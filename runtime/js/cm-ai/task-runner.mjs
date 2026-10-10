import {readExecutionPolicy} from './execution-policy.mjs';
import {readExternalModels} from './external-models.mjs';
import {beforeFirstQaRound,readQaConfigRevision} from './qa-config-revision.mjs';
import {readCloseoutPolicy} from './knowledge-closeout.mjs';
import {readQaAttachment} from './qa-attachment.mjs';
// Trusted synthetic fixture host; explicit V2 supports isolated task-file writes.
import { randomUUID } from 'node:crypto';
import { types } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {verifySpecificationMaterial,boundSpecificationMaterial,inspectSpecificationDrift,describeSpecificationDrift,
  readSpecificationRebind} from './specification-material.mjs';
import { captureReviewBaseline, captureReviewInventory, compareReviewBaseline, createReviewPackage, verifyReviewPackage, verifyCompletionReviewPackage, validChecks, readReviewSourceFiles } from './review-package.mjs';
import { digest,need,shape,id,text,json,freeze,arrayItems,validIdentity,validTaskLearningInput,validCallTimeout,requestFor,terminalFor,failureCode,
  JOURNAL_PAYLOAD_LIMIT,developCheckpointReserve,taskReviewScope,boundedReason } from './effect-contract.mjs';
import { reviewResult,reviewReceipt,boundReviewText,reviewPaths } from './review-runner.mjs';
import { checkCompletion } from './gate-bridge.mjs';
import { runnerPayload,runnerPayloadV3,readRunnerHistory,attemptBaseline,boundRunnerRecord,
  MAX_AI_JOINED_HOSTS,controlledState,stageAllowed,effectSlotFree,reviewTimeoutTransition,validateReviewDispatchGrant,validateTaskLearningReviewPackage,
  reviewRetrySpent,abandonableReviewResult,developBudget,developBudgetExhausted,
  MAX_REVIEW_REDISPATCHES,REVIEW_RETRY_CODES,reviewNotDispatchedExhausted,REVIEW_NOT_DISPATCHED_LIMIT_CODE,reviewNeverStartedStatus,reviewNotDispatchedLimitReason,reviewNotDispatchedExtendable,reviewDenialUnconfirmed,reviewDenialExhausted,reviewDenialConfirmable,reviewDenialLimitReason,
  REVIEW_DENIAL_LIMIT_CODE,REVIEW_DISPATCH_CONFIRM_REQUIRED_CODE,countReviewDispatchConfirmations,reviewRedispatchCount,reviewRedispatchable,reviewRedispatchExhausted,REVIEW_REDISPATCH_LIMIT_CODE,reviewRedispatchLimitReason,reviewRedispatchStopReason,reviewAbandonRefusal,
  completionBlockCount,completionRetriesExhausted,supersededReviewPayload,bootstrapReviewRecoverable,protectedDevelopScope,protectedScopeBlockReason,
  developTimeoutBasis,developTimeoutEffect,developTimeoutState,DEVELOP_CALL_TIMEOUT_REASON,
  developAnswerInvalidEffect,developAnswerRetryable,developAnswerInvalidReason,
  RECHECK_CODES,COMPLETE_RECHECK_CODE,developRecheckSource,developRecheckCode,developRecheckReason,
  completeRecheckSource,completeRecheckable,completeRecheckReason,
  DEVELOP_REDO_CODE,developAnswerMissingEffect,developRedoCause,developRedoRequiredReason,developRedoReason,
  DISPATCH_RETRY_CODE,developDispatchFailedEffect,developDispatchBasis,developDispatchReason,answerGapLimit,
  pendingDevelopStart,redoDevelopStart,workerGoneBinding,EFFECT_INTERRUPT_LIMIT_CODE,effectInterruptLimitReason,developRedoSource,COMMIT_INTERRUPTED_CODE,COMMIT_INTERRUPTED_REASON,
  DOCUMENTATION_SYNC_CODES,documentationSyncSource,documentationSyncRetryCode,documentationSyncStopReason } from './durable-runner-state.mjs';
import {splitDocumentationState} from './host-documentation.mjs';
import {readProcessStartTime,inspectWorkerGroup} from './worker-process-identity.mjs';
import {recoverRunnerCommitImage} from './task-commit.mjs';
import {commitRunnerFixture} from './task-commit.mjs';
import {inspectProviderReview,hasProviderReviewResult,inspectProviderReviewFailure} from './provider-review-observation.mjs';
import {attachCmAiTaskLearningApplicationEvidence,attachCmAiTaskLearningEvidence,
  readCmAiTaskLearningApplication} from './cm-ai-context-refresh.mjs';
import {readCmAiProjectLearningWriteback,writeCmAiProjectLearning} from './cm-ai-learning-writer.mjs';
import {verifyCmAiTaskLearningHandoff,writeCmAiTaskLearningHandoff} from './cm-ai-learning-handoff-writer.mjs';
import {implementationSha256,loadHandoff} from '../../../scripts/cm-task-gate.mjs';
import {createHostHandoff} from './host-handoff.mjs';
import {inspectFixCodeAssociation,explainCompletedDelivery} from './fix-code-association.mjs';
import {approvedReviewAt,completedReviewedDeliveries,fixReviewedAt,resolveDeliverySteps} from './reviewed-deliveries.mjs';
import {validateAcceptedFix} from './accepted-fix.mjs';
import {appendFits} from './execution-store-limits.mjs';
import {inspectCmAiQaFailure} from './cm-ai-qa-log.mjs';
import {readHostQaFixHistory} from './host-qa-fix.mjs';
import {publishHostReview} from './host-review-file.mjs';
import {reviewExclusions} from './effect-contract.mjs';
import {bootstrapConfiguration,readBootstrapEvidence} from './host-bootstrap.mjs';
import {validateCodeProjectPaths,assertCodeProjectSelections} from './code-projects.mjs';
import {readEvidenceSupersession} from './reviewed-evidence-supersession-record.mjs';
import {readReconciliationReceipt} from './review-reconciliation.mjs';

// Keep default V1 imports free of SQLite initialization/warnings. Native ownership
// is loaded synchronously only at the explicit V2 boundary (Node24.14+).
const requireNative=createRequire(import.meta.url);
const taskOwnerTarget=store=>requireNative('./task-owner.mjs').taskOwnerTarget(store);

const commitCapabilities=new WeakMap();
// This fixed resolver returns data, not a configurable journal port or issuer.
export function resolveFixtureCommit(token,store,action,payload) {
  const entry=commitCapabilities.get(token);
  need(entry!==undefined && entry.store===store,'commit_capability_invalid');
  need(action==='guard'?arguments.length===3:
    ['append-intent','append-result'].includes(action)&&arguments.length===4,'commit_phase_invalid');
  return entry.resolve(action,payload);
}

const NativePromise=Promise,promisePrototype=Promise.prototype,nativeThen=Promise.prototype.then;
const nativeSpecies=Object.getOwnPropertyDescriptor(NativePromise,Symbol.species);
function directPromiseObservation(value) {
  let object=value;
  for(let depth=0;object && depth<40;depth++,object=Object.getPrototypeOf(object)) {
    if(types.isProxy(object))return false;
    const descriptor=Object.getOwnPropertyDescriptor(object,'constructor');
    if(!descriptor)continue;
    if(!Object.hasOwn(descriptor,'value'))return false;
    if(descriptor.value===undefined)return true;
    if(descriptor.value!==NativePromise)return false;
    const species=Object.getOwnPropertyDescriptor(NativePromise,Symbol.species);
    return species && Reflect.ownKeys(species).length===Reflect.ownKeys(nativeSpecies).length
      && Reflect.ownKeys(nativeSpecies).every(key=>species[key]===nativeSpecies[key]);
  }
  return object===null;
}
// Observation is not admission. Bypass custom then/constructor/species hooks while
// attaching rejection cleanup, restoring any temporary descriptor before callbacks run.
// Immutable accessor-bearing containers are outside the trusted adapter contract;
// their producer must already own rejection handling (there is no safe JS escape hatch).
function observePromise(value,onFulfilled,onRejected) {
  const own=Object.getOwnPropertyDescriptor(value,'constructor');
  if(directPromiseObservation(value)) {
    Reflect.apply(nativeThen,value,[onFulfilled,onRejected]);return true;
  }
  if(!(own ? own.configurable || (Object.hasOwn(own,'value') && own.writable) : Object.isExtensible(value)))return false;
  try {
    if(own && !own.configurable)Object.defineProperty(value,'constructor',{value:undefined});
    else Object.defineProperty(value,'constructor',{value:undefined,configurable:true});
    Reflect.apply(nativeThen,value,[onFulfilled,onRejected]);return true;
  } finally {
    if(own)Object.defineProperty(value,'constructor',own);
    else Reflect.deleteProperty(value,'constructor');
  }
}
const ignorePromiseResult=()=>{};
// Reviewer budgets go up to 3,600,000 ms; the host adds its cleanup margin.
export const MAX_REVIEW_BOUND_MS=3600000+60000;
// What the user does next for each retryable reviewer failure class. The class
// itself is also journaled in reviewInvocation.result.inspection.failure.
const REVIEW_FAILURE_HINTS=Object.freeze({
  reviewer_auth_failed:'审查 CLI 未登录或凭证失效；先在本机重新登录审查 CLI，再恢复原 run 重派本轮审查',
  reviewer_billing_error:'审查账号额度或计费不可用；恢复额度后再恢复原 run 重派本轮审查',
  reviewer_rate_limited:'审查请求被限流或额度用尽；等额度恢复后再恢复原 run 重派本轮审查',
  reviewer_server_error:'审查服务端错误或过载；稍后恢复原 run 重派本轮审查',
  reviewer_model_not_found:'审查模型不存在或当前账号不可用；模型已绑定原 run 配置，确认账号可用该模型后恢复，换模型需新建运行',
  reviewer_api_error:'审查 API 返回错误且没有结论；核对审查 CLI 账号与网络后恢复原 run 重派本轮审查',
  reviewer_provider_failed:'审查进程报告失败且没有结论；核对审查 CLI 后恢复原 run 重派本轮审查',
  reviewer_exited:'审查进程没有给出结论就退出；核对审查 CLI 能否正常运行后恢复原 run 重派本轮审查',
  reviewer_stream_unrecognized:'审查 CLI 输出了无法识别的事件（常见于 CLI 升级）；核对 CLI 版本后恢复原 run 重派本轮审查',
  contradictory_verdict:'审查结论与 finding 等级矛盾：approved 不能带 P0–P2，changes_requested 至少要有一条 P0–P2；本轮结论作废并重派',
  invalid_finding_path:'审查 finding 的 path 不在 examinedPaths 或 handoff 路径内；本轮结论作废并重派',
  missing_material:'审查没有原样复制 examinedPaths；本轮结论作废并重派',
  review_package_mismatch:'审查没有原样复制 packageDigest；本轮结论作废并重派',
  invalid_finding_severity:'审查 finding 的 severity 不是 P0–P3；本轮结论作废并重派',
  invalid_finding_id:'审查 finding 的 id 不合格式；本轮结论作废并重派',
  invalid_finding_shape:'审查 finding 字段不全或重复；本轮结论作废并重派'});
const reviewFailureReason=failure=>`${failure}: ${REVIEW_FAILURE_HINTS[failure]??'审查失败且没有可用结论'}`;
// A verdict the review round ends on names why, instead of a bare code.
const verdictReason=(prefix,summary)=>`${prefix}：${String(summary).replace(/[\x00-\x1f\x7f]/g,' ').slice(0,300)}`;
const HALTED_SPEC_DRIFT='规格在本运行执行中途变化，运行已停在 blocked/spec_drift，不能继续或换绑。'
  +'出口：用 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做；本运行改动的代码需还原，或加 --accept-superseded-code-drift 作为已有代码记录。';
const safeReason=error=>{
  if(error===null||typeof error!=='object'||types.isProxy(error))return null;
  const descriptor=Object.getOwnPropertyDescriptor(error,'message');
  return descriptor&&Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='string'
    &&descriptor.value.length<=8192&&!/[\r\n\0]/.test(descriptor.value)?descriptor.value:null;
};

export function createTaskRunner(options) {
  const taskMode=options && Object.hasOwn(options,'taskCompletion');
  const requestedVersion=taskMode&&options?.persistence?.version;
  const invocationMode=requestedVersion===3;
  const optionKeys=['root','identity','scope','requirements','developer','reviewers','excludedContexts','check',taskMode?'taskCompletion':'commit'];
  if(options && Object.hasOwn(options,'timeoutMs'))optionKeys.push('timeoutMs');
  if(options && Object.hasOwn(options,'persistence'))optionKeys.push('persistence');
  if(options && Object.hasOwn(options,'taskLearning'))optionKeys.push('taskLearning');
  if(options && Object.hasOwn(options,'specification'))optionKeys.push('specification');
  if(options && Object.hasOwn(options,'bootstrap'))optionKeys.push('bootstrap');
  if(options && Object.hasOwn(options,'codeProjectPaths'))optionKeys.push('codeProjectPaths');
  if(options && Object.hasOwn(options,'verificationGate'))optionKeys.push('verificationGate');
  if(options && Object.hasOwn(options,'providerDevelopment'))optionKeys.push('providerDevelopment');
  if(options && Object.hasOwn(options,'protectedDevelopment'))optionKeys.push('protectedDevelopment');
  if(options && Object.hasOwn(options,'knowledgeCloseout'))optionKeys.push('knowledgeCloseout');
  if(options && Object.hasOwn(options,'executionPolicy'))optionKeys.push('executionPolicy');
  if(options && Object.hasOwn(options,'externalModels'))optionKeys.push('externalModels');
  if(invocationMode)optionKeys.push('reviewInvocation');
  shape(options,optionKeys);
  need(options.providerDevelopment===undefined||typeof options.providerDevelopment==='boolean','invalid_input');
  // Transient like providerDevelopment, never journaled: protected current-session
  // development applies proposals in a sandbox, so a stuck develop there may be a
  // partial write and gets no develop_redo exit (durable-runner-state.mjs).
  need(options.protectedDevelopment===undefined||typeof options.protectedDevelopment==='boolean','invalid_input');
  const {check,commit}=options;need(typeof check==='function' && (taskMode||typeof commit==='function'));
  // Opt-in gate between the task's own checks and the independent review. It may
  // only block: passing it grants nothing and never substitutes for that review.
  const verificationGate=options.verificationGate??null;
  need(verificationGate===null||typeof verificationGate==='function');
  if(taskMode)need(Object.hasOwn(options,'persistence'),'runner_completion');
  const config=json({root:options.root,identity:options.identity,scope:options.scope,requirements:options.requirements,
    ...(Object.hasOwn(options,'codeProjectPaths')?{codeProjectPaths:validateCodeProjectPaths(options.codeProjectPaths)}:{}),
    excludedContexts:options.excludedContexts,timeoutMs:Object.hasOwn(options,'timeoutMs')?options.timeoutMs:1000});
  if(config.codeProjectPaths)assertCodeProjectSelections(config.codeProjectPaths,[...config.scope,...config.requirements]);
  validIdentity(config.identity);need(config.identity.attempt===1);
  validCallTimeout(config.timeoutMs);
  need(Array.isArray(config.excludedContexts) && config.excludedContexts.length>0);config.excludedContexts.forEach(id);
  shape(options.developer,['provider','requestedModel','contextId','run']);
  const developer={...json({provider:options.developer.provider,requestedModel:options.developer.requestedModel,
    contextId:options.developer.contextId}),run:options.developer.run};
  id(developer.contextId);text(developer.requestedModel);need(['codex','claude'].includes(developer.provider) && typeof developer.run==='function');
  const candidates=arrayItems(options.reviewers);need(candidates.length<=2);
  const used=new Set([...config.excludedContexts,developer.contextId]),ids=new Set();
  const reviewers=candidates.map(r=>{
    shape(r,['id','provider','requestedModel','allowed','available','contexts','run',...(invocationMode?['adapterId']:[])]);
    const {run}=r,v=json({id:r.id,provider:r.provider,requestedModel:r.requestedModel,allowed:r.allowed,available:r.available,contexts:r.contexts});
    id(v.id);need(!ids.has(v.id));ids.add(v.id);text(v.requestedModel);
    need(['codex','claude'].includes(v.provider) && typeof v.allowed==='boolean' && typeof v.available==='boolean' && typeof run==='function');
    need(Array.isArray(v.contexts) && v.contexts.length===2);
    for(const c of v.contexts){id(c);need(!used.has(c),'not_independent');used.add(c);}
    if(invocationMode)id(r.adapterId);
    return {...v,...(invocationMode?{adapterId:r.adapterId}:{}),run};
  });
  let invocationConfig=null,authorize=null,liveHostContextId=null,reviewTimeoutMs=null;
  if(invocationMode){
    need(reviewers.length===1&&['codex','claude'].includes(reviewers[0].provider)&&reviewers[0].allowed&&reviewers[0].available,'runner_invocation');
    shape(options.reviewInvocation,['developerThreadId','excludedThreadIds','authorize',
      ...['hostContextId','timeoutMs'].filter(key=>Object.hasOwn(options.reviewInvocation,key))]);
    liveHostContextId=options.reviewInvocation.hostContextId??null;
    // Transient like hostContextId, never journaled: the host sizes the review
    // race above its reviewer's own budget, which a resumed run may raise.
    if(Object.hasOwn(options.reviewInvocation,'timeoutMs')){
      reviewTimeoutMs=options.reviewInvocation.timeoutMs;
      need(Number.isSafeInteger(reviewTimeoutMs)&&reviewTimeoutMs>=1&&reviewTimeoutMs<=MAX_REVIEW_BOUND_MS,'runner_invocation');
    }
    if(liveHostContextId!==null){id(liveHostContextId);
      need(![developer.contextId,...reviewers.flatMap(r=>r.contexts)].includes(liveHostContextId),'not_independent');}
    authorize=options.reviewInvocation.authorize;need(typeof authorize==='function','runner_invocation');
    invocationConfig=json({developerThreadId:options.reviewInvocation.developerThreadId,
      excludedThreadIds:options.reviewInvocation.excludedThreadIds});
    id(invocationConfig.developerThreadId);need(Array.isArray(invocationConfig.excludedThreadIds)
      &&invocationConfig.excludedThreadIds.length>0&&invocationConfig.excludedThreadIds.length<=32,'runner_invocation');
    const actual=new Set([invocationConfig.developerThreadId]);
    for(const thread of invocationConfig.excludedThreadIds){id(thread);need(!actual.has(thread),'runner_invocation');actual.add(thread);}
  }
  let metadata=json({...config,developer:{provider:developer.provider,requestedModel:developer.requestedModel,contextId:developer.contextId},
    reviewers:reviewers.map(({run,...r})=>r),...(invocationMode?{reviewInvocation:invocationConfig}:{}),
    ...(Object.hasOwn(options,'taskLearning')?{taskLearning:json(options.taskLearning)}:{}),
    ...(Object.hasOwn(options,'knowledgeCloseout')?{knowledgeCloseout:readCloseoutPolicy(options.knowledgeCloseout)}:{}),
    ...(Object.hasOwn(options,'executionPolicy')?{executionPolicy:readExecutionPolicy(options.executionPolicy)}:{}),
    ...(Object.hasOwn(options,'externalModels')?{externalModels:readExternalModels(options.externalModels)}:{})});
  const taskLearning=metadata.taskLearning??null;
  if(taskLearning!==null){need(taskMode,'runner_learning');
    shape(taskLearning,['feature',...(Object.hasOwn(taskLearning,'hostHandoff')?['hostHandoff']:[])]);
    text(taskLearning.feature);if(Object.hasOwn(taskLearning,'hostHandoff'))need(taskLearning.hostHandoff===true,'runner_learning');}
  const bootstrap=options.bootstrap??null;
  if(bootstrap!==null){
    need(taskMode&&taskLearning?.hostHandoff===true,'bootstrap_task_required');
    metadata=json({...metadata,bootstrap:bootstrapConfiguration(bootstrap,{root:config.root,identity:config.identity,
      scope:config.scope,feature:taskLearning.feature})});
  }
  let store=null,journal=null,restored=null,storeRevision=null,poisoned=false,parsedHistory=null;
  let completion=null,storeIdentity=null,storeOperating=false,liveToken=null,completeEffect=null,taskCommit=null;
  const version=taskMode?(invocationMode?3:2):1;
  if(Object.hasOwn(options,'persistence')) {
    shape(options.persistence,['store','mode',...(taskMode?['version']:[])]);store=options.persistence.store;
    if(taskMode){need(options.persistence.version===version,'runner_version');completion={owner:taskOwnerTarget(store)};}
    need(store && typeof store.snapshot==='function' && typeof store.append==='function');
    need(['create','resume'].includes(options.persistence.mode));
    const saved=store.snapshot();
    need(saved.identity.repositoryId===config.identity.repositoryId && saved.identity.runId===config.identity.runId,'identity_mismatch');
    journal=saved.records;storeRevision=saved.revision;
    if(taskMode){
      const selection=json(options.taskCompletion);shape(selection,['reviewsDir','handoffs']);
      const absolute=p=>need(typeof p==='string'&&!p.includes('\0')&&path.isAbsolute(p)&&path.resolve(p)===p,'unsupported_path');
      absolute(selection.reviewsDir);need(fs.realpathSync(selection.reviewsDir)===selection.reviewsDir
        &&fs.lstatSync(selection.reviewsDir).isDirectory(),'unsupported_path');
      need(Array.isArray(selection.handoffs)&&selection.handoffs.length===2);
      for(const [index,p] of selection.handoffs.entries()){absolute(p);
        if(taskLearning!==null)need(p===path.join(selection.reviewsDir,
          `${completion.owner.feature}-${config.identity.taskId}-a${index+1}-handoff.json`),'runner_completion');
        try{const s=fs.lstatSync(p);
        need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&fs.realpathSync(p)===p,'unsupported_file');
      }catch(error){if(error.code!=='ENOENT')throw error;}}
      completion=json({version:1,mode:'fixture-task',owner:completion.owner,fingerprints:saved.fingerprints,...selection});
      storeIdentity=saved.identity;metadata=json({...metadata,completion});
    }
    if(options.persistence.mode==='resume')parsedHistory=restored=readRunnerHistory(journal,metadata,version);
    else need(journal.length===0,'runner_exists');
  }
  // Transient live identity is deliberately absent from metadata/init bytes.
  const joinedHosts=[...(restored?.joinedHosts??[])];
  if(liveHostContextId!==null)need(!restored?.reviewerThreads.includes(liveHostContextId),'not_independent');
  const liveInvocation=()=>({...invocationConfig,excludedThreadIds:[...new Set([
    ...invocationConfig.excludedThreadIds,...joinedHosts,...(liveHostContextId===null?[]:[liveHostContextId])])]});
  const specificationSelection=options.specification??null;
  if(specificationSelection!==null){
    shape(specificationSelection,['specsRoot','feature']);
    need(completion&&specificationSelection.specsRoot===completion.owner.specsRoot
      &&specificationSelection.feature===taskLearning?.feature,'spec_drift');
  }
  const baselineOptions=()=>({...configToBaseline(metadata),
    ...(specificationSelection===null?{}:{specification:specificationSelection})});
  const original=restored?.original??captureReviewBaseline(baselineOptions());
  const controller=new AbortController(),calls=[],cache=new Map(),session=restored?.session??randomUUID(),registered=new Map(),receipts=[];
  let state=reviewers.some(r=>r.allowed&&r.available)?'ready':'pending_review',code=null,attempt=1;
  let busy=false,pending=null,sequence=0,base=original,reviewPackage=null,currentChecks=null,workflowRunning=false;
  let reason=null,checkNewPaths=null;
  let receipt=null,priorReview=null,cancelAfterCommit=false,workflowError=null,cancellationRequested=false,reviewInvocation=null;
  let learningResult=null;
  // Journaled supersession context: shown, never counted as a review verdict.
  let carriedReview=restored?.supersession?.carriedReview??null;
  const acceptedFixes=structuredClone(restored?.acceptedFixes??[]);
  let qaAttachment=restored?.qaAttachment??null;
  // A fresh ready-state capture carries the current material; represent an
  // accepted (identical or explicitly rebound) one by the bound material.
  const withBoundSpecification=fresh=>{
    if(!Object.hasOwn(fresh,'specification'))return fresh;
    const {baselineDigest,...data}={...fresh,specification:boundSpecificationMaterial(original,fresh.specification)};
    return {...data,baselineDigest:digest(data)};
  };
  const handoffBinding=(pkg=reviewPackage)=>pkg&&Object.hasOwn(pkg,'handoff')
    ?{handoffPath:completion.handoffs[pkg.identity.attempt-1]}:{};
  function publishRegisteredReview(inspectOnly=false){
    if(!invocationMode||taskLearning?.hostHandoff!==true||!receipt||!reviewPackage?.handoff)return;
    need(inspectOnly||!busy,'busy');
    publishHostReview({reviewsDir:completion.reviewsDir,feature:completion.owner.feature,inspectOnly,
      ...handoffBinding(),reviewPackage,receipt,registered:registered.get(receipt.id),
      at:reviewInvocation.registration.registeredAt});
  }
  // A develop effect the host gate blocked keeps its audit entry like any other,
  // so the next corrected delivery needs a new effect id or it would just read
  // the blocked result back out of the cache. Counting them here keeps that
  // derivation in one place, next to the cache it is derived from.
  const verificationBlocks=()=>[...cache.values()].filter(entry=>entry.effect.kind==='develop'
    &&entry.result?.state==='blocked'
    &&['verification_precheck_failed','check_output_out_of_scope','develop_checks_not_passed','develop_unchanged_after_review','develop_empty_changes','develop_requirement_missing','develop_package_too_large','bootstrap_verification_failed','bootstrap_instruction_conflict','develop_call_timeout'].includes(entry.result?.code)
    ||developTimeoutEffect(entry)||developAnswerInvalidEffect(entry)||developRecheckSource(entry)||developRedoSource(entry)||developDispatchFailedEffect(entry)
    ||documentationSyncSource(entry)).length;
  const completionBlocks=()=>[...cache.values()].filter(entry=>entry.effect.kind==='complete'
    &&entry.result?.state==='blocked'&&['completion_checks_changed','completion_package_changed'].includes(entry.result?.code)
    ||completeRecheckSource(entry)).length;
  const privateStatus=()=>json({state,code,...(reason?{reason}:{}),
    ...(!(metadata.externalModels||metadata.executionPolicy)&&state==='unknown'&&restored?.pending
      &&(restored.pendingAbandonable||restored.pendingInterruptible||restored.pendingReviewExhausted||restored.pendingWorkerVoidable)
      ?{pendingEffectKind:restored.pending.kind}:{}),
    // Q16: this interruption is a documentation retry; abandon_effect resends only documentation_sync.
    ...(!(metadata.externalModels||metadata.executionPolicy)&&state==='unknown'&&restored?.pending?.kind==='develop'
      &&restored.pendingInterruptible&&restored.pendingDocumentation!=null?{documentationSyncPending:true}:{}),
    // R2: the interruption cap is spent; abandon_effect now only voids the run.
    ...(state==='unknown'&&restored?.pending&&restored.pendingInterruptLimit
      ?{code:EFFECT_INTERRUPT_LIMIT_CODE,reason:effectInterruptLimitReason(restored.pending.kind)}:{}),
    ...(!(metadata.externalModels||metadata.executionPolicy)&&state==='unknown'&&restored?.pending?.kind==='review'
      &&restored.state.reviewInvocation?.registration&&(restored.state.reviewInvocation.result===null||restored.pendingResultAbandonable)
      ?{pendingReviewInvocation:true}:{}),
    identity:{...config.identity,attempt},packageDigest:reviewPackage?.packageDigest??null,
    receipt,receipts,calls,cancelAfterCommit,workflowError,...(store?{cancellationRequested}:{}),...(taskMode?{taskCommit}:{}),
    ...(invocationMode?{reviewInvocation}:{}),...(taskLearning!==null?{learningWriteback:learningResult?.writeback??null}:{})},16*1024*1024);
  // Other task runs' committed, reviewed deliveries in this specs root, only
  // those reviewed after this run's own approving review, and the live proof
  // that recorded interleaving steps are exactly such deliveries.
  const laterDeliveries=()=>completedReviewedDeliveries({specsRoot:completion.owner.specsRoot,root:config.root,identity:config.identity});
  const reviewedAt=()=>approvedReviewAt({reviewInvocation,reviewPackage});
  const resolveSteps=(steps,allowAbsent=false)=>resolveDeliverySteps({specsRoot:completion.owner.specsRoot,root:config.root,
    identity:config.identity,after:reviewedAt(),steps,allowAbsent});
  // This run's own QA fixes take their place in the same order at the final
  // review time their completion evidence cites (evidence: a fix not yet accepted).
  const fixTime=(evidence=null)=>fix=>{
    const cited=[...acceptedFixes.map(item=>item.evidence),...(evidence?[evidence]:[])]
      .find(item=>item.reviewPackage.packageDigest===fix.packageDigest);
    return cited?fixReviewedAt(completion.owner.specsRoot,cited):null;
  };
  const laterOptions=(evidence=null)=>({deliveries:laterDeliveries,after:reviewedAt(),fixTime:fixTime(evidence)});
  let publication;
  let pendingReconciliation=null;
  // Replay decides; this only reports an exit abandonReview would accept.
  function reviewResultAbandonable(){
    return !(metadata.externalModels||metadata.executionPolicy)&&invocationMode&&store&&!busy&&!poisoned&&state==='unknown'&&!restored?.pending
      &&abandonableReviewResult({state,attempt,cache:[...cache.values()],calls,reviewInvocation},reviewers[0].contexts[attempt-1],reviewRedispatchRecords());
  }
  // V5 (A34): review-redispatch records of this round (written by abandon_review).
  function reviewRedispatchRecords(){
    return journal?.filter(row=>row.payload.type==='review-redispatch'&&row.payload.attempt===attempt).length??0;
  }
  // The review effect ids of the current round: the entry derives the next redispatch id from
  // them, never from reviewInvocation (a refused authorization leaves it at the previous round's
  // value), so an id can never repeat one the cache holds.
  const reviewEffectIds=()=>[...cache.values()].filter(entry=>entry.effect.kind==='review'
    &&entry.effect.identity.attempt===attempt).map(entry=>entry.effect.id);
  // Confirmations of this round (abandon_review on a review that never started).
  const reviewDispatchConfirmations=()=>countReviewDispatchConfirmations((journal??[]).map(row=>row.payload),attempt);
  // A spent retryable review block this round may still redispatch (advance).
  const reviewRedispatchLive=()=>Boolean(!(metadata.externalModels||metadata.executionPolicy)&&invocationMode&&store&&!busy&&!poisoned
    &&!restored?.pending&&reviewRedispatchable({state,code,attempt,cache:[...cache.values()],calls,reviewInvocation},
      reviewers[0].contexts[attempt-1],reviewRedispatchRecords()));
  const reviewRedispatchSpent=()=>Boolean(!(metadata.externalModels||metadata.executionPolicy)&&invocationMode&&store&&!busy&&!poisoned
    &&!restored?.pending&&reviewRedispatchExhausted({state,code,attempt,cache:[...cache.values()],calls,reviewInvocation},
      reviewers[0].contexts[attempt-1],reviewRedispatchRecords()));
  // A develop cut off by the host answer limit (unknown/call_timeout) whose
  // start the journal pins, checked against the code root now: true only when
  // nothing of it reached the disk. Never journaled by status; advance records
  // develop-timeout-retry before redoing the round (see executeEffect).
  function developTimeoutRetryBasis(){
    if(!store||!taskMode||busy||poisoned||!developTimeoutState({state,code})||restored?.pending&&!cache.has(restored.pending.id))return null;
    const basis=developTimeoutBasis({state,code,attempt,cache:[...cache.values()],calls,reviewPackage,priorReview},metadata.bootstrap);
    if(basis===null)return null;
    try{
      if(basis==='reviewed_package')verifyReviewPackage({root:config.root,baseline:attemptBaseline(original,reviewPackage.identity.attempt),
        checks:reviewPackage.checks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      else assertReadyBaseline();
    }catch{return null;}
    return basis;
  }
  // A journaled blocked/failed develop whose current-session answer failed local
  // validation: shown as the retryable block; advance journals develop-answer-retry.
  const answerRetryable=()=>Boolean(store&&taskMode&&!busy&&!poisoned&&!(restored?.pending&&!cache.has(restored.pending.id))
    &&developAnswerRetryable({state,code,attempt,cache:[...cache.values()]},metadata.bootstrap));
  // V3 answer gaps (durable-runner-state.mjs): a delivered develop or a complete
  // whose later re-check never got a usable answer. Status shows the retryable
  // block; advance journals develop-recheck / complete-recheck first.
  const answerGapCount=type=>journal?.filter(row=>row.payload.type===type).length??0;
  const gapsLive=()=>Boolean(store&&taskMode&&invocationMode&&!busy&&!poisoned&&!(restored?.pending&&!cache.has(restored.pending.id)));
  const developRecheck=()=>gapsLive()?developRecheckCode({state,code,attempt,cache:[...cache.values()],learningResult,receipt},
    metadata,answerGapCount('develop-recheck')):null;
  const completeRecheck=()=>gapsLive()&&completeRecheckable({state,code,attempt,cache:[...cache.values()],taskCommit},
    answerGapCount('complete-recheck'));
  // V2 + R3: a stuck current-session develop that only an operator confirmation
  // (develop_redo) may redo. Returns the cause or null.
  // Provider development (V9) qualifies only with its worker identity journaled.
  const providerRun=developer.requestedModel!=='current-session';
  const developRedoRequired=()=>{
    if(!gapsLive()||!providerRun&&(options.protectedDevelopment===true||options.providerDevelopment===true))return null;
    return developRedoCause({state,code,attempt,cache:[...cache.values()],calls,receipt},metadata,
      answerGapCount('develop-answer-redo'),parsedHistory?.workers??null);
  };
  // Q16/Q17: the final task's develop journals the developer answer it accepted
  // and the documentation start (documentation-sync-started) right before the
  // adapter asks documentation_sync, and marks its developer call with the
  // record. A sync that then fails is redone alone, from that record.
  const documentationJournaling=()=>Boolean(invocationMode&&store&&taskMode&&bootstrap===null&&!metadata.bootstrap);
  function journalDocumentationSync(effectId,raw){
    const event=json(raw,512*1024);shape(event,['result','effectiveModel','documents','othersDigest']);
    const call=calls.at(-1);need(call?.terminal==='running'&&!Object.hasOwn(call,'documentationSync'),'invalid_input');
    const record=persist('documentation-sync-started',{effectId,invocationId:call.invocationId,...event});
    call.documentationSync=record.digest;
  }
  const documentationRecord=value=>journal?.find(row=>row.digest===value&&row.payload.type==='documentation-sync-started')?.payload??null;
  // The run's documentation-sync retries so far, as the journal counts them.
  const documentationRetries=()=>parsedHistory?.answerGaps?.documentationSync??0;
  // The checkpointed documentation_sync failure the last develop left, still
  // waiting for its stop confirmation, with its start record; or null.
  function documentationSyncRetry(){
    if(!gapsLive()||!documentationJournaling()||options.providerDevelopment===true)return null;
    const retry=documentationSyncRetryCode({state,code,attempt,cache:[...cache.values()]},metadata,documentationRetries());
    const source=retry===null?null:documentationRecord(calls.at(-1)?.documentationSync);
    return source?{code:retry,source,detail:[...cache.values()].at(-1).result.reason??null}:null;
  }
  // The latest stop confirmation for the source call: documentation-sync-retry
  // (develop_redo) or effect-interrupted (abandon_effect), bound to its start.
  const documentationStopRecord=start=>journal?.findLast(row=>['documentation-sync-retry','effect-interrupted'].includes(row.payload.type)
    &&row.payload.startDigest===start)?.payload??null;
  // A confirmed documentation block: what the redo reuses and is checked against.
  function documentationRedoSource(){
    if(!gapsLive()||!documentationJournaling()||state!=='blocked'||!DOCUMENTATION_SYNC_CODES.includes(code))return null;
    const start=calls.at(-1)?.documentationSync,source=documentationRecord(start),stop=documentationStopRecord(start);
    return source&&stop?{code,source,stop}:null;
  }
  // The Learning input of the develop effect whose sync is redone (checkpointed
  // or interrupted): the redo reuses its developer answer, so it binds the same.
  const documentationRedoLearningInput=()=>{
    const stop=documentationRedoSource()?.stop;
    return journal.findLast(row=>row.payload.type==='effect-intent'&&row.payload.effect.id===stop?.effectId)?.payload.effect.learningInput;
  };
  // The code root under the task's own fixed snapshot rules (the full develop
  // scope and the ignore policy bound at create, as the task baseline), split
  // at the documentation paths. The adapter takes its start and end with it too.
  function documentationSnapshot(paths){
    const baseline=captureReviewBaseline({...configToBaseline(metadata),version:original.version,
      ...(Object.hasOwn(original,'specification')?{specification:{specsRoot:original.specificationRoot,feature:original.specification.feature}}:{})},
      !Object.hasOwn(original,'ignorePolicy'),original.ignorePolicy?.version??2,
      original.ignorePolicy?.version===2?original.ignorePolicy:null);
    return splitDocumentationState(baseline.files,paths);
  }
  const documentationRefusal=(refusal,detail)=>Object.assign(new Error(refusal),{code:refusal,reason:{
    documentation_sync_out_of_scope:`documentation_sync_out_of_scope: 文档路径以外的文件已不等于文档同步开始时的内容${detail?`（${detail.replace(/^out_of_scope:\s*/,'')}）`:''}，`
      +'可能是文档同步越界写的，也可能是之后的改动。先把它们还原到文档同步开始时的内容（git diff 查看差异；确需修改先走规格变更），再 advance 只重发文档同步。',
    documentation_sync_stop_required:'documentation_sync_stop_required: 宿主无法证明文档同步的写入方已停止；先确认会话已停止修改文档，再以 --mode resume --allow-develop-redo 发送 develop_redo，之后 advance 只重发文档同步。',
    documentation_sync_changed_after_stop:'documentation_sync_changed_after_stop: 文档路径在确认停写之后又变了，旧的文档同步可能仍在写。若是你自己的修改，确认会话已停后再发送一次 develop_redo 重新确认（不另占次数），再 advance；否则先让会话停下。',
    documentation_sync_capture_failed:`documentation_sync_capture_failed: 宿主无法读取代码根来核对文档同步的起点（${detail}）；修好后再试。`}[refusal]});
  // The live documentation state, or the refusal when the code root cannot be read.
  function documentationLive(paths){
    try{return documentationSnapshot(paths);}
    catch(error){throw documentationRefusal('documentation_sync_capture_failed',failureCode(error));}
  }
  // The disk gate before every documentation-only redo (also after a restart):
  // the rest of the code root equals the documentation start, and the
  // documentation paths equal what they were when the stop was confirmed.
  function assertDocumentationRedo(redo){
    const live=documentationLive(redo.source.documents.map(item=>item.path));
    if(live.othersDigest!==redo.source.othersDigest)throw documentationRefusal('documentation_sync_out_of_scope',
      redo.code==='documentation_sync_out_of_scope'?[...cache.values()].at(-1)?.result.reason??null:null);
    if(digest(live.documents)!==digest(redo.stop.documents))throw documentationRefusal('documentation_sync_changed_after_stop');
  }
  // V9: provider development journals its worker's identity (develop-worker):
  // spawning right before the spawn, started (pid = process group, start time)
  // right after. A throw here makes the spawn wrapper kill the new group.
  // Protected development also journals each sandbox subprocess that applies a
  // proposal (apply_spawning / apply_started): it may outlive a dead host too.
  const workerJournaling=()=>Boolean(invocationMode&&store&&taskMode
    &&(developer.requestedModel!=='current-session'||options.protectedDevelopment===true));
  function journalWorker(effectId,raw){
    const event=json(raw),started=['started','apply_started'].includes(event?.phase);
    shape(event,['phase',...(started?['pid']:[])]);
    need(['spawning','started','apply_spawning','apply_started'].includes(event.phase),'invalid_input');
    persist('develop-worker',{effectId,invocationId:calls.at(-1).invocationId,phase:event.phase,
      ...(started?{pid:event.pid,startTime:readProcessStartTime(event.pid)}:{})});
  }
  // The host's proof for a provider develop: 'none' (never spawned), 'gone',
  // or a refusal code. Windows, permission errors and unreadable start times
  // are unknown, never gone.
  // checkpointed: the host was alive after the spawn, so a spawned child with a
  // pid was journaled in the same tick; spawning alone then means no process.
  // Every started writer is checked: the provider worker and each proposal
  // apply subprocess.
  function workerProof(worker,{checkpointed=false}={}){
    if(worker?.journal!==true)return {code:'worker_identity_unrecorded'};
    if(!checkpointed&&(worker.spawned&&worker.started===null||worker.applies.some(item=>item.started===null)))
      return {code:'worker_identity_incomplete'};
    const binding=workerGoneBinding(worker);
    if(binding===null)return {proof:'none'};
    for(const started of [worker.started,...worker.applies.map(item=>item.started)].filter(Boolean)){
      const verdict=inspectWorkerGroup(started);
      if(verdict!=='gone')return {code:verdict==='alive'?'worker_process_alive':'worker_process_unknown',pid:started.pid};
    }
    return {proof:'gone',binding};
  }
  // V6: where writes are applied proposals, the live root must still equal the
  // journal-pinned round start (no partial apply is sent to review).
  function verifyRoundStart(basis,prefix,what){
    const refuse=(code,detail)=>{throw Object.assign(new Error(code),{code,reason:detail});};
    if(basis===null)refuse(`${prefix}_root_unpinned`,`${what}的本轮起点无法从运行存档确定（本轮之前已有被拦下的交付），宿主不能证明中途没有写到一半；核对后用新建运行替代。`);
    try{
      if(basis==='reviewed_package')verifyReviewPackage({root:config.root,baseline:attemptBaseline(original,reviewPackage.identity.attempt),
        checks:reviewPackage.checks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      else assertReadyBaseline();
    }catch(error){refuse(`${prefix}_root_changed`,boundedReason(`${what}中途退出后代码根已不等于本轮起点（可能是应用到一半的提案）：`,
      [safeReason(error)??error?.code??'changed'],'。把这些文件还原到本轮起点后重试；半成品不会被当成新交付送审。'));}
    return basis;
  }
  const workerRefusal=(prefix,result)=>({code:`${prefix}_${result.code}`,reason:{
    worker_identity_unrecorded:'这次 provider 开发没有在运行存档里记下 worker 进程身份（旧版本建的 effect，或未配置 provider 模型），宿主无法证明进程已退出；按 reason 手工核对后只能新建运行替代。',
    worker_identity_incomplete:'运行存档只记到 worker 即将启动，没有记下 pid，宿主无法证明进程已退出；请手工确认该 provider 进程已不存在后，用新建运行替代。',
    worker_process_alive:`provider worker 或提案应用子进程的进程组（pid ${result.pid}）仍在运行，可能还在写文件；等它退出或手工结束该进程组后再试。`,
    worker_process_unknown:`宿主无法核对进程组（pid ${result.pid}）是否已退出（Windows、无权限或读不到启动时间），不放行；确认进程已退出后在能核对的环境重试。`}[result.code]});
  // P1-3: a develop that failed before dispatch. A legacy execution_error also
  // needs the live code root to still equal the journal-pinned round start.
  function developDispatchRetry(){
    if(!gapsLive()||options.providerDevelopment===true)return null;
    const basis=developDispatchBasis({state,code,attempt,cache:[...cache.values()],calls,receipt,reviewPackage,priorReview},
      metadata,answerGapCount('develop-dispatch-retry'));
    if(basis===null)return null;
    try{
      if(basis==='reviewed_package')verifyReviewPackage({root:config.root,baseline:attemptBaseline(original,reviewPackage.identity.attempt),
        checks:reviewPackage.checks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      else assertReadyBaseline();
    }catch{return null;}
    return basis;
  }
  // A45: the host died between task-commit-intent and task-commit-result. Only
  // the journaled commit plan is followed (recoverCommit); complete is never redone.
  // A result already journaled (a recovery that died before its checkpoint)
  // closes the same effect with the checkpoint only.
  const commitRecoveryTransaction=()=>!invocationMode||!store||busy||poisoned||restored?.pending?.kind!=='complete'
    ||!restored.transaction?null:restored.transaction;
  // The Learning input a re-check must carry: exactly the delivered develop's.
  // A documentation-only redo reuses that develop's answer, so it carries the
  // input bound to it too (a LESSONS.md edited meanwhile changes a fresh read).
  const recheckLearningInput=()=>{
    if(RECHECK_CODES.includes(status().code))return json([...cache.values()].at(-1).effect.learningInput);
    const bound=documentationRedoSource()===null?undefined:documentationRedoLearningInput();
    return bound===undefined?null:json(bound);
  };
  const status=()=>{
    let current=store?publication:privateStatus();
    if(current.state==='unknown'&&commitRecoveryTransaction()!==null){
      const {reason:discard,...rest}=current;
      current=freeze({...rest,state:'blocked',code:COMMIT_INTERRUPTED_CODE,reason:COMMIT_INTERRUPTED_REASON});
    }
    if(current.state==='unknown'){
      const recheck=developRecheck();
      if(recheck!==null)current=freeze({...current,state:'blocked',code:recheck,reason:developRecheckReason(recheck,current.code,current.reason)});
      else if(completeRecheck())current=freeze({...current,state:'blocked',code:COMPLETE_RECHECK_CODE,reason:completeRecheckReason(current.code)});
    }
    if(current.state==='blocked'&&current.code==='failed'&&answerRetryable())
      current=freeze({...current,code:'develop_answer_invalid',reason:developAnswerInvalidReason(calls.at(-1).failureResult)});
    if(developTimeoutState(current)){
      const {reason:discard,...rest}=current;
      current=developTimeoutRetryBasis()!==null
        ?freeze({...rest,state:'blocked',code:'develop_call_timeout',reason:DEVELOP_CALL_TIMEOUT_REASON})
        :freeze({...rest,state:'unknown',code:'call_timeout',...(current.state==='blocked'
          ?{reason:'develop_call_timeout: 代码根已不等于本轮开发起点（超时后有写入），不能重发；按 unknown 只读核对。'}:{})});
    }
    if(current.state==='unknown'){
      const basis=developDispatchRetry();
      if(basis!==null){const {reason:discard,...rest}=current;
        current=freeze({...rest,state:'blocked',code:DISPATCH_RETRY_CODE,reason:developDispatchReason(current.code)});}
    }
    // The journaled block keeps its start binding: a changed root falls to develop_redo below.
    if(current.state==='blocked'&&current.code===DISPATCH_RETRY_CODE&&developDispatchRetry()===null){
      const {reason:discard,...rest}=current;current=freeze({...rest,state:'unknown',code:[...cache.values()].at(-1).result.code});
    }
    // Q16/Q17: a failed documentation_sync of the final task (never develop_redo).
    if(current.state==='unknown'){
      const retry=documentationSyncRetry();
      if(retry!==null){
        const {reason:discard,...rest}=current;
        current=freeze({...rest,state:'blocked',code:retry.code,reason:documentationSyncStopReason(retry.code,retry.detail),developRedoRequired:true});
      }
    }
    if(current.state==='unknown'||current.state==='blocked'&&['failed','unavailable'].includes(current.code)){
      const cause=developRedoRequired();
      if(cause!==null){const {reason:discard,...rest}=current;
        current=freeze({...rest,state:'blocked',code:DEVELOP_REDO_CODE,reason:developRedoRequiredReason(cause),developRedoRequired:true});}
    }
    // R2: a spent exit is an explicit limit block, never an exit-less unknown.
    if((current.state==='unknown'||current.state==='blocked'&&['failed','unavailable'].includes(current.code))&&gapsLive()
      &&(options.providerDevelopment!==true||providerRun)){
      const limit=answerGapLimit({state,code,attempt,cache:[...cache.values()],calls,receipt,learningResult,taskCommit,reviewPackage,priorReview},
        metadata,{developRecheck:answerGapCount('develop-recheck'),completeRecheck:answerGapCount('complete-recheck'),
          developRedo:answerGapCount('develop-answer-redo'),developDispatch:answerGapCount('develop-dispatch-retry'),
          documentationSync:documentationRetries(),
          workers:parsedHistory?.workers??null});
      if(limit!==null&&(options.providerDevelopment===true?limit.code==='develop_redo_limit'
        :!(options.protectedDevelopment===true&&limit.code==='develop_redo_limit'))){
        const {reason:discard,...rest}=current;current=freeze({...rest,state:'blocked',code:limit.code,reason:limit.reason});}
    }
    if(!busy&&!poisoned&&bootstrapReviewRecoverable(frame(),restored?.pending??null,metadata.bootstrap))
      current=freeze({...current,bootstrapReviewRecovery:true});
    // V5: a spent retryable review block with a no-result redispatch left stays
    // blocked until the operator confirms the original reviewer stopped
    // (abandon_review journals review-redispatch); a fully spent round is an
    // explicit limit block.
    if(current.state==='blocked'&&reviewRedispatchLive())
      current=freeze({...current,reviewRedispatchStopRequired:true,reason:reviewRedispatchStopReason(current.code)});
    else if(current.state==='blocked'&&reviewRedispatchSpent())
      current=freeze({...current,code:REVIEW_REDISPATCH_LIMIT_CODE,reason:reviewRedispatchLimitReason(current.code)});
    // A round whose review never started: a refused authorization (explicit confirmation
    // needed) or registrations voided before dispatch three times. Shared with replay.
    if(!busy&&current.state==='pending_review'){
      const never=reviewNeverStartedStatus({state,code,attempt,cache:[...cache.values()]},reviewDispatchConfirmations());
      if(never!==null)current=freeze({...current,...never});
    }
    // Status only; never part of a cached result or checkpoint.
    if(current.state==='unknown'&&reviewResultAbandonable())current=freeze({...current,abandonableReviewResult:true});
    else if(current.state==='unknown'&&!(metadata.externalModels||metadata.executionPolicy)&&invocationMode&&store&&!busy&&!poisoned&&!restored?.pending){
      const refusal=reviewAbandonRefusal({state,attempt,cache:[...cache.values()],calls,reviewInvocation},reviewers[0].contexts[attempt-1],reviewRedispatchRecords());
      if(refusal)current=freeze({...current,reason:`${refusal.code}: ${refusal.reason}`,reviewAbandonRefusal:refusal.code});
    }
    const available=Boolean((metadata.externalModels||metadata.executionPolicy))&&!busy&&!poisoned&&invocationMode&&store&&['unknown','pending_review'].includes(current.state)
      &&readRunnerHistory(journal,metadata,3).reviewReconciliation!==null;
    if((metadata.externalModels||metadata.executionPolicy)&&!busy&&!poisoned&&invocationMode&&store&&reviewInvocation?.registration
      &&(available||current.state==='unknown'&&reviewInvocation.result?.reconciliationRequired!==false)){
      const grant=reviewInvocation.registration.grant;
      current=freeze({...current,reviewReconciliation:{invocationId:grant.invocationId,requestDigest:grant.requestDigest,
        provider:reviewers[0].provider,providerThreadId:reviewInvocation.started,available},
        reason:available?'原调用的终态与本地清理收据已保存；使用 reconcile_review 接纳证据，此操作不派发模型。'
          :'缺少原调用的可信终态或本地清理证据。保留本 run、attempt、journal 和快照；按 invocationId / providerThreadId 向原宿主或 provider 核对结果及终止状态，并确认本地后代已退出。当前适配器没有远端状态查询入口，人工说明、PID 消失或重启均不能解锁；不要删 journal、换 runId 或重派。'});
    }
    if(!busy&&!poisoned)try{publishRegisteredReview(true);}
    catch{return freeze({...current,code:'review_publication_required'});}
    // Every next effect re-verifies the bound specification. When it no longer
    // verifies, report that and its real exits instead of the refused action.
    if(!busy&&!poisoned&&specificationLive(current.state,current.code)){
      const drift=inspectSpecificationDrift(original);
      if(drift)return freeze({...current,code:'spec_drift',reason:describeSpecificationDrift(drift),
        specificationRebind:drift.rebindable?'available':'unavailable'});
    }
    if(current.state==='blocked'&&current.code==='spec_drift'&&!current.reason)
      return freeze({...current,reason:HALTED_SPEC_DRIFT});
    if(!busy&&reviewPackage&&(['awaiting_review','approved','changes_requested'].includes(current.state)
      ||current.state==='blocked'&&['review_package_changed','completion_package_changed'].includes(current.code))){
      try{
        verifyReviewPackage({root:config.root,baseline:attemptBaseline(original,reviewPackage.identity.attempt),
          checks:currentChecks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
        if(current.state==='blocked'&&current.code==='review_package_changed'){
          const {reason:oldReason,...rest}=current;
          if(priorReview?.verdict==='approved')return freeze({...rest,state:'approved',code:null});
          if(priorReview?.verdict==='changes_requested'&&attempt===2&&reviewPackage.identity.attempt===1)
            return freeze({...rest,state:'changes_requested',code:null});
          return freeze({...rest,state:'blocked',code:priorReview?.verdict==='changes_requested'?'review_limit':'review_blocked'});
        }
        if(current.code==='completion_package_changed')return freeze({...current,retryReady:true});
      }catch(error){return freeze({...current,state:'blocked',
        code:current.code==='completion_package_changed'?'completion_package_changed':'review_package_changed',
        ...(current.code==='completion_package_changed'?{retryReady:false}:{}),reason:error.message});}
    }
    if(current.state!=='fixture_completed')return current;
    try {
      if(acceptedFixes.length){
        for(const item of acceptedFixes){
          const {handoffDigest,...binding}=item.evidence.qaSource;
          const history=readHostQaFixHistory({...binding,specsDir:completion.owner.specsRoot,codeProject:config.root});
          need(history.handoffDigest===handoffDigest,'fix_qa_source_changed');
        }
        inspectFixCodeAssociation({root:config.root,specsRoot:completion.owner.specsRoot,baseline:base,
          parentPackage:reviewPackage,fixPackages:acceptedFixes.map(item=>item.evidence.reviewPackage),
          steps:acceptedFixes.at(-1).association.laterDeliveries??[],...laterOptions()});
        const last=acceptedFixes.at(-1);
        return freeze({...current,acceptedQaFix:{qaRound:last.qaRound,testRunId:last.evidence.qaSource.testRunId,
          evidenceDigest:digest(last)}});
      }
      try{verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
        reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});}
      catch(error){
        // The exact reviewed tree no longer holds. A committed task may still be
        // intact under later, separately reviewed deliveries of other runs.
        if(!completion)throw error;
        if(reviewPackage.handoff){
          const handoff=handoffBinding().handoffPath;
          need(digest(readReviewSourceFiles(path.dirname(handoff),[path.basename(handoff)])[0])===digest(reviewPackage.handoff),'package_mismatch');
        }
        explainCompletedDelivery({root:config.root,baseline:base,parentPackage:reviewPackage,deliveries:laterDeliveries(),after:reviewedAt()});
      }
      return current;
    } catch(error){
      return freeze({...current,code:'correction_review_required',...(error?.code==='fix_current_code_unexplained'
        ?{reason:`未经审查的改动：${error.paths.slice(0,20).join(', ')}${error.paths.length>20?` 等 ${error.paths.length} 个路径`:''}`}
        :error?.code==='fix_association_unverified'?{reason:'已登记 QA 修复所接续的后续交付无法按其运行存档核实（存档缺失、未完成或内容不符）'}:{})});
    }
  };
  const halt=(next,why,detail=null)=>{state=next;code=why;reason=detail;};
  function assertReadyBaseline(){
    compareReviewBaseline(withBoundSpecification(captureReviewBaseline({...configToBaseline(metadata),version:original.version,
      ...(Object.hasOwn(original,'specification')?{specification:{specsRoot:original.specificationRoot,feature:original.specification.feature}}:{})},
      !Object.hasOwn(original,'ignorePolicy'),original.ignorePolicy?.version??2,
      original.ignorePolicy?.version===2?original.ignorePolicy:null)),original);
  }
  const specificationLive=(currentState,currentCode)=>Object.hasOwn(original,'specification')
    &&['develop','review','complete'].some(kind=>stageAllowed(kind,currentState,currentCode,priorReview?.verdict));
  function frame(){return {state,code,reason,attempt,session,sequence,reviewPackage,currentChecks,receipt,receipts,calls,
    cache:[...cache.values()],priorReview,cancelAfterCommit,workflowError,cancellationRequested,...(taskMode?{taskCommit}:{}),
    ...(invocationMode?{reviewInvocation}:{}),...(taskLearning!==null?{learningResult}:{})};}
  const same=(a,b,why)=>need(digest(a)===digest(b),why);
  function revoke(){if(liveToken){commitCapabilities.delete(liveToken);liveToken=null;}}
  function storeOperation(fn){
    if(poisoned||storeOperating){poison();need(false,'store_failure');}
    storeOperating=true;
    try{const value=fn();need(!poisoned,'store_failure');return value;}
    catch(error){poison();throw error;}finally{storeOperating=false;}
  }
  function currentStore(){
    same(taskOwnerTarget(store),completion.owner,'task_owner_mismatch');const current=store.snapshot();
    same(current.identity,storeIdentity,'identity_mismatch');same(current.fingerprints,completion.fingerprints,'identity_mismatch');
    need(current.revision===storeRevision,'runner_store_changed');need(!poisoned,'store_failure');return current;
  }
  function candidate(type,fields){
    const basic={id:`runner.${String(journal.length+1).padStart(6,'0')}`,
      kind:{init:'result','effect-intent':'intent','effect-checkpoint':'result',control:'cancel',
        'task-commit-intent':'commit-intent','task-commit-result':'commit-result',
        'review-invocation-registered':'intent','review-invocation-started':'result','review-invocation-result':'result',
        'review-invocation-abandoned':'result','review-invocation-receipt':'result','review-invocation-reconciled':'result','effect-abandoned':'result',
        'host-joined':'result','qa-fix-accepted':'result','qa-attached':'result','qa-config-revised':'result',
        'evidence-superseded':'result','develop-retry-limit':'result','develop-worker':'result','effect-interrupted':'result','develop-timeout-retry':'result','develop-answer-retry':'result','develop-recheck':'result','complete-recheck':'result','develop-answer-redo':'result','develop-dispatch-retry':'result','review-redispatch':'result','review-dispatch-confirmed':'result','completion-retry-limit':'result','specification-rebound':'result','documentation-sync-started':'result','documentation-sync-retry':'result',
        'bootstrap-review-recovered':'result'}[type],
      payload:version===3?runnerPayloadV3(type,fields):runnerPayload(type,fields,version)};
    const body={version:1,seq:journal.length+1,...basic,previousDigest:journal.at(-1)?.digest??null};
    const record={...body,digest:digest(body)};boundRunnerRecord(record,body.seq);
    return {record,parsed:readRunnerHistory([...journal,record],metadata,version)};
  }
  // The exact record the store would append must fit its limits (payload, append
  // input, record count, whole state). Refusing here leaves the store usable,
  // where an over-limit append inside persist would poison it.
  function assertJournalFits(type,fields,why){
    if(!store||!taskMode)return;
    const {record}=candidate(type,fields);
    need(appendFits(currentStore(),{id:record.id,kind:record.kind,payload:record.payload,expectedRevision:storeRevision}),why);
  }
  function persist(type,fields) {
    if(!store)return;
    if(taskMode)return storeOperation(()=>{
      const current=currentStore(),{record,parsed}=candidate(type,fields);
      need(!poisoned,'store_failure');
      store.append({id:record.id,kind:record.kind,payload:record.payload,expectedRevision:storeRevision});
      const saved=store.snapshot();need(!poisoned,'store_failure');
      const {revision:old,...body}=current,expected={...body,records:[...journal,record]};
      same(saved,{...expected,revision:digest(expected)},'runner_store_changed');
      need(!poisoned,'store_failure');journal=saved.records;storeRevision=saved.revision;parsedHistory=parsed;
      if(type.startsWith('task-commit-'))taskCommit=parsed.state.taskCommit;
      return record;
    });
    need(!poisoned,'store_failure');
    const current=store.snapshot();need(current.revision===storeRevision,'runner_store_changed');
    const record={id:`runner.${String(journal.length+1).padStart(6,'0')}`,
      kind:{init:'result','effect-intent':'intent','effect-checkpoint':'result',control:'cancel'}[type],payload:runnerPayload(type,fields)};
    boundRunnerRecord(record,journal.length+1);
    const next=[...journal,record];readRunnerHistory(next,metadata);
    store.append({...record,expectedRevision:storeRevision});const saved=store.snapshot();journal=saved.records;storeRevision=saved.revision;
  }
  function poison() {
    poisoned=true;revoke();halt('unknown','store_failure');controller.abort();publication=privateStatus();return publication;
  }
  function nativeCompletion(fresh){
    const input=json({selectors:{tasksPath:completion.owner.tasksPath,feature:completion.owner.feature,
      reviewsDir:completion.reviewsDir,handoff:completion.handoffs[attempt-1]},root:config.root,
      identity:{...config.identity,attempt},baseline:base,reviewPackage,checks:fresh,receipt,
      registered:registered.get(receipt?.id),execution:calls.find(c=>c.invocationId===receipt?.id)},16*1024*1024);
    need(completeEffect?.effect.identity.attempt===attempt&&state==='committing'&&busy,'commit_phase_invalid');
    const token=Object.freeze({});liveToken=token;
    let phase='prepared';
    const ack=()=>json({owner:completion.owner,identity:input.identity,fingerprints:completion.fingerprints,
      inputDigest:digest(input),phase,intentDigest:taskCommit?.intentDigest??null,
      planDigest:taskCommit?.planDigest??null,resultDigest:taskCommit?.resultDigest??null});
    commitCapabilities.set(token,{store,resolve:(action,payload)=>{
      need(liveToken===token&&state==='committing'&&busy&&completeEffect,'commit_capability_invalid');
      if(action==='guard'){storeOperation(currentStore);return ack();}
      need(action==='append-intent'?phase==='prepared':phase==='intent','commit_phase_invalid');
      const fields={effectId:completeEffect.effect.id,completeIntentDigest:completeEffect.digest,commit:json(payload)};
      const type=action==='append-intent'?'task-commit-intent':'task-commit-result';
      // Invalid caller data is rejected before invoking the appender. The actual
      // append repeats preflight against its protected current cursor.
      candidate(type,fields);
      persist(type,fields);need(!poisoned&&liveToken===token,'store_failure');
      phase=action==='append-intent'?'intent':'result';return ack();
    }});
    try{
      const result=commitRunnerFixture(token,store,input,controller.signal);
      need(!poisoned&&phase==='result'&&taskCommit?.resultDigest,'commit_unknown');
      same(result,{outcome:'fixture_committed',intentDigest:taskCommit.intentDigest,planDigest:taskCommit.planDigest},'commit_unknown');
    }finally{revoke();}
  }
  // Exact byte count of the payload the store validates for this record, built by
  // the same record builder; an oversized record is measured, never written.
  const payloadBytes=(type,fields)=>Buffer.byteLength(JSON.stringify(version===3
    ?runnerPayloadV3(type,fields,Infinity):runnerPayload(type,fields,version,Infinity)));
  const largestFiles=files=>files.slice().sort((a,b)=>b.size-a.size).slice(0,3)
    .map(file=>`${file.path} ${file.size} bytes`);
  if(restored) {
    const s=structuredClone(restored.state);
    ({state,code,attempt,sequence,reviewPackage,currentChecks,receipt,priorReview,cancelAfterCommit,workflowError,cancellationRequested}=s);
    reason=s.reason??null;
    if(taskLearning!==null)learningResult=s.learningResult;
    if(taskMode)taskCommit=s.taskCommit;
    if(invocationMode)reviewInvocation=s.reviewInvocation;
    calls.push(...s.calls);receipts.push(...s.receipts);s.cache.forEach(c=>cache.set(c.effect.id,c));
    receipts.forEach(r=>registered.set(r.id,r));base=attemptBaseline(original,attempt);
    // Replay re-proves each version 2 record (its steps and the composition they
    // give) against the referenced stores when they all still exist; a missing
    // store is left to the live checks, which refuse it.
    for(const [index,item] of acceptedFixes.entries())if(item.association.version===2)
      validateAcceptedFix({record:item,previous:acceptedFixes.slice(0,index),baseline:base,parentPackage:reviewPackage,
        feature:taskLearning?.feature,resolveSteps:steps=>resolveSteps(steps,true)});
  } else {
    // A baseline too large for its record is refused before anything is appended.
    const bytes=store?payloadBytes('init',{config:metadata,baseline:original,session}):0;
    if(bytes>JOURNAL_PAYLOAD_LIMIT)throw Object.assign(new Error(boundedReason(`limit_exceeded: the task baseline journal record would be ${bytes} bytes, `
      +`above the journal record limit ${JOURNAL_PAYLOAD_LIMIT}; largest baseline material: `,
      largestFiles(original.files.filter(file=>Object.hasOwn(file,'contentBase64'))))),{code:'limit_exceeded'});
    persist('init',{config:metadata,baseline:original,session});
  }
  publication=privateStatus();
  function control(event) {
    if(poisoned)return false;
    try{persist('control',{event});return true;}catch{poison();return false;}
  }
  function cancel() {
    if(poisoned)return status();
    if(['committing','fixture_completed'].includes(state)){
      if(!cancelAfterCommit && control('late-cancel')){cancelAfterCommit=true;cancellationRequested=true;
        publication=json({...publication,cancelAfterCommit:true,...(store?{cancellationRequested}:{})},16*1024*1024);}
      return status();
    }
    if(!['blocked','unknown','cancelled'].includes(state) && control('cancel')){
      halt('cancelled','cancelled');cancellationRequested=true;controller.abort();publication=json({...publication,state,code,...(store?{cancellationRequested}:{})},16*1024*1024);
    }
    return status();
  }
  function active(){need(!poisoned,'store_failure');need(state!=='cancelled','cancelled');}
  async function bounded(fn,request,extraControl=null) {
    active();let timer,abort;
    try {
      const boxed=await Promise.race([
        new Promise((resolve,reject)=>{
          // Validate synchronous values before resolving any Promise with them.
          const accept=value=>{try {resolve({value:json(value)});}catch(error){reject(error);}};
          queueMicrotask(()=>{
            try {
              active();const returned=fn(request,{signal:controller.signal,...(extraControl??{})});
              if(types.isPromise(returned)) {
                const supported=Object.getPrototypeOf(returned)===promisePrototype
                  && !Object.hasOwn(returned,'constructor');
                const observed=observePromise(returned,supported?accept:ignorePromiseResult,
                  supported?reject:ignorePromiseResult);
                need(supported && observed);
              } else accept(returned);
            } catch(error){reject(error);}
          });
        }),
        new Promise((_,reject)=>{
          abort=()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'}));
          controller.signal.addEventListener('abort',abort,{once:true});
          timer=setTimeout(()=>{reject(Object.assign(new Error('call_timeout'),{code:'call_timeout'}));controller.abort();},config.timeoutMs);
        })
      ]);
      return boxed.value;
    } finally {clearTimeout(timer);controller.signal.removeEventListener('abort',abort);}
  }
  async function invoke(adapter,role,contextId,payload,extraControl=null) {
    const request=requestFor({invocationId:`${session}.${++sequence}`,identity:{...config.identity,attempt},
      role,provider:adapter.provider,requestedModel:adapter.requestedModel,contextId,payload});
    const call={invocationId:request.invocationId,contextId,provider:adapter.provider,requestedModel:adapter.requestedModel,
      effectiveModel:'unknown',channel:'fixture',started:true,terminal:'running',requestDigest:request.requestDigest,resultDigest:null};
    calls.push(call);
    try {
      const response=terminalFor(await bounded(adapter.run,request,extraControl),request);active();
      call.terminal=response.status;call.effectiveModel=response.effectiveModel;call.resultDigest=digest(response.result);
      if(role==='developer'&&response.status==='failed'&&response.result!==null)call.failureResult=response.result;
      if(role==='developer'&&Object.hasOwn(response,'blockedReason'))call.blockedReason=response.blockedReason;
      if(Object.hasOwn(response,'providerThreadId'))call.providerThreadId=response.providerThreadId;
      return {request,response,call};
    } catch(error){call.terminal=state==='cancelled'?'cancelled':'unknown';throw error;}
  }
  function acceptReview(request,call,rawResult,fallbackReasons=[]) {
    const result=reviewResult(rawResult,reviewPackage);
    let drift=null;
    try{verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
      reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});}
    catch(error){drift=error;}
    // Changed approved specs invalidate the verdict itself. Do not register a
    // receipt that the code-root cleanup path could later reuse.
    if(drift?.code==='spec_drift'){halt('blocked','spec_drift');return;}
    receipt=reviewReceipt({request,call,result,reviewPackage,developerProvider:developer.provider,fallbackReasons});
    registered.set(receipt.id,receipt);receipts.push(receipt);priorReview=result;
    if(result.verdict==='approved'){state='approved';code=null;}
    else if(result.verdict==='changes_requested' && attempt===1) {
      state='changes_requested';code=null;attempt=2;
      const {baselineDigest:old,...data}=original,newData={...data,identity:{...config.identity,attempt}};
      base=freeze({...newData,baselineDigest:digest(newData)});
    } else halt('blocked',result.verdict==='changes_requested'?'review_limit':'review_blocked',
      verdictReason(result.verdict==='changes_requested'?'review_limit: 第 2 轮审查仍要求修改，本运行两轮已用完'
        :'review_blocked: 审查判定 blocked，无法靠修改批准范围内的代码解决',result.summary));
    if(drift)halt('blocked','review_package_changed',drift.message);
  }
  const clock=Date.now.bind(Date);
  const safeTime=()=>{const value=clock();need(Number.isSafeInteger(value),'clock_invalid');return value;};
  const resultView=fields=>json(Object.fromEntries(Object.entries(fields)
    .filter(([key])=>!['effectId','invocationId'].includes(key))),512*1024);
  async function invokeObserved(adapter,contextId,payload,effectId) {
    const nextSequence=sequence+1,request=requestFor({invocationId:`${session}.${nextSequence}`,
      identity:{...config.identity,attempt},role:'reviewer',provider:adapter.provider,
      requestedModel:adapter.requestedModel,contextId,payload});
    let authorizationAt;
    try{authorizationAt=safeTime();}catch{halt('unknown','clock_invalid');return;}
    let grant;
    try{
      const returned=authorize(request,Object.freeze({authorizationAt}));
      if(types.isPromise(returned)){
        observePromise(returned,ignorePromiseResult,ignorePromiseResult);
        if(state==='cancelled'||controller.signal.aborted)return;
        need(false,'authorization_invalid');
      }
      if(state==='cancelled'||controller.signal.aborted)return;
      grant=json(returned);
      if(digest(grant)===digest({status:'denied',code:'permission_denied'})){
        halt('pending_review','permission_denied');return;
      }
    }catch(error){
      if(state==='cancelled'||controller.signal.aborted)return;
      halt('unknown',failureCode(error)==='clock_invalid'?'clock_invalid':'authorization_invalid');return;
    }
    if(state==='cancelled'||controller.signal.aborted)return;
    let registeredAt;
    try{registeredAt=safeTime();}catch{halt('unknown','clock_invalid');return;}
    if(registeredAt<authorizationAt){halt('unknown','clock_invalid');return;}
    try{grant=validateReviewDispatchGrant(grant,{request,reviewerId:adapter.id,adapterId:adapter.adapterId,
      packageDigest:reviewPackage.packageDigest,hostContextIds:[invocationConfig.developerThreadId,...liveInvocation().excludedThreadIds],
      authorizationAt,registeredAt});}
    catch{halt('unknown','authorization_invalid');return;}
    const registrationFields={effectId,reviewerId:adapter.id,adapterId:adapter.adapterId,requestDigest:request.requestDigest,
      authorizationAt,registeredAt,grant};
    // Validate first, then journal the signer immediately before registration.
    // Durable host lists and prior joiners already have replayable authority.
    if(![invocationConfig.developerThreadId,...invocationConfig.excludedThreadIds,...joinedHosts].includes(grant.hostContextId)){
      need(joinedHosts.length<MAX_AI_JOINED_HOSTS,'host_limit');
      persist('host-joined',{hostContextId:grant.hostContextId});joinedHosts.push(grant.hostContextId);
    }
    persist('review-invocation-registered',registrationFields);
    sequence=nextSequence;
    const registration=json({reviewerId:adapter.id,adapterId:adapter.adapterId,requestDigest:request.requestDigest,
      authorizationAt,registeredAt,grant});
    const call={invocationId:request.invocationId,contextId,provider:request.provider,requestedModel:adapter.requestedModel,
      effectiveModel:'unknown',channel:'host-authorized',started:false,terminal:'running',requestDigest:request.requestDigest,
      resultDigest:null,providerThreadId:null};
    calls.push(call);
    let dispatchAt=null,notDispatched=null;
    try{dispatchAt=safeTime();if(dispatchAt<registeredAt)notDispatched='clock_invalid';
      else if(dispatchAt>=grant.expiresAt)notDispatched='grant_expired';}
    catch{notDispatched='clock_invalid';}
    if(notDispatched){
      const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'not_dispatched',observation:null,inspection:null,
        reconciliationRequired:true,reason:notDispatched};
      persist('review-invocation-result',fields);const result=resultView(fields);
      Object.assign(call,{terminal:'not_dispatched',resultDigest:digest(result)});
      reviewInvocation=json({registration,started:null,result});halt('pending_review',notDispatched);return;
    }
    call.started=true;
    const expectation={request,developerThreadId:invocationConfig.developerThreadId,
      excludedThreadIds:reviewExclusions(liveInvocation(),calls,developer.contextId)};
    const events=[];let started=null,sealed=false,invalid=false,invalidReject;
    let capturedReceipt=null,receiptConflict=false,captureOpen=true,adapterDone;
    const adapterFinished=new Promise(resolve=>{adapterDone=resolve;});
    const onReconciliation=raw=>{
      if(!captureOpen||invalid)return false;
      try{
        let value=readReconciliationReceipt(raw);
        if(value.result?.status==='succeeded'){
          const bounded=boundReviewText(value.result.value);need(bounded!==null,'observation_invalid');
          value={...value,result:{status:'succeeded',value:bounded}};
        }
        if(capturedReceipt&&digest(value)!==digest(capturedReceipt))receiptConflict=true;
        else capturedReceipt=value;
        return !receiptConflict;
      }catch{receiptConflict=true;return false;}
    };
    const localController=new AbortController();
    const abort=()=>localController.abort();controller.signal.addEventListener('abort',abort,{once:true});
    const observation=result=>json({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
      events,result},512*1024);
    const rejectedObservation=()=>json({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
      events,result:{status:'invalid',code:'observation_invalid'}},512*1024);
    const invalidFields=()=>({effectId,invocationId:request.invocationId,dispatchAt,outcome:'unknown',
      observation:rejectedObservation(),inspection:null,reconciliationRequired:true,reason:'observation_invalid'});
    const invalidPromise=new Promise((_,reject)=>{invalidReject=reject;});
    const onEvent=raw=>{
      if(sealed)return false;
      let event;
      try{event=json(raw,64*1024);const candidate=json({version:1,kind:'cm-provider-review-observation',
        requestDigest:request.requestDigest,events:[...events,event],result:{status:'failed',code:'in_progress'}},512*1024);
        inspectProviderReview(JSON.stringify(candidate),JSON.stringify(expectation));
        if(event.event==='thread.started'){
          need(started===null&&event.provider_thread!==request.contextId,'observation_invalid');
          persist('review-invocation-started',{effectId,invocationId:request.invocationId,providerThreadId:event.provider_thread});
          started=event.provider_thread;call.providerThreadId=started;
        }
        events.push(event);return true;
      }catch(error){
        try{event=json(raw,64*1024);}catch{event={event:'invalid',item_type:null};}
        try{json({version:1,kind:'cm-provider-review-observation',requestDigest:request.requestDigest,
          events:[...events,event],result:{status:'invalid',code:'observation_invalid'}},512*1024);}
        catch{event={event:'invalid',item_type:null};}
        events.push(event);invalid=true;sealed=true;localController.abort();
        invalidReject(Object.assign(new Error('observation_invalid'),{code:'observation_invalid'}));return false;
      }
    };
    let timer,timedOut=false,cancelReject;
    try{
      let raw;
      try{
        raw=await Promise.race([
          new Promise((resolve,reject)=>queueMicrotask(()=>{
            try{
              need(!localController.signal.aborted,'cancelled');
              const returned=adapter.run(request,{signal:localController.signal,onEvent,...((metadata.externalModels||metadata.executionPolicy)?{onReconciliation}:{})});
              if(types.isPromise(returned)){
                const supported=Object.getPrototypeOf(returned)===promisePrototype&&!Object.hasOwn(returned,'constructor');
                const observed=observePromise(returned,supported?value=>{adapterDone();resolve(value);}:ignorePromiseResult,
                  supported?error=>{adapterDone();reject(error);}:ignorePromiseResult);
                need(supported&&observed);
              }else {adapterDone();resolve(returned);}
            }catch(error){adapterDone();reject(error);}
          })),
          invalidPromise,
          new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;localController.abort();
            reject(Object.assign(new Error('call_timeout'),{code:'call_timeout'}));},reviewTimeoutMs??config.timeoutMs);}),
          new Promise((_,reject)=>{cancelReject=()=>reject(Object.assign(new Error('cancelled'),{code:'cancelled'}));
            controller.signal.addEventListener('abort',cancelReject,{once:true});})
        ]);
      }catch(error){
        sealed=true;
        let fields;
        if(invalid){fields=invalidFields();}
        else if(timedOut){
          const recorded=observation({status:'failed',code:'timeout'});
          fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'timed_out',
            observation:recorded,inspection:inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation)),
            reconciliationRequired:Boolean((metadata.externalModels||metadata.executionPolicy))||hasProviderReviewResult(recorded.events)};
        }
        else if(state==='cancelled'){fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'cancelled',
          observation:observation({status:'cancelled',code:'cancelled'}),inspection:null,reconciliationRequired:true};}
        else {
          const recorded=observation({status:'failed',code:failureCode(error)}),inspection=inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation));
          fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'unknown',observation:recorded,inspection,reconciliationRequired:true};
        }
        persist('review-invocation-result',fields);const result=resultView(fields);
        const retry=reviewTimeoutTransition(result,[...cache.values()],attempt,calls.slice(0,-1),contextId);
        Object.assign(call,{terminal:fields.outcome==='cancelled'?'cancelled':retry?'failed':'unknown',resultDigest:digest(result)});
        reviewInvocation=json({registration,started,result});
        if(fields.outcome==='cancelled')halt('cancelled','cancelled');
        else if(retry)halt(retry.state,retry.code);
        else halt('unknown',fields.reason??fields.inspection?.code??'reconciliation_required');
        // Bound cleanup draining; never wait indefinitely or dispatch again.
        // The original unknown is already journaled and remains unchanged.
        if((metadata.externalModels||metadata.executionPolicy)&&timedOut&&!invalid){let drainTimer;await Promise.race([adapterFinished,
          new Promise(resolve=>{drainTimer=setTimeout(resolve,2500);})]);clearTimeout(drainTimer);}
        return;
      }
      sealed=true;
      let providerResult;
      try{
        providerResult=json(raw);
        if(providerResult?.status==='succeeded')shape(providerResult,['status','value']);
        else {shape(providerResult,['status','code']);need(['failed','cancelled'].includes(providerResult.status));
          text(providerResult.code);need(providerResult.code.length<=256);}
      }catch(error){
        const recorded=observation({status:'failed',code:failureCode(error)}),inspection=inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation));
        const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'unknown',observation:recorded,inspection,reconciliationRequired:true};
        persist('review-invocation-result',fields);const result=resultView(fields);
        Object.assign(call,{terminal:'unknown',resultDigest:digest(result)});reviewInvocation=json({registration,started,result});
        halt('unknown',inspection.code??'reconciliation_required');return;
      }
      // A reviewer that failed without a verdict, or whose complete answer breaks
      // the verdict contract, ends in a new explicit retryable result.
      const reviewerFailed=(recorded,failure)=>{
        const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:'failed',observation:recorded,
          inspection:failure,reconciliationRequired:Boolean((metadata.externalModels||metadata.executionPolicy))};
        persist('review-invocation-result',fields);const result=resultView(fields);
        const retry=reviewTimeoutTransition(result,[...cache.values()],attempt,calls.slice(0,-1),contextId);
        Object.assign(call,{terminal:retry?'failed':'unknown',resultDigest:digest(result)});reviewInvocation=json({registration,started,result});
        halt(retry?.state??'unknown',retry?.code??failure.code??'reconciliation_required',reviewFailureReason(failure.failure));
      };
      // Bound the reviewer text before it is observed, inspected or journaled.
      if(providerResult.status==='succeeded'){
        const bounded=boundReviewText(providerResult.value);
        if(bounded===null){
          const fields=invalidFields();persist('review-invocation-result',fields);const result=resultView(fields);
          Object.assign(call,{terminal:'unknown',resultDigest:digest(result)});reviewInvocation=json({registration,started,result});
          halt('unknown','observation_invalid');return;
        }
        providerResult=json({status:'succeeded',value:bounded});
      }
      let recorded,inspection;
      try{recorded=observation(providerResult);inspection=inspectProviderReview(JSON.stringify(recorded),JSON.stringify(expectation));}
      catch{
        const failure=recorded===undefined?null:inspectProviderReviewFailure(JSON.stringify(recorded),JSON.stringify(expectation));
        if(failure){reviewerFailed(recorded,failure);return;}
        const fields=invalidFields();persist('review-invocation-result',fields);const result=resultView(fields);
        Object.assign(call,{terminal:'unknown',resultDigest:digest(result)});reviewInvocation=json({registration,started,result});
        halt('unknown','observation_invalid');return;
      }
      const observed=inspection.observationStatus==='completed';
      const failure=!observed&&inspection.code==='transport_incomplete'
        ?inspectProviderReviewFailure(JSON.stringify(recorded),JSON.stringify(expectation)):null;
      if(failure){reviewerFailed(recorded,failure);return;}
      const fields={effectId,invocationId:request.invocationId,dispatchAt,outcome:observed?'observed':inspection.code==='transport_timeout'?'timed_out':'unknown',
        observation:recorded,inspection,reconciliationRequired:!observed
          &&(Boolean((metadata.externalModels||metadata.executionPolicy))||inspection.code!=='transport_timeout'||hasProviderReviewResult(recorded.events))};
      persist('review-invocation-result',fields);const result=resultView(fields);
      const retry=reviewTimeoutTransition(result,[...cache.values()],attempt,calls.slice(0,-1),contextId);
      Object.assign(call,{terminal:observed?'succeeded':retry?'failed':'unknown',resultDigest:digest(observed?inspection.review:result)});
      reviewInvocation=json({registration,started,result});
      if(observed)acceptReview(request,call,inspection.review);
      else if(retry)halt(retry.state,retry.code);
      else halt('unknown',inspection.code??'reconciliation_required');
    }finally{
      captureOpen=false;
      if((metadata.externalModels||metadata.executionPolicy)&&(state==='unknown'||state==='pending_review'&&code==='review_transport_timeout')
        &&started!==null&&!invalid&&!receiptConflict&&capturedReceipt)
        pendingReconciliation={effectId,invocationId:request.invocationId,receipt:capturedReceipt};
      sealed=true;clearTimeout(timer);controller.signal.removeEventListener('abort',abort);
      if(cancelReject)controller.signal.removeEventListener('abort',cancelReject);}
  }
  async function collectChecks(){
    const before=new Map(captureReviewInventory(config.root,base).map(file=>[file.path,file.sha256]));
    const results=json(await bounded(check,json({identity:{...config.identity,attempt}})));
    validChecks(results);
    const after=captureReviewInventory(config.root,base);
    checkNewPaths=new Set(after.filter(file=>!before.has(file.path)).map(file=>file.path));
    return results;
  }
  const failedChecks=checks=>checks.filter(item=>item.outcome!=='passed'||item.kind!=='visual'&&item.exitCode!==0);
  const checkFailureReason=(checks,code='checks_not_passed')=>{
    const details=failedChecks(checks).map(item=>
      `${item.id}: ${item.outcome}; ${item.evidence.replace(/[\x00-\x1f]/g,' ').slice(0,60)}`);
    return `${code}: ${details.join(' | ')}`;
  };
  // Runs on the checks just collected, before any handoff or review package is
  // built, so a deliverable that does not satisfy the task's own written
  // verification never spends an independent review round.
  async function verificationSatisfied(checks) {
    if(verificationGate===null)return true;
    // The description carries hard requirements too ("also confirm X/Y/Z do not
    // regress", "do not modify A"), and a gate that reads only the verification
    // section lets exactly those through to the independent review. Both are
    // sent; neither is required to exist.
    const specification=Object.hasOwn(original,'specification')?verifySpecificationMaterial(original):null;
    const verification=specification?.task?.verification??null;
    const description=specification?.task?.description??null;
    const written=value=>typeof value==='string'&&value.trim().length>0;
    if(!written(verification)&&!written(description))return true;
    const verdict=json(await bounded(verificationGate,
      json({identity:{...config.identity,attempt},
        ...(written(description)?{description}:{}),
        ...(written(verification)?{verification}:{}),checks})));
    shape(verdict,['satisfied']);need(typeof verdict.satisfied==='boolean','invalid_result');
    return verdict.satisfied;
  }
  // Attempt 2 exists to answer the findings that rejected attempt 1. Code
  // byte-identical to that rejected artifact cannot, so it never spends the
  // last review round; the same attempt may deliver again under a new effect id.
  function unchangedSinceRejection(){
    if(attempt!==2||priorReview?.verdict!=='changes_requested')return null;
    const rejected=receipts.findLast(item=>item.identity.attempt===1&&item.result.verdict==='changes_requested');
    if(!rejected)return null;
    const candidate=createReviewPackage({root:config.root,baseline:base,checks:currentChecks});
    return candidate.artifactDigest===rejected.artifactDigest
      ?`develop_unchanged_after_review: 第 2 轮交付与第 1 轮被要求修改的代码逐字节相同（artifactDigest ${rejected.artifactDigest.slice(0,12)}）；按审查 findings 修改后重新交付`:null;
  }
  // A delivery that changes nothing in scope has no review package to build. It
  // is the delivery that must be redone, exactly like failed checks, not an
  // unknown effect: nothing was dispatched to a reviewer and no round was spent.
  const EMPTY_DELIVERY='develop_empty_changes: the delivery changes nothing in scope relative to the task baseline; '
    +'write the actual change and resume to redo this attempt';
  // Scope may overlap requirements. A delivery that removed such a file cannot be
  // packaged (every requirement must exist), which is again a delivery to redo.
  // Only in-scope requirements qualify: touching any other file stays out_of_scope,
  // which the package builder reports before it ever reads the requirements.
  const missingScopeRequirements=()=>config.scope.filter(p=>config.requirements.includes(p)).filter(p=>{
    try{const stat=fs.lstatSync(path.join(config.root,p));return !stat.isFile()||stat.isSymbolicLink();}
    catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return true;throw error;}
  });
  const emptyDelivery=error=>{
    if(error?.code==='empty_changes'){halt('blocked','develop_empty_changes',EMPTY_DELIVERY);return;}
    // Instruction bootstrap has its own no-redispatch recovery contract once
    // rule evidence starts being written. Keep its size failures on that
    // conservative path instead of granting a fresh developer effect.
    if(error?.code==='limit_exceeded'&&metadata.bootstrap?.mode!=='instructions'){
      halt('blocked','develop_package_too_large',boundedReason('develop_package_too_large: ',
        [safeReason(error)??'review material exceeds its bounded size'],
        '; shrink the changed files or move generated artifacts out of scope, then resume to redo this attempt'));
      return;
    }
    const missing=error?.code==='read_failed'?missingScopeRequirements():[];
    if(!missing.length)throw error;
    halt('blocked','develop_requirement_missing',boundedReason('develop_requirement_missing: ',missing,
      ' are requirement files and must exist in the review package; restore them and resume to redo this attempt'));
  };
  // After a delivered develop: the task checks, the verification precheck, the
  // unchanged-after-review guard and the host handoff. False when it halted.
  async function hostDeliveryChecks(){
    currentChecks=await collectChecks();active();
    if(failedChecks(currentChecks).length){halt('blocked','develop_checks_not_passed',checkFailureReason(currentChecks,'develop_checks_not_passed'));return false;}
    if(!await verificationSatisfied(currentChecks)){halt('blocked','verification_precheck_failed');return false;}
    active();
    // unchangedSinceRejection builds a package too, so an empty delivery or a
    // deleted in-scope requirement surfaces there first and takes the same
    // retryable block (emptyDelivery).
    let unchanged;
    try{unchanged=unchangedSinceRejection();}catch(error){emptyDelivery(error);return false;}
    if(unchanged){halt('blocked','develop_unchanged_after_review',unchanged);return false;}
    try{createHostHandoff({root:config.root,baseline:base,checks:currentChecks,
      handoffPath:completion.handoffs[attempt-1]});}
    catch(error){emptyDelivery(error);return false;}
    return true;
  }
  async function packageDelivery(v){
    active();
    let nextPackage;
    try{nextPackage=createReviewPackage({root:config.root,baseline:base,checks:currentChecks,
      ...(taskLearning?.hostHandoff===true?{handoffPath:completion.handoffs[attempt-1]}:{})});}
    catch(error){emptyDelivery(error);return;}
    if(taskLearning!==null)validateTaskLearningReviewPackage(nextPackage,learningResult.writeback,v.learningInput,
      learningResult.bootstrap??null,metadata.bootstrap??null);
    reviewPackage=nextPackage;
    state='awaiting_review';
  }
  function developControl(effectId,documentationRedo){
    const control={...(workerJournaling()?{onWorker:event=>journalWorker(effectId,event)}:{}),
      ...(documentationJournaling()?{onDocumentationSync:event=>journalDocumentationSync(effectId,event),
        documentationSnapshot:paths=>documentationSnapshot(json(paths))}:{}),
      ...(documentationRedo?{documentationRedo}:{})};
    return Object.keys(control).length?control:null;
  }
  // Q16/Q17: a develop whose documentation_sync started (its call carries the
  // record) and then failed: the code its checkpoint shows, and the detail
  // (out-of-scope paths, or the transport code of a lost answer).
  function documentationFailure(v,error){
    const call=calls.at(-1);
    if(v.kind!=='develop'||call?.terminal!=='unknown'||typeof call.documentationSync!=='string')return null;
    let raw=null;
    try{const d=Object.getOwnPropertyDescriptor(error,'code');if(d&&Object.hasOwn(d,'value')&&typeof d.value==='string')raw=d.value;}catch{}
    if(raw==='documentation_sync_blocked')return {code:'documentation_sync_answer_blocked',detail:null};
    if(['documentation_sync_answer_invalid','invalid_input','invalid_result'].includes(raw))return {code:'documentation_sync_answer_invalid',detail:null};
    if(raw==='out_of_scope')return {code:'documentation_sync_out_of_scope',detail:safeReason(error)};
    return {code:'documentation_sync_answer_missing',detail:typeof raw==='string'&&/^[a-z_]{1,64}$/.test(raw)?raw:'execution_error'};
  }
  async function perform(v) {
    if(v.kind==='develop') {
      need(stageAllowed('develop',state,code,priorReview?.verdict),'stage_mismatch');
      const recheck=state==='blocked'&&RECHECK_CODES.includes(code);
      // Q16/Q17: a documentation-only redo reuses the journaled developer answer.
      let documentationRedo=null;
      if(state==='blocked'&&DOCUMENTATION_SYNC_CODES.includes(code)){
        const source=documentationRecord(calls.at(-1)?.documentationSync);need(source!==null,'documentation_sync_unavailable');
        documentationRedo={result:source.result,effectiveModel:source.effectiveModel};
      }
      state='developing';code=null;reason=null;checkNewPaths=null;receipt=null;
      // The adapter would refuse this scope before any provider runs. Block it
      // here instead: no call starts, nothing is written, and the outcome is
      // definite rather than unknown (create refuses such runs already).
      const refusedScope=protectedDevelopScope(metadata);
      if(refusedScope.length){halt('blocked','protected_scope',protectedScopeBlockReason(refusedScope));return;}
      // The delivery and its Learning writeback are already on disk: re-run only
      // the checks, the precheck, the handoff and the package. No developer call.
      if(recheck){
        if(!await hostDeliveryChecks())return;
        writeCmAiTaskLearningHandoff({handoffPath:completion.handoffs[attempt-1],feature:taskLearning.feature,
          identity:{...config.identity,attempt},learningInput:v.learningInput,application:learningResult.application,
          retrospective:learningResult.retrospective,writeback:learningResult.writeback});
        await packageDelivery(v);return;
      }
      const previousLearning=learningResult;
      const previousBootstrap=learningResult?.bootstrap??null;
      const previousWriteback=learningResult?.writeback??null;
      if(bootstrap!==null&&metadata.bootstrap?.mode==='instructions'){
        try{bootstrap.assertInstructionBaseline({identity:v.identity,previous:previousBootstrap,
          previousWriteback});}
        catch(error){if(error.code!=='bootstrap_instruction_conflict')throw error;
          halt('blocked','bootstrap_instruction_conflict',boundedReason(
            'bootstrap_instruction_conflict: 规则文件与本运行绑定的基准不一致：',error.paths??[],
            '。本轮未派发或写入。请还原这些文件后在原 run resume；若要采用新的提交，使用新 runId 重建。'));
          return;}
      }
      if(taskLearning!==null)learningResult=null;
      let verificationReason=null;
      const adapter=bootstrap===null?developer:{...developer,run:(request,control)=>
        bootstrap.run(request,control,developer.run,{previous:previousBootstrap,previousWriteback,baseline:original,
          verificationFailed:detail=>{verificationReason=detail;}})};
      const result=await invoke(adapter,'developer',developer.contextId,{scope:config.scope,
        requirements:original.files.filter(f=>config.requirements.includes(f.path)),priorReview,
        ...supersededReviewPayload(carriedReview,attempt),
        ...(Object.hasOwn(original,'specification')?{specification:verifySpecificationMaterial(original)}:{}),
        ...(Object.hasOwn(v,'learningInput')?{learningInput:v.learningInput}:{})},
      developControl(v.id,documentationRedo));
      if(Object.hasOwn(original,'specification'))verifySpecificationMaterial(original);
      if(result.response.status!=='succeeded'){
        const failure=result.response.result?.code;
        // The live session's init_verify did not pass, before any rule write.
        // Keep the Learning/bootstrap evidence this develop started from, so the
        // retry of the same attempt binds to exactly the files still on disk.
        if(failure==='bootstrap_verification_failed'){
          need(metadata.bootstrap?.mode==='instructions'&&typeof verificationReason==='string','invalid_result');
          learningResult=previousLearning;
          halt('blocked','bootstrap_verification_failed',verificationReason);return;
        }
        halt(result.response.status==='unknown'?'unknown':'blocked',
          failure==='invalid_result'&&result.response.result.retryable===true?'developer_result_invalid':
            failure==='protected_edit_stale'?failure:result.response.status);return;
      }
      if(taskLearning===null)shape(result.response.result,['outcome']);
      else {
        const instructionBootstrap=metadata.bootstrap?.mode==='instructions';
        shape(result.response.result,['outcome','application','retrospective',...(instructionBootstrap?['bootstrap']:[])]);
        need(result.response.result.outcome==='implemented','invalid_result');
        const instructionEvidence=instructionBootstrap?readBootstrapEvidence(result.response.result.bootstrap,
          metadata.bootstrap,v.identity):null;
        if(instructionEvidence)need(instructionEvidence.invocationId===result.request.invocationId,'identity_mismatch');
        const application=readCmAiTaskLearningApplication(result.response.result.application);
        need(application.feature===v.learningInput.feature
          &&digest(application.identity)===digest(v.learningInput.identity)
          &&application.learningDigest===v.learningInput.learningDigest,'identity_mismatch');
        const retrospective=json(result.response.result.retrospective,16*1024);
        const writeback=readCmAiProjectLearningWriteback(writeCmAiProjectLearning({codeProject:config.root,
          learningInput:v.learningInput,retrospective},instructionEvidence?.files.find(file=>file.path==='AGENTS.md').afterSha256??null,
          metadata.bootstrap?.feature??null),
        {learningInput:v.learningInput,retrospective});
        learningResult=freeze({application,retrospective,writeback,...(instructionEvidence?{bootstrap:instructionEvidence}:{})});
        if(writeback.outcome==='writeback_pending'){halt('blocked','learning_writeback_pending');return;}
        if(taskLearning.hostHandoff===true&&!await hostDeliveryChecks())return;
        writeCmAiTaskLearningHandoff({handoffPath:completion.handoffs[attempt-1],feature:taskLearning.feature,
          identity:{...config.identity,attempt},learningInput:v.learningInput,application,retrospective,writeback});
      }
      need(result.response.result.outcome==='implemented','invalid_result');
      if(taskLearning?.hostHandoff!==true){
        currentChecks=await collectChecks();active();
        if(failedChecks(currentChecks).length){halt('blocked','develop_checks_not_passed',checkFailureReason(currentChecks,'develop_checks_not_passed'));return;}
        if(!await verificationSatisfied(currentChecks)){halt('blocked','verification_precheck_failed');return;}
        active();
        let unchanged;
        try{unchanged=unchangedSinceRejection();}catch(error){emptyDelivery(error);return;}
        if(unchanged){halt('blocked','develop_unchanged_after_review',unchanged);return;}
      }
      await packageDelivery(v);return;
    }
    if(v.kind==='review') {
      state='reviewing';verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
        reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      if(invocationMode){await invokeObserved(reviewers[0],reviewers[0].contexts[attempt-1],{reviewPackage,priorReview,
        ...supersededReviewPayload(carriedReview,attempt)},v.id);return;}
      const fallbackReasons=[];
      for(const candidate of reviewers) {
        active();
        if(!candidate.allowed || !candidate.available){fallbackReasons.push({id:candidate.id,reason:!candidate.allowed?'not_authorized':'unavailable'});continue;}
        const {request,response,call}=await invoke(candidate,'reviewer',candidate.contexts[attempt-1],{reviewPackage,priorReview,
          ...supersededReviewPayload(carriedReview,attempt)});
        if(['unavailable','auth_required','permission_denied'].includes(response.status)) {
          fallbackReasons.push({id:candidate.id,reason:response.status});continue;
        }
        if(response.status!=='succeeded'){halt(response.status==='unknown'?'unknown':'pending_review',response.status);return;}
        acceptReview(request,call,response.result,fallbackReasons);
        return;
      }
      halt('pending_review','review_channels_unavailable');return;
    }
    if(v.kind==='complete') {
      const fresh=await collectChecks();active();
      try {
        verifyCompletionReviewPackage({root:config.root,baseline:base,checks:fresh,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      } catch(error){
        const duringCheck=error.code==='out_of_scope'&&Array.isArray(error.violations)
          &&error.violations.length>0&&error.violations.every(item=>item.newFile);
        const blockedCode=duringCheck?'completion_package_changed':failureCode(error);
        halt('blocked',blockedCode,blockedCode==='completion_checks_changed'&&failedChecks(fresh).length
          ?checkFailureReason(fresh):safeReason(error));return;
      }
      if(taskLearning!==null)try {
        const learningInput=currentLearningInput();
        verifyCmAiTaskLearningHandoff({handoffPath:completion.handoffs[attempt-1],feature:taskLearning.feature,
          identity:{...config.identity,attempt},learningInput,
          ...(Object.hasOwn(learningResult,'application')?{application:learningResult.application}:{}),
          retrospective:learningResult.retrospective,
          writeback:learningResult.writeback});
      } catch {halt('blocked','package_mismatch','package_mismatch: 完成前核对 Learning handoff 与已审交付不一致（handoff 文件或 Learning 记录被改动）；保留现场核对 .reviews 下的 handoff，不能直接重试。');return;}
      try {
        checkCompletion({receipt,registered:registered.get(receipt?.id),execution:calls.find(c=>c.invocationId===receipt?.id),
          reviewPackage,identity:{...config.identity,attempt}});
      } catch(error){halt('blocked',failureCode(error));return;}
      active();state='committing';
      if(taskMode){nativeCompletion(fresh);state='fixture_completed';return;}
      const returned=commit(json({identity:{...config.identity,attempt},packageDigest:reviewPackage.packageDigest,receiptDigest:receipt.receiptDigest}));
      if(types.isPromise(returned)) {
        observePromise(returned,ignorePromiseResult,ignorePromiseResult);need(false,'async_commit');
      }
      const result=json(returned);shape(result,['outcome']);need(result.outcome==='fixture_completed','commit_unknown');
      state='fixture_completed';return;
    }
  }
  // No delivery can still be reviewed: journal the terminal limit instead of an
  // intent, so no developer call runs (see developBudgetExhausted).
  const retryLimitDue=()=>invocationMode&&store&&!poisoned
    &&developBudgetExhausted({state,code,priorReview,calls,cache:[...cache.values()]});
  function recordRetryLimit(){
    const used=developBudget({calls,cache:[...cache.values()]});
    persist('develop-retry-limit',{fromState:state,fromCode:code,countedCalls:used.calls,countedEffects:used.effects});
    const recovered=readRunnerHistory(journal,metadata,3).state;
    ({state,code}=recovered);reason=recovered.reason??null;publication=privateStatus();return publication;
  }
  // The completion re-check bound is spent: journal the terminal limit instead
  // of another complete intent (see completionRetriesExhausted).
  const completionLimitDue=()=>invocationMode&&store&&!poisoned&&completionRetriesExhausted({state,code,cache:[...cache.values()]});
  function recordCompletionLimit(){
    persist('completion-retry-limit',{fromCode:code,completionBlocks:completionBlockCount([...cache.values()])});
    const recovered=readRunnerHistory(journal,metadata,3).state;
    ({state,code}=recovered);reason=recovered.reason??null;publication=privateStatus();return publication;
  }
  const limitDue=()=>retryLimitDue()?recordRetryLimit:completionLimitDue()?recordCompletionLimit:null;
  function executeEffect(raw) {
    let v,timeoutBasis=null,answerRetry=false,recheck=null,completeSource=null,dispatchBasis=null;
    try {
      need(!poisoned,'store_failure');v=json(raw);
      shape(v,['version','id','identity','kind',...(Object.hasOwn(v,'learningInput')?['learningInput']:[])]);id(v.id);validIdentity(v.identity);
      need(v.version===1 && ['develop','review','complete'].includes(v.kind));
      if(v.kind==='develop'&&taskLearning!==null)need(Object.hasOwn(v,'learningInput'),'runner_learning');
      if(Object.hasOwn(v,'learningInput')){need(v.kind==='develop'&&taskLearning!==null,'runner_learning');
        validTaskLearningInput(v.learningInput,v.identity,taskLearning.feature);}
      for(const k of ['repositoryId','runId','taskId'])need(v.identity[k]===config.identity[k],'identity_mismatch');
      // Publication is retryable local projection, never a provider redispatch.
      // Recovered/cached reviews can repair a missing file from the same receipt.
      try{publishRegisteredReview();}catch(error){
        if(error.code==='busy')throw error;
        need(false,'review_publication_required');
      }
      const old=cache.get(v.id);
      if(old){need(old.digest===digest(v),'intent_conflict');return Promise.resolve(old.result);}
      if(restored?.pending?.id===v.id){need(digest(restored.pending)===digest(v),'intent_conflict');return Promise.resolve(status());}
      need(!busy,'busy');need(v.identity.attempt===attempt,'attempt_mismatch');
      // A timed-out develop (journaled or already released) is redone only while
      // the code root still equals its start, verified here in the dispatch tick.
      // A delivered develop whose later checks lost their answer is re-checked,
      // never redeveloped; the re-check carries the delivered Learning input.
      if(v.kind==='develop'&&state==='unknown')recheck=developRecheck();
      if(v.kind==='develop'&&(recheck!==null||state==='blocked'&&RECHECK_CODES.includes(code)))
        need(digest(v.learningInput)===digest([...cache.values()].at(-1).effect.learningInput),'runner_learning');
      if(v.kind==='complete'&&state==='unknown'&&completeRecheck())completeSource=code;
      if(v.kind==='develop'&&state==='unknown'&&recheck===null)dispatchBasis=developDispatchRetry();
      // Q16/Q17: re-ask only documentation_sync; refused (nothing journaled)
      // while the code root outside the documentation paths changed, or while a
      // writer that never answered may still be writing the documentation.
      // Q16/Q17: never redispatched before the operator confirmed the writer stopped.
      if(v.kind==='develop'&&state==='unknown'&&recheck===null&&documentationSyncRetry()!==null)
        throw documentationRefusal('documentation_sync_stop_required');
      if(v.kind==='develop'&&state==='blocked'&&DOCUMENTATION_SYNC_CODES.includes(code)){
        const redo=documentationRedoSource();need(redo!==null,'documentation_sync_unavailable');
        if(taskLearning!==null)need(digest(v.learningInput)===digest(documentationRedoLearningInput()),'runner_learning');
        assertDocumentationRedo(redo);
      }
      // A journaled develop_dispatch_failed (also after a restart between its
      // record and the develop intent) re-verifies the round start right here.
      if(v.kind==='develop'&&state==='blocked'&&code===DISPATCH_RETRY_CODE)
        need(developDispatchRetry()!==null,'develop_dispatch_root_changed');
      if(v.kind==='develop'&&recheck===null&&developTimeoutState({state,code})){
        timeoutBasis=developTimeoutRetryBasis();need(timeoutBasis!==null,'develop_timeout_root_changed');
        if(state==='blocked')timeoutBasis=null;
      }
      // A refused authorization is a decision: a review is admitted again only after the
      // operator's journaled confirmation (abandon_review), bounded per round.
      if(v.kind==='review'&&reviewDenialUnconfirmed({state,code}))
        need(false,reviewDenialExhausted({state,code},reviewDispatchConfirmations())?REVIEW_DENIAL_LIMIT_CODE:REVIEW_DISPATCH_CONFIRM_REQUIRED_CODE);
      answerRetry=v.kind==='develop'&&state==='blocked'&&code==='failed'&&answerRetryable();
      need(timeoutBasis!==null||answerRetry||recheck!==null||completeSource!==null||dispatchBasis!==null
        ||stageAllowed(v.kind,state,code,priorReview?.verdict),'stage_mismatch');need(effectSlotFree(v.kind,[...cache.values()],calls),'limit_exceeded');
      need(!(v.kind==='review'&&reviewNotDispatchedExhausted({state,code,attempt,cache:[...cache.values()]},reviewDispatchConfirmations().extended)),REVIEW_NOT_DISPATCHED_LIMIT_CODE);
      if(Object.hasOwn(original,'specification'))verifySpecificationMaterial(original);
      if(v.kind==='develop'&&bootstrap!==null)bootstrap.assertWriteAuthorized();
    } catch(error){return Promise.resolve(freeze({outcome:'rejected',code:error.code??'invalid_input',
      ...(String(error.code).startsWith('documentation_sync_')&&typeof error.reason==='string'?{reason:error.reason}:{})}));}
    // The timed-out develop left the code root as it started: journal that
    // finding, then redo the round like any retryable develop block.
    if(timeoutBasis!==null){
      try{persist('develop-timeout-retry',{effectId:[...cache.values()].at(-1).effect.id,invocationId:calls.at(-1).invocationId,basis:timeoutBasis});}
      catch{return Promise.resolve(poison());}
      halt('blocked','develop_call_timeout',DEVELOP_CALL_TIMEOUT_REASON);publication=privateStatus();
    }
    if(recheck!==null){
      const source=code;
      try{persist('develop-recheck',{effectId:[...cache.values()].at(-1).effect.id,invocationId:calls.at(-1).invocationId,code:recheck});}
      catch{return Promise.resolve(poison());}
      halt('blocked',recheck,developRecheckReason(recheck,source,reason));publication=privateStatus();
    }
    if(dispatchBasis!==null){
      const source=code;
      try{persist('develop-dispatch-retry',{effectId:[...cache.values()].at(-1).effect.id,invocationId:calls.at(-1).invocationId,basis:dispatchBasis});}
      catch{return Promise.resolve(poison());}
      halt('blocked',DISPATCH_RETRY_CODE,developDispatchReason(source));publication=privateStatus();
    }
    if(completeSource!==null){
      try{persist('complete-recheck',{effectId:[...cache.values()].at(-1).effect.id,source:completeSource});}
      catch{return Promise.resolve(poison());}
      halt('blocked',COMPLETE_RECHECK_CODE,completeRecheckReason(completeSource));publication=privateStatus();
    }
    if(answerRetry){
      try{persist('develop-answer-retry',{effectId:[...cache.values()].at(-1).effect.id,invocationId:calls.at(-1).invocationId});}
      catch{return Promise.resolve(poison());}
      halt('blocked','develop_answer_invalid',developAnswerInvalidReason(calls.at(-1).failureResult));publication=privateStatus();
    }
    if(v.kind==='develop'&&retryLimitDue()){try{return Promise.resolve(recordRetryLimit());}catch{return Promise.resolve(poison());}}
    if(v.kind==='complete'&&completionLimitDue()){try{return Promise.resolve(recordCompletionLimit());}catch{return Promise.resolve(poison());}}
    if(store) {
      try {
        if(state==='ready')assertReadyBaseline();
        // A rejected first delivery has no review package yet. Every later
        // developer effect must recheck the reviewed tree before dispatch,
        // except one that redoes a delivery this attempt already made: that
        // delivery changed the tree on purpose and never became a package, so
        // it is compared against the baseline when the new package is built,
        // exactly as a redo at attempt 1 is.
        else if(reviewPackage!==null&&!(v.kind==='develop'&&state==='blocked'&&!['review_package_changed','develop_call_timeout'].includes(code)
          &&stageAllowed('develop',state,code,priorReview?.verdict)))verifyReviewPackage({root:config.root,baseline:reviewPackage.identity.attempt===attempt?base:attemptBaseline(original,reviewPackage.identity.attempt),
          checks:reviewPackage.checks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()});
      } catch(error){return Promise.resolve(freeze({outcome:'rejected',code:failureCode(error),
        ...(safeReason(error)?{reason:safeReason(error)}:{})}));}
      try{const record=persist('effect-intent',{effect:v,...(v.kind==='develop'&&workerJournaling()?{workerJournal:true}:{})});
        if(taskMode&&v.kind==='complete')completeEffect={effect:v,digest:record.digest};
      }catch{return Promise.resolve(poison());}
    }
    busy=true;if(v.kind!=='develop')code=null;
    const packageBefore=reviewPackage;
    pending=(async()=>{
      try {await perform(v);}
      catch(error){if(state!=='cancelled'&&!poisoned&&documentationFailure(v,error)){
        const {code:failed,detail}=documentationFailure(v,error);halt('unknown',failed,detail);
      }else if(state!=='cancelled'){
        const failure=failureCode(error);
        const checkOnly=failure==='out_of_scope'&&Array.isArray(error.violations)&&error.violations.length>0
          &&error.violations.every(item=>item.newFile&&checkNewPaths?.has(item.path));
        halt(checkOnly||failure==='spec_drift'||failure==='bootstrap_review_mismatch'?'blocked':'unknown',
          checkOnly?'check_output_out_of_scope':failure,
          failure==='bootstrap_review_mismatch'
            ?'规则审查包与六项目标证据不符；核对当前文件及 handoff 后，在原 run 使用 bootstrap_review_recover 恢复审查包。'
            :['out_of_scope','unsupported_file','limit_exceeded','package_mismatch','snapshot_changed'].includes(failure)
              ?safeReason(error):null);
      }}
      if(poisoned)return status();
      let result=privateStatus();cache.set(v.id,{effect:v,digest:digest(v),result});
      // A package the journal cannot hold would poison the store after the delivery
      // was written. Measure the exact checkpoint first; if it (plus room for the
      // review and completion checkpoints) does not fit, the delivery is redone.
      if(store&&v.kind==='develop'&&state==='awaiting_review'&&reviewPackage!==packageBefore){
        const bytes=payloadBytes('effect-checkpoint',{effectId:v.id,checkpoint:frame()});
        const size=value=>Buffer.byteLength(JSON.stringify(value??null));
        const reserve=developCheckpointReserve({examinedPathsBytes:size(reviewPaths(reviewPackage)),
          receiptsBytes:size(receipts),callsBytes:size(calls),writebackBytes:size(learningResult?.writeback)});
        const budget=JOURNAL_PAYLOAD_LIMIT-reserve;
        if(bytes>budget){
          const changed=reviewPackage.changes.filter(change=>change.after).map(change=>change.after);
          reviewPackage=packageBefore;
          halt('blocked','develop_package_too_large',boundedReason(`develop_package_too_large: the review checkpoint would be ${bytes} bytes, `
            +`above ${budget} (journal record limit ${JOURNAL_PAYLOAD_LIMIT} minus ${reserve} kept for the bounded review `
            +'and completion records); largest changed files: ',largestFiles(changed),
            '; shrink them or move them out of scope, then resume to redo this attempt'));
          result=privateStatus();cache.set(v.id,{effect:v,digest:digest(v),result});
        }
      }
      try{persist('effect-checkpoint',{effectId:v.id,checkpoint:frame()});publication=result;}
      catch{return poison();}
      if(pendingReconciliation){
        const saved=pendingReconciliation;pendingReconciliation=null;
        const registration=journal.findLast(row=>row.payload.type==='review-invocation-registered'&&row.payload.effectId===saved.effectId);
        const startedRecord=journal.findLast(row=>row.payload.type==='review-invocation-started'&&row.payload.effectId===saved.effectId);
        const resultRecord=journal.findLast(row=>row.payload.type==='review-invocation-result'&&row.payload.effectId===saved.effectId);
        const fields={...saved,registeredDigest:registration.digest,startedDigest:startedRecord?.digest??null,resultDigest:resultRecord.digest};
        // Invalid/unusable evidence never mutates the journal or poisons a run.
        let usable=false;try{assertJournalFits('review-invocation-receipt',fields,'review_reconciliation_limit');usable=true;}catch{}
        if(usable)try{persist('review-invocation-receipt',fields);}catch{return poison();}
      }
      // A block or verdict that leaves no reviewable delivery ends the run now,
      // so status never invites a resume that could not finish.
      try{const record=limitDue();return record?record():result;}catch{return poison();}
    })().finally(()=>{busy=false;pending=null;completeEffect=null;}).then(result=>{
      if(poisoned)return result;
      try{publishRegisteredReview();}
      catch{return freeze({...result,code:'review_publication_required'});}
      // A spent retryable review block reads through status: its V5 redispatch
      // (pending_review) or the round's explicit limit.
      return ['unknown','pending_review'].includes(result.state)
        ||result.state==='blocked'&&REVIEW_RETRY_CODES.includes(result.code)?status():result;
    });
    return pending;
  }
  function attachLearningEvidence(raw) {
    need(taskLearning!==null,'runner_learning');need(!poisoned,'store_failure');need(!busy,'busy');
    need(state==='awaiting_review','stage_mismatch');
    const input=json(raw,256*1024);shape(input,['handoff','application','retrospective']);
    const currentIdentity={...config.identity,attempt},learningInput=currentLearningInput();
    const applied=attachCmAiTaskLearningApplicationEvidence({handoff:input.handoff,feature:taskLearning.feature,
      identity:currentIdentity,learningInput,application:input.application});
    return attachCmAiTaskLearningEvidence({handoff:applied,feature:taskLearning.feature,
      identity:currentIdentity,learningInput,retrospective:input.retrospective});
  }
  function currentLearningInput() {
    const currentIdentity={...config.identity,attempt};
    const recovered=journal?.some(row=>row.payload.type==='bootstrap-review-recovered'
      &&row.payload.reviewPackage.packageDigest===reviewPackage?.packageDigest)??false;
    const develop=[...cache.values()].filter(entry=>entry.effect.kind==='develop'
      &&digest(entry.effect.identity)===digest(currentIdentity)
      &&(entry.result.state==='awaiting_review'||recovered&&['unknown','blocked'].includes(entry.result.state)));
    need(develop.length===1&&Object.hasOwn(develop[0].effect,'learningInput'),'runner_learning');
    return develop[0].effect.learningInput;
  }
  async function defaultWorkflow(ctx) {
    for(let round=1;round<=2;round++) {
      const effect=kind=>ctx.executeEffect({version:1,id:`${kind}-${round}`,identity:{...config.identity,attempt:round},kind});
      if((await effect('develop')).state!=='awaiting_review')return;
      const reviewed=await effect('review');
      if(reviewed.state==='changes_requested')continue;
      if(reviewed.state==='approved')await effect('complete');
      return;
    }
  }
  async function run(workflow=defaultWorkflow) {
    if(workflowRunning || busy)return freeze({outcome:'rejected',code:'busy'});
    if(typeof workflow!=='function')return freeze({outcome:'rejected',code:'invalid_input'});
    workflowRunning=true;let lease=true;
    const ctx=Object.freeze({executeEffect:v=>lease?executeEffect(v):Promise.resolve(freeze({outcome:'rejected',code:'workflow_closed'}))});
    try {await workflow(ctx);}
    catch {
      if(workflowError===null && control('workflow-error')) {
        const next=controlledState(frame(),'workflow-error',busy||restored?.pending!=null,version);
        ({state,code,workflowError}=next);reason=next.reason??null;
        const {reason:oldReason,...currentPublication}=publication;
        publication=json({...currentPublication,workflowError,...(!busy?{state,code,...(reason?{reason}:{})}:{})},16*1024*1024);
      }
    }
    finally {
      lease=false;
      if(pending){const waiting=pending;cancel();await waiting;}
      workflowRunning=false;
    }
    return status();
  }
  // Read-only content comparison, not completion authority or a JSON operation.
  const inspectFixAssociation=(fixPackage,evidence=null)=>{
    need(!busy&&!poisoned,'host_busy');
    const current=status();
    need(current.state==='fixture_completed'&&current.code!=='review_publication_required','qa_fix_parent_not_completed');
    const known=acceptedFixes.some(item=>item.evidence.reviewPackage.packageDigest===fixPackage.packageDigest);
    return inspectFixCodeAssociation({root:config.root,
      ...(completion?{specsRoot:completion.owner.specsRoot,...laterOptions(evidence)}:{}),
      baseline:base,parentPackage:reviewPackage,steps:acceptedFixes.at(-1)?.association.laterDeliveries??[],extend:!known,
      fixPackages:known?acceptedFixes.map(item=>item.evidence.reviewPackage)
        :[...acceptedFixes.map(item=>item.evidence.reviewPackage),fixPackage]});
  };
  const acceptCompletedFix=raw=>{
    need(invocationMode&&store&&!busy&&!poisoned,'fix_accept_unavailable');
    const evidence=json(raw,12*1024*1024),association=inspectFixAssociation(evidence.reviewPackage,evidence);
    const existing=acceptedFixes.find(item=>item.evidence.qaSource.testRunId===evidence.qaSource.testRunId);
    if(existing){need(digest(existing.evidence)===digest(evidence),'fix_evidence_changed');return json(existing,12*1024*1024);}
    const source=evidence.qaSource;
    const failure=inspectCmAiQaFailure({specsDir:completion.owner.specsRoot,feature:source.feature,
      identity:source.identity,packageDigest:source.packageDigest,testRunId:source.testRunId});
    const record=validateAcceptedFix({record:{evidence,association,qaRound:failure.qaRound},previous:acceptedFixes,
      baseline:base,parentPackage:reviewPackage,feature:taskLearning?.feature,resolveSteps:steps=>resolveSteps(steps)});
    assertJournalFits('qa-fix-accepted',{record},'fix_record_too_large');
    persist('qa-fix-accepted',{record});acceptedFixes.push(record);
    return json(record,12*1024*1024);
  };
  const attachQa=raw=>{
    need(invocationMode&&store&&!busy&&!poisoned,'qa_attach_unavailable');
    const record=readQaAttachment(raw);
    if(qaAttachment){need(digest(record)===digest(qaAttachment),'fingerprint_mismatch');return json(qaAttachment);}
    need(state==='fixture_completed','qa_attach_not_completed');
    persist('qa-attached',{record});qaAttachment=record;return json(record);
  };
  const reviseQa=raw=>{
    need(invocationMode&&store&&!busy&&!poisoned,'qa_revision_unavailable');
    const record=readQaConfigRevision(raw),current=status();
    // Before the first QA round (the caller checks the QA log) development may
    // still be in progress, but never with an unresolved effect, after
    // cancellation, or over completed code that no longer matches its review.
    if(beforeFirstQaRound(record))need(!['unknown','cancelled'].includes(current.state)
      &&!(current.state==='fixture_completed'&&current.code!==null),'qa_revision_not_completed');
    else need(current.state==='fixture_completed'&&current.code===null,'qa_revision_not_completed');
    need((current.packageDigest??null)===record.packageDigest,'package_mismatch');
    persist('qa-config-revised',{record});return json(record);
  };
  // Explicit, journaled continuation after a proper re-approval. Refused unless
  // everything this run's developer and reviewer see is unchanged; the record
  // then lets the bound material verify against the re-approved hashes only.
  const rebindSpecification=raw=>{
    const refuse=(code,why)=>{throw Object.assign(new Error(code),{code,reason:why});};
    need(invocationMode&&store&&!busy&&!poisoned,'spec_rebind_unavailable');
    const value=json(raw);shape(value,['version','reason','at']);need(value.version===1,'invalid_input');
    if(!Object.hasOwn(original,'specification'))refuse('spec_rebind_unavailable','本运行没有绑定规格材料（旧版运行），无需换绑');
    const drift=inspectSpecificationDrift(original);
    if(drift===null)return freeze({outcome:'unchanged'});
    if(restored?.pending||!specificationLive(state,code))
      refuse('spec_rebind_unavailable',`运行当前为 ${state}${code?`/${code}`:''}，没有待执行的开发、审查或完成，不能换绑`);
    if(!drift.rebindable)refuse('spec_rebind_refused',describeSpecificationDrift(drift));
    const record=readSpecificationRebind({version:1,taskId:config.identity.taskId,boundDigest:digest(original.specification),
      sources:drift.sources,files:drift.files,reason:value.reason,reboundAt:value.at});
    persist('specification-rebound',{record});
    return json({outcome:'rebound',record});
  };
  const supersedeEvidence=raw=>{
    need(invocationMode&&store&&!busy&&!poisoned,'supersede_unavailable');
    const record=readEvidenceSupersession(raw,{feature:taskLearning.feature,
      taskId:config.identity.taskId,newRunId:config.identity.runId});
    if(restored?.supersession){need(digest(restored.supersession)===digest(record),'supersede_record_invalid');return json(record);}
    need(journal.length===1&&state==='ready','supersede_unavailable');
    persist('evidence-superseded',{record});carriedReview=record.carriedReview??null;return json(record);
  };
  const abandonReview=raw=>{
    try{
      // A review that never started (a refused authorization, or the spent not-dispatched
      // redispatch bound): nothing ran, so no process needs proving stopped, even for
      // external-model runs. Only this explicit, audited confirmation leaves those ends.
      if(invocationMode&&store&&!busy&&!poisoned&&!restored?.pending&&state==='pending_review'){
        const confirmed=reviewDispatchConfirmations(),ended={state,code,attempt,cache:[...cache.values()]};
        const denied=reviewDenialUnconfirmed(ended),voided=reviewNotDispatchedExhausted(ended,confirmed.extended);
        if(denied||voided){
          if(denied&&reviewDenialExhausted(ended,confirmed))
            throw Object.assign(new Error(REVIEW_DENIAL_LIMIT_CODE),{code:REVIEW_DENIAL_LIMIT_CODE,reason:reviewDenialLimitReason()});
          if(voided&&!reviewNotDispatchedExtendable(ended,confirmed))
            throw Object.assign(new Error(REVIEW_NOT_DISPATCHED_LIMIT_CODE),
              {code:REVIEW_NOT_DISPATCHED_LIMIT_CODE,reason:reviewNotDispatchedLimitReason(code,confirmed.extended)});
          need(denied?reviewDenialConfirmable(ended,confirmed):true,'review_abandon_unavailable');
          const value=json(raw);shape(value,['allowed','reason']);
          need(value.allowed===true,'review_abandon_authorization_required');
          need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason,'utf8')<=500
            &&!/[\r\n\0]/.test(value.reason),'review_abandon_reason_required');
          persist('review-dispatch-confirmed',{effectId:[...cache.values()].at(-1).effect.id,attempt,code,reason:value.reason,
            at:new Date().toISOString()});
          const recovered=readRunnerHistory(journal,metadata,3).state;
          ({state,code}=recovered);reason=recovered.reason??null;publication=privateStatus();return status();
        }
      }
      need(!(metadata.externalModels||metadata.executionPolicy),'external_review_reconciliation_required');
      // V5 (A34): the operator confirms the spent block's reviewer stopped; this
      // journals the round's second no-result redispatch (no dispatch here).
      if(state==='blocked'&&reviewRedispatchLive()){
        const value=json(raw);shape(value,['allowed','reason']);
        need(value.allowed===true,'review_abandon_authorization_required');
        need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason,'utf8')<=500
          &&!/[\r\n\0]/.test(value.reason),'review_abandon_reason_required');
        persist('review-redispatch',{effectId:[...cache.values()].at(-1).effect.id,
          invocationId:reviewInvocation.registration.grant.invocationId,attempt,code,reason:value.reason,at:new Date().toISOString()});
        state='pending_review';publication=privateStatus();return status();
      }
      if(state==='blocked'&&reviewRedispatchSpent())throw Object.assign(new Error('review_abandon_budget_exhausted'),{code:'review_abandon_budget_exhausted'});
      if(invocationMode&&store&&!busy&&!poisoned&&state==='unknown'&&!restored?.pending&&!reviewResultAbandonable()){
        const refusal=reviewAbandonRefusal({state,attempt,cache:[...cache.values()],calls,reviewInvocation},reviewers[0].contexts[attempt-1],reviewRedispatchRecords());
        if(refusal)throw Object.assign(new Error(refusal.code),refusal);
      }
      need(invocationMode&&store&&!busy&&!poisoned&&state==='unknown'
        &&(restored?.pending?.kind==='review'||reviewResultAbandonable()),'review_abandon_unavailable');
      const value=json(raw);shape(value,['allowed','reason']);
      need(value.allowed===true,'review_abandon_authorization_required');
      need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(value.reason),'review_abandon_reason_required');
      if(!restored?.pending){
        // A checkpointed review whose journaled result was never accepted.
        const binding=readRunnerHistory(journal,metadata,3).reviewResultAbandon;
        need(binding!==null,'review_abandon_unavailable');
        persist('review-invocation-abandoned',{...binding,reason:value.reason,at:new Date().toISOString()});
        const recovered=readRunnerHistory(journal,metadata,3).state;
        ({state,code,sequence,reviewInvocation}=recovered);reason=recovered.reason??null;
        calls.splice(0,calls.length,...recovered.calls);
        publication=privateStatus();return status();
      }
      const history=readRunnerHistory(journal,metadata,3),last=journal.at(-1);
      // A38: the no-verdict result of the pending review reached the journal, its checkpoint did not.
      const withResult=last?.payload?.type==='review-invocation-result'&&history.pendingResultAbandonable===true;
      need(history.pending?.id===restored.pending.id&&history.state.state==='unknown'
        &&history.state.code==='reconciliation_required'
        &&(['review-invocation-registered','review-invocation-started'].includes(last?.payload?.type)
          &&history.state.reviewInvocation?.result===null||withResult)
        &&history.state.reviewInvocation?.registration,
      'review_abandon_unavailable');
      const registration=journal.findLast(row=>row.payload.type==='review-invocation-registered'
        &&row.payload.effectId===history.pending.id);
      const started=journal.findLast(row=>row.payload.type==='review-invocation-started'&&row.payload.effectId===history.pending.id
        &&journal.indexOf(row)>journal.indexOf(registration))??null;
      need(registration,'review_abandon_unavailable');
      const contextId=reviewers[0].contexts[attempt-1];
      need(reviewRedispatchCount(history.state.cache,history.state.calls,attempt,contextId,reviewRedispatchRecords())<MAX_REVIEW_REDISPATCHES,
        'review_abandon_budget_exhausted');
      const fields={effectId:history.pending.id,
        invocationId:history.state.reviewInvocation.registration.grant.invocationId,
        registeredDigest:registration.digest,startedDigest:started?.digest??null,
        ...(withResult?{resultDigest:last.digest}:{}),
        reason:value.reason,at:new Date().toISOString()};
      persist('review-invocation-abandoned',fields);
      const recovered=readRunnerHistory(journal,metadata,3).state;
      ({state,code,sequence,reviewInvocation}=recovered);calls.push(...recovered.calls.slice(calls.length));
      publication=privateStatus();return status();
    }catch(error){return freeze({outcome:'rejected',code:error.code??'review_abandon_unavailable',
      ...(error.code==='review_abandon_budget_exhausted'?{reason:`本轮独立审查已无结论重派 ${MAX_REVIEW_REDISPATCHES} 次，不能再放弃重派；在途审查可用 abandon_effect 作废本运行后 --supersede-reviewed-evidence 新建运行。`}
        :typeof error.reason==='string'?{reason:error.reason}:{})});}
  };
  const reconcileReview=raw=>{
    try{
      need((metadata.externalModels||metadata.executionPolicy)&&invocationMode&&store&&!busy&&!poisoned,'review_reconciliation_unavailable');
      const value=json(raw);shape(value,['invocationId']);id(value.invocationId);
      const prior=journal.findLast(row=>row.payload.type==='review-invocation-reconciled');
      if(prior?.payload.invocationId===value.invocationId&&state!=='unknown')return status();
      const history=readRunnerHistory(journal,metadata,3),proof=history.reviewReconciliation;
      need(['unknown','pending_review'].includes(state)&&!history.pending&&proof!==null,'review_reconciliation_evidence_required');
      need(proof.invocationId===value.invocationId,'review_reconciliation_binding');
      const {request,effect,before,result,...binding}=proof;
      const call=calls.find(item=>item.invocationId===value.invocationId);
      need(['unknown','failed'].includes(call?.terminal),'review_reconciliation_unavailable');
      // Same call, same grant and same effect. The journal retains the original
      // unknown and receipt; one atomic record contains the validated transition.
      Object.assign(call,{terminal:result.outcome==='observed'?'succeeded':'failed',
        resultDigest:digest(result.outcome==='observed'?result.inspection.review:result)});
      reviewInvocation=json({...reviewInvocation,result});reason=null;
      if(result.outcome==='observed')acceptReview(request,call,result.inspection.review);
      else {const retry=reviewTimeoutTransition(result,before.cache,before.attempt,before.calls,call.contextId);
        halt(retry.state,retry.code,reviewFailureReason(result.inspection.failure));}
      const response=privateStatus();cache.set(effect.id,{effect,digest:digest(effect),result:response});
      try{persist('review-invocation-reconciled',{...binding,checkpoint:frame()});publication=response;}
      catch{return poison();}
      try{limitDue()?.();}catch{return poison();}
      return status();
    }catch(error){return freeze({outcome:'rejected',code:error.code??'review_reconciliation_unavailable'});}
  };
  const abandonEffect=raw=>{
    try{
      need(!(metadata.externalModels||metadata.executionPolicy),'external_review_reconciliation_required');
      need(invocationMode&&store&&!busy&&!poisoned&&options.persistence.mode==='resume','effect_abandon_unavailable');
      const value=json(raw);shape(value,['allowed','reason']);
      need(value.allowed===true,'effect_abandon_authorization_required');
      need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(value.reason),'effect_abandon_reason_required');
      const history=readRunnerHistory(journal,metadata,3),effect=history.pending;
      need(effect!==null,'effect_abandon_no_pending');
      need(history.transaction===null&&history.state.taskCommit?.intentDigest==null,'effect_abandon_commit_pending');
      // V8: retire the interrupted step and continue the run from its retryable block.
      if(history.pendingInterruptible)return interruptEffect(history,effect,value.reason);
      need(effect.kind!=='review'||history.pendingAbandonable||history.pendingReviewExhausted,'effect_abandon_review_pending');
      need(['develop','complete','review'].includes(effect.kind),'effect_abandon_unavailable');
      // A develop whose writers are journaled is voided only with their gone-proof.
      let worker=null;
      if(effect.kind==='develop'&&history.pendingWorkerVoidable){
        const proof=workerProof(history.pendingWorker);
        if(proof.code){const refusal=workerRefusal('effect_abandon',proof);throw Object.assign(new Error(refusal.code),refusal);}
        worker=proof.binding??null;
      }else need(effect.kind!=='develop'||options.providerDevelopment!==true||history.pendingWorker?.journal===true,'effect_abandon_provider_development');
      need(history.state.state==='unknown'&&history.state.code==='reconciliation_required'
        &&(history.pendingAbandonable||history.pendingReviewExhausted||history.pendingWorkerVoidable),'effect_abandon_unavailable');
      const intent=journal.findLast(row=>row.payload.type==='effect-intent');
      persist('effect-abandoned',{effectId:effect.id,effectKind:effect.kind,intentDigest:intent.digest,
        lastRecordDigest:journal.at(-1).digest,reason:value.reason,at:new Date().toISOString(),...(worker?{worker}:{})});
      const recovered=readRunnerHistory(journal,metadata,3).state;
      ({state,code,sequence}=recovered);reason=recovered.reason;restored.pending=null;
      publication=privateStatus();return status();
    }catch(error){return freeze({outcome:'rejected',code:poisoned?'store_failure':error.code??'effect_abandon_unavailable',
      ...(error.code==='effect_abandon_commit_pending'?{reason:'task-commit-intent 已写入，tasks.md 可能已改名或勾选；不能放弃或重做完成。发送 complete，宿主只按运行存档里的提交计划核对 tasks.md 并收尾。'}
        :!poisoned&&error.reason?{reason:error.reason}:{})});}
  };
  function interruptEffect(history,effect,why){
    const refuse=(code,detail)=>{throw Object.assign(new Error(code),{code,reason:detail});};
    const extra={};
    if(effect.kind==='develop'){
      if(options.providerDevelopment===true&&!providerRun)refuse('effect_interrupt_worker_identity_unrecorded',
        '这次 provider 开发没有配置 provider 模型，运行存档无法记下 worker 进程身份，宿主无法证明进程已退出；请手工确认进程已退出后用新建运行替代。');
      // Every journaled writer (provider worker, proposal apply subprocess) must be gone.
      if(providerRun||history.pendingWorker?.journal===true){
        const proof=workerProof(history.pendingWorker);
        if(proof.code){const refusal=workerRefusal('effect_interrupt',proof);refuse(refusal.code,refusal.reason);}
        if(proof.proof==='gone')extra.worker=proof.binding;
      }
      // A Claude provider and protected current-session development write by
      // applying proposals: a changed root can only be a partly applied one.
      if(providerRun?developer.provider==='claude':options.protectedDevelopment===true)
        extra.basis=verifyRoundStart(pendingDevelopStart(history.state),'effect_interrupt',providerRun?'Claude provider 开发':'受保护开发');
      // Q16: the host died during documentation_sync, after the developer
      // answered: bind the start record and the documentation as confirmed now,
      // so the run redoes only documentation_sync.
      if(history.pendingDocumentation){
        extra.startDigest=history.pendingDocumentation.digest;
        extra.documents=documentationLive(history.pendingDocumentation.payload.documents.map(item=>item.path)).documents;
      }
    }
    const intent=journal.findLast(row=>row.payload.type==='effect-intent');
    persist('effect-interrupted',{effectId:effect.id,effectKind:effect.kind,intentDigest:intent.digest,
      lastRecordDigest:journal.at(-1).digest,reason:why,at:new Date().toISOString(),...extra});
    const recovered=readRunnerHistory(journal,metadata,3).state;
    ({state,code,sequence}=recovered);reason=recovered.reason??null;
    calls.splice(0,calls.length,...recovered.calls);
    restored.pending=null;publication=privateStatus();return status();
  }
  // A45: finish the interrupted task commit from its journaled plan only.
  const recoverCommit=()=>{
    try{
      const transaction=commitRecoveryTransaction();need(transaction!==null,'commit_recovery_unavailable');
      const effect=restored.pending,intent=transaction.intentRecord.payload.commit;
      // tasks.md is never touched again and no second result is appended once
      // the journal holds the commit result; only the checkpoint is missing.
      if(transaction.resultRecord===null){
        recoverRunnerCommitImage(completion.owner,intent,()=>verifyReviewPackage({root:config.root,baseline:base,
          checks:reviewPackage.checks,reviewPackage,expectedDigest:reviewPackage.packageDigest,...handoffBinding()}));
        persist('task-commit-result',{effectId:effect.id,completeIntentDigest:transaction.completeIntentDigest,
          commit:{version:1,protocol:'cm-task-commit',type:'result',intentDigest:transaction.intentRecord.digest,
            planDigest:intent.plan.planDigest,outcome:'fixture_committed'}});
      }
      state='fixture_completed';code=null;reason=null;
      const response=privateStatus();cache.set(effect.id,{effect,digest:digest(effect),result:response});
      persist('effect-checkpoint',{effectId:effect.id,checkpoint:frame()});
      restored.pending=null;publication=response;return status();
    }catch(error){
      if(poisoned)return freeze({outcome:'rejected',code:'store_failure'});
      return freeze({outcome:'rejected',code:error.code??'commit_recovery_unavailable',reason:error.code==='commit_recovery_conflict'
        ?'tasks.md 或提交计划引用的证据文件既不是提交前也不是提交后的样子（或已被改动）；宿主不改写。请核对 tasks.md 与 .reviews 下的 handoff/审查文件，还原后重试 complete。'
        :error.code==='commit_recovery_code_changed'?'代码已不等于审查通过的交付，宿主不勾选任务；还原到审查通过的交付后重试 complete。'
        :'完成提交无法按运行存档的提交计划收尾；保留现场核对 tasks.md 与提交记录。'});
    }
  };
  // The operator's confirmation that the stuck current-session develop stopped
  // writing (R3). Journals develop-answer-redo; the next advance redoes the round.
  const redoDevelop=raw=>{
    try{
      need(invocationMode&&store&&!busy&&!poisoned&&options.persistence.mode==='resume','develop_redo_unavailable');
      const value=json(raw);shape(value,['allowed','reason']);
      need(value.allowed===true,'develop_redo_authorization_required');
      need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(value.reason),'develop_redo_reason_required');
      // Q16: the confirmation for a documentation_sync that never answered after
      // it changed the documentation paths; only documentation_sync is redone.
      // A re-confirmation (blocked) keeps the confirmed source and spends no retry.
      const documentation=state==='unknown'?documentationSyncRetry():null,confirmed=state==='blocked'?documentationRedoSource():null;
      if(documentation!==null||confirmed!==null){
        const source=documentation?.source??confirmed.source,start=calls.at(-1).documentationSync;
        const live=documentationLive(source.documents.map(item=>item.path));
        persist('documentation-sync-retry',{effectId:documentation?[...cache.values()].at(-1).effect.id:confirmed.stop.effectId,
          invocationId:calls.at(-1).invocationId,startDigest:start,code:documentation?.code??confirmed.code,documents:live.documents,
          reason:value.reason,at:new Date().toISOString()});
        const recovered=readRunnerHistory(journal,metadata,3).state;
        halt('blocked',recovered.code,recovered.reason);publication=privateStatus();return status();
      }
      const cause=developRedoRequired();need(cause!==null,'develop_redo_unavailable');
      const effectId=[...cache.values()].at(-1).effect.id;let worker=null,basis=null;
      if(cause.startsWith('provider_')){
        const proof=workerProof(parsedHistory?.workers?.[effectId],{checkpointed:true});
        if(proof.code){const refusal=workerRefusal('develop_redo',proof);throw Object.assign(new Error(refusal.code),refusal);}
        if(proof.proof==='gone')worker=proof.binding;
        if(developer.provider==='claude')basis=verifyRoundStart(redoDevelopStart({state,code,attempt,cache:[...cache.values()],
          reviewPackage,priorReview}),'develop_redo','Claude provider 开发');
      }
      persist('develop-answer-redo',{effectId,invocationId:calls.at(-1).invocationId,
        cause,reason:value.reason,at:new Date().toISOString(),...(worker?{worker}:{}),...(basis?{basis}:{})});
      halt('blocked',DEVELOP_REDO_CODE,developRedoReason(cause));publication=privateStatus();return status();
    }catch(error){return freeze({outcome:'rejected',code:poisoned?'store_failure':error.code??'develop_redo_unavailable',
      ...(!poisoned&&error.reason?{reason:error.reason}:{})});}
  };
  const recoverBootstrapReview=raw=>{
    try{
      need(invocationMode&&store&&!busy&&!poisoned&&options.persistence.mode==='resume',
        'bootstrap_review_recovery_unavailable');
      const value=json(raw);shape(value,['allowed','reason']);
      need(value.allowed===true,'bootstrap_review_recovery_authorization_required');
      need(typeof value.reason==='string'&&value.reason.trim().length>0&&Buffer.byteLength(value.reason,'utf8')<=500
        &&!/[\r\n\0]/.test(value.reason),'bootstrap_review_recovery_reason_required');
      const history=readRunnerHistory(journal,metadata,3);
      need(bootstrapReviewRecoverable(history.state,history.pending,metadata.bootstrap),
        'bootstrap_review_recovery_unavailable');
      const input=history.state.cache.at(-1).effect.learningInput;
      const handoffPath=completion.handoffs[attempt-1];
      verifyCmAiTaskLearningHandoff({handoffPath,feature:taskLearning.feature,
        identity:{...config.identity,attempt},learningInput:input,
        ...(Object.hasOwn(learningResult,'application')?{application:learningResult.application}:{}),
        retrospective:learningResult.retrospective,writeback:learningResult.writeback});
      const pkg=createReviewPackage({root:config.root,baseline:base,checks:currentChecks,handoffPath});
      validateTaskLearningReviewPackage(pkg,learningResult.writeback,input,learningResult.bootstrap,metadata.bootstrap);
      const handoff=loadHandoff(handoffPath,{task:config.identity.taskId,attempt});
      const paths=pkg.changes.map(item=>item.path);
      need(digest([...handoff.changed_files].sort())===digest([...paths].sort())
        &&handoff.implementation_sha256===implementationSha256(config.root,handoff.changed_files),
        'bootstrap_review_recovery_mismatch');
      verifyReviewPackage({root:config.root,baseline:base,checks:currentChecks,
        reviewPackage:pkg,expectedDigest:pkg.packageDigest,handoffPath});
      persist('bootstrap-review-recovered',{fromDigest:journal.at(-1).digest,reviewPackage:pkg,
        reason:value.reason,at:new Date().toISOString()});
      reviewPackage=pkg;state='awaiting_review';code=null;reason=null;
      publication=privateStatus();return status();
    }catch(error){return freeze({outcome:'rejected',code:error.code??'bootstrap_review_recovery_mismatch',
      reason:'原运行的文件、handoff 或证据无法精确核对；请保留现场并检查差异，不要重新派发开发。'});}
  };
  // Interrupted intents keep their ids; the entry derives fresh ones from this count.
  const interruptions=kind=>parsedHistory?.interrupted?.filter(item=>item.kind===kind).length??0;
  const api={reviseQa,supersedeEvidence,rebindSpecification,abandonReview,reconcileReview,abandonEffect,recoverBootstrapReview,executeEffect,status,cancel,run,inspectFixAssociation,acceptCompletedFix,attachQa,verificationBlocks,completionBlocks,reviewEffectIds,recheckLearningInput,redoDevelop,recoverCommit,interruptions};
  if(bootstrap!==null)api.inspectBootstrapAdmission=()=>bootstrap.inspectAdmission(original);
  if(taskLearning!==null)api.attachLearningEvidence=attachLearningEvidence;
  // A terminal reviewer observation is durable even if the host died before
  // the checkpoint. Finish that same effect from its validated journal bytes.
  if(restored?.pendingObservedReview){
    const observed=restored.pendingObservedReview,request=observed.request,result=observed.result;
    const call={invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
      requestedModel:request.requestedModel,effectiveModel:'unknown',channel:'host-authorized',
      started:true,terminal:'succeeded',requestDigest:request.requestDigest,
      resultDigest:digest(result.inspection.review),providerThreadId:observed.started};
    sequence++;calls.push(call);
    reviewInvocation=json({registration:observed.registration,started:observed.started,result});
    acceptReview(request,call,result.inspection.review);
    const effect=restored.pending,response=privateStatus();
    cache.set(effect.id,{effect,digest:digest(effect),result:response});
    persist('effect-checkpoint',{effectId:effect.id,checkpoint:frame()});
    restored.pending=null;publication=response;
  }
  return Object.freeze(api);
}
function configToBaseline(c){
  const scope=Object.hasOwn(c,'taskLearning')?taskReviewScope(c.scope):c.scope;
  return {root:c.root,identity:c.identity,scope,requirements:c.requirements,
    ...(c.codeProjectPaths?{codeProjectPaths:c.codeProjectPaths}:{}),
    ...(c.bootstrap?{bootstrapRequirements:c.bootstrap.bootstrapRequirements}:{}),
    ...(c.completion?{specsRoot:c.completion.owner.specsRoot}:{})};
}
