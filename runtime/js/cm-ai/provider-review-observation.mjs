// Offline data inspection only: never authenticates, dispatches or grants completion.
import {digest,need,shape,id,text,hex,json,validIdentity} from './effect-contract.mjs';
import {readReviewPackage} from './review-package.mjs';
import {reviewResult,reviewResultForPaths} from './review-runner.mjs';
import {MAX_REVIEW_EXCLUSIONS} from './effect-contract.mjs';
import {readFixCausePackage,causeReviewPaths} from '../cm-fix/cause-package.mjs';

function decode(raw,limit) {
  need(typeof raw==='string');need(Buffer.byteLength(raw,'utf8')<=limit,'limit_exceeded');
  return json(JSON.parse(raw),limit);
}
function expectation(v,cause=false) {
  shape(v,['request','developerThreadId','excludedThreadIds']);
  id(v.developerThreadId);need(Array.isArray(v.excludedThreadIds)&&v.excludedThreadIds.length<=MAX_REVIEW_EXCLUSIONS);
  v.excludedThreadIds.forEach(id);
  const r=v.request;
  shape(r,['version','invocationId','identity','role','provider','requestedModel','contextId','payload','requestDigest']);
  need(r.version===1&&r.role==='reviewer'&&['codex','claude'].includes(r.provider));
  id(r.invocationId);id(r.contextId);validIdentity(r.identity);text(r.requestedModel);hex(r.requestDigest);
  const {requestDigest,...body}=r;need(digest(body)===requestDigest,'observation_binding');
  shape(r.payload,['reviewPackage','priorReview']);
  const pkg=(cause?readFixCausePackage:readReviewPackage)(r.payload.reviewPackage);
  if(cause)need(r.payload.priorReview===null,'observation_binding');
  need(digest(pkg.identity)===digest(r.identity),'observation_binding');
  return {request:r,pkg,excluded:new Set([v.developerThreadId,...v.excludedThreadIds])};
}
function eventStream(events,excluded) {
  need(Array.isArray(events)&&events.length<=64);
  let stage=0,thread=null,terminal=null,close=null,hasResult=false;
  for(const e of events) {
    need(close===null);
    if(e?.event==='process_closed') {
      shape(e,['event','exit_code','signal','timed_out']);
      need(e.exit_code===null||Number.isInteger(e.exit_code)&&e.exit_code>=-255&&e.exit_code<=255);
      need(e.signal===null||typeof e.signal==='string'&&e.signal.trim().length>0&&e.signal.length<=64);
      need(typeof e.timed_out==='boolean');close=e;continue;
    }
    need(terminal===null);
    if(e?.event==='thread.started') {
      shape(e,['event','provider_thread']);need(stage===0);id(e.provider_thread);
      need(!excluded.has(e.provider_thread),'observation_context');thread=e.provider_thread;stage=1;
    }else {
      shape(e,['event','item_type']);
      if(e.event==='turn.started'){need(stage===1&&e.item_type===null);stage=2;}
      else if(e.event==='item.completed'){need(stage===2&&e.item_type==='agent_message');stage=3;hasResult=true;}
      else if(e.event==='turn.completed'){need(stage===3&&e.item_type===null);terminal=e.event;}
      else {need(['error','turn.failed'].includes(e.event)&&e.item_type===null);terminal=e.event;}
    }
  }
  return {thread,terminal,close,hasResult};
}
// Reuse the validated normalized stream; a final message counts even if its
// value was truncated or the process never reached turn.completed.
export const hasProviderReviewResult=events=>eventStream(events,new Set()).hasResult;
export function inspectProviderReview(observationText,expectationText) {
  need(arguments.length===2);
  return inspect(observationText,expectationText,false);
}
export function inspectProviderCauseReview(observationText,expectationText){
  need(arguments.length===2);
  return inspect(observationText,expectationText,true);
}
function readObservation(observationText,expectationText,cause) {
  const observation=decode(observationText,1024*1024),expected=expectation(decode(expectationText,10*1024*1024),cause);
  shape(observation,['version','kind','requestDigest','events','result']);
  need(observation.version===1&&observation.kind==='cm-provider-review-observation');
  hex(observation.requestDigest);need(observation.requestDigest===expected.request.requestDigest,'observation_binding');
  const stream=eventStream(observation.events,expected.excluded),r=observation.result;
  if(r?.status==='succeeded')shape(r,['status','value']);
  else {shape(r,['status','code']);need(['failed','cancelled'].includes(r.status));text(r.code);need(r.code.length<=256);}
  return {observation,expected,...stream,r};
}
function inspect(observationText,expectationText,cause) {
  try {
    const {observation,expected,thread,terminal,close,r}=readObservation(observationText,expectationText,cause);
    let observationStatus='unknown',code='transport_incomplete',review=null;
    if(close?.timed_out===true||r.code==='timeout')code='transport_timeout';
    else if(r.status==='cancelled'||r.code==='cancelled'){observationStatus='cancelled';code='transport_cancelled';}
    else if(close?.exit_code===0&&close.signal===null&&terminal==='turn.completed'&&r.status==='succeeded'){
      review=cause?reviewResultForPaths(r.value,expected.pkg,causeReviewPaths(expected.pkg)):reviewResult(r.value,expected.pkg);
      observationStatus='completed';code=null;
    }
    return json({version:1,kind:cause?'cm-provider-cause-review-inspection':'cm-provider-review-inspection',requestDigest:expected.request.requestDigest,
      observationDigest:digest(observation),identity:expected.request.identity,logicalContextId:expected.request.contextId,
      provider:expected.request.provider,requestedModel:expected.request.requestedModel,effectiveModel:null,providerThreadId:thread,
      observationStatus,code,review,completionEligible:false});
  }catch(error){
    const allowed=['limit_exceeded','observation_binding','observation_context','invalid_package',
      'review_package_mismatch','missing_material','contradictory_verdict',
      'invalid_finding_path','invalid_finding_id','invalid_finding_severity','invalid_finding_shape'];
    const code=allowed.includes(error?.code)?error.code:'observation_invalid';
    throw Object.assign(new Error(code),{code});
  }
}

// A reviewer that ended without a usable verdict and broke no boundary may be
// dispatched once more; the class tells the user whether to log in or wait.
// Only these fixed worker codes qualify, and only with no final message and an
// observed process exit. Tool/context breaks, output limits, spawn or prompt
// failures and any other code stay unknown, as before.
export const REVIEWER_PROVIDER_FAILURES=Object.freeze({
  reviewer_auth_failed:'reviewer_auth_failed',reviewer_billing_error:'reviewer_billing_error',
  reviewer_rate_limited:'reviewer_rate_limited',reviewer_server_error:'reviewer_server_error',
  reviewer_model_not_found:'reviewer_model_not_found',reviewer_api_error:'reviewer_api_error',
  provider_failed:'reviewer_provider_failed',incomplete_result:'reviewer_exited',
  missing_init:'reviewer_stream_unrecognized',unexpected_event:'reviewer_stream_unrecognized',
  invalid_event:'reviewer_stream_unrecognized'});
// A complete answer that breaks the written verdict contract can never become a
// receipt. It is retried under the same budget and its exact code is kept.
export const REVIEWER_VERDICT_FAILURES=Object.freeze(['contradictory_verdict','invalid_finding_path',
  'invalid_finding_severity','invalid_finding_id','invalid_finding_shape','missing_material','review_package_mismatch']);
// Pure and deterministic: live classification and journal replay call it with
// the same bytes. Returns null for everything that is not such a failure.
export function inspectProviderReviewFailure(observationText,expectationText){
  need(arguments.length===2);
  let read;
  try{read=readObservation(observationText,expectationText,false);}catch{return null;}
  const {observation,expected,thread,terminal,close,hasResult,r}=read;
  if(close===null||close.timed_out||r.status==='cancelled'||['timeout','cancelled'].includes(r.code))return null;
  let category,failure;
  if(!hasResult){
    if(r.status!=='failed'||!Object.hasOwn(REVIEWER_PROVIDER_FAILURES,r.code))return null;
    category='provider';failure=REVIEWER_PROVIDER_FAILURES[r.code];
  }else{
    if(!(close.exit_code===0&&close.signal===null&&terminal==='turn.completed'&&r.status==='succeeded'))return null;
    try{reviewResult(r.value,expected.pkg);return null;}
    catch(error){if(!REVIEWER_VERDICT_FAILURES.includes(error?.code))return null;category='verdict';failure=error.code;}
  }
  return json({version:1,kind:'cm-provider-review-failure',requestDigest:expected.request.requestDigest,
    observationDigest:digest(observation),identity:expected.request.identity,logicalContextId:expected.request.contextId,
    provider:expected.request.provider,requestedModel:expected.request.requestedModel,providerThreadId:thread,
    category,failure,completionEligible:false});
}
