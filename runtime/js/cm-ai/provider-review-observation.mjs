// Offline data inspection only: never authenticates, dispatches or grants completion.
import {digest,need,shape,id,text,hex,json,validIdentity} from './effect-contract.mjs';
import {readReviewPackage} from './review-package.mjs';
import {reviewResult} from './review-runner.mjs';

function decode(raw,limit) {
  need(typeof raw==='string');need(Buffer.byteLength(raw,'utf8')<=limit,'limit_exceeded');
  return json(JSON.parse(raw),limit);
}
function expectation(v) {
  shape(v,['request','developerThreadId','excludedThreadIds']);
  id(v.developerThreadId);need(Array.isArray(v.excludedThreadIds)&&v.excludedThreadIds.length<=32);
  v.excludedThreadIds.forEach(id);
  const r=v.request;
  shape(r,['version','invocationId','identity','role','provider','requestedModel','contextId','payload','requestDigest']);
  need(r.version===1&&r.role==='reviewer'&&r.provider==='codex');
  id(r.invocationId);id(r.contextId);validIdentity(r.identity);text(r.requestedModel);hex(r.requestDigest);
  const {requestDigest,...body}=r;need(digest(body)===requestDigest,'observation_binding');
  shape(r.payload,['reviewPackage','priorReview']);
  const pkg=readReviewPackage(r.payload.reviewPackage);
  need(digest(pkg.identity)===digest(r.identity),'observation_binding');
  return {request:r,pkg,excluded:new Set([v.developerThreadId,...v.excludedThreadIds])};
}
function eventStream(events,excluded) {
  need(Array.isArray(events)&&events.length<=64);
  let stage=0,thread=null,terminal=null,close=null;
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
      else if(e.event==='item.completed'){need(stage===2&&e.item_type==='agent_message');stage=3;}
      else if(e.event==='turn.completed'){need(stage===3&&e.item_type===null);terminal=e.event;}
      else {need(['error','turn.failed'].includes(e.event)&&e.item_type===null);terminal=e.event;}
    }
  }
  return {thread,terminal,close};
}
export function inspectProviderReview(observationText,expectationText) {
  try {
    need(arguments.length===2);
    const observation=decode(observationText,1024*1024),expected=expectation(decode(expectationText,10*1024*1024));
    shape(observation,['version','kind','requestDigest','events','result']);
    need(observation.version===1&&observation.kind==='cm-provider-review-observation');
    hex(observation.requestDigest);need(observation.requestDigest===expected.request.requestDigest,'observation_binding');
    const {thread,terminal,close}=eventStream(observation.events,expected.excluded),r=observation.result;
    if(r?.status==='succeeded')shape(r,['status','value']);
    else {shape(r,['status','code']);need(['failed','cancelled'].includes(r.status));text(r.code);need(r.code.length<=256);}
    let observationStatus='unknown',code='transport_incomplete',review=null;
    if(close?.timed_out===true||r.code==='timeout')code='transport_timeout';
    else if(r.status==='cancelled'||r.code==='cancelled'){observationStatus='cancelled';code='transport_cancelled';}
    else if(close?.exit_code===0&&close.signal===null&&terminal==='turn.completed'&&r.status==='succeeded'){
      review=reviewResult(r.value,expected.pkg);observationStatus='completed';code=null;
    }
    return json({version:1,kind:'cm-provider-review-inspection',requestDigest:expected.request.requestDigest,
      observationDigest:digest(observation),identity:expected.request.identity,logicalContextId:expected.request.contextId,
      provider:'codex',requestedModel:expected.request.requestedModel,effectiveModel:null,providerThreadId:thread,
      observationStatus,code,review,completionEligible:false});
  }catch(error){
    const allowed=['limit_exceeded','observation_binding','observation_context','invalid_package',
      'review_package_mismatch','missing_material','contradictory_verdict'];
    const code=allowed.includes(error?.code)?error.code:'observation_invalid';
    throw Object.assign(new Error(code),{code});
  }
}
