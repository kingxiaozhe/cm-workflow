// Shared V3 grant and normalized observation contracts; no completion receipt issuer.
import {validateReviewDispatchGrant} from '../cm-ai/durable-runner-state.mjs';
import {inspectProviderCauseReview} from '../cm-ai/provider-review-observation.mjs';
import {digest,id,json,need,shape,text,hex} from '../cm-ai/effect-contract.mjs';

export function validateCauseReviewer(raw,hostContextId,maxExclusions=32){
  need([32,33,34].includes(maxExclusions),'invalid_cause_reviewer');
  const value=json(raw);shape(value,['reviewerId','adapterId','provider','requestedModel','contextId','excludedThreadIds',
    ...(Object.hasOwn(value,'workerConfigurationDigest')?['workerConfigurationDigest']:[])]);
  if(Object.hasOwn(value,'workerConfigurationDigest'))hex(value.workerConfigurationDigest);
  for(const key of ['reviewerId','adapterId','contextId'])id(value[key]);text(value.requestedModel);
  need(['codex','claude'].includes(value.provider),'invalid_cause_reviewer');
  need(Array.isArray(value.excludedThreadIds)&&value.excludedThreadIds.length<=maxExclusions,'invalid_cause_reviewer');
  value.excludedThreadIds.forEach(id);need(value.contextId!==hostContextId&&!value.excludedThreadIds.includes(value.contextId),'invalid_cause_reviewer');
  return value;
}
export function causeExpectation(request,configuration){
  return {request,developerThreadId:configuration.hostContextId,
    excludedThreadIds:[...configuration.causeReview.excludedThreadIds,request.contextId,
      ...(request.payload.reviewPackage.correction?.finalReview?[request.payload.reviewPackage.correction.finalReview.providerThreadId]:[])]};
}
export function inspectCauseRegistration(raw,configuration){
  const value=json(raw,5*1024*1024);shape(value,['request','authorizationAt','registeredAt','grant']);
  const r=configuration.causeReview,request=value.request;
  need(request.provider===r.provider&&request.requestedModel===r.requestedModel&&request.contextId===r.contextId,'cause_registration_mismatch');
  validateReviewDispatchGrant(value.grant,{request,reviewerId:r.reviewerId,adapterId:r.adapterId,
    packageDigest:request.payload.reviewPackage.packageDigest,hostContextIds:[configuration.hostContextId],
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
