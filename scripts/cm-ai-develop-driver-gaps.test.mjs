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
import {captureReviewBaseline} from '../runtime/js/cm-ai/review-package.mjs';
import {boundReviewText,reviewResultForPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {REVIEW_TEXT_LIMIT,JOURNAL_PAYLOAD_LIMIT} from '../runtime/js/cm-ai/effect-contract.mjs';
import {main as fixHostMain} from './cm-fix-host.mjs';
import {runLiveDriver} from './fixtures/live-evidence-driver.mjs';

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
  // create requires a bound review configuration; reviewer() replaces it with the
  // same model and a real preflight, so the durable fingerprint is unchanged.
  fs.writeFileSync(path.join(root,'review.json'),JSON.stringify({model:'fixture',preflight:{}}));
  const bin=path.join(root,'bin');fs.mkdirSync(bin);
  const env={...process.env,PATH:bin+path.delimiter+process.env.PATH,CM_WORKFLOW_HOME:path.join(root,'home'),
    CM_WORKFLOW_LOG_HOME:path.join(root,'logs')};
  const write=(name,value)=>fs.writeFileSync(path.join(answers,name),JSON.stringify(value));
  const content=(name,bytes)=>fs.writeFileSync(path.join(answers,name),bytes);
  const develop=(edits,name='develop.json')=>write(name,{status:'succeeded',value:developValue,edits});
  const plan=(extra={})=>{const file=path.join(root,`plan-${Math.random().toString(36).slice(2)}.json`);
    const value={config:'run.json',mode:'create',hostContext:'drive-host-a',
      permissions:[],answers:'answers',checks:[{id:'noop',command:[process.execPath,'-e','0']}],...extra};
    if(!value.permissions.includes('--review-config'))value.permissions=[...value.permissions,'--review-config','review.json'];
    fs.writeFileSync(file,JSON.stringify(value));
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
test('single advance reaches live logic and browser QA only after independent fixture Review',async t=>{
  const f=fixture(t);f.reviewer('approved');f.content('target.mjs','export const value = 42;\n');f.develop({'target.mjs':'target.mjs'});f.develop({'target.mjs':'target.mjs'},'develop-a2.json');
  const cases=['logic','browser'].map((kind,index)=>({id:`TC-00${index+1}`,origin:'user',kind,blocking:true,
    acIds:[],taskIds:['T-001'],title:'Fixture observation',preconditions:[],steps:['Observe fixture'],expected:['value is 42'],cleanup:[]}));
  fs.writeFileSync(path.join(f.specsDir,'1.work/test-cases.json'),JSON.stringify({schemaVersion:'1.0',feature:'work',cases}));
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
  fs.writeFileSync(path.join(f.root,'workflow.json'),JSON.stringify({documentationPaths:[],applicableAgentFiles:[],qa:{
    commands:[{id:'fixture-check',caseIds:['TC-001'],command:[process.execPath,'-e','0']}],
    environment:{kind:'web',carrier:'browser',target:'fixture',scope:'local'}}}));
  f.write('qa-assess.json',{scores:{scope:2,risk:2,accumulation:2,boundary:2},changes:{api:false,migration:false,authentication:false,authorization:false,payment:false}});
  f.write('documentation-inspect.json',{status:'completed',reason:'Fixture inspected'});
  const plan=f.plan({permissions:['--allow-review-attempt','1','--workflow-config','workflow.json','--allow-qa','--browser-qa','available'],
    liveEvidence:{directory:'exchange',kinds:['qa_logic','qa_browser'],timeoutMs:1000}});
  const out=await runLiveDriver(DRIVER,plan,'advance',row=>row.kind==='qa_logic'
    ?{verdict:'SUPPORTED',evidence:['Fixture target.mjs exports 42']}
    :{verdict:'BLOCKED',evidence:[],environment:row.payload.environment,cleanup:'not_needed'},{env:f.env});
  assert.equal(out.status,0,out.stderr);assert.deepEqual(out.requests.map(r=>r.kind),['qa_logic','qa_browser']);
  assert.equal(result(out).code,'qa_result_blocked');
});
test('single live verification precheck executes after checks and blocks before Review',async t=>{
  const f=fixture(t);f.content('target.mjs','export const value = 42;\n');f.develop({'target.mjs':'target.mjs'});
  fs.writeFileSync(path.join(f.specsDir,'1.work/tasks.md'),'- [ ] T-001: fixture\n  - 验证: value is 43\n');
  fs.writeFileSync(path.join(f.specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:['1.work'],specFiles:buildManifest(f.specsDir)}));
  const plan=f.plan({verificationPrecheck:true,liveEvidence:{directory:'exchange',kinds:['verification_precheck'],timeoutMs:1000}});
  const out=await runLiveDriver(DRIVER,plan,'advance',row=>{
    assert.equal(row.kind,'verification_precheck');
    assert.match(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),/42/);
    return {items:[{requirement:'value is 43',satisfied:false,evidence:'Actual fixture source exports 42'}]};
  },{env:f.env});
  assert.equal(out.status,0,out.stderr);assert.equal(out.requests.length,1);
  assert.equal(result(out).code,'verification_precheck_failed');
  assert.equal(result(out).pendingAction,'resume');
});

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
  const args=mode=>[HOST,'serve','--config',f.config,'--mode',mode,'--host-context','drive-host-a','--allow-development','--review-config',path.join(f.root,'review.json')];
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
  '--host-context','drive-host-a','--allow-development','--review-config',${JSON.stringify(path.join(f.root,'review.json'))},'--protected-conversation-config',${JSON.stringify(protection)}],
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
function liveSession(f,{mode,write=false,act=write?"fs.writeFileSync(cwd+'/target.mjs','export const value = 43;\\n');":'',args=[],value=developValue}){
  const wrapper=path.join(f.root,`live-${mode}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(wrapper,`import fs from 'node:fs';
import {driveHost} from ${JSON.stringify(DRIVE_CORE)};
import {createHostCheck} from ${JSON.stringify(HOST_CHECK)};
const cwd=${JSON.stringify(f.codeProject)};
driveHost({host:${JSON.stringify(HOST)},args:['serve','--config',${JSON.stringify(f.config)},'--mode',${JSON.stringify(mode)},
  '--host-context','drive-host-a','--allow-development',...${JSON.stringify(args.includes('--review-config')?args:['--review-config',path.join(f.root,'review.json'),...args])}],cwd,operation:'advance',answers:{},
  request:{version:1,identity:${JSON.stringify(f.identity)}},
  answerFor:async row=>{
    if(row.kind==='develop'){
      ${act}
      return {status:'succeeded',value:${JSON.stringify(value)}};
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
const oversizedScope=['samples/one.bin','samples/two.bin','samples/three.bin'];
const writeOversizedScope=`fs.mkdirSync(cwd+'/samples',{recursive:true});for(const file of ${JSON.stringify(oversizedScope)})`
  +`fs.writeFileSync(cwd+'/'+file,Buffer.alloc(750*1024,0x61));`;
const shrinkOversizedScope=`for(const file of ${JSON.stringify(oversizedScope)})fs.writeFileSync(cwd+'/'+file,'small\\n');`;
test('#19 a direct live host maps oversized review material to a retryable develop package block',t=>{
  const f=fixture(t,{scope:oversizedScope});
  const blocked=liveSession(f,{mode:'create',act:writeOversizedScope});
  assert.equal(blocked.status,0,blocked.stderr);
  assert.equal(result(blocked).state,'blocked',blocked.stdout);
  assert.equal(result(blocked).code,'develop_package_too_large');
  assert.equal(result(blocked).pendingAction,'resume');
  assert.match(result(blocked).reason,/2097152/);
  const retried=liveSession(f,{mode:'resume',act:shrinkOversizedScope});
  assert.equal(retried.status,0,retried.stderr);
  assert.equal(result(retried).state,'awaiting_review',retried.stdout);
  const intents=records(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id);
  assert.deepEqual(intents,['develop-1','develop-1-retry-1']);
});
test('#19 a legacy unknown limit checkpoint resumes as a retryable develop package block',t=>{
  const f=fixture(t,{scope:oversizedScope});
  const blocked=liveSession(f,{mode:'create',act:writeOversizedScope});
  assert.equal(blocked.status,0,blocked.stderr);
  assert.equal(result(blocked).code,'develop_package_too_large',blocked.stdout);
  // Reproduce the previous runner's durable checkpoint exactly: the successful
  // developer call and passed checks were retained, but the terminal was unknown.
  const state=JSON.parse(fs.readFileSync(f.store,'utf8'));
  const last=state.records.at(-1);assert.equal(last.payload.type,'effect-checkpoint');
  const legacy=value=>({...value,state:'unknown',code:'limit_exceeded',
    reason:'limit_exceeded: samples/three.bin (material bytes 1536000+768000 > 2097152; scope, requirements and AGENTS.md content count)'});
  const checkpoint=legacy(last.payload.checkpoint);
  checkpoint.cache=checkpoint.cache.map(entry=>entry.effect.id===last.payload.effectId?{...entry,result:legacy(entry.result)}:entry);
  const {digest:old,...body}=last;
  const payload={...last.payload,checkpoint};const record={...body,payload};record.digest=digest({...body,payload});
  const {revision,...rest}=state;rest.records=[...state.records.slice(0,-1),record];
  fs.writeFileSync(f.store,JSON.stringify({...rest,revision:digest(rest)})+'\n');
  const status=f.drive(f.plan({mode:'resume',answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,0,status.stderr);
  assert.equal(result(status).state,'blocked',status.stdout);
  assert.equal(result(status).code,'develop_package_too_large');
  assert.equal(result(status).pendingAction,'resume');
  const retried=liveSession(f,{mode:'resume',act:shrinkOversizedScope});
  assert.equal(retried.status,0,retried.stderr);
  assert.equal(result(retried).state,'awaiting_review',retried.stdout);
});
test('#19 a generic legacy limit after passed checks is not reclassified as review material',t=>{
  const f=fixture(t,{scope:oversizedScope});
  const blocked=liveSession(f,{mode:'create',act:writeOversizedScope});
  assert.equal(blocked.status,0,blocked.stderr);
  const state=JSON.parse(fs.readFileSync(f.store,'utf8')),last=state.records.at(-1);
  const legacy=value=>({...value,state:'unknown',code:'limit_exceeded',reason:'limit_exceeded'});
  const checkpoint=legacy(last.payload.checkpoint);
  checkpoint.cache=checkpoint.cache.map(entry=>entry.effect.id===last.payload.effectId?{...entry,result:legacy(entry.result)}:entry);
  const {digest:old,...body}=last;
  const payload={...last.payload,checkpoint};const record={...body,payload};record.digest=digest({...body,payload});
  const {revision,...rest}=state;rest.records=[...state.records.slice(0,-1),record];
  fs.writeFileSync(f.store,JSON.stringify({...rest,revision:digest(rest)})+'\n');
  const status=f.drive(f.plan({mode:'resume',answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,1,status.stderr);
  assert.equal(result(status).state,'unknown',status.stdout);
  assert.equal(result(status).code,'limit_exceeded');
  assert.equal(result(status).pendingAction,'reconcile');
});
test('#19 legacy review material diagnostics allow parentheses in the reported path',async()=>{
  const {reviewMaterialLimitReason}=await import('../runtime/js/cm-ai/review-package.mjs');
  assert.equal(reviewMaterialLimitReason('limit_exceeded: samples/probe (draft).png '
    +'(material bytes 1536000+768000 > 2097152; scope, requirements and AGENTS.md content count)'),true);
  assert.equal(reviewMaterialLimitReason('limit_exceeded'),false);
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
// A53: the out-of-scope write still wins, now as the named, retryable re-check block.
test('#19 an out-of-scope write still wins over a missing requirement and names the path',t=>{
  const f=fixture(t,{scope:['target.mjs','requirements.md'],files:{'target.mjs':'export const value = 42;\n'}});
  const run=liveSession(f,{mode:'create',act:"fs.unlinkSync(cwd+'/requirements.md');fs.writeFileSync(cwd+'/outside.mjs','x');"});
  assert.equal(result(run).state,'blocked',run.stdout);assert.equal(result(run).code,'develop_out_of_scope');
  assert.match(result(run).reason,/outside\.mjs/);assert.equal(result(run).pendingAction,'resume');
});
// Round 2 (Codex re-review of 304cbfb): a develop-gate block after a
// changes_requested review must be retryable at attempt 2 as it is at attempt 1.
function secondRound(f){
  f.reviewer('changes_requested');
  const review=['--review-config','review.json'];
  f.content('a1.mjs','export const value = 42;\n');f.develop({'target.mjs':'a1.mjs'});
  const first=f.drive(f.plan({permissions:review}),'advance');assert.equal(first.status,0,first.stderr);
  const decided=f.drive(f.plan({mode:'resume',permissions:[...review,'--allow-review-attempt','1'],
    packageDigest:result(first).packageDigest,answers:undefined,checks:undefined}),'decision');
  assert.equal(decided.status,0,decided.stderr);assert.equal(result(decided).state,'changes_requested');
  return review;
}
test('#19 a second-round develop whose checks fail retries in the same attempt after the fix',t=>{
  const f=fixture(t),review=secondRound(f);
  f.content('a2.mjs','export const value = 43;\n');f.develop({'target.mjs':'a2.mjs'},'develop-a2.json');
  const failing=f.drive(f.plan({mode:'resume',permissions:review,
    checks:[{id:'unit',command:[process.execPath,'-e','process.exit(3)']}]}),'advance');
  assert.equal(failing.status,0,failing.stderr);
  assert.equal(result(failing).state,'blocked',failing.stdout);assert.equal(result(failing).code,'develop_checks_not_passed');
  assert.equal(result(failing).identity.attempt,2);assert.equal(result(failing).pendingAction,'resume');
  const retried=f.drive(f.plan({mode:'resume',permissions:review}),'advance');
  assert.equal(retried.status,0,retried.stderr);
  assert.equal(result(retried).state,'awaiting_review',retried.stdout);assert.equal(result(retried).identity.attempt,2);
  const intents=records(f).filter(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='develop').map(row=>row.payload.effect.id);
  assert.deepEqual(intents,['develop-1','develop-2','develop-2-retry-1']);
});
test('#19 a second-round delivery that deletes an in-scope requirement is recoverable at attempt 2',t=>{
  const f=fixture(t,{scope:['target.mjs','requirements.md']}),review=secondRound(f);
  const args=['--review-config',path.join(f.root,'review.json')];
  const broken=liveSession(f,{mode:'resume',args,
    act:"fs.writeFileSync(cwd+'/target.mjs','export const value = 43;\\n');fs.unlinkSync(cwd+'/requirements.md');"});
  assert.equal(broken.status,0,broken.stderr);
  assert.equal(result(broken).state,'blocked',broken.stdout);assert.equal(result(broken).code,'develop_requirement_missing');
  assert.equal(result(broken).identity.attempt,2);
  // The round-2 edit stays on disk; only the requirement is restored.
  const restored=liveSession(f,{mode:'resume',args,act:"fs.writeFileSync(cwd+'/requirements.md','# Fixture\\n');"});
  assert.equal(restored.status,0,restored.stderr);
  assert.equal(result(restored).state,'awaiting_review',restored.stdout);assert.equal(result(restored).identity.attempt,2);
  const changes=lastCheckpoint(f).reviewPackage.changes.map(change=>change.path);
  assert.deepEqual(changes,['target.mjs']);
});
test('#19 review material counts every AGENTS.md the snapshot carries, not only ancestors',t=>{
  // Two unrelated instruction files plus scope growth: 300+300+1000+900 KiB > 2 MiB.
  const f=fixture(t,{scope:['target.mjs','big2.mjs'],files:{'a/AGENTS.md':'a'.repeat(300*1024),
    'b/AGENTS.md':'b'.repeat(300*1024),'target.mjs':'export const value = 1;\n'}});
  f.content('grown.mjs','//'+'y'.repeat(1000*1024)+'\n');f.content('big2.mjs','//'+'z'.repeat(900*1024)+'\n');
  f.develop({'target.mjs':'grown.mjs','big2.mjs':'big2.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/2097152/);assert.match(run.stderr,/[ab]\/AGENTS\.md/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 1;\n');
  noRun(f);
});
// Journal record payloads are capped at 1 MiB (execution-store). A review package
// carries base64 content, so a delivery must fit that record, not only the
// review-package limits, or the checkpoint cannot be written after the files are.
const line=kib=>'//'+'x'.repeat(kib*1024)+'\n';
for(const kib of [700,800,1000])test(`#19 a ${kib} KiB delivery whose checkpoint exceeds the journal budget is refused before any write`,t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 1;\n'}});
  f.content('big.mjs',line(kib));f.develop({'target.mjs':'big.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);
  assert.match(run.stderr,/target\.mjs/);assert.match(run.stderr,/1048576/);
  assert.equal(fs.readFileSync(path.join(f.codeProject,'target.mjs'),'utf8'),'export const value = 1;\n');
  noRun(f);
});
test('#19 a 500 KiB delivery still fits the journal and reaches review',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 1;\n'}});
  f.content('big.mjs',line(500));f.develop({'target.mjs':'big.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).state,'awaiting_review',run.stdout);
});
test('#19 a create baseline too large for its journal record is refused by the driver before launch',t=>{
  const f=fixture(t,{scope:['Assets/big.bin','target.mjs'],files:{'Assets/big.bin':crypto.randomBytes(800*1024)}});
  f.content('target.mjs','export const value = 1;\n');f.develop({'target.mjs':'target.mjs'});
  const run=f.drive(f.plan(),'advance');
  assert.equal(run.status,2,run.stderr);assert.match(run.stderr,/Assets\/big\.bin/);assert.match(run.stderr,/1048576/);
  assert.equal(fs.existsSync(path.join(f.codeProject,'target.mjs')),false);noRun(f);
});
test('#19 the host refuses an oversized create baseline before it creates any journal',t=>{
  const f=fixture(t,{scope:['Assets/big.bin'],files:{'Assets/big.bin':crypto.randomBytes(800*1024)}});
  const run=spawnSync(process.execPath,[HOST,'serve','--config',f.config,'--mode','create','--host-context','drive-host-a',
    '--allow-development','--review-config',path.join(f.root,'review.json')],{encoding:'utf8',input:'',timeout:60000,env:f.env});
  assert.equal(run.status,1,run.stderr);assert.match(run.stderr,/Assets\/big\.bin/);assert.match(run.stderr,/1048576/);
  assert.equal(fs.existsSync(path.join(f.specsDir,'.reviews','.execution',f.identity.runId)),false);
});
test('#19 the runner refuses an init record that only the run metadata pushes over the journal limit',t=>{
  // Size a scope file so the baseline alone fits one record but baseline plus
  // the runner's own metadata does not: only the exact init check can see it.
  const probe=fixture(t,{scope:['Assets/big.bin'],files:{'Assets/big.bin':Buffer.alloc(3,0x61)}});
  const baselineBytes=f=>Buffer.byteLength(JSON.stringify(captureReviewBaseline({root:f.codeProject,specsRoot:f.specsDir,
    identity:f.identity,scope:['Assets/big.bin'],requirements:['requirements.md'],specification:{specsRoot:f.specsDir,feature:'1.work'}})));
  const created=spawnSync(process.execPath,[HOST,'serve','--config',probe.config,'--mode','create','--host-context','drive-host-a',
    '--allow-development','--review-config',path.join(probe.root,'review.json')],{encoding:'utf8',input:'',timeout:60000,env:probe.env});
  assert.equal(created.status,0,created.stderr);
  const init=Buffer.byteLength(JSON.stringify(records(probe)[0].payload)),overhead=init-baselineBytes(probe);
  assert(overhead>512,`metadata overhead ${overhead}`);
  const target=1024*1024-Math.floor(overhead/2),base=baselineBytes(probe)-4;
  const size=Math.floor((target-base)/4)*3;
  const f=fixture(t,{scope:['Assets/big.bin'],files:{'Assets/big.bin':Buffer.alloc(size+3,0x61)}});
  assert(baselineBytes(f)<=1024*1024&&baselineBytes(f)+overhead>1024*1024,`${baselineBytes(f)} + ${overhead}`);
  const run=spawnSync(process.execPath,[HOST,'serve','--config',f.config,'--mode','create','--host-context','drive-host-a',
    '--allow-development','--review-config',path.join(f.root,'review.json')],{encoding:'utf8',input:'',timeout:60000,env:f.env});
  assert.equal(run.status,1,run.stderr);assert.match(run.stderr,/Assets\/big\.bin/);assert.match(run.stderr,/1048576/);
  assert.equal(fs.existsSync(f.store)?records(f).length:0,0,'no journal record is written');
});
test('#19 a live delivery too large for its checkpoint blocks retryably and a smaller retry reaches review',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 1;\n'}});
  const big=liveSession(f,{mode:'create',act:`fs.writeFileSync(cwd+'/target.mjs','//'+'x'.repeat(800*1024)+'\\n');`});
  assert.equal(big.status,0,big.stderr);
  assert.equal(result(big).state,'blocked',big.stdout);assert.equal(result(big).code,'develop_package_too_large');
  assert.equal(result(big).pendingAction,'resume');assert.match(result(big).reason,/target\.mjs/);assert.match(result(big).reason,/1048576/);
  const small=liveSession(f,{mode:'resume',act:"fs.writeFileSync(cwd+'/target.mjs','export const value = 2;\\n');"});
  assert.equal(small.status,0,small.stderr);assert.equal(result(small).state,'awaiting_review',small.stdout);
  const intents=records(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id);
  assert.deepEqual(intents,['develop-1','develop-1-retry-1']);
});
test('#19 a delivery whose develop checkpoint fits but leaves no room for review and completion is redone',t=>{
  // Under the 1 MiB record on its own, over the budget that keeps room for the
  // bounded review and completion checkpoints, which carry the same package again.
  const f=fixture(t,{files:{'target.mjs':'export const value = 1;\n'}});
  const run=liveSession(f,{mode:'create',act:`fs.writeFileSync(cwd+'/target.mjs','//'+'x'.repeat(700*1024)+'\\n');`});
  assert.equal(run.status,0,run.stderr);
  assert.equal(result(run).state,'blocked',run.stdout);assert.equal(result(run).code,'develop_package_too_large');
  const [,bytes,budget]=/checkpoint would be (\d+) bytes, above (\d+)/.exec(result(run).reason).map(Number);
  assert(bytes<=JOURNAL_PAYLOAD_LIMIT&&bytes>budget,`${bytes} ${budget}`);
  assert.match(result(run).reason,/bounded review/);
});
// Codex review of 090d683: a valid reviewer result near the admitted package limit
// must still leave every later checkpoint persistable.
test('#19 a package admitted at the budget edge survives a maximal review through completion',t=>{
  const f=fixture(t,{files:{'target.mjs':'export const value = 1;\n'}});f.reviewer('approved');
  const cli=path.join(f.bin,'codex');
  fs.writeFileSync(cli,fs.readFileSync(cli,'utf8').replace("findings:[],summary:'Synthetic process review, not model evidence'",
    "findings:Array.from({length:40},(_,n)=>({id:'F'+n,severity:'P3',path:data.examinedPaths[0],message:'m'.repeat(2000),"
    +"evidence:'e'.repeat(2000)})),summary:'s'.repeat(20000)"));
  const args=['--review-config',path.join(f.root,'review.json')];
  // Walk down from an oversized delivery using the runner's own figures. Base64
  // carries 3 content bytes in 4; each redo adds about 5 KB to the frame and the
  // reserve together, and all effects must stay within the six-effect limit.
  let content=700*1024,admitted,budget,mode='create';
  for(let round=0;round<3;round++){
    admitted=liveSession(f,{mode,args,act:`fs.writeFileSync(cwd+'/target.mjs','//'+'x'.repeat(${content})+'\\n');`});mode='resume';
    assert.equal(admitted.status,0,admitted.stderr);
    if(result(admitted).state==='awaiting_review')break;
    const [,bytes,limit]=/checkpoint would be (\d+) bytes, above (\d+)/.exec(result(admitted).reason).map(Number);
    budget=limit;content-=Math.ceil((bytes-limit+8000)*3/4);
  }
  assert.equal(result(admitted).state,'awaiting_review',admitted.stdout);
  const developed=Buffer.byteLength(JSON.stringify(records(f).at(-1).payload));
  assert(developed<=budget&&developed>budget-8192,`${developed} vs ${budget}`);
  const review=['--review-config','review.json'];
  const decided=f.drive(f.plan({mode:'resume',permissions:[...review,'--allow-review-attempt','1'],
    packageDigest:result(admitted).packageDigest,answers:undefined,checks:undefined}),'decision');
  assert.equal(decided.status,0,decided.stderr);assert.equal(result(decided).state,'approved',decided.stdout);
  const completed=f.drive(f.plan({mode:'resume',permissions:review,packageDigest:result(admitted).packageDigest}),'complete');
  assert.equal(completed.status,0,completed.stderr);assert.equal(result(completed).state,'fixture_completed',completed.stdout);
  const payloads=records(f).map(row=>Buffer.byteLength(JSON.stringify(row.payload)));
  assert(Math.max(...payloads)<=JOURNAL_PAYLOAD_LIMIT,String(Math.max(...payloads)));
  const receipt=records(f).filter(row=>row.payload.type==='effect-checkpoint').at(-1).payload.checkpoint.receipt.result;
  const text=Buffer.byteLength(JSON.stringify(receipt))-Buffer.byteLength(JSON.stringify(receipt.examinedPaths));
  assert(text<=REVIEW_TEXT_LIMIT&&text>REVIEW_TEXT_LIMIT-2048,String(text));assert.match(receipt.summary,/truncated/);
});
test('#19 review text over the limit is truncated by the documented rule and stays a valid review',()=>{
  const pkg={packageDigest:'a'.repeat(64)},paths=['a.mjs','b.mjs'];
  const long=n=>'z'.repeat(n);
  const small={verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:paths,findings:[],summary:'ok'};
  assert.equal(boundReviewText(small),small);
  const approved={...small,findings:Array.from({length:40},(_,n)=>({id:`P${n}`,severity:'P3',path:'a.mjs',
    message:long(3000),evidence:long(3000)})),summary:long(30000)};
  const bounded=boundReviewText(approved),bytes=v=>Buffer.byteLength(JSON.stringify(v))-Buffer.byteLength(JSON.stringify(v.examinedPaths));
  assert(bytes(bounded)<=REVIEW_TEXT_LIMIT);assert.equal(bounded.findings.length,40);
  assert(bounded.findings.every(f=>f.message.endsWith('truncated to the review text limit]')));
  assert.deepEqual(bounded.findings.map(f=>f.id),approved.findings.map(f=>f.id));
  reviewResultForPaths(bounded,pkg,paths);
  // The non-blocking finding comes first, so omitting "from the end" alone would keep it.
  const requested={...small,verdict:'changes_requested',findings:[{id:'P3-first',severity:'P3',path:'a.mjs',message:'x',evidence:'y'},
    ...Array.from({length:60},(_,n)=>({id:`B${n}-${'i'.repeat(100)}`,severity:'P1',path:'b.mjs',message:long(500),evidence:long(500)}))],summary:'s'};
  const omitted=boundReviewText(requested);
  assert(bytes(omitted)<=REVIEW_TEXT_LIMIT);assert(omitted.findings.length<61&&omitted.findings.some(f=>f.severity==='P1'));
  assert(!omitted.findings.some(f=>f.id==='P3-first'),'non-blocking findings are omitted first');
  assert.match(omitted.summary,new RegExp(`${61-omitted.findings.length} findings omitted`));
  reviewResultForPaths(omitted,pkg,paths);
  // The last blocking finding is never dropped: a result that cannot fit even then is refused.
  const huge='d/'+'p'.repeat(14000)+'.mjs';
  assert.equal(boundReviewText({...small,verdict:'changes_requested',examinedPaths:[huge],
    findings:[{id:'B1',severity:'P1',path:huge,message:'m',evidence:'e'}],summary:'s'}),null);
});
// Codex review of 090d683: the handoff lists every changed path, so with many of
// them it is far larger than any fixed allowance. Around the budget edge the
// driver must never admit a delivery the runner then blocks for size.
// Find the runner's exact edge with a live delivery of this layout, then drive
// deliveries straddling it: each is refused before any write or reaches review.
function sweepEdge(t,{scope,files={},writeLayout,answerLayout,value=developValue}){
  const probe=fixture(t,{scope,files});
  const blocked=liveSession(probe,{mode:'create',act:writeLayout(700*1024),value});
  const [,bytes,budget]=/checkpoint would be (\d+) bytes, above (\d+)/.exec(result(blocked).reason).map(Number);
  const edge=700*1024-Math.ceil((bytes-budget)*3/4);
  let admitted=0,refused=0;
  for(let step=-4;step<=4;step++){
    const f=fixture(t,{scope,files});answerLayout(f,edge+step*4096);
    f.write('develop.json',{status:'succeeded',value,edits:f.edits});
    const run=f.drive(f.plan(),'advance');
    if(run.status===2){refused++;assert.match(run.stderr,/含 handoff/);noRun(f);continue;}
    admitted++;assert.equal(run.status,0,run.stderr);
    assert.equal(result(run).state,'awaiting_review',`${edge+step*4096}: ${run.stdout}`);
  }
  assert(admitted>0&&refused>0,`admitted ${admitted}, refused ${refused}`);
}
// Codex review of 090d683: the handoff lists every changed path, so with many of
// them it is far larger than any fixed allowance. Around the budget edge the
// driver must never admit a delivery the runner then blocks for size.
test('#19 with many changed paths the driver never admits a delivery the runner blocks for size',t=>{
  const names=Array.from({length:200},(_,n)=>`src/generated/module-with-a-rather-long-descriptive-name-${String(n).padStart(3,'0')}.mjs`);
  sweepEdge(t,{scope:['big.mjs',...names],
    writeLayout:big=>`fs.mkdirSync(cwd+'/src/generated',{recursive:true});`
      +`for(const name of ${JSON.stringify(names)})fs.writeFileSync(cwd+'/'+name,'export const v = '+name.length+';\\n');`
      +`fs.writeFileSync(cwd+'/big.mjs','//'+'x'.repeat(${big})+'\\n');`,
    answerLayout:(f,big)=>{
      for(const name of names)f.content(name.replaceAll('/','_'),`export const v = ${name.length};\n`);
      f.content('big-content.mjs','//'+'x'.repeat(big)+'\n');
      f.edits=Object.fromEntries([['big.mjs','big-content.mjs'],...names.map(name=>[name,name.replaceAll('/','_')])]);
    }});
});
// A lesson delivery also changes AGENTS.md through the Learning writeback; the
// driver projects that write with the writer's own merge.
test('#19 a lesson delivery near the edge is sized with its AGENTS.md writeback',t=>{
  const lesson={...developValue,retrospective:{status:'lesson_candidate',reason:null,candidates:[{classification:'structured',
    trigger:'Large fixture files need a size check',action:'Measure the delivery before writing it',evidence:['target.mjs']}]}};
  const agents='# Project rules\n\n'+'- keep this rule\n'.repeat(3000);
  sweepEdge(t,{scope:['target.mjs'],files:{'AGENTS.md':agents},value:lesson,
    writeLayout:big=>`fs.writeFileSync(cwd+'/target.mjs','//'+'x'.repeat(${big})+'\\n');`,
    answerLayout:(f,big)=>{f.content('big-content.mjs','//'+'x'.repeat(big)+'\n');f.edits={'target.mjs':'big-content.mjs'};}});
});
// Codex review of 36d860c: journaled reasons are limited to 8192 characters on
// replay. A reason listing many long paths must stay within it and replay.
const longPaths=Array.from({length:20},(_,n)=>`${'a'.repeat(200)}/${'b'.repeat(200)}/requirement-${String(n).padStart(2,'0')}.md`);
function assertReplayableReason(f,code){
  const status=f.drive(f.plan({mode:'resume',answers:undefined,checks:undefined}),'status');
  assert.equal(status.status,0,status.stderr);assert.equal(result(status).code,code);
  const reason=result(status).reason;assert(reason.length<=8192,String(reason.length));assert(!/[\r\n\0]/.test(reason));
  return reason;
}
test('#19 a requirement-missing reason over 20 long paths stays within the replay limit',t=>{
  const files=Object.fromEntries(longPaths.map(file=>[file,'# requirement\n']));
  const f=fixture(t,{scope:['target.mjs',...longPaths],files:{...files,'target.mjs':'export const value = 1;\n'}});
  const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));definition.requirements=['requirements.md',...longPaths];
  fs.writeFileSync(f.config,JSON.stringify(definition));
  const run=liveSession(f,{mode:'create',act:`fs.writeFileSync(cwd+'/target.mjs','export const value = 2;\\n');`
    +`for(const file of ${JSON.stringify(longPaths)})fs.unlinkSync(cwd+'/'+file);`});
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).code,'develop_requirement_missing',run.stdout);
  const reason=assertReplayableReason(f,'develop_requirement_missing');
  for(const n of ['00','19'])assert.match(reason,new RegExp(`requirement-${n}\\.md`));
});
test('#19 a package-too-large reason with long changed paths stays within the replay limit',t=>{
  const f=fixture(t,{scope:['target.mjs',...longPaths]});
  const run=liveSession(f,{mode:'create',act:`for(const file of ${JSON.stringify(longPaths)}){fs.mkdirSync(cwd+'/'+file.slice(0,file.lastIndexOf('/')),{recursive:true});`
    +`fs.writeFileSync(cwd+'/'+file,'//'+'y'.repeat(40*1024)+'\\n');}fs.writeFileSync(cwd+'/target.mjs','//'+'x'.repeat(700*1024)+'\\n');`});
  assert.equal(run.status,0,run.stderr);assert.equal(result(run).code,'develop_package_too_large',run.stdout);
  assertReplayableReason(f,'develop_package_too_large');
});
test('#19 bounded reasons list what fits and count the rest',async()=>{
  const {boundedReason}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  const items=Array.from({length:50},(_,n)=>`${'p'.repeat(1000)}-${n}`);
  const reason=boundedReason('head: ',items,'; tail');
  assert(reason.length<=8192);assert.match(reason,/^head: /);assert.match(reason,/等 50 个; tail$/);
  assert.equal(boundedReason('x: ',['a','b'],'.'),'x: a, b.');
  assert(!/[\r\n\0]/.test(boundedReason('h',['a\nb','c\0d'],'')));
  assert.match(boundedReason('',[`${'q'.repeat(500)}/name.md`],''),/…q+\/name\.md$/);
});
// Codex review of ee86753 asked for a retryable block when the task handoff
// exceeds its 256 KiB limit. Its inputs are already capped: changed files come
// from the scope in run.json (at most 64 KiB), check results from validChecks (at
// most 64 KiB of JSON), and Learning records from their own limits. This builds
// the largest handoff those caps allow with the real builders and keeps it under
// the limit, so the case cannot happen; raising any of those caps must revisit it.
test('#19 the largest handoff the input caps allow stays under the 256 KiB handoff limit',async t=>{
  const {hostHandoffDocument}=await import('../runtime/js/cm-ai/host-handoff.mjs');
  const {taskLearningHandoffBytes}=await import('../runtime/js/cm-ai/cm-ai-learning-handoff-writer.mjs');
  const {validChecks}=await import('../runtime/js/cm-ai/review-package.mjs');
  const {inspectCmAiTaskLearningInput,createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective}=
    await import('../runtime/js/cm-ai/cm-ai-context-refresh.mjs');
  const {validateRunDefinition,RUN_DEFINITION_LIMIT}=await import('./cm-ai-run.mjs');
  const f=fixture(t);
  // Largest scope a 64 KiB run.json can hold, 255 files plus AGENTS.md added by the writeback.
  const definition=JSON.parse(fs.readFileSync(f.config,'utf8'));
  const room=RUN_DEFINITION_LIMIT-Buffer.byteLength(JSON.stringify({...definition,scope:[]}));
  const length=Math.floor(room/255)-3;
  definition.scope=Array.from({length:255},(_,n)=>`${'q'.repeat(length-4)}${String(n).padStart(4,'0')}`);
  assert(Buffer.byteLength(JSON.stringify(definition))<=RUN_DEFINITION_LIMIT);validateRunDefinition(definition);
  // Largest check JSON: backslashes double in the check JSON and again in the handoff.
  let low=1,high=70000;
  const checkWith=size=>[{id:'c',command:['\\'.repeat(size)],outcome:'passed',exitCode:0,evidence:'e'}];
  while(low<high){const middle=Math.ceil((low+high)/2);try{validChecks(checkWith(middle));low=middle;}catch{high=middle-1;}}
  const checks=checkWith(low);
  const identity={...f.identity,attempt:2};
  const learningInput=inspectCmAiTaskLearningInput({specsDir:f.specsDir,codeProject:f.codeProject,feature:'1.work',
    identity,applicableAgentFiles:[]},{admission:null,parallelSelection:null});
  const binding={feature:'1.work',identity,learningDigest:learningInput.learningDigest};
  const application=createCmAiTaskLearningApplication({...binding,status:'applied',note:'\\'.repeat(512)});
  const retrospective=createCmAiTaskLearningRetrospective({...binding,status:'lesson_candidate',reason:null,
    candidates:Array.from({length:3},(_,n)=>({classification:'structured',trigger:`${n}${'\\'.repeat(239)}`,
      action:`${n}${'\\'.repeat(239)}`,evidence:Array.from({length:8},(_,e)=>`${'e'.repeat(500)}/${n}-${e}.md`)}))});
  const {payload}=hostHandoffDocument({baseline:{identity},checks,
    reviewPackage:{changes:definition.scope.map(file=>({path:file})),packageDigest:'0'.repeat(64)},implementationSha256:'0'.repeat(64)});
  const handoff=taskLearningHandoffBytes({handoff:payload,feature:'1.work',identity,learningInput,application,retrospective,includeAgents:true});
  assert(handoff.length<256*1024,`largest handoff ${handoff.length}`);
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
    '--allow-development','--review-config',path.join(f.root,'review.json'),'--input-limit','1048576'],{env:f.env,finish:{version:1,identity:f.identity},
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
    '--allow-development','--review-config',path.join(f.root,'review.json')],{env:f.env,finish:{version:1,identity:f.identity},
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
    '--allow-development','--review-config',path.join(f.root,'review.json'),...(limit?['--input-limit',limit]:[])],{env:f.env,
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
