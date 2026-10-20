import {planBytes} from '../../runtime/js/cm-ai/task-commit-codec.mjs';
import {prepareMarkDone,verifyMarkDonePlan} from '../cm-task-gate.mjs';
import {nativeCorrectionPaths} from '../../runtime/js/cm-ai/native-correction-publication.mjs';
import {prepareCodexReviewInput} from '../../runtime/js/cm-ai/codex-review-adapter.mjs';
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {digest} from '../../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,effectSlotFree} from '../../runtime/js/cm-ai/durable-runner-state.mjs';
import {strictProviderFailure,providerRecoverySource,providerFailedRequest,PROVIDER_RECOVERY_EFFECT} from '../../runtime/js/cm-ai/provider-review-recovery.mjs';
import {openExecutionStore} from '../../runtime/js/cm-ai/execution-store.mjs';
export function exerciseProviderRecovery(context){
 const {f,drive,read,state,frozen}=context,failed=read(),failure=readRunnerHistory(failed.records,failed.records[0].payload.config,3),before=fs.readFileSync(state);
 assert(strictProviderFailure(failure.state.reviewInvocation.result));
 assert.equal(failure.evidenceContinuation.consumed,true);
 assert(failure.state.reviewInvocation.result.observation.events.some(e=>e.diagnostic),'safe native failure diagnostic survives actual owner persistence');
 const shown=drive('status'),source=shown.value.providerReviewRecovery?.source;assert(source,'closed native provider failure must expose separately authorized recovery source');
 assert.equal(source.revision,failed.revision);
 const cfg={...failed.records[0].payload.config,scope:failure.effectiveScope};
 const rejectState=s=>assert.throws(()=>providerRecoverySource(failed.records,s,cfg,failure.original,failure.nativeCorrection,failure.evidenceContinuation));
 const original=failure.state.reviewInvocation.result;
 for(const code of ['invalid_event','unexpected_event','missing_init','incomplete_result','process_cleanup_unknown','timeout']){
  const result={...original,observation:{...original.observation,result:{status:'failed',code}}};
  rejectState({...failure.state,reviewInvocation:{...failure.state.reviewInvocation,result}});
 }
 for(const verdict of ['approved','blocked','changes_requested'])rejectState({...failure.state,receipt:{result:{verdict}}});
 for(const events of [original.observation.events.slice(1),original.observation.events.filter(e=>e.event!=='turn.started'),
  original.observation.events.filter(e=>!['error','turn.failed'].includes(e.event)),original.observation.events.map(e=>e.event==='process_closed'?{...e,timed_out:true}:e),
  [...original.observation.events.slice(0,2),{event:'item.completed',item_type:'agent_message'},...original.observation.events.slice(2)]]){
  assert.equal(strictProviderFailure({...original,observation:{...original.observation,events}}),false);
 }
 assert.equal(strictProviderFailure({...original,observation:{...original.observation,events:original.observation.events.map(({diagnostic,...e})=>e)}}),true,'legacy no-diagnostic remains eligible');
 const file=path.join(f.root,'provider-recovery.json'),value={version:1,reason:'Separate authority for one new provider recovery review; no development',providerReviewRecovery:true,source,oldInvocationStopped:true};
 const register=(v=value,target=shown.value.launchControlTarget)=>{fs.writeFileSync(file,JSON.stringify(v));return drive('status',{evidenceRequestFile:file,target});};
 const request=providerFailedRequest(failure.state,cfg),manifest=prepareCodexReviewInput(request).material.manifest,thread=failure.state.reviewInvocation.started;
 const proofBody={version:2,kind:'cm-review-material-evidence',manifest,manifestDigest:digest(manifest),requestDigest:request.requestDigest,
  packageDigest:manifest.packageDigest,promptSha256:manifest.promptSha256,promptBytes:manifest.promptBytes,providerThreadId:thread,
  callCount:Math.ceil(manifest.pageCount/8),pageReadCount:manifest.pageCount,pages:manifest.pages};
 const processClosed={event:'process_closed',exit_code:0,signal:null,timed_out:false},proof={...proofBody,evidenceDigest:digest(proofBody)};
 const contradictoryBody={version:1,kind:'cm-review-material-result',invocationId:request.invocationId,identity:request.identity,
  requestDigest:request.requestDigest,packageDigest:manifest.packageDigest,manifestDigest:digest(manifest),providerThreadId:thread,proof,
  result:{verdict:'approved',packageDigest:source.packageDigest,examinedPaths:[...new Set([...request.payload.reviewPackage.changes.map(c=>c.path),...request.payload.reviewPackage.requirements.map(c=>c.path),...(request.payload.reviewPackage.unchangedScope??[]).map(c=>c.path)])].sort(),findings:[],summary:'Synthetic contradictory same-call success; never owner acceptance'},
  processClosed,events:[{event:'thread.started',provider_thread:thread},{event:'turn.started',item_type:null},{event:'item.completed',item_type:'agent_message'},{event:'turn.completed',item_type:null},processClosed],ownerAccepted:false};
 const conflictFile=path.join(f.specsDir,'.reviews','material-result-'+digest({request:request.requestDigest,thread})+'.json'),conflictBytes=Buffer.from(JSON.stringify({...contradictoryBody,resultArtifactDigest:digest(contradictoryBody)})+'\n');
 fs.writeFileSync(conflictFile,conflictBytes,{flag:'wx',mode:0o600});
 const conflict=drive('status');assert.equal(conflict.value.code,'provider_recovery_result_conflict');assert.equal(conflict.value.providerReviewRecovery.source,null);
 assert.notEqual(conflict.value.reviewReconciliation?.available,true);assert.notEqual(register().status,0);assert.deepEqual(fs.readFileSync(state),before);
 fs.renameSync(conflictFile,path.join(f.root,'synthetic-conflicting-saved-result-before-grant.json'));
 assert.notEqual(drive('decision',{packageDigest:source.packageDigest}).value?.state,'approved');assert.deepEqual(fs.readFileSync(state),before);
 assert.notEqual(register(value,{...shown.value.launchControlTarget,revision:'0'.repeat(64)}).status,0);assert.deepEqual(fs.readFileSync(state),before);
 for(const key of Object.keys(source)){
  const v=source[key];const changed=typeof v==='string'?(v.length===64?'0'.repeat(64):'wrong-source'):key==='identity'?{...v,taskId:'T-wrong'}:{...v,config:'0'.repeat(64)};
  assert.notEqual(register({...value,source:{...source,[key]:changed}}).status,0,key);assert.deepEqual(fs.readFileSync(state),before);
 }
 assert.notEqual(register({...value,oldInvocationStopped:false}).status,0);assert.deepEqual(fs.readFileSync(state),before);
 const code=path.join(f.codeProject,'target.mjs'),bytes=fs.readFileSync(code);fs.appendFileSync(code,'// drift\n');assert.notEqual(register().status,0);assert.deepEqual(fs.readFileSync(state),before);fs.writeFileSync(code,bytes);
 const writer=openExecutionStore({specsRoot:f.specsDir,identity:failed.identity,fingerprints:failed.fingerprints,create:false});
 try{assert.notEqual(register().status,0);assert.deepEqual(fs.readFileSync(state),before);}finally{writer.close();}
 const grant=register();assert.equal(grant.status,0,grant.stderr);assert.equal(grant.value.state,'awaiting_review');
 const authorized=read(),a=readRunnerHistory(authorized.records,failed.records[0].payload.config,3);assert.equal(a.state.calls.length,failure.state.calls.length,'authorization never dispatches');
 assert.deepEqual(authorized.records.slice(0,failed.records.length),failed.records);assert.equal(authorized.records.length,failed.records.length+1);
 assert.deepEqual(a.evidenceContinuation,failure.evidenceContinuation);assert.deepEqual(a.nativeCorrection,failure.nativeCorrection);
 const grantedBytes=fs.readFileSync(state);assert.equal(register().status,0,'exact duplicate idempotent');assert.deepEqual(fs.readFileSync(state),grantedBytes);
 assert.notEqual(register({...value,reason:'different authority'}).status,0);assert.deepEqual(fs.readFileSync(state),grantedBytes);
 fs.writeFileSync(conflictFile,conflictBytes,{flag:'wx',mode:0o600});
 assert.equal(drive('status').value.code,'provider_recovery_result_conflict');
 assert.notEqual(drive('decision',{packageDigest:source.packageDigest}).value?.state,'approved');assert.deepEqual(fs.readFileSync(state),grantedBytes,'conflicting saved success after grant cannot create intent');
 fs.renameSync(conflictFile,path.join(f.root,'synthetic-conflicting-saved-result-after-grant.json'));
 const archive=fs.mkdtempSync(path.join(f.root,'provider-recovery-results-'));process.stderr.write('[provider recovery archive] '+archive+'\n');
 const tasks=path.join(f.specsDir,'1.work/tasks.md'),taskBytes=fs.readFileSync(tasks);
 for(const verdict of ['provider_failed','blocked','changes_requested','approved']){
  fs.writeFileSync(path.join(f.root,'evidence-verdict.json'),JSON.stringify(verdict));
  const result=drive('decision',{packageDigest:source.packageDigest}),snapshot=read(),h=readRunnerHistory(snapshot.records,failed.records[0].payload.config,3);
  assert.equal(h.state.calls.length,failure.state.calls.length+1,result.stderr+' '+JSON.stringify(result.value));
  assert.deepEqual(h.state.calls.slice(0,failure.state.calls.length),failure.state.calls);assert.deepEqual(h.nativeCorrection,failure.nativeCorrection);assert.deepEqual(h.evidenceContinuation,failure.evidenceContinuation);
  assert.equal(h.providerRecovery.consumed,true);assert.equal(h.state.cache.at(-1).effect.id,PROVIDER_RECOVERY_EFFECT);assert.equal(h.state.reviewPackage.packageDigest,source.packageDigest);
  assert.notEqual(h.state.calls.at(-1).providerThreadId,failure.state.calls.at(-1).providerThreadId);
  assert.equal(effectSlotFree('develop',h.state.cache,h.state.calls,[],null,'develop',h.state,h.nativeCorrection,h.evidenceContinuation,h.providerRecovery),false);
  assert.equal(effectSlotFree('review',h.state.cache,h.state.calls,[],null,PROVIDER_RECOVERY_EFFECT,h.state,h.nativeCorrection,h.evidenceContinuation,h.providerRecovery),false);
  fs.writeFileSync(path.join(f.root,'provider-'+verdict+'-before-crash.json'),JSON.stringify(snapshot)+'\n',{mode:0o600});
  const intent=snapshot.records.findLastIndex(r=>r.payload.type==='effect-intent');
  for(const end of [intent+1,...snapshot.records.map((r,i)=>['review-invocation-registered','review-invocation-started','review-invocation-result','effect-checkpoint'].includes(r.payload.type)&&i>intent?i+1:null).filter(Boolean)]){
   const prefix=snapshot.records.slice(0,end),p=readRunnerHistory(prefix,failed.records[0].payload.config,3);assert.equal(p.providerRecovery.consumed,true,'all crash prefixes consume same single slot');
   if(prefix.at(-1).payload.type==='review-invocation-started')for(const previous of new Set(failure.state.calls.map(c=>c.providerThreadId).filter(v=>typeof v==='string'))){
    const altered=structuredClone(prefix),last=altered.at(-1);last.payload.providerThreadId=previous;const {digest:oldDigest,...body}=last;last.digest=digest(body);
    assert.throws(()=>readRunnerHistory(altered,failed.records[0].payload.config,3),'new recovery rejects every previous provider thread');
   }

   if(end===snapshot.records.length)continue;
   const {revision,...body}=snapshot,partial={...body,records:prefix};partial.revision=digest(partial);fs.writeFileSync(state,JSON.stringify(partial)+'\n');
   const recovered=drive('status');assert(recovered.value&&recovered.value.outcome==='reported',recovered.stderr);
   assert.equal(recovered.status,recovered.value.state==='unknown'?1:0,recovered.stderr);
   assert.equal(readRunnerHistory(read().records,failed.records[0].payload.config,3).providerRecovery.consumed,true);
   fs.writeFileSync(state,JSON.stringify(snapshot)+'\n');
  }
  const status=drive('status');assert.equal(status.value.providerReviewRecovery.source,null);
  if(verdict==='provider_failed')assert.equal(status.value.code,'provider_review_recovery_exhausted');
  else assert.equal(h.state.receipt.result.verdict,verdict);
  const used=fs.readFileSync(state);assert.notEqual(register(value,status.value.launchControlTarget).status,0);assert.deepEqual(fs.readFileSync(state),used);
  if(verdict==='approved'){
   verifyProviderCompletion({f,snapshot});
   assert.equal(result.value.state,'approved',result.stderr);
   const complete=drive('complete',{packageDigest:source.packageDigest});assert.equal(complete.status,0,complete.stderr);assert.equal(complete.value.state,'fixture_completed',JSON.stringify(complete.value));
   const qa=drive('advance');assert.equal(qa.status,0,qa.stderr);assert.match(fs.readFileSync(tasks,'utf8'),/^- \[x\] T-001/m);
   const logs=fs.readFileSync(path.join(f.specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(logs.filter(r=>r.node==='N6'&&r.event==='test_run'&&r.phase==='complete'&&r.result==='PASS').length,1);
  }else{
   assert.notEqual(drive('complete',{packageDigest:source.packageDigest}).value?.state,'fixture_completed');assert.deepEqual(fs.readFileSync(tasks),taskBytes);
  }
  const target=path.join(archive,verdict);fs.mkdirSync(target,{mode:0o700});fs.writeFileSync(path.join(target,'state.json'),fs.readFileSync(state));
  for(const suffix of ['.md','-receipt.json']){
   const file=path.join(f.specsDir,'.reviews','work-T-001-native-correction-1-provider-recovery-1'+suffix);
   if(fs.existsSync(file)){fs.copyFileSync(file,path.join(target,path.basename(file)));if(verdict!=='approved')fs.renameSync(file,path.join(target,'inactive-'+path.basename(file)));}
  }
  for(const {p,bytes}of frozen)assert.deepEqual(fs.readFileSync(p),bytes);
  process.stderr.write(`[provider recovery scenario] ${verdict}: original calls and consumed grants retained; one new fresh review; full original package\n`);
  if(verdict!=='approved')fs.writeFileSync(state,grantedBytes);
 }
}

export function verifyProviderCompletion({f,snapshot}){
 const cfg=snapshot.records[0].payload.config,h=readRunnerHistory(snapshot.records,cfg,3),task=cfg.identity.taskId,feature=cfg.taskLearning.feature.replace(/^\d+\./,'');
 const paths=nativeCorrectionPaths(cfg.completion.reviewsDir,feature,task,true,true,true),old=nativeCorrectionPaths(cfg.completion.reviewsDir,feature,task),material=nativeCorrectionPaths(cfg.completion.reviewsDir,feature,task,true);
 const selectors={handoff:paths.handoff,reviewsDir:cfg.completion.reviewsDir,tasksPath:cfg.completion.owner.tasksPath,feature,task,attempt:2,projectRoot:f.codeProject,correction:1};
 assert.equal(h.state.receipt.result.verdict,'approved');
 const plan=prepareMarkDone(selectors);planBytes(plan);const pinned=new Set(plan.evidence.map(e=>e.path));assert.equal(plan.evidence.length,12,'reuse the existing twelve fixed evidence pins');
 for(const file of [paths.review,paths.receipt,old.review,old.receipt,material.review,material.receipt])assert(pinned.has(file),'new accepted receipt and all original native/material evidence pinned');
 const bytes=fs.readFileSync(paths.receipt),changed={...JSON.parse(bytes),receiptDigest:'0'.repeat(64)};
 try{fs.writeFileSync(paths.receipt,JSON.stringify(changed)+'\n');assert.throws(()=>prepareMarkDone(selectors),'a changed accepted receipt cannot prepare completion');}
 finally{fs.writeFileSync(paths.receipt,bytes);}
 assert.throws(()=>verifyMarkDonePlan(selectors,plan.planDigest),'receipt file revision changes invalidate the previous plan even after restoring bytes');
 assert.equal(prepareMarkDone(selectors).evidence.length,12);
 process.stderr.write('[provider preparation] twelve fixed evidence pins and accepted receipt binding verified\n');
}
