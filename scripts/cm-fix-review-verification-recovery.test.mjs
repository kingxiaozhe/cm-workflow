import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

async function fixture(t,phase='cause',{validVerdict=null}={}){
 if(phase==='revision')validVerdict='changes_requested';
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-bounded-review-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
 fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
 const verification={files:['value.mjs','red.mjs','existing.mjs'],checks:[{id:'unit',command:[process.execPath,'existing.mjs']}],mutationPaths:['value.mjs'],timeoutMs:2000};
 fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'both'},roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'claude-cli'}}}));
 const reviewConfig={model:'synthetic',disabledSkills:[],preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd,model:'synthetic',verification})}};
 const reviewer=createFixReviewHost({codeProject:cwd,hostContextId:'author',runtime:'codex',reviewRuntime:'claude',verification,review:reviewConfig}).reviewer;
 const identity={repositoryId:'fixture',runId:'bounded-'+phase,taskId:'T-FIX-bounded',attempt:1};
 const configuration={hostContextId:'author',reviewRuntime:'claude',defect:'Wrong constant',causeReview:reviewer,reviewVerification:verification,
  reproduction:{cwd,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
  redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
  baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},repair:{scope:['value.mjs'],requirements:['value.mjs']}};
 const authority=createHostReviewAuthority({hostContextId:'author',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
 const finalConfig=fixFinalReviewConfiguration(configuration),finalAuthority=createHostReviewAuthority({hostContextId:'author',reviewerId:finalConfig.reviewer.reviewerId,adapterId:finalConfig.reviewer.adapterId,decide:async()=>({status:'approved'})});
 let calls=0,owner,threadOverride=null,proofAuxiliaryChanged=false;const review=auth=>({authorize:auth.authorize,async run(request,{onEvent,onVerification}){calls++;for(const e of [{event:'thread.started',provider_thread:threadOverride??'thread-'+calls},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(e);if(validVerdict){const files=verification.files.map(p=>({path:p,sha256:createHash('sha256').update(fs.readFileSync(path.join(cwd,p))).digest('hex'),mode:fs.statSync(path.join(cwd,p)).mode&511}));if(proofAuxiliaryChanged)files.find(f=>f.path==='existing.mjs').sha256='d'.repeat(64);onVerification({version:1,requestDigest:request.requestDigest,packageDigest:request.payload.reviewPackage.packageDigest,profileDigest:digest(verification),providerThreadId:'thread-'+calls,files,snapshotDigest:digest(files),checks:[{id:'unit',commandDigest:digest(verification.checks[0].command),exitCode:0,outputSha256:'b'.repeat(64),startedAt:1,endedAt:2}],mutations:[{path:'value.mjs',beforeSha256:files[0].sha256,afterSha256:'c'.repeat(64),checkId:'unit',baselineExitCode:0,mutatedExitCode:1,restoredExitCode:0,restoredSha256:files[0].sha256,startedAt:3,endedAt:4}]});return {status:'succeeded',value:{verdict:validVerdict,packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:['value.mjs'],findings:validVerdict==='changes_requested'?[{id:'F1',severity:'P2',path:'value.mjs',message:'Synthetic valid rejection',evidence:'Fixture'}]:[],summary:'Synthetic conclusion'}};}return {status:'failed',code:'review_verification_evidence'};}});
 const runtime={causeReview:review(authority),finalReview:review(finalAuthority),assertReviewReady(){},prepare:async()=>({contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}}),bridge:{async call(kind){
  if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong value',plan:'Correct value',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:phase==='cause',...(phase!=='cause'?{investigation:{discardedAlternatives:[],boundaryAnalysis:null}}:{})};
  if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;'+(owner.status().revision?'\n// revision':''));return {outcome:'repaired'};}
  if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};throw Error(kind);
 }}};
 const options={specsRoot,identity,configuration,create:true};owner=openFixExecution(options,runtime);
 t.after(()=>{owner?.close();fs.rmSync(root,{recursive:true,force:true});});
 await owner.advance({authorized:true});
 if(phase!=='cause'){await owner.runRedTest({authorized:true});await owner.captureBaseline({authorized:true});await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();owner.createHandoff();}
 const reviewNow=async token=>{const pkg=phase==='cause'?owner.causeReviewPackage():owner.finalReviewPackage();await (phase==='cause'?authority:finalAuthority).hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);return phase==='cause'?owner.reviewCause({verificationRecoveryAuthorization:token}):owner.reviewFinal({verificationRecoveryAuthorization:token});};
 await reviewNow();
 if(phase==='revision'){owner.publishReview();await owner.prepareRevision({authorized:true});await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();owner.createHandoff();validVerdict=null;await reviewNow();}
 if((phase==='cause'||phase==='revision')&&!validVerdict)for(let i=0;i<2;i++){owner.abandonReview({authorized:true,reason:'Failed verification worker closed'});await reviewNow();}
 const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
 return {root,cwd,configuration,identity,specsRoot,statePath,reviewNow,reviewConfig,setVerdict(verdict){validVerdict=verdict;},setThread(thread){threadOverride=thread;},changeProofAuxiliary(){proofAuxiliaryChanged=true;},close(){owner.close();owner=null;},get owner(){return owner;},get calls(){return calls;},reopen(){owner?.close();owner=openFixExecution({...options,create:false},runtime);}};
}
for(const phase of ['cause','final','revision'])test(`${phase} verification recovery is single prepared and explicitly dispatched without rewriting history`,{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,phase),before=fs.readFileSync(f.statePath),old=JSON.parse(before),calls=f.calls;
 const eligible=await f.owner.inspectVerificationRecovery();assert.equal(eligible.phase,phase==='cause'?'cause_review':phase==='revision'?'revision_final_review':'final_review');assert.equal(f.calls,calls);assert.deepEqual(fs.readFileSync(f.statePath),before);
 const input={authorized:true,expected:eligible,previousInvocationStopped:true,reason:'Runtime verification transport repaired; retain all prior evidence'};
 const prepared=await f.owner.prepareVerificationRecovery(input);assert.equal(f.calls,calls);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records.slice(0,old.records.length),old.records);
 assert.deepEqual(await f.owner.prepareVerificationRecovery(input),prepared);
 f.reopen();await assert.rejects(f.reviewNow(),{code:'fix_verification_recovery_authorization_required'});assert.equal(f.calls,calls);
 await f.reviewNow(prepared.authorizationDigest);assert.equal(f.calls,calls+1);assert.equal(f.owner.status().stage,'unknown');
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_verification_recovery_used'});
 assert.throws(()=>f.owner.abandonReview({authorized:true,reason:'No extra budget'}),{code:'fix_verification_recovery_used'});
 f.reopen();assert.equal(f.owner.status().stage,'unknown');assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).fingerprints,old.fingerprints);
});
for(const verdict of ['approved','changes_requested'])test(`valid ${verdict} is never verification recovery eligibility`,{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,'cause',{validVerdict:verdict});
 assert.notEqual(f.owner.status().stage,'unknown');
 const before=fs.readFileSync(f.statePath),calls=f.calls;
 await assert.rejects(f.owner.inspectVerificationRecovery(),{code:'fix_verification_recovery_unavailable'});
 assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(f.calls,calls);
});
for(const drift of ['source','auxiliary','baseline'])test(`verification recovery refuses ${drift} drift before preparing history`,{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery(),before=fs.readFileSync(f.statePath),calls=f.calls;
 if(drift==='source')fs.appendFileSync(path.join(f.cwd,'value.mjs'),'\n// changed');
 else if(drift==='auxiliary')fs.appendFileSync(path.join(f.cwd,'existing.mjs'),'\n// changed');
 else fs.writeFileSync(path.join(f.cwd,'existing.mjs'),'process.exit(1)');
 await assert.rejects(f.owner.prepareVerificationRecovery({authorized:true,expected,previousInvocationStopped:true,reason:'Bounded recovery'}),{code:drift==='source'?'review_verification_package_binding':drift==='baseline'?'review_verification_check_failed':'fix_verification_recovery_stale'});
 assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(f.calls,calls);
});
test('preparation and continuation reject missing confirmations, stale targets and old threads',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery(),before=fs.readFileSync(f.statePath);
 const args={authorized:true,expected,previousInvocationStopped:true,reason:'Runtime repaired'};
 await assert.rejects(f.owner.prepareVerificationRecovery({...args,authorized:false}),{code:'fix_verification_recovery_authorization_required'});
 await assert.rejects(f.owner.prepareVerificationRecovery({...args,previousInvocationStopped:false}),{code:'fix_verification_recovery_confirmation'});
 await assert.rejects(f.owner.prepareVerificationRecovery({...args,expected:{...expected,invocationId:'another'}}),{code:'fix_verification_recovery_stale'});
 assert.deepEqual(fs.readFileSync(f.statePath),before);
 const prepared=await f.owner.prepareVerificationRecovery(args);
 f.setThread('thread-1');await f.reviewNow(prepared.authorizationDigest);
 const state=JSON.parse(fs.readFileSync(f.statePath));assert.equal(state.records.some(r=>r.id==='fix-verification-recovery-started'),false);
 assert.equal(f.owner.status().stage,'unknown');f.reopen();assert.equal(f.owner.status().stage,'unknown');
});
test('prepared auxiliary snapshot stays binding at dispatch and across resume',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery();
 const prepared=await f.owner.prepareVerificationRecovery({authorized:true,expected,previousInvocationStopped:true,reason:'Runtime repaired'}),before=fs.readFileSync(f.statePath),calls=f.calls;
 fs.appendFileSync(path.join(f.cwd,'existing.mjs'),'\n// changed after permission');f.reopen();
 await assert.rejects(f.reviewNow(prepared.authorizationDigest),{code:'fix_verification_recovery_drift'});
 assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(f.calls,calls);
});
const DRIVER=fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url)),INSPECT=fileURLToPath(new URL('./cm-fix-verification-recovery.mjs',import.meta.url));
function cliFiles(f){
 const {hostContextId,causeReview,reviewRuntime,...run}=f.configuration,config=path.join(f.root,'config.json'),review=path.join(f.root,'review.json');
 fs.writeFileSync(config,JSON.stringify({...run,identity:f.identity,specsRoot:f.specsRoot}));fs.writeFileSync(review,JSON.stringify(f.reviewConfig));
 const answers=path.join(f.root,'answers');fs.mkdirSync(answers);return {config,review,answers};
}
function spawnFixture(command,f){return spawnSync(process.execPath,command,{encoding:'utf8',timeout:20000,env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});}
test('read-only inspection CLI reports frozen baseline failure without a writer or provider',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),{config}=cliFiles(f),before=fs.readFileSync(f.statePath),dir=path.dirname(f.statePath);
 const beforeFiles=fs.readdirSync(dir).map(p=>[p,fs.statSync(path.join(dir,p)).mtimeMs]);
 fs.writeFileSync(path.join(f.cwd,'existing.mjs'),'process.exit(1)');
 const run=spawnFixture([INSPECT,'--config',config],f);assert.equal(run.status,1,run.stderr);
 const diagnostic=JSON.parse(run.stderr.trim().split('\n').at(-1));assert.equal(diagnostic.code,'review_verification_check_failed');assert.equal(diagnostic.verificationDiagnostic.checkId,'unit');assert.equal(diagnostic.verificationDiagnostic.exitCode,1);
 assert.deepEqual(fs.readFileSync(f.statePath),before);assert.deepEqual(fs.readdirSync(dir).map(p=>[p,fs.statSync(path.join(dir,p)).mtimeMs]),beforeFiles);
});
test('real driver prepares once and forwards bounded startup authorization without dispatch permission',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),files=cliFiles(f),before=fs.readFileSync(f.statePath);f.close();
 const inspected=spawnFixture([INSPECT,'--config',files.config],f);assert.equal(inspected.status,0,inspected.stderr);assert.deepEqual(fs.readFileSync(f.statePath),before);
 const expected=JSON.parse(inspected.stdout).expected,plan=path.join(f.root,'plan.json');
 const base={config:files.config,cwd:f.cwd,mode:'resume',hostContext:'author',runtime:'codex',reviewRuntime:'claude',reviewConfig:files.review,expected,previousInvocationStopped:true,reason:'Explicit bounded runtime repair',permissions:['--allow-verification-recovery']};
 fs.writeFileSync(plan,JSON.stringify(base));let run=spawnFixture([DRIVER,'--plan',plan,'prepare_verification_recovery'],f);assert.equal(run.status,0,run.stderr+run.stdout);
 const prepared=JSON.parse(run.stdout).result;assert.match(prepared.authorizationDigest,/^[a-f0-9]{64}$/);
 const preparedBytes=fs.readFileSync(f.statePath);run=spawnFixture([DRIVER,'--plan',plan,'prepare_verification_recovery'],f);assert.equal(run.status,0,run.stderr);assert.deepEqual(fs.readFileSync(f.statePath),preparedBytes);
 fs.writeFileSync(plan,JSON.stringify({...base,answers:files.answers,permissions:[]}));run=spawnFixture([DRIVER,'--plan',plan,'cause_review'],f);assert.match(run.stdout+run.stderr,/fix_verification_recovery_authorization_required/);
 fs.writeFileSync(plan,JSON.stringify({...base,answers:files.answers,permissions:[],verificationRecoveryAuthorization:prepared.authorizationDigest}));run=spawnFixture([DRIVER,'--plan',plan,'cause_review'],f);assert.match(run.stdout+run.stderr,/permission_denied/);
 assert.deepEqual(fs.readFileSync(f.statePath),preparedBytes,'No dispatch grant or invocation without the original review permission');
});
for(const phase of ['cause','final'])test(`${phase} recovered valid review publishes original round without rewriting failed evidence`,{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,phase),expected=await f.owner.inspectVerificationRecovery();
 const prepared=await f.owner.prepareVerificationRecovery({authorized:true,expected,previousInvocationStopped:true,reason:'Verification transport fixed'}),old=JSON.parse(fs.readFileSync(f.statePath)).records;
 f.setVerdict('approved');await f.reviewNow(prepared.authorizationDigest);
 assert.equal(f.owner.status().stage,phase==='cause'?'red_test_required':'final_review_evidence_required');
 if(phase==='final')assert.equal(f.owner.publishReview().stage,'completion_gate_required');
 f.reopen();assert.equal(f.owner.status().stage,phase==='cause'?'red_test_required':'completion_gate_required');
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records;assert.deepEqual(rows.slice(0,old.length),old);
 assert.equal(rows.filter(r=>r.id==='fix-verification-recovery-registered').length,1);
 const latest=rows.find(r=>r.id==='fix-verification-recovery-registered');assert.equal(latest.payload.request.identity.attempt,1);
});

test('observation-cause correction packages are explicitly outside verification recovery',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t),target=await f.owner.inspectVerificationRecovery();
 const {verificationRecoveryTarget}=await import('../runtime/js/cm-fix/review-verification-recovery.mjs');
 const records=JSON.parse(fs.readFileSync(f.statePath)).records;
 const registration=structuredClone(records.findLast(r=>r.id.endsWith('-registered')&&r.payload.request?.role==='reviewer'));
 registration.payload.request.payload.reviewPackage.correction={reason:'observation_cause_review_omitted'};
 const prefix=registration.id.slice(0,-11);
 assert.throws(()=>verificationRecoveryTarget({records,configuration:f.configuration,stage:'unknown',phase:'cause_review',registration,
  started:records.find(r=>r.id===prefix+'-started'),result:records.find(r=>r.id===prefix+'-result'),
  baseline:{files:target.files,snapshotDigest:target.snapshotDigest,checks:f.configuration.reviewVerification.checks.map(c=>({id:c.id,commandDigest:digest(c.command),exitCode:0}))}}),{code:'fix_verification_recovery_unavailable'});
});

for(const phase of ['cause','final'])test(`${phase} recovery persists rejected auxiliary proof as a failed observation`,{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,phase),expected=await f.owner.inspectVerificationRecovery();
 const prepared=await f.owner.prepareVerificationRecovery({authorized:true,expected,previousInvocationStopped:true,reason:'Verification transport repaired'});
 const old=JSON.parse(fs.readFileSync(f.statePath)).records,source=fs.readFileSync(path.join(f.cwd,'existing.mjs'));
 f.setVerdict('approved');f.changeProofAuxiliary();await f.reviewNow(prepared.authorizationDigest);
 assert.equal(f.owner.status().stage,'unknown');
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records;
 assert.deepEqual(rows.slice(0,old.length),old);
 const failed=rows.find(r=>r.id==='fix-verification-recovery-result');
 assert.ok(failed,'Rejected recovery proof must leave a durable failed result');
 assert.equal(failed.payload.verification,undefined);
 assert.deepEqual(failed.payload.observation.result,{status:'failed',code:'fix_verification_recovery_binding'});
 assert.equal(failed.payload.verificationDiagnostic.code,'fix_verification_recovery_binding');
 assert.deepEqual(fs.readFileSync(path.join(f.cwd,'existing.mjs')),source);
 f.reopen();assert.equal(f.owner.status().stage,'unknown');
 assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records,rows);
});

test('real driver preserves F24 request and invocation permissions through bounded final recovery',{skip:process.platform!=='darwin'},async t=>{
 const f=await fixture(t,'final'),files=cliFiles(f),plan=path.join(f.root,'f24-plan.json');
 const base={config:files.config,cwd:f.cwd,mode:'resume',hostContext:'author',runtime:'codex',reviewRuntime:'claude',reviewConfig:files.review};
 const drive=(operation,value)=>{fs.writeFileSync(plan,JSON.stringify({...base,...value}));return spawnFixture([DRIVER,'--plan',plan,operation],f);};
 let f24Invocation;
 for(let cycle=0;cycle<2;cycle++){
  const rows=JSON.parse(fs.readFileSync(f.statePath)).records;
  const prior=rows.findLast(r=>r.id.endsWith('-registered')&&r.payload.request?.role==='reviewer').payload;
  f24Invocation=prior.request.invocationId;
  const request={permissions:['--allow-final-review-recovery'],invocationId:f24Invocation,packageDigest:prior.request.payload.reviewPackage.packageDigest,previousInvocationStopped:true,reason:'Original F24 retry after closed failed worker',...(cycle?{finalReviewRecoveryInvocation:f24Invocation}:{})};
  f.close();const old=fs.readFileSync(f.statePath);
  if(cycle){const denied=drive('recover_final_review',{...request,finalReviewRecoveryInvocation:'wrong-invocation'});assert.match(denied.stdout+denied.stderr,/fix_review_recovery_authorization_required/);assert.deepEqual(fs.readFileSync(f.statePath),old);}
  const recovered=drive('recover_final_review',request);assert.equal(recovered.status,0,recovered.stdout+recovered.stderr);
  // No answers directory is required: this request records permission, not an author response.
  assert.equal(Object.hasOwn(request,'answers'),false);
  f.reopen();assert.equal(f.owner.status().finalReviewRecoveryCount,cycle+1);
  await f.reviewNow();assert.equal(f.owner.status().stage,'unknown');
 }
 const expected=await f.owner.inspectVerificationRecovery(),old=JSON.parse(fs.readFileSync(f.statePath)).records;
 f.close();const preparedRun=drive('prepare_verification_recovery',{permissions:['--allow-verification-recovery'],expected,previousInvocationStopped:true,reason:'Runtime verification transport repaired'});
 assert.equal(preparedRun.status,0,preparedRun.stdout+preparedRun.stderr);
 const prepared=JSON.parse(preparedRun.stdout).result,preparedBytes=fs.readFileSync(f.statePath);
 assert.deepEqual(JSON.parse(preparedBytes).records.slice(0,old.length),old);
 const continuation={answers:files.answers,verificationRecoveryAuthorization:prepared.authorizationDigest};
 for(const extra of [{permissions:[]},{permissions:['--allow-final-review-recovery']},{permissions:['--allow-final-review-recovery'],finalReviewRecoveryInvocation:'wrong-invocation'}]){
  const denied=drive('final_review',{...continuation,...extra});assert.match(denied.stdout+denied.stderr,/fix_review_recovery_authorization_required/);assert.deepEqual(fs.readFileSync(f.statePath),preparedBytes);
 }
 const originalPermission=drive('final_review',{...continuation,permissions:['--allow-final-review-recovery'],finalReviewRecoveryInvocation:f24Invocation});
 assert.match(originalPermission.stdout+originalPermission.stderr,/permission_denied/);
 assert.doesNotMatch(originalPermission.stdout+originalPermission.stderr,/fix_review_recovery_authorization_required/);
 assert.deepEqual(fs.readFileSync(f.statePath),preparedBytes,'Passing F24 binding still cannot dispatch without original final-review permission');
 f.reopen();assert.equal(f.owner.status().finalReviewRecoveryCount,2);assert.equal(f.calls,3);
});
