// N6 policy over host semantic assessment; no provider, QA execution or new state.
import fs from 'node:fs';
import path from 'node:path';
import {inspectCmAiQaTaskContext} from './cm-ai-admission.mjs';
import {scanRows,readDecision} from './cm-ai-qa-log.mjs';
import {digest,freeze,hex,json,need,shape,validIdentity} from './effect-contract.mjs';

const key=(feature,task)=>`${feature}/${task}`;

function history(binding,context) {
  const completed=new Set(context.completed.map(task=>key(task.feature,task.id)));
  const unseen=new Set(completed),since=new Set();
  const log=path.join(binding.specsDir,'运行日志.jsonl');
  if(fs.existsSync(log))scanRows(log,row=>{
    if(row?.schema_version!==1||row.workflow!=='cm-ai'||row.event!=='qa'||row.node!=='N6'
      ||row.repository_id!==binding.identity.repositoryId||!completed.has(key(row.feature,row.task)))return;
    const identity={repositoryId:row.repository_id,runId:row.run_id,taskId:row.task,attempt:row.attempt};
    readDecision({decisionId:row.decision_id,identity,packageDigest:row.package_digest,status:row.status,
      reason:row.reason,score:row.score,at:row.at},identity,row.package_digest);
    const task=key(row.feature,row.task);unseen.delete(task);
    if(row.status==='triggered')since.clear();else since.add(task);
  });
  // Missing historical QA rows are unknown coverage, never evidence of a reset.
  // This callback only proposes a fresh decision. An older run/package for the
  // same task cannot cover the current work; exact recovery happens in entry.
  return new Set([...unseen,...since,key(binding.feature,binding.identity.taskId)]).size;
}

export function decideHostQaPolicy({assessment,pending,mergeEligible,unassessedTasks}) {
  const value=json(assessment);shape(value,['scores','changes']);
  shape(value.scores,['scope','risk','accumulation','boundary']);
  shape(value.changes,['api','migration','authentication','authorization','payment']);
  for(const score of Object.values(value.scores))need(Number.isInteger(score)&&score>=1&&score<=5,'qa_assessment_invalid');
  for(const flag of Object.values(value.changes))need(typeof flag==='boolean','qa_assessment_invalid');
  need(Number.isSafeInteger(pending)&&pending>=0&&typeof mergeEligible==='boolean'
    &&Number.isSafeInteger(unassessedTasks)&&unassessedTasks>=1,'qa_policy_unavailable');
  need(!mergeEligible||pending===1,'qa_policy_unavailable');
  const score=Object.values(value.scores).reduce((sum,item)=>sum+item,0);
  const reasons=[];
  if(pending===0)reasons.push('feature_complete');
  for(const name of ['migration','authentication','authorization','payment'])if(value.changes[name])reasons.push(name);
  if(unassessedTasks>=5)reasons.push('five_tasks_without_qa');
  if(value.changes.api&&!mergeEligible)reasons.push('api_change');
  if(reasons.length)return {status:'triggered',score:null,reason:reasons.join(',')};
  if(score>=8)return {status:'triggered',score,reason:'risk_score'};
  return {status:'skipped',score,reason:value.changes.api&&mergeEligible?'merged_to_feature_qa':'risk_score_below_threshold'};
}

// Plug directly into the existing trusted qaDecisionProvider seam. The host
// classifies meaning; this function owns the mechanical decision and binding.
export function createHostQaDecisionProvider({assess,timeoutMs}) {
  need(typeof assess==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000,'qa_assessment_invalid');
  return Object.freeze({timeoutMs,async decide(raw,signal){
    const binding=json(raw);shape(binding,['specsDir','codeProject','feature','identity','packageDigest']);
    validIdentity(binding.identity);hex(binding.packageDigest);
    const context=inspectCmAiQaTaskContext({...binding,taskId:binding.identity.taskId});
    const unassessedTasks=history(binding,context);
    need(!signal.aborted,'cancelled');
    const assessment=await assess(freeze({...binding,pending:context.pending,mergeEligible:context.mergeEligible,
      unassessedTasks}),signal);
    need(!signal.aborted,'cancelled');
    // Assessment is read-only. A task/log change while it was pending requires
    // another decision; do not bind an answer to different policy inputs.
    const current=inspectCmAiQaTaskContext({...binding,taskId:binding.identity.taskId});
    need(digest(current)===digest(context)&&history(binding,current)===unassessedTasks,'stale_qa');
    const result=decideHostQaPolicy({assessment,pending:context.pending,mergeEligible:context.mergeEligible,unassessedTasks});
    return freeze({...result,decisionId:`qa-${digest({identity:binding.identity,packageDigest:binding.packageDigest}).slice(0,48)}`,
      identity:binding.identity,packageDigest:binding.packageDigest,at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')});
  }});
}
