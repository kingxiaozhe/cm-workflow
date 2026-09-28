// Develop answers and driver gaps found in the pre-release audit. Every test here
// drives the real driver/host processes; none needs the Codex sandbox, so CI runs them.
// Protected-mode flows that do reach the sandbox live in cm-ai-host.test.mjs.
import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
import {PassThrough,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {buildManifest} from './cm-spec-manifest.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {applyProtectedEdits,protectedFixBridge} from '../runtime/js/cm-fix/protected-edits.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {applyDevelopEdits} from './cm-ai-drive.mjs';
import {main as fixHostMain} from './cm-fix-host.mjs';

// Log mirrors and runtime declarations stay out of the invoking user's home.
const isolated=fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-gaps-home-'));
process.env.CM_WORKFLOW_HOME=path.join(isolated,'user');
process.env.CM_WORKFLOW_LOG_HOME=path.join(isolated,'logs');
after(()=>fs.rmSync(isolated,{recursive:true,force:true}));

const DRIVER=fileURLToPath(new URL('./cm-ai-drive.mjs',import.meta.url));
const HOST=fileURLToPath(new URL('./cm-ai-host.mjs',import.meta.url));
const BATCH_HOST=fileURLToPath(new URL('./cm-ai-batch-host.mjs',import.meta.url));
const DRIVE_CORE=new URL('../runtime/js/cm-ai/drive-core.mjs',import.meta.url).href;
const HOST_CHECK=new URL('../runtime/js/cm-ai/host-check.mjs',import.meta.url).href;
const REVIEWER=fileURLToPath(new URL('./fixtures/codex-review-process.mjs',import.meta.url));
const developValue={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}};

function fixture(t,{scope=['target.mjs'],runId='drive-gaps-run',files={}}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-gaps-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsDir=path.join(root,'specs5'),codeProject=path.join(root,'app'),feature='1.work';
  const identity={repositoryId:'drive-gaps',runId,taskId:'T-001',attempt:1};
  fs.mkdirSync(path.join(specsDir,feature),{recursive:true});fs.mkdirSync(codeProject);
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'# Fixture\n');
  for(const [file,content] of Object.entries(files)){
    fs.mkdirSync(path.dirname(path.join(codeProject,file)),{recursive:true});
    fs.writeFileSync(path.join(codeProject,file),content);fs.chmodSync(path.join(codeProject,file),0o644);
  }
  const config=path.join(root,'run.json');
  fs.writeFileSync(config,JSON.stringify({version:1,specsDir,codeProject,feature,identity,scope,requirements:['requirements.md']}));
  const answers=path.join(root,'answers');fs.mkdirSync(answers);
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),
    CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const content=(name,bytes)=>fs.writeFileSync(path.join(answers,name),bytes);
  const develop=(edits,name='develop.json')=>write(name,{status:'succeeded',value:developValue,edits});
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'run.json',mode:'create',hostContext:'drive-host-a',
      permissions:[],answers:'answers',checks:[{id:'noop',command:[process.execPath,'-e','0']}],...extra}));
    return file;};
  const drive=(file,operation,timeout=60000,umask=null)=>umask===null
    ?spawnSync(process.execPath,[DRIVER,'--plan',file,operation],{encoding:'utf8',timeout,env})
    :spawnSync('/bin/sh',['-c',`umask ${umask}; exec "$0" "$@"`,process.execPath,DRIVER,'--plan',file,operation],{encoding:'utf8',timeout,env});
  const store=path.join(specsDir,'.reviews','.execution',runId,'state.json');
  const reviewer=verdict=>{
    let fake=fs.readFileSync(REVIEWER,'utf8');
    if(verdict==='changes_requested')fake=fake.replace("verdict:'approved'","verdict:'changes_requested'")
      .replace('findings:[]',"findings:[{id:'F1',severity:'P2',path:'"+scope[0]+"',message:'Revise',evidence:'Fixture finding'}]");
    fs.writeFileSync(path.join(bin,'codex'),fake,{mode:0o700});
    fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{passed:true,
      cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:codeProject,model:'fixture'})}}));
  };
  return {root,specsDir,codeProject,config,answers,bin,env,identity,write,content,develop,plan,drive,store,reviewer};
}
const result=run=>JSON.parse(run.stdout).result;
const records=f=>JSON.parse(fs.readFileSync(f.store,'utf8')).records;
const lastCheckpoint=f=>records(f).filter(row=>row.payload.type==='effect-checkpoint').at(-1).payload.checkpoint;
const noRun=f=>assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution')),false,'preflight must not create a run');

// ---- #24 run ID length -------------------------------------------------------------------------
test('#24 a run ID shorter than 8 characters is refused before the driver launches a host',t=>{
  const f=fixture(t,{runId:'short'});f.content('target.mjs','export const value = 42;\n');f.develop({'target.mjs':'target.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/runId.*8.*128/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews')),false);
});
test('#24 the host refuses a short run ID at create before writing any journal, and resume is unaffected',t=>{
  const f=fixture(t,{runId:'short'});
  const args=mode=>[HOST,'serve','--config',f.config,'--mode',mode,'--host-context','drive-host-a','--allow-development'];
  const created=spawnSync(process.execPath,args('create'),{encoding:'utf8',input:'',timeout:30000,env:f.env});
  assert.equal(created.status,1,created.stderr);
  assert.match(created.stderr,/invalid_config: identity\.runId/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution','short')),false);
  // The rule is a create-time rule: resume keeps its original path for existing journals.
  const resumed=spawnSync(process.execPath,args('resume'),{encoding:'utf8',input:'',timeout:30000,env:f.env});
  assert.equal(resumed.status,1,resumed.stderr);
  assert.match(resumed.stderr,/store_missing/);
  assert.doesNotMatch(resumed.stderr,/identity\.runId/);
});

// ---- #29 current attempt identity ---------------------------------------------------------------
test('#29 the single driver binds the current attempt for decision and complete after a revision',t=>{
  const f=fixture(t);f.reviewer('changes_requested');
  const review=['--review-config','review.json'];
  f.content('a1.mjs','export const value = 42;\n');f.develop({'target.mjs':'a1.mjs'});
  const first=f.drive(f.plan({permissions:review}),'advance');assert.equal(first.status,0,first.stderr);
  assert.equal(result(first).state,'awaiting_review');
  const decided=f.drive(f.plan({mode:'resume',permissions:[...review,'--allow-review-attempt','1'],
    packageDigest:result(first).packageDigest,answers:undefined,checks:undefined}),'decision');
  assert.equal(decided.status,0,decided.stderr);
  assert.equal(result(decided).state,'changes_requested');assert.equal(result(decided).identity.attempt,2);
  f.content('a2.mjs','export const value = 43;\n');f.develop({'target.mjs':'a2.mjs'},'develop-a2.json');f.reviewer('approved');
  const second=f.drive(f.plan({mode:'resume',permissions:review}),'advance');assert.equal(second.status,0,second.stderr);
  assert.equal(result(second).state,'awaiting_review');assert.equal(result(second).identity.attempt,2);
  const packageDigest=result(second).packageDigest;
  const approved=f.drive(f.plan({mode:'resume',permissions:[...review,'--allow-review-attempt','2'],packageDigest,
    answers:undefined,checks:undefined}),'decision');
  assert.equal(approved.status,0,approved.stderr);
  assert.equal(result(approved).outcome,'advanced',approved.stdout);
  assert.equal(result(approved).state,'approved');assert.equal(result(approved).identity.attempt,2);
  const completed=f.drive(f.plan({mode:'resume',permissions:review,packageDigest}),'complete');
  assert.equal(completed.status,0,completed.stderr);
  assert.equal(result(completed).state,'fixture_completed',completed.stdout);
  assert.equal(result(completed).identity.attempt,2);
  assert.match(fs.readFileSync(path.join(f.specsDir,'1.work','tasks.md'),'utf8'),/\[x\] T-001/);
});

// ---- #11 deletion, executable bit, rename ------------------------------------------------------
const renameScope=['scripts/test.sh','old/Legacy.swift','new/Legacy.swift'];
const renameFiles={'scripts/test.sh':'#!/bin/sh\necho TEST SUCCEEDED\n','old/Legacy.swift':'// legacy\n'};
test('#11 a develop answer deletes, sets the executable bit and renames, and the package records mode and deletion',t=>{
  const f=fixture(t,{scope:renameScope,files:renameFiles});
  f.content('legacy.swift','// legacy\n');
  f.develop({'scripts/test.sh':{mode:'0755'},'old/Legacy.swift':{delete:true},'new/Legacy.swift':'legacy.swift'});
  // The task's own check runs the script directly, so it only passes with the executable bit.
  // A private umask must not leak into new source files: they are created 0644.
  const run=f.drive(f.plan({checks:[{id:'test',command:['./scripts/test.sh']}]}),'advance',60000,'077');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'awaiting_review',run.stdout);
  assert.equal(fs.statSync(path.join(f.codeProject,'scripts/test.sh')).mode&0o777,0o755);
  assert.equal(fs.existsSync(path.join(f.codeProject,'old/Legacy.swift')),false);
  assert.equal(fs.statSync(path.join(f.codeProject,'new/Legacy.swift')).mode&0o777,0o644);
  const changes=new Map(lastCheckpoint(f).reviewPackage.changes.map(change=>[change.path,change]));
  assert.equal(changes.get('scripts/test.sh').before.mode,0o644);assert.equal(changes.get('scripts/test.sh').after.mode,0o755);
  assert.equal(changes.get('scripts/test.sh').before.sha256,changes.get('scripts/test.sh').after.sha256);
  assert.equal(changes.get('old/Legacy.swift').after,null);assert.equal(changes.get('old/Legacy.swift').before.size,10);
  assert.equal(changes.get('new/Legacy.swift').before,null);assert.equal(changes.get('new/Legacy.swift').after.mode,0o644);
  // The recorded mode is verified: dropping the bit after packaging is package drift, named by path.
  fs.chmodSync(path.join(f.codeProject,'scripts/test.sh'),0o644);
  const status=f.drive(f.plan({mode:'resume',answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,0,status.stderr);
  assert.equal(result(status).state,'blocked');assert.equal(result(status).code,'review_package_changed');
  assert.match(result(status).reason,/scripts\/test\.sh/);
});
for(const [name,edits,pattern] of [
  ['mode outside 0644/0755',{'scripts/test.sh':{mode:'0777'}},/mode/],
  ['numeric mode',{'scripts/test.sh':{file:'legacy.swift',mode:493}},/mode/],
  ['delete:false',{'old/Legacy.swift':{delete:false}},/delete/],
  ['delete with content',{'old/Legacy.swift':{delete:true,file:'legacy.swift'}},/delete/],
  ['delete of a missing file',{'new/Legacy.swift':{delete:true}},/new\/Legacy\.swift/],
  ['mode of a missing file',{'new/Legacy.swift':{mode:'0755'}},/new\/Legacy\.swift/],
  ['unknown field',{'scripts/test.sh':{file:'legacy.swift',owner:'root'}},/develop\.json\.edits/],
])test(`#11 invalid develop edit entry is refused before launch: ${name}`,t=>{
  const f=fixture(t,{scope:renameScope,files:renameFiles});f.content('legacy.swift','// legacy\n');f.develop(edits);
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/develop\.json\.edits/);assert.match(run.stderr,pattern);
  noRun(f);
});

// ---- #19 limits and no-op deliveries before launch -----------------------------------------------
test('#19 a scope file above 1 MiB is refused before launch with its path and the limit',t=>{
  const icon='Assets/AppIcon.appiconset/AppIcon.png';
  const f=fixture(t,{scope:[icon,'Assets/AppIcon.appiconset/Contents.json']});
  f.content('icon.png',crypto.randomBytes(1200*1024));f.content('contents.json','{"images":[]}\n');
  f.develop({[icon]:'icon.png','Assets/AppIcon.appiconset/Contents.json':'contents.json'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/AppIcon\.png/);assert.match(run.stderr,/1048576/);
  noRun(f);
});
test('#19 an unedited scope file above 1 MiB is refused before launch as well',t=>{
  const f=fixture(t,{scope:['Assets/big.bin','target.mjs'],files:{'Assets/big.bin':crypto.randomBytes(1200*1024)}});
  f.content('target.mjs','export const value = 42;\n');f.develop({'target.mjs':'target.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/Assets\/big\.bin/);assert.match(run.stderr,/1048576/);
  noRun(f);
});
test('#19 scope material above 2 MiB is refused before launch naming the files and the limit',t=>{
  const shots=['01-light-zh','01-dark-zh','01-light-en','01-dark-en'].map(name=>`design/baseline/${name}.png`);
  const f=fixture(t,{scope:shots});
  shots.forEach((shot,index)=>f.content(`shot-${index}.png`,crypto.randomBytes(550*1024)));
  f.develop(Object.fromEntries(shots.map((shot,index)=>[shot,`shot-${index}.png`])));
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/2097152/);assert.match(run.stderr,/design\/baseline\/01-/);
  noRun(f);
});
for(const variant of ['empty edits','identical content'])test(`#19 a no-op develop answer is refused before launch: ${variant}`,t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 42;\n'}});
  f.content('same.mjs','export const value = 42;\n');
  f.develop(variant==='empty edits'?{}:{'target.mjs':'same.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/没有任何改动/);
  noRun(f);
});

test('#19 a lesson-only delivery is not refused as empty: its Learning writeback changes AGENTS.md',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 42;\n'}});
  f.write('develop.json',{status:'succeeded',value:{...developValue,retrospective:{status:'lesson_candidate',reason:null,
    candidates:[{classification:'structured',trigger:'Fixture values need an explicit check',
      action:'Run the syntax check before delivering',evidence:['target.mjs']}]}},edits:{}});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'awaiting_review',run.stdout);
  assert(lastCheckpoint(f).reviewPackage.changes.some(change=>change.path==='AGENTS.md'));
});
test('#11 direct edits are validated as a whole before the first write',t=>{
  const f=fixture(t,{scope:['a.txt','gone.txt']});f.content('a.txt','a\n');
  assert.throws(()=>applyDevelopEdits({'a.txt':'a.txt','gone.txt':{delete:true}},f.answers,f.codeProject,['a.txt','gone.txt']),/gone\.txt/);
  assert.equal(fs.existsSync(path.join(f.codeProject,'a.txt')),false);
});
test('#11 the protected host refuses an invalid mode before any sandbox write',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 42;\n'}});
  const protection=path.join(f.root,'protection.json');
  fs.writeFileSync(protection,JSON.stringify({checkCommands:[{id:'noop',command:['/usr/bin/true']}],timeoutMs:60000}));
  for(const edit of [{content:'export const value = 43;\n',mode:'0777'},{content:null,mode:'0755'}]){
    const wrapper=path.join(f.root,`protected-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
driveHost({host:${JSON.stringify(HOST)},args:['serve','--config',${JSON.stringify(f.config)},'--mode',${JSON.stringify(fs.existsSync(f.store)?'resume':'create')},
  '--host-context','drive-host-a','--allow-development','--protected-conversation-config',${JSON.stringify(protection)}],
  cwd:${JSON.stringify(f.codeProject)},operation:'advance',answers:{},request:{version:1,identity:${JSON.stringify(f.identity)}},
  answerFor:async row=>row.kind==='develop'?{status:'succeeded',value:${JSON.stringify(developValue)},
    edits:[{path:'target.mjs',beforeSha256:row.payload.expected['target.mjs'],...${JSON.stringify(edit)}}]}:null});`);
    const run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',timeout:60000,env:f.env});
    assert.equal(run.status,0,run.stderr);
    assert.equal(result(run).state,'blocked');assert.equal(result(run).code,'developer_result_invalid');
    assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 42;\n');
    assert.equal(fs.statSync(path.join(f.codeProject,'target.mjs')).mode&0o777,0o644);
  }
});
test('#10 an invalid --input-limit is refused by the driver before launch',t=>{
  const f=fixture(t);f.content('target.mjs','export const value = 42;\n');f.develop({'target.mjs':'target.mjs'});
  const run=f.drive(f.plan({permissions:['--input-limit','64k']}),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/--input-limit/);noRun(f);
});
// A live session is not the driver: it can still deliver nothing. The runner must
// then leave a retryable develop block, not an unknown run.
function liveSession(f,{mode,write=false,act=write?"fs.writeFileSync(cwd+'/target.mjs','export const value = 43;\\n');":''}){
  const wrapper=path.join(f.root,`live-${mode}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(wrapper,`import fs from 'node:fs';
import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
import {createHostCheck} from ${JSON.stringify(HOST_CHECK)};
const cwd=${JSON.stringify(f.codeProject)};
driveHost({host:${JSON.stringify(HOST)},args:['serve','--config',${JSON.stringify(f.config)},'--mode',${JSON.stringify(mode)},
  '--host-context','drive-host-a','--allow-development'],cwd,operation:'advance',answers:{},
  request:{version:1,identity:${JSON.stringify(f.identity)}},
  answerFor:async row=>{
    if(row.kind==='develop'){
      ${act}
      return {status:'succeeded',value:${JSON.stringify(developValue)}};
    }
    if(row.kind==='check')return createHostCheck({cwd,commands:[{id:'noop',command:[process.execPath,'-e','0']}]})
      ({identity:row.payload.identity},{signal:new AbortController().signal});
    return null;
  }});
`);
  return spawnSync(process.execPath,[wrapper],{encoding:'utf8',timeout:60000,env:f.env});
}
test('#19 a live empty delivery blocks as a retryable develop_empty_changes and the retry reaches review',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 42;\n'}});
  const empty=liveSession(f,{mode:'create',write:false});assert.equal(empty.status,0,empty.stderr);
  assert.equal(result(empty).state,'blocked',empty.stdout);assert.equal(result(empty).code,'develop_empty_changes');
  assert.equal(result(empty).pendingAction,'resume');assert.match(result(empty).reason,/develop_empty_changes/);
  const retried=liveSession(f,{mode:'resume',write:true});assert.equal(retried.status,0,retried.stderr);
  assert.equal(result(retried).state,'awaiting_review',retried.stdout);
  const intents=records(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id);
  assert.deepEqual(intents,['develop-1','develop-1-retry-1']);
});
// Scope and requirements may overlap. A requirement must exist in every review
// package, so deleting one is refused before launch (Codex review of 6f005df).
test('#11 deleting a scope path that is also a requirement is refused before launch',t=>{
  const f=fixture(t,{scope:['target.mjs','requirements.md']});
  f.content('target.mjs','export const value = 42;\n');f.develop({'target.mjs':'target.mjs','requirements.md':{delete:true}});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/requirements\.md/);assert.match(run.stderr,/requirements/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'requirements.md'),'utf8'),'# Fixture\n');
  assert.equal(fs.existsSync(path.join(f.codeProject,'target.mjs')),false);
  noRun(f);
});
test('#19 a live delivery that deletes an in-scope requirement blocks retryably and the restored retry reaches review',t=>{
  const f=fixture(t,{scope:['target.mjs','requirements.md'],files:{'target.mjs':'export const value = 42;\n'}});
  const broken=liveSession(f,{mode:'create',act:"fs.writeFileSync(cwd+'/target.mjs','export const value = 43;\\n');fs.unlinkSync(cwd+'/requirements.md');"});
  assert.equal(broken.status,0,broken.stderr);
  assert.equal(result(broken).state,'blocked',broken.stdout);assert.equal(result(broken).code,'develop_requirement_missing');
  assert.equal(result(broken).pendingAction,'resume');assert.match(result(broken).reason,/requirements\.md/);
  const restored=liveSession(f,{mode:'resume',act:"fs.writeFileSync(cwd+'/requirements.md','# Fixture\\n');"});
  assert.equal(restored.status,0,restored.stderr);assert.equal(result(restored).state,'awaiting_review',restored.stdout);
  const intents=records(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id);
  assert.deepEqual(intents,['develop-1','develop-1-retry-1']);
});
test('#19 an out-of-scope write still wins over a missing requirement and stays unknown',t=>{
  const f=fixture(t,{scope:['target.mjs','requirements.md'],files:{'target.mjs':'export const value = 42;\n'}});
  const run=liveSession(f,{mode:'create',act:"fs.unlinkSync(cwd+'/requirements.md');fs.writeFileSync(cwd+'/outside.mjs','x');"});
  assert.equal(run.status,1,run.stderr);
  assert.equal(result(run).state,'unknown');assert.equal(result(run).code,'out_of_scope');
});
test('#19 a legacy unknown/empty_changes develop checkpoint still replays as unknown',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 42;\n'}});
  assert.equal(liveSession(f,{mode:'create',write:false}).status,0);
  // Rewrite the new blocked checkpoint into exactly what the previous runner wrote
  // for the same delivery: unknown/empty_changes with no reason, same frame otherwise.
  const state=JSON.parse(fs.readFileSync(f.store,'utf8'));
  const last=state.records.at(-1);assert.equal(last.payload.type,'effect-checkpoint');
  const legacy=value=>{const {reason,...rest}=value;return {...rest,state:'unknown',code:'empty_changes'};};
  const checkpoint=legacy(last.payload.checkpoint);
  checkpoint.reason=null;
  checkpoint.cache=checkpoint.cache.map(entry=>entry.effect.id===last.payload.effectId?{...entry,result:legacy(entry.result)}:entry);
  const {digest:old,...body}=last;
  const payload={...last.payload,checkpoint};
  const record={...body,payload};record.digest=digest({...body,payload});
  const {revision,...rest}=state;rest.records=[...state.records.slice(0,-1),record];
  fs.writeFileSync(f.store,JSON.stringify({...rest,revision:digest(rest)})+'\n');
  const status=f.drive(f.plan({mode:'resume',answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,1,status.stderr);
  assert.equal(result(status).state,'unknown');assert.equal(result(status).code,'empty_changes');
  assert.equal(result(status).pendingAction,'reconcile');
});

// ---- #10 input limit: bridge sizing, naming, fail-fast ------------------------------------------
function session(argv,{env,onRequest,finish}){
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,argv,{stdio:['pipe','pipe','pipe'],env});
    let buffer='',stderr='';const rows=[];
    const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('session timed out: '+stderr));},60000);
    child.stderr.on('data',chunk=>{stderr+=chunk;});
    child.stdin.on('error',()=>{});
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;
      for(let newline;(newline=buffer.indexOf('\n'))!==-1;){
        const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line)continue;
        const row=JSON.parse(line);rows.push(row);
        if(row.type==='host_ready')send({requestId:'drive',operation:'advance',...(finish??{})});
        else if(row.type==='host_request')onRequest(row,send,child);
        else if(row.type==='host_response'&&row.accepted===false)child.stdin.end();
        else if(row.requestId==='drive')child.stdin.end();
      }
    });
    child.once('error',reject);
    child.once('close',code=>{clearTimeout(timer);resolve({code,rows,stderr});});
  });
}
const padded=(row,result)=>({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,
  result:{...result,pad:'x'.repeat(100*1024)}});
test('#10 the single host sizes the tool-bridge reply limit from --input-limit',async t=>{
  const f=fixture(t);
  const run=await session([HOST,'serve','--config',f.config,'--mode','create','--host-context','drive-host-a',
    '--allow-development','--input-limit','1048576'],{env:f.env,finish:{version:1,identity:f.identity},
    onRequest:(row,send)=>send(padded(row,{status:'succeeded',value:developValue}))});
  const response=run.rows.find(row=>row.type==='host_response');
  assert.equal(response.accepted,true,JSON.stringify(response));
  // The oversized-but-allowed reply reached the developer contract, which rejects the
  // extra field: a recorded develop result, not a session left waiting or unknown.
  assert.equal(run.rows.find(row=>row.requestId==='drive').result.state,'blocked');
});
test('#10 a reply line above the single host input limit is named request_too_large',async t=>{
  const f=fixture(t);
  const run=await session([HOST,'serve','--config',f.config,'--mode','create','--host-context','drive-host-a',
    '--allow-development'],{env:f.env,finish:{version:1,identity:f.identity},
    onRequest:(row,send)=>send(padded(row,{status:'succeeded',value:developValue}))});
  assert.equal(run.code,1,run.stderr);
  assert.match(run.stderr,/"code":"request_too_large"/);assert.match(run.stderr,/65536/);assert.match(run.stderr,/--input-limit/);
  assert.doesNotMatch(run.stderr,/host_launch_failed/);
});
function batchFixture(t){
  const f=fixture(t);
  for(const args of [['init','-b','main'],['config','user.name','Fixture'],['config','user.email','fixture@example.invalid'],['add','-A'],['commit','-m','baseline']]){
    const run=spawnSync('git',['-C',f.codeProject,...args],{encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  }
  const batch={version:1,repositoryId:'batch-gaps',batchId:'batch-gaps-run',specsDir:f.specsDir,codeProject:f.codeProject,
    tasks:[{feature:'1.work',taskId:'T-001',scope:['target.mjs'],requirements:['requirements.md']}]};
  fs.writeFileSync(path.join(f.root,'batch.json'),JSON.stringify({batch,workflows:{'1.work/T-001':null}}));
  return f;
}
for(const limit of ['1048576',null])test(`#10 the batch host ${limit?'sizes the reply limit from --input-limit':'names request_too_large'}`,async t=>{
  const f=batchFixture(t);
  const run=await session([BATCH_HOST,'serve','--config',path.join(f.root,'batch.json'),'--host-context','batch-host-a',
    '--allow-development',...(limit?['--input-limit',limit]:[])],{env:f.env,
    onRequest:(row,send)=>send(padded(row,{status:'succeeded',value:developValue}))});
  if(limit){
    assert.equal(run.rows.find(row=>row.type==='host_response')?.accepted,true,run.stderr);
    assert.equal(run.rows.find(row=>row.requestId==='drive').result.state,'blocked');
  }else{
    assert.equal(run.code,1,run.stderr);assert.match(run.stderr,/"code":"request_too_large"/);
    assert.doesNotMatch(run.stderr,/batch_host_failed/);
  }
});
for(const limit of ['1048576',null])test(`#10 the fix host ${limit?'accepts --input-limit and sizes the reply limit':'names request_too_large'}`,async t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-gaps-fix-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const specsRoot=path.join(root,'specs'),cwd=path.join(root,'code');fs.mkdirSync(specsRoot);fs.mkdirSync(cwd);
  const config=path.join(root,'config.json');
  fs.writeFileSync(config,JSON.stringify({specsRoot,identity:{repositoryId:'fixture',runId:'fix-limit-run',taskId:'T-FIX-limit',attempt:1},
    defect:'Synthetic defect',reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],
      expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:2000}}));
  const input=new PassThrough(),rows=[];let errors='',answered=false;
  const send=value=>{if(!input.writableEnded)input.write(JSON.stringify(value)+'\n');};
  const output=new Writable({write(chunk,encoding,callback){
    for(const line of chunk.toString().split('\n').filter(Boolean)){
      const row=JSON.parse(line);rows.push(row);
      if(row.type==='host_ready')send({requestId:'advance',operation:'advance'});
      if(row.type==='host_request'&&!answered){answered=true;send(padded(row,{contextDigest:row.payload.contextDigest,
        status:'no_relevant_lesson',summary:'No lesson'}));}
      if((row.type==='host_response'||row.requestId==='advance')&&!input.writableEnded)input.end();
    }
    callback();
  }});
  const error=new Writable({write(chunk,encoding,callback){errors+=chunk;callback();}});
  const code=await fixHostMain(['serve','--config',config,'--mode','create','--host-context','fixture-host','--allow-reproduction',
    ...(limit?['--input-limit',limit]:[])],{input,output,error});
  if(limit){
    assert.equal(rows.find(row=>row.type==='host_response')?.accepted,true,errors);
    assert.equal(code,0,errors);
  }else{
    assert.equal(code,1);assert.match(errors,/"code":"request_too_large"/);assert.doesNotMatch(errors,/fix_host_failed/);
  }
});
test('#10 the tool bridge names an oversized reply separately from a mismatched one',async()=>{
  const bridge=createHostToolBridge({responseLimit:64*1024}),sent=[];
  bridge.attach(row=>{if(row.type==='host_request')sent.push(row);});
  const call=bridge.call('develop',{},new AbortController().signal);await new Promise(resolve=>setImmediate(resolve));
  const row=sent[0],reply=result=>({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
  assert.deepEqual(bridge.accept(reply({pad:'x'.repeat(64*1024)})),{accepted:false,code:'host_response_too_large'});
  assert.deepEqual(bridge.accept({...reply({}),callId:'other'}),{accepted:false,code:'host_response_mismatch'});
  assert.equal(bridge.accept(reply({ok:true})).accepted,true);assert.deepEqual(await call,{ok:true});bridge.close();
});
test('#10 the driver stops waiting when the host rejects a reply',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-gaps-reject-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // A host that rejects every reply and only answers once its input closes.
  const host=path.join(root,'rejecting-host.mjs'),wrapper=path.join(root,'drive.mjs');
  fs.writeFileSync(host,`const out=row=>process.stdout.write(JSON.stringify(row)+'\\n');
out({type:'host_ready',sessionId:'s'});let text='';
process.stdin.on('data',chunk=>{text+=chunk;for(let at;(at=text.indexOf('\\n'))>=0;){const row=JSON.parse(text.slice(0,at));text=text.slice(at+1);
  if(row.requestId==='drive')out({type:'host_request',sessionId:'s',callId:'c',requestDigest:'d',kind:'develop',payload:{}});
  if(row.type==='host_result'){out({type:'host_response',accepted:false,code:'host_response_too_large'});
    out({type:'host_request',sessionId:'s',callId:'c2',requestDigest:'d2',kind:'develop',payload:{}});}}});
// Even a result that is not itself a failure must not turn a rejected reply into success.
process.stdin.on('end',()=>{out({requestId:'drive',result:{state:'blocked',code:'failed'}});process.exit(0);});
`);
  fs.writeFileSync(wrapper,`import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
driveHost({host:${JSON.stringify(host)},args:[],cwd:${JSON.stringify(root)},operation:'advance',answers:{},
  answerFor:async()=>({status:'succeeded',value:{}})});`);
  const run=spawnSync(process.execPath,[wrapper],{encoding:'utf8',timeout:15000});
  assert.notEqual(run.signal,'SIGTERM','driver kept waiting for a rejected reply');
  assert.equal(run.status,1,run.stderr);
  assert.match(run.stderr,/host_response_too_large/);assert.match(run.stderr,/--input-limit/);
  // The ended session receives nothing more, and the host's own result is still reported.
  assert.doesNotMatch(run.stderr,/ERR_STREAM_WRITE_AFTER_END|write after end/);
  assert.equal(JSON.parse(run.stdout).result.state,'blocked');
});
test('#10 a protected develop reply above the input limit is refused before launch',t=>{
  const f=fixture(t,{scope:['App.xcodeproj/project.pbxproj']});
  fs.writeFileSync(path.join(f.root,'protection.json'),JSON.stringify({checkCommands:[{id:'noop',command:['/usr/bin/true']}],timeoutMs:60000}));
  f.content('pbxproj.txt','// !$*UTF8*$!\n'+'\t\tA1D0000000000000000001 /* x */ = {isa = PBXBuildFile; };\n'.repeat(1500));
  f.develop({'App.xcodeproj/project.pbxproj':'pbxproj.txt'});
  const run=f.drive(f.plan({runtime:'claude',permissions:['--protected-conversation-config','protection.json'],checks:undefined}),'advance',30000);
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/--input-limit/);assert.match(run.stderr,/65536/);
  noRun(f);
});

// ---- #31 protected text mode --------------------------------------------------------------------
const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4a50000000049454e44ae426082','hex');
test('#31 protected mode refuses non-UTF-8 develop content before launch',t=>{
  const f=fixture(t,{scope:['Assets/icon.png']});
  fs.writeFileSync(path.join(f.root,'protection.json'),JSON.stringify({checkCommands:[{id:'noop',command:['/usr/bin/true']}],timeoutMs:60000}));
  f.content('icon.png',png);f.develop({'Assets/icon.png':'icon.png'});
  const run=f.drive(f.plan({runtime:'claude',permissions:['--protected-conversation-config','protection.json'],checks:undefined}),'advance',30000);
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/UTF-8/);assert.match(run.stderr,/Assets\/icon\.png/);
  noRun(f);
});
test('#31 protected text edits create new files 0644 and apply an explicit mode; cm-fix proposals keep their shape',async t=>{
  const cwd=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-drive-gaps-edits-')));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  fs.mkdirSync(path.join(cwd,'bin'));fs.writeFileSync(path.join(cwd,'bin','run'),'#!/bin/sh\n');fs.chmodSync(path.join(cwd,'bin','run'),0o644);
  const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
  // The sandbox inherits the caller's umask; a private one must not make new source 0600.
  const umask=process.umask(0o077);
  try{applyProtectedEdits({cwd,scope:['new.txt','bin/run'],edits:[{path:'new.txt',beforeSha256:null,content:'new\n'},
    {path:'bin/run',beforeSha256:sha('#!/bin/sh\n'),content:'#!/bin/sh\n',mode:'0755'}]});}
  finally{process.umask(umask);}
  assert.equal(fs.statSync(path.join(cwd,'new.txt')).mode&0o777,0o644);
  assert.equal(fs.statSync(path.join(cwd,'bin','run')).mode&0o777,0o755);
  assert.throws(()=>applyProtectedEdits({cwd,scope:['new.txt'],edits:[{path:'new.txt',beforeSha256:sha('new\n'),content:'x',mode:'0777'}]}),
    {code:'protected_edit_invalid'});
  assert.throws(()=>applyProtectedEdits({cwd,scope:['new.txt'],edits:[{path:'new.txt',beforeSha256:sha('new\n'),content:null,mode:'0755'}]}),
    {code:'protected_edit_invalid'});
  const bridge={call:async(kind,payload)=>({outcome:'repaired',edits:[{path:'new.txt',beforeSha256:payload.expected['new.txt'],content:'x\n',mode:'0755'}]})};
  const fix=protectedFixBridge({bridge,cwd,specsRoot:path.join(cwd,'specs'),timeoutMs:1000});
  await assert.rejects(fix.call('fix_repair',{codeProject:cwd,scope:['new.txt'],identity:{repositoryId:'r',runId:'fix-run-01',taskId:'T-1',attempt:1},
    instructions:'Repair'},new AbortController().signal),{code:'invalid_input'});
  assert.equal(fs.readFileSync(path.join(cwd,'new.txt'),'utf8'),'new\n');
});
