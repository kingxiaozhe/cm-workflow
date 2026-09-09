// Fixed Codex-host entry for the existing cm-ai admission and V3 task runner.
import {inspectCmAiAdmission} from './cm-ai-admission.mjs';
import {inspectCmAiContextRefresh,inspectCmAiTaskLearningInput} from './cm-ai-context-refresh.mjs';
import {findCmAiQaDecision,inspectCmAiQaDecision,inspectCmAiQaResult,recordCmAiQaDecision,
  latestCmAiQaRun,recordCmAiQaRun} from './cm-ai-qa-log.mjs';
import {recordCmAiRunDone} from './cm-ai-run-finalizer.mjs';
import {readHostQaFixHandoff} from './host-qa-fix.mjs';
import {digest,freeze,hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';

const sameIdentity=(left,right)=>['repositoryId','runId','taskId','attempt'].every(key=>left[key]===right[key]);
const sameTask=(left,right)=>['repositoryId','runId','taskId'].every(key=>left[key]===right[key]);
const boundStatus=(status,identity)=>{validIdentity(status?.identity);
  need(sameIdentity(status.identity,identity),'identity_mismatch');return status;};
const pendingAction=status=>status.state==='awaiting_spec_approval'?'spec_approval':
  status.state==='changes_requested'?'resume':
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
  status.state==='fixture_completed'&&status.code==='qa_execution_unknown'?'reconcile':
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
  need(operation.version===1&&['advance','start','status','decision','complete','qa','qa_result','context_refresh','finish','run_finalize','cancel','resume']
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
  if(operation.operation==='decision'&&identity.attempt===1&&result?.state==='changes_requested'){
    const next={...identity,attempt:2};
    boundStatus(runner.status(),next);
    return summary(operation,boundStatus(result,next),'advanced');
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
  if(options&&Object.hasOwn(options,'hostDecisionProvider'))optionKeys.push('hostDecisionProvider');
  if(options&&Object.hasOwn(options,'developmentAttempt'))optionKeys.push('developmentAttempt');
  if(options&&Object.hasOwn(options,'qaDecision'))optionKeys.push('qaDecision');
  if(options&&Object.hasOwn(options,'qaDecisionProvider'))optionKeys.push('qaDecisionProvider');
  if(options&&Object.hasOwn(options,'qaExecutor'))optionKeys.push('qaExecutor');
  if(options&&Object.hasOwn(options,'qaLogHome'))optionKeys.push('qaLogHome');
  if(options&&Object.hasOwn(options,'applicableAgentFiles'))optionKeys.push('applicableAgentFiles');
  if(options&&Object.hasOwn(options,'documentationResult'))optionKeys.push('documentationResult');
  if(options&&Object.hasOwn(options,'documentationProvider'))optionKeys.push('documentationProvider');
  shape(options,optionKeys);
  if(Object.hasOwn(options,'developmentAttempt'))need([1,2].includes(options.developmentAttempt),'invalid_development_attempt');
  text(options.specsDir);text(options.codeProject);text(options.feature);
  const ownerIdentity=json(options.identity);validIdentity(ownerIdentity);
  const runner=options.runner;
  const runnerKeys=['executeEffect','status','cancel','run'];
  if(runner&&Object.hasOwn(runner,'attachLearningEvidence'))runnerKeys.push('attachLearningEvidence');
  if(runner&&Object.hasOwn(runner,'inspectFixAssociation'))runnerKeys.push('inspectFixAssociation');
  if(runner&&Object.hasOwn(runner,'acceptCompletedFix'))runnerKeys.push('acceptCompletedFix');
  if(runner&&Object.hasOwn(runner,'inspectBootstrapAdmission'))runnerKeys.push('inspectBootstrapAdmission');
  shape(runner,runnerKeys);
  for(const name of ['executeEffect','status','cancel','run'])need(typeof runner[name]==='function');
  if(Object.hasOwn(runner,'attachLearningEvidence'))need(typeof runner.attachLearningEvidence==='function');
  if(Object.hasOwn(runner,'inspectFixAssociation'))need(typeof runner.inspectFixAssociation==='function');
  if(Object.hasOwn(runner,'acceptCompletedFix'))need(typeof runner.acceptCompletedFix==='function');
  if(Object.hasOwn(runner,'inspectBootstrapAdmission'))need(typeof runner.inspectBootstrapAdmission==='function');

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
  if(Object.hasOwn(options,'qaExecutor')){
    shape(options.qaExecutor,['mode','caseCount','timeoutMs','run',
      ...(Object.hasOwn(options.qaExecutor,'configuration')?['configuration']:[])]);
    const {run,...config}=options.qaExecutor;
    need(typeof run==='function');qaExecutor={...json(config),run};
    need(['commands','browser','all'].includes(config.mode)&&Number.isSafeInteger(config.caseCount)&&config.caseCount>0);
    need(Number.isInteger(config.timeoutMs)&&config.timeoutMs>=1&&config.timeoutMs<=3600000);
  }
  const applicableAgentFiles=Object.hasOwn(options,'applicableAgentFiles')?json(options.applicableAgentFiles):null;
  const documentationResult=Object.hasOwn(options,'documentationResult')?json(options.documentationResult):null;
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
      identity:status.identity,packageDigest:status.packageDigest,contextDigest:refresh.contextDigest});
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
      const reread=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,
        feature:options.feature,applicableAgentFiles});
      need(reread.state==='complete'&&reread.contextDigest===refresh.contextDigest,'stale_documentation');
      validateDocumentationResult(result,current,reread);
      if(result.status==='completed')inspectedDocumentation=result;
      return result;
    }finally{clearTimeout(timer);pendingDocumentation=null;}
  }

  async function route(raw) {
    const operation=readOperation(raw);
    need(sameTask(operation.identity,ownerIdentity),'identity_mismatch');
    need(operation.identity.attempt>=ownerIdentity.attempt,'identity_mismatch');
    const admission=['start','resume'].includes(operation.operation)
      ?runner.inspectBootstrapAdmission?.()??inspectCmAiAdmission({specsDir:options.specsDir,codeProject:options.codeProject}):null;
    if(admission&&admission.state!=='ready'){
      // Original callers still stop before reading runner state. A caller using
      // a newer attempt must bind it to the runner before we report its block.
      const blockedIdentity=sameIdentity(operation.identity,ownerIdentity)?ownerIdentity:
        boundStatus(runner.status(),operation.identity).identity;
      return summary(operation,{state:admission.state,code:admission.reason,
        identity:blockedIdentity,packageDigest:null},'awaiting');
    }
    const initialStatus=runner.status();
    const identity=json(initialStatus.identity);validIdentity(identity);
    need(sameTask(identity,ownerIdentity)&&identity.attempt>=ownerIdentity.attempt,'identity_mismatch');
    // Stable run-definition identity can query/control or resume the current
    // attempt. Package-bound mutations must name the current attempt exactly.
    const stableControl=['status','cancel','advance','resume'].includes(operation.operation)
      &&sameIdentity(operation.identity,ownerIdentity);
    need(sameIdentity(operation.identity,identity)||stableControl,'identity_mismatch');
    if(operation.operation==='advance'){
      const startedEpoch=cancellationEpoch;
      const notCancelled=()=>{const current=runner.status();
        need(startedEpoch===cancellationEpoch&&!current.cancellationRequested&&!current.cancelAfterCommit,'cancelled');};
      // Reuse the runner's two-attempt lifecycle, including its fresh review
      // identity and review_limit. Never retry unknown/provider failures.
      const call=(name,packageDigest,extra={})=>route({version:1,operation:name,
        requestId:operation.requestId,identity:runner.status().identity,...(packageDigest===undefined?{}:{packageDigest}),...extra});
      let result=await call('status');
      for(let round=identity.attempt;round<=2;round++){
        if(result.code===null&&['ready','changes_requested'].includes(result.state))result=await call('start');
        if(['reported','advanced'].includes(result.outcome)&&result.code===null&&result.state==='awaiting_review')
          result=await call('decision',result.packageDigest);
        if(result.outcome==='advanced'&&result.code===null&&result.state==='changes_requested'
          &&result.identity.attempt===round+1)continue;
        if(['reported','advanced'].includes(result.outcome)&&result.code===null&&result.state==='approved')
          result=await call('complete',result.packageDigest);
        break;
      }
      if(['reported','advanced'].includes(result.outcome)&&result.code===null&&result.state==='fixture_completed'){
        let qaTestRunId=null;
        notCancelled();
        result=await call('qa',result.packageDigest);
        if(result.outcome==='recorded'&&result.code==='qa_triggered'&&qaExecutor!==null){
          notCancelled();
          need(pendingExecution===null,'qa_execution_pending');
          const binding={specsDir:options.specsDir,feature:options.feature,identity:result.identity,packageDigest:result.packageDigest};
          let previous;
          try{previous=latestCmAiQaRun(binding);}
          catch(error){
            if(error.code==='qa_result_incomplete')return summary(operation,{...runner.status(),code:'qa_execution_unknown'},'blocked');
            throw error;
          }
          let testRunId=previous?.testRunId;
          const accepted=runner.status().acceptedQaFix;
          const repaired=previous?.status==='failed'&&accepted?.testRunId===previous.testRunId;
          if(previous===null||repaired){
            // Later rounds require an original completed child accepted by the
            // parent journal. Unknown executions and unrepaired failures stop.
            const qaRound=repaired?accepted.qaRound+1:1;
            need(qaRound>=1&&qaRound<=3,'qa_round_invalid');
            testRunId=`qa-${digest(repaired?{...binding,qaRound,repair:accepted.evidenceDigest}:binding).slice(0,48)}`;
            const invocation={...binding,codeProject:options.codeProject,testRunId,mode:qaExecutor.mode,caseCount:qaExecutor.caseCount,
              ...(repaired?{qaRound}: {})};
            const logInput={...invocation,...(Object.hasOwn(options,'qaLogHome')?{logHome:options.qaLogHome}:{})};
            notCancelled();
            recordCmAiQaRun({...logInput,phase:'start'});
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
              const current=boundStatus(runner.status(),result.identity);
              need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===result.packageDigest,'stale_qa');
              recordCmAiQaRun({...logInput,phase:'complete',result:executed});
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
      return freeze({...result,operation:'advance',requestDigest:digest(operation)});
    }
    if(operation.operation==='status'){
      const status=boundStatus(initialStatus,identity);
      return summary(operation,status,'reported');
    }
    if(operation.operation==='cancel'){
      cancellationEpoch++;
      pendingReviewDecision?.abort();
      pendingQa?.abort();
      pendingExecution?.abort();
      pendingDocumentation?.abort();
      const status=boundStatus(runner.cancel(),identity);
      return summary(operation,status,'cancelled');
    }
    if(operation.operation==='decision'){
      const status=boundStatus(runner.status(),identity);
      need(status.packageDigest===operation.packageDigest,'stale_decision');
      let decision=hostDecision;
      if(hostDecisionProvider!==null){
        // A historical terminal or outstanding invocation is owned by the runner;
        // never ask for fresh authorization to replay or reopen it.
        if(status.state!=='awaiting_review'||status.code!==null)return summary(operation,status,'reported');
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
      let decision=qaDecision;
      if(qaProvider!==null){
        need(pendingQa===null,'qa_decision_pending');
        const binding={specsDir:options.specsDir,feature:options.feature,identity,packageDigest:operation.packageDigest};
        decision=findCmAiQaDecision(binding);
        // A bound historical decision is evidence, not a fresh proposal. Keep
        // the existing downstream compatibility path; do not rewrite its log.
        if(decision!==null)return summary(operation,{...status,code:`qa_${decision.status}`},'recorded');
        if(decision===null){
          const controller=new AbortController();pendingQa=controller;
          let timer,timedOut=false;
          try{
            const interrupted=new Promise((_,reject)=>{
              controller.signal.addEventListener('abort',()=>reject(Object.assign(new Error('QA decision interrupted'),
                {code:timedOut?'qa_decision_timeout':'cancelled'})),{once:true});
              timer=setTimeout(()=>{timedOut=true;controller.abort();},qaTimeout);
            });
            decision=json(await Promise.race([
              Promise.resolve().then(()=>{need(!controller.signal.aborted,'cancelled');
                return decideQa(freeze({...binding,codeProject:options.codeProject}),controller.signal);}),interrupted]));
            need(!controller.signal.aborted,'cancelled');
            const current=boundStatus(runner.status(),identity);
            need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===operation.packageDigest,'stale_qa');
          }finally{clearTimeout(timer);pendingQa=null;}
        }
      }
      if(decision===null)return summary(operation,{...status,code:'qa_decision_required'},'awaiting');
      if(decision.status==='skipped'){
        const admission=inspectCmAiAdmission({specsDir:options.specsDir,codeProject:options.codeProject});
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
      const documentationEpoch=cancellationEpoch;
      const documentation=await documentationFor(status,refresh);
      need(documentationEpoch===cancellationEpoch,'cancelled');
      contextEvidence(options,identity,operation);
      const current=boundStatus(runner.status(),identity);
      need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===status.packageDigest,'stale_documentation');
      if(documentation===null)
        return summary(operation,{...status,code:'documentation_sync_required'},'awaiting');
      const result=validateDocumentationResult(documentation,status,refresh);
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
      need(refresh.state==='complete','run_not_ready');
      const documentationEpoch=cancellationEpoch;
      const documentation=await documentationFor(status,refresh);need(documentation!==null,'run_not_ready');
      need(documentationEpoch===cancellationEpoch,'cancelled');
      contextEvidence(options,identity,operation);
      const current=boundStatus(runner.status(),identity);
      need(!current.cancellationRequested&&!current.cancelAfterCommit,'cancelled');
      need(current.state==='fixture_completed'&&current.code==null&&current.packageDigest===status.packageDigest,'stale_documentation');
      const finalContext=inspectCmAiContextRefresh({specsDir:options.specsDir,codeProject:options.codeProject,
        feature:options.feature,applicableAgentFiles});
      need(finalContext.state==='complete'&&finalContext.contextDigest===refresh.contextDigest,'stale_documentation');
      const documentationStatus=validateDocumentationResult(documentation,status,refresh);
      if(documentationStatus==='blocked')
        return summary(operation,{...status,code:'documentation_sync_blocked'},'blocked');
      const input={specsDir:options.specsDir,codeProject:options.codeProject,feature:options.feature,identity,
        packageDigest:operation.packageDigest,contextDigest:refresh.contextDigest,
        documentationSyncId:documentation.syncId};
      if(Object.hasOwn(options,'qaLogHome'))input.logHome=options.qaLogHome;
      const result=recordCmAiRunDone(input);
      return freeze({version:1,workflow:'cm-ai',operation:operation.operation,requestDigest:digest(operation),identity,
        outcome:'finalized',state:'run_done',code:result.degraded?'run_done_degraded':'run_done',
        packageDigest:operation.packageDigest,pendingAction:'none',contextDigest:refresh.contextDigest,
        deduplicated:result.deduplicated,degraded:result.degraded});
    }
    need(['start','resume'].includes(operation.operation),'invalid_input');
    need(admission.state==='ready'&&admission.nextTask?.feature===options.feature
      &&admission.nextTask.id===identity.taskId,'task_mismatch');
    const status=boundStatus(runner.status(),identity);
    const developable=['ready','changes_requested'].includes(status.state);
    const repeatable=operation.operation==='start'&&status.state==='awaiting_review';
    if(!developable&&!repeatable)
      return summary(operation,status,'reported');
    // Launch authority is checked before any develop intent or Learning work.
    // An unapproved next attempt is waiting, not a dispatched effect of unknown outcome.
    if(developable&&Object.hasOwn(options,'developmentAttempt')&&options.developmentAttempt!==identity.attempt)
      return summary(operation,{...status,code:'provider_development_authorization_required'},'awaiting');
    const learningInput=inspectCmAiTaskLearningInput({specsDir:options.specsDir,codeProject:options.codeProject,
      feature:options.feature,identity,applicableAgentFiles:applicableAgentFiles??[]},
    {admission:runner.inspectBootstrapAdmission?.()??null});
    const result=await runner.executeEffect({version:1,id:`develop-${identity.attempt}`,identity,kind:'develop',learningInput});
    return effectSummary(operation,result,runner,identity);
  }
  const handle=async raw=>{try{return await route(raw);}catch(error){return rejected(ownerIdentity,error);}};
  return Object.freeze({handle});
}
