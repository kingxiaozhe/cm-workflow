import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {openExecutionStore} from '../runtime/js/cm-ai/execution-store.mjs';
import * as execution from '../runtime/js/cm-fix/execution.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {assertJestConfigurationDiscovery} from '../runtime/js/cm-fix/jest-command-correction.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';

const DRIVER=fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url));
const INSPECT=fileURLToPath(new URL('./cm-fix-command-correction.mjs',import.meta.url));

async function fixture(t,{green=false,unrelated=false,closeout=false,summaryFailure=false,configRepairScope=false,commandSuffix=[]}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-jest-correction-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(path.join(cwd,'app/node_modules/jest/bin'),{recursive:true});fs.mkdirSync(specsRoot);
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(cwd,'app/package.json'),JSON.stringify({jest:{}}));
 if(closeout)fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,policies:{delivery:'diff'}}));
 fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(cwd,'test.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('TARGET BUG');process.exit(1)}");
 const cli='app/node_modules/jest/bin/jest.js',callsPath=path.join(root,'check-calls');
 fs.writeFileSync(path.join(cwd,cli),`const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(callsPath)},'1');if(!process.argv.includes('--config')){console.error('Error: Could not find a config file based on provided values:\\ncwd: "'+process.cwd()+'"');process.exit(1)}if(process.argv.includes('--baseline'))process.exit(0);import(process.cwd()+'/test.mjs');`);
 if(summaryFailure){const file=path.join(cwd,cli);fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('process.exit(1)',"console.error('Test Suites: 1 failed, 1 total');process.exit(1)"));}
 const command=[process.execPath,cli,'--rootDir','app',...commandSuffix];
 const options={specsRoot,identity:{repositoryId:'fixture',runId:'jest-command',taskId:'T-FIX-command',attempt:1},create:true,configuration:{hostContextId:'fixture-host',defect:'Wrong constant',
  reproduction:{cwd,command:[process.execPath,'test.mjs'],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:3000},
  redTest:{cwd,command:green?[process.execPath,'-e','process.exit(0)']:unrelated?[process.execPath,'-e',"console.error('OTHER');process.exit(1)"]:command,testFiles:['test.mjs'],expectedFailure:{exitCode:1,outputIncludes:'TARGET BUG'},timeoutMs:3000},
  baseline:{cwd,testFiles:['test.mjs'],commands:[{id:'existing',command:[...command,'--baseline']}],timeoutMs:3000},
  repair:{scope:configRepairScope?['value.mjs','app/package.json']:['value.mjs'],requirements:['value.mjs']},walkthrough:{flows:[{id:'flow',modules:['one'],kind:'commands',steps:['Run constant'],expected:['No error'],command}],timeoutMs:3000}}};
 if(closeout){options.configuration.reviewRuntime='claude';options.configuration.causeReview={reviewerId:'fixture-cause',adapterId:'claude-review-adapter',provider:'claude',requestedModel:'synthetic',contextId:'fixture-cause-context',excludedThreadIds:[]};}
 const learning={files:[],contextDigest:digest([]),application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Fixture'}};
 const bridge={call:async(kind)=>{
  if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong constant',affectedPaths:['value.mjs'],plan:'Set value to 2',crossLayer:false,affectedModules:['one'],investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
  if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
  assert.equal(kind,'fix_repair');fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};
 }};
 const capabilities={bridge,assertReviewReady(){},...(closeout?{prepare:async()=>learning}:{})};
 let owner=openFixExecution(options,capabilities);t.after(()=>owner.close());
 if(closeout)startFixRun({specsRoot,identity:options.identity,configuration:options.configuration});
 await owner.advance({authorized:true});assert.equal((await owner.runRedTest({authorized:true})).stage,'red_test_not_confirmed');
 const statePath=path.join(specsRoot,'.reviews/.execution/jest-command/state.json'),state=()=>JSON.parse(fs.readFileSync(statePath));
 const reopen=(extra={})=>{owner.close();owner=openFixExecution({...options,create:false},{...capabilities,...extra});return owner;};
 return {root,cwd,specsRoot,options,statePath,state,reopen,checkCalls:()=>fs.readFileSync(callsPath,'utf8'),get owner(){return owner;},declaration:{kind:'jest-config-path',path:'app/package.json'}};
}
test('original not-red run gains one explicit correction; all later command phases and replay use corrected argv',async t=>{
 const f=await fixture(t),before=f.state(),output=f.owner.status().redTest.output,old=fs.readFileSync(path.join(f.specsRoot,output.path));
 const expected=f.owner.inspectCommandCorrection({declaration:f.declaration});
 assert.deepEqual(f.state(),before);assert.equal(expected.commands.length,3);
 assert.throws(()=>f.owner.prepareCommandCorrection({expected,declaration:f.declaration,previousInvocationStopped:true,reason:'explicit config'}),{code:'fix_command_correction_authorization_required'});
 const input={authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'Explicitly add config discovery only'};
 assert.equal(f.owner.prepareCommandCorrection(input).stage,'red_test_required');
 assert.deepEqual(f.state().records.slice(0,before.records.length),before.records);assert.deepEqual(f.state().fingerprints,before.fingerprints);
 assert.equal((await f.reopen().runRedTest({authorized:true})).stage,'baseline_required');
 assert.match(f.owner.status().redTest.output.path,/-retry-1\.md$/);assert.deepEqual(fs.readFileSync(path.join(f.specsRoot,output.path)),old);
 assert.equal((await f.owner.captureBaseline({authorized:true})).stage,'repair_required');
 assert.equal(f.owner.status().baseline.observations[0].outcome,'passed');
 assert.equal((await f.owner.repair({authorized:true})).stage,'regression_required');
 assert.equal((await f.owner.runRegression({authorized:true})).stage,'handoff_required');
 assert.equal(f.reopen().status().stage,'handoff_required');
 assert.equal(f.owner.status().regression.red.outcome,'passed');assert.equal(f.owner.status().regression.baseline.observations[0].outcome,'passed');
 assert.throws(()=>f.owner.prepareCommandCorrection(input),{code:'fix_command_correction_used'});
});
test('qualification rejects real green/unrelated failure, stale history, changed tests/config and arbitrary corrections',async t=>{
 for(const mode of ['green','unrelated']){
  const f=await fixture(t,{[mode]:true});assert.throws(()=>f.owner.inspectCommandCorrection({declaration:f.declaration}),{code:'fix_command_correction_unavailable'});f.owner.close();
 }
 const f=await fixture(t),expected=f.owner.inspectCommandCorrection({declaration:f.declaration});
 for(const override of [{previousInvocationStopped:false},{reason:''},{expected:{...expected,historyDigest:digest('stale')}}]){
  assert.throws(()=>f.owner.prepareCommandCorrection({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'fixed',...override}));
 }
 const old=fs.readFileSync(path.join(f.cwd,'test.mjs'));fs.appendFileSync(path.join(f.cwd,'test.mjs'),'\n// drift');
 assert.throws(()=>f.owner.prepareCommandCorrection({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'fixed'}));
 fs.writeFileSync(path.join(f.cwd,'test.mjs'),old);
 assert.throws(()=>f.owner.inspectCommandCorrection({declaration:{...f.declaration,command:['anything']}}));
 fs.appendFileSync(path.join(f.cwd,'app/package.json'),' ');
 assert.throws(()=>f.owner.prepareCommandCorrection({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'fixed'}),{code:'fix_command_correction_stale'});
});
test('read-only inspection API exists and new-run launch preflight rejects every missing Jest configuration',()=>{
 assert.equal(typeof execution.inspectFixCommandCorrection,'function');
 const config={reproduction:{cwd:'/no-such-fixture'},redTest:{cwd:'/no-such-fixture',command:['node','app/node_modules/jest/bin/jest.js','--rootDir','app']}};
 assert.throws(()=>assertJestConfigurationDiscovery(config),{code:'fix_jest_config_path_required'});
 assert.doesNotThrow(()=>assertJestConfigurationDiscovery({...config,redTest:{...config.redTest,command:[...config.redTest.command,'--config','app/package.json']}}));
});

test('real inspector and driver prepare one correction without running checks or altering old records',async t=>{
 const f=await fixture(t),before=f.state(),checkCalls=f.checkCalls();f.owner.close();
 const config=path.join(f.root,'config.json'),plan=path.join(f.root,'plan.json');
 const {hostContextId,...configuration}=f.options.configuration;
 fs.writeFileSync(config,JSON.stringify({...configuration,specsRoot:f.specsRoot,identity:f.options.identity}));
 const cli=args=>spawnSync(process.execPath,args,{encoding:'utf8',timeout:30000,env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});
 const preview=cli([INSPECT,'--config',config,'--jest-config',f.declaration.path]);
 assert.equal(preview.status,0,preview.stdout+preview.stderr);
 const expected=JSON.parse(preview.stdout).expected;assert.equal(expected.commands.length,3);assert.deepEqual(f.state(),before);
 const base={config,cwd:f.cwd,mode:'resume',hostContext:hostContextId,runtime:'codex',expected,commandCorrection:f.declaration,previousInvocationStopped:true,reason:'Explicit Jest discovery correction'};
 const drive=(permissions,extra={})=>{fs.writeFileSync(plan,JSON.stringify({...base,permissions,...extra}));return cli([DRIVER,'--plan',plan,'prepare_command_correction']);};
 for(const [permissions,extra]of [[[],{}],[['--allow-command-correction'],{previousInvocationStopped:false}],[['--allow-command-correction'],{mode:'create'}]]){
  const rejected=drive(permissions,extra);assert.notEqual(rejected.status,0);assert.deepEqual(f.state(),before);
 }
 const prepared=drive(['--allow-command-correction']);assert.equal(prepared.status,0,prepared.stdout+prepared.stderr);
 assert.match(prepared.stdout,/red_test_required/);
 const after=f.state();assert.deepEqual(after.records.slice(0,before.records.length),before.records);assert.deepEqual(after.fingerprints,before.fingerprints);
 assert.equal(after.records.length,before.records.length+1);
 const again=drive(['--allow-command-correction']);assert.notEqual(again.status,0);assert.deepEqual(f.state(),after);
 const used=cli([INSPECT,'--config',config,'--jest-config',f.declaration.path]);assert.notEqual(used.status,0);assert.match(used.stderr,/fix_command_correction_used/);
 assert.equal(f.checkCalls(),checkCalls);
 assert.equal((await f.reopen().runRedTest({authorized:true})).stage,'baseline_required');
});

test('corrected original run completes fixture review, N5, post-review regression, walkthrough and finish',async t=>{
 const f=await fixture(t,{closeout:true}),before=f.state(),expected=f.owner.inspectCommandCorrection({declaration:f.declaration});
 f.owner.prepareCommandCorrection({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'Explicit Jest discovery correction'});
 assert.equal((await f.reopen().runRedTest({authorized:true})).stage,'baseline_required');
 assert.equal((await f.owner.captureBaseline({authorized:true})).stage,'repair_required');
 assert.equal((await f.owner.repair({authorized:true})).stage,'regression_required');
 assert.equal((await f.owner.runRegression({authorized:true})).stage,'handoff_required');
 assert.equal((await f.owner.retrospect()).stage,'handoff_ready');
 assert.equal(f.owner.createHandoff().stage,'final_review_required');
 const pkg=f.owner.finalReviewPackage();assert(pkg.checks.every(c=>c.outcome==='passed'));
 const settings=fixFinalReviewConfiguration(f.options.configuration),authority=createHostReviewAuthority({hostContextId:settings.hostContextId,reviewerId:settings.reviewer.reviewerId,adapterId:settings.reviewer.adapterId,decide:async()=>({status:'approved'})});
 await authority.hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
 let calls=0;
 f.reopen({finalReview:{authorize:authority.authorize,run:async(request,{onEvent})=>{
  assert.equal(request.provider,'claude');assert.equal(request.requestedModel,'synthetic');
  calls++;for(const event of [{event:'thread.started',provider_thread:'synthetic-command-correction-reviewer'},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])assert.equal(onEvent(event),true);
  return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic fixture only; no Claude call'}};
 }}});
 assert.equal((await f.owner.reviewFinal()).stage,'final_review_evidence_required');assert.equal(calls,1);
 assert.equal(f.owner.publishReview().stage,'completion_gate_required');
 assert.equal(f.owner.checkCompletionGate().stage,'post_review_regression_required');
 assert.equal((await f.owner.runRegression({authorized:true,postReview:true})).stage,'closeout_required');
 assert.equal((await f.reopen().runWalkthrough({authorized:true})).stage,'closeout_required');
 assert.equal(f.owner.status().walkthrough.status,'passed');
 assert.equal(f.owner.status().walkthrough.rows[0].observation.command.at(-1),'app/package.json');
 f.owner.publishDossier();
 const finished=f.owner.finish({authorized:true});assert.equal(finished.stage,'completed');assert.equal(finished.completionEligible,true);
 assert.equal(f.reopen().status().stage,'completed');assert.equal(f.owner.completionEvidence().identity.runId,f.options.identity.runId);
 assert.deepEqual(f.state().records.slice(0,before.records.length),before.records);assert.deepEqual(f.state().fingerprints,before.fingerprints);
 assert.equal(calls,1);
});

test('prepared correction refuses source drift before corrected red without losing history or executing another check',async t=>{
 const f=await fixture(t),expected=f.owner.inspectCommandCorrection({declaration:f.declaration});
 f.owner.prepareCommandCorrection({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'Explicit Jest discovery correction'});
 const prepared=f.state(),checkCalls=f.checkCalls(),source=path.join(f.cwd,'value.mjs'),original=fs.readFileSync(source);
 fs.appendFileSync(source,'\n// unrelated drift after qualification');
 assert.equal(f.owner.status().stage,'command_correction_drift');
 assert.equal((await f.owner.runRedTest({authorized:true})).stage,'command_correction_drift');
 assert.deepEqual(f.state(),prepared);
 f.reopen();assert.equal(f.owner.status().stage,'command_correction_drift');assert.deepEqual(f.state(),prepared);
 assert.equal(f.checkCalls(),checkCalls);
 fs.writeFileSync(source,original);
 assert.equal(f.owner.status().stage,'red_test_required');
 assert.equal((await f.owner.runRedTest({authorized:true})).stage,'baseline_required');
});

// Startup correction must not become a retry for tests that actually ran, or
// freeze a configuration file which the declared repair itself must change.
test('qualification rejects Jest test summaries and repair-owned configuration',async t=>{
 for(const option of ['summaryFailure','configRepairScope']){
  const f=await fixture(t,{[option]:true}),before=f.state();
  assert.throws(()=>f.owner.inspectCommandCorrection({declaration:f.declaration}),{code:option==='summaryFailure'?'fix_command_correction_unavailable':'fix_command_correction_config'});
  assert.deepEqual(f.state(),before);
 }
});

test('corrected red retry budget refuses an eighth abandon before poisoning replay',async t=>{
 const f=await fixture(t),expected=f.owner.inspectCommandCorrection({declaration:f.declaration});
 f.owner.prepareCommandCorrection({authorized:true,expected,declaration:f.declaration,previousInvocationStopped:true,reason:'Explicit Jest discovery correction'});
 for(let retry=1;retry<=8;retry++){
  // An occupied private result path makes this isolated command's publication
  // unknown, without fabricating or editing a journal record.
  const output=path.join(f.specsRoot,`.reviews/fix-command-a1-red-output-retry-${retry}.md`);
  fs.writeFileSync(output,'existing evidence must survive',{mode:0o600});
  assert.equal((await f.owner.runRedTest({authorized:true})).stage,'unknown');
  if(retry<8){assert.equal(f.owner.abandonStep({authorized:true,reason:'Stopped fixture command; preserve lost result'}).stage,'red_test_required');f.reopen();}
 }
 const before=f.state();
 assert.throws(()=>f.owner.abandonStep({authorized:true,reason:'Must not create retry nine'}),{code:'fix_abandon_limit'});
 assert.deepEqual(f.state(),before);assert.equal(f.reopen().status().stage,'unknown');
 assert.equal((await f.owner.runRedTest({authorized:true})).stage,'unknown');assert.deepEqual(f.state(),before);
 assert.equal(f.state().records.some(r=>r.id.includes('retry-9')),false);
 // Upgrade fixture: the old runtime could already have appended abandon #8.
 // Preserve that legal prefix and refuse the next intent before any append.
 f.owner.close();
 const history=f.state(),store=openExecutionStore({specsRoot:f.specsRoot,identity:history.identity,fingerprints:history.fingerprints,create:false});
 try{store.append({id:'fix-abandoned-8',kind:'result',expectedRevision:history.revision,payload:{pending:'red_test',reason:'Old-runtime legal abandon',abandonedAt:Date.now(),intentDigest:digest(history.records.at(-1))}});}finally{store.close();}
 const legacy=f.state();assert.equal(f.reopen().status().stage,'red_test_required');
 await assert.rejects(()=>f.owner.runRedTest({authorized:true}),{code:'fix_abandon_limit'});
 assert.deepEqual(f.state(),legacy);assert.equal(f.reopen().status().stage,'red_test_required');
});

test('new-run configuration discovery accepts Jest default package.json without jest field',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'jest-default-config-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'package.json'),'{}');
 assert.doesNotThrow(()=>assertJestConfigurationDiscovery({reproduction:{cwd:root},redTest:{cwd:root,command:['node','node_modules/jest/bin/jest.js','--rootDir','.']}}));
});

test('qualification refuses Jest option separators and existing short config alias',async t=>{
 for(const commandSuffix of [['--'],['-c','app/package.json']]){
  const f=await fixture(t,{commandSuffix}),before=f.state();
  assert.throws(()=>f.owner.inspectCommandCorrection({declaration:f.declaration}),{code:'fix_command_correction_config'});assert.deepEqual(f.state(),before);
 }
});
