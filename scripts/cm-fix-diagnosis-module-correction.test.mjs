import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Readable,Writable} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import * as execution from '../runtime/js/cm-fix/execution.mjs';
import {createFixHost} from '../runtime/js/cm-fix/host.mjs';
import {createFixReviewHost} from '../runtime/js/cm-fix/host-review.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {digest,need} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readFixCausePackage} from '../runtime/js/cm-fix/cause-package.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';

const MARK='CM_DIAGNOSIS_MODULE_CORRECTION',OP='prepare_diagnosis_module_correction',FLAG='--allow-diagnosis-module-correction';
const isolated=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-diagnosis-module-test-home-'))),priorEnvironment={};
for(const key of ['HOME','CLAUDE_HOME','CODEX_HOME','CM_WORKFLOW_HOME','CM_WORKFLOW_LOG_HOME']){priorEnvironment[key]=process.env[key];process.env[key]=path.join(isolated,key);fs.mkdirSync(process.env[key]);}
after(()=>{for(const [key,value]of Object.entries(priorEnvironment))if(value===undefined)delete process.env[key];else process.env[key]=value;fs.rmSync(isolated,{recursive:true,force:true});});
const DRIVER=fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url)),HOST=fileURLToPath(new URL('./cm-fix-host.mjs',import.meta.url));
const denied=/^(?:fix_diagnosis_module_correction_(?:unavailable|stale|binding|confirmation|authorization_required|drift)|fix_busy|unsupported_file)$/;
function api(owner){assert.equal(typeof execution.inspectFixDiagnosisModuleCorrection,'function',MARK+': missing read-only API');assert.equal(typeof owner.inspectDiagnosisModuleCorrection,'function',MARK+': missing owner preview');assert.equal(typeof owner.prepareDiagnosisModuleCorrection,'function',MARK+': missing owner prepare');}
const bytes=p=>fs.readFileSync(p),parsed=p=>JSON.parse(bytes(p));
function output(){let value='';return {stream:new Writable({write(c,e,cb){value+=c;cb();}}),get value(){return value;}};}
async function fixture(t,{aligned=false,outside=false,waitingDiagnosis=false,lifecycle=false}={}){
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-diagnosis-module-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
 fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(cwd,'one'));fs.mkdirSync(path.join(cwd,'two'));
 fs.writeFileSync(path.join(cwd,'one/value.mjs'),'export const value=1;');
 fs.writeFileSync(path.join(cwd,'test.mjs'),"import {value} from './one/value.mjs';if(value!==2){console.error('OWNED MODULE BUG');process.exit(1)}");
 const saved={},home=path.join(root,'home');fs.mkdirSync(home);
 for(const k of ['HOME','CLAUDE_HOME','CODEX_HOME','CM_WORKFLOW_HOME','CM_WORKFLOW_LOG_HOME']){saved[k]=process.env[k];process.env[k]=path.join(home,k);fs.mkdirSync(process.env[k],{recursive:true});}
 const review={model:'synthetic',disabledSkills:[],preflight:{passed:true,cli_model:'synthetic',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd,model:'synthetic',disabledSkills:[],promptTransport:'stdin'})}};
 let workerCalls=0,started=null,releaseWorker=null,releaseDiagnosis=null;
 const host=createFixReviewHost({codeProject:cwd,hostContextId:'owned-host',review,permissions:['--allow-cause-review'],workerFactory:()=>async(input,{onEvent,signal})=>{
  workerCalls++;onEvent({event:'thread.started',provider_thread:'owned-started-thread'});started=true;
  if(lifecycle){const data=JSON.parse(input.prompt.split('<cm-review-data-json>\n')[1]);for(const event of [{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
   return {status:'succeeded',value:{verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:['one/value.mjs'],findings:[],summary:'Owned synthetic reviewer; no provider'}};}
  return new Promise(resolve=>{releaseWorker=()=>resolve({status:'failed',code:'owned_stopped'});signal.addEventListener('abort',releaseWorker,{once:true});});
 }});
 const diagnosis={status:'diagnosed',rootCause:'The owned constant is wrong',affectedPaths:['one/value.mjs'],plan:'Set the owned constant to two',crossLayer:true,
  affectedModules:outside?['one','foreign']:aligned?['one','two']:['one'],investigation:{discardedAlternatives:[],boundaryAnalysis:null}};
 const configuration={hostContextId:'owned-host',defect:'Owned wrong value',causeReview:host.reviewer,
  reproduction:{cwd,command:[process.execPath,'test.mjs'],expectedFailure:{exitCode:1,outputIncludes:'OWNED MODULE BUG'},timeoutMs:5000},
  redTest:{cwd,command:[process.execPath,lifecycle?'regression.test.mjs':'test.mjs'],testFiles:[lifecycle?'regression.test.mjs':'test.mjs'],expectedFailure:{exitCode:1,outputIncludes:'OWNED MODULE BUG'},timeoutMs:5000},
  ...(lifecycle?{testAuthor:{requirements:['one/value.mjs']}}:{}),
  baseline:{cwd,testFiles:['test.mjs'],commands:[{id:'existing',command:[process.execPath,'--check','test.mjs']}],timeoutMs:5000},
  repair:{scope:['one/value.mjs'],requirements:['one/value.mjs']},
  walkthrough:{flows:[{id:'one',modules:['two','one'],kind:'commands',steps:['Read the owned constant'],expected:['The constant is two'],command:[process.execPath,'test.mjs']}],timeoutMs:5000}};
 const identity={repositoryId:'owned-fixture',runId:'diagnosis-module',taskId:'T-FIX-module',attempt:1};
 const capabilities={...host.execution,...(lifecycle?{prepare:async()=>({contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'Owned fixture has no project lessons'}})}:{}),bridge:{async call(kind){
  if(kind==='fix_test_author'){assert(lifecycle);fs.writeFileSync(path.join(cwd,'regression.test.mjs'),fs.readFileSync(path.join(cwd,'test.mjs')));return {outcome:'authored'};}
  if(kind==='fix_repair'){assert(lifecycle);fs.writeFileSync(path.join(cwd,'one/value.mjs'),'export const value=2;');return {outcome:'repaired'};}
  if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
  assert.equal(kind,'fix_diagnose');if(waitingDiagnosis)await new Promise(resolve=>{releaseDiagnosis=resolve;});return diagnosis;
 }}};
 let owner=execution.openFixExecution({specsRoot,identity,configuration,create:true},capabilities);
 const statePath=path.join(specsRoot,'.reviews/.execution/diagnosis-module/state.json');
 t.after(()=>{owner?.close();for(const [k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;fs.rmSync(root,{recursive:true,force:true});});
 const advancement=owner.advance({authorized:true});
 if(!waitingDiagnosis){await advancement;assert.equal(owner.status().stage,aligned?'cause_review_required':'walkthrough_configuration_mismatch');}
 else{for(let i=0;i<100&&!releaseDiagnosis;i++)await new Promise(resolve=>setTimeout(resolve,5));assert(releaseDiagnosis);}
 return {root,cwd,specsRoot,identity,configuration,diagnosis,review,statePath,host,advancement,get owner(){return owner;},get workerCalls(){return workerCalls;},get started(){return started;},releaseDiagnosis:()=>releaseDiagnosis?.(),close(){owner.close();},reopen(options={},extra={}){owner.close();owner=execution.openFixExecution({specsRoot,identity,configuration,create:false,...options},{...capabilities,...extra});return owner;}};
}
const request=(expected,extra={})=>({authorized:true,expected,previousInvocationStopped:true,reason:'Explicitly align only the frozen walkthrough modules',...extra});
const refused=(fn,code)=>assert.throws(fn,error=>code?error.code===code:denied.test(error.code));

test('diagnosis module correction: real mismatch gains exactly the frozen union and preserves original diagnosis, records and replay',async t=>{
 const f=await fixture(t),before=parsed(f.statePath),old=bytes(f.statePath);api(f.owner);
 const expected=f.owner.inspectDiagnosisModuleCorrection();assert.deepEqual(bytes(f.statePath),old);
 f.close();const publicTarget=execution.inspectFixDiagnosisModuleCorrection({specsRoot:f.specsRoot,identity:{repositoryId:f.identity.repositoryId,runId:f.identity.runId}});
 assert.deepEqual(publicTarget,expected);assert.deepEqual(bytes(f.statePath),old);f.reopen();
 assert.deepEqual(expected.originalModules,['one']);assert.deepEqual(expected.modules,['one','two']);
 assert.equal(expected.configurationDigest,digest(before.records[0].payload.configuration));assert.equal(expected.historyDigest,digest(before.records));assert.equal(expected.diagnosisDigest,digest(f.diagnosis));
 assert.deepEqual(expected.files.map(x=>x.path),['one/value.mjs']);assert.equal(expected.snapshotDigest,digest(expected.files));
 const input=request(expected),receipt=f.owner.prepareDiagnosisModuleCorrection(input),after=parsed(f.statePath),status=f.owner.status();
 assert.equal(after.records.length,before.records.length+1);assert.deepEqual(after.records.slice(0,before.records.length),before.records);assert.deepEqual(after.fingerprints,before.fingerprints);
 assert.equal(after.records.at(-1).id,'fix-diagnosis-module-corrected');assert.equal(after.records.at(-1).kind,'result');
 assert.deepEqual(status.originalDiagnosis,f.diagnosis);assert.deepEqual(status.diagnosis,{...f.diagnosis,affectedModules:['one','two']});assert.equal(status.stage,'cause_review_required');
 assert.equal(receipt.correctionDigest,digest({target:expected,reason:input.reason,previousInvocationStopped:true}));
 const prepared=bytes(f.statePath);assert.deepEqual(f.owner.prepareDiagnosisModuleCorrection(input),receipt);assert.deepEqual(bytes(f.statePath),prepared);
 f.reopen();assert.deepEqual(f.owner.status().diagnosis,status.diagnosis);assert.deepEqual(f.owner.prepareDiagnosisModuleCorrection(input),receipt);assert.deepEqual(bytes(f.statePath),prepared);
 const pkg=f.owner.causeReviewPackage();assert.deepEqual(pkg.diagnosis,status.diagnosis);assert.deepEqual(pkg.diagnosisModuleCorrection.originalDiagnosis,f.diagnosis);
 assert.equal(pkg.diagnosisModuleCorrection.correctionDigest,receipt.correctionDigest);assert.deepEqual(readFixCausePackage(pkg),pkg);
 const forged={...pkg,diagnosis:{...pkg.diagnosis,plan:'Forged replacement plan'}};const {packageDigest,...body}=forged;forged.packageDigest=digest(body);assert.throws(()=>readFixCausePackage(forged));
 assert.equal(f.workerCalls,0);assert.deepEqual(bytes(f.statePath),prepared);
});

test('diagnosis module correction: authority, stopped confirmation, exact target and reason are mandatory before append',async t=>{
 const f=await fixture(t);api(f.owner);const expected=f.owner.inspectDiagnosisModuleCorrection(),before=bytes(f.statePath);
 for(const extra of [{authorized:false},{previousInvocationStopped:false},{reason:''},{reason:'not\na single line'},{expected:{...expected,modules:['one','two','foreign']}},{expected:{...expected,originalModules:['foreign']}},{expected:{...expected,historyDigest:'0'.repeat(64)}}]){
  refused(()=>f.owner.prepareDiagnosisModuleCorrection(request(expected,extra)));assert.deepEqual(bytes(f.statePath),before);
 }
 const input=request(expected),receipt=f.owner.prepareDiagnosisModuleCorrection(input),prepared=bytes(f.statePath);
 refused(()=>f.owner.prepareDiagnosisModuleCorrection({...input,reason:'A different authorization'}));refused(()=>f.owner.prepareDiagnosisModuleCorrection({...input,expected:{...expected,modules:['two']}}));
 assert.deepEqual(bytes(f.statePath),prepared);assert.equal(f.workerCalls,0);assert(receipt.correctionDigest);
});

test('diagnosis module correction: omission-only refuses aligned and outside-module owner declarations and strict schema deletion',async t=>{
 for(const mode of ['aligned','outside']){
  const f=await fixture(t,{[mode]:true});api(f.owner);const before=bytes(f.statePath);
  refused(()=>f.owner.inspectDiagnosisModuleCorrection());refused(()=>f.owner.prepareDiagnosisModuleCorrection(request({})));assert.deepEqual(bytes(f.statePath),before);assert.equal(f.workerCalls,0);f.close();
 }
 const f=await fixture(t);api(f.owner);const expected=f.owner.inspectDiagnosisModuleCorrection();f.owner.prepareDiagnosisModuleCorrection(request(expected));
 const pkg=f.owner.causeReviewPackage(),relation=structuredClone(pkg.diagnosisModuleCorrection);
 relation.originalDiagnosis.affectedModules=['one','foreign'];relation.target.originalModules=['one','foreign'];relation.target.diagnosisDigest=digest(relation.originalDiagnosis);
 relation.correctionDigest=digest({target:relation.target,reason:relation.reason,previousInvocationStopped:relation.previousInvocationStopped});
 const {packageDigest,...body}=pkg,forged={...body,diagnosisModuleCorrection:relation};forged.packageDigest=digest(forged);
 assert.throws(()=>readFixCausePackage(forged),undefined,'A matching self-digest cannot authorize removing an originally declared outside module');
});

test('diagnosis module correction: live source bytes, mode and configuration target drift refuse without rewriting history',async t=>{
 const f=await fixture(t);api(f.owner);const expected=f.owner.inspectDiagnosisModuleCorrection(),before=bytes(f.statePath),file=path.join(f.cwd,'one/value.mjs'),old=bytes(file),mode=fs.statSync(file).mode&511;
 for(const change of ['bytes','mode','symlink']){
  if(change==='bytes')fs.appendFileSync(file,'\n// drift');else if(change==='mode')fs.chmodSync(file,mode^64);else{fs.renameSync(file,file+'.owned');fs.symlinkSync(file+'.owned',file);}
  refused(()=>f.owner.prepareDiagnosisModuleCorrection(request(expected)));assert.deepEqual(bytes(f.statePath),before);
  if(change==='symlink'){fs.unlinkSync(file);fs.renameSync(file+'.owned',file);}else{fs.writeFileSync(file,old);fs.chmodSync(file,mode);}
 }
 refused(()=>f.owner.prepareDiagnosisModuleCorrection(request({...expected,configurationDigest:'0'.repeat(64)})));assert.deepEqual(bytes(f.statePath),before);
 const input=request(expected);f.owner.prepareDiagnosisModuleCorrection(input);const prepared=bytes(f.statePath);fs.appendFileSync(file,'\n// after correction drift');
 refused(()=>f.owner.prepareDiagnosisModuleCorrection(input));assert.deepEqual(bytes(f.statePath),prepared);
});

test('diagnosis module correction: pending diagnosis and started review cannot authorize a correction or repeat it late',async t=>{
 const pending=await fixture(t,{waitingDiagnosis:true});
 try{api(pending.owner);const old=bytes(pending.statePath);refused(()=>pending.owner.inspectDiagnosisModuleCorrection());assert.deepEqual(bytes(pending.statePath),old);}
 finally{pending.releaseDiagnosis();await pending.advancement;pending.close();}
 const f=await fixture(t);api(f.owner);const expected=f.owner.inspectDiagnosisModuleCorrection(),input=request(expected);f.owner.prepareDiagnosisModuleCorrection(input);
 const pkg=f.owner.causeReviewPackage();await f.host.authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
 const reviewing=f.owner.reviewCause();for(let i=0;i<100&&!f.started;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(f.started,true);const started=bytes(f.statePath);
 refused(()=>f.owner.inspectDiagnosisModuleCorrection());refused(()=>f.owner.prepareDiagnosisModuleCorrection(input));assert.deepEqual(bytes(f.statePath),started);assert.equal(f.workerCalls,1);
 f.owner.cancel();await reviewing;const stopped=bytes(f.statePath);refused(()=>f.owner.prepareDiagnosisModuleCorrection(input));assert.deepEqual(bytes(f.statePath),stopped);
});

test('diagnosis module correction: actual stdio parser routes only the authorized existing host operation',async()=>{
 for(const allowed of [false,true]){
  let calls=0;const expected={owned:'sentinel'},owner={prepareDiagnosisModuleCorrection(input){calls++;need(input.authorized===true,'fix_diagnosis_module_correction_authorization_required');assert.deepEqual(input,{authorized:true,expected,previousInvocationStopped:true,reason:'Owned authority'});return {sentinel:'routed'};}};
  const host=createFixHost({owner,config:{},permissions:allowed?[FLAG]:[]}),out=output(),err=output();
  await serveCmAiHost({host,input:Readable.from([JSON.stringify({requestId:'route',operation:OP,expected,previousInvocationStopped:true,reason:'Owned authority'})+'\n']),output:out.stream,errorOutput:err.stream});
  const reply=out.value.trim().split('\n').map(JSON.parse).find(x=>x.requestId==='route');
  assert(reply,MARK+': stdio rejected the registered correction operation before routing');assert.equal(calls,1);
  if(allowed)assert.deepEqual(reply.result,{sentinel:'routed'});else{assert(reply.error);assert.match(err.value,/fix_diagnosis_module_correction_authorization_required/);}
 }
});

test('diagnosis module correction: actual CLI startup, driver and resumed owner preserve permissions and old prefix',async t=>{
 const f=await fixture(t);api(f.owner);const expected=f.owner.inspectDiagnosisModuleCorrection(),before=bytes(f.statePath),beforeState=parsed(f.statePath);f.close();
 const config=path.join(f.root,'config.json'),review=path.join(f.root,'review.json'),plan=path.join(f.root,'plan.json');const {hostContextId,causeReview,...stored}=f.configuration;
 fs.writeFileSync(config,JSON.stringify({...stored,specsRoot:f.specsRoot,identity:f.identity}));fs.writeFileSync(review,JSON.stringify(f.review));
 const cli=args=>spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000,env:{...process.env,CM_NOTIFY_DISABLED:'1'}});
 const base={config,cwd:f.cwd,mode:'resume',hostContext:hostContextId,runtime:'codex',reviewConfig:review,expected,previousInvocationStopped:true,reason:'Owned CLI module correction'};
 const drive=(permissions,extra={})=>{fs.writeFileSync(plan,JSON.stringify({...base,permissions,...extra}));return cli([DRIVER,'--plan',plan,OP]);};
 for(const [permissions,extra]of [[[],{}],[[FLAG],{mode:'create'}],[[FLAG],{previousInvocationStopped:false}]]){const r=drive(permissions,extra);assert.notEqual(r.status,0);assert.deepEqual(bytes(f.statePath),before);}
 const direct=cli([HOST,'serve','--config',config,'--mode','create','--host-context',hostContextId,'--allow-reproduction',FLAG,'--review-config',review]);assert.notEqual(direct.status,0);assert.deepEqual(bytes(f.statePath),before);
 const prepared=drive([FLAG]);assert.equal(prepared.status,0,MARK+': actual driver/host did not prepare correction: '+prepared.stdout+prepared.stderr);
 const after=parsed(f.statePath);assert.equal(after.records.length,beforeState.records.length+1);assert.deepEqual(after.records.slice(0,beforeState.records.length),beforeState.records);assert.deepEqual(after.fingerprints,beforeState.fingerprints);
 const raw=bytes(f.statePath),again=drive([FLAG]);assert.equal(again.status,0,again.stdout+again.stderr);assert.deepEqual(bytes(f.statePath),raw);
 const reopened=f.reopen();assert.equal(reopened.status().stage,'cause_review_required');assert.deepEqual(reopened.status().diagnosis.plan,f.diagnosis.plan);assert.equal(f.workerCalls,0);
});

test('diagnosis module correction: real owner retains relation through cause, author, repair, handoff and final package replay',async t=>{
 const f=await fixture(t,{lifecycle:true});api(f.owner);const before=parsed(f.statePath),expected=f.owner.inspectDiagnosisModuleCorrection(),input=request(expected),receipt=f.owner.prepareDiagnosisModuleCorrection(input);
 const cause=f.owner.causeReviewPackage(),relation=cause.diagnosisModuleCorrection;
 await f.host.authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:cause.packageDigest},new AbortController().signal);
 await f.owner.reviewCause();assert.equal(f.workerCalls,1);assert.equal(f.owner.status().causeReview.review.verdict,'approved');
 assert.equal(f.owner.status().stage,'test_author_required');assert.equal((await f.owner.authorTests({authorized:true})).stage,'red_test_required');
 assert.equal((await f.owner.runRedTest({authorized:true})).stage,'baseline_required');assert.equal((await f.owner.captureBaseline({authorized:true})).stage,'repair_required');
 assert.equal((await f.owner.repair({authorized:true})).stage,'regression_required');assert.equal((await f.owner.runRegression({authorized:true})).stage,'handoff_required');
 assert.equal((await f.owner.retrospect()).stage,'handoff_ready');assert.equal(f.owner.createHandoff().stage,'final_review_required');
 const pkg=f.owner.finalReviewPackage(),evidence=pkg.checks[0].evidence;
 assert.equal(typeof evidence,'string');assert(evidence.includes(JSON.stringify(relation)),'Final package must carry the exact structured relation in its existing bounded check evidence');
 assert(evidence.includes(f.diagnosis.plan));assert(evidence.includes(receipt.correctionDigest));assert(pkg.checks.every(c=>c.outcome==='passed'));
 const current=parsed(f.statePath),handoff=current.records.find(r=>r.id==='fix-handoff-intent');assert(handoff.payload.evidence.some(row=>typeof row==='string'&&row.includes(JSON.stringify(relation))));
 assert.deepEqual(current.records.slice(0,before.records.length),before.records);assert.deepEqual(current.fingerprints,before.fingerprints);
 assert.deepEqual(f.owner.status().originalDiagnosis,f.diagnosis);f.reopen();assert.equal(f.owner.status().stage,'final_review_required');assert.deepEqual(f.owner.finalReviewPackage(),pkg);assert.equal(f.workerCalls,1);
});

test('diagnosis module correction: joined host survives failed registration and source drift still blocks the first review',async t=>{
 const f=await fixture(t);api(f.owner);const expected=f.owner.inspectDiagnosisModuleCorrection(),receipt=f.owner.prepareDiagnosisModuleCorrection(request(expected));
 const prepared=parsed(f.statePath),hostContextId='owned-successor-host';let newWorkerCalls=0;
 const successor=createFixReviewHost({codeProject:f.cwd,hostContextId,review:f.review,permissions:['--allow-cause-review'],workerFactory:()=>async()=>{newWorkerCalls++;return {status:'failed',code:'must_not_execute'};}});
 f.reopen({hostContextId},successor.execution);const pkg=f.owner.causeReviewPackage();
 await successor.authority.hostDecisionProvider.decide({identity:f.identity,packageDigest:pkg.packageDigest},new AbortController().signal);
 const rename=fs.renameSync;let failedRegistration=0;
 const fault=t.mock.method(fs,'renameSync',(from,to)=>{
  if(to===f.statePath){const candidate=JSON.parse(fs.readFileSync(from,'utf8'));
   if(candidate.records.at(-1)?.id==='fix-cause-registered'){failedRegistration++;throw Object.assign(new Error('Owned registration disk fault'),{code:'EIO'});}}
  return rename(from,to);
 });
 try{await assert.rejects(()=>f.owner.reviewCause(),{code:'cause_authorization_invalid'});}finally{fault.mock.restore();}
 assert.equal(failedRegistration,1,'The real writer must reach exactly the registered atomic-state rename');
 const joined=parsed(f.statePath);assert.deepEqual(joined.records.slice(0,prepared.records.length),prepared.records);assert.deepEqual(joined.fingerprints,prepared.fingerprints);
 assert.equal(joined.records.length,prepared.records.length+1);assert.equal(joined.records.at(-1).id,'fix-host-joined-1');assert.equal(joined.records.at(-1).payload.hostContextId,hostContextId);
 assert.equal(joined.records.some(row=>row.id==='fix-cause-registered'),false);assert.equal(newWorkerCalls,0);assert.equal(f.workerCalls,0);
 f.reopen({hostContextId},successor.execution);assert.equal(f.owner.status().stage,'cause_review_required');
 fs.appendFileSync(path.join(f.cwd,'one/value.mjs'),'\n// source changed after the interrupted first registration');
 assert.equal(f.owner.status().stage,'diagnosis_module_correction_drift','A host-joined record cannot spend or disable the original source binding');
 const beforeRetry=bytes(f.statePath);f.reopen({hostContextId},successor.execution);assert.equal(f.owner.status().stage,'diagnosis_module_correction_drift');
 const stopped=await f.owner.reviewCause();assert.equal(stopped.stage,'diagnosis_module_correction_drift');assert.deepEqual(bytes(f.statePath),beforeRetry);
 assert.equal(newWorkerCalls,0);assert.equal(parsed(f.statePath).records.some(row=>row.id==='fix-cause-registered'),false);
 assert.equal(f.owner.status().diagnosisModuleCorrection.correctionDigest,receipt.correctionDigest);
 f.close();
 // A real grant can be valid while a trusted host callback changes the source
 // before registration. Candidate replay alone sees the old bound package;
 // the live preappend guard must still reject before persisting or running it.
 const g=await fixture(t);api(g.owner);g.owner.prepareDiagnosisModuleCorrection(request(g.owner.inspectDiagnosisModuleCorrection()));
 const original=g.host.execution.causeReview,originalPkg=g.owner.causeReviewPackage();
 await g.host.authority.hostDecisionProvider.decide({identity:g.identity,packageDigest:originalPkg.packageDigest},new AbortController().signal);
 let authorityChanges=0,callbackWorkerCalls=0;
 g.reopen({}, {causeReview:{...original,authorize(review,control){const grant=original.authorize(review,control);fs.appendFileSync(path.join(g.cwd,'one/value.mjs'),'\n// owned authorize callback drift');authorityChanges++;return grant;},async run(){callbackWorkerCalls++;return {status:'failed',code:'must_not_execute'};}}});
 const beforeAuthority=bytes(g.statePath);let rejected=null;
 try{await g.owner.reviewCause();}catch(error){rejected=error;}
 assert.equal(authorityChanges,1,'The actual authority must issue its grant before the owned drift');
 assert.equal(callbackWorkerCalls,0,'A valid grant does not authorize a source changed before append');assert.deepEqual(bytes(g.statePath),beforeAuthority);
 assert.equal(parsed(g.statePath).records.some(row=>row.id==='fix-cause-registered'),false);assert.equal(g.owner.status().stage,'diagnosis_module_correction_drift');
 if(rejected)assert.equal(rejected.code,'cause_authorization_invalid');
});
