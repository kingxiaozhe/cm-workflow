// One separately approved technical opportunity. No refunds, new runs or development.
import {digest,need,shape,id,hex,validIdentity,requestFor,MAX_REVIEW_EXCLUSIONS} from './effect-contract.mjs';
import {evidenceCheckpointBudget} from './valid-review-evidence-continuation.mjs';
import {RECORD_LIMIT,STATE_LIMIT} from './execution-store-limits.mjs';
import {inspectProviderReviewFailure} from './provider-review-observation.mjs';
export const PROVIDER_RECOVERY_EFFECT='review-provider-recovery-1';
export function providerRecoveryRequest(v){
 shape(v,['version','reason','providerReviewRecovery','source','oldInvocationStopped']);
 need(v.version===1&&v.providerReviewRecovery===true&&v.oldInvocationStopped===true,'provider_recovery_authorization');
 need(typeof v.reason==='string'&&v.reason.trim()&&Buffer.byteLength(v.reason)<=500&&!/[\r\n\0]/.test(v.reason),'provider_recovery_reason');
 readProviderRecoverySource(v.source);return v;
}
export function readProviderRecoverySource(s){
 shape(s,['identity','hostContextId','revision','fromDigest','configDigest','baselineDigest','scopeDigest','candidateDigest','packageDigest',
  'evidenceRegistrationDigest','evidenceAuthorizationDigest','failedEffectId','failedCheckpointDigest','invocationId','requestDigest',
  'registrationDigest','startedDigest','resultDigest','fingerprints']);
 validIdentity(s.identity);for(const k of ['hostContextId','failedEffectId','invocationId'])id(s[k]);
 for(const k of ['revision','fromDigest','configDigest','baselineDigest','scopeDigest','candidateDigest','packageDigest','evidenceRegistrationDigest',
  'evidenceAuthorizationDigest','failedCheckpointDigest','requestDigest','registrationDigest','startedDigest','resultDigest'])hex(s[k]);
 shape(s.fingerprints,['workflow','config','inputs']);Object.values(s.fingerprints).forEach(hex);return s;
}
// The caller's history has already validated the entire observation and cleanup
// contract. Narrow this further to a real native failure terminal. Diagnostics
// are optional evidence only, never eligibility or authority.
export function strictProviderFailure(result){
 const o=result?.observation,events=o?.events;
 if(!(result?.outcome==='failed'&&result.reconciliationRequired===false&&result.inspection?.kind==='cm-provider-review-failure'
  &&result.inspection.category==='provider'&&result.inspection.failure==='reviewer_provider_failed'
  &&o?.result?.status==='failed'&&o.result.code==='provider_failed'&&Array.isArray(events)&&events.length===4))return false;
 return events[0].event==='thread.started'&&typeof events[0].provider_thread==='string'&&events[1].event==='turn.started'
  &&['error','turn.failed'].includes(events[2].event)&&events[2].item_type===null
  &&events[3].event==='process_closed'&&events[3].timed_out===false;
}
export function providerRecoverySource(records,s,config,baseline,correction,evidence,existing=null){
 const last=s.cache.at(-1),call=s.calls.at(-1),inv=s.reviewInvocation,b=inv?.registration?.binding;
 need(!existing&&correction?.epoch===1&&correction.developConsumed&&correction.reviewConsumed&&evidence?.authorization&&evidence.consumed
  &&s.calls.length===evidence.callsAtRegistration+1&&s.cache.filter(c=>c.effect.kind!=='complete').length===evidence.effectsAtRegistration+1
  &&s.receipts.length===evidence.receiptsAtRegistration&&s.attempt===2&&['blocked','pending_review'].includes(s.state)&&s.code==='review_provider_failed'&&s.receipt===null
  &&last?.effect.kind==='review'&&last.effect.id===evidence.authorization.reviewEffectId&&last.result.code==='review_provider_failed'
  &&call?.terminal==='failed'&&call.invocationId===b?.invocationId&&call.requestDigest===b.requestDigest
  &&strictProviderFailure(inv.result)&&inv.started===inv.result.inspection.providerThreadId
  &&b.packageDigest===s.reviewPackage?.packageDigest&&s.reviewPackage.packageDigest===evidence.reviewPackage.packageDigest
  &&digest(config)===evidence.source.configDigest&&baseline.baselineDigest===evidence.source.baselineDigest
  &&config.controlPolicy?.version===2&&config.controlPolicy.development==='conversation'&&config.controlPolicy.bootstrap==='disabled'
  &&config.controlPolicy.qaFix==='disabled'&&!config.bootstrap&&!config.parallelSelection&&!config.codeProjectPaths&&!config.binaryAssets
  &&!config.externalModels&&!config.executionPolicy&&config.developer.provider==='codex'&&config.developer.requestedModel==='current-session'
  &&config.reviewers.length===1&&config.reviewers[0].provider==='codex'
  &&!s.taskCommit&&!s.cancellationRequested&&!s.cancelAfterCommit&&!s.workflowError,'provider_recovery_unavailable');
 need(providerRecoveryExclusions(records,s,config).length<=MAX_REVIEW_EXCLUSIONS,'provider_recovery_exclusion_capacity');
 providerRecoveryCapacity(records,s,s.reviewPackage);
 const request=providerFailedRequest(s,config);
 const inspection=inspectProviderReviewFailure(JSON.stringify(inv.result.observation),JSON.stringify({request,
  developerThreadId:config.reviewInvocation.developerThreadId,excludedThreadIds:[]}));
 need(digest(inspection)===digest(inv.result.inspection),'provider_recovery_binding');
 const find=type=>records.findLast(r=>r.payload.type===type&&r.payload.invocationId===call.invocationId);
 const registered=records.findLast(r=>r.payload.type==='review-invocation-registered'&&r.payload.binding.invocationId===call.invocationId),started=find('review-invocation-started'),result=find('review-invocation-result');
 need(registered&&started&&result,'provider_recovery_binding');
 const fingerprints=config.completion.fingerprints;
 return readProviderRecoverySource({identity:b.identity,hostContextId:b.hostContextId,
  revision:digest({version:1,identity:{repositoryId:config.identity.repositoryId,runId:config.identity.runId},fingerprints,records}),
  fromDigest:records.at(-1).digest,configDigest:digest(config),baselineDigest:baseline.baselineDigest,scopeDigest:digest(config.scope),
  candidateDigest:digest({baseIdentity:s.reviewPackage.baseIdentity,scope:s.reviewPackage.scope,changes:s.reviewPackage.changes,unchangedScope:s.reviewPackage.unchangedScope??null}),
  packageDigest:s.reviewPackage.packageDigest,evidenceRegistrationDigest:evidence.recordDigest,evidenceAuthorizationDigest:evidence.authorizationDigest,
  failedEffectId:last.effect.id,failedCheckpointDigest:digest(last),invocationId:call.invocationId,requestDigest:call.requestDigest,
  registrationDigest:registered.digest,startedDigest:started.digest,resultDigest:result.digest,fingerprints});
}
export function providerFailedRequest(s,config){
 const b=s.reviewInvocation.registration.binding;
 const r=requestFor({invocationId:b.invocationId,identity:b.identity,role:'reviewer',provider:config.reviewers[0].provider,
  requestedModel:config.reviewers[0].requestedModel,contextId:config.reviewers[0].contexts[s.attempt-1],
  payload:{reviewPackage:s.reviewPackage,priorReview:s.priorReview}});
 need(r.requestDigest===b.requestDigest,'provider_recovery_binding');return r;
}
export function applyProviderRecovery(records,s,config,baseline,correction,evidence,existing,record){
 const expected=providerRecoverySource(records,s,config,baseline,correction,evidence,existing),request=providerRecoveryRequest(record.request);
 need(digest(request.source)===digest(expected)&&record.requestDigest===digest(request)&&record.reviewEffectId===PROVIDER_RECOVERY_EFFECT
  &&record.fromDigest===records.at(-1).digest&&typeof record.at==='string'&&new Date(record.at).toISOString()===record.at,'provider_recovery_binding');
 return {...s,state:'awaiting_review',code:null,reason:null,reviewInvocation:null};
}
export const providerRecoveryExhausted=(s,recovery)=>recovery?.consumed===true&&s.cache.at(-1)?.effect.id===recovery.record.reviewEffectId
 &&['blocked','pending_review','unknown'].includes(s.state)&&s.receipt===null;

export function providerRecoveryCapacity(records,state,pkg,authorization=true){
 const budget=evidenceCheckpointBudget(state,pkg);
 // One authorization + five review records + four original completion records
 // (intent, commit-intent, commit-result, checkpoint). Reserve bounded payloads
 // and both future review/completion checkpoints; global limits stay unchanged.
 need(records.length+(authorization?10:9)<=RECORD_LIMIT
  &&Buffer.byteLength(JSON.stringify({records}))+2*budget.futureCheckpointMaxBytes+2*1024*1024<=STATE_LIMIT,'provider_recovery_capacity');
 return budget;
}

export function providerRecoveryExclusions(records,state,config){
 return [...new Set([...config.reviewInvocation.excludedThreadIds,config.reviewInvocation.developerThreadId,
  ...records.filter(r=>r.payload.type==='host-joined').map(r=>r.payload.hostContextId),
  state.reviewInvocation?.registration?.binding?.hostContextId,
  ...state.calls.map(c=>c.providerThreadId)].filter(v=>typeof v==='string'))];
}
