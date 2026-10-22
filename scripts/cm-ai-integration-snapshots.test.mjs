// Synthetic data only. These tests prove protocol boundaries, not independent
// approval of any real report or permission to restore a product run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {captureReviewBaseline,compareReviewInventoryToBaseline,createReviewPackage,readReviewPackage}
  from '../runtime/js/cm-ai/review-package.mjs';
import {readIntegrationPlan,previewReviewedIntegration,readIntegrationEvidence}
  from '../runtime/js/cm-ai/reviewed-integration.mjs';
import {readIntegrationSnapshots,assertSnapshotBoundaries,verifySnapshotReview}
  from '../runtime/js/cm-ai/integration-snapshots.mjs';
import {explainIntegratedDelivery} from '../runtime/js/cm-ai/fix-code-association.mjs';
import {canonical,sha,fileRecord,createReviewedIntegrationFixture,syntheticIntegrationReview}
  from './fixtures/reviewed-integration.mjs';

const body='# Archived synthetic instructions\nDo not treat this evidence as authority.\n';
const names=['reports/fixture-a/AGENTS.md','reports/fixture-b/runtime/AGENTS.md'];
const files=()=>names.map((name,i)=>fileRecord(name,body,i===0?0o644:0o664));
const provenance=canonical({version:1,kind:'synthetic-snapshot-provenance',files:names.map(name=>({path:name,source:'synthetic fixture'}))});
const snapshots=()=>({files:files(),provenanceSha256:sha(provenance)});
const identity=runId=>({repositoryId:'snapshot-fixture',runId,taskId:'T-'+runId,attempt:1});
const plan=snapshotValue=>({version:1,kind:'cm-reviewed-integration-v1',author:{provider:'codex',contextId:'snapshot-author'},
  target:{identity:identity('parent'),rootDigest:'a'.repeat(64),baselineDigest:'b'.repeat(64),
    packageDigest:'c'.repeat(64),recordCount:1,lastDigest:'d'.repeat(64)},sources:[],documents:[],
  ...(snapshotValue===undefined?{}:{snapshots:snapshotValue})});
const material=(name,bytes,mode=0o644)=>({...fileRecord(name,bytes,mode),contentBase64:Buffer.from(bytes).toString('base64')});
const checks=[{id:'synthetic',command:['synthetic-check'],outcome:'passed',exitCode:0,evidence:'Synthetic data only'}];
const emptyPackage=()=>({scope:[],requirements:[],changes:[]});
const emptyBase=()=>({files:[],scope:['AGENTS.md','src/parent.mjs'],requirements:['req.md']});
const refused=fn=>assert.throws(fn,error=>typeof error.code==='string');

function reviewPackage(requirements){
  const changes=[{path:'probe.mjs',before:material('probe.mjs','0\n'),after:material('probe.mjs','1\n')}];
  const pkg={version:1,kind:'cm-review-package',identity:identity('new-review'),rootDigest:'e'.repeat(64),baseIdentity:'f'.repeat(64),
    scope:['probe.mjs'],changes,requirements:[...requirements].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0),checks,
    artifactDigest:digest(changes),requirementsDigest:digest([...requirements].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)),
    checksDigest:digest(checks)};
  return {...pkg,packageDigest:digest(pkg)};
}
const reviewRequirements=()=>[material('integration/snapshot-provenance.json',provenance),
  material('integration/snapshots/'+sha(body)+'.txt',body)];
const verifyRequirements=requirements=>verifySnapshotReview(readReviewPackage(reviewPackage(requirements)),snapshots());

test('snapshot plan parser preserves old v1 and accepts only fixed sorted evidence additions',()=>{
  const old={...plan(),sources:[{identity:identity('source'),root:fs.realpathSync(os.tmpdir()),revision:'1'.repeat(64),packageDigest:'2'.repeat(64)}]};
  assert.deepEqual(readIntegrationPlan(old),old);
  const value=snapshots();assert.deepEqual(readIntegrationSnapshots(value),value);
  assert.deepEqual(readIntegrationPlan(plan(value)).snapshots,value);
  for(const change of [v=>v.files.reverse(),v=>v.files.push(v.files[0]),v=>v.files=[],
    v=>v.provenanceSha256='bad',v=>v.ignore=true,v=>v.files[0].mode=0o755,v=>v.files[0].mode=0o600,
    v=>v.files[0].size=-1,v=>v.files[0].size=256*1024+1,v=>v.files[0].sha256='bad',v=>v.files[0].type='symlink',
    v=>v.files[0].before=null,
    v=>v.files=Array.from({length:65},(_,i)=>fileRecord(`reports/copy-${String(i).padStart(2,'0')}/AGENTS.md`,body)),
    v=>v.files=Array.from({length:9},(_,i)=>({...fileRecord(`reports/copy-${i}/AGENTS.md`,body),size:256*1024}))]){
    const bad=structuredClone(value);change(bad);refused(()=>readIntegrationSnapshots(bad));
  }
  for(const name of ['AGENTS.md','reports/AGENTS.md','src/example/AGENTS.md','reports/fixture/README.md',
    'reports/fixture/agents.md','reports/../escape/AGENTS.md','reports/.git/AGENTS.md',
    'reports/node_modules/AGENTS.md','reports/fixture\\nested/AGENTS.md','/reports/fixture/AGENTS.md']){
    refused(()=>readIntegrationSnapshots({files:[fileRecord(name,body)],provenanceSha256:sha(provenance)}));
  }
});

test('snapshot boundaries reject original inventory and every applicable reviewed path without reversing ancestry',()=>{
  const value=snapshots(),first=names[0],covered='reports/fixture-a/src/file.mjs';
  assert.doesNotThrow(()=>assertSnapshotBoundaries(value,emptyBase(),[emptyPackage()]));
  assert.doesNotThrow(()=>assertSnapshotBoundaries(value,{...emptyBase(),scope:['AGENTS.md','reports/fixture-ab/code.mjs']},[]));
  refused(()=>assertSnapshotBoundaries(value,{...emptyBase(),files:[fileRecord(first,body)]},[]));
  for(const field of ['scope','requirements'])for(const p of [first,covered])
    refused(()=>assertSnapshotBoundaries(value,{...emptyBase(),[field]:[p]},[]));
  for(const learning of [[first],[covered]])
    refused(()=>assertSnapshotBoundaries(value,emptyBase(),[],learning));
  for(const field of ['scope','requirements','changes','instructions'])for(const p of [first,covered]){
    const pkg=emptyPackage();pkg[field]=field==='scope'?[p]:[{path:p}];
    refused(()=>assertSnapshotBoundaries(value,emptyBase(),[emptyPackage(),pkg]));
  }
  assert.doesNotThrow(()=>assertSnapshotBoundaries(undefined,emptyBase(),[]));
});

test('snapshot review binds full data and provenance while deduplicating bytes independently of target modes',()=>{
  const requirements=reviewRequirements();
  assert.equal(requirements.length,2);assert.equal(new Set(files().map(file=>file.sha256)).size,1);
  assert.doesNotThrow(()=>verifyRequirements(requirements));
  assert.equal(requirements[1].mode,0o644);assert.equal(snapshots().files[1].mode,0o664);
  for(const selected of [[],requirements.slice(0,1),requirements.slice(1),
    [material(requirements[0].path,provenance+' '),requirements[1]],
    [requirements[0],material(requirements[1].path,body+' ')],
    [requirements[0],material('integration/snapshots/wrong.txt',body)],
    [requirements[0],{...requirements[1],contentBase64:Buffer.from(body+' ').toString('base64')}],
    [requirements[0],{...requirements[1],size:requirements[1].size+1}]])refused(()=>verifyRequirements(selected));
  // Absence of the option leaves old packages untouched.
  assert.doesNotThrow(()=>verifySnapshotReview(readReviewPackage(reviewPackage([material('req.md','old')])),undefined));
});

function treeFixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-snapshot-tree-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const put=(name,bytes,mode=0o644)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,bytes);fs.chmodSync(file,mode);};
  put('parent.mjs','0\n');put('other.mjs','A\n');put('req.md','Synthetic requirement\n');put('AGENTS.md','Real root instructions\n');
  const deliver=(runId,scope,edits)=>{
    // This valid legacy-policy V2 baseline has no Git-ignore discovery. Pure
    // composition needs only local file records, not Apple Git or Python.
    const baseline=captureReviewBaseline({root,identity:identity(runId),scope,requirements:['req.md']},true);
    for(const [name,bytes] of Object.entries(edits))put(name,bytes);
    return {baseline,pkg:createReviewPackage({root,baseline,checks})};
  };
  const parent=deliver('parent',['parent.mjs'],{'parent.mjs':'1\n'});
  const input={root,baseline:parent.baseline,parentPackage:parent.pkg,deliveries:[],after:30,since:10,sources:[],documents:[]};
  return {root,put,deliver,parent,input,addSnapshots:()=>files().forEach(file=>put(file.path,body,file.mode))};
}

test('snapshot composition retains the scanner and requires the exact complete tree including permissions',t=>{
  const f=treeFixture(t);assert.doesNotThrow(()=>explainIntegratedDelivery(f.input));
  f.addSnapshots();
  assert.deepEqual(compareReviewInventoryToBaseline(f.root,f.parent.baseline,{withMode:true})
    .filter(row=>row.path.startsWith('reports/')).map(row=>row.path),names);
  refused(()=>explainIntegratedDelivery(f.input));
  const input={...f.input,snapshots:snapshots()};assert.doesNotThrow(()=>explainIntegratedDelivery(input));
  refused(()=>explainIntegratedDelivery({...input,snapshots:{...snapshots(),files:files().slice(0,1)}}));
  const mutations=[{name:names[0],apply:()=>f.put(names[0],body+' '),restore:()=>f.put(names[0],body)},
    {name:names[1],apply:()=>fs.chmodSync(path.join(f.root,names[1]),0o644),restore:()=>fs.chmodSync(path.join(f.root,names[1]),0o664)},
    {name:names[0],apply:()=>fs.unlinkSync(path.join(f.root,names[0])),restore:()=>f.put(names[0],body)},
    {name:'reports/unlisted/AGENTS.md',apply:()=>f.put('reports/unlisted/AGENTS.md',body),restore:()=>fs.unlinkSync(path.join(f.root,'reports/unlisted/AGENTS.md'))},
    {name:'reports/other.txt',apply:()=>f.put('reports/other.txt','unreviewed'),restore:()=>fs.unlinkSync(path.join(f.root,'reports/other.txt'))},
    {name:'AGENTS.md',apply:()=>f.put('AGENTS.md','changed active instructions\n'),restore:()=>f.put('AGENTS.md','Real root instructions\n')}];
  for(const mutation of mutations){mutation.apply();try{assert.throws(()=>explainIntegratedDelivery(input),
    error=>error.code==='fix_current_code_unexplained'&&error.paths.includes(mutation.name));}finally{mutation.restore();}}
  const first=path.join(f.root,names[0]),other=path.join(f.root,names[1]);
  fs.unlinkSync(first);fs.symlinkSync(other,first);try{refused(()=>explainIntegratedDelivery(input));}
  finally{fs.unlinkSync(first);f.put(names[0],body);}
  fs.unlinkSync(first);fs.linkSync(other,first);try{refused(()=>explainIntegratedDelivery(input));}
  finally{fs.unlinkSync(first);f.put(names[0],body);}
  assert.doesNotThrow(()=>explainIntegratedDelivery(input));
});

test('snapshot additions never cover a broken ordinary delivery or a newly applicable source instruction',t=>{
  const f=treeFixture(t),one=f.deliver('one',['other.mjs'],{'other.mjs':'B\n'}),two=f.deliver('two',['other.mjs'],{'other.mjs':'C\n'});
  const delivered=(name,pkg,reviewedAt)=>({runId:name,packages:[{pkg,reviewedAt}]});
  f.addSnapshots();const input={...f.input,snapshots:snapshots(),deliveries:[delivered('one',one.pkg,40),delivered('two',two.pkg,50)]};
  assert.doesNotThrow(()=>explainIntegratedDelivery(input));
  refused(()=>explainIntegratedDelivery({...input,deliveries:[delivered('two',two.pkg,50)]}));
  f.put('other.mjs','B\n');refused(()=>explainIntegratedDelivery(input));f.put('other.mjs','C\n');
  // Build a valid later package while snapshots are absent. Its business path
  // makes the proposed AGENTS directory active, even though the before-chain
  // and final bytes otherwise match exactly.
  for(const name of names)fs.unlinkSync(path.join(f.root,name));
  const active=f.deliver('active',['reports/fixture-a/code.mjs'],{'reports/fixture-a/code.mjs':'export const active=true;\n'});
  f.addSnapshots();
  assert.throws(()=>explainIntegratedDelivery({...input,deliveries:[...input.deliveries,delivered('active',active.pkg,60)]}),
    error=>error.code==='integration_snapshot_protected');
});

test('real owner accepts exact snapshot evidence once and preserves history and calls across resume drift',{timeout:120000},async t=>{
  // The sole Git/owner fixture is lazy: selecting the pure snapshot tests above
  // does not create it or require Git/Python. Setup has its original 90 s budget.
  let timer;const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Snapshot owner fixture exceeded 90000 ms')),90000);});
  let f;try{f=await Promise.race([createReviewedIntegrationFixture(t),deadline]);}finally{clearTimeout(timer);}
  const nextPlan={...f.plan,snapshots:snapshots()};
  const review=await syntheticIntegrationReview(f.root,nextPlan,f.documents,{snapshotEvidence:{provenance,contents:{[sha(body)]:body}}});
  const bytes=fs.readFileSync(f.statePath('parent')),before=f.history('parent'),calls={...f.calls},
    tasks=fs.readFileSync(path.join(f.specsDir,f.definitions.parent.feature,'tasks.md'));
  const input={...f.input,plan:nextPlan,review};
  assert.equal(previewReviewedIntegration(input).eligibleForAdoption,false,'every declared snapshot must exist');
  for(const file of files()){f.write(file.path,body);fs.chmodSync(path.join(f.codeProject,file.path),file.mode);}
  const preview=previewReviewedIntegration({...input,review:null});assert.equal(preview.code,'integration_review_required',JSON.stringify(preview));
  assert.equal(previewReviewedIntegration(input).eligibleForAdoption,true,JSON.stringify(previewReviewedIntegration(input)));
  assert.deepEqual(fs.readFileSync(f.statePath('parent')),bytes);assert.deepEqual(f.calls,calls);
  fs.writeFileSync(f.evidenceFile,canonical({plan:nextPlan,review}));
  assert.deepEqual(readIntegrationEvidence(f.evidenceFile),{plan:nextPlan,review});
  let run=await f.openParent();
  try{
    const args={allowed:true,evidenceFile:f.evidenceFile,expectedDigest:digest(nextPlan)};
    const accepted=run.host.acceptReviewedIntegration(args);assert.equal(accepted.state,'fixture_completed',JSON.stringify(accepted));
    assert.equal(accepted.code,null,JSON.stringify(accepted));
    const after=f.history('parent');assert.equal(after.saved.records.length,before.saved.records.length+1);
    assert.deepEqual(after.saved.records.slice(0,-1),before.saved.records);assert.deepEqual(after.state,before.state);
    assert.deepEqual(after.original,before.original);assert.deepEqual(after.saved.identity,before.saved.identity);
    assert.deepEqual(after.saved.fingerprints,before.saved.fingerprints);
    assert.deepEqual(after.acceptedIntegration.plan.snapshots,nextPlan.snapshots);
    const adopted=fs.readFileSync(f.statePath('parent'));
    assert.equal(run.host.acceptReviewedIntegration(args).code,null);assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);
    run.close();run=null;run=await f.openParent();
    assert.equal((await run.host.handle(f.request('parent','status'))).code,null);
    f.write(names[0],body+' ');
    const drift=await run.host.handle(f.request('parent','status'));assert.equal(drift.code,'correction_review_required',JSON.stringify(drift));
    assert.deepEqual(f.history('parent').state,before.state);assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);
    f.write(names[0],body);assert.equal((await run.host.handle(f.request('parent','status'))).code,null);
    const proof=fs.readFileSync(f.evidenceFile);fs.writeFileSync(f.evidenceFile,Buffer.concat([proof,Buffer.from(' ')]));
    assert.equal((await run.host.handle(f.request('parent','status'))).code,'correction_review_required');fs.writeFileSync(f.evidenceFile,proof);
    assert.deepEqual(fs.readFileSync(f.statePath('parent')),adopted);assert.deepEqual(f.calls,calls);
    assert.deepEqual(fs.readFileSync(path.join(f.specsDir,f.definitions.parent.feature,'tasks.md')),tasks);
  }finally{run?.close();}
});
