// Fixed Codex-host entry for the existing cm-ai admission and V3 task runner.
import {inspectCmAiAdmission,matchesCmAiTaskSelection,selectedFeature} from './cm-ai-admission.mjs';
import {inspectCmAiContextRefresh,inspectCmAiTaskLearningInput} from './cm-ai-context-refresh.mjs';
import {findCmAiQaDecision,inspectCmAiQaDecision,inspectCmAiQaResult,recordCmAiQaDecision,
  latestCmAiQaRun,recordCmAiQaRun,inspectCmAiQaRecovery,inspectCmAiQaConfigurationRecovery,timedOutQaDecision,
  replacesTimedOutQaDecision,validEnvironmentFailureReason} from './cm-ai-qa-log.mjs';
import {recordCmAiRunDone} from './cm-ai-run-finalizer.mjs';
import {projectHostResult} from './host-progress.mjs';
import {operatorGuidance} from './operator-guidance.mjs';
import {outstandingFeatureQa,describeOutstandingQa} from './project-qa-gate.mjs';
import {REVIEWED_HANDOFF_HINT} from './host-handoff.mjs';
import {readHostQaFixHandoff} from './host-qa-fix.mjs';
import {readCloseoutPolicy,readCloseoutReport,closeoutSummary} from './knowledge-closeout.mjs';
import {digest,freeze,hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';

const sameIdentity=(left,right)=>['repositoryId','runId','taskId','attempt'].every(key=>left[key]===right[key]);
const sameTask=(left,right)=>['repositoryId','runId','taskId'].every(key=>left[key]===right[key]);
const boundStatus=(status,identity)=>{validIdentity(status?.identity);
  need(sameIdentity(status.identity,identity),'identity_mismatch');return status;};
// A no-result timeout, an explicit abandonment, a reviewer failure with no
// verdict and a verdict that broke the written contract share one redispatch
// per attempt. Exported for the batch driver, like developmentRetryable.
export const reviewRetryable=status=>status.state==='pending_review'
  &&['review_transport_timeout','review_abandoned','review_provider_failed','review_verdict_invalid'].includes(status.code);
const retryReview=reviewRetryable;
// Both mean the delivery itself must be redone: an invalid developer result, or
// one that does not satisfy the task's own written verification. Exported so the
// batch driver decides retryability from the same predicate instead of keeping a
// second copy of the code list that silently drifts.
export const developmentRetryable=status=>status.state==='blocked'
  &&['developer_result_invalid','verification_precheck_failed','check_output_out_of_scope','develop_checks_not_passed','develop_unchanged_after_review','develop_empty_changes','develop_requirement_missing','develop_package_too_large','bootstrap_verification_failed','develop_call_timeout','develop_answer_invalid',
    'check_answer_missing','check_answer_invalid','develop_answer_missing','develop_dispatch_failed','develop_interrupted'].includes(status.code)
  // Shown before the operator confirmed the session stopped: not yet redoable.
  &&status.developRedoRequired!==true;
const retryDeveloper=developmentRetryable;
export const completionRetryable=status=>status.state==='blocked'
  &&['completion_checks_changed','completion_package_changed','complete_recheck_failed','complete_commit_interrupted'].includes(status.code)
  &&status.retryReady!==false;
const pendingAction=status=>status.state==='awaiting_spec_approval'?'spec_approval':
  // The runner reports spec_drift over any state whose next effect would be refused.
  status.code==='spec_drift'?(status.specificationRebind==='available'?'spec_rebind':'none'):
  status.bootstrapReviewRecovery===true?'bootstrap_review_recover':
  status.developRedoRequired===true?'develop_redo':
  status.reviewReconciliation?.available?'reconcile_review':
  status.state==='changes_requested'||retryDeveloper(status)||retryReview(status)?'resume':
  status.state==='awaiting_review'?'decision':status.state==='unknown'
    ?(status.pendingEffectKind?'abandon_effect':
      status.pendingReviewInvocation||status.abandonableReviewResult?'abandon_review':'reconcile'):
  status.state==='pending_review'&&status.code==='provider_review_observed'?'review_evidence':
  status.state==='pending_review'?'decision':status.state==='approved'||completionRetryable(status)?'complete':
  status.state==='fixture_completed'&&status.code==='qa_triggered'?'qa_execution':
  status.state==='fixture_completed'&&status.code==='qa_skipped'?'context_refresh':
  status.state==='fixture_completed'&&status.code==='qa_passed'?'context_refresh':
  status.state==='fixture_completed'&&status.code==='correction_review_required'?'none':
  status.state==='fixture_completed'&&status.code==='documentation_sync_required'?'documentation_sync':
  status.state==='fixture_completed'&&status.code==='documentation_synced'?'run_finalize':
  status.state==='fixture_completed'&&status.code==='documentation_sync_blocked'?'none':
  status.state==='fixture_completed'&&status.code==='project_qa_not_passed'?'none':
  status.state==='fixture_completed'&&status.code==='qa_blocked'?'none':
  status.state==='fixture_completed'&&status.code==='qa_execution_unknown'?'reconcile':
  status.state==='fixture_completed'&&['qa_failed','qa_result_blocked'].includes(status.code)?'none':
  status.state==='fixture_completed'?'qa':'none';
const summary=(operation,status,outcome)=>freeze({version:1,workflow:'cm-ai',operation:operation.operation,
  requestDigest:digest(operation),identity:status.identity,outcome,state:status.state,code:status.code??null,
  packageDigest:status.packageDigest??null,pendingAction:pendingAction(status),
  ...(status.reviewReconciliation?{reviewReconciliation:status.reviewReconciliation}:{}),
  ...(status.developRedoRequired===true?{developRedoRequired:true}:{}),
  ...(typeof status.reason==='string'?{reason:status.reason}:{}),
  ...(status.code==='handoff_exists'?{reason:REVIEWED_HANDOFF_HINT}:{}),
  ...(status.state==='blocked'&&status.calls?.at(-1)?.blockedReason!==undefined
    ?{blockedReason:status.calls.at(-1).blockedReason}:{})});
const correctionSummary=(operation,status)=>status.code==='correction_review_required'
  ?summary(operation,status,'blocked'):null;
// run_done is a project claim: every approved feature's latest mandatory QA must
// have passed, not only this final run's own. Read with the strict owner validator.
function projectQaSummary(operation,status,options){
  const admission=inspectCmAiAdmission({specsDir:options.specsDir,codeProject:options.codeProject,...selectedFeature(options.featureSelection)});
  const outstanding=outstandingFeatureQa({specsDir:options.specsDir,features:admission.features.map(({name,pending})=>({name,pending})),
    currentRunId:status.identity.runId,inspect:latestCmAiQaRun});
  if(!outstanding.length)return null;
  return freeze({...summary(operation,{...status,code:'project_qa_not_passed',
    reason:`以下 feature 的最新一轮 QA 未通过：${outstanding.map(describeOutstandingQa).join('；')}。先恢复对应运行让 QA 通过，再重新推进本运行收尾。`},'blocked'),
  outstandingQa:outstanding});
}

function readOperation(raw) {
  const operation=json(raw),keys=['version','operation','requestId','identity'];
  if(['decision','complete','qa','qa_result','context_refresh','finish','run_finalize'].includes(operation?.operation))keys.push('packageDigest');
  if(['qa_result','context_refresh','finish','run_finalize'].includes(operation?.operation))keys.push('testRunId');
  if(['abandon_review','abandon_effect','bootstrap_review_recover','develop_redo'].includes(operation?.operation))keys.push('reason');
  if(operation?.operation==='reconcile_review')keys.push('invocationId');
  shape(operation,keys);
  if(operation?.operation==='reconcile_review')id(operation.invocationId);
  need(operation.version===1&&['advance','start','status','decision','complete','qa','qa_result','context_refresh','finish','run_finalize','cancel','resume','reconcile_review','abandon_review','abandon_effect','bootstrap_review_recover','develop_redo']
    .includes(operation.operation));
  id(operation.requestId);validIdentity(operation.identity);
  if(operation.operation==='abandon_review')need(typeof operation.reason==='string'
    &&operation.reason.trim().length>0&&Buffer.byteLength(operation.reason,'utf8')<=500
    &&!/[\r\n\0]/.test(operation.reason),'review_abandon_reason_required');
  if(operation.operation==='abandon_effect')need(typeof operation.reason==='string'
    &&operation.reason.trim().length>0&&Buffer.byteLength(operation.reason,'utf8')<=500
    &&!/[\r\n\0]/.test(operation.reason),'effect_abandon_reason_required');
  if(operation.operation==='develop_redo')need(typeof operation.reason==='string'
    &&operation.reason.trim().length>0&&Buffer.byteLength(operation.reason,'utf8')<=500
    &&!/[\r\n\0]/.test(operation.reason),'develop_redo_reason_required');
  if(operation.operation==='bootstrap_review_recover')need(typeof operation.reason==='string'
    &&operation.reason.trim().length>0&&Buffer.byteLength(operation.reason,'utf8')<=500
    &&!/[\r\n\0]/.test(operation.reason),'bootstrap_review_recovery_reason_required');
  if(['decision','complete','qa','qa_result','context_refresh','finish','run_finalize'].includes(operation.operation))hex(operation.packageDigest);
  if(operation.operation==='qa_result')id(operation.testRunId);
  if(['context_refresh','finish','run_finalize'].includes(operation.operation)){
    need(operation.testRunId===null||typeof operation.testRunId==='string');
    if(operation.testRunId!==null)id(operation.testRunId);
  }
  return operation;
}

const rejected=(identity,error)=>{
  let code='invalid_input';
  try{const descriptor=Object.getOwnPropertyDescriptor(error,'code');
    if(descriptor&&Object.hasOwn(descriptor,'value')&&typeof descriptor.value==='string'
      &&/^[a-z][a-z0-9_]{0,63}$/.test(descriptor.value))code=descriptor.value;
  }catch{}
  return freeze({version:1,workflow:'cm-ai',operation:null,requestDigest:null,identity,
    outcome:'rejected',state:null,code,packageDigest:null,pendingAction:'none'});
};

function validateHostDecision(decision,status) {
  if(decision?.status==='denied'){
    shape(decision,['status','code']);need(decision.code==='permission_denied','invalid_host_decision');return 'denied';
  }
  shape(decision,['status']);need(decision.status==='approved','invalid_host_decision');
  need(status.packageDigest!==null,'stale_decision');return 'approved';
}

function effectSummary(operation,result,runner,identity) {
  if(result?.outcome==='rejected'){
    const rejection=json(result);shape(rejection,['outcome','code',...(Object.hasOwn(rejection,'reason')?['reason']:[])]);id(rejection.code);
    const current=boundStatus(runner.status(),identity);
    return summary(operation,{...current,code:rejection.code,...(rejection.reason?{reason:rejection.reason}:{})},'rejected');
  }
  if(operation.operation==='decision'&&identity.attempt===1&&result?.state==='changes_requested'){
    const next={...identity,attempt:2};
    boundStatus(runner.status(),next);
    return summary(operation,boundStatus(result,next),'advanced');
  }
  // A rejected current-session answer is checkpointed blocked/failed; the
  // runner's status shows it as the retryable develop_answer_invalid block.
  if(result?.state==='blocked'&&['failed','unavailable'].includes(result.code)){
    const current=runner.status();if(['develop_answer_invalid','develop_answer_missing'].includes(current.code))result=current;
  }
  return summary(operation,boundStatus(result,identity),result?.code==='handoff_exists'?'blocked':'advanced');
}

function contextEvidence(options,identity,operation) {
  try {
    const decision=inspectCmAiQaDecision({specsDir:options.specsDir,feature:options.feature,identity,
      packageDigest:operation.packageDigest});
    if(operation.testRunId===null)need(decision.status==='skipped','context_not_ready');
    else {
      need(decision.status==='triggered','context_not_ready');
      const result=inspectCmAiQaResult({specsDir:options.specsDir,feature:options.feature,identity,
        packageDigest:operation.packageDigest,testRunId:operation.testRunId});
      need(result.status==='passed','context_not_ready');
    }
  } catch {need(false,'context_not_ready');}
}

const contextSummary=(operation,status,refresh)=>freeze({version:1,workflow:'cm-ai',operation:operation.operation,
  requestDigest:digest(operation),identity:status.identity,outcome:'refreshed',state:status.state,
  code:refresh.state==='complete'?'context_complete':'context_refreshed',packageDigest:status.packageDigest,
  pendingAction:refresh.state==='complete'?'finish':'start_next_task',nextTask:refresh.nextTask,
  contextDigest:refresh.contextDigest,contextFiles:refresh.contextFiles});

function validateDocumentationResult(result,status,refresh,policy=null) {
  shape(result,['syncId','identity','packageDigest','contextDigest','status','reason','at',
    ...(policy?.enabled&&Object.hasOwn(result,'closeout')?['closeout']:[])]);
  if(Object.hasOwn(result,'closeout'))readCloseoutReport(result.closeout);
  id(result.syncId);validIdentity(result.identity);hex(result.packageDigest);hex(result.contextDigest);
  need(sameIdentity(result.identity,status.identity),'identity_mismatch');
  need(result.packageDigest===status.packageDigest&&result.contextDigest===refresh.contextDigest,'stale_documentation');
  need(['completed','blocked'].includes(result.status),'invalid_documentation_result');
  text(result.reason);need(result.reason.length<=200&&!/[\n\r\0]/.test(result.reason),'invalid_documentation_result');
  need(typeof result.at==='string'
    &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(result.at)
    &&Number.isFinite(Date.parse(result.at)),'invalid_documentation_result');
  return result.status;
}

export function createCmAiConversationEntry(options) {
  const optionKeys=['specsDir','codeProject','feature','identity','runner'];
  if(options&&Object.hasOwn(options,'hostDecision'))optionKeys.push('hostDecision');
  if(options&&Object.hasOwn(options,'hostDecisionProvider'))optionKeys.push('hostDecisionProvider');
  if(options&&Object.hasOwn(options,'developmentAttempt'))optionKeys.push('developmentAttempt');
  if(options&&Object.hasOwn(options,'qaDecision'))optionKeys.push('qaDecision');
  if(options&&Object.hasOwn(options,'qaDecisionProvider'))optionKeys.push('qaDecisionProvider');
  if(options&&Object.hasOwn(options,'qaExecutor'))optionKeys.push('qaExecutor');
  if(options&&Object.hasOwn(options,'rerunUnknownQa'))optionKeys.push('rerunUnknownQa');
  if(options&&Object.hasOwn(options,'rerunBlockedQa'))optionKeys.push('rerunBlockedQa');
  if(options&&Object.hasOwn(options,'qaEnvironmentFailure'))optionKeys.push('qaEnvironmentFailure');
  if(options&&Object.hasOwn(options,'qaLogHome'))optionKeys.push('qaLogHome');
  if(options&&Object.hasOwn(options,'applicableAgentFiles'))optionKeys.push('applicableAgentFiles');
  if(options&&Object.hasOwn(options,'documentationResult'))optionKeys.push('documentationResult');
  if(options&&Object.hasOwn(options,'documentationProvider'))optionKeys.push('documentationProvider');
  if(options&&Object.hasOwn(options,'knowledgeCloseout'))optionKeys.push('knowledgeCloseout');
  if(options&&Object.hasOwn(options,'codeProjects'))optionKeys.push('codeProjects');
  if(options&&Object.hasOwn(options,'parallelSelection'))optionKeys.push('parallelSelection');
  if(options&&Object.hasOwn(options,'allowAbandonReview'))optionKeys.push('allowAbandonReview');
  if(options&&Object.hasOwn(options,'allowAbandonEffect'))optionKeys.push('allowAbandonEffect');
  if(options&&Object.hasOwn(options,'allowBootstrapReviewRecovery'))optionKeys.push('allowBootstrapReviewRecovery');
  if(options&&Object.hasOwn(options,'allowDevelopRedo'))optionKeys.push('allowDevelopRedo');
  if(options&&Object.hasOwn(options,'holdRevision'))optionKeys.push('holdRevision');
  if(options&&Object.hasOwn(options,'featureSelection'))optionKeys.push('featureSelection');
  shape(options,optionKeys);
  need(!Object.hasOwn(options,'featureSelection')||options.featureSelection===options.feature,'invalid_input');
  need(!Object.hasOwn(options,'holdRevision')||options.holdRevision===true,'invalid_input');
  if(Object.hasOwn(options,'developmentAttempt'))need([1,2].includes(options.developmentAttempt),'invalid_development_attempt');
  text(options.specsDir);text(options.codeProject);text(options.feature);
  const ownerIdentity=json(options.identity);validIdentity(ownerIdentity);
  const runner=options.runner;
  const runnerKeys=['executeEffect','status','cancel','run'];
  if(runner&&Object.hasOwn(runner,'verificationBlocks'))runnerKeys.push('verificationBlocks');
  if(runner&&Object.hasOwn(runner,'completionBlocks'))runnerKeys.push('completionBlocks');
  if(runner&&Object.hasOwn(runner,'recheckLearningInput'))runnerKeys.push('recheckLearningInput');
  if(runner&&Object.hasOwn(runner,'attachLearningEvidence'))runnerKeys.push('attachLearningEvidence');
  if(runner&&Object.hasOwn(runner,'inspectFixAssociation'))runnerKeys.push('inspectFixAssociation');
  if(runner&&Object.hasOwn(runner,'acceptCompletedFix'))runnerKeys.push('acceptCompletedFix');
  if(runner&&Object.hasOwn(runner,'attachQa'))runnerKeys.push('attachQa');
  if(runner&&Object.hasOwn(runner,'reviseQa'))runnerKeys.push('reviseQa');
  if(runner&&Object.hasOwn(runner,'supersedeEvidence'))runnerKeys.push('supersedeEvidence');
  if(runner&&Object.hasOwn(runner,'rebindSpecification'))runnerKeys.push('rebindSpecification');
  if(runner&&Object.hasOwn(runner,'abandonReview'))runnerKeys.push('abandonReview');
  if(runner&&Object.hasOwn(runner,'reconcileReview'))runnerKeys.push('reconcileReview');
  if(runner&&Object.hasOwn(runner,'abandonEffect'))runnerKeys.push('abandonEffect');
  if(runner&&Object.hasOwn(runner,'recoverBootstrapReview'))runnerKeys.push('recoverBootstrapReview');
  if(runner&&Object.hasOwn(runner,'redoDevelop'))runnerKeys.push('redoDevelop');
  if(runner&&Object.hasOwn(runner,'recoverCommit'))runnerKeys.push('recoverCommit');
  if(runner&&Object.hasOwn(runner,'interruptions'))runnerKeys.push('interruptions');
  if(runner&&Object.hasOwn(runner,'inspectBootstrapAdmission'))runnerKeys.push('inspectBootstrapAdmission');
  shape(runner,runnerKeys);
  for(const name of ['executeEffect','status','cancel','run'])need(typeof runner[name]==='function');
  if(Object.hasOwn(runner,'completionBlocks'))need(typeof runner.completionBlocks==='function');
  if(Object.hasOwn(runner,'recheckLearningInput'))need(typeof runner.recheckLearningInput==='function');
  if(Object.hasOwn(runner,'attachLearningEvidence'))need(typeof runner.attachLearningEvidence==='function');
  if(Object.hasOwn(runner,'inspectFixAssociation'))need(typeof runner.inspectFixAssociation==='function');
  if(Object.hasOwn(runner,'acceptCompletedFix'))need(typeof runner.acceptCompletedFix==='function');
  if(Object.hasOwn(runner,'attachQa'))need(typeof runner.attachQa==='function');
  if(Object.hasOwn(runner,'reviseQa'))need(typeof runner.reviseQa==='function');
  if(Object.hasOwn(runner,'abandonReview'))need(typeof runner.abandonReview==='function');
  if(Object.hasOwn(runner,'reconcileReview'))need(typeof runner.reconcileReview==='function');
  if(Object.hasOwn(runner,'abandonEffect'))need(typeof runner.abandonEffect==='function');
  if(Object.hasOwn(runner,'recoverBootstrapReview'))need(typeof runner.recoverBootstrapReview==='function');
  if(Object.hasOwn(runner,'redoDevelop'))need(typeof runner.redoDevelop==='function');
  if(Object.hasOwn(runner,'recoverCommit'))need(typeof runner.recoverCommit==='function');
  if(Object.hasOwn(runner,'interruptions'))need(typeof runner.interruptions==='function');
  if(Object.hasOwn(runner,'inspectBootstrapAdmission'))need(typeof runner.inspectBootstrapAdmission==='function');
  need(options.allowAbandonReview===undefined||typeof options.allowAbandonReview==='boolean','invalid_input');
  let abandonPermission=options.allowAbandonReview===true;
  need(options.allowAbandonEffect===undefined||typeof options.allowAbandonEffect==='boolean','invalid_input');
  let abandonEffectPermission=options.allowAbandonEffect===true;
  need(options.allowBootstrapReviewRecovery===undefined||typeof options.allowBootstrapReviewRecovery==='boolean','invalid_input');
  let bootstrapReviewRecoveryPermission=options.allowBootstrapReviewRecovery===true;
  need(options.allowDevelopRedo===undefined||typeof options.allowDevelopRedo==='boolean','invalid_input');
  let developRedoPermission=options.allowDevelopRedo===true;

  const hostDecision=Object.hasOwn(options,'hostDecision')?json(options.hostDecision):null;
  let hostDecisionProvider=null,pendingReviewDecision=null;
  if(Object.hasOwn(options,'hostDecisionProvider')){
    shape(options.hostDecisionProvider,['decide','timeoutMs']);
    const {decide,timeoutMs}=options.hostDecisionProvider;
    need(typeof decide==='function'&&Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000);
    need(hostDecision===null);hostDecisionProvider={decide,timeoutMs};
  }
  const qaDecision=Object.hasOwn(options,'qaDecision')?json(options.qaDecision):null;
  const qaProvider=options.qaDecisionProvider??null;
  if(qaProvider!==null){
    shape(qaProvider,['decide','timeoutMs']);
    need(typeof qaProvider.decide==='function'&&Number.isInteger(qaProvider.timeoutMs)
      &&qaProvider.timeoutMs>=1&&qaProvider.timeoutMs<=60000);
    need(qaDecision===null);
  }
  const decideQa=qaProvider?.decide,qaTimeout=qaProvider?.timeoutMs;
  let pendingQa=null;
  let qaExecutor=null,pendingExecution=null,cancellationEpoch=0;
  const inFlightHandles=new Set();
  let rerunUnknownQa=options.rerunUnknownQa??false;need(typeof rerunUnknownQa==='boolean');
  let rerunBlockedQa=options.rerunBlockedQa??false;need(typeof rerunBlockedQa==='boolean');
  need(!(rerunUnknownQa&&rerunBlockedQa),'qa_recovery_authorization_required');
  // Operator declaration that the latest FAIL came from the environment; only
  // meaningful with the one-shot rerun authorization and consumed with it.
  const qaEnvironmentFailure=options.qaEnvironmentFailure??null;
  // With --rerun-unknown-qa it is the operator's attestation that older timed-out
  // case rows (no host_request_timeout field) had no session answer.
  need(qaEnvironmentFailure===null||(rerunBlockedQa||rerunUnknownQa)&&validEnvironmentFailureReason(qaEnvironmentFailure),'qa_recovery_authorization_required');
  if(Object.hasOwn(options,'qaExecutor')){
    shape(options.qaExecutor,['mode','caseCount','timeoutMs','run',
      ...(Object.hasOwn(options.qaExecutor,'configuration')?['configuration']:[]),
      ...(Object.hasOwn(options.qaExecutor,'requestTimeoutMs')?['requestTimeoutMs']:[]),
      ...(Object.hasOwn(options.qaExecutor,'prepare')?['prepare']:[])]);
    const {run,prepare,...config}=options.qaExecutor;
    need(typeof run==='function'&&(prepare===undefined||typeof prepare==='function'));
    qaExecutor={...json(config),run,...(prepare?{prepare}:{})};
    need(['commands','browser','all'].includes(config.mode)&&Number.isSafeInteger(config.caseCount)&&config.caseCount>0);
    need(Number.isInteger(config.timeoutMs)&&config.timeoutMs>=1&&config.timeoutMs<=3600000);
    need(config.requestTimeoutMs===undefined||Number.isInteger(config.requestTimeoutMs)&&config.requestTimeoutMs>=1&&config.requestTimeoutMs<=3600000);
  }
  const applicableAgentFiles=Object.hasOwn(options,'applicableAgentFiles')?json(options.applicableAgentFiles):null;
  const documentationResult=Object.hasOwn(options,'documentationResult')?json(options.documentationResult):null;
  const knowledgeCloseout=Object.hasOwn(options,'knowledgeCloseout')?readCloseoutPolicy(options.knowledgeCloseout):null;
  if(Object.hasOwn(options,'codeProjects'))need(knowledgeCloseout!==null&&Array.isArray(options.codeProjects)
    &&options.codeProjects.length>0&&options.codeProjects.every(value=>typeof value==='string'),'invalid_input');
  let documentationProvider=null,pendingDocumentation=null,inspectedDocumentation=null;
  if(Object.hasOwn(options,'documentationProvider')){
    shape(options.documentationProvider,['inspect','timeoutMs']);
    const {inspect,timeoutMs}=options.documentationProvider;
    need(typeof inspect==='function'&&Number.isInteger(timeoutMs)&&timeoutMs>=1&&timeoutMs<=60000);
    need(documentationResult===null);documentationProvider={inspect,timeoutMs};
  }
  if(Object.hasOwn(options,'qaLogHome'))text(options.qaLogHome);

  async function documentationFor(status,refresh){
    if(documentationProvider===null)return documentationResult;
    const binding=json({specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,
      identity:status.identity,packageDigest:status.packageDigest,contextDigest:refresh.contextDigest,
      ...(knowledgeCloseout===null?{}:{closeout:knowledgeCloseout,
        ...(options.codeProjects?{codeProjects:options.codeProjects}:{})})});
    const syncId=`docs-${digest(binding).slice(0,48)}`;
    if(inspectedDocumentation?.syncId===syncId)return inspectedDocumentation;
    need(pendingDocumentation===null,'documentation_pending');
    need(!status.cancellationRequested&&!status.cancelAfterCommit,'cancelled');
    const controller=new AbortController();pendingDocumentation=controller;
    let timer,timedOut=false;
    try{
      const interrupted=new Promise((_,reject)=>{
        controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Documentation interrupted'),
          {code:timedOut?'documentation_timeout':'cancelled'})),{once:true});
        timer=setTimeout(()=>{timedOut=true;controller.abort();},documentationProvider.timeoutMs);
      });
      const result=json(await Promise.race([Promise.resolve().then(()=>{
        need(!controller.signal.aborted,'cancelled');
        return documentationProvider.inspect(freeze({...binding,syncId}),controller.signal);
      }),interrupted]));
      need(!controller.signal.aborted,'cancelled');need(result.syncId===syncId,'stale_documentation');
      const current=boundStatus(runner.status(),status.identity);
      need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===status.packageDigest,'stale_documentation');
      const reread=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,...(options.featureSelection===undefined?{}:{featureSelection:options.featureSelection}),
        feature:options.feature,applicableAgentFiles});
      need(reread.state==='complete'&&reread.contextDigest===refresh.contextDigest,'stale_documentation');
      validateDocumentationResult(result,current,reread,knowledgeCloseout);
      if(result.status==='completed')inspectedDocumentation=result;
      return result;
    }finally{clearTimeout(timer);pendingDocumentation=null;}
  }

  // Admission summaries do not describe a runner transition. Track their
  // origin privately; other awaiting results still need progress projection.
  const admissionReports=new WeakSet();
  async function route(raw) {
    const operation=readOperation(raw);
    need(sameTask(operation.identity,ownerIdentity),'identity_mismatch');
    need(operation.identity.attempt>=ownerIdentity.attempt,'identity_mismatch');
    const admission=['start','resume'].includes(operation.operation)
      ?runner.inspectBootstrapAdmission?.()??inspectCmAiAdmission({specsDir:options.specsDir,codeProject:options.codeProject,...selectedFeature(options.featureSelection)}):null;
    if(admission&&admission.state!=='ready'){
      // Original callers still stop before reading runner state. A caller using
      // a newer attempt must bind it to the runner before we report its block.
      const blockedIdentity=sameIdentity(operation.identity,ownerIdentity)?ownerIdentity:
        boundStatus(runner.status(),operation.identity).identity;
      const report=summary(operation,{state:admission.state,code:admission.reason,
        identity:blockedIdentity,packageDigest:null},'awaiting');
      admissionReports.add(report);return report;
    }
    const initialStatus=runner.status();
    const identity=json(initialStatus.identity);validIdentity(identity);
    need(sameTask(identity,ownerIdentity)&&identity.attempt>=ownerIdentity.attempt,'identity_mismatch');
    // Stable run-definition identity can query/control or resume the current
    // attempt. Package-bound mutations must name the current attempt exactly.
    const stableControl=['status','cancel','advance','resume','reconcile_review','abandon_review','abandon_effect','bootstrap_review_recover','develop_redo'].includes(operation.operation)
      &&sameIdentity(operation.identity,ownerIdentity);
    need(sameIdentity(operation.identity,identity)||stableControl,'identity_mismatch');
    if(operation.operation==='advance'){
      const startedEpoch=cancellationEpoch;
      const notCancelled=()=>{const current=runner.status();
        need(startedEpoch===cancellationEpoch&&!current.cancellationRequested&&!current.cancelAfterCommit,'cancelled');};
      // Reuse the runner's two-attempt lifecycle, including its fresh review
      // identity and review_limit. Only no-result transport timeouts may redispatch.
      const call=(name,packageDigest,extra={})=>route({version:1,operation:name,
        requestId:operation.requestId,identity:runner.status().identity,...(packageDigest===undefined?{}:{packageDigest}),...extra});
      let result=await call('status');
      for(let round=identity.attempt;round<=2;round++){
        if(result.code===null&&['ready','changes_requested'].includes(result.state)||retryDeveloper(result))result=await call('start');
        if(['reported','advanced'].includes(result.outcome)&&(result.code===null&&result.state==='awaiting_review'||retryReview(result)))
          result=await call('decision',result.packageDigest);
        if(result.outcome==='advanced'&&result.code===null&&result.state==='changes_requested'
          &&result.identity.attempt===round+1)continue;
        if(['reported','advanced'].includes(result.outcome)
          &&(result.code===null&&result.state==='approved'||completionRetryable(result)))
          result=await call('complete',result.packageDigest);
        break;
      }
      if(['reported','advanced'].includes(result.outcome)&&result.code===null&&result.state==='fixture_completed'){
        let qaTestRunId=null;
        notCancelled();
        result=await call('qa',result.packageDigest);
        if(result.outcome==='recorded'&&result.code==='qa_triggered'&&qaExecutor!==null){
          // The host is constructed before N5 marks the task complete. Freeze the
          // execution plan only now, then retain it throughout this invocation.
          if(qaExecutor.prepare){
            const prepared=json(qaExecutor.prepare());shape(prepared,['mode','caseCount','configuration']);
            need(['commands','browser','all'].includes(prepared.mode)
              &&Number.isSafeInteger(prepared.caseCount)&&prepared.caseCount>0,'qa_plan_invalid');
            qaExecutor={...qaExecutor,...prepared};
          }
          notCancelled();
          need(pendingExecution===null,'qa_execution_pending');
          const binding={specsDir:options.specsDir,feature:options.feature,identity:result.identity,packageDigest:result.packageDigest};
          let previous,recovery=null,configurationRecovery=false,incompleteReport=false,timedOutCall=false;
          const timedOutRecovery=()=>inspectCmAiQaRecovery(binding,{timedOut:true,requestTimeoutMs:qaExecutor.requestTimeoutMs??null,
            attestation:rerunUnknownQa?qaEnvironmentFailure:null});
          try{previous=latestCmAiQaRun(binding);}
          catch(error){
            if(error.code==='qa_result_superseded'){
              recovery=inspectCmAiQaConfigurationRecovery(binding);
              need(recovery!==null,'qa_revision_invalid');configurationRecovery=true;previous=null;
            }else{
              if(error.code!=='qa_result_incomplete')throw error;
              if(rerunUnknownQa){
                try{recovery=inspectCmAiQaRecovery(binding);}
                catch(error){if(error.code!=='qa_execution_unknown')throw error;}
                // A call stopped by qa_execution_timeout whose only non-PASS
                // cases are host request timeouts: supersede it into the next round.
                if(recovery===null)try{recovery=timedOutRecovery();timedOutCall=true;}
                catch(error){if(error.code!=='qa_execution_unknown')throw error;}
              }
              // The call wrote its fixed report but no complete row (a host before
              // this fix rejected stale_qa in between). --rerun-blocked-qa reads
              // that report under the ordinary blocked-evidence rules.
              if(recovery===null&&rerunBlockedQa){
                try{recovery=inspectCmAiQaRecovery(binding,{blocked:true,environment:qaExecutor.configuration?.environment,
                  environmentFailure:qaEnvironmentFailure});}
                catch(error){
                  // Name the flag that does recover a timed-out call.
                  let timedOutCallRecoverable=false;try{timedOutRecovery();timedOutCallRecoverable=true;}
                  catch(probe){timedOutCallRecoverable=probe?.code==='qa_environment_failure_required';}
                  if(error.code==='qa_rerun_not_blocked_by_evidence'&&timedOutCallRecoverable)
                    throw Object.assign(new Error('use --rerun-unknown-qa'),{code:'qa_rerun_unknown_qa_required'});
                  throw error;
                }
                incompleteReport=true;
              }
              if(recovery===null)return summary(operation,{...runner.status(),code:'qa_execution_unknown'},'blocked');
              previous=null;
            }
          }
          // The authorization's durable effect is a replacement of a timed-out
          // decision with no QA run under it yet (just written, or written
          // before an interruption): run the ordinary first round, not a rerun.
          if(rerunBlockedQa&&previous===null&&replacesTimedOutQaDecision(binding))rerunBlockedQa=false;
          if(rerunBlockedQa&&!incompleteReport){
            need(previous!==null,'qa_rerun_not_blocked_by_evidence');
            recovery=inspectCmAiQaRecovery(binding,{blocked:true,environment:qaExecutor.configuration?.environment,
              environmentFailure:qaEnvironmentFailure});
          }
          let testRunId=previous?.testRunId;
          const accepted=runner.status().acceptedQaFix;
          const repaired=previous?.status==='failed'&&accepted?.testRunId===previous.testRunId;
          // An accepted repair already owns the next round of that FAIL.
          need(!(rerunBlockedQa&&repaired),'qa_rerun_not_blocked_by_evidence');
          if(previous===null||repaired||rerunBlockedQa){
            // Later rounds require an accepted completed repair or explicit
            // evidence recovery/configuration revision. Unknown execution stops.
            const qaRound=recovery?recovery.qaRound+(rerunBlockedQa||configurationRecovery||timedOutCall?1:0):(repaired?accepted.qaRound+1:1);
            need(qaRound>=1&&qaRound<=3,'qa_round_invalid');
            testRunId=`qa-${digest(recovery?{...binding,previousTestRunId:recovery.testRunId}:
              repaired?{...binding,qaRound,repair:accepted.evidenceDigest}:binding).slice(0,48)}`;
            const invocation={...binding,codeProject:options.codeProject,testRunId,mode:qaExecutor.mode,caseCount:qaExecutor.caseCount,
              ...(repaired||recovery?{qaRound}: {})};
            const logInput={...invocation,...(Object.hasOwn(options,'qaLogHome')?{logHome:options.qaLogHome}:{})};
            notCancelled();
            if(recovery&&!configurationRecovery){
              recordCmAiQaRun({...logInput,testRunId:recovery.testRunId,mode:recovery.mode,
                caseCount:recovery.caseCount,qaRound:recovery.qaRound,phase:rerunBlockedQa||timedOutCall?'superseded':'abandoned',
                ...(timedOutCall?{timedOutRecovery:{requestTimeoutMs:recovery.requestTimeoutMs,attestation:recovery.attestation}}:{}),
                ...(rerunBlockedQa?{expectedEnvironment:qaExecutor.configuration?.environment??null}:{}),
                ...(rerunBlockedQa&&qaEnvironmentFailure!==null?{environmentFailure:qaEnvironmentFailure}:{})});
              rerunUnknownQa=false;rerunBlockedQa=false;
            }
            recordCmAiQaRun({...logInput,phase:'start',
              deferredCases:qaExecutor.configuration?.plan?.deferred_cases??[],
              ...(qaExecutor.configuration?.plan?.dropped_task_cases?{droppedTaskCases:qaExecutor.configuration.plan.dropped_task_cases}:{}),
              ...(qaExecutor.configuration?.plan?.dropped_task_commands?{droppedTaskCommands:qaExecutor.configuration.plan.dropped_task_commands}:{}),
              ...(recovery?{previousTestRunId:recovery.testRunId}:{})});
            const controller=new AbortController();pendingExecution=controller;
            let timer,timedOut=false;
            try{
              const interrupted=new Promise((_,reject)=>{
                controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('QA interrupted'),
                  {code:timedOut?'qa_execution_timeout':'cancelled'})),{once:true});
                timer=setTimeout(()=>{timedOut=true;controller.abort();},qaExecutor.timeoutMs);
              });
              const executed=await Promise.race([Promise.resolve().then(()=>{
                notCancelled();
                need(!controller.signal.aborted,'cancelled');
                return qaExecutor.run(freeze(invocation),controller.signal);
              }),interrupted]);
              need(!controller.signal.aborted,'cancelled');
              // A run that moved on meanwhile (for example files in scope replaced):
              // still record a BLOCKED or FAIL this call observed, so the restored run
              // can take the ordinary --rerun-blocked-qa path instead of staying
              // qa_execution_unknown (a source change is already BLOCKED/sourceChanged).
              // A PASS is never recorded unconfirmed; it stays unknown, and only
              // --rerun-unknown-qa may discard that fully backed all-PASS report.
              const current=boundStatus(runner.status(),result.identity);
              const fresh=current.state==='fixture_completed'&&current.code==null&&current.packageDigest===result.packageDigest;
              if(fresh||executed.result!=='PASS')recordCmAiQaRun({...logInput,phase:'complete',result:executed});
              need(fresh,'stale_qa');
            }finally{clearTimeout(timer);pendingExecution=null;}
          }
          result=await call('qa_result',result.packageDigest,{testRunId});
          qaTestRunId=testRunId;
          if(result.code==='qa_passed'&&applicableAgentFiles!==null)
            result=await call('context_refresh',result.packageDigest,{testRunId});
        }
        // Only the already-bound host decision can skip execution. A triggered
        // QA stops at qa_execution until the actual executor supplies evidence.
        if(result.outcome==='recorded'&&result.code==='qa_skipped'&&applicableAgentFiles!==null)
          result=await call('context_refresh',result.packageDigest,{testRunId:null});
        if(result.code==='context_complete'){
          notCancelled();
          result=await call('finish',result.packageDigest,{testRunId:qaTestRunId});
          if(result.code==='documentation_synced'){
            notCancelled();
            result=await call('run_finalize',result.packageDigest,{testRunId:qaTestRunId});
          }
        }
      }
      // Next-task execution and QA execution still need their host adapters;
      // a refreshed nextTask is not permission to dispatch it or claim run_done.
      const advanced=freeze({...result,operation:'advance',requestDigest:digest(operation)});
      if(admissionReports.has(result))admissionReports.add(advanced);
      return advanced;
    }
    if(operation.operation==='status'){
      const status=boundStatus(initialStatus,identity);
      return summary(operation,status,'reported');
    }
    if(operation.operation==='cancel'){
      const interrupted=inFlightHandles.size>0||pendingReviewDecision!==null||pendingQa!==null
        ||pendingExecution!==null||pendingDocumentation!==null;
      cancellationEpoch++;
      pendingReviewDecision?.abort();
      pendingQa?.abort();
      pendingExecution?.abort();
      pendingDocumentation?.abort();
      const status=boundStatus(runner.cancel(),identity);
      return summary(operation,status,status.state==='cancelled'||interrupted?'cancelled':'reported');
    }
    if(operation.operation==='reconcile_review'){
      const result=runner.reconcileReview?.({invocationId:operation.invocationId})
        ??{outcome:'rejected',code:'review_reconciliation_unavailable'};
      return result.outcome==='rejected'?summary(operation,{...runner.status(),code:result.code},'rejected')
        :summary(operation,result,'reconciled');
    }
    if(operation.operation==='abandon_review'){
      if(!abandonPermission)return summary(operation,{...runner.status(),
        code:'review_abandon_authorization_required'},'rejected');
      abandonPermission=false;
      const result=runner.abandonReview?.({allowed:true,reason:operation.reason})
        ??{outcome:'rejected',code:'review_abandon_unavailable'};
      if(result.outcome==='rejected')return summary(operation,{...runner.status(),code:result.code},'rejected');
      return summary(operation,boundStatus(result,identity),'abandoned');
    }
    if(operation.operation==='abandon_effect'){
      if(!abandonEffectPermission)return summary(operation,{...runner.status(),
        code:'effect_abandon_authorization_required'},'rejected');
      abandonEffectPermission=false;
      const result=runner.abandonEffect?.({allowed:true,reason:operation.reason})
        ??{outcome:'rejected',code:'effect_abandon_unavailable'};
      if(result.outcome==='rejected')return summary(operation,{...runner.status(),code:result.code,
        ...(result.reason?{reason:result.reason}:{})},'rejected');
      // V8: an interrupted step continues in the run (recorded); a void ends it.
      return summary(operation,boundStatus(result,identity),result.code==='effect_abandoned'?'abandoned':'recorded');
    }
    if(operation.operation==='develop_redo'){
      if(!developRedoPermission)return summary(operation,{...runner.status(),
        code:'develop_redo_authorization_required'},'rejected');
      developRedoPermission=false;
      const result=runner.redoDevelop?.({allowed:true,reason:operation.reason})
        ??{outcome:'rejected',code:'develop_redo_unavailable'};
      if(result.outcome==='rejected')return summary(operation,{...runner.status(),code:result.code,
        ...(result.reason?{reason:result.reason}:{})},'rejected');
      return summary(operation,boundStatus(result,identity),'recorded');
    }
    if(operation.operation==='bootstrap_review_recover'){
      if(!bootstrapReviewRecoveryPermission)return summary(operation,{...runner.status(),
        code:'bootstrap_review_recovery_authorization_required'},'rejected');
      bootstrapReviewRecoveryPermission=false;
      const result=runner.recoverBootstrapReview?.({allowed:true,reason:operation.reason})
        ??{outcome:'rejected',code:'bootstrap_review_recovery_unavailable'};
      if(result.outcome==='rejected')return summary(operation,{...runner.status(),code:result.code,
        ...(result.reason?{reason:result.reason}:{})},'rejected');
      return summary(operation,boundStatus(result,identity),'advanced');
    }
    if(operation.operation==='decision'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_decision');
      if(status.code==='review_package_changed')return summary(operation,status,'rejected');
      let decision=hostDecision;
      if(hostDecisionProvider!==null){
        // A historical terminal or outstanding invocation is owned by the runner;
        // never ask for fresh authorization to replay or reopen it.
        if(!(status.state==='awaiting_review'&&status.code===null)&&!retryReview(status))return summary(operation,status,'reported');
        need(pendingReviewDecision===null,'review_decision_pending');
        need(!status.cancellationRequested&&!status.cancelAfterCommit,'cancelled');
        const controller=new AbortController();pendingReviewDecision=controller;
        let timer,timedOut=false;
        try{
          const interrupted=new Promise((_,reject)=>{
            controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('Review decision interrupted'),
              {code:timedOut?'review_decision_timeout':'cancelled'})),{once:true});
            timer=setTimeout(()=>{timedOut=true;controller.abort();},hostDecisionProvider.timeoutMs);
          });
          const binding=freeze(json({specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,
            identity,packageDigest:operation.packageDigest}));
          decision=json(await Promise.race([Promise.resolve().then(()=>{
            need(!controller.signal.aborted,'cancelled');return hostDecisionProvider.decide(binding,controller.signal);
          }),interrupted]));
          need(!controller.signal.aborted,'cancelled');
          const current=boundStatus(runner.status(),identity);
          need(current.state===status.state&&current.code===status.code
            &&current.packageDigest===operation.packageDigest,'stale_decision');
          need(!current.cancellationRequested&&!current.cancelAfterCommit,'cancelled');
        }finally{clearTimeout(timer);pendingReviewDecision=null;}
      }
      if(decision===null)return summary(operation,{...status,code:'decision_required'},'awaiting');
      if(validateHostDecision(decision,status)==='denied')
        return summary(operation,{...status,code:'permission_denied'},'denied');
      const retries=retryReview(status)?status.calls.filter(call=>call.channel==='host-authorized'
        &&['failed','abandoned'].includes(call.terminal)
        &&call.contextId===status.reviewInvocation.registration.grant.logicalContextId).length:0;
      const resumed=runner.interruptions?.('review')??0;
      const effectId=`review-${identity.attempt}${retries?`-retry-${retries}`:''}${resumed?`-resume-${resumed}`:''}`;
      const result=await runner.executeEffect({version:1,id:effectId,identity,kind:'review'});
      return effectSummary(operation,result,runner,identity);
    }
    if(operation.operation==='complete'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_completion');
      if(status.code==='review_package_changed')return summary(operation,status,'rejected');
      if(status.code==='completion_package_changed'&&status.retryReady===false)return summary(operation,status,'rejected');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(['approved','fixture_completed'].includes(status.state)||completionRetryable(status),'completion_not_ready');
      // A45: finish the interrupted task commit from its journaled plan only.
      if(status.code==='complete_commit_interrupted'){
        const recovered=runner.recoverCommit?.()??{outcome:'rejected',code:'commit_recovery_unavailable'};
        return effectSummary(operation,recovered,runner,identity);
      }
      const retries=runner.completionBlocks?.()??0,resumed=runner.interruptions?.('complete')??0;
      const effectId=`complete-${identity.attempt}${retries?`-retry-${retries}`:''}${resumed?`-resume-${resumed}`:''}`;
      const result=await runner.executeEffect({version:1,id:effectId,identity,kind:'complete'});
      return effectSummary(operation,result,runner,identity);
    }
    if(operation.operation==='qa'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','qa_not_ready');
      let decision=qaDecision,previousDecisionId=null;
      if(qaProvider!==null){
        need(pendingQa===null,'qa_decision_pending');
        const binding={specsDir:options.specsDir,feature:options.feature,identity,packageDigest:operation.packageDigest};
        decision=findCmAiQaDecision(binding);
        // An older host recorded a missed qa_assess window as this durable
        // block. Only the explicit one-shot rerun authorization asks again; the
        // new decision is appended with a link, the old row stays history.
        if(rerunBlockedQa&&timedOutQaDecision(decision)){previousDecisionId=decision.decisionId;decision=null;}
        // A bound historical decision is evidence, not a fresh proposal. Keep
        // the existing downstream compatibility path; do not rewrite its log.
        if(decision!==null)return summary(operation,{...status,code:`qa_${decision.status}`,
          ...(decision.status==='blocked'?{reason:decision.reason}:{})},'recorded');
        if(decision===null){
          const controller=new AbortController();pendingQa=controller;
          let timer,timedOut=false;
          try{
            const interrupted=new Promise((_,reject)=>{
              controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('QA decision interrupted'),
                {code:timedOut?'qa_decision_timeout':'cancelled'})),{once:true});
              // The request watchdog normally settles first with the same
              // retryable qa_decision_timeout; this is the outer backstop.
              timer=setTimeout(()=>{timedOut=true;controller.abort();},qaTimeout+1000);
            });
            decision=json(await Promise.race([
              Promise.resolve().then(()=>{need(!controller.signal.aborted,'cancelled');
                return decideQa(freeze({...binding,codeProject:options.codeProject,
                  ...(previousDecisionId===null?{}:{previousDecisionId})}),controller.signal);}),interrupted]));
            need(!controller.signal.aborted,'cancelled');
            const current=boundStatus(runner.status(),identity);
            need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===operation.packageDigest,'stale_qa');
          }finally{clearTimeout(timer);pendingQa=null;}
        }
      }
      if(decision===null)return summary(operation,{...status,code:'qa_decision_required'},'awaiting');
      if(decision.status==='skipped'){
        const admission=inspectCmAiAdmission({specsDir:options.specsDir,codeProject:options.codeProject,...selectedFeature(options.featureSelection)});
        if(!['ready','complete'].includes(admission.state))
          return summary(operation,{...status,code:admission.reason},'awaiting');
        const feature=admission.features.find(item=>item.name===options.feature);
        need(feature,'qa_policy_unavailable');
        // N6 feature completion is a mandatory trigger, regardless of score.
        // Ask for the proper bound decision; do not synthesize authorization.
        if(feature.pending===0)return summary(operation,{...status,code:'qa_mandatory_required'},'awaiting');
      }
      const input={specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,identity,
        packageDigest:operation.packageDigest,decision};
      if(Object.hasOwn(options,'qaLogHome'))input.logHome=options.qaLogHome;
      if(previousDecisionId!==null)input.previousDecisionId=previousDecisionId;
      recordCmAiQaDecision(input);
      return summary(operation,{...status,code:`qa_${decision.status}`},'recorded');
    }
    if(operation.operation==='qa_result'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','qa_not_ready');
      const result=inspectCmAiQaResult({specsDir:options.specsDir,feature:options.feature,identity,
        packageDigest:operation.packageDigest,testRunId:operation.testRunId});
      const code=result.status==='blocked'?'qa_result_blocked':`qa_${result.status}`;
      if(result.status==='failed'){
        const fixHandoff=readHostQaFixHandoff({specsDir:options.specsDir,codeProject:options.codeProject,
          feature:options.feature,identity,packageDigest:operation.packageDigest,testRunId:operation.testRunId});
        return freeze({...summary(operation,{...status,code},'verified'),fixHandoff,
          pendingAction:fixHandoff.status==='authorization_required'?'fix_authorization':
            fixHandoff.status==='dispatch_required'?'fix_dispatch':'none'});
      }
      return freeze({...summary(operation,{...status,code},'verified'),
        ...(code==='qa_result_blocked'&&rerunBlockedQa?{pendingAction:'qa'}:{})});
    }
    if(operation.operation==='context_refresh'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','context_not_ready');
      contextEvidence(options,identity,operation);
      need(applicableAgentFiles!==null,'context_invalid');
      const refresh=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,...(options.featureSelection===undefined?{}:{featureSelection:options.featureSelection}),
        feature:options.feature,applicableAgentFiles});
      if(!['ready','complete'].includes(refresh.state))return summary(operation,{state:refresh.state,
        code:refresh.reason,identity,packageDigest:status.packageDigest},'awaiting');
      return contextSummary(operation,status,refresh);
    }
    if(operation.operation==='finish'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','run_not_ready');
      contextEvidence(options,identity,operation);
      need(applicableAgentFiles!==null,'context_invalid');
      const refresh=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,...(options.featureSelection===undefined?{}:{featureSelection:options.featureSelection}),
        feature:options.feature,applicableAgentFiles});
      need(refresh.state==='complete','run_not_ready');
      const projectQa=projectQaSummary(operation,status,options);if(projectQa)return projectQa;
      const documentationEpoch=cancellationEpoch;
      const documentation=await documentationFor(status,refresh);
      need(documentationEpoch===cancellationEpoch,'cancelled');
      contextEvidence(options,identity,operation);
      const current=boundStatus(runner.status(),identity);
      need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===status.packageDigest,'stale_documentation');
      if(documentation===null)
        return summary(operation,{...status,code:'documentation_sync_required'},'awaiting');
      const result=validateDocumentationResult(documentation,status,refresh,knowledgeCloseout);
      if(result==='blocked')return freeze({...summary(operation,{...status,code:'documentation_sync_blocked'},'blocked'),
        ...closeoutSummary(knowledgeCloseout,documentation)});
      return freeze({...summary(operation,{...status,code:'documentation_synced'},'verified'),
        contextDigest:refresh.contextDigest,...closeoutSummary(knowledgeCloseout,documentation)});
    }
    if(operation.operation==='run_finalize'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','run_not_ready');
      contextEvidence(options,identity,operation);
      need(applicableAgentFiles!==null,'context_invalid');
      const refresh=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,...(options.featureSelection===undefined?{}:{featureSelection:options.featureSelection}),
        feature:options.feature,applicableAgentFiles});
      need(refresh.state==='complete','run_not_ready');
      const projectQa=projectQaSummary(operation,status,options);if(projectQa)return projectQa;
      const documentationEpoch=cancellationEpoch;
      const documentation=await documentationFor(status,refresh);need(documentation!==null,'run_not_ready');
      need(documentationEpoch===cancellationEpoch,'cancelled');
      contextEvidence(options,identity,operation);
      const current=boundStatus(runner.status(),identity);
      need(!current.cancellationRequested&&!current.cancelAfterCommit,'cancelled');
      need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===status.packageDigest,'stale_documentation');
      const finalContext=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,...(options.featureSelection===undefined?{}:{featureSelection:options.featureSelection}),
        feature:options.feature,applicableAgentFiles});
      need(finalContext.state==='complete'&&finalContext.contextDigest===refresh.contextDigest,'stale_documentation');
      const documentationStatus=validateDocumentationResult(documentation,status,refresh,knowledgeCloseout);
      if(documentationStatus==='blocked')
        return freeze({...summary(operation,{...status,code:'documentation_sync_blocked'},'blocked'),
          ...closeoutSummary(knowledgeCloseout,documentation)});
      const finalQa=projectQaSummary(operation,status,options);if(finalQa)return finalQa;
      const input={specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,identity,
        packageDigest:operation.packageDigest,contextDigest:refresh.contextDigest,
        documentationSyncId:documentation.syncId};
      if(Object.hasOwn(options,'qaLogHome'))input.logHome=options.qaLogHome;
      const result=recordCmAiRunDone(input);
      return freeze({version:1,workflow:'cm-ai',operation:operation.operation,requestDigest:digest(operation),identity,
        outcome:'finalized',state:'run_done',code:result.degraded?'run_done_degraded':'run_done',
        packageDigest:operation.packageDigest,pendingAction:'none',contextDigest:refresh.contextDigest,
        deduplicated:result.deduplicated,degraded:result.degraded,
        ...closeoutSummary(knowledgeCloseout,documentation)});
    }
    need(['start','resume'].includes(operation.operation),'invalid_input');
    need(matchesCmAiTaskSelection(admission,options.feature,identity.taskId,options.parallelSelection??null),'task_mismatch');
    const status=boundStatus(runner.status(),identity);
    const developable=['ready','changes_requested'].includes(status.state)||retryDeveloper(status);
    const repeatable=operation.operation==='start'&&status.state==='awaiting_review';
    if(!developable&&!repeatable)
      return summary(operation,status,'reported');
    // Launch authority is checked before any develop intent or Learning work.
    // An unapproved next attempt is waiting, not a dispatched effect of unknown outcome.
    if(developable&&Object.hasOwn(options,'developmentAttempt')&&options.developmentAttempt!==identity.attempt)
      return summary(operation,{...status,code:'provider_development_authorization_required'},'awaiting');
    // Transient launch option: the caller has no revision answer yet. Stop after
    // the review that asked for it, before any develop intent, and say so.
    if(options.holdRevision===true&&status.state==='changes_requested')
      return summary(operation,{...status,code:'revision_answer_required'},'awaiting');
    // A re-check (check_answer_*) re-runs the checks of the delivery already made:
    // it binds that delivery's Learning input, never a freshly read one (its
    // writeback may already have changed AGENTS.md).
    const learningInput=runner.recheckLearningInput?.()??inspectCmAiTaskLearningInput({specsDir:options.specsDir,codeProject:options.codeProject,
      feature:options.feature,identity,applicableAgentFiles:applicableAgentFiles??[],
      ...(options.featureSelection===undefined?{}:{featureSelection:options.featureSelection})},
    {admission:runner.inspectBootstrapAdmission?.()??null,parallelSelection:options.parallelSelection??null});
    // Keep rejected effects immutable. A run-wide rejection count gives each
    // corrected result a new effect id without changing the provider attempt.
    const rejectedValues=status.calls.filter(call=>call.terminal==='failed'
      &&call.failureResult?.code==='invalid_result'&&call.failureResult.retryable===true).length;
    // Both kinds of local rejection need a fresh effect id: an invalid developer
    // result, and one the host gate blocked before the review package existed.
    const retries=rejectedValues+(runner.verificationBlocks?.()??0),resumed=runner.interruptions?.('develop')??0;
    const effectId=`develop-${identity.attempt}${retries?`-retry-${retries}`:''}${resumed?`-resume-${resumed}`:''}`;
    const result=await runner.executeEffect({version:1,id:effectId,identity,kind:'develop',learningInput});
    return effectSummary(operation,result,runner,identity);
  }
  const handle=async raw=>{
    let token=null,operation=null;const epoch=cancellationEpoch;
    try{
      operation=readOperation(raw);
      if(!['status','cancel','reconcile_review','abandon_review','abandon_effect','bootstrap_review_recover','develop_redo'].includes(operation.operation)){
        token=Symbol(operation.operation);inFlightHandles.add(token);
      }
      const routed=await route(operation);
      const guidance=operatorGuidance(routed,{executionActive:inFlightHandles.size>(token===null?0:1)});
      const result=guidance?freeze({...routed,guidance}):routed;
      if(!admissionReports.has(routed)&&(epoch===cancellationEpoch||operation.operation==='cancel'))projectHostResult({specsDir:options.specsDir,
        feature:options.feature,result,readCurrent:()=>runner.status()});
      return result;
    }catch(error){return freeze({...rejected(ownerIdentity,error),
      ...(['finish','run_finalize'].includes(operation?.operation)
        ?closeoutSummary(knowledgeCloseout,null,error.code??'inspection_failed'): {})});}
    finally{if(token!==null)inFlightHandles.delete(token);}
  };
  return Object.freeze({handle});
}
