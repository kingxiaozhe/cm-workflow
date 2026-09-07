// Fixed N6 decision adapter for the JS CM log authority through its platform lock adapter.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hex,id,json,need,shape,text,validIdentity} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const MiB=1024*1024;

const sameIdentity=(left,right)=>['repositoryId','runId','taskId','attempt'].every(key=>left[key]===right[key]);

function readDecision(raw,identity,packageDigest) {
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

function scanRows(log,visit) {
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
  let result;
  try{result=childProcess.spawnSync('python3',args,options);}
  catch{need(false,'qa_log_failed');}
  need(!result.error&&result.status===0&&result.signal===null&&Buffer.isBuffer(result.stdout)
    &&result.stdout.length<=MiB,'qa_log_failed');
  return readResult(result.stdout,input.identity,input.specsDir);
}

export function inspectCmAiQaDecision(input) {
  shape(input,['specsDir','feature','identity','packageDigest']);
  text(input.specsDir);text(input.feature);validIdentity(input.identity);hex(input.packageDigest);
  const log=path.join(path.resolve(input.specsDir),'运行日志.jsonl');
  need(fs.existsSync(log),'context_not_ready');
  const matches=[];
  try {scanRows(log,row=>{if(row?.schema_version===1&&row.workflow==='cm-ai'&&row.event==='qa'&&row.node==='N6'
    &&row.repository_id===input.identity.repositoryId&&row.run_id===input.identity.runId
    &&row.feature===input.feature&&row.task===input.identity.taskId&&row.attempt===input.identity.attempt
    &&row.package_digest===input.packageDigest)matches.push(row);});}
  catch{need(false,'context_not_ready');}
  need(matches.length===1,'context_not_ready');
  const row=matches[0];id(row.decision_id);
  need(['triggered','skipped','blocked'].includes(row.status),'context_not_ready');
  return Object.freeze({status:row.status,decisionId:row.decision_id});
}

function reportFile(specsDir,raw) {
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

export function inspectCmAiQaResult(input) {
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
  need(latestStarts.every((item,index)=>item.row.attempt===index+1),'qa_result_invalid');
  const latestStart=latestStarts.at(-1);
  need(latestStart.row.operation_id===input.testRunId,'qa_result_stale');
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
  reportFile(input.specsDir,complete.report);
  return Object.freeze({status});
}
