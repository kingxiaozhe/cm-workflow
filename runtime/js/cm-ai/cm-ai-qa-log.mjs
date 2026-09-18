// Fixed N6 decision adapter for the JS CM log authority through its platform lock adapter.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';
import {readQaAttachment} from './qa-attachment.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const MiB=1024*1024;

const sameIdentity=(left,right)=>['repositoryId','runId','taskId','attempt'].every(key=>left[key]===right[key]);

export function recordCmAiQaAttachment({specsDir,codeProject,feature,identity,record,logHome}){
  record=readQaAttachment(record);validIdentity(identity);text(feature);
  const args=[writer,'--workflow','cm-ai','--event','decision','--phase','qa_attach','--runtime','codex',
    '--project-root',codeProject,'--specs-dir',specsDir,'--run-id',identity.runId,'--at',record.attachedAt,
    '--detail','附加 N6 QA','--data-json',JSON.stringify({feature,task:identity.taskId,qaFingerprint:record.qaFingerprint})];
  let result;
  try{result=childProcess.spawnSync('python3',args,{timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL',
    ...(logHome?{env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}}:{})});}
  catch{need(false,'qa_log_failed');}
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout),'qa_log_failed');
  return readResult(result.stdout,identity,specsDir);
}

export function readDecision(raw,identity,packageDigest) {
  const decision=json(raw);shape(decision,['decisionId','identity','packageDigest','status','reason','score','at']);
  id(decision.decisionId);validIdentity(decision.identity);hex(decision.packageDigest);
  need(sameIdentity(decision.identity,identity)&&decision.packageDigest===packageDigest,'qa_decision_mismatch');
  need(['triggered','skipped','blocked'].includes(decision.status));
  text(decision.reason);need(decision.reason.length<=200&&!/[\n\r\0]/.test(decision.reason));
  need(typeof decision.at==='string'
    &&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/.test(decision.at)
    &&Number.isFinite(Date.parse(decision.at)));
  if(decision.score!==null)need(Number.isInteger(decision.score)&&decision.score>=4&&decision.score<=20);
  if(decision.status==='skipped')need(Number.isInteger(decision.score)&&decision.score<=7);
  if(decision.status==='triggered'&&decision.score!==null)need(decision.score>=8);
  return json({...decision,at:decision.at.endsWith('Z')?`${decision.at.slice(0,-1)}+00:00`:decision.at});
}

export function scanRows(log,visit) {
  let descriptor;
  try {
    const stat=fs.lstatSync(log);need(stat.isFile()&&!stat.isSymbolicLink(),'qa_log_failed');
    descriptor=fs.openSync(log,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const chunk=Buffer.alloc(64*1024);let pending=Buffer.alloc(0);
    const consume=line=>{if(line.length){need(line.length<=MiB,'qa_log_failed');
      visit(json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(line)),MiB));}};
    while(true){const size=fs.readSync(descriptor,chunk,0,chunk.length,null);if(size===0)break;
      pending=Buffer.concat([pending,chunk.subarray(0,size)]);let newline;
      while((newline=pending.indexOf(10))!==-1){consume(pending.subarray(0,newline));pending=pending.subarray(newline+1);}
      need(pending.length<=MiB,'qa_log_failed');}
    consume(pending);
  } finally {if(descriptor!==undefined)fs.closeSync(descriptor);}
}

function existingDecision(specsDir,feature,identity,packageDigest,decision) {
  const log=path.join(path.resolve(specsDir),'运行日志.jsonl');
  if(!fs.existsSync(log))return false;
  try {
    const matches=[];scanRows(log,row=>{if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
      &&row.repository_id===identity.repositoryId&&row.run_id===identity.runId&&row.feature===feature
      &&row.task===identity.taskId&&row.attempt===identity.attempt&&row.package_digest===packageDigest)matches.push(row);});
    if(matches.length===0)return false;
    need(matches.length===1,'qa_decision_conflict');
    const row=matches[0];
    need(row.decision_id===decision.decisionId&&row.status===decision.status&&row.reason===decision.reason
      &&row.score===decision.score&&row.at===decision.at,'qa_decision_conflict');
    return true;
  } catch(error) {
    if(error?.code==='qa_decision_conflict')throw error;
    need(false,'qa_log_failed');
  }
}

function readResult(stdout,identity,specsDir) {
  try {
    const result=json(JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(stdout)),MiB);
    shape(result,['event_id','run_id','project_log','global_log','global_written','pointer_written','deduplicated','degraded']);
    id(result.event_id);need(result.run_id===identity.runId);text(result.project_log);text(result.global_log);
    need(path.resolve(result.project_log)===path.join(path.resolve(specsDir),'运行日志.jsonl'));
    need(typeof result.global_written==='boolean'&&(typeof result.pointer_written==='boolean'||result.pointer_written===null)
      &&typeof result.deduplicated==='boolean'&&typeof result.degraded==='boolean');
    return result;
  } catch {need(false,'qa_log_failed');}
}

export function recordCmAiQaDecision(input) {
  const keys=['specsDir','codeProject','feature','identity','packageDigest','decision'];
  if(input&&Object.hasOwn(input,'logHome'))keys.push('logHome');
  shape(input,keys);text(input.specsDir);text(input.codeProject);text(input.feature);validIdentity(input.identity);
  hex(input.packageDigest);
  const decision=readDecision(input.decision,input.identity,input.packageDigest);
  if(existingDecision(input.specsDir,input.feature,input.identity,input.packageDigest,decision))return;
  const detail=decision.status==='triggered'?`触发:${decision.reason}`:
    decision.status==='skipped'?`跳过:评分${decision.score}`:`阻塞:${decision.reason}`;
  const data={node:'N6',feature:input.feature,task:input.identity.taskId,attempt:input.identity.attempt,
    repository_id:input.identity.repositoryId,package_digest:input.packageDigest,decision_id:decision.decisionId,
    status:decision.status,reason:decision.reason,score:decision.score};
  const args=[writer,'--workflow','cm-ai','--event','qa','--runtime','codex','--project-root',input.codeProject,
    '--specs-dir',input.specsDir,'--run-id',input.identity.runId,'--at',decision.at,'--detail',detail,
    '--data-json',JSON.stringify(data)];
  const options={timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL'};
  if(Object.hasOwn(input,'logHome')){text(input.logHome);options.env={...process.env,CM_WORKFLOW_LOG_HOME:input.logHome};}
  if(decision.status==='skipped'&&decision.reason==='merged_to_feature_qa'){
    // N6 requires an explicit merge decision as well as the per-task QA row.
    // Write first: a crash may repeat this same idempotent log operation, never QA.
    const mergeArgs=[...args];mergeArgs[mergeArgs.indexOf('--event')+1]='decision';
    mergeArgs[mergeArgs.indexOf('--detail')+1]='合并至feature级QA';
    mergeArgs.push('--phase','qa_merge');
    let merged;
    try{merged=childProcess.spawnSync('python3',mergeArgs,options);}catch{need(false,'qa_log_failed');}
    need(!merged.error&&merged.status===0&&merged.signal===null&&Buffer.isBuffer(merged.stdout),'qa_log_failed');
    readResult(merged.stdout,input.identity,input.specsDir);
  }
  let result;
  try{result=childProcess.spawnSync('python3',args,options);}
  catch{need(false,'qa_log_failed');}
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout)
    &&result.stdout.length<=MiB,'qa_log_failed');
  return readResult(result.stdout,input.identity,input.specsDir);
}

function findDecisionRow(input) {
  shape(input,['specsDir','feature','identity','packageDigest']);
  text(input.specsDir);text(input.feature);validIdentity(input.identity);hex(input.packageDigest);
  const log=path.join(path.resolve(input.specsDir),'运行日志.jsonl');
  if(!fs.existsSync(log))return null;
  const matches=[];
  try {scanRows(log,row=>{if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
    &&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
    &&row.feature===input.feature&&row.task===input.identity.taskId&&row.attempt===input.identity.attempt
    &&row.package_digest===input.packageDigest)matches.push(row);});}
  catch{need(false,'context_not_ready');}
  if(matches.length===0)return null;
  need(matches.length===1,'context_not_ready');
  const row=matches[0];id(row.decision_id);
  need(['triggered','skipped','blocked'].includes(row.status),'context_not_ready');
  return row;
}

export function findCmAiQaDecision(input) {
  const row=findDecisionRow(input);if(row===null)return null;
  return readDecision({status:row.status,decisionId:row.decision_id,identity:input.identity,
    packageDigest:input.packageDigest,reason:row.reason,score:row.score,at:row.at},input.identity,input.packageDigest);
}

export function inspectCmAiQaDecision(input) {
  const row=findDecisionRow(input);need(row,'context_not_ready');
  return Object.freeze({status:row.status,decisionId:row.decision_id});
}

export function reportFile(specsDir,raw) {
  text(raw);need(!raw.includes('\0'),'qa_report_invalid');
  try {
    const specs=fs.realpathSync(specsDir),reviews=path.join(specs,'.reviews'),reviewsStat=fs.lstatSync(reviews);
    need(reviewsStat.isDirectory()&&!reviewsStat.isSymbolicLink(),'qa_report_invalid');
    const candidate=path.isAbsolute(raw)?path.resolve(raw):path.resolve(specs,raw);
    const lexical=path.relative(reviews,candidate);
    need(lexical.length>0&&!lexical.startsWith(`..${path.sep}`)&&!path.isAbsolute(lexical),'qa_report_invalid');
    const resolved=fs.realpathSync(candidate),relative=path.relative(fs.realpathSync(reviews),resolved),stat=fs.lstatSync(candidate);
    need(relative.length>0&&!relative.startsWith(`..${path.sep}`)&&!path.isAbsolute(relative)
      &&stat.isFile()&&!stat.isSymbolicLink(),'qa_report_invalid');
    return resolved;
  } catch(error) {
    if(error?.code==='qa_report_invalid')throw error;
    need(false,'qa_report_invalid');
  }
}

function partialPassCases(items,code){
  need(!items.some(({row})=>row.phase==='complete'||row.phase==='case_blocked'
    ||(row.phase==='case_complete'&&row.result!=='PASS')),code);
  const cases=items.filter(({row})=>row.phase==='case_complete').map(({row})=>row.case_id);
  for(const caseId of cases)id(caseId);
  return [...new Set(cases)].sort();
}

// An abandoned invocation is history, never a result. Only its explicit
// successor may reuse a round; completed FAIL retries still advance 1..3.
function validateRunSequence(items,code='qa_round_invalid'){
  const starts=[],ids=new Set();let current=null,abandoned=false;
  for(const item of items){
    const row=item.row;
    if(row.phase==='start'){
      id(row.operation_id);need(!ids.has(row.operation_id),code);ids.add(row.operation_id);
      need(row.attempt===(current?current.attempt+(abandoned?0:1):1)&&row.attempt<=3,code);
      if(abandoned){
        // Legacy successors retain their plan; explicit links may bind a fresh plan.
        if(row.previous_test_run_id===undefined)need(row.mode===current.mode&&row.case_count===current.case_count,code);
        else need(row.previous_test_run_id===current.operation_id,code);
      }else need(row.previous_test_run_id===undefined,code);
      current=row;abandoned=false;starts.push(item);
    }else{
      need(current&&row.operation_id===current.operation_id&&row.attempt===current.attempt&&!abandoned,code);
      if(row.phase==='abandoned'){
        need(row.previous_test_run_id===current.operation_id&&row.reason==='host_terminated'
          &&row.mode===current.mode&&row.case_count===current.case_count,code);
        const prior=items.filter(entry=>entry.position<item.position&&entry.row.operation_id===row.operation_id);
        const passed=partialPassCases(prior,code);
        // Step 26 records omitted this field and could only abandon empty runs.
        need(JSON.stringify(row.partial_pass_cases===undefined?[]:row.partial_pass_cases)===JSON.stringify(passed)
          &&(row.partial_pass_cases!==undefined||passed.length===0),code);
        abandoned=true;
      }
    }
  }
  need(starts.length>0,code);return starts;
}

function qaRunRows(input){
  const decision=findCmAiQaDecision(input);need(decision?.status==='triggered','qa_not_triggered');
  const rows=[];let position=0;
  scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    const index=position++;
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='test_run'
      &&row.node==='N6'&&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
      &&row.feature===input.feature&&row.task===input.identity.taskId&&row.package_digest===input.packageDigest
      &&row.qa_decision_id===decision.decisionId)rows.push({row,position:index});
  });
  return rows;
}

// Only a trusted resumed owner calls this after fresh explicit authorization.
// Retain unknown for non-PASS results, even if their evidence files vanished.
export function inspectCmAiQaRecovery(input){
  const rows=qaRunRows(input),starts=validateRunSequence(rows),start=starts.at(-1).row;
  const runs=rows.filter(item=>item.row.operation_id===start.operation_id);
  const passed=partialPassCases(runs,'qa_execution_unknown');
  const report=path.join(input.specsDir,'.reviews',`${start.operation_id}-execution.md`);
  let exists=false;try{fs.lstatSync(report);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  need(!exists,'qa_execution_unknown');
  // Reject an operation ID reused under another decision, identity or package.
  scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    if(row.event==='test_run'&&row.operation_id===start.operation_id)
      need(rows.some(item=>JSON.stringify(item.row)===JSON.stringify(row)),'qa_result_mismatch');
  });
  return {testRunId:start.operation_id,qaRound:start.attempt,mode:start.mode,caseCount:start.case_count,
    partialPassCases:passed,abandoned:runs.some(({row})=>row.phase==='abandoned')};
}

// Discover the latest invocation from the authoritative log, never a second checkpoint.
export function latestCmAiQaRun(input) {
  const decision=findCmAiQaDecision(input);need(decision?.status==='triggered','qa_not_triggered');
  const rows=[];
  try{scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='test_run'
      &&row.node==='N6'&&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
      &&row.feature===input.feature&&row.task===input.identity.taskId&&row.package_digest===input.packageDigest
      &&row.qa_decision_id===decision.decisionId)rows.push(row);
  });}catch{need(false,'qa_result_invalid');}
  if(rows.length===0)return null;
  const starts=rows.filter(row=>row.phase==='start');need(starts.length>0,'qa_result_invalid');
  const testRunId=starts.at(-1).operation_id;id(testRunId);
  return {testRunId,...inspectCmAiQaResult({...input,testRunId})};
}

export function recordCmAiQaRun(input) {
  const keys=['specsDir','codeProject','feature','identity','packageDigest','testRunId','mode','caseCount','phase'];
  if(Object.hasOwn(input,'result'))keys.push('result');
  if(Object.hasOwn(input,'logHome'))keys.push('logHome');
  if(Object.hasOwn(input,'qaRound'))keys.push('qaRound');
  if(Object.hasOwn(input,'previousTestRunId'))keys.push('previousTestRunId');
  if(Object.hasOwn(input,'deferredCases'))keys.push('deferredCases');
  shape(input,keys);validIdentity(input.identity);id(input.testRunId);hex(input.packageDigest);
  text(input.specsDir);text(input.codeProject);text(input.feature);
  need(['commands','browser','all'].includes(input.mode));
  need(Number.isSafeInteger(input.caseCount)&&input.caseCount>0);
  need(['start','complete','abandoned'].includes(input.phase));
  const qaRound=input.qaRound??1;
  need(Number.isSafeInteger(qaRound)&&qaRound>=1&&qaRound<=3,'qa_round_invalid');
  const binding={specsDir:input.specsDir,feature:input.feature,identity:input.identity,packageDigest:input.packageDigest};
  let passed=[];
  if(input.phase==='abandoned'){
    const previous=inspectCmAiQaRecovery(binding);
    passed=previous.partialPassCases;
    need(previous.testRunId===input.testRunId&&previous.qaRound===qaRound
      &&previous.mode===input.mode&&previous.caseCount===input.caseCount,'qa_round_invalid');
    if(previous.abandoned)return;
  }else if(input.phase==='start'){
    let previous;
    if(Object.hasOwn(input,'previousTestRunId')){
      previous=inspectCmAiQaRecovery(binding);
      need(previous.abandoned&&previous.testRunId===input.previousTestRunId&&previous.qaRound===qaRound,'qa_round_invalid');
    }else previous=latestCmAiQaRun(binding);
    scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
      need(!(row.event==='test_run'&&row.operation_id===input.testRunId),'qa_round_invalid');
    });
    if(previous===null)need(qaRound===1,'qa_round_invalid');
    else if(!Object.hasOwn(input,'previousTestRunId')){
      const failure=inspectCmAiQaFailure({...binding,testRunId:previous.testRunId});
      need(qaRound===failure.qaRound+1&&input.testRunId!==previous.testRunId,'qa_round_invalid');
    }
  }else need(readCmAiQaRunRound({...binding,testRunId:input.testRunId})===qaRound,'qa_round_invalid');
  const decision=findCmAiQaDecision({specsDir:input.specsDir,feature:input.feature,identity:input.identity,
    packageDigest:input.packageDigest});need(decision?.status==='triggered','qa_not_triggered');
  const data={node:'N6',repository_id:input.identity.repositoryId,feature:input.feature,task:input.identity.taskId,
    package_digest:input.packageDigest,qa_decision_id:decision.decisionId,operation_id:input.testRunId,
    attempt:qaRound,mode:input.mode,case_count:input.caseCount};
  if(input.phase==='start'){
    if(Object.hasOwn(input,'previousTestRunId'))data.previous_test_run_id=input.previousTestRunId;
    const deferred=json(input.deferredCases??[]);need(Array.isArray(deferred),'qa_plan_invalid');
    for(const item of deferred){
      shape(item,['id','taskIds']);id(item.id);
      need(Array.isArray(item.taskIds)&&item.taskIds.length>0,'qa_plan_invalid');
      for(const taskId of item.taskIds)id(taskId);
    }
    data.deferred_cases=deferred;
  }
  if(input.phase==='abandoned')Object.assign(data,{previous_test_run_id:input.testRunId,reason:'host_terminated',partial_pass_cases:passed});
  if(input.phase==='complete'){
    const result=json(input.result);shape(result,['result','passed','failed','blocked','report']);
    for(const key of ['passed','failed','blocked'])need(Number.isSafeInteger(result[key])&&result[key]>=0,'qa_result_invalid');
    need(result.passed+result.failed+result.blocked===input.caseCount,'qa_result_invalid');
    need((result.result==='PASS'&&result.passed===input.caseCount)
      ||(result.result==='FAIL'&&result.failed>0)||(result.result==='BLOCKED'&&result.blocked>0),'qa_result_invalid');
    reportFile(input.specsDir,result.report);Object.assign(data,result);
  }else need(!Object.hasOwn(input,'result'));
  const args=[writer,'--workflow','cm-ai','--event','test_run','--phase',input.phase,'--runtime','codex',
    '--project-root',input.codeProject,'--specs-dir',input.specsDir,'--run-id',input.identity.runId,
    '--detail',`QA ${input.phase}`,'--data-json',JSON.stringify(data)];
  const options={timeout:10000,maxBuffer:MiB,killSignal:'SIGKILL'};
  if(Object.hasOwn(input,'logHome')){text(input.logHome);options.env={...process.env,CM_WORKFLOW_LOG_HOME:input.logHome};}
  const result=childProcess.spawnSync('python3',args,options);
  need(!result.error&&result.status===0&&result.signal===null,'qa_log_failed');
  return readResult(result.stdout,input.identity,input.specsDir);
}

// Read the registered round before executing cases or publishing their result.
// Task attempt remains bound by the QA decision; it is not the QA round.
export function readCmAiQaRunRound(input){
  shape(input,['specsDir','feature','identity','packageDigest','testRunId']);
  const {testRunId,...binding}=input;id(testRunId);
  const decision=findCmAiQaDecision(binding);need(decision?.status==='triggered','qa_not_triggered');
  const rows=[];
  scanRows(path.join(input.specsDir,'运行日志.jsonl'),row=>{
    if(row.workflow==='cm-ai'&&row.event==='test_run'&&row.run_id===input.identity.runId
      &&row.node==='N6'&&row.repository_id===input.identity.repositoryId&&row.feature===input.feature
      &&row.task===input.identity.taskId&&row.package_digest===input.packageDigest
      &&row.qa_decision_id===decision.decisionId)rows.push(row);
  });
  const starts=validateRunSequence(rows.map((row,position)=>({row,position})));
  const start=starts.at(-1).row;
  need(start.operation_id===testRunId&&!rows.some(row=>row.operation_id===testRunId
    &&['complete','abandoned'].includes(row.phase)),'qa_round_invalid');
  return start.attempt;
}

export function inspectCmAiQaResult(input) {
  return inspectQaResult(input,false);
}

// Input to the separate cm-fix lifecycle, not permission to modify or rerun QA.
// Shares the exact latest-round validator; never lets callers select an old FAIL.
export function inspectCmAiQaFailure(input) {
  return inspectQaResult(input,true);
}

// Historical evidence only. Never use this to select a new repair or QA action.
export function readCmAiQaFailureHistory(input) {
  return inspectQaResult(input,true,true);
}

function inspectQaResult(input,failureSource,historical=false) {
  shape(input,['specsDir','feature','identity','packageDigest','testRunId']);
  text(input.specsDir);text(input.feature);validIdentity(input.identity);hex(input.packageDigest);id(input.testRunId);
  const log=path.join(path.resolve(input.specsDir),'运行日志.jsonl');
  need(fs.existsSync(log),'qa_result_incomplete');
  const decisions=[],allRuns=[];let position=0;
  try {scanRows(log,row=>{
    const item={row,position:position++};
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
      &&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
      &&row.feature===input.feature&&row.task===input.identity.taskId&&row.attempt===input.identity.attempt
      &&row.package_digest===input.packageDigest)decisions.push(item);
    if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='test_run')allRuns.push(item);
  });}catch{need(false,'qa_result_invalid');}
  need(decisions.length===1&&decisions[0].row.status==='triggered','qa_not_triggered');
  const decisionId=decisions[0].row.decision_id;id(decisionId);
  const selected=allRuns.filter(item=>item.row.operation_id===input.testRunId);
  need(selected.length>0,'qa_result_incomplete');
  const bound=row=>row.node==='N6'&&row.repository_id===input.identity.repositoryId
    &&row.run_id===input.identity.runId&&row.feature===input.feature&&row.task===input.identity.taskId
    &&row.package_digest===input.packageDigest
    &&row.qa_decision_id===decisionId;
  for(const {row} of selected)need(bound(row),'qa_result_mismatch');
  const candidates=allRuns.filter(item=>item.position>decisions[0].position&&bound(item.row));
  need(candidates.length>0,'qa_result_invalid');
  for(const {row} of candidates)need(typeof row.operation_id==='string'
    &&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.operation_id)
    &&Number.isSafeInteger(row.attempt)&&row.attempt>=1&&row.attempt<=3,'qa_result_invalid');
  const latestStarts=candidates.filter(item=>item.row.phase==='start');
  need(latestStarts.length>0,'qa_result_incomplete');
  validateRunSequence(candidates,'qa_result_invalid');
  const latestStart=latestStarts.at(-1);
  if(!historical)need(latestStart.row.operation_id===input.testRunId,'qa_result_stale');
  const runs=candidates.filter(item=>item.row.operation_id===input.testRunId);
  need(runs.length>0,'qa_result_invalid');
  const starts=runs.filter(item=>item.row.phase==='start'),completes=runs.filter(item=>item.row.phase==='complete');
  need(starts.length===1&&completes.length===1,'qa_result_incomplete');
  need(decisions[0].position<starts[0].position&&starts[0].position<completes[0].position,'qa_result_invalid');
  const start=starts[0].row,complete=completes[0].row;
  text(start.mode);text(complete.mode);need(start.mode===complete.mode&&start.attempt===complete.attempt,'qa_result_invalid');
  for(const key of ['case_count','passed','failed','blocked'])
    need(Number.isSafeInteger(complete[key])&&complete[key]>=0,'qa_result_invalid');
  need(Number.isSafeInteger(start.case_count)&&start.case_count>0&&start.case_count===complete.case_count
    &&complete.passed+complete.failed+complete.blocked===complete.case_count,'qa_result_invalid');
  text(complete.result);const result=complete.result.toUpperCase();
  let status;
  if(['PASS','PASSED'].includes(result)){
    need(complete.passed===complete.case_count&&complete.failed===0&&complete.blocked===0
      &&!runs.some(item=>item.row.phase==='case_blocked'),'qa_result_invalid');status='passed';
  }else if(['FAIL','FAILED'].includes(result)){
    need(complete.failed>0,'qa_result_invalid');status='failed';
  }else if(['BLOCKED','NEEDS_MANUAL'].includes(result)){
    need(complete.blocked>0,'qa_result_invalid');status='blocked';
  }else need(false,'qa_result_invalid');
  const report=reportFile(input.specsDir,complete.report);
  if(failureSource){
    need(status==='failed','qa_failure_required');
    return json({identity:input.identity,packageDigest:input.packageDigest,testRunId:input.testRunId,
      qaDecisionId:decisionId,qaRound:start.attempt,report,
      counts:{total:complete.case_count,passed:complete.passed,failed:complete.failed,blocked:complete.blocked}});
  }
  return Object.freeze({status});
}
