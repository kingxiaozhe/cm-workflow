// Shared V3 grant and normalized observation contracts; no completion receipt issuer.
import {validateReviewDispatchGrant} from '../cm-ai/durable-runner-state.mjs';
import {inspectProviderCauseReview} from '../cm-ai/provider-review-observation.mjs';
import {digest,id,json,need,shape,text,hex} from '../cm-ai/effect-contract.mjs';

// A run outlives the session that created it. Its durable configuration keeps the
// original hostContextId, so stored records and fingerprints stay byte-identical;
// a resumed session declares its own next to it. Both are host identities: a grant
// may carry either, and the reviewer stays independent of both.
export function fixHostContexts(configuration){
  const hosts=configuration.hostContextIds??[configuration.hostContextId];
  need(Array.isArray(hosts)&&hosts.length>=1&&hosts.length<=2&&new Set(hosts).size===hosts.length
    &&hosts[0]===configuration.hostContextId,'invalid_host_context');
  hosts.forEach(id);return hosts;
}
export function validateCauseReviewer(raw,hostContextId,maxExclusions=32){
  const hosts=Array.isArray(hostContextId)?hostContextId:[hostContextId];
  need(hosts.length>=1&&hosts.length<=2,'invalid_cause_reviewer');hosts.forEach(id);
  need([32,33,34].includes(maxExclusions),'invalid_cause_reviewer');
  const value=json(raw);shape(value,['reviewerId','adapterId','provider','requestedModel','contextId','excludedThreadIds',
    ...(Object.hasOwn(value,'workerConfigurationDigest')?['workerConfigurationDigest']:[])]);
  if(Object.hasOwn(value,'workerConfigurationDigest'))hex(value.workerConfigurationDigest);
  for(const key of ['reviewerId','adapterId','contextId'])id(value[key]);text(value.requestedModel);
  need(['codex','claude'].includes(value.provider),'invalid_cause_reviewer');
  need(Array.isArray(value.excludedThreadIds)&&value.excludedThreadIds.length<=maxExclusions,'invalid_cause_reviewer');
  value.excludedThreadIds.forEach(id);need(!hosts.includes(value.contextId)&&!value.excludedThreadIds.includes(value.contextId),'invalid_cause_reviewer');
  return value;
}
export function causeExpectation(request,configuration){
  const hosts=fixHostContexts(configuration);
  return {request,developerThreadId:hosts[0],
    excludedThreadIds:[...configuration.causeReview.excludedThreadIds,...hosts.slice(1),request.contextId,
      ...(request.payload.reviewPackage.correction?.finalReview?[request.payload.reviewPackage.correction.finalReview.providerThreadId]:[])]};
}
export function inspectCauseRegistration(raw,configuration){
  const value=json(raw,5*1024*1024);shape(value,['request','authorizationAt','registeredAt','grant']);
  const r=configuration.causeReview,request=value.request;
  need(request.provider===r.provider&&request.requestedModel===r.requestedModel&&request.contextId===r.contextId,'cause_registration_mismatch');
  validateReviewDispatchGrant(value.grant,{request,reviewerId:r.reviewerId,adapterId:r.adapterId,
    packageDigest:request.payload.reviewPackage.packageDigest,hostContextIds:fixHostContexts(configuration),
    authorizationAt:value.authorizationAt,registeredAt:value.registeredAt});
  inspectProviderCauseReview(JSON.stringify({version:1,kind:'cm-provider-review-observation',
    requestDigest:request.requestDigest,events:[],result:{status:'failed',code:'in_progress'}}),
    JSON.stringify(causeExpectation(request,configuration)));
  return value;
}
export function inspectCauseResult(raw,registration,configuration,started){
  const value=json(raw,1024*1024);shape(value,['dispatchAt','observation']);
  need(Number.isSafeInteger(value.dispatchAt)&&value.dispatchAt>=registration.registeredAt
    &&value.dispatchAt<registration.grant.expiresAt,'cause_registration_mismatch');
  const result=inspectProviderCauseReview(JSON.stringify(value.observation),JSON.stringify(causeExpectation(registration.request,configuration)));
  need(result.providerThreadId===started,'cause_registration_mismatch');return result;
}
