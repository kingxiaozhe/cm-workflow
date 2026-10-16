import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';
import {startFixRun} from '../runtime/js/cm-fix/start.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const supported=process.platform==='darwin'&&Number(process.versions.node.split('.')[0])>=24;
const DRIVER=fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url));
const INSPECT=fileURLToPath(new URL('./cm-fix-verification-recovery.mjs',import.meta.url));
async function fixture(t,{reproductionClearsAfterCorrection=false,pauseReproductionAfterCorrection=false,fullCloseout=false,pauseBaseline=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-source-correction-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
 const source={
  'ios.ts':"export type AccentKey = 'blue';\nexport const palette = {blue:'#00f'};\n",
  'theme.ts':"import { AccentKey, palette } from './ios.ts';\nexport const accent: AccentKey = 'blue';\nexport const color = palette[accent];\n",
  'theme-check.mjs':"import {color} from './theme.ts';if(color!=='#00f')process.exit(1);\n",
  'button.mjs':'export const outline = true;\n',
  'button-check.mjs':"import {outline} from './button.mjs';if(outline){console.error('OUTLINE_BUG');process.exit(1);}\n"
 };
 if(reproductionClearsAfterCorrection)source['button-check.mjs']="import fs from 'node:fs';import {outline} from './button.mjs';if(outline&&!fs.readFileSync('theme.ts','utf8').startsWith('import type')){console.error('OUTLINE_BUG');process.exit(1); }\n";
 if(pauseReproductionAfterCorrection)source['button-check.mjs']="import fs from 'node:fs';if(fs.readFileSync('theme.ts','utf8').startsWith('import type'))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);"+source['button-check.mjs'];
 if(pauseBaseline)source['theme-check.mjs']+='Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1000);\n';
 for(const [name,value] of Object.entries(source))fs.writeFileSync(path.join(cwd,name),value);
 fs.writeFileSync(path.join(cwd,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:'both'},roles:{coder:{adapter:'codex-cli'},reviewer:{adapter:'claude-cli'}}}));
 const profile={files:Object.keys(source),checks:[{id:'theme',command:[process.execPath,'theme-check.mjs']}],mutationPaths:['theme.ts'],timeoutMs:3000};
 const reviewConfig={model:'synthetic',disabledSkills:[],preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint({cwd,model:'synthetic',verification:profile})}};
 const reviewer=createFixReviewHost({codeProject:cwd,hostContextId:'author',runtime:'codex',reviewRuntime:'claude',verification:profile,review:reviewConfig}).reviewer;
 const identity={repositoryId:'fixture',runId:'source-correction',taskId:'T-FIX-source-correction',attempt:1};
 const configuration={hostContextId:'author',reviewRuntime:'claude',defect:'Pressed button has outline',causeReview:reviewer,reviewVerification:profile,
  reproduction:{cwd,command:[process.execPath,'button-check.mjs'],expectedFailure:{exitCode:1,outputIncludes:'OUTLINE_BUG'},timeoutMs:3000},
  redTest:{cwd,testFiles:['button-check.mjs'],command:[process.execPath,'button-check.mjs'],expectedFailure:{exitCode:1,outputIncludes:'OUTLINE_BUG'},timeoutMs:3000},
  baseline:{cwd,testFiles:['theme-check.mjs'],commands:[{id:'theme',command:[process.execPath,'theme-check.mjs']}],timeoutMs:3000},repair:{scope:['button.mjs','theme.ts'],requirements:['button.mjs']}};
 if(fullCloseout)configuration.walkthrough={timeoutMs:3000,flows:[{id:'button-flow',modules:['button'],steps:['Read the repaired button outline'],expected:['outline is false'],kind:'commands',command:[process.execPath,'button-check.mjs']},{id:'theme-flow',modules:['theme'],steps:['Load the corrected native TypeScript theme'],expected:['palette blue is preserved'],kind:'commands',command:[process.execPath,'theme-check.mjs']}]};
 const authority=createHostReviewAuthority({hostContextId:'author',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
 const finalConfig=fixFinalReviewConfiguration(configuration),finalAuthority=createHostReviewAuthority({hostContextId:'author',reviewerId:finalConfig.reviewer.reviewerId,adapterId:finalConfig.reviewer.adapterId,decide:async()=>({status:'approved'})});
 let owner,calls=0,approve=false,finalApprove=false;
 const runtime={assertReviewReady(){},prepare:async()=>({contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}}),
  bridge:{async call(kind){if(kind==='fix_diagnose'){
   const diagnosis={status:'diagnosed',rootCause:'Pressed outline is enabled',plan:'Disable pressed outline',affectedPaths:['button.mjs','theme.ts'],affectedModules:['button','theme'],crossLayer:true};
   if(fullCloseout){const button=spawnSync(process.execPath,['button-check.mjs'],{cwd,encoding:'utf8'}),theme=spawnSync(process.execPath,['theme-check.mjs'],{cwd,encoding:'utf8'});assert.equal(button.status,1);assert.match(button.stderr,/OUTLINE_BUG/);assert.equal(theme.status,1);assert.match(theme.stderr,/does not provide an export named 'AccentKey'/);
    diagnosis.investigation={discardedAlternatives:[],boundaryAnalysis:{callChain:'button-check.mjs -> button.mjs; theme-check.mjs -> theme.ts -> ios.ts',edgeEvidence:'Native button check exits 1 with OUTLINE_BUG; native theme check exits 1 because AccentKey is not a runtime export',lastNormalEdge:'Both commands launched successfully with the frozen Node executable',firstFailingEdge:'button exports outline=true; theme uses a type-only symbol as a runtime import',hypotheses:[{hypothesis:'The button defect remains separate from the theme import transport failure',support:'The independent button command reports the original OUTLINE_BUG signature',counterTest:'Run theme-check.mjs separately with the same native Node executable',result:'The independent theme command fails with missing AccentKey runtime export'}]}};
   }return diagnosis;
  }
   if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'button.mjs'),'export const outline = false;\n');return {outcome:'repaired'};}
   if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};throw Error(kind);}},
  causeReview:{authorize:authority.authorize,async run(request,{onEvent,onVerification}){
   calls++;const thread='review-'+calls;for(const e of [{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(e);
   if(!(request.payload.reviewPackage.kind==='cm-fix-cause-review-package'?approve:finalApprove))return {status:'failed',code:'review_verification_evidence'};
   const files=profile.files.map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(cwd,p))),mode:fs.statSync(path.join(cwd,p)).mode&511})),before=files.find(f=>f.path==='theme.ts').sha256;
   onVerification({version:1,requestDigest:request.requestDigest,packageDigest:request.payload.reviewPackage.packageDigest,profileDigest:digest(profile),providerThreadId:thread,files,snapshotDigest:digest(files),checks:[{id:'theme',commandDigest:digest(profile.checks[0].command),exitCode:0,outputSha256:sha(''),startedAt:1,endedAt:2}],mutations:[{path:'theme.ts',beforeSha256:before,afterSha256:'c'.repeat(64),checkId:'theme',baselineExitCode:0,mutatedExitCode:1,restoredExitCode:0,restoredSha256:before,startedAt:3,endedAt:4}]});
   return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:['button.mjs','theme.ts'],findings:[],summary:'Synthetic routing proof only'}};
  }}};
 runtime.finalReview={authorize:finalAuthority.authorize,run:runtime.causeReview.run};
 const options={specsRoot,identity,configuration};owner=openFixExecution({...options,create:true},runtime);
 t.after(()=>{owner?.close();fs.rmSync(root,{recursive:true,force:true});});
 const review=async token=>{const pkg=owner.causeReviewPackage();await authority.hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);return owner.reviewCause({verificationRecoveryAuthorization:token});};
 const finalReview=async()=>{const pkg=owner.finalReviewPackage();await finalAuthority.hostDecisionProvider.decide({identity:pkg.identity,packageDigest:pkg.packageDigest},new AbortController().signal);return owner.reviewFinal();};
 if(fullCloseout)startFixRun({specsRoot,identity,configuration});
 await owner.advance({authorized:true});await review();for(let i=0;i<2;i++){owner.abandonReview({authorized:true,reason:'Verification worker closed'});await review();}
 const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
 const correction={kind:'type-import-split',path:'theme.ts',beforeSha256:sha(source['theme.ts']),typeNames:['AccentKey']};
 const config=path.join(root,'config.json'),reviewPath=path.join(root,'review.json'),correctionPath=path.join(root,'correction.json'),answers=path.join(root,'answers');
 const {hostContextId,causeReview,reviewRuntime,...run}=configuration;
 fs.writeFileSync(config,JSON.stringify({...run,identity,specsRoot}));fs.writeFileSync(reviewPath,JSON.stringify(reviewConfig));fs.writeFileSync(correctionPath,JSON.stringify(correction));fs.mkdirSync(answers);
 return {root,cwd,specsRoot,statePath,source,correction,config,reviewPath,correctionPath,answers,configuration,review,finalReview,get owner(){return owner;},get calls(){return calls;},approve(){approve=true;},approveFinal(){finalApprove=true;},close(){owner.close();owner=null;},reopen(){owner?.close();owner=openFixExecution({...options,create:false},runtime);}};
}
function cli(f,args){return spawnSync(process.execPath,args,{encoding:'utf8',timeout:30000,env:{...process.env,CM_WORKFLOW_HOME:path.join(f.root,'home'),CM_WORKFLOW_LOG_HOME:path.join(f.root,'logs')}});}

test('type-import source correction previews in isolation then preserves original history and final diff',{skip:!supported},async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.statePath),old=JSON.parse(before),calls=f.calls;
 const broken=spawnSync(process.execPath,['theme-check.mjs'],{cwd:f.cwd,encoding:'utf8'});assert.notEqual(broken.status,0);assert.match(broken.stderr,/does not provide an export named 'AccentKey'/);
 const expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction});
 assert.ok(expected.sourceCorrection);assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(f.calls,calls);assert.equal(fs.readFileSync(path.join(f.cwd,'theme.ts'),'utf8'),f.source['theme.ts']);
 const prepared=await f.owner.prepareVerificationRecovery({authorized:true,sourceCorrectionAuthorized:true,expected,sourceCorrection:f.correction,previousInvocationStopped:true,reason:'Explicit type-only import correction; preserve button defect'});
 assert.match(prepared.authorizationDigest,/^[a-f0-9]{64}$/);assert.equal(f.calls,calls);
 assert.match(fs.readFileSync(path.join(f.cwd,'theme.ts'),'utf8'),/import type/);assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records.slice(0,old.records.length),old.records);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).fingerprints,old.fingerprints);
 assert.deepEqual(await f.owner.prepareVerificationRecovery({authorized:true,sourceCorrectionAuthorized:true,expected,sourceCorrection:f.correction,previousInvocationStopped:true,reason:'Explicit type-only import correction; preserve button defect'}),prepared);
 f.reopen();f.approve();await f.review(prepared.authorizationDigest);assert.equal(f.owner.status().stage,'red_test_required');
 await f.owner.runRedTest({authorized:true});await f.owner.captureBaseline({authorized:true});await f.owner.repair({authorized:true});await f.owner.runRegression({authorized:true});await f.owner.retrospect();f.owner.createHandoff();
 const pkg=f.owner.finalReviewPackage(),change=pkg.changes.find(c=>c.path==='theme.ts');
 assert.ok(change,'Pre-review source correction must remain visible in final implementation diff');
 assert.equal(Buffer.from(change.before.contentBase64,'base64').toString(),f.source['theme.ts']);assert.match(Buffer.from(change.after.contentBase64,'base64').toString(),/import type/);
 assert.deepEqual(f.configuration.repair.scope,['button.mjs','theme.ts']);assert.equal(f.calls,calls+1);
});

test('real source-correction inspector and driver preserve previews and require separate startup authority',{skip:!supported},async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.statePath),calls=f.calls;
 f.close();
 const inspection=cli(f,[INSPECT,'--config',f.config,'--source-correction',f.correctionPath]);assert.equal(inspection.status,0,inspection.stdout+inspection.stderr);
 const expected=JSON.parse(inspection.stdout).expected;assert.ok(expected.sourceCorrection);
 assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(fs.readFileSync(path.join(f.cwd,'theme.ts'),'utf8'),f.source['theme.ts']);
 const plan=path.join(f.root,'plan.json'),base={config:f.config,cwd:f.cwd,mode:'resume',hostContext:'author',runtime:'codex',reviewRuntime:'claude',reviewConfig:f.reviewPath,expected,sourceCorrection:f.correction,previousInvocationStopped:true,reason:'Authorized type-only import correction'};
 const drive=(permissions,operation='prepare_verification_recovery',extra={})=>{fs.writeFileSync(plan,JSON.stringify({...base,permissions,...extra}));return cli(f,[DRIVER,'--plan',plan,operation]);};
 let run=drive(['--allow-verification-recovery']);assert.equal(run.status,2);assert.match(run.stderr,/--allow-source-correction/);assert.deepEqual(fs.readFileSync(f.statePath),before);
 run=drive(['--allow-source-correction']);assert.equal(run.status,2);assert.match(run.stderr,/--allow-verification-recovery/);assert.deepEqual(fs.readFileSync(f.statePath),before);
 run=drive(['--allow-verification-recovery','--allow-source-correction']);assert.equal(run.status,0,run.stdout+run.stderr);const prepared=JSON.parse(run.stdout).result;
 assert.match(prepared.authorizationDigest,/^[a-f0-9]{64}$/);assert.match(fs.readFileSync(path.join(f.cwd,'theme.ts'),'utf8'),/import type/);
 const preparedBytes=fs.readFileSync(f.statePath);run=drive(['--allow-verification-recovery','--allow-source-correction']);assert.equal(run.status,0,run.stdout+run.stderr);assert.deepEqual(fs.readFileSync(f.statePath),preparedBytes);
 // A fresh review is still separately authorized; preparing source does not invoke it.
 const {sourceCorrection,...continuation}=base;fs.writeFileSync(plan,JSON.stringify({...continuation,answers:f.answers,permissions:[],verificationRecoveryAuthorization:prepared.authorizationDigest}));
 run=cli(f,[DRIVER,'--plan',plan,'cause_review']);assert.match(run.stdout+run.stderr,/permission_denied/);assert.deepEqual(fs.readFileSync(f.statePath),preparedBytes);assert.equal(f.calls,calls);
 f.reopen();assert.equal(f.owner.status().stage,'cause_review_required');
});

test('source-correction startup flag refuses create and missing recovery permission before opening a run',{skip:!supported},async t=>{
 const f=await fixture(t),before=fs.readFileSync(f.statePath),host=fileURLToPath(new URL('./cm-fix-host.mjs',import.meta.url));f.close();
 for(const [mode,permissions] of [['create',['--allow-verification-recovery','--allow-source-correction']],['resume',['--allow-source-correction']]]){
  const run=cli(f,[host,'serve','--config',f.config,'--mode',mode,'--host-context','author','--allow-reproduction',...permissions]);assert.notEqual(run.status,0);assert.match(run.stderr,/fix_(?:source_correction_authorization_required|verification_recovery_unavailable)/);assert.deepEqual(fs.readFileSync(f.statePath),before);
 }
});

const prepareInput=(f,expected)=>({authorized:true,sourceCorrectionAuthorized:true,expected,sourceCorrection:f.correction,previousInvocationStopped:true,reason:'Explicit original-scope type import repair'});
test('source correction rejects missing authority, wrong expected and wrong declaration before writes',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),before=fs.readFileSync(f.statePath);
 for(const [override,code] of [[{authorized:false},'fix_verification_recovery_authorization_required'],[{sourceCorrectionAuthorized:false},'fix_source_correction_authorization_required'],[{previousInvocationStopped:false},'fix_verification_recovery_confirmation'],[{expected:{...expected,invocationId:'wrong'}},'fix_verification_recovery_stale'],[{sourceCorrection:{...f.correction,typeNames:['MissingType']}},'type_import_correction_names']]){
  await assert.rejects(f.owner.prepareVerificationRecovery({...input,...override}),{code});assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(fs.readFileSync(path.join(f.cwd,'theme.ts'),'utf8'),f.source['theme.ts']);
 }
 assert.equal(f.calls,3);
});

test('source correction refuses a third source image and unapproved manual correction',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),before=fs.readFileSync(f.statePath);
 const target=path.join(f.cwd,'theme.ts');fs.appendFileSync(target,'// unrelated manual source\n');
 await assert.rejects(f.owner.prepareVerificationRecovery(input));assert.deepEqual(fs.readFileSync(f.statePath),before);
 fs.writeFileSync(target,Buffer.from(expected.sourceCorrection.after.contentBase64,'base64'));
 await assert.rejects(f.owner.prepareVerificationRecovery(input));assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(f.calls,3);
});

test('source correction resumes the exact recorded intent after an injected post-rename interruption',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),before=JSON.parse(fs.readFileSync(f.statePath)).records;
 const target=path.join(f.cwd,'theme.ts'),rename=fs.renameSync;let interrupted=false;
 fs.renameSync=(from,to)=>{const result=rename(from,to);if(to===target&&!interrupted){interrupted=true;throw Object.assign(new Error('fixture interruption after atomic source rename'),{code:'fixture_interruption'});}return result;};
 try{await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fixture_interruption'});}finally{fs.renameSync=rename;}
 assert.ok(interrupted);assert.match(fs.readFileSync(target,'utf8'),/import type/);
 const interruptedRows=JSON.parse(fs.readFileSync(f.statePath)).records;assert.deepEqual(interruptedRows.slice(0,before.length),before);
 assert.equal(interruptedRows.filter(r=>r.id==='fix-verification-recovery-source-intent').length,1);assert.equal(interruptedRows.some(r=>r.id==='fix-verification-recovery-prepared'),false);
 f.reopen();const exactAfter=fs.readFileSync(target),interruptedState=fs.readFileSync(f.statePath);fs.appendFileSync(target,'// third content after interruption\n');
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'type_import_correction_stale'});assert.deepEqual(fs.readFileSync(f.statePath),interruptedState);fs.writeFileSync(target,exactAfter);
 const prepared=await f.owner.prepareVerificationRecovery(input);assert.match(prepared.authorizationDigest,/^[a-f0-9]{64}$/);
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records;assert.deepEqual(rows.slice(0,interruptedRows.length),interruptedRows);assert.equal(rows.filter(r=>r.id==='fix-verification-recovery-source-intent').length,1);assert.equal(f.calls,3);
 assert.deepEqual(await f.owner.prepareVerificationRecovery(input),prepared);
});

test('source correction cannot replace a prepared declaration or claim a second recovery budget',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),prepared=await f.owner.prepareVerificationRecovery(input),before=fs.readFileSync(f.statePath);
 await assert.rejects(f.owner.prepareVerificationRecovery({...input,sourceCorrection:{...f.correction,typeNames:['palette']}}));assert.deepEqual(fs.readFileSync(f.statePath),before);
 for(const override of [{sourceCorrectionAuthorized:false},{sourceCorrection:undefined},{sourceCorrectionAuthorized:false,sourceCorrection:undefined}]){await assert.rejects(f.owner.prepareVerificationRecovery({...input,...override}),{code:'fix_source_correction_authorization_required'});assert.deepEqual(fs.readFileSync(f.statePath),before);}
 await assert.rejects(f.owner.inspectVerificationRecovery(),{code:'fix_verification_recovery_used'});
 assert.throws(()=>f.owner.abandonReview({authorized:true,reason:'No reset'}),{code:'fix_verification_recovery_used'});
 await f.review(prepared.authorizationDigest);assert.equal(f.owner.status().stage,'unknown');assert.equal(f.calls,4);
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_verification_recovery_used'});assert.equal(f.calls,4);
});

test('source correction records failure and cannot dispatch when original reproduction no longer matches',{skip:!supported},async t=>{
 const f=await fixture(t,{reproductionClearsAfterCorrection:true}),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),old=JSON.parse(fs.readFileSync(f.statePath)).records;
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_source_correction_reproduction_changed'});
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records;assert.deepEqual(rows.slice(0,old.length),old);assert.equal(rows.some(r=>r.id==='fix-verification-recovery-prepared'),false);
 assert.equal(rows.find(r=>r.id==='fix-verification-recovery-source-failed').payload.code,'fix_source_correction_reproduction_changed');
 assert.match(fs.readFileSync(path.join(f.cwd,'theme.ts'),'utf8'),/import type/);f.reopen();assert.equal(f.owner.status().stage,'unknown');
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_source_correction_failed'});assert.equal(f.calls,3);
});

test('interrupted source checks consume their bounded attempts without resetting review calls',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected);
 for(let attempt=1;attempt<=2;attempt++){
  const rename=fs.renameSync;let interrupted=false;
  fs.renameSync=(from,to)=>{const result=rename(from,to);if(to===f.statePath&&!interrupted&&JSON.parse(fs.readFileSync(to)).records.at(-1).id===`fix-verification-recovery-source-check-${attempt}-intent`){interrupted=true;throw Object.assign(new Error('fixture interruption after durable check intent'),{code:'fixture_interruption'});}return result;};
  try{await assert.rejects(f.owner.prepareVerificationRecovery(input));}finally{fs.renameSync=rename;}
  assert.ok(interrupted);f.reopen();assert.equal(f.owner.status().sourceCorrection.checksUsed,attempt);assert.equal(f.calls,3);
 }
 const before=fs.readFileSync(f.statePath);await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_source_correction_check_budget'});assert.deepEqual(fs.readFileSync(f.statePath),before);
 assert.equal(JSON.parse(before).records.some(r=>r.id==='fix-verification-recovery-prepared'),false);
});

test('source intent rejects non-target profile drift before applying the recorded patch',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),target=path.join(f.cwd,'theme.ts'),rename=fs.renameSync;let interrupted=false;
 fs.renameSync=(from,to)=>{if(to===target&&!interrupted){interrupted=true;throw Object.assign(new Error('fixture interruption before atomic source rename'),{code:'fixture_interruption'});}return rename(from,to);};
 try{await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fixture_interruption'});}finally{fs.renameSync=rename;}
 assert.ok(interrupted);f.reopen();const before=fs.readFileSync(f.statePath);fs.appendFileSync(path.join(f.cwd,'ios.ts'),'// changed dependency after intent\n');
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_source_correction_drift'});
 assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(fs.readFileSync(target,'utf8'),f.source['theme.ts']);assert.equal(f.calls,3);
});

test('source result cannot prepare after profile drift in the result-to-prepared interruption gap',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),rename=fs.renameSync;let interrupted=false;
 fs.renameSync=(from,to)=>{if(to===f.statePath&&!interrupted&&JSON.parse(fs.readFileSync(from)).records.at(-1).id==='fix-verification-recovery-prepared'){interrupted=true;throw Object.assign(new Error('fixture interruption before prepared checkpoint'),{code:'fixture_interruption'});}return rename(from,to);};
 try{await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fixture_interruption'});}finally{fs.renameSync=rename;}
 assert.ok(interrupted);f.reopen();const before=fs.readFileSync(f.statePath),rows=JSON.parse(before).records;
 assert.ok(rows.some(r=>r.id==='fix-verification-recovery-source-result'));assert.equal(rows.some(r=>r.id==='fix-verification-recovery-prepared'),false);
 fs.appendFileSync(path.join(f.cwd,'ios.ts'),'// changed after result\n');
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_source_correction_drift'});assert.deepEqual(fs.readFileSync(f.statePath),before);assert.equal(f.calls,3);
});

test('durable source result survives a post-rename store interruption without competing failure or repeated checks',{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),rename=fs.renameSync;let interrupted=false;
 fs.renameSync=(from,to)=>{const result=rename(from,to);if(to===f.statePath&&!interrupted&&JSON.parse(fs.readFileSync(to)).records.at(-1).id==='fix-verification-recovery-source-result'){interrupted=true;throw Object.assign(new Error('fixture interruption after durable source result'),{code:'fixture_interruption'});}return result;};
 try{await assert.rejects(f.owner.prepareVerificationRecovery(input));}finally{fs.renameSync=rename;}
 assert.ok(interrupted);const rows=JSON.parse(fs.readFileSync(f.statePath)).records;
 assert.ok(rows.some(r=>r.id==='fix-verification-recovery-source-result'));assert.equal(rows.some(r=>r.id==='fix-verification-recovery-source-failed'),false);assert.equal(rows.some(r=>r.id==='fix-verification-recovery-prepared'),false);
 f.reopen();const prepared=await f.owner.prepareVerificationRecovery(input);assert.match(prepared.authorizationDigest,/^[a-f0-9]{64}$/);
 const after=JSON.parse(fs.readFileSync(f.statePath)).records;assert.deepEqual(after.slice(0,rows.length),rows);assert.equal(after.filter(r=>/^fix-verification-recovery-source-check-[12]-intent$/.test(r.id)).length,1);assert.equal(after.some(r=>r.id==='fix-verification-recovery-source-failed'),false);assert.equal(f.calls,3);
});

test('cancelling an active source reproduction cannot publish a prepared continuation',{skip:!supported},async t=>{
 const f=await fixture(t,{pauseReproductionAfterCorrection:true}),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected);
 const running=f.owner.prepareVerificationRecovery(input).then(value=>({value}),error=>({error}));
 const deadline=Date.now()+5000;let started=false;
 while(Date.now()<deadline){if(JSON.parse(fs.readFileSync(f.statePath)).records.some(r=>r.id==='fix-verification-recovery-source-check-1-intent')){started=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
 assert.ok(started,'The fixed source reproduction must actually have started');f.owner.cancel();const result=await running;assert.ok(result.error);
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records;assert.equal(rows.some(r=>r.id==='fix-verification-recovery-prepared'),false);assert.equal(rows.some(r=>r.id==='fix-verification-recovery-registered'),false);assert.equal(f.calls,3);
 f.reopen();assert.equal(f.owner.status().stage,'cancelled');
});

async function correctedCause(f){
 const expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),prepared=await f.owner.prepareVerificationRecovery(input);
 f.approve();await f.review(prepared.authorizationDigest);assert.equal(f.owner.status().stage,'red_test_required');return {input,prepared};
}
async function reachFinalReview(f){
 await f.owner.runRedTest({authorized:true});await f.owner.captureBaseline({authorized:true});await f.owner.repair({authorized:true});await f.owner.runRegression({authorized:true});await f.owner.retrospect();f.owner.createHandoff();
}
test('successful source cause recovery retains original F24 final recovery and replays its fresh review',{skip:!supported},async t=>{
 const f=await fixture(t),{input}=await correctedCause(f);await reachFinalReview(f);await f.finalReview();assert.equal(f.owner.status().stage,'unknown');
 const before=JSON.parse(fs.readFileSync(f.statePath)).records,last=before.findLast(r=>r.id.endsWith('-registered')&&r.payload.request?.role==='reviewer').payload;
 const recovered=f.owner.recoverFinalReview({authorized:true,invocationId:last.request.invocationId,packageDigest:last.request.payload.reviewPackage.packageDigest,previousInvocationStopped:true,reason:'Original F24 budget after a separate final transport failure'});
 assert.equal(recovered.stage,'final_review_required');assert.equal(recovered.finalReviewRecoveryCount,1);
 assert.deepEqual(JSON.parse(fs.readFileSync(f.statePath)).records.slice(0,before.length),before);
 f.reopen();assert.equal(f.owner.status().stage,'final_review_required');f.approveFinal();await f.finalReview();assert.equal(f.owner.status().stage,'final_review_evidence_required');
 f.owner.publishReview();f.reopen();assert.equal(f.owner.status().stage,'completion_gate_required');
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records,oldThread=rows.find(r=>r.id==='fix-final-started').payload.providerThreadId,newThread=rows.find(r=>r.id==='fix-final-recovery-started').payload.providerThreadId;
 assert.notEqual(newThread,oldThread);assert.equal(rows.filter(r=>r.id==='fix-verification-recovery-registered').length,1);
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_verification_recovery_used'});
});

// Fixture-only corruption: reseal hashes so failures come from semantic replay,
// not the store's byte/hash checks. Never applied to a user's execution archive.
function resealFixture(statePath,mutate){
 const state=JSON.parse(fs.readFileSync(statePath));mutate(state.records);let previous=null;
 for(const row of state.records){row.previousDigest=previous;const {digest:old,...data}=row;row.digest=digest(data);previous=row.digest;}
 const {revision,...data}=state;state.revision=digest(data);fs.writeFileSync(statePath,JSON.stringify(state)+'\n');
}
for(const field of ['package','reproduction','baseline','sourceResultDigest','sourceRevision'])test(`source correction replay rejects resealed ${field} tampering`,{skip:!supported},async t=>{
 const f=await fixture(t),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),prepared=await f.owner.prepareVerificationRecovery(prepareInput(f,expected));
 if(field==='sourceRevision'){f.approve();await f.review(prepared.authorizationDigest);assert.equal(f.owner.status().stage,'red_test_required');}
 f.close();const original=fs.readFileSync(f.statePath);
 resealFixture(f.statePath,rows=>{
  const result=rows.find(r=>r.id==='fix-verification-recovery-source-result').payload,ready=rows.find(r=>r.id==='fix-verification-recovery-prepared').payload;
  if(field==='package'){result.package.defect+=' substituted';const {packageDigest,...body}=result.package;result.package.packageDigest=digest(body);}
  if(field==='reproduction')result.reproduction.observation.signatureMatched=false;
  if(field==='baseline')result.baseline.checks[0].commandDigest='a'.repeat(64);
  if(['package','reproduction','baseline'].includes(field))rows.splice(rows.findIndex(r=>r.id==='fix-verification-recovery-source-result')+1);
  if(field==='sourceResultDigest')ready.sourceResultDigest='a'.repeat(64);
  if(field==='sourceRevision'){
   const pkg=rows.find(r=>r.id==='fix-verification-recovery-registered').payload.request.payload.reviewPackage;
   pkg.sourceRevision.correctionDigest='a'.repeat(64);const {packageDigest,...body}=pkg;pkg.packageDigest=digest(body);
  }
 });
 try{assert.throws(()=>{f.reopen();f.owner.status();},error=>['fix_source_correction_binding','reproduction_mismatch','fix_verification_recovery_baseline','fix_verification_recovery_binding'].includes(error.code));}
 finally{fs.writeFileSync(f.statePath,original);}
});

test('source correction completes the original JS gates with walkthrough frozen at creation',{skip:!supported},async t=>{
 const f=await fixture(t,{fullCloseout:true}),initial=JSON.parse(fs.readFileSync(f.statePath)),{input}=await correctedCause(f);
 await reachFinalReview(f);f.approveFinal();await f.finalReview();assert.equal(f.owner.status().stage,'final_review_evidence_required');
 f.owner.publishReview();assert.equal(f.owner.checkCompletionGate().stage,'post_review_regression_required');
 await f.owner.runRegression({authorized:true,postReview:true});assert.equal(f.owner.status().stage,'closeout_required');
 await f.owner.runWalkthrough({authorized:true});assert.equal(f.owner.status().walkthrough.status,'passed');
 const finished=f.owner.finish({authorized:true});assert.equal(finished.stage,'completed');assert.equal(finished.completionEligible,true);
 f.reopen();assert.equal(f.owner.status().stage,'completed');const evidence=f.owner.completionEvidence();
 assert.ok(evidence.reviewPackage.changes.some(c=>c.path==='theme.ts'));assert.equal(evidence.identity.attempt,1);
 const final=JSON.parse(fs.readFileSync(f.statePath));assert.deepEqual(final.fingerprints,initial.fingerprints);assert.deepEqual(final.records.slice(0,initial.records.length),initial.records);
 await assert.rejects(f.owner.prepareVerificationRecovery(input),{code:'fix_verification_recovery_used'});
});

test('cancelling formal source baseline interrupts its frozen check before completion',{skip:!supported},async t=>{
 const f=await fixture(t,{pauseBaseline:true}),expected=await f.owner.inspectVerificationRecovery({sourceCorrection:f.correction}),input=prepareInput(f,expected),write=fs.writeFileSync;
 let scheduled=false,cancelledAt=0,timer;
 fs.writeFileSync=(file,...args)=>{const result=write(file,...args);if(!scheduled&&typeof file==='string'&&file.endsWith('/tools.json')&&JSON.parse(fs.readFileSync(f.statePath)).records.some(r=>r.id==='fix-verification-recovery-source-check-1-intent')){
  scheduled=true;timer=setTimeout(()=>{cancelledAt=Date.now();f.owner.cancel();},50);
 }return result;};
 let failure;try{await f.owner.prepareVerificationRecovery(input);}catch(error){failure=error;}finally{fs.writeFileSync=write;clearTimeout(timer);}
 assert.ok(scheduled);assert.ok(cancelledAt);assert.ok(failure);assert.equal(failure.verificationDiagnostic?.code,'verification_cancelled');
 const rows=JSON.parse(fs.readFileSync(f.statePath)).records;assert.equal(rows.some(r=>r.id==='fix-verification-recovery-source-result'),false);assert.equal(rows.some(r=>r.id==='fix-verification-recovery-prepared'),false);assert.equal(f.calls,3);
 f.reopen();assert.equal(f.owner.status().stage,'cancelled');
});
