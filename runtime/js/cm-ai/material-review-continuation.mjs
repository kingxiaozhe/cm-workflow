// A separately authorized opportunity, never a refund or automatic retry.
// Pure live/replay predicates. The original owner lock controls registration.
import {REVIEW_MATERIAL_BATCH_PROFILE} from './review-material.mjs';
import {digest,need,shape,hex,validIdentity,id} from './effect-contract.mjs';
export const MATERIAL_CONTINUATION_EFFECT='review-2-material-continuation-1-correction-1';
export const MATERIAL_TIMEOUT_EFFECT='review-2-material-batch-1-correction-1';
export function readMaterialContinuationSource(source,timeout=false){
 shape(source,['identity','hostContextId','revision','invocationId','requestDigest','packageDigest','fingerprints',...(timeout?['transportProfileDigest']:[])]);
 if(timeout){hex(source.transportProfileDigest);need(source.transportProfileDigest===digest(REVIEW_MATERIAL_BATCH_PROFILE),'material_timeout_transport_changed');}
 validIdentity(source.identity);id(source.hostContextId);id(source.invocationId);
 for(const key of ['revision','requestDigest','packageDigest'])hex(source[key]);
 shape(source.fingerprints,['workflow','config','inputs']);Object.values(source.fingerprints).forEach(hex);
 return source;
}
export function materialContinuationBinding(records,s,config,original,correction,timeout=false){
 const invocation=s.reviewInvocation,entry=s.cache.at(-1),call=s.calls.at(-1);
 need(correction?.epoch===1&&correction.materialReview?.consumed===true
  &&(timeout?correction.materialContinuation?.consumed===true&&!correction.materialTimeoutContinuation
    &&s.state==='blocked'&&s.code==='review_transport_timeout'
    &&entry?.effect.id===correction.materialContinuation.effectId&&entry.result.state==='blocked'
    &&invocation?.result?.outcome==='timed_out'&&invocation.result.reconciliationRequired===false
    &&invocation.result.observation?.result?.status==='failed'&&invocation.result.observation.result.code==='timeout'
    &&invocation.result.observation.events.some(e=>e.event==='process_closed'&&e.timed_out===true)
    &&!invocation.result.observation.events.some(e=>e.event==='turn.completed'||e.event==='item.completed')
    &&call?.terminal==='failed'
   :!correction.materialContinuation&&s.state==='unknown'&&s.code==='transport_incomplete'
    &&entry?.effect.id===correction.materialReview.effectId&&entry.result.state==='unknown'
    &&invocation?.result?.outcome==='unknown'&&invocation.result.observation?.result?.status==='failed'
    &&invocation.result.observation.result.code==='review_material_incomplete'&&call?.terminal==='unknown')
  &&s.attempt===2&&s.calls.length===(timeout?12:11)&&s.sequence===s.calls.length
  &&invocation.result.inspection?.review===null
  &&call.invocationId===invocation.registration?.binding?.invocationId
  &&s.receipt===null&&s.receipts.length===3&&s.receipts.every(r=>r.result.verdict==='blocked')
  &&config.controlPolicy?.version===2&&config.controlPolicy.development==='conversation'
  &&config.controlPolicy.bootstrap==='disabled'&&config.controlPolicy.qaFix==='disabled'
  &&!config.bootstrap&&!config.parallelSelection&&!config.codeProjectPaths&&!config.binaryAssets
  &&!config.externalModels&&!config.executionPolicy&&config.developer.provider==='codex'
  &&config.developer.requestedModel==='current-session'&&config.reviewers.length===1&&config.reviewers[0].provider==='codex'
  &&!s.taskCommit&&!s.cancellationRequested&&!s.cancelAfterCommit&&!s.workflowError,'material_continuation_unavailable');
 const binding=invocation.registration.binding;
 need(binding.packageDigest===s.reviewPackage?.packageDigest&&binding.requestDigest===call.requestDigest
  &&binding.identity.taskId===config.identity.taskId&&binding.identity.attempt===2,'material_continuation_binding');
 const fingerprints=config.completion.fingerprints;
 const revision=digest({version:1,identity:{repositoryId:config.identity.repositoryId,runId:config.identity.runId},fingerprints,records});
 const source=readMaterialContinuationSource({identity:binding.identity,hostContextId:binding.hostContextId,
  invocationId:binding.invocationId,requestDigest:binding.requestDigest,packageDigest:binding.packageDigest,revision,fingerprints,...(timeout?{transportProfileDigest:digest(REVIEW_MATERIAL_BATCH_PROFILE)}:{})},timeout);
 return {source,failedCheckpointDigest:digest(entry),failedResultDigest:digest(invocation.result),
  configDigest:digest(config),baselineDigest:original.baselineDigest,scopeDigest:digest(config.scope),
  materialGrantDigest:correction.materialReview.recordDigest,...(timeout?{priorContinuationDigest:correction.materialContinuation.recordDigest}:{}),reviewEffectId:timeout?MATERIAL_TIMEOUT_EFFECT:MATERIAL_CONTINUATION_EFFECT};
}
export function applyMaterialContinuation(records,s,config,original,correction,record,timeout=false){
 const expected=materialContinuationBinding(records,s,config,original,correction,timeout);
 for(const key of Object.keys(expected))need(digest(expected[key])===digest(record[key]),'material_continuation_binding');
 need(record.oldInvocationStopped===true,'material_continuation_stop_confirmation');
 need(typeof record.reason==='string'&&record.reason.trim()&&Buffer.byteLength(record.reason)<=500
  &&!/[\r\n\0]/.test(record.reason),'material_continuation_reason');
 need(typeof record.at==='string'&&new Date(record.at).toISOString()===record.at,'material_continuation_binding');
 return {...s,state:'awaiting_review',code:null,reason:null,reviewInvocation:null};
}
