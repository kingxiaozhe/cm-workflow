// A bounded reviewer change for an explicit no-verdict capacity failure. The
// init configuration and all prior calls remain authoritative and unchanged.
import {digest,json,shape,need,hex,id,text} from './effect-contract.mjs';

const CODE='reviewer_switch_unavailable';
const same=(left,right)=>need(digest(left)===digest(right),CODE);
const reviewerKeys=['id','provider','requestedModel','adapterId','allowed','available','contexts'];
const basisKeys=['fromDigest','effectId','invocationId','requestDigest','packageDigest','attempt','sourceFailure','fromReviewerDigest',
  'hostContextId','sourceRevision'];

function readReviewer(raw){
  const value=json(raw);shape(value,reviewerKeys);
  [value.id,value.adapterId].forEach(id);text(value.requestedModel);
  need(value.requestedModel.length<=200&&value.allowed===true&&value.available===true,CODE);
  need(Array.isArray(value.contexts)&&value.contexts.length===2&&value.contexts[0]!==value.contexts[1],CODE);
  value.contexts.forEach(id);return value;
}

export function reviewerSwitchBasis({config,state,pending,transaction,reviewer,redispatches,maxRedispatches,switches=0,lastDigest,
  hostContextId,sourceRevision}){
  need(config?.controlPolicy?.version===2&&config.controlPolicy.development==='conversation'
    &&config.developer?.provider==='codex'&&config.developer.requestedModel==='current-session'&&config.reviewInvocation
    &&!config.bootstrap&&!config.parallelSelection&&!config.codeProjectPaths
    &&!config.externalModels&&!config.executionPolicy&&!config.binaryAssets,CODE);
  need(pending===null&&transaction===null&&switches===0,CODE);
  need(state?.attempt===2&&Array.isArray(config.excludedContexts)&&config.excludedContexts.length===1
    &&hostContextId===config.excludedContexts[0],CODE);
  id(hostContextId);hex(sourceRevision);
  need(Number.isInteger(redispatches)&&redispatches>=0&&Number.isInteger(maxRedispatches)
    &&maxRedispatches>0&&redispatches<maxRedispatches,'reviewer_switch_budget_exhausted');
  need(['pending_review','blocked'].includes(state?.state)&&state.code==='review_provider_failed'
    &&!state.cancellationRequested&&!state.cancelAfterCommit&&!state.workflowError,CODE);
  const original=readReviewer(reviewer);need(original.provider==='claude',CODE);
  need(config.reviewers?.length===1,CODE);same(config.reviewers[0],original);
  const entry=state.cache?.at(-1),invocation=state.reviewInvocation,result=invocation?.result;
  need(entry?.effect.kind==='review'&&entry.effect.identity.attempt===state.attempt
    &&['pending_review','blocked'].includes(entry.result?.state)&&entry.result.code==='review_provider_failed',CODE);
  need(result?.outcome==='failed'&&result.reconciliationRequired===false
    &&result.inspection?.kind==='cm-provider-review-failure'&&result.inspection.category==='provider'
    &&result.inspection.failure==='reviewer_rate_limited'&&result.inspection.completionEligible===false,CODE);
  const binding=invocation.registration?.binding,inspection=result.inspection;
  need(binding&&binding.identity.attempt===state.attempt&&state.reviewPackage?.identity.attempt===state.attempt,CODE);
  same(binding.identity,{...config.identity,attempt:state.attempt});same(state.reviewPackage.identity,binding.identity);
  need(binding.reviewerId===original.id&&binding.adapterId===original.adapterId
    &&binding.logicalContextId===original.contexts[state.attempt-1]
    &&binding.packageDigest===state.reviewPackage.packageDigest
    &&invocation.registration.requestDigest===binding.requestDigest,CODE);
  need(inspection.requestDigest===binding.requestDigest&&inspection.provider==='claude'
    &&inspection.requestedModel===original.requestedModel&&inspection.logicalContextId===binding.logicalContextId
    &&inspection.providerThreadId===invocation.started,CODE);
  same(inspection.identity,binding.identity);same(entry.result.reviewInvocation,invocation);
  const call=state.calls?.find(item=>item.invocationId===binding.invocationId);
  need(call?.terminal==='failed'&&call.channel==='host-review'&&call.provider==='claude'
    &&call.requestedModel===original.requestedModel&&call.contextId===binding.logicalContextId
    &&call.requestDigest===binding.requestDigest&&call.resultDigest===digest(result),CODE);
  need(!(state.receipts??[]).some(receipt=>receipt.identity?.attempt===state.attempt),CODE);
  hex(lastDigest);[binding.requestDigest,binding.packageDigest].forEach(hex);
  return json({fromDigest:lastDigest,effectId:entry.effect.id,invocationId:binding.invocationId,
    requestDigest:binding.requestDigest,packageDigest:binding.packageDigest,attempt:state.attempt,
    sourceFailure:'reviewer_rate_limited',fromReviewerDigest:digest(original),hostContextId,sourceRevision});
}

export function readReviewerSwitch(raw,context){
  const record=json(raw);shape(record,[...basisKeys,'toReviewer','configurationDigest','reason','at']);
  const basis=reviewerSwitchBasis(context);
  same(Object.fromEntries(basisKeys.map(key=>[key,record[key]])),basis);
  const target=readReviewer(record.toReviewer);
  need(target.provider==='codex'&&target.adapterId==='codex-review-adapter',CODE);
  same(target.contexts,context.reviewer.contexts);
  need(target.id===context.reviewer.id,CODE);
  hex(record.configurationDigest);text(record.reason);
  need(Buffer.byteLength(record.reason,'utf8')<=500&&!/[\r\n\0]/.test(record.reason),CODE);
  need(typeof record.at==='string'&&Number.isFinite(Date.parse(record.at))
    &&new Date(record.at).toISOString()===record.at,CODE);
  return record;
}

export function effectiveReviewer(original,record){
  return record===null||record===undefined?json(original):json(record.toReviewer);
}
