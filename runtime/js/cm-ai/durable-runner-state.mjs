// Host-only S3b2b journal grammar. Data validation grants no provider authority.
import {digest,need,shape,id,text,hex,json,validIdentity,validTaskLearningInput,requestFor} from './effect-contract.mjs';
import {readReviewBaseline,readReviewPackage} from './review-package.mjs';
import {reviewResult,reviewReceipt} from './review-runner.mjs';
import {checkCompletion} from './gate-bridge.mjs';
import path from 'node:path';
import {readCommitIntent,readCommitResult} from './task-commit-codec.mjs';
import {inspectProviderReview} from './provider-review-observation.mjs';
import {readCmAiProjectLearningWriteback} from './cm-ai-learning-writer.mjs';
import {readCmAiTaskLearningApplication} from './cm-ai-context-refresh.mjs';

const LIMIT=16*1024*1024;
const same=(a,b)=>need(digest(a)===digest(b),'runner_history_mismatch');
const prefix=(a,b)=>{need(b.length>=a.length,'runner_history_mismatch');same(a,b.slice(0,a.length));};
const uuid=s=>need(typeof s==='string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(s),'runner_session');
const states=['ready','awaiting_review','approved','changes_requested','fixture_completed','blocked','unknown','cancelled','pending_review'];
export const stageAllowed=(kind,state)=>({develop:['ready','changes_requested'],review:['awaiting_review'],complete:['approved']})[kind]?.includes(state)===true;
export function validateTaskLearningReviewPackage(rawPackage,writeback,learningInput) {
  validTaskLearningInput(learningInput,learningInput.identity,learningInput.feature);
  const reviewPackage=readReviewPackage(rawPackage);
  const agents=reviewPackage.changes.find(change=>change.path==='AGENTS.md')??null;
  if(writeback.outcome==='written')need(agents?.after?.sha256===writeback.agentsFile.sha256,'runner_learning');
  else if(writeback.outcome==='no_new_lesson'){
    const expected=learningInput.learningFiles.find(file=>file.scope==='project'&&file.path==='AGENTS.md')??null;
    if(agents!==null)need(expected!==null&&agents.after?.sha256===expected.sha256,'runner_learning');
  }else need(writeback.outcome==='deduplicated'
    &&(agents===null||agents.after?.sha256===writeback.agentsFile.sha256),'runner_learning');
  return true;
}
export const runnerPayload=(type,fields,version=1)=>{need([1,2].includes(version),'runner_version');
  return json(version===1?{version,protocol:'cm-task-runner',type,...fields}:{...fields,version,protocol:'cm-task-runner',type});};
export const runnerPayloadV3=(type,fields)=>json({...fields,version:3,protocol:'cm-task-runner',type});
export function boundRunnerRecord({id,kind,payload},seq) {
  // Exact S3a envelope width. Digest contents do not affect encoded byte count.
  json({version:1,seq,id,kind,payload,previousDigest:seq>1?'0'.repeat(64):null,digest:'0'.repeat(64)});
}
export function attemptBaseline(original,attempt) {
  const {baselineDigest,...data}=original,next={...data,identity:{...original.identity,attempt}};
  return readReviewBaseline({...next,baselineDigest:digest(next)});
}
export function initialRunnerState(config,session,version=1) {
  return {state:config.reviewers.some(r=>r.allowed&&r.available)?'ready':'pending_review',code:null,attempt:1,session,sequence:0,
    reviewPackage:null,currentChecks:null,receipt:null,receipts:[],calls:[],cache:[],priorReview:null,cancelAfterCommit:false,workflowError:null,cancellationRequested:false,
    ...(version>=2?{taskCommit:null}:{}),...(version===3?{reviewInvocation:null}:{}),
    ...(Object.hasOwn(config,'taskLearning')?{learningResult:null}:{})};
}
export function runnerStatus(s,config) {
  return json({state:s.state,code:s.code,identity:{...config.identity,attempt:s.attempt},packageDigest:s.reviewPackage?.packageDigest??null,
    receipt:s.receipt,receipts:s.receipts,calls:s.calls,cancelAfterCommit:s.cancelAfterCommit,workflowError:s.workflowError,cancellationRequested:s.cancellationRequested,
    ...(Object.hasOwn(s,'taskCommit')?{taskCommit:s.taskCommit}:{}),
    ...(Object.hasOwn(s,'reviewInvocation')?{reviewInvocation:s.reviewInvocation}:{}),
    ...(Object.hasOwn(config,'taskLearning')?{learningWriteback:s.learningResult?.writeback??null}:{})},LIMIT);
}
export function controlledState(state,event,outstanding,version=1) {
  const s=structuredClone(state);
  const unresolvedReview=version===3&&s.reviewInvocation?.result?.reconciliationRequired===true
    &&s.reviewInvocation.registration?.grant?.identity?.attempt===s.attempt;
  if(event==='workflow-error') {s.workflowError='workflow_error';if(!outstanding && s.state!=='fixture_completed'
    && !(s.state==='unknown'&&(version>=2&&s.taskCommit||unresolvedReview))){s.state='blocked';s.code='workflow_error';}}
  else if(event==='late-cancel'){s.cancelAfterCommit=true;s.cancellationRequested=true;}
  else if(event==='cancel') {if(!['blocked','unknown','cancelled','fixture_completed'].includes(s.state)){s.state='cancelled';s.code='cancelled';s.cancellationRequested=true;}}
  else need(false,'runner_control');
  return s;
}
function packageLink(pkg,original,attempt,checks) {
  const p=readReviewPackage(pkg),b=attemptBaseline(original,attempt);
  same(p.identity,b.identity);same(p.scope,b.scope);same(p.checks,checks);
  need(p.baseIdentity===b.baselineDigest && p.rootDigest===b.rootDigest,'runner_package');
  const files=new Map(b.files.map(f=>[f.path,f]));
  for(const c of p.changes){same(c.before,files.get(c.path)??null);if(c.after===null)files.delete(c.path);else files.set(c.path,c.after);}
  same(p.requirements,b.requirements.map(path=>files.get(path)??null));
}
function callRequest(call,adapter,contextId,role,payload,identity,session,index) {
  shape(call,['invocationId','contextId','provider','requestedModel','effectiveModel','channel','started','terminal','requestDigest','resultDigest']);
  need(call.invocationId===`${session}.${index}` && call.contextId===contextId && call.provider===adapter.provider
    && call.requestedModel===adapter.requestedModel && call.channel==='fixture' && call.started===true,'runner_call');
  text(call.effectiveModel);hex(call.requestDigest);
  need(['succeeded','failed','unknown','cancelled','unavailable','auth_required','permission_denied'].includes(call.terminal),'runner_call');
  if(call.resultDigest!==null)hex(call.resultDigest);
  if(['failed','unavailable','auth_required','permission_denied'].includes(call.terminal))same(call.resultDigest,digest(null));
  const request=requestFor({invocationId:call.invocationId,identity,role,provider:adapter.provider,
    requestedModel:adapter.requestedModel,contextId,payload});
  need(call.requestDigest===request.requestDigest,'runner_request');return request;
}
function reviewRequest(before,config,session) {
  const reviewer=config.reviewers[0];
  return requestFor({invocationId:`${session}.${before.sequence+1}`,identity:{...config.identity,attempt:before.attempt},
    role:'reviewer',provider:reviewer.provider,requestedModel:reviewer.requestedModel,
    contextId:reviewer.contexts[before.attempt-1],payload:{reviewPackage:before.reviewPackage,priorReview:before.priorReview}});
}
function grantBody(grant) {
  const {grantDigest,...body}=grant;return body;
}
export function validateReviewDispatchGrant(raw,expected) {
  const grant=json(raw),request=expected.request;
  shape(grant,['version','kind','grantId','adapterId','invocationId','requestDigest','identity','reviewerId','logicalContextId',
    'packageDigest','hostContextId','decisionId','decision','issuedAt','expiresAt','grantDigest']);
  need(grant.version===1&&grant.kind==='cm-review-dispatch-grant'&&grant.decision==='approved','runner_grant');
  [grant.grantId,grant.adapterId,grant.invocationId,grant.reviewerId,grant.logicalContextId,grant.hostContextId,grant.decisionId].forEach(id);
  [grant.requestDigest,grant.packageDigest,grant.grantDigest].forEach(hex);validIdentity(grant.identity);
  for(const n of [grant.issuedAt,expected.authorizationAt,expected.registeredAt,grant.expiresAt])need(Number.isSafeInteger(n),'runner_grant');
  need(grant.expiresAt-grant.issuedAt>=1&&grant.expiresAt-grant.issuedAt<=60000
    &&grant.issuedAt<=expected.authorizationAt&&expected.authorizationAt<=expected.registeredAt
    &&expected.registeredAt<grant.expiresAt,'runner_grant');
  same(grant.identity,request.identity);need(grant.adapterId===expected.adapterId&&grant.invocationId===request.invocationId
    &&grant.requestDigest===request.requestDigest&&grant.reviewerId===expected.reviewerId
    &&grant.logicalContextId===request.contextId&&grant.packageDigest===expected.packageDigest,'runner_grant');
  need(expected.hostContextIds.includes(grant.hostContextId),'runner_grant');
  need(digest(grantBody(grant))===grant.grantDigest,'runner_grant');return grant;
}
function readRegistration(p,before,effect,config,session) {
  shape(p,['version','protocol','type','effectId','reviewerId','adapterId','requestDigest','authorizationAt','registeredAt','grant']);
  need(p.effectId===effect.id,'runner_invocation');
  const request=reviewRequest(before,config,session),reviewer=config.reviewers[0];
  need(p.reviewerId===reviewer.id&&p.adapterId===reviewer.adapterId&&p.requestDigest===request.requestDigest,'runner_grant');
  const grant=validateReviewDispatchGrant(p.grant,{request,reviewerId:reviewer.id,adapterId:reviewer.adapterId,
    packageDigest:before.reviewPackage.packageDigest,hostContextIds:[config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds],
    authorizationAt:p.authorizationAt,registeredAt:p.registeredAt});
  return {request,record:json({reviewerId:p.reviewerId,adapterId:p.adapterId,requestDigest:p.requestDigest,
    authorizationAt:p.authorizationAt,registeredAt:p.registeredAt,grant})};
}
function readStarted(p,registration,effect,config) {
  shape(p,['version','protocol','type','effectId','invocationId','providerThreadId']);
  need(p.effectId===effect.id&&p.invocationId===registration.request.invocationId,'runner_invocation');id(p.providerThreadId);
  const excluded=new Set([config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds,
    registration.request.contextId]);
  need(!excluded.has(p.providerThreadId),'runner_invocation');return p.providerThreadId;
}
function readInvocationResult(p,registration,started,effect,config) {
  const common=['version','protocol','type','effectId','invocationId','dispatchAt','outcome','observation','inspection','reconciliationRequired'];
  need(p.effectId===effect.id&&p.invocationId===registration.request.invocationId,'runner_invocation');
  need(typeof p.reconciliationRequired==='boolean','runner_invocation');
  if(p.outcome==='not_dispatched')need(p.dispatchAt===null||Number.isSafeInteger(p.dispatchAt),'runner_invocation');
  else need(Number.isSafeInteger(p.dispatchAt)&&registration.record.registeredAt<=p.dispatchAt
    &&p.dispatchAt<registration.record.grant.expiresAt,'runner_invocation');
  const expectation={request:registration.request,developerThreadId:config.reviewInvocation.developerThreadId,
    excludedThreadIds:config.reviewInvocation.excludedThreadIds};
  let inspected=null;
  if(['observed','unknown'].includes(p.outcome)&&p.inspection!==null) {
    shape(p,common);const observation=json(p.observation,512*1024);
    inspected=inspectProviderReview(JSON.stringify(observation),JSON.stringify(expectation));same(p.inspection,inspected);
    need(inspected.providerThreadId===started,'runner_invocation');
    if(p.outcome==='observed')need(inspected.observationStatus==='completed'&&p.reconciliationRequired===false,'runner_invocation');
    else need(['unknown','cancelled'].includes(inspected.observationStatus)&&p.reconciliationRequired===true,'runner_invocation');
  } else if(p.outcome==='unknown') {
    shape(p,[...common,'reason']);need(p.reason==='observation_invalid'&&p.inspection===null&&p.reconciliationRequired===true,'runner_invocation');
    const observation=json(p.observation,512*1024);need(observation.requestDigest===registration.request.requestDigest,'runner_invocation');
    let rejected=false;try{inspectProviderReview(JSON.stringify(observation),JSON.stringify(expectation));}catch{rejected=true;}
    const first=observation.events?.find?.(event=>event?.event==='thread.started')?.provider_thread??null;
    need(rejected||first===registration.request.contextId,'runner_invocation');
    if(started===null)need(first===null||[config.reviewInvocation.developerThreadId,...config.reviewInvocation.excludedThreadIds,
      registration.request.contextId].includes(first),'runner_invocation');
    else need(first===started,'runner_invocation');
  } else if(['cancelled','timed_out'].includes(p.outcome)) {
    shape(p,common);need(p.inspection===null&&p.reconciliationRequired===true,'runner_invocation');
    const observation=json(p.observation,512*1024),check=inspectProviderReview(JSON.stringify(observation),JSON.stringify(expectation));
    need(check.providerThreadId===started,'runner_invocation');
    need(p.outcome==='cancelled'?check.observationStatus==='cancelled':check.code==='transport_timeout','runner_invocation');
  } else if(p.outcome==='not_dispatched') {
    shape(p,[...common,'reason']);need(['grant_expired','clock_invalid'].includes(p.reason)
      &&p.observation===null&&p.inspection===null&&p.reconciliationRequired===true&&started===null,'runner_invocation');
    need(p.reason==='grant_expired'?Number.isSafeInteger(p.dispatchAt)&&p.dispatchAt>=registration.record.grant.expiresAt:
      p.dispatchAt===null||p.dispatchAt<registration.record.registeredAt,'runner_invocation');
  } else need(false,'runner_invocation');
  return json(Object.fromEntries(Object.entries(p).filter(([key])=>!['version','protocol','type','effectId','invocationId'].includes(key))),512*1024);
}
function invocationCall(call,registration,started,result,before) {
  shape(call,['invocationId','contextId','provider','requestedModel','effectiveModel','channel','started','terminal','requestDigest','resultDigest','providerThreadId']);
  const request=registration.request;need(call.invocationId===request.invocationId&&call.contextId===request.contextId
    &&call.provider==='codex'&&call.requestedModel===request.requestedModel&&call.effectiveModel==='unknown'
    &&call.channel==='host-authorized'&&call.requestDigest===request.requestDigest
    &&call.providerThreadId===started,'runner_call');
  const expectedTerminal=result.outcome==='observed'?'succeeded':result.outcome==='cancelled'?'cancelled':
    result.outcome==='not_dispatched'?'not_dispatched':'unknown';
  need(call.started===(result.outcome!=='not_dispatched')&&call.terminal===expectedTerminal
    &&call.resultDigest===digest(result.outcome==='observed'?result.inspection.review:result)
    &&before.sequence+1===Number(request.invocationId.split('.').at(-1)),'runner_call');
}
function checkpoint(before,raw,effect,config,original,session,controls,version=1,taskCommit=null,invocation=null) {
  const s=json(raw,LIMIT);
  shape(s,['state','code','attempt','session','sequence','reviewPackage','currentChecks','receipt','receipts','calls','cache',
    'priorReview','cancelAfterCommit','workflowError','cancellationRequested',...(version>=2?['taskCommit']:[]),...(version===3?['reviewInvocation']:[]),
    ...(Object.hasOwn(config,'taskLearning')?['learningResult']:[])]);
  if(version>=2){
    same(s.taskCommit,effect.kind==='complete'?taskCommit:null);
    if(effect.kind==='complete'){
      if(taskCommit===null)need(s.state!=='fixture_completed','runner_commit');
      else if(taskCommit.resultDigest===null)need(s.state==='unknown','runner_commit');
      else need(['fixture_completed','unknown'].includes(s.state),'runner_commit');
    }
  }
  need(states.includes(s.state) && [1,2].includes(s.attempt) && s.session===session,'runner_state');
  need(s.code===null || typeof s.code==='string' && s.code.length<=128,'runner_state');
  need(typeof s.cancelAfterCommit==='boolean' && [null,'workflow_error'].includes(s.workflowError),'runner_state');
  need(typeof s.cancellationRequested==='boolean','runner_state');
  need(Array.isArray(s.calls) && s.calls.length<=6 && s.sequence===s.calls.length,'runner_calls');
  need(Array.isArray(s.receipts) && s.receipts.length<=2 && Array.isArray(s.cache) && s.cache.length<=6,'runner_limits');
  prefix(before.calls,s.calls);prefix(before.receipts,s.receipts);prefix(before.cache,s.cache);
  need(s.cache.length===before.cache.length+1,'runner_cache');
  const entry=s.cache.at(-1);shape(entry,['effect','digest','result']);same(entry.effect,effect);same(entry.digest,digest(effect));
  same(entry.result,runnerStatus(s,config));
  const added=s.calls.slice(before.calls.length),identity={...config.identity,attempt:before.attempt};
  let accepted=null,expectedState=null,expectedCode=null,expectedAttempt=before.attempt;
  if(effect.kind!=='develop'&&Object.hasOwn(config,'taskLearning'))same(s.learningResult,before.learningResult);
  if(effect.kind==='develop') {
    need(added.length<=1 && s.receipts.length===before.receipts.length,'runner_develop');same(s.receipt,null);same(s.priorReview,before.priorReview);
    if(added.length)callRequest(added[0],config.developer,config.developer.contextId,'developer',{
      scope:config.scope,requirements:original.files.filter(f=>config.requirements.includes(f.path)),priorReview:before.priorReview,
      ...(Object.hasOwn(effect,'learningInput')?{learningInput:effect.learningInput}:{})
    },identity,session,before.calls.length+1);
    if(Object.hasOwn(config,'taskLearning')){
      if(s.learningResult!==null){
        const hasApplication=Object.hasOwn(s.learningResult,'application');
        shape(s.learningResult,[...(hasApplication?['application']:[]),'retrospective','writeback']);
        let application=null;
        if(hasApplication){application=readCmAiTaskLearningApplication(s.learningResult.application);
          need(application.feature===effect.learningInput.feature
            &&application.learningDigest===effect.learningInput.learningDigest,'runner_learning');
          same(application.identity,effect.learningInput.identity);}
        const writeback=readCmAiProjectLearningWriteback(s.learningResult.writeback,
          {learningInput:effect.learningInput,retrospective:s.learningResult.retrospective});
        need(added.length===1&&added[0].terminal==='succeeded','runner_learning');
        same(added[0].resultDigest,digest({outcome:'implemented',...(hasApplication?{application}:{}),
          retrospective:s.learningResult.retrospective}));
        if(writeback.outcome==='writeback_pending'){
          expectedState='blocked';expectedCode='learning_writeback_pending';
        }
      }else need(s.state==='unknown'||s.state==='cancelled'
        ||added[0]&&['failed','unavailable','auth_required','permission_denied'].includes(added[0].terminal),'runner_learning');
    }
    if(digest(s.reviewPackage)!==digest(before.reviewPackage)) {
      const developerResult=Object.hasOwn(config,'taskLearning')
        ?{outcome:'implemented',...(s.learningResult&&Object.hasOwn(s.learningResult,'application')
          ?{application:s.learningResult.application}:{}),retrospective:s.learningResult?.retrospective}:{outcome:'implemented'};
      need(added.length===1 && added[0].terminal==='succeeded' && added[0].resultDigest===digest(developerResult),'runner_develop');
      if(Object.hasOwn(config,'taskLearning'))need(s.learningResult!==null
        &&s.learningResult.writeback.outcome!=='writeback_pending','runner_learning');
      packageLink(s.reviewPackage,original,before.attempt,s.currentChecks);
      if(Object.hasOwn(config,'taskLearning'))validateTaskLearningReviewPackage(s.reviewPackage,
        s.learningResult.writeback,effect.learningInput);
      expectedState='awaiting_review';
    }
    if(added[0] && ['failed','unavailable','auth_required','permission_denied'].includes(added[0].terminal)) {
      expectedState='blocked';expectedCode=added[0].terminal;
    }
  } else if(effect.kind==='review'&&version===3) {
    same(s.reviewPackage,before.reviewPackage);same(s.currentChecks,before.currentChecks);
    if(!invocation?.registration){
      need(!invocation?.result&&added.length===0&&s.sequence===before.sequence,'runner_invocation');
      same(s.reviewInvocation,before.reviewInvocation);same(s.receipt,before.receipt);same(s.receipts,before.receipts);same(s.priorReview,before.priorReview);
      if(controls.cancelled===true){expectedState='cancelled';expectedCode='cancelled';}
      else if(s.code==='permission_denied')expectedState='pending_review';
      else {need(['authorization_invalid','clock_invalid'].includes(s.code),'runner_invocation');expectedState='unknown';}
      expectedCode??=s.code;
    } else {
    need(invocation.result&&added.length===1,'runner_invocation');
    invocationCall(added[0],invocation.registration,invocation.started,invocation.result,before);
    const diagnostic={registration:invocation.registration.record,started:invocation.started,result:invocation.result};
    same(s.reviewInvocation,diagnostic);
    if(invocation.result.outcome==='observed'){
      need(s.receipts.length===before.receipts.length+1,'runner_receipt');
      const rawReceipt=s.receipts.at(-1),result=reviewResult(invocation.result.inspection.review,before.reviewPackage);
      accepted=reviewReceipt({request:invocation.registration.request,call:added[0],result,
        reviewPackage:before.reviewPackage,developerProvider:config.developer.provider,fallbackReasons:[]});
      same(rawReceipt,accepted);same(s.receipt,accepted);same(s.priorReview,result);
      if(result.verdict==='approved')expectedState='approved';
      else if(result.verdict==='changes_requested'&&before.attempt===1){expectedState='changes_requested';expectedAttempt=2;}
      else {expectedState='blocked';expectedCode=result.verdict==='changes_requested'?'review_limit':'review_blocked';}
    }
    else if(invocation.result.outcome==='cancelled'){need(controls.cancelled===true,'runner_control');expectedState='cancelled';expectedCode='cancelled';}
    else if(invocation.result.outcome==='not_dispatched'){expectedState='pending_review';expectedCode=invocation.result.reason;}
    else {expectedState='unknown';expectedCode=invocation.result.reason??invocation.result.inspection?.code??'reconciliation_required';}
    if(invocation.result.outcome!=='observed'){
      same(s.receipt,before.receipt);same(s.receipts,before.receipts);same(s.priorReview,before.priorReview);
    }
    }
  } else if(effect.kind==='review') {
    same(s.reviewPackage,before.reviewPackage);same(s.currentChecks,before.currentChecks);
    const reasons=[];let index=0;
    for(const candidate of config.reviewers) {
      if(!candidate.allowed || !candidate.available){reasons.push({id:candidate.id,reason:!candidate.allowed?'not_authorized':'unavailable'});continue;}
      if(index===added.length)break;
      const call=added[index++],request=callRequest(call,candidate,candidate.contexts[before.attempt-1],'reviewer',{
        reviewPackage:before.reviewPackage,priorReview:before.priorReview},identity,session,before.calls.length+index);
      if(['unavailable','auth_required','permission_denied'].includes(call.terminal)){reasons.push({id:candidate.id,reason:call.terminal});continue;}
      need(index===added.length,'runner_fallback');
      if(s.receipts.length===before.receipts.length+1) {
        const rawReceipt=s.receipts.at(-1),result=reviewResult(rawReceipt.result,before.reviewPackage);
        accepted=reviewReceipt({request,call,result,reviewPackage:before.reviewPackage,developerProvider:config.developer.provider,fallbackReasons:reasons});
        same(rawReceipt,accepted);
        if(result.verdict==='approved')expectedState='approved';
        else if(result.verdict==='changes_requested' && before.attempt===1){expectedState='changes_requested';expectedAttempt=2;}
        else {expectedState='blocked';expectedCode=result.verdict==='changes_requested'?'review_limit':'review_blocked';}
      } else if(call.terminal==='failed'){expectedState='pending_review';expectedCode='failed';}
      break;
    }
    need(index===added.length && s.receipts.length===before.receipts.length+(accepted?1:0),'runner_receipt');
    same(s.receipt,accepted??before.receipt);same(s.priorReview,accepted?.result??before.priorReview);
    if(!accepted && reasons.length===config.reviewers.length){expectedState='pending_review';expectedCode='review_channels_unavailable';}
  } else {
    need(added.length===0,'runner_complete');same(s.reviewPackage,before.reviewPackage);same(s.currentChecks,before.currentChecks);
    same(s.receipts,before.receipts);same(s.receipt,before.receipt);same(s.priorReview,before.priorReview);
    if(s.state==='fixture_completed') {
      checkCompletion({receipt:s.receipt,registered:before.receipt,execution:s.calls.find(c=>c.invocationId===s.receipt?.id),
        reviewPackage:s.reviewPackage,identity});expectedState='fixture_completed';
    } else if(s.state==='blocked')expectedState='blocked';
  }
  need(s.attempt===expectedAttempt,'runner_attempt');
  // Terminal failure may retain materials; it cannot confer a new dispatch capability.
  if(!['unknown','cancelled'].includes(s.state))need(s.state===expectedState,'runner_transition');
  if(expectedCode && !['unknown','cancelled'].includes(s.state))need(s.code===expectedCode,'runner_transition');
  if(['awaiting_review','approved','fixture_completed'].includes(s.state)) {
    need(s.code===null,'runner_transition');packageLink(s.reviewPackage,original,s.attempt,s.currentChecks);
  }
  need(s.workflowError===(controls.workflowError??before.workflowError),'runner_control');
  need(s.cancelAfterCommit===(controls.cancelAfterCommit||before.cancelAfterCommit),'runner_control');
  need(s.cancellationRequested===(!!controls.cancelled||!!controls.cancelAfterCommit||before.cancellationRequested),'runner_control');
  if(controls.cancelled)need(s.state==='cancelled','runner_control');
  return structuredClone(s);
}

function completionConfig(config,version){
  shape(config,['root','identity','scope','requirements','excludedContexts','timeoutMs','developer','reviewers','completion',
    ...(version===3?['reviewInvocation']:[]),...(Object.hasOwn(config,'taskLearning')?['taskLearning']:[])]);
  // V1 gets these data constraints from createTaskRunner before reading history.
  // The new standalone V2 reader must enforce them before exposing initial state.
  validIdentity(config.identity);need(config.identity.attempt===1);
  need(Number.isInteger(config.timeoutMs)&&config.timeoutMs>=1&&config.timeoutMs<=60000);
  need(Array.isArray(config.excludedContexts)&&config.excludedContexts.length>0);config.excludedContexts.forEach(id);
  shape(config.developer,['provider','requestedModel','contextId']);
  id(config.developer.contextId);text(config.developer.requestedModel);need(['codex','claude'].includes(config.developer.provider));
  need(Array.isArray(config.reviewers)&&config.reviewers.length<=2);
  const used=new Set([...config.excludedContexts,config.developer.contextId]),ids=new Set();
  for(const r of config.reviewers){
    shape(r,['id','provider','requestedModel','allowed','available','contexts',...(version===3?['adapterId']:[])]);id(r.id);need(!ids.has(r.id));ids.add(r.id);
    text(r.requestedModel);need(['codex','claude'].includes(r.provider)&&typeof r.allowed==='boolean'&&typeof r.available==='boolean');
    if(version===3)id(r.adapterId);
    need(Array.isArray(r.contexts)&&r.contexts.length===2);
    for(const c of r.contexts){id(c);need(!used.has(c),'not_independent');used.add(c);}
  }
  const c=config.completion;shape(c,['version','mode','owner','fingerprints','reviewsDir','handoffs']);
  need(c.version===1&&c.mode==='fixture-task','runner_completion');
  shape(c.owner,['tasksPath','feature','specsRoot']);shape(c.fingerprints,['workflow','config','inputs']);
  Object.values(c.fingerprints).forEach(hex);text(c.owner.feature);
  const absolute=p=>need(typeof p==='string'&&!p.includes('\0')&&path.isAbsolute(p)&&path.resolve(p)===p,'runner_completion');
  [config.root,c.owner.tasksPath,c.owner.specsRoot,c.reviewsDir].forEach(absolute);
  need(c.owner.tasksPath.startsWith(c.owner.specsRoot+path.sep),'runner_completion');
  if(Object.hasOwn(config,'taskLearning')){shape(config.taskLearning,['feature']);text(config.taskLearning.feature);
  }
  need(config.root!==c.owner.specsRoot&&!config.root.startsWith(c.owner.specsRoot+path.sep)
    &&!c.owner.specsRoot.startsWith(config.root+path.sep),'runner_completion');
  need([path.join(c.owner.specsRoot,'.reviews'),path.join(path.dirname(c.owner.tasksPath),'.reviews')].includes(c.reviewsDir),'runner_completion');
  need(Array.isArray(c.handoffs)&&c.handoffs.length===2&&c.handoffs[0]!==c.handoffs[1],'runner_completion');
  for(const p of c.handoffs){absolute(p);need(path.dirname(p)===c.reviewsDir,'runner_completion');}
  if(version===3){
    need(config.reviewers.length===1&&config.reviewers[0].provider==='codex'
      &&config.reviewers[0].allowed&&config.reviewers[0].available,'runner_invocation');
    const v=config.reviewInvocation;shape(v,['developerThreadId','excludedThreadIds']);id(v.developerThreadId);
    need(Array.isArray(v.excludedThreadIds)&&v.excludedThreadIds.length>0&&v.excludedThreadIds.length<=32,'runner_invocation');
    const actual=new Set([v.developerThreadId]);for(const item of v.excludedThreadIds){id(item);need(!actual.has(item),'runner_invocation');actual.add(item);}
  }
  return c;
}
function fullEnvelope(r,index,previousDigest){
  shape(r,['version','seq','id','kind','payload','previousDigest','digest']);hex(r.digest);
  need(r.version===1&&r.seq===index+1&&r.previousDigest===previousDigest,'runner_chain');
  const {digest:recordDigest,...body}=r;need(recordDigest===digest(body),'runner_chain');
}
export function readRunnerHistory(raw,config,version=1) {
  need([1,2,3].includes(version),'runner_version');
  if(version>=2)config=json(config,LIMIT);
  const records=json(raw,LIMIT);need(Array.isArray(records) && records.length>0,'runner_missing');
  need(records[0]?.payload?.version===version,'runner_version');
  const completion=version>=2?completionConfig(config,version):null;
  let original,session,state,pending=null,beforeIntent=null,controlCount=0,controls={},completeIntentDigest=null,transaction=null;
  let invocation={registration:null,started:null,result:null};
  for(const [index,r] of records.entries()) {
    boundRunnerRecord(r,index+1);
    if(version>=2)fullEnvelope(r,index,index?records[index-1].digest:null);
    need(r.id===`runner.${String(index+1).padStart(6,'0')}`,'runner_sequence');
    const p=r.payload;need(p.version===version && p.protocol==='cm-task-runner','runner_version');
    const common=['version','protocol','type'];
    if(index===0) {
      shape(p,[...common,'config','baseline','session']);need(p.type==='init' && r.kind==='result','runner_init');
      same(p.config,config);session=p.session;uuid(session);original=readReviewBaseline(p.baseline);
      const reviewScope=Object.hasOwn(config,'taskLearning')&&!config.scope.includes('AGENTS.md')
        ?[...config.scope,'AGENTS.md']:[...config.scope];
      same(original.identity,config.identity);same(original.scope,reviewScope.sort());same(original.requirements,[...config.requirements].sort());
      same(original.rootDigest,digestRoot(config.root));state=initialRunnerState(config,session,version);continue;
    }
    if(p.type==='effect-intent') {
      shape(p,[...common,'effect']);need(r.kind==='intent' && pending===null,'runner_intent');
      const e=p.effect;shape(e,['version','id','identity','kind',...(Object.hasOwn(e,'learningInput')?['learningInput']:[])]);
      validIdentity(e.identity);id(e.id);
      if(e.kind==='develop'&&Object.hasOwn(config,'taskLearning'))need(Object.hasOwn(e,'learningInput'),'runner_learning');
      if(Object.hasOwn(e,'learningInput')){need(e.kind==='develop'&&Object.hasOwn(config,'taskLearning'),'runner_learning');
        validTaskLearningInput(e.learningInput,e.identity,config.taskLearning.feature);}
      same(e.identity,{...config.identity,attempt:state.attempt});need(e.version===1 && stageAllowed(e.kind,state.state),'runner_stage');
      need(state.cache.length<6 && !state.cache.some(c=>c.effect.id===e.id),'runner_cache');
      pending=e;beforeIntent=structuredClone(state);controls={};completeIntentDigest=e.kind==='complete'?r.digest:null;
      invocation={registration:null,started:null,result:null};
    } else if(version===3&&p.type==='review-invocation-registered') {
      need(r.kind==='intent'&&pending?.kind==='review'&&!invocation.registration,'runner_invocation');
      invocation.registration=readRegistration(p,beforeIntent,pending,config,session);
    } else if(version===3&&p.type==='review-invocation-started') {
      need(r.kind==='result'&&invocation.registration&&!invocation.started&&!invocation.result,'runner_invocation');
      invocation.started=readStarted(p,invocation.registration,pending,config);
    } else if(version===3&&p.type==='review-invocation-result') {
      need(r.kind==='result'&&invocation.registration&&!invocation.result,'runner_invocation');
      invocation.result=readInvocationResult(p,invocation.registration,invocation.started,pending,config);
      if(invocation.result.outcome==='cancelled')need(controls.cancelled===true,'runner_control');
    } else if(p.type==='effect-checkpoint') {
      shape(p,[...common,'effectId','checkpoint']);need(r.kind==='result' && pending && p.effectId===pending.id,'runner_checkpoint');
      state=checkpoint(beforeIntent,p.checkpoint,pending,config,original,session,controls,version,state.taskCommit??null,invocation);
      pending=null;beforeIntent=null;invocation={registration:null,started:null,result:null};
    } else if(version>=2 && ['task-commit-intent','task-commit-result'].includes(p.type)){
      shape(p,[...common,'effectId','completeIntentDigest','commit']);
      need(pending?.kind==='complete'&&p.effectId===pending.id&&p.completeIntentDigest===completeIntentDigest&&!controls.cancelled,'runner_commit');
      if(p.type==='task-commit-intent'){
        need(r.kind==='commit-intent'&&transaction===null&&beforeIntent.state==='approved','runner_commit');
        const c=readCommitIntent(p.commit,{owner:completion.owner,identity:pending.identity,fingerprints:completion.fingerprints});
        const base=attemptBaseline(original,pending.identity.attempt),s=beforeIntent;
        checkCompletion({receipt:s.receipt,registered:s.receipts.find(x=>x.id===s.receipt?.id),
          execution:s.calls.find(x=>x.invocationId===s.receipt?.id),reviewPackage:s.reviewPackage,identity:pending.identity});
        same(c.proof,{root:config.root,baselineDigest:base.baselineDigest,packageDigest:s.reviewPackage.packageDigest,
          receiptDigest:s.receipt.receiptDigest,checksDigest:s.reviewPackage.checksDigest});
        need(c.plan.evidence.every(e=>path.dirname(e.path)===completion.reviewsDir)
          &&completion.handoffs.slice(0,pending.identity.attempt).every(h=>c.plan.evidence.some(e=>e.path===h)),'runner_commit_selectors');
        transaction={effectId:pending.id,completeIntentDigest,intentRecord:r,resultRecord:null};
        state.taskCommit={intentDigest:r.digest,planDigest:c.plan.planDigest,resultDigest:null,outcome:null};
      }else{
        need(r.kind==='commit-result'&&transaction&&transaction.resultRecord===null,'runner_commit');
        readCommitResult(p.commit,{intentDigest:transaction.intentRecord.digest,planDigest:state.taskCommit.planDigest});
        transaction.resultRecord=r;state.taskCommit={...state.taskCommit,resultDigest:r.digest,outcome:'fixture_committed'};
      }
    } else if(p.type==='control') {
      shape(p,[...common,'event']);need(r.kind==='cancel' && ++controlCount<=16,'runner_control');
      if(p.event==='late-cancel')need(state.state==='fixture_completed' || pending?.kind==='complete','runner_control');
      if(p.event==='cancel')need(state.state!=='fixture_completed','runner_control');
      if(version>=2&&p.event==='cancel')need(transaction===null,'runner_control');
      const next=controlledState(state,p.event,pending!==null,version);need(digest(next)!==digest(state),'runner_control');state=next;
      if(pending){if(p.event==='cancel')controls.cancelled=true;if(p.event==='late-cancel')controls.cancelAfterCommit=true;
        if(p.event==='workflow-error')controls.workflowError='workflow_error';}
    } else need(false,'runner_record');
  }
  if(pending){state.state='unknown';state.code='reconciliation_required';
    if(version===3&&invocation.registration)state.reviewInvocation={registration:invocation.registration.record,
      started:invocation.started,result:invocation.result};}
  return {original,session,state,pending,...(version>=2?{transaction}:{})};
}
// Baseline rootDigest uses bytes of the canonical root, not JSON string encoding.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
const digestRoot=root=>createHash('sha256').update(fs.realpathSync(root)).digest('hex');
