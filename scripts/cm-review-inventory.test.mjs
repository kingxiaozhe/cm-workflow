import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {captureReviewBaseline,createReviewPackage,readReviewBaseline,readReviewPackage,verifyReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {digest} from '../runtime/js/cm-ai/contracts.mjs';
import {buildReviewPrompt} from '../runtime/js/cm-ai/codex-review-adapter.mjs';

const identity={repositoryId:'fixture',runId:'inventory',taskId:'T-001',attempt:1};
const checks=[{id:'fixture',command:['node','fixture.mjs'],outcome:'passed',exitCode:0,evidence:'synthetic check'}];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const capture=(root,extra={})=>captureReviewBaseline({root,identity,scope:['code.js'],requirements:['requirements.md'],...extra});
const write=(root,name,body)=>fs.writeFileSync(path.join(root,name),body);
function fixture(fn){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-inventory-')));
  try{write(root,'code.js','before');write(root,'requirements.md','fixture');return fn(root);}
  finally{fs.rmSync(root,{recursive:true,force:true});}
}

test('large inventory retains hashes, emits only selected bodies, and verifies the review package',()=>fixture(root=>{
  for(let i=0;i<510;i++)write(root,`asset-${i}`,Buffer.alloc(4096,i%256));
  const media=Buffer.alloc(2*1024*1024+1,17);write(root,'media.bin',media);write(root,'AGENTS.md','fixture instructions');
  const baseline=capture(root);
  assert.equal(baseline.version,2);assert.equal(baseline.files.length,514);
  assert.deepEqual(baseline.files.filter(f=>Object.hasOwn(f,'contentBase64')).map(f=>f.path),['AGENTS.md','code.js','requirements.md']);
  assert.equal(baseline.files.find(f=>f.path==='media.bin').sha256,sha(media));
  assert(Buffer.byteLength(JSON.stringify(baseline))<150000);
  assert.deepEqual(readReviewBaseline(JSON.parse(JSON.stringify(baseline))),baseline);
  write(root,'code.js','after');
  const reviewPackage=createReviewPackage({root,baseline,checks});
  assert.equal(reviewPackage.version,1);
  assert.equal(Buffer.from(reviewPackage.changes[0].before.contentBase64,'base64').toString(),'before');
  assert.deepEqual(readReviewPackage(reviewPackage),reviewPackage);
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage,expectedDigest:reviewPackage.packageDigest}).outcome,'matched');
}));

for(const mode of ['same-size edit','add','delete','rename','chmod','symlink','hardlink'])
  test(`digest-only out-of-scope file rejects ${mode}`,()=>fixture(root=>{
    write(root,'asset.bin',Buffer.alloc(1024*1024+1,7));const baseline=capture(root);write(root,'code.js','after');
    const target=path.join(root,'asset.bin');
    if(mode==='same-size edit'){const fd=fs.openSync(target,'r+');try{fs.writeSync(fd,Buffer.from([8]),0,1,65537);}finally{fs.closeSync(fd);}}
    if(mode==='add')write(root,'new.bin','extra');
    if(mode==='delete')fs.unlinkSync(target);
    if(mode==='rename')fs.renameSync(target,path.join(root,'renamed.bin'));
    if(mode==='chmod')fs.chmodSync(target,0o700);
    if(mode==='symlink'){fs.unlinkSync(target);fs.symlinkSync('code.js',target);}
    if(mode==='hardlink')fs.linkSync(target,path.join(root,'linked.bin'));
    assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:['symlink','hardlink'].includes(mode)?'unsupported_file':'out_of_scope'});
  }));

for(const mutation of ['truncate','grow','replace'])test(`streamed file ${mutation} fails and closes its descriptor`,t=>fixture(root=>{
  const target=path.join(root,'asset.bin');write(root,'asset.bin',Buffer.alloc(1024*1024+1));
  const originalRead=fs.readSync,originalOpen=fs.openSync,originalClose=fs.closeSync;
  let targetFd,changed=false,closed=false,maxRead=0;
  t.mock.method(fs,'openSync',(...args)=>{const fd=originalOpen(...args);if(args[0]===target)targetFd=fd;return fd;});
  t.mock.method(fs,'readSync',(...args)=>{
    const n=originalRead(...args);
    if(args[0]===targetFd){
      maxRead=Math.max(maxRead,args[3]);
      if(!changed){changed=true;
        if(mutation==='truncate')fs.truncateSync(target,1);
        if(mutation==='grow')fs.appendFileSync(target,'extra');
        if(mutation==='replace'){fs.renameSync(target,target+'.old');write(root,'asset.bin',Buffer.alloc(1024*1024+1));}
      }
    }
    return n;
  });
  t.mock.method(fs,'closeSync',fd=>{if(fd===targetFd)closed=true;return originalClose(fd);});
  assert.throws(()=>capture(root),{code:'snapshot_changed'});assert(changed&&closed);assert(maxRead<=64*1024);
}));

test('oversized inventory fails before reading the file, while selected material retains its smaller cap',t=>fixture(root=>{
  const target=path.join(root,'asset.bin');write(root,'asset.bin','');fs.truncateSync(target,1024*1024*1024+1);
  const original=fs.openSync;let opened=false;
  t.mock.method(fs,'openSync',(...args)=>{if(args[0]===target)opened=true;return original(...args);});
  assert.throws(()=>capture(root),{code:'limit_exceeded'});assert.equal(opened,false);
  fs.unlinkSync(target);write(root,'code.js',Buffer.alloc(1024*1024+1));
  assert.throws(()=>capture(root),{code:'limit_exceeded'});
}));

test('inventory count is bounded without silently omitting the last file',()=>fixture(root=>{
  for(let i=0;i<9998;i++)write(root,`empty-${String(i).padStart(5,'0')}`,'');
  const baseline=capture(root);assert.equal(baseline.files.length,10000);readReviewBaseline(baseline);
  write(root,'one-more','');assert.throws(()=>capture(root),{code:'limit_exceeded'});
}));

test('offline sparse baseline rejects missing required bodies, extra bodies, aliases, and malformed metadata',()=>fixture(root=>{
  write(root,'asset.bin','outside');const original=capture(root);
  for(const mutate of [
    b=>{delete b.files.find(f=>f.path==='code.js').contentBase64;},
    b=>{b.files.find(f=>f.path==='asset.bin').contentBase64=Buffer.from('outside').toString('base64');},
    b=>{b.files[0].size=-1;},b=>{b.files[0].sha256='bad';},
    b=>{b.files.push({...b.files[0],path:'ASSET.bin'});},
  ]){
    const b=structuredClone(original);mutate(b);const {baselineDigest,...data}=b;
    assert.throws(()=>readReviewBaseline({...data,baselineDigest:digest(data)}),{code:'invalid_baseline'});
  }
}));

test('legacy baseline preserves full records and package digests across offline restoration',()=>fixture(root=>{
  write(root,'outside.txt','legacy body');const baseline=capture(root,{version:1});
  assert(baseline.files.every(f=>Object.hasOwn(f,'contentBase64')));
  assert.deepEqual(capture(root,{version:1}),readReviewBaseline(baseline));
  write(root,'code.js','after');const reviewPackage=createReviewPackage({root,baseline,checks});
  assert.equal(verifyReviewPackage({root,baseline:readReviewBaseline(JSON.parse(JSON.stringify(baseline))),checks,
    reviewPackage,expectedDigest:reviewPackage.packageDigest}).outcome,'matched');
  write(root,'outside.txt','changed');assert.throws(()=>createReviewPackage({root,baseline,checks}),{code:'out_of_scope'});
}));

test('unchanged scope lists only existing unchanged files by hash, including Learning instructions',()=>fixture(root=>{
  write(root,'AGENTS.md','fixture instructions');write(root,'removed.js','remove');write(root,'mode.js','mode');
  const baseline=capture(root,{scope:['code.js','AGENTS.md','requirements.md','new.js','absent.js','removed.js','mode.js']});
  write(root,'code.js','after');write(root,'new.js','new');fs.unlinkSync(path.join(root,'removed.js'));
  fs.chmodSync(path.join(root,'mode.js'),0o700);
  const pkg=createReviewPackage({root,baseline,checks});
  assert.deepEqual(pkg.unchangedScope,[{path:'AGENTS.md',sha256:sha('fixture instructions')},
    {path:'requirements.md',sha256:sha('fixture')}]);
  assert.deepEqual(pkg.changes.map(c=>c.path),['code.js','mode.js','new.js','removed.js']);
  assert.deepEqual(readReviewPackage(pkg),pkg);
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  const changed=structuredClone(pkg);changed.unchangedScope[0].sha256=sha('forged');
  assert.throws(()=>readReviewPackage(changed),{code:'invalid_package'});
  const {packageDigest,...body}=changed,resealed={...body,packageDigest:digest(body)};
  assert.throws(()=>verifyReviewPackage({root,baseline,checks,reviewPackage:resealed,expectedDigest:resealed.packageDigest}),{code:'package_mismatch'});
  write(root,'AGENTS.md','drift');
  assert.throws(()=>verifyReviewPackage({root,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}),{code:'package_mismatch'});
}));

test('unchanged scope rejects invalid hashes, paths, duplicate aliases, changed paths, bodies and inconsistent material',()=>fixture(root=>{
  write(root,'AGENTS.md','fixture instructions');
  const baseline=capture(root,{scope:['code.js','AGENTS.md','requirements.md']});write(root,'code.js','after');
  const pkg=createReviewPackage({root,baseline,checks});
  for(const mutate of [
    p=>{p.unchangedScope=null;},p=>{p.unchangedScope[0].sha256='bad';},
    p=>{p.unchangedScope[0].path='../AGENTS.md';},p=>{p.unchangedScope[0].path='outside.md';},
    p=>{p.unchangedScope[0].path='code.js';},p=>{p.unchangedScope.push(p.unchangedScope[0]);},
    p=>{p.unchangedScope.push({...p.unchangedScope[0],path:'agents.md'});},
    p=>{p.unchangedScope.reverse();},p=>{p.unchangedScope[0].contentBase64='';},
    p=>{p.unchangedScope[1].sha256=sha('forged requirement');},
  ]){
    const changed=structuredClone(pkg);mutate(changed);const {packageDigest,...body}=changed;
    assert.throws(()=>readReviewPackage({...body,packageDigest:digest(body)}),{code:'invalid_package'});
  }
}));

for(const version of [1,2])test(`legacy package without unchangedScope retains digest and live verification with baseline v${version}`,()=>fixture(root=>{
  write(root,'AGENTS.md','fixture instructions');
  const baseline=capture(root,{version,scope:['code.js','AGENTS.md']});write(root,'code.js','after');
  const current=createReviewPackage({root,baseline,checks});
  // Exact historical v1 shape, as persisted before unchangedScope was introduced.
  const {unchangedScope,packageDigest,...body}=current;
  const legacy={...body,packageDigest:digest(body)},serialized=JSON.stringify(legacy);
  assert.notEqual(current.packageDigest,legacy.packageDigest);
  assert.equal(JSON.stringify(readReviewPackage(JSON.parse(serialized))),serialized);
  assert.equal(verifyReviewPackage({root,baseline,checks,reviewPackage:legacy,expectedDigest:legacy.packageDigest}).outcome,'matched');
  assert.equal(JSON.stringify(legacy),serialized);
  write(root,'AGENTS.md','drift');
  assert.throws(()=>verifyReviewPackage({root,baseline,checks,reviewPackage:legacy,expectedDigest:legacy.packageDigest}),{code:'package_mismatch'});
}));

test('both review prompt providers explain hash-only unchanged scope and include its examined paths',()=>fixture(root=>{
  write(root,'AGENTS.md','synthetic instruction body must stay out of the prompt');
  const baseline=capture(root,{scope:['code.js','AGENTS.md']});write(root,'code.js','after');
  const pkg=createReviewPackage({root,baseline,checks});
  for(const provider of ['codex','claude']){
    const body={version:1,invocationId:'review-1',identity,role:'reviewer',provider,requestedModel:'fixture',
      contextId:'review-context',payload:{reviewPackage:pkg,priorReview:null}};
    const prompt=buildReviewPrompt({...body,requestDigest:digest(body)},provider);
    assert.match(prompt,/unchangedScope.*SHA-256 only/);
    assert.match(prompt,/must not require changes to them or infer their contents from hashes/);
    assert.deepEqual(JSON.parse(prompt.split('<cm-review-data-json>\n')[1]).examinedPaths,['AGENTS.md','code.js','requirements.md']);
    assert(!prompt.includes(Buffer.from('synthetic instruction body must stay out of the prompt').toString('base64')));
  }
}));

// Step 24: approved specs live outside the code root and never become scope.
import {buildManifest} from './cm-spec-manifest.mjs';
import {captureSpecificationMaterial} from '../runtime/js/cm-ai/specification-material.mjs';
import {buildDeveloperPrompt,readDeveloperRequest} from '../runtime/js/cm-ai/developer-adapter.mjs';
import {requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {reviewResult,reviewPaths,reviewReceipt} from '../runtime/js/cm-ai/review-runner.mjs';
import {checkCompletion} from '../runtime/js/cm-ai/gate-bridge.mjs';

function specificationFixture(t,{cases=true,design='export function normalizePriority(value): Priority;\n'}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-specification-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const code=path.join(root,'app'),specsRoot=path.join(root,'specs'),feature='1.priority';
  fs.mkdirSync(code);fs.mkdirSync(path.join(specsRoot,feature),{recursive:true});
  const writeSpec=(name,body)=>write(specsRoot,feature+'/'+name,body);
  write(code,'code.js','before');write(code,'requirements.md','Optional README material');
  writeSpec('tasks.md','# Tasks\n- [ ] T-001: implement normalizePriority ~2h\n- [ ] T-002: sort priorities ~1h\n\n## 验证要求\n- T-001: node --test priority.test.mjs\n- T-002: node --test sort.test.mjs\n\n## Other\n- T-001: must not be verification\n');
  writeSpec('requirements.md','# Requirements\n- [ ] [AC-001] Normalize priority\n- AC-002: Stable ordering\n');
  writeSpec('design.md',design);
  const testCases=[{id:'TC-001',taskIds:['T-001'],acIds:['AC-001'],description:'normalize'},
    {id:'TC-002',taskIds:['T-002'],acIds:['AC-002'],description:'sort'},
    {id:'TC-003',taskIds:['T-001','T-002'],acIds:['AC-001','AC-002'],description:'both'}];
  if(cases)writeSpec('test-cases.json',JSON.stringify({cases:testCases}));
  const approve=()=>write(specsRoot,'.cm-specs-status',JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsRoot)}));
  approve();
  const selection={specsRoot,feature};
  const capture=()=>captureReviewBaseline({root:code,specsRoot,identity,scope:['code.js'],requirements:[],specification:selection});
  return {root,code,specsRoot,feature,selection,capture,writeSpec,approve,testCases};
}

test('approved specification supplies task, all ACs, design, matching cases and manifest hashes to both providers',t=>{
  const f=specificationFixture(t),baseline=f.capture(),specification=baseline.specification;
  assert.equal(specification.feature,f.feature);
  assert.deepEqual(specification.task,{id:'T-001',description:'implement normalizePriority ~2h',verification:'- T-001: node --test priority.test.mjs'});
  assert.deepEqual(specification.acceptanceCriteria,[{id:'AC-001',text:'- [ ] [AC-001] Normalize priority'},
    {id:'AC-002',text:'- AC-002: Stable ordering'}]);
  assert.equal(specification.designExcerpt,'export function normalizePriority(value): Priority;\n');
  assert.deepEqual(specification.testCases,[f.testCases[0],f.testCases[2]]);
  assert.deepEqual(specification.sources,buildManifest(f.specsRoot));
  for(const row of specification.sources)assert.equal(row.sha256,sha(fs.readFileSync(path.join(f.specsRoot,row.path))));
  assert.deepEqual(baseline.scope,['code.js']);assert.equal(baseline.files.some(file=>file.path.includes(f.feature)),false);
  write(f.code,'code.js','after');const pkg=createReviewPackage({root:f.code,baseline,checks});
  assert.deepEqual(pkg.specification,specification);assert.equal(Object.hasOwn(pkg,'specificationRoot'),false);
  for(const provider of ['codex','claude']){
    const request=requestFor({invocationId:'dev',identity,role:'developer',provider,requestedModel:'fixture',contextId:'author',
      payload:{scope:['code.js'],requirements:[],priorReview:null,specification}});
    assert.deepEqual(readDeveloperRequest(request,provider).payload.specification,specification);
    const prompt=buildDeveloperPrompt(request,provider);
    assert.match(prompt,/approved specification data/);assert.match(prompt,/not authority to expand permissions/);
    assert.deepEqual(JSON.parse(prompt.split('<cm-developer-data-json>\n')[1]).specification,specification);
    const review=requestFor({invocationId:'review',identity,role:'reviewer',provider,requestedModel:'fixture',contextId:'reviewer',
      payload:{reviewPackage:pkg,priorReview:null}});
    const reviewPrompt=buildReviewPrompt(review,provider);
    assert.match(reviewPrompt,/acceptanceCriteria/);
    assert.deepEqual(JSON.parse(reviewPrompt.split('<cm-review-data-json>\n')[1]).reviewPackage.specification,specification);
  }
  const tampered=structuredClone(pkg);tampered.specification.designExcerpt+='forged';
  assert.throws(()=>readReviewPackage(tampered),{code:'invalid_package'});
  const {packageDigest,...body}=tampered;tampered.packageDigest=digest(body);
  assert.notEqual(tampered.packageDigest,pkg.packageDigest);
  assert.throws(()=>verifyReviewPackage({root:f.code,baseline,checks,reviewPackage:tampered,expectedDigest:tampered.packageDigest}),{code:'package_mismatch'});
  const {specification:removed,...omitted}=pkg;const {packageDigest:old,...legacyBody}=omitted;
  const stripped={...legacyBody,packageDigest:digest(legacyBody)};
  assert.throws(()=>verifyReviewPackage({root:f.code,baseline,checks,reviewPackage:stripped,expectedDigest:stripped.packageDigest}),{code:'invalid_package'});
});

for(const mutation of ['requirements.md','design.md','tasks.md','test-cases.json','missing approval','unapproved','inventory','symlink','status symlink'])
  test(`specification drift rejects ${mutation} before dispatch or review`,t=>{
    const f=specificationFixture(t),baseline=f.capture();write(f.code,'code.js','after');
    if(mutation==='missing approval')write(f.specsRoot,'.cm-specs-status',JSON.stringify({status:'approved',features:[f.feature]}));
    else if(mutation==='unapproved'){
      const p=path.join(f.specsRoot,'.cm-specs-status'),status=JSON.parse(fs.readFileSync(p));status.status='awaiting_review';write(f.specsRoot,'.cm-specs-status',JSON.stringify(status));
    }else if(mutation==='inventory'){
      fs.mkdirSync(path.join(f.specsRoot,'2.new'));for(const name of ['requirements.md','design.md','tasks.md'])write(f.specsRoot,'2.new/'+name,'new');
    }else if(mutation==='symlink'){
      fs.renameSync(path.join(f.specsRoot,f.feature,'design.md'),path.join(f.root,'external.md'));
      fs.symlinkSync(path.join(f.root,'external.md'),path.join(f.specsRoot,f.feature,'design.md'));
    }else if(mutation==='status symlink'){
      fs.renameSync(path.join(f.specsRoot,'.cm-specs-status'),path.join(f.root,'external.json'));
      fs.symlinkSync(path.join(f.root,'external.json'),path.join(f.specsRoot,'.cm-specs-status'));
    }else fs.appendFileSync(path.join(f.specsRoot,f.feature,mutation),'changed');
    assert.throws(()=>captureSpecificationMaterial({...f.selection,taskId:identity.taskId}),{code:'spec_drift'});
    assert.throws(()=>createReviewPackage({root:f.code,baseline,checks}),{code:'spec_drift'});
  });

test('approved specification tolerates runtime checkboxes but not reapproved contract replacement',t=>{
  const f=specificationFixture(t),baseline=f.capture();write(f.code,'code.js','after');
  const pkg=createReviewPackage({root:f.code,baseline,checks});
  for(const name of ['requirements.md','tasks.md']){
    const p=path.join(f.specsRoot,f.feature,name);fs.writeFileSync(p,fs.readFileSync(p,'utf8').replaceAll('[ ]','[x]'));
  }
  assert.equal(verifyReviewPackage({root:f.code,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  f.writeSpec('design.md','approved but different interface');f.approve();
  assert.throws(()=>verifyReviewPackage({root:f.code,baseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}),{code:'spec_drift'});
});

for(const size of [65536,65537,1024*1024+4])test(`design byte limit ${size} preserves UTF-8 and marks truncation only above 64 KiB`,t=>{
  const design='界'.repeat(Math.floor(size/3))+'a'.repeat(size%3),f=specificationFixture(t,{cases:false,design});
  const material=f.capture().specification;
  assert.equal(Buffer.byteLength(material.designExcerpt)<=65536,true);assert(!material.designExcerpt.includes('\ufffd'));
  assert.equal(material.truncated,size>65536?true:undefined);assert.deepEqual(material.testCases,[]);assert.equal(material.sources.length,3);
  assert(design.startsWith(material.designExcerpt));
});

test('new specification and legacy packages both retain receipt completion eligibility',t=>{
  const f=specificationFixture(t),baseline=f.capture();
  const legacyBaseline=captureReviewBaseline({root:f.code,identity,scope:['code.js'],requirements:['requirements.md']});
  write(f.code,'code.js','after');
  const current=createReviewPackage({root:f.code,baseline,checks});
  const old=createReviewPackage({root:f.code,baseline:legacyBaseline,checks});
  const {unchangedScope,packageDigest,...oldBody}=old,legacy={...oldBody,packageDigest:digest(oldBody)};
  for(const pkg of [current,legacy]){
    assert.deepEqual(readReviewPackage(pkg),pkg);
    const result=reviewResult({verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),findings:[],summary:'Synthetic review'},pkg);
    const request=requestFor({invocationId:'receipt',identity,role:'reviewer',provider:'claude',requestedModel:'fixture',contextId:'reviewer',payload:{reviewPackage:pkg,priorReview:null}});
    const call={invocationId:request.invocationId,started:true,terminal:'succeeded',requestDigest:request.requestDigest,resultDigest:digest(result),
      provider:'claude',contextId:'reviewer',requestedModel:'fixture',effectiveModel:'fixture',channel:'fixture'};
    const receipt=reviewReceipt({request,call,result,reviewPackage:pkg,developerProvider:'codex',fallbackReasons:[]});
    assert.equal(checkCompletion({receipt,registered:receipt,execution:call,reviewPackage:pkg,identity}).outcome,'eligible');
    assert.equal(verifyReviewPackage({root:f.code,baseline:pkg===current?baseline:legacyBaseline,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}).outcome,'matched');
  }
});

// A repository that merely contains mobile/.env.example used to be impossible
// to review: walk() validates every discovered path, so the placeholder aborted
// the whole baseline capture rather than being skipped. Committed placeholders
// are ordinary source; the real secret files must still be refused.
test('committed environment placeholders are inventoried while real secret files stay refused',()=>fixture(root=>{
  fs.mkdirSync(path.join(root,'mobile'));
  write(root,'mobile/.env.example','API_URL=https://example.invalid\n');
  write(root,'.env.sample','TOKEN=replace-me\n');
  const baseline=capture(root);
  const inventoried=baseline.files.map(f=>f.path);
  assert.ok(inventoried.includes('mobile/.env.example'),'placeholder missing from the inventory');
  assert.ok(inventoried.includes('.env.sample'),'placeholder missing from the inventory');
  // Inventoried means hashed, not disclosed: only selected scope carries a body.
  const placeholder=baseline.files.find(f=>f.path==='mobile/.env.example');
  assert.equal(placeholder.contentBase64,undefined);
  assert.equal(typeof placeholder.sha256,'string');

  // Selecting a placeholder as ordinary source is allowed too.
  const selected=captureReviewBaseline({root,identity,scope:['mobile/.env.example'],
    requirements:['requirements.md']}).files.find(f=>f.path==='mobile/.env.example');
  assert.equal(Buffer.from(selected.contentBase64,'base64').toString(),
    'API_URL=https://example.invalid\n');

  for(const secret of ['.env','.env.local','.env.production','.env.example.bak']){
    write(root,secret,'SECRET=1\n');
    assert.throws(()=>capture(root),{code:'unsupported_path'},`${secret} was not refused`);
    assert.throws(()=>captureReviewBaseline({root,identity,scope:[secret],
      requirements:['requirements.md']}),{code:'unsupported_path'},`${secret} was selectable`);
    fs.rmSync(path.join(root,secret));
  }

  // The placeholder name must not become a way to smuggle a real secret in.
  fs.writeFileSync(path.join(root,'.env'),'SECRET=real\n');
  fs.symlinkSync('.env',path.join(root,'.env.disguise'));
  fs.renameSync(path.join(root,'.env.disguise'),path.join(root,'.env.template'));
  assert.throws(()=>capture(root),{code:'unsupported_path'},'the .env sibling was not refused');
  fs.rmSync(path.join(root,'.env'));
  assert.throws(()=>capture(root),/unsupported_file|unsupported_path|read_failed/,
    'a symlink wearing a placeholder name was captured');
  fs.rmSync(path.join(root,'.env.template'));
}));
