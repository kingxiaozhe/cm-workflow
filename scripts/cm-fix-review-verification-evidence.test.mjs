import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {createFixFinalReview,inspectFixFinalResult,fixFinalReviewConfiguration} from '../runtime/js/cm-fix/final-review.mjs';

import {inspectCauseResult} from '../runtime/js/cm-fix/cause-invocation.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {bindVerificationDiagnostic,verificationFailure} from '../runtime/js/cm-fix/review-verification-diagnostic.mjs';
const failedDiagnostic=request=>bindVerificationDiagnostic(verificationFailure({phase:'check',code:'review_verification_check_failed',checkId:'unit',result:{exitCode:1,outcome:'failed',output:'SYNTHETIC_PRIVATE_OUTPUT'}}),{request,configuration:verification,providerThreadId:'actual-review'});
import {captureReviewBaseline,createReviewPackage} from '../runtime/js/cm-ai/review-package.mjs';
import {createHostHandoff} from '../runtime/js/cm-ai/host-handoff.mjs';

function evidence(request){
  const pkg=request.payload.reviewPackage, file=pkg.files?.[0]??pkg.changes[0].after;
  const files=[{path:'value.mjs',sha256:file.sha256,mode:file.mode}];
  return {version:1,requestDigest:request.requestDigest,packageDigest:request.payload.reviewPackage.packageDigest,profileDigest:digest(verification),providerThreadId:'actual-review',files,snapshotDigest:digest(files),
    checks:[{id:'unit',commandDigest:digest(verification.checks[0].command),exitCode:0,outputSha256:'b'.repeat(64),startedAt:1,endedAt:2}],
    mutations:[{path:'value.mjs',beforeSha256:files[0].sha256,afterSha256:'c'.repeat(64),checkId:'unit',baselineExitCode:0,mutatedExitCode:1,restoredExitCode:0,restoredSha256:files[0].sha256,startedAt:3,endedAt:4}]};
}
const verification={files:['value.mjs'],checks:[{id:'unit',command:['node','--test','value.mjs']}],mutationPaths:['value.mjs'],timeoutMs:1000};
const reviewer={reviewerId:'cause-reviewer',adapterId:'claude-cause-review-adapter',provider:'claude',requestedModel:'synthetic',contextId:'fresh-review',excludedThreadIds:[]};

test('final review derivation preserves opt-in verification without changing old configuration',()=>{
  const old={hostContextId:'author',causeReview:reviewer};
  assert.equal(Object.hasOwn(fixFinalReviewConfiguration(old),'reviewVerification'),false);
  assert.deepEqual(fixFinalReviewConfiguration({...old,reviewVerification:verification}).reviewVerification,verification);
});

for(const mode of ['legacy','missing','valid','duplicate','tampered','failed','diagnosed','callback-thrown','bad-diagnostic'])test(`cause ${mode} result binds mechanical evidence and resume keeps configuration`,async()=>{
  const enabled=mode!=='legacy';
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-verification-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
  fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'verify-cause',taskId:'T-FIX-verify',attempt:1};
  const configuration={hostContextId:'author',defect:'Synthetic mismatch',causeReview:reviewer,
    reproduction:{cwd,command:[process.execPath,'-e',"process.stderr.write('BUG');process.exit(3)"],expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000},
    ...(enabled?{reviewVerification:verification}:{})};
  const authority=createHostReviewAuthority({hostContextId:'author',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
  let owner,calls=0,lateVerification,readinessCalls=0;
  const causeReview={authorize:authority.authorize,async run(request,{onEvent,onVerification}){
    calls++;
    for(const event of [{event:'thread.started',provider_thread:'actual-review'},{event:'turn.started',item_type:null},
      {event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
    lateVerification=onVerification;
    if(['valid','duplicate','tampered','callback-thrown'].includes(mode)){
      const proof=evidence(request);if(['tampered','callback-thrown'].includes(mode))proof.providerThreadId='wrong-thread';
      if(mode==='callback-thrown')onVerification(proof);
      try{onVerification(proof);if(mode==='duplicate')onVerification(proof);}catch{/* A misbehaving worker swallowing callback failures must not gain success. */}
    }
    if(mode==='failed')return {status:'failed',code:'timeout'};
    if(mode==='bad-diagnostic'){const d=failedDiagnostic(request);d.requestDigest='f'.repeat(64);return {status:'failed',code:'review_verification_evidence',verificationDiagnostic:d};}
    if(mode==='diagnosed')return {status:'failed',code:'review_verification_evidence',verificationDiagnostic:failedDiagnostic(request)};
    return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Synthetic'}};
  }};
  try{
    owner=openFixExecution({specsRoot,identity,configuration,create:true},{causeReview,assertReviewReady(pkg){readinessCalls++;if(pkg)assert.equal(pkg.kind,'cm-fix-cause-review-package');},bridge:{async call(){return {status:'diagnosed',rootCause:'Constant mismatch',plan:'Correct after red test',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};}}});
    await owner.advance({authorized:true});
    await authority.hostDecisionProvider.decide({identity,packageDigest:owner.causeReviewPackage().packageDigest},new AbortController().signal);
    const result=await owner.reviewCause();assert.equal(readinessCalls,enabled?2:1);
    if(['legacy','valid'].includes(mode))assert.equal(result.stage,'red_test_required');else assert.notEqual(result.stage,'red_test_required');
    if(lateVerification)assert.equal(lateVerification({}),false);
    owner.close();owner=null;
    if(mode==='valid'){
      assert.throws(()=>openFixExecution({specsRoot,identity,configuration:{...configuration,reviewVerification:{...verification,timeoutMs:2000}},create:false}),{code:'fingerprint_mismatch'});
      const legacy={...configuration};delete legacy.reviewVerification;
      assert.throws(()=>openFixExecution({specsRoot,identity,configuration:legacy,create:false}),{code:'fingerprint_mismatch'});
    }
    owner=openFixExecution({specsRoot,identity,configuration,create:false},{causeReview});
    assert.equal((await owner.reviewCause()).stage,result.stage);assert.equal(calls,1);
    const rows=JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'))).records;
    assert.equal(Object.hasOwn(rows[0].payload.configuration,'reviewVerification'),enabled);
    if(mode==='valid'){
      const registration=rows.find(r=>r.id==='fix-cause-registered').payload,value=rows.find(r=>r.id==='fix-cause-result').payload;
      assert.deepEqual(value.verification,evidence(registration.request));
      assert.equal(inspectCauseResult(value,registration,configuration,'actual-review').observationStatus,'completed');
      const missing=structuredClone(value);delete missing.verification;
      assert.throws(()=>inspectCauseResult(missing,registration,configuration,'actual-review'));
      const tampered=structuredClone(value);tampered.verification.packageDigest='f'.repeat(64);
      assert.throws(()=>inspectCauseResult(tampered,registration,configuration,'actual-review'),{code:'review_verification_binding'});
      assert.throws(()=>inspectCauseResult(value,registration,{...configuration,reviewVerification:undefined},'actual-review'),{code:'review_verification_invalid'});
    }
    if(['duplicate','tampered','callback-thrown'].includes(mode)){
      const value=rows.find(r=>r.id==='fix-cause-result')?.payload;assert(value,'callback rejection must be durable');
      assert.equal(value.observation.result.status,'failed');assert(!Object.hasOwn(value,'verification'));
      assert.equal(value.verificationDiagnostic.phase,'callback');
      assert.equal(value.verificationDiagnostic.code,mode==='duplicate'?'review_verification_invalid':'review_verification_binding');
      assert.equal(value.verificationDiagnostic.providerThreadId,'actual-review');
    }
    if(mode==='bad-diagnostic'){
      const value=rows.find(r=>r.id==='fix-cause-result')?.payload;assert(value,'invalid optional metadata must not erase a failed observation');
      assert.equal(value.observation.result.status,'failed');assert.equal(value.observation.result.code,'review_verification_evidence');
      assert.equal(value.verificationDiagnostic.code,'review_verification_binding');
      assert.equal(value.verificationDiagnostic.requestDigest,rows.find(r=>r.id==='fix-cause-registered').payload.request.requestDigest);
    }
    if(mode==='diagnosed'){
      const value=rows.find(r=>r.id==='fix-cause-result').payload;
      assert.equal(value.verificationDiagnostic.code,'review_verification_check_failed');
      assert.equal(value.observation.result.code,'review_verification_evidence');
      assert(!Object.hasOwn(value.observation.result,'verificationDiagnostic'));
      const registration=rows.find(r=>r.id==='fix-cause-registered').payload;
      const tampered=structuredClone(value);tampered.verificationDiagnostic.requestDigest='f'.repeat(64);
      assert.throws(()=>inspectCauseResult(tampered,registration,configuration,'actual-review'),{code:'review_verification_binding'});
    }
    if(!enabled)assert.equal(Object.hasOwn(rows.find(r=>r.id==='fix-cause-result').payload,'verification'),false);
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});

for(const mode of ['legacy','missing','valid','duplicate','tampered','failed','diagnosed','callback-thrown','bad-diagnostic'])test(`final ${mode} result retains original grant and binds execution evidence`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-final-verification-'))),cwd=path.join(root,'code');fs.mkdirSync(cwd);
  try{
    const identity={repositoryId:'fixture',runId:'verify-final',taskId:'T-FIX-verify',attempt:1};
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
    const baseline=captureReviewBaseline({root:cwd,identity,scope:['value.mjs'],requirements:['value.mjs']});
    fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');
    const checks=[{id:'unit',command:['synthetic-check'],outcome:'passed',exitCode:0,evidence:'Synthetic only'}];
    const handoffPath=path.join(root,'fix-verify-T-FIX-verify-a1-handoff.json');
    createHostHandoff({root:cwd,baseline,checks,handoffPath,evidence:['learning: no_relevant_lesson','learning: retrospective no_new_lesson']});
    const pkg=createReviewPackage({root:cwd,baseline,checks,handoffPath});
    const configuration=fixFinalReviewConfiguration({hostContextId:'author',causeReview:reviewer,...(mode==='legacy'?{}:{reviewVerification:verification})});
    const authority=createHostReviewAuthority({hostContextId:'author',reviewerId:configuration.reviewer.reviewerId,adapterId:configuration.reviewer.adapterId,decide:async()=>({status:'approved'})});
    await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
    let registration,lateVerification;
    const review=createFixFinalReview({reviewPackage:pkg,configuration,timeoutMs:1000},{authorize:authority.authorize,async run(request,{onEvent,onVerification}){
      for(const event of [{event:'thread.started',provider_thread:'actual-review'},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},
        {event:'turn.completed',item_type:null},{event:'process_closed',exit_code:0,signal:null,timed_out:false}])onEvent(event);
      lateVerification=onVerification;
      if(['valid','duplicate','tampered','callback-thrown'].includes(mode)){
        const proof=evidence(request);if(['tampered','callback-thrown'].includes(mode))proof.profileDigest='f'.repeat(64);
        if(mode==='callback-thrown')onVerification(proof);
        try{onVerification(proof);if(mode==='duplicate')onVerification(proof);}catch{}
      }
      if(mode==='failed')return {status:'failed',code:'timeout'};
      if(mode==='bad-diagnostic'){const d=failedDiagnostic(request);d.requestDigest='f'.repeat(64);return {status:'failed',code:'review_verification_evidence',verificationDiagnostic:d};}
    if(mode==='diagnosed')return {status:'failed',code:'review_verification_evidence',verificationDiagnostic:failedDiagnostic(request)};
      return {status:'succeeded',value:{verdict:'approved',packageDigest:pkg.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Synthetic only'}};
    }});
    const result=await review({signal:new AbortController().signal,register(value){registration=value;},onStarted(){}});
    if(['duplicate','tampered','callback-thrown'].includes(mode)){
      assert(result.value,'callback rejection must retain its failed observation');
      assert.equal(result.value.observation.result.status,'failed');assert(!Object.hasOwn(result.value,'verification'));
      assert.notEqual(result.inspection.observationStatus,'completed');
      assert.equal(result.value.verificationDiagnostic.phase,'callback');
      assert.equal(result.value.verificationDiagnostic.code,mode==='duplicate'?'review_verification_invalid':'review_verification_binding');
    }
    assert.equal(result.outcome,['valid','legacy','failed','diagnosed','duplicate','tampered','callback-thrown','bad-diagnostic'].includes(mode)?'observed':'unknown');
    if(lateVerification)assert.equal(lateVerification({}),false);
    if(mode==='valid'){
      assert.deepEqual(result.value.verification,evidence(registration.request));
      const missing=structuredClone(result.value);delete missing.verification;
      assert.throws(()=>inspectFixFinalResult(missing,registration,configuration,'actual-review'));
      const changed=structuredClone(result.value);changed.verification.requestDigest='f'.repeat(64);
      assert.throws(()=>inspectFixFinalResult(changed,registration,configuration,'actual-review'),{code:'review_verification_binding'});
      const legacy={...configuration};delete legacy.reviewVerification;
      assert.throws(()=>inspectFixFinalResult(result.value,registration,legacy,'actual-review'),{code:'review_verification_invalid'});
    }
    if(mode==='bad-diagnostic'){
      assert(result.value,'invalid optional metadata must not erase a failed observation');
      assert.equal(result.value.observation.result.status,'failed');assert.notEqual(result.inspection.observationStatus,'completed');
      assert.equal(result.value.verificationDiagnostic.code,'review_verification_binding');
      assert.equal(result.value.verificationDiagnostic.requestDigest,registration.request.requestDigest);
    }
    if(mode==='diagnosed'){
      assert.equal(result.value.verificationDiagnostic.code,'review_verification_check_failed');
      assert(!Object.hasOwn(result.value.observation.result,'verificationDiagnostic'));
      const changed=structuredClone(result.value);changed.verificationDiagnostic.providerThreadId='wrong-thread';
      assert.throws(()=>inspectFixFinalResult(changed,registration,configuration,'actual-review'),{code:'review_verification_binding'});
    }
    if(['legacy','failed'].includes(mode))assert.equal(Object.hasOwn(result.value,'verification'),false);
    if(mode==='failed')assert.notEqual(result.inspection.observationStatus,'completed');
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

for(const phase of ['cause','final'])for(const code of ['review_verification_package_binding','review_verification_source_drift','review_verification_sync_required'])
test(`${phase} package precheck rejects ${code} before any grant or registration`,async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'fix-package-precheck-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');
  fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);
  fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  fs.writeFileSync(path.join(cwd,'red.mjs'),"import {value} from './value.mjs';if(value!==2){console.error('BUG');process.exit(1)}");
  fs.writeFileSync(path.join(cwd,'existing.mjs'),"import {value} from './value.mjs';if(typeof value!=='number')process.exit(1)");
  const identity={repositoryId:'fixture',runId:'package-precheck',taskId:'T-FIX-verify',attempt:1};
  const configuration={hostContextId:'author',defect:'Wrong constant',causeReview:reviewer,reviewVerification:verification,
    reproduction:{cwd,command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    redTest:{cwd,testFiles:['red.mjs'],command:[process.execPath,'red.mjs'],expectedFailure:{exitCode:1,outputIncludes:'BUG'},timeoutMs:2000},
    baseline:{cwd,testFiles:['existing.mjs'],commands:[{id:'existing',command:[process.execPath,'existing.mjs']}],timeoutMs:2000},
    repair:{scope:['value.mjs'],requirements:['value.mjs']}};
  let grants=0,calls=0,owner,packages=0;
  const review={authorize(){grants++;throw Error('must not authorize');},async run(){calls++;throw Error('must not dispatch');}};
  const options={specsRoot,identity,configuration,create:true};
  const runtime={causeReview:review,finalReview:review,assertReviewReady(pkg){if(!pkg)return;packages++;
    assert.equal(pkg.kind,phase==='cause'?'cm-fix-cause-review-package':'cm-review-package');
    if(code==='review_verification_sync_required')return Promise.resolve();
    throw Object.assign(new Error(code),{code});
  },prepare:async()=>({contextDigest:digest([]),files:[],application:{contextDigest:digest([]),status:'no_relevant_lesson',summary:'No fixture instructions'}}),
    bridge:{async call(kind){
      if(kind==='fix_diagnose')return {status:'diagnosed',rootCause:'Wrong value',plan:'Correct value',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:phase==='cause',...(phase==='final'?{investigation:{discardedAlternatives:[],boundaryAnalysis:null}}:{})};
      if(kind==='fix_repair'){fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=2;');return {outcome:'repaired'};}
      if(kind==='fix_retrospective')return {status:'no_new_lesson',candidates:[],reason:null};
      throw Error(kind);
    }}};
  try{
    owner=openFixExecution(options,runtime);await owner.advance({authorized:true});
    if(phase==='final'){
      await owner.runRedTest({authorized:true});await owner.captureBaseline({authorized:true});await owner.repair({authorized:true});await owner.runRegression({authorized:true});await owner.retrospect();owner.createHandoff();
    }
    assert.equal(owner.status().stage,phase==='cause'?'cause_review_required':'final_review_required');
    const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json'),before=fs.readFileSync(statePath);
    await assert.rejects(phase==='cause'?owner.reviewCause():owner.reviewFinal(),{code});
    assert.equal(grants,0);assert.equal(calls,0);assert.equal(packages,1);
    assert.deepEqual(fs.readFileSync(statePath),before);
    assert.equal(JSON.parse(before).records.filter(r=>r.id.includes(phase)&&r.id.endsWith('-registered')).length,0);
    owner.close();owner=openFixExecution({...options,create:false},runtime);
    await assert.rejects(phase==='cause'?owner.reviewCause():owner.reviewFinal(),{code});
    assert.deepEqual(fs.readFileSync(statePath),before);assert.equal(grants,0);
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
});
