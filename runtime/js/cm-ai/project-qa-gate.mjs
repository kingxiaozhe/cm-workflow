// Project-level view of every approved feature's latest N6 QA, read from the
// authoritative specs log. Read-only: it names what has not passed; it never
// reruns, repairs, supersedes or reinterprets a QA result.
import fs from 'node:fs';
import path from 'node:path';
import {scanRows} from './log-rows.mjs';

const LABELS={qa_failed:'最新一轮 FAIL',qa_blocked:'最新一轮 BLOCKED',qa_decision_blocked:'QA 决策阻塞',
  qa_not_run:'已触发但未执行',qa_execution_unknown:'执行结果未知',qa_pending:'旧结果已作废，待下一轮'};
const cache=new Map();

// One pass: the latest decision per feature, and the test_run rows bound to it.
function readFeatureQa(specsDir){
  const log=path.join(path.resolve(specsDir),'运行日志.jsonl');
  let stat;
  try{stat=fs.lstatSync(log);}catch(error){if(error.code==='ENOENT')return new Map();throw error;}
  const key=[log,stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(':');
  if(cache.has(key))return cache.get(key);
  const decisions=new Map(),runs=[];
  scanRows(log,row=>{
    if(row?.schema_version!==1||row.workflow!=='cm-ai'||row.node!=='N6'||typeof row.feature!=='string')return;
    if(row.event==='qa')decisions.set(row.feature,row);
    else if(row.event==='test_run')runs.push(row);
  });
  const result=new Map([...decisions].map(([feature,decision])=>[feature,{decision,
    runs:runs.filter(row=>row.feature===feature&&row.run_id===decision.run_id&&row.repository_id===decision.repository_id
      &&row.task===decision.task&&row.package_digest===decision.package_digest&&row.qa_decision_id===decision.decision_id)}]));
  cache.clear();cache.set(key,result);
  return result;
}

// Row-level reading for warnings. The strict owner validator replaces it via
// `inspect` wherever a result gates run_done.
function latestRound(runs){
  const start=runs.filter(row=>row.phase==='start').at(-1);
  if(!start)return 'qa_not_run';
  const rows=runs.filter(row=>row.operation_id===start.operation_id);
  if(rows.some(row=>['superseded','abandoned'].includes(row.phase)))return 'qa_pending';
  const complete=rows.find(row=>row.phase==='complete');
  if(!complete)return 'qa_execution_unknown';
  const result=String(complete.result).toUpperCase();
  return ['PASS','PASSED'].includes(result)?null:['FAIL','FAILED'].includes(result)?'qa_failed':'qa_blocked';
}

// Features whose latest QA decision (from any run but the caller's own) has not
// ended in a completed PASS. A skipped latest decision is not a failure; the
// mandatory feature-completion trigger is enforced where it is decided.
export function outstandingFeatureQa({specsDir,features,currentRunId=null,inspect=null}){
  const outstanding=[];
  for(const [feature,{decision,runs}] of readFeatureQa(specsDir)){
    if(!features.includes(feature)||decision.run_id===currentRunId||decision.status==='skipped')continue;
    let status;
    if(decision.status!=='triggered')status='qa_decision_blocked';
    else if(inspect===null)status=latestRound(runs);
    else{
      try{
        const latest=inspect({specsDir,feature,packageDigest:decision.package_digest,identity:{repositoryId:decision.repository_id,
          runId:decision.run_id,taskId:decision.task,attempt:decision.attempt}});
        status=latest===null?'qa_not_run':latest.status==='passed'?null:latest.status==='failed'?'qa_failed':'qa_blocked';
      }catch(error){
        status=error?.code==='qa_result_incomplete'?'qa_execution_unknown':error?.code==='qa_result_superseded'?'qa_pending'
          :typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:'qa_result_invalid';
      }
    }
    if(status!==null)outstanding.push({feature,runId:decision.run_id,taskId:decision.task,attempt:decision.attempt,status});
  }
  return outstanding.sort((left,right)=>features.indexOf(left.feature)-features.indexOf(right.feature));
}

export function describeOutstandingQa(item){
  return `${item.feature}（${item.taskId} / run ${item.runId}：${LABELS[item.status]??item.status}）`;
}
