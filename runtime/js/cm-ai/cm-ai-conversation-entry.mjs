// Fixed Codex-host entry for the existing cm-ai admission and V3 task runner.
import {inspectCmAiAdmission} from './cm-ai-admission.mjs';
import {inspectCmAiContextRefresh,inspectCmAiTaskLearningInput} from './cm-ai-context-refresh.mjs';
import {inspectCmAiQaDecision,inspectCmAiQaResult,recordCmAiQaDecision} from './cm-ai-qa-log.mjs';
import {recordCmAiRunDone} from './cm-ai-run-finalizer.mjs';
import {digest,freeze,hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';

const sameIdentity=(left,right)=>['repositoryId','runId','taskId','attempt'].every(key=>left[key]===right[key]);
const boundStatus=(status,identity)=>{validIdentity(status?.identity);
  need(sameIdentity(status.identity,identity),'identity_mismatch');return status;};
const pendingAction=status=>status.state==='awaiting_spec_approval'?'spec_approval':
  status.state==='awaiting_review'?'decision':status.state==='unknown'?'reconcile':
  status.state==='pending_review'&&status.code==='provider_review_observed'?'review_evidence':
  status.state==='pending_review'?'decision':status.state==='approved'?'complete':
  status.state==='fixture_completed'&&status.code==='qa_triggered'?'qa_execution':
  status.state==='fixture_completed'&&status.code==='qa_skipped'?'context_refresh':
  status.state==='fixture_completed'&&status.code==='qa_passed'?'context_refresh':
  status.state==='fixture_completed'&&status.code==='correction_review_required'?'none':
  status.state==='fixture_completed'&&status.code==='documentation_sync_required'?'documentation_sync':
  status.state==='fixture_completed'&&status.code==='documentation_synced'?'run_finalize':
  status.state==='fixture_completed'&&status.code==='documentation_sync_blocked'?'none':
  status.state==='fixture_completed'&&status.code==='qa_blocked'?'none':
  status.state==='fixture_completed'&&['qa_failed','qa_result_blocked'].includes(status.code)?'none':
  status.state==='fixture_completed'?'qa':'none';
const summary=(operation,status,outcome)=>freeze({version:1,workflow:'cm-ai',operation:operation.operation,
  requestDigest:digest(operation),identity:status.identity,outcome,state:status.state,code:status.code??null,
  packageDigest:status.packageDigest??null,pendingAction:pendingAction(status)});
const correctionSummary=(operation,status)=>status.code==='correction_review_required'
  ?summary(operation,status,'blocked'):null;

function readOperation(raw) {
  const operation=json(raw),keys=['version','operation','requestId','identity'];
  if(['decision','complete','qa','qa_result','context_refresh','finish','run_finalize'].includes(operation?.operation))keys.push('packageDigest');
  if(['qa_result','context_refresh','finish','run_finalize'].includes(operation?.operation))keys.push('testRunId');
  shape(operation,keys);
  need(operation.version===1&&['start','status','decision','complete','qa','qa_result','context_refresh','finish','run_finalize','cancel','resume']
    .includes(operation.operation));
  id(operation.requestId);validIdentity(operation.identity);
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
    const rejection=json(result);shape(rejection,['outcome','code']);id(rejection.code);
    const current=boundStatus(runner.status(),identity);
    return summary(operation,{...current,code:rejection.code},'rejected');
  }
  return summary(operation,boundStatus(result,identity),'advanced');
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

function validateDocumentationResult(result,status,refresh) {
  shape(result,['syncId','identity','packageDigest','contextDigest','status','reason','at']);
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
  if(options&&Object.hasOwn(options,'qaDecision'))optionKeys.push('qaDecision');
  if(options&&Object.hasOwn(options,'qaLogHome'))optionKeys.push('qaLogHome');
  if(options&&Object.hasOwn(options,'applicableAgentFiles'))optionKeys.push('applicableAgentFiles');
  if(options&&Object.hasOwn(options,'documentationResult'))optionKeys.push('documentationResult');
  shape(options,optionKeys);
  text(options.specsDir);text(options.codeProject);text(options.feature);
  const identity=json(options.identity);validIdentity(identity);
  const runner=options.runner;
  const runnerKeys=['executeEffect','status','cancel','run'];
  if(runner&&Object.hasOwn(runner,'attachLearningEvidence'))runnerKeys.push('attachLearningEvidence');
  shape(runner,runnerKeys);
  for(const name of ['executeEffect','status','cancel','run'])need(typeof runner[name]==='function');
  if(Object.hasOwn(runner,'attachLearningEvidence'))need(typeof runner.attachLearningEvidence==='function');

  const hostDecision=Object.hasOwn(options,'hostDecision')?json(options.hostDecision):null;
  const qaDecision=Object.hasOwn(options,'qaDecision')?json(options.qaDecision):null;
  const applicableAgentFiles=Object.hasOwn(options,'applicableAgentFiles')?json(options.applicableAgentFiles):null;
  const documentationResult=Object.hasOwn(options,'documentationResult')?json(options.documentationResult):null;
  if(Object.hasOwn(options,'qaLogHome'))text(options.qaLogHome);

  async function route(raw) {
    const operation=readOperation(raw);need(sameIdentity(operation.identity,identity),'identity_mismatch');
    if(operation.operation==='status'){
      const status=boundStatus(runner.status(),identity);
      return summary(operation,status,'reported');
    }
    if(operation.operation==='cancel'){
      const status=boundStatus(runner.cancel(),identity);
      return summary(operation,status,'cancelled');
    }
    if(operation.operation==='decision'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_decision');
      if(hostDecision===null)return summary(operation,{...status,code:'decision_required'},'awaiting');
      if(validateHostDecision(hostDecision,status)==='denied')
        return summary(operation,{...status,code:'permission_denied'},'denied');
      const result=await runner.executeEffect({version:1,id:`review-${identity.attempt}`,identity,kind:'review'});
      return effectSummary(operation,result,runner,identity);
    }
    if(operation.operation==='complete'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_completion');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(['approved','fixture_completed'].includes(status.state),'completion_not_ready');
      const result=await runner.executeEffect({version:1,id:`complete-${identity.attempt}`,identity,kind:'complete'});
      return effectSummary(operation,result,runner,identity);
    }
    if(operation.operation==='qa'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','qa_not_ready');
      if(qaDecision===null)return summary(operation,{...status,code:'qa_decision_required'},'awaiting');
      const input={specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,identity,
        packageDigest:operation.packageDigest,decision:qaDecision};
      if(Object.hasOwn(options,'qaLogHome'))input.logHome=options.qaLogHome;
      recordCmAiQaDecision(input);
      return summary(operation,{...status,code:`qa_${qaDecision.status}`},'recorded');
    }
    if(operation.operation==='qa_result'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','qa_not_ready');
      const result=inspectCmAiQaResult({specsDir:options.specsDir,feature:options.feature,identity,
        packageDigest:operation.packageDigest,testRunId:operation.testRunId});
      const code=result.status==='blocked'?'qa_result_blocked':`qa_${result.status}`;
      return summary(operation,{...status,code},'verified');
    }
    if(operation.operation==='context_refresh'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','context_not_ready');
      contextEvidence(options,identity,operation);
      need(applicableAgentFiles!==null,'context_invalid');
      const refresh=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,
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
      const refresh=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,
        feature:options.feature,applicableAgentFiles});
      need(refresh.state==='complete','run_not_ready');
      if(documentationResult===null)
        return summary(operation,{...status,code:'documentation_sync_required'},'awaiting');
      const result=validateDocumentationResult(documentationResult,status,refresh);
      if(result==='blocked')return summary(operation,{...status,code:'documentation_sync_blocked'},'blocked');
      return freeze({...summary(operation,{...status,code:'documentation_synced'},'verified'),
        contextDigest:refresh.contextDigest});
    }
    if(operation.operation==='run_finalize'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_qa');
      const correction=correctionSummary(operation,status);if(correction)return correction;
      need(status.state==='fixture_completed','run_not_ready');
      contextEvidence(options,identity,operation);
      need(applicableAgentFiles!==null,'context_invalid');
      const refresh=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,
        feature:options.feature,applicableAgentFiles});
      need(refresh.state==='complete'&&documentationResult!==null,'run_not_ready');
      const documentationStatus=validateDocumentationResult(documentationResult,status,refresh);
      if(documentationStatus==='blocked')
        return summary(operation,{...status,code:'documentation_sync_blocked'},'blocked');
      const input={specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,identity,
        packageDigest:operation.packageDigest,contextDigest:refresh.contextDigest,
        documentationSyncId:documentationResult.syncId};
      if(Object.hasOwn(options,'qaLogHome'))input.logHome=options.qaLogHome;
      const result=recordCmAiRunDone(input);
      return freeze({version:1,workflow:'cm-ai',operation:operation.operation,requestDigest:digest(operation),identity,
        outcome:'finalized',state:'run_done',code:result.degraded?'run_done_degraded':'run_done',
        packageDigest:operation.packageDigest,pendingAction:'none',contextDigest:refresh.contextDigest,
        deduplicated:result.deduplicated,degraded:result.degraded});
    }
    need(['start','resume'].includes(operation.operation),'invalid_input');
    const admission=inspectCmAiAdmission({specsDir:options.specsDir,codeProject:options.codeProject});
    if(admission.state!=='ready')return summary(operation,{state:admission.state,code:admission.reason,
      identity,packageDigest:null},'awaiting');
    need(admission.state==='ready'&&admission.nextTask?.feature===options.feature
      &&admission.nextTask.id===identity.taskId,'task_mismatch');
    const status=boundStatus(runner.status(),identity);
    const developable=['ready','changes_requested'].includes(status.state);
    const repeatable=operation.operation==='start'&&status.state==='awaiting_review';
    if(!developable&&!repeatable)
      return summary(operation,status,'reported');
    const learningInput=inspectCmAiTaskLearningInput({specsDir:options.specsDir,codeProject:options.codeProject,
      feature:options.feature,identity,applicableAgentFiles:applicableAgentFiles??[]});
    const result=await runner.executeEffect({version:1,id:`develop-${identity.attempt}`,identity,kind:'develop',learningInput});
    return effectSummary(operation,result,runner,identity);
  }
  const handle=async raw=>{try{return await route(raw);}catch(error){return rejected(identity,error);}};
  return Object.freeze({handle});
}
