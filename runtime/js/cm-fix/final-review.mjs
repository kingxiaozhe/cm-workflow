// Existing V3 grants and standard implementation-review observations only.
// The owning execution store registers callbacks; this module issues no receipt.
import {randomUUID} from 'node:crypto';
import {types} from 'node:util';
import {digest,json,need,shape,requestFor,validIdentity,failureCode} from '../cm-ai/effect-contract.mjs';
import {readReviewPackage} from '../cm-ai/review-package.mjs';
import {validateReviewDispatchGrant} from '../cm-ai/durable-runner-state.mjs';
import {inspectProviderReview} from '../cm-ai/provider-review-observation.mjs';
import {validateCauseReviewer} from './cause-invocation.mjs';
import {inspectFixWalkthrough} from './walkthrough.mjs';
import {inspectFixRegressionFailure} from './regression-evidence.mjs';

// Preserve old persisted configuration bytes: reuse its reviewer model settings,
// never its cause-review authority or actual provider thread.
export function fixFinalReviewConfiguration(configuration,causeThread=null){
  const base=validateCauseReviewer(configuration.causeReview,configuration.hostContextId);
  return {hostContextId:configuration.hostContextId,reviewer:{...base,reviewerId:'fix-final-reviewer',
    adapterId:`${base.provider}-review-adapter`,contextId:'fix-final-review-context',
    excludedThreadIds:[...new Set([...base.excludedThreadIds,...(causeThread?[causeThread]:[])])]}};
}

function expectation(request,configuration){
  return {request,developerThreadId:configuration.hostContextId,
    excludedThreadIds:[...configuration.reviewer.excludedThreadIds,request.contextId]};
}

// Immediate diagnostics only, never approval or replay evidence. Do not expose
// exception messages, provider text, arbitrary event labels or accessors.
function reviewDiagnostic(phase,error,event=null){
  let code=failureCode(error);
  try{
    const descriptor=error&&Object.getOwnPropertyDescriptor(error,'code');
    if(descriptor&&Object.hasOwn(descriptor,'value')&&['observation_invalid','observation_binding',
      'observation_context','final_context_mismatch','final_registration_mismatch','final_sync_registration_required'].includes(descriptor.value))code=descriptor.value;
  }catch{/* Uninspectable errors remain execution_error. */}
  const result={phase,code};
  if(phase==='event'){
    result.event=['thread.started','turn.started','item.started','item.updated','item.completed','turn.completed',
      'turn.failed','error','process_closed'].includes(event?.event)?event.event:'other';
    result.itemType=event?.item_type===null?null:['agent_message','reasoning','command_execution','error'].includes(event?.item_type)?event.item_type:'other';
  }
  return result;
}
export function inspectFixFinalRegistration(raw,configuration){
  const value=json(raw,12*1024*1024);shape(value,['request','authorizationAt','registeredAt','grant']);
  const reviewer=validateCauseReviewer(configuration.reviewer,configuration.hostContextId,configuration.reviewFeedback?34:33),request=value.request;
  need(request.provider===reviewer.provider&&request.requestedModel===reviewer.requestedModel&&request.contextId===reviewer.contextId,'final_registration_mismatch');
  const pkg=readReviewPackage(request.payload.reviewPackage);
  const previous=configuration.reviewFeedback?inspectFixRepairReview(configuration.reviewFeedback,pkg.identity):null;
  need(pkg.handoff&&digest(request.payload.priorReview)===digest(previous?.review??null),'final_handoff_required');
  if(previous)need(reviewer.excludedThreadIds.includes(previous.providerThreadId),'final_context_mismatch');
  validateReviewDispatchGrant(value.grant,{request,reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,
    packageDigest:pkg.packageDigest,hostContextIds:[configuration.hostContextId],authorizationAt:value.authorizationAt,registeredAt:value.registeredAt});
  inspectProviderReview(JSON.stringify({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
    events:[],result:{status:'failed',code:'in_progress'}}),JSON.stringify(expectation(request,configuration)));
  return value;
}
export function inspectFixFinalResult(raw,registration,configuration,started){
  const value=json(raw,1024*1024);shape(value,['dispatchAt','observation']);
  need(Number.isSafeInteger(value.dispatchAt)&&value.dispatchAt>=registration.registeredAt
    &&value.dispatchAt<registration.grant.expiresAt,'final_registration_mismatch');
  const checked=inspectProviderReview(JSON.stringify(value.observation),JSON.stringify(expectation(registration.request,configuration)));
  need(checked.providerThreadId===started,'final_registration_mismatch');return checked;
}

// Read-only feedback for the next repair; registration is still supplied by the
// serial owner. This is neither a dispatch grant nor a completion receipt.
export function inspectFixRepairReview(raw,nextIdentity){
  validIdentity(nextIdentity);
  const value=json(raw,12*1024*1024);
  shape(value,['configuration','registration','started','result',...(Object.hasOwn(value,'walkthroughFailure')?['walkthroughFailure']:[]),
    ...(Object.hasOwn(value,'regressionFailure')?['regressionFailure']:[])]);
  need(!(Object.hasOwn(value,'walkthroughFailure')&&Object.hasOwn(value,'regressionFailure')),'fix_review_repair_unavailable');
  const registered=inspectFixFinalRegistration(value.registration,value.configuration);
  const previous=registered.request.identity;
  need(previous.attempt===1&&nextIdentity.attempt===2,'fix_review_limit');
  need(['repositoryId','runId','taskId'].every(key=>previous[key]===nextIdentity[key]),'fix_review_identity_mismatch');
  const checked=inspectFixFinalResult(value.result,registered,value.configuration,value.started);
  need(checked.observationStatus==='completed','fix_review_repair_unavailable');
  if(value.walkthroughFailure){
    const failure=value.walkthroughFailure;shape(failure,['configuration','binding','result']);
    shape(failure.binding,['identity','packageDigest','diagnosisDigest','configurationDigest']);
    need(checked.review.verdict==='approved'&&digest(failure.binding.identity)===digest(previous)
      &&failure.binding.packageDigest===registered.request.payload.reviewPackage.packageDigest
      &&failure.binding.configurationDigest===digest(failure.configuration),'fix_review_repair_unavailable');
    need(inspectFixWalkthrough(failure.result,{binding:failure.binding,configuration:failure.configuration}).status==='failed','fix_review_repair_unavailable');
  }else if(value.regressionFailure){
    need(checked.review.verdict==='approved','fix_review_repair_unavailable');
    const pkg=registered.request.payload.reviewPackage;
    inspectFixRegressionFailure(value.regressionFailure,{identity:previous,packageDigest:pkg.packageDigest,
      priorHandoff:JSON.parse(Buffer.from(pkg.handoff.contentBase64,'base64').toString('utf8'))});
  }else need(checked.review.verdict==='changes_requested','fix_review_repair_unavailable');
  return json({identity:previous,review:checked.review,providerThreadId:checked.providerThreadId,
    registrationDigest:digest(registered),observationDigest:checked.observationDigest,
    ...(value.walkthroughFailure?{walkthroughFailure:value.walkthroughFailure}:{}),
    ...(value.regressionFailure?{regressionFailure:value.regressionFailure}:{})});
}

export function fixRevisionReviewConfiguration(feedback,nextIdentity){
  const previous=inspectFixRepairReview(feedback,nextIdentity),config=json(feedback.configuration);
  return {...config,reviewer:{...config.reviewer,excludedThreadIds:[...new Set([...config.reviewer.excludedThreadIds,previous.providerThreadId])]},reviewFeedback:feedback};
}

export function createFixFinalReview({reviewPackage,configuration,timeoutMs},{authorize,run}){
  const pkg=readReviewPackage(reviewPackage);need(pkg.handoff,'final_handoff_required');
  const config=json(configuration,12*1024*1024);shape(config,['hostContextId','reviewer',...(Object.hasOwn(config,'reviewFeedback')?['reviewFeedback']:[])]);
  const previous=config.reviewFeedback?inspectFixRepairReview(config.reviewFeedback,pkg.identity):null;
  const reviewer=validateCauseReviewer(config.reviewer,config.hostContextId,previous?34:33);
  if(previous)need(reviewer.excludedThreadIds.includes(previous.providerThreadId),'final_context_mismatch');
  need(Number.isInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=3600000,'invalid_timeout');
  need(typeof authorize==='function'&&typeof run==='function','final_review_unavailable');
  let used=false;
  return async({signal,register,onStarted})=>{
    need(!used,'final_review_already_attempted');need(!signal.aborted,'cancelled');
    need(typeof register==='function'&&typeof onStarted==='function','final_registration_required');used=true;
    const request=requestFor({invocationId:`fix-final.${randomUUID()}`,identity:pkg.identity,role:'reviewer',provider:reviewer.provider,
      requestedModel:reviewer.requestedModel,contextId:reviewer.contextId,payload:{reviewPackage:pkg,priorReview:previous?.review??null}});
    const authorizationAt=Date.now(),grant=authorize(request,{authorizationAt});
    if(types.isPromise(grant)){Promise.prototype.then.call(grant,()=>{},()=>{});need(false,'final_authorization_invalid');}
    if(digest(grant)===digest({status:'denied',code:'permission_denied'}))return {outcome:'denied',completionEligible:false};
    const registration=inspectFixFinalRegistration({request,authorizationAt,registeredAt:Date.now(),grant},config);
    const sync=callback=>{const value=callback();if(types.isPromise(value))Promise.prototype.then.call(value,()=>{},()=>{});
      need(value===undefined,'final_sync_registration_required');};
    sync(()=>register(registration));need(!signal.aborted,'cancelled');
    const dispatchAt=Date.now();need(dispatchAt>=registration.registeredAt&&dispatchAt<grant.expiresAt,'grant_expired');
    const controller=new AbortController(),events=[];let started=null,sealed=false,timedOut=false,timer,rejectAbort,diagnostic=null,phase='transport';
    const observation=result=>({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,events,result});
    const interrupted=new Promise((resolve,reject)=>{rejectAbort=()=>reject(Object.assign(new Error('interrupted'),{code:'interrupted'}));});
    const cancel=()=>controller.abort();signal.addEventListener('abort',cancel,{once:true});
    controller.signal.addEventListener('abort',rejectAbort,{once:true});
    const onEvent=raw=>{
      if(sealed||controller.signal.aborted)return false;
      let event=null,eventPhase='event';
      try{
        event=json(raw,64*1024);
        inspectProviderReview(JSON.stringify({...observation({status:'failed',code:'in_progress'}),events:[...events,event]}),JSON.stringify(expectation(request,config)));
        if(event.event==='thread.started'){eventPhase='registration';sync(()=>onStarted(event.provider_thread));started=event.provider_thread;}
        events.push(event);return true;
      }catch(error){diagnostic=reviewDiagnostic(eventPhase,error,event);controller.abort();return false;}
    };
    try{
      timer=setTimeout(()=>{timedOut=true;controller.abort();},timeoutMs);
      const result=await Promise.race([interrupted,Promise.resolve().then(()=>{need(!controller.signal.aborted,'cancelled');return run(request,{signal:controller.signal,onEvent});})]);
      need(!controller.signal.aborted,'interrupted');
      const value={dispatchAt,observation:observation(result)};
      phase='result';
      const inspection=inspectFixFinalResult(value,registration,config,started);
      return {outcome:'observed',value,inspection,completionEligible:false};
    }catch(error){
      const reason=timedOut?'timeout':signal.aborted?'cancelled':'transport_incomplete';
      return {outcome:'unknown',reason,diagnostic:diagnostic??(reason==='transport_incomplete'
        ?reviewDiagnostic(phase,error):{phase:'transport',code:reason}),completionEligible:false};
    }
    finally{sealed=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);controller.signal.removeEventListener('abort',rejectAbort);controller.abort();}
  };
}
