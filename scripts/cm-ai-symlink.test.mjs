import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {captureReviewBaseline,createReviewPackage,projectedReviewPackage,readReviewBaseline,readReviewPackage,
  captureScopeRevisionSources,extendReviewBaseline,verifyCompletionReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {digest,JOURNAL_PAYLOAD_LIMIT,requestFor} from '../runtime/js/cm-ai/effect-contract.mjs';
import {checkpointStoragePlan,resolveCheckpointPackage} from '../runtime/js/cm-ai/checkpoint-package-material.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {captureBeforeSnapshot,replayDelivery} from '../runtime/js/cm-ai/host-replay.mjs';
import {withHostDocumentation} from '../runtime/js/cm-ai/host-documentation.mjs';
import {createProjectExecution} from '../runtime/js/cm-ai/host-project-execution.mjs';
import {applyProtectedEdits,captureProtectedEdits} from '../runtime/js/cm-fix/protected-edits.mjs';
import {applyDevelopEdits,developPreview,plannedCheckResults,preflightDevelopDeliveries,projectDevelopCheckpoint,
  protectedDevelopEdits} from './cm-ai-drive.mjs';
import {implementationSha256} from './cm-task-gate.mjs';

const identity={repositoryId:'repo',runId:'symlink-test',taskId:'T-001',attempt:1};
const checks=[{id:'check',command:['check'],outcome:'passed',exitCode:0,evidence:'passed'}];
const link='mods/mgt-pipeline/lib';
const hash=target=>createHash('sha256').update('symlink\0').update(target).digest('hex');
function project(t){
  const top=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-symlink-test-')));
  t.after(()=>fs.rmSync(top,{recursive:true,force:true}));
  const cwd=path.join(top,'code'),answers=path.join(top,'answers'),specsRoot=path.join(cwd,'specs');
  for(const dir of ['mods/mgt-pipeline','lib','lib-next','specs','.git','.reviews'])fs.mkdirSync(path.join(cwd,dir),{recursive:true});
  fs.mkdirSync(answers);
  fs.writeFileSync(path.join(cwd,'lib/file'),'internal');
  fs.writeFileSync(path.join(cwd,'note'),'before');
  fs.writeFileSync(path.join(answers,'content'),'replacement');
  const outside=path.join(top,'outside');
  fs.writeFileSync(outside,'outside sentinel');
  const capture=(scope=[link,'note'],version=3)=>captureReviewBaseline({root:cwd,identity,scope,
    requirements:['lib/file'],specsRoot,version},true);
  const set=(target,p=link)=>fs.symlinkSync(target,path.join(cwd,p));
  return {cwd,answers,specsRoot,outside,capture,set};
}
const record=(target,p=link)=>({path:p,type:'symlink',target,size:Buffer.byteLength(target),sha256:hash(target)});
const delivery=(edits,file='develop.json')=>({file,value:{status:'succeeded',edits}});
function preflight(f,scope,deliveries,options={}){
  const inputs={deliveries,answersRoot:f.answers,codeProject:f.cwd,specsRoot:f.specsRoot,scope,
    requirements:[],preview:{baseline:{version:3},material:[],exact:false},...options};
  return spawnSync(process.execPath,['--input-type=module','-e',
    `const [inputs]=process.argv.splice(1);
    const {preflightDevelopDeliveries}=await import(${JSON.stringify(new URL('./cm-ai-drive.mjs',import.meta.url).href)});
    preflightDevelopDeliveries(JSON.parse(inputs));`,JSON.stringify(inputs)],{encoding:'utf8',timeout:15000});
}

test('v3 captures links as metadata without opening referents and v2 still rejects them',t=>{
  const {cwd,outside,set,capture}=project(t);
  set('../../lib');set(outside,'outside');set('missing','dangling');set(link,'chain');
  const open=fs.openSync;
  t.mock.method(fs,'openSync',(file,...args)=>{
    assert(![outside,path.join(cwd,'outside'),path.join(cwd,link,'file')].includes(file));
    return open(file,...args);
  });
  const baseline=capture();
  assert.deepEqual(baseline.files.filter(f=>f.type==='symlink'),[record(link,'chain'),record('missing','dangling'),record('../../lib'),record(outside,'outside')]);
  assert(!baseline.files.some(f=>f.path.startsWith(link+'/')));
  assert.deepEqual(readReviewBaseline(baseline),baseline);
  assert.throws(()=>capture(undefined,2),{code:'unsupported_file'});
  const {baselineDigest,symlinkPolicy,...old}={...baseline,version:2};
  assert.throws(()=>readReviewBaseline({...old,baselineDigest:digest(old)}),{code:'invalid_baseline'});
});

test('review binds target, type, untouched scope, and extended scope; projected and real packages agree',t=>{
  const {cwd,set,capture}=project(t);
  set('../../lib');set('missing','dangling');
  const baseline=capture(),scope=[...baseline.scope,'dangling'];
  const extended=extendReviewBaseline(baseline,scope,captureScopeRevisionSources(cwd,baseline,scope));
  fs.writeFileSync(path.join(cwd,'note'),'after');
  let pkg=createReviewPackage({root:cwd,baseline:extended,checks});
  assert.equal(pkg.version,2);
  assert.deepEqual(pkg.unchangedScope,[record('missing','dangling'),record('../../lib')]);
  const projected=projectedReviewPackage({root:cwd,baseline:extended,checks,scopeFiles:[{path:link,symlink:'../../lib-next'}]});
  fs.unlinkSync(path.join(cwd,link));set('../../lib-next');
  pkg=createReviewPackage({root:cwd,baseline:extended,checks});
  assert.deepEqual(projected,pkg);
  assert.deepEqual(readReviewPackage(pkg),pkg);
  assert.deepEqual(pkg.changes.find(c=>c.path===link),{path:link,before:record('../../lib'),after:record('../../lib-next')});
  const {packageDigest,symlinkPolicy,...old}={...pkg,version:1};
  assert.throws(()=>readReviewPackage({...old,packageDigest:digest(old)}),{code:'invalid_package'});
  assert.throws(()=>createReviewPackage({root:cwd,baseline:extended,checks,
    handoffPath:path.join(cwd,link)}),{code:'unsupported_file'});
  fs.unlinkSync(path.join(cwd,link));
  fs.writeFileSync(path.join(cwd,link),'../../lib-next');
  assert.equal(createReviewPackage({root:cwd,baseline:extended,checks}).changes.find(c=>c.path===link).after.type,'file');
  assert.throws(()=>verifyCompletionReviewPackage({root:cwd,baseline:extended,checks,reviewPackage:pkg,expectedDigest:pkg.packageDigest}),{code:'package_mismatch'});
  fs.unlinkSync(path.join(cwd,'dangling'));set('elsewhere','dangling');
  assert.throws(()=>createReviewPackage({root:cwd,baseline,checks}),{code:'out_of_scope'});
});

test('protected and driver edits share link fingerprints across create, retarget and delete',t=>{
  const {cwd,specsRoot,answers}=project(t);
  const scope=[link];
  for(const [before,target] of [[null,'../../lib'],['../../lib','../../lib-next'],['../../lib-next',null]]){
    const expected=captureProtectedEdits(cwd,scope,{allowSymlinks:true});
    const map={[link]:target===null?{delete:true}:{symlink:target}};
    const edits=protectedDevelopEdits(map,answers,cwd,expected,{allowSymlinks:true,specsRoot});
    assert.deepEqual(edits,[{path:link,beforeSha256:before===null?null:hash(before),...(target===null?{content:null}:{symlink:target})}]);
    applyProtectedEdits({cwd,scope,edits,allowSymlinks:true,specsRoot});
    assert.equal(captureProtectedEdits(cwd,scope,{allowSymlinks:true})[link],target===null?null:hash(target));
  }
  applyDevelopEdits({[link]:{symlink:'../../lib'}},answers,cwd,scope,{allowSymlinks:true,specsRoot});
  assert.equal(fs.readlinkSync(path.join(cwd,link)),'../../lib');
});

test('target validation rejects unsafe edits before writes and driver preflight and apply agree',async t=>{
  const fixture=project(t),{cwd,specsRoot,answers,outside,set}=fixture;
  set('../lib','mods/alias');
  fs.symlinkSync(path.dirname(outside),path.join(cwd,'parent'));
  const options={allowSymlinks:true,specsRoot};
  const apply=(target,edit)=>applyProtectedEdits({cwd,scope:[target],edits:[{path:target,beforeSha256:null,...edit}],...options});
  const unsafe={absolute:outside,escape:'../../../outside',git:'../../.git',specs:'../../specs',reviews:'../../.reviews',
    dangling:'../../missing',chain:'../alias',hiddenChain:'../alias/../mgt-pipeline',empty:'',nul:'a\0b',tooLong:'a'.repeat(1025)};
  for(const [name,target] of Object.entries(unsafe))await t.test(name,subtest=>{
    subtest.after(()=>fs.rmSync(path.join(cwd,link),{force:true}));
    const map={[link]:{symlink:target}},error={code:'invalid_symlink_target'};
    assert.throws(()=>apply(link,{symlink:target}),error);
    const result=preflight(fixture,[link],[delivery(map)]);
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/invalid_symlink_target/);
    assert.throws(()=>applyDevelopEdits(map,answers,cwd,[link],options),error);
    assert.equal(fs.existsSync(path.join(cwd,link)),false);
  });
  assert.throws(()=>apply('parent/outside',{content:'modified'}),{code:'unsupported_path'});
  assert.throws(()=>applyProtectedEdits({cwd,scope:['new','new/file'],edits:[
    {path:'new',beforeSha256:null,symlink:'lib'},{path:'new/file',beforeSha256:null,content:'text'}],...options}),{code:'unsupported_path'});
  assert.equal(fs.existsSync(path.join(cwd,'new')),false);
  set('../../lib');
  for(const edit of [{content:'text'},{content:'text',mode:'0755'}]){
    assert.throws(()=>applyProtectedEdits({cwd,scope:[link],edits:[{path:link,beforeSha256:hash('../../lib'),...edit}],...options}),{code:'unsupported_path'});
  }
  assert.throws(()=>applyDevelopEdits({[link]:{mode:'0755'}},answers,cwd,[link],options),{code:'unsupported_path'});
  assert.throws(()=>applyDevelopEdits({[link]:{symlink:'../../lib-next',mode:'0755'}},answers,cwd,[link],options),
    /只允许单独的 symlink/);
  const value={status:'succeeded',edits:{[link]:{symlink:'../../lib-next'}}};
  const preview={baseline:{version:3},material:[],exact:false};
  preflightDevelopDeliveries({deliveries:[{file:'develop.json',value}],answersRoot:answers,codeProject:cwd,
    scope:[link],requirements:[],preview,specsRoot,protectedMode:true});
  assert.equal(fs.readlinkSync(path.join(cwd,link)),'../../lib');
  assert.equal(fs.readFileSync(outside,'utf8'),'outside sentinel');
});

test('symlink target validation rejects root underflow even when clamping would find a directory',async t=>{
  const localPath='mods/a/lib',symlink='../../../lib',error={code:'invalid_symlink_target'};
  for(const multipleRoots of [false,true])await t.test(multipleRoots?'multiple code roots':'single code root',async scenario=>{
    const linkPath=multipleRoots?`lib-next/${localPath}`:localPath;
    const codeProjectPaths=multipleRoots?['lib','lib-next']:undefined;
    const scope=[linkPath],edits={[linkPath]:{symlink}};
    function setup(subtest){
      const fixture=project(subtest),{cwd,specsRoot}=fixture;
      const codeRoot=multipleRoots?path.join(cwd,'lib-next'):cwd;
      const codeProjects=codeProjectPaths?.map(prefix=>path.join(cwd,prefix));
      fs.mkdirSync(path.join(codeRoot,'mods/a'),{recursive:true});
      if(multipleRoots){
        fs.mkdirSync(path.join(codeRoot,'lib'));
        assert.equal(path.resolve(cwd,path.dirname(linkPath),symlink),path.join(cwd,'lib'));
        assert.equal(fs.statSync(path.join(cwd,'lib')).isDirectory(),true);
      }
      assert.equal(fs.statSync(path.join(codeRoot,'lib')).isDirectory(),true);
      return {...fixture,codeRoot,options:{allowSymlinks:true,specsRoot,codeProjects}};
    }
    await scenario.test('preflight',subtest=>{
      const fixture=setup(subtest);
      const result=preflight(fixture,scope,[delivery(edits)],fixture.options);
      assert.equal(result.status,2,result.stderr);
      assert.match(result.stderr,/\binvalid_symlink_target\b/);
    });
    await scenario.test('applyDevelopEdits',subtest=>{
      const {cwd,answers,options}=setup(subtest);
      assert.throws(()=>applyDevelopEdits(edits,answers,cwd,scope,options),error);
      assert.equal(fs.lstatSync(path.join(cwd,linkPath),{throwIfNoEntry:false}),undefined);
    });
    await scenario.test('applyProtectedEdits',subtest=>{
      const {cwd,codeRoot,specsRoot}=setup(subtest);
      assert.throws(()=>applyProtectedEdits({cwd:codeRoot,specsRoot,allowSymlinks:true,scope:[localPath],
        edits:[{path:localPath,beforeSha256:null,symlink}]}),error);
      assert.equal(fs.lstatSync(path.join(cwd,linkPath),{throwIfNoEntry:false}),undefined);
    });
    await scenario.test('review package assembly',subtest=>{
      const {cwd,specsRoot,set}=setup(subtest);
      const baseline=captureReviewBaseline({root:cwd,identity,scope,requirements:['lib/file'],
        specsRoot,version:3,...(multipleRoots?{codeProjectPaths}:{})},true);
      set(symlink,linkPath);
      assert.throws(()=>createReviewPackage({root:cwd,baseline,checks}),error);
    });
  });
});

test('v2 driver preflight and both develop adapters reject a symlink answer',async t=>{
  const f=project(t),scope=[link],edits={[link]:{symlink:'../../lib'}};
  const options={allowSymlinks:false,specsRoot:f.specsRoot};
  const refused=/当前运行的基线版本不支持.*软链/;
  await t.test('preflight',()=>{
    const result=preflight(f,scope,[delivery(edits)],{preview:{baseline:{version:2},material:[],exact:false}});
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,refused);
  });
  await t.test('protectedDevelopEdits',()=>{
    assert.throws(()=>protectedDevelopEdits(edits,f.answers,f.cwd,{[link]:null},options),refused);
  });
  await t.test('applyDevelopEdits',()=>{
    assert.throws(()=>applyDevelopEdits(edits,f.answers,f.cwd,scope,options),refused);
  });
  assert.equal(fs.existsSync(path.join(f.cwd,link)),false);
});

test('driver preflight uses completed earlier deliveries to resolve second-round link targets',t=>{
  const f=project(t),target='src/new.js',alias='lib/n',scope=[target,alias];
  const baseline=f.capture(scope);
  const first=delivery({[target]:'content'}),second=delivery({[alias]:{symlink:'../src/new.js'}},'develop-a2.json');
  const result=preflight(f,scope,[first,second]);
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.existsSync(path.join(f.cwd,target)),false);
  const projected=projectedReviewPackage({root:f.cwd,baseline,checks,scopeFiles:[
    {path:target,contentBase64:fs.readFileSync(path.join(f.answers,'content'),'base64'),mode:0o644},
    {path:alias,symlink:'../src/new.js'}]});
  for(const {value} of [first,second])applyDevelopEdits(value.edits,f.answers,f.cwd,scope,{allowSymlinks:true,specsRoot:f.specsRoot});
  assert.equal(fs.readlinkSync(path.join(f.cwd,alias)),'../src/new.js');
  assert.deepEqual(projected,createReviewPackage({root:f.cwd,baseline,checks}));
  const removed=preflight(f,scope,[delivery({[target]:{delete:true}}),second]);
  assert.equal(removed.status,2,removed.stderr);
  assert.match(removed.stderr,/develop-a2\.json.*invalid_symlink_target/);
});

test('driver reports unsupported disk scope entries as Chinese preflight errors',async t=>{
  const f=project(t);f.set('lib','alias');f.set('lib','bad');
  for(const [file,code,reason] of [['alias/file','unsupported_path',/父级经过软链/],['bad','unsupported_file',/UTF-8/]])await t.test(file,()=>{
    // Inject raw readlink bytes so the non-UTF-8 case also runs on filesystems
    // that refuse to create a link with those target bytes.
    const result=spawnSync(process.execPath,['--input-type=module','-e',
      `import fs from 'node:fs';
      import {preflightDevelopDeliveries} from ${JSON.stringify(new URL('./cm-ai-drive.mjs',import.meta.url).href)};
      const [cwd,answers,file]=process.argv.slice(1);
      if(file==='bad'){
        const readlink=fs.readlinkSync;
        fs.readlinkSync=(p,...args)=>p===cwd+'/bad'?Buffer.from([255,255,255]):readlink(p,...args);
      }
      preflightDevelopDeliveries({codeProject:cwd,answersRoot:answers,scope:[file],requirements:[],
        deliveries:[{file:'develop.json',value:{status:'succeeded',edits:{[file]:'content'}}}],allowSymlinks:true});`,
      f.cwd,f.answers,file],{encoding:'utf8',timeout:15000});
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/无法读取.*范围/);
    assert.ok(result.stderr.includes(file));assert.ok(result.stderr.includes(code));
    assert.match(result.stderr,reason);
    assert.doesNotMatch(result.stderr,/\n\s+at /);
  });
});

test('legacy batch preflight still sizes protected chmod against the existing file',t=>{
  const f=project(t);
  fs.writeFileSync(path.join(f.cwd,'note'),'text'.repeat(2048));
  const deliveries=[delivery({note:{mode:'0755'}})];
  const options={diskChecks:false,protectedMode:true,inputLimit:4096};
  const old=preflight(f,['note'],deliveries,{...options,allowSymlinks:false});
  assert.equal(old.status,2,old.stderr);
  assert.match(old.stderr,/受保护模式下的应答.*超过宿主输入上限 4096/);
  const current=preflight(f,['note'],deliveries,{...options,allowSymlinks:true});
  assert.equal(current.status,0,current.stderr);
});

test('multi-root protected precheck rejects a link into a sibling before any root writes',async t=>{
  const f=project(t),codeProjects=['lib','lib-next'].map(file=>path.join(f.cwd,file));
  const execution=createProjectExecution({definition:{codeProject:f.cwd,specsDir:f.specsRoot,codeProjects},
    protection:{timeoutMs:5000,checkCommands:codeProjects.map((codeProject,i)=>({
      id:`check-${i}`,codeProject,command:[process.execPath,'-e','0']}))}});
  const scope=['lib/file','lib-next/n'],expected=execution.expected(scope,true);
  const edits=[{path:'lib/file',beforeSha256:expected['lib/file'],content:'new bytes'},
    {path:'lib-next/n',beforeSha256:null,symlink:'../lib/file'}];
  let invoked=false;
  await assert.rejects(execution.commit({scope,edits,expected,identity,allowSymlinks:true,
    signal:new AbortController().signal,onApply:()=>{invoked=true;}}),{code:'invalid_symlink_target'});
  assert.equal(invoked,false);
  assert.equal(fs.readFileSync(path.join(f.cwd,'lib/file'),'utf8'),'internal');
  assert.equal(fs.existsSync(path.join(f.cwd,'lib-next/n')),false);
});

test('documentation fallback snapshots honor the v3 link flag and see an out-of-scope retarget',async t=>{
  const f=project(t),feature='1.docs',scope=['README.md'];
  const featureDir=path.join(f.specsRoot,feature);
  fs.mkdirSync(featureDir);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(featureDir,name),'# Fixture\n');
  fs.writeFileSync(path.join(featureDir,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(f.specsRoot,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature]}));
  f.set('../../lib');
  const request=requestFor({invocationId:'docs',identity,role:'developer',provider:'codex',requestedModel:'fixture',
    contextId:'author',payload:{scope,requirements:[{path:'lib/file'}],priorReview:null}});
  const developer={provider:'codex',requestedModel:'fixture',contextId:'author',run:async()=>({
    version:1,invocationId:'docs',contextId:'author',provider:'codex',effectiveModel:'fixture',
    status:'succeeded',accepted:true,result:{outcome:'implemented'}})};
  let syncCalls=0;
  const adapter=withHostDocumentation({developer,specsDir:f.specsRoot,codeProject:f.cwd,feature,scope,
    documentationSync:{paths:scope,run:async()=>{
      syncCalls++;
      fs.unlinkSync(path.join(f.cwd,link));f.set('../../lib-next');
      return {status:'completed'};
    }}});
  const signal=new AbortController().signal;
  await assert.rejects(adapter.run(request,{signal}),{code:'unsupported_file'});
  assert.equal(syncCalls,0);
  await assert.rejects(adapter.run(request,{signal,allowSymlinks:true}),{code:'out_of_scope',message:`out_of_scope: ${link}`});
  assert.equal(syncCalls,1);
});

test('replay restores link text for baseline and red and checks no link points back to the original',async t=>{
  const {cwd,specsRoot,set}=project(t);
  set('../../lib');
  const snapshot=captureBeforeSnapshot(cwd,[link],{allowSymlinks:true});
  fs.unlinkSync(path.join(cwd,link));set('../../lib-next');
  const observed=[];
  const run=snapshot=>replayDelivery({codeProject:cwd,specsDir:specsRoot,snapshot,scope:[link],tests:[link],
    checkCommands:checks,timeoutMs:5000,identity,greenChecks:checks,signal:new AbortController().signal,
    makeCheck:({cwd:copy})=>async()=>{observed.push(fs.readlinkSync(path.join(copy,link)));return checks;}});
  assert.equal((await run(snapshot)).status,'replayed');
  assert.deepEqual(observed,['../../lib','../../lib-next']);
  snapshot.files.set(link,{symlink:path.join(cwd,'lib')});
  assert.equal((await run(snapshot)).reason,'internal_link');
  assert.deepEqual(observed,['../../lib','../../lib-next']);
});

test('task gate hashes link text without reading the referent and rejects lexical escape',t=>{
  const {cwd,set,outside}=project(t);
  const options={allowSymlinks:true};
  set('../../lib');
  const first=implementationSha256(cwd,[link],options);
  fs.writeFileSync(path.join(cwd,'lib/file'),'changed referent');
  assert.equal(implementationSha256(cwd,[link],options),first);
  fs.unlinkSync(path.join(cwd,link));set('../../lib-next');
  assert.notEqual(implementationSha256(cwd,[link],options),first);
  fs.unlinkSync(path.join(cwd,link));set(outside);
  assert.throws(()=>implementationSha256(cwd,[link],options),/outside project root/);
});

function recordHistory(records,payload,kind){
  const body={version:1,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,
    kind,payload,previousDigest:records.at(-1)?.digest??null};
  records.push({...body,digest:digest(body)});
}

test('inline, archived and referenced checkpoints preserve the same symlink fingerprint',t=>{
  const {cwd,set,capture}=project(t),baseline=capture();
  set('../../lib');
  const reviewPackage=createReviewPackage({root:cwd,baseline,checks});
  const records=[];
  const envelope=(type,fields)=>({version:3,protocol:'cm-task-runner',type,...fields});
  const effect={version:1,id:'develop-link',kind:'develop',identity};
  recordHistory(records,envelope('init',{config:{identity}}),'intent');
  recordHistory(records,envelope('effect-intent',{effect}),'intent');
  const checkpoint={state:'awaiting_review',attempt:1,reviewPackage,
    cache:[{effect,result:{state:'awaiting_review',identity,packageDigest:reviewPackage.packageDigest}}]};
  const payload=(id,checkpoint,fields)=>envelope('effect-checkpoint',{effectId:id,checkpoint,...fields});
  const inline=payload(effect.id,checkpoint,{});
  assert.deepEqual(resolveCheckpointPackage(inline,records,identity),checkpoint);
  const archive=checkpointStoragePlan({records,effectId:effect.id,checkpoint,identity,enabled:true,reserve:JOURNAL_PAYLOAD_LIMIT-8192});
  assert.deepEqual(archive.payloadFields,{packageMaterial:true});
  const stored=payload(effect.id,archive.checkpoint,archive.payloadFields);
  assert.deepEqual(resolveCheckpointPackage(stored,records,identity),checkpoint);
  recordHistory(records,stored,'result');
  const review={...effect,id:'review-link',kind:'review'};
  recordHistory(records,envelope('effect-intent',{effect:review}),'intent');
  const reviewed={...checkpoint,cache:[{effect:review,result:checkpoint.cache[0].result}]};
  const reference=checkpointStoragePlan({records,effectId:review.id,checkpoint:reviewed,identity,enabled:true,reserve:0});
  assert.equal(reference.payloadFields.packageRef.packageDigest,reviewPackage.packageDigest);
  const restored=resolveCheckpointPackage(payload(review.id,reference.checkpoint,reference.payloadFields),records,identity);
  assert.deepEqual(restored.reviewPackage,reviewPackage);
  assert.equal(restored.reviewPackage.changes[0].after.sha256,hash('../../lib'));
});

test('real current-session driver preflights, resumes and completes a new v3 run with a scoped symlink',t=>{
  const fixture=project(t),{cwd,answers,set}=fixture,root=path.dirname(cwd),feature='1.fixture';
  const specsRoot=path.join(root,'specs');
  fs.renameSync(fixture.specsRoot,specsRoot);
  const featureDir=path.join(specsRoot,feature),bin=path.join(root,'bin');
  fs.mkdirSync(featureDir);fs.mkdirSync(bin);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(featureDir,name),'# Fixture\n');
  fs.writeFileSync(path.join(featureDir,'tasks.md'),'- [ ] T-001: fixture\n');
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  write(path.join(specsRoot,'.cm-specs-status'),{status:'approved',features:[feature],specFiles:buildManifest(specsRoot)});
  const definition={version:1,specsDir:specsRoot,codeProject:cwd,feature,identity,scope:[link],requirements:['lib/file']};
  write(path.join(root,'run.json'),definition);
  write(path.join(root,'review.json'),{model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd,model:'fixture'})}});
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),path.join(bin,'codex'));
  fs.chmodSync(path.join(bin,'codex'),0o700);
  const planFile=path.join(root,'plan.json'),answerFile=path.join(answers,'develop.json');
  const plan={config:'run.json',mode:'create',hostContext:'symlink-host',
    permissions:['--review-config','review.json'],answers:'answers',checks:[{id:'check',command:[process.execPath,'-e','0']}]};
  const answer={status:'succeeded',value:{outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
    edits:{[link]:{symlink:'../../lib-next'}}};
  write(planFile,plan);
  set('../../lib');
  const drive=operation=>spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url)),
    '--plan',planFile,operation],{encoding:'utf8',timeout:60000,env:{...process.env,
    PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
  write(answerFile,{...answer,edits:{[link]:{symlink:'../../../outside'}}});
  const refused=drive('start'),store=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
  assert.equal(refused.status,2,refused.stderr);
  assert.match(refused.stderr,/invalid_symlink_target/);
  assert.equal(fs.existsSync(store),false);
  assert.equal(fs.readlinkSync(path.join(cwd,link)),'../../lib');
  write(answerFile,answer);
  const preview=developPreview({definition});
  assert.equal(preview.exact,true);
  const projected=projectDevelopCheckpoint({preview,codeProject:cwd,attempt:1,value:answer,
    projected:new Map([[link,{path:link,symlink:'../../lib-next'}]]),checks:plannedCheckResults(plan.checks)}).pkg;
  const started=drive('start');
  assert.equal(started.status,0,started.stderr);
  assert.equal(JSON.parse(started.stdout).result.state,'awaiting_review',started.stdout);
  write(planFile,{...plan,mode:'resume'});
  write(path.join(answers,'develop-a2.json'),answer);
  const completed=drive('advance');
  assert.equal(completed.status,0,completed.stderr);
  assert.match(fs.readFileSync(path.join(featureDir,'tasks.md'),'utf8'),/- \[x\] T-001/,completed.stdout);
  const journal=JSON.parse(fs.readFileSync(store,'utf8')).records;
  const history=readRunnerHistory(journal,journal[0].payload.config,3);
  assert.equal(history.original.version,3);
  assert.equal(history.state.state,'fixture_completed');
  assert.equal(history.state.reviewPackage.version,2);
  assert.deepEqual(history.state.reviewPackage.changes[0],{path:link,before:record('../../lib'),after:record('../../lib-next')});
  assert.equal(projected.packageDigest,history.state.reviewPackage.packageDigest);
  assert.equal(fs.readlinkSync(path.join(cwd,link)),'../../lib-next');
});

test('real batch driver passes the v3 flag to apply and QA snapshots',t=>{
  const f=project(t),feature='1.batch',root=path.dirname(f.cwd),specsDir=path.join(root,'specs');
  fs.renameSync(f.specsRoot,specsDir);
  f.set('../../lib');
  fs.writeFileSync(path.join(f.cwd,'lib-next/file'),'next fixture');
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const git=spawnSync('git',['-C',f.cwd,...args],{encoding:'utf8'});
    assert.equal(git.status,0,git.stderr);
  }
  const featureDir=path.join(specsDir,feature),bin=path.join(root,'bin'),taskAnswers=path.join(f.answers,feature,identity.taskId);
  fs.mkdirSync(featureDir);fs.mkdirSync(bin);fs.mkdirSync(taskAnswers,{recursive:true});
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(featureDir,name),'# Fixture\n');
  fs.writeFileSync(path.join(featureDir,'tasks.md'),`- [ ] T-001: fixture\n  - 范围: \`${link}\`\n`);
  const write=(file,value)=>fs.writeFileSync(file,JSON.stringify(value));
  write(path.join(specsDir,'.cm-specs-status'),{status:'approved',features:[feature],specFiles:buildManifest(specsDir)});
  const key=`${feature}/${identity.taskId}`,check=[process.execPath,'-e',
    `if(require('node:fs').readlinkSync(${JSON.stringify(link)})!=='../../lib-next') process.exit(1)`];
  write(path.join(root,'batch.json'),{batch:{version:1,repositoryId:'repo',batchId:'symlink-batch',specsDir,codeProject:f.cwd,
    tasks:[{feature,taskId:identity.taskId,scope:[link],requirements:['lib/file']}]},
    workflows:{[key]:{documentationPaths:[],applicableAgentFiles:[],qa:{commands:[{id:'qa-link',command:check,caseIds:[]}],
      environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}}}}});
  write(path.join(root,'review.json'),{model:'fixture',preflight:{passed:true,cli_model:'fixture',prompt_transport:'stdin',
    config_fingerprint:configFingerprint({cwd:f.cwd,model:'fixture'})}});
  fs.copyFileSync(fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url)),path.join(bin,'codex'));
  fs.chmodSync(path.join(bin,'codex'),0o700);
  const planFile=path.join(root,'plan.json');
  const plan={config:'batch.json',mode:'create',hostContext:'batch-fixture',
    permissions:['--allow-qa','--review-config','review.json'],answers:'answers',checks:{[key]:[{id:'link',command:check}]}};
  const answer={status:'succeeded',value:{outcome:'implemented',
    application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}},
    edits:{[link]:{symlink:'../../lib-next'}}};
  for(const file of ['develop.json','develop-a2.json'])write(path.join(taskAnswers,file),answer);
  write(path.join(taskAnswers,'qa-assess.json'),{confirmed:true});
  write(path.join(taskAnswers,'documentation-inspect.json'),{status:'completed',reason:'Synthetic fixture'});
  let result;
  for(let i=0;i<5;i++){
    write(planFile,i===0?plan:{...plan,mode:'resume',originalHostContext:plan.hostContext});
    const driven=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-ai-batch-drive.mjs',import.meta.url)),
      '--plan',planFile,'advance'],{encoding:'utf8',timeout:30000,env:{...process.env,
      PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),CM_WORKFLOW_LOG_HOME:path.join(root,'logs')}});
    assert.equal(driven.status,0,driven.stderr);
    result=JSON.parse(driven.stdout).result;
    assert.ok(fs.existsSync(path.join(specsDir,'运行日志.jsonl')),`${driven.stdout}\n${driven.stderr}`);
    if(result.state==='run_done')break;
  }
  assert.equal(result.state,'run_done',JSON.stringify(result));
  assert.equal(fs.readlinkSync(path.join(f.cwd,link)),'../../lib-next');
  const rows=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.filter(row=>row.event==='test_run'&&row.phase==='complete').map(row=>row.result),['PASS']);
});
