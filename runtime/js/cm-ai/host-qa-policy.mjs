// N6 fixed checkpoints over registered paths and runner-proven changes.
import fs from 'node:fs';
import path from 'node:path';
import {inspectCmAiQaTaskContext} from './cm-ai-admission.mjs';
import {scanRows,readDecision} from './cm-ai-qa-log.mjs';
import {digest,freeze,hex,id,json,need,shape,validIdentity} from './effect-contract.mjs';

const key=(feature,task)=>`${feature}/${task}`;

function unassessed(binding,context) {
  const completed=new Set(context.completed.map(task=>key(task.feature,task.id)));
  const pendingFeatures=new Set(context.pendingFeatures);
  const unseen=new Set(context.completed.filter(task=>pendingFeatures.has(task.feature))
    .map(task=>key(task.feature,task.id))),since=new Set();
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
  return new Set([...unseen,...since]);
}
function history(binding,context) {
  // Missing historical QA rows are unknown coverage, never evidence of a reset.
  // This callback only proposes a fresh decision. An older run/package for the
  // same task cannot cover the current work; exact recovery happens in entry.
  return new Set([...unassessed(binding,context),key(binding.feature,binding.identity.taskId)]).size;
}
// Completed tasks counted toward five_tasks_without_qa right now, by the same log
// reading the decision uses (batch-plan.mjs predicts one-member groups from it).
export function qaUnassessedTaskCount({specsDir,codeProject,feature,repositoryId}){
  const context=inspectCmAiQaTaskContext({specsDir,codeProject,feature});
  return unassessed({specsDir,feature,identity:{repositoryId}},context).size;
}

const categories=['migration','authentication','authorization','payment','api'];

// Deliberately bounded POSIX glob grammar: literals, *, ?, and whole-segment **.
// A registry never imports executable patterns, absolute roots or parent traversal.
function relativePath(value,pattern=false){
  need(typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\\\r\n\0]/.test(value)
    &&!value.startsWith('/')&&!/^[A-Za-z]:/.test(value),'qa_assessment_invalid');
  const parts=value.split('/');
  need(parts.every(part=>part.length>0&&part!=='.'&&part!=='..'),'qa_assessment_invalid');
  if(pattern)need(!/[\[\]{}()!+@]/.test(value)&&parts.every(part=>!part.includes('**')||part==='**'),'qa_assessment_invalid');
  return value;
}
export function readQaCriticalPaths(raw={}){
  const registry=json(raw);need(registry&&typeof registry==='object'&&!Array.isArray(registry),'qa_assessment_invalid');
  need(Object.keys(registry).every(name=>categories.includes(name)),'qa_assessment_invalid');
  for(const patterns of Object.values(registry)){
    need(Array.isArray(patterns)&&patterns.length<=256&&new Set(patterns).size===patterns.length,'qa_assessment_invalid');
    patterns.forEach(pattern=>relativePath(pattern,true));
  }
  return registry;
}
function matchesPath(file,pattern){
  const segments=pattern.split('/');
  const source=segments.map((part,index)=>part==='**'
    ?index===segments.length-1?'.*':'(?:[^/]+/)*'
    :part.replace(/[.*+?^${}()|[\]\\]/g,char=>char==='*'?'[^/]*':char==='?'?'[^/]':`\\${char}`)
      +(index===segments.length-1?'':'/')).join('');
  return new RegExp(`^${source}$`).test(file);
}
export function readQaAssessment(raw){
  const value=json(raw);shape(value,['confirmed']);need(value.confirmed===true,'qa_assessment_invalid');
  return value;
}
export function readQaChangedFiles(raw){
  const value=json(raw);shape(value,['paths','source']);
  need(['review_package','handoff_only','unavailable'].includes(value.source),'qa_policy_unavailable');
  need(Array.isArray(value.paths)&&value.paths.length<=10000&&new Set(value.paths).size===value.paths.length,'qa_policy_unavailable');
  value.paths.forEach(file=>relativePath(file));
  need(value.source!=='unavailable'||value.paths.length===0,'qa_policy_unavailable');
  return value;
}
export function decideHostQaPolicy({changedFiles,criticalPaths={},pending,mergeEligible,unassessedTasks}) {
  const registry=readQaCriticalPaths(criticalPaths);
  need(Array.isArray(changedFiles)&&new Set(changedFiles).size===changedFiles.length,'qa_policy_unavailable');
  changedFiles.forEach(file=>relativePath(file));
  need(Number.isSafeInteger(pending)&&pending>=0&&typeof mergeEligible==='boolean'
    &&Number.isSafeInteger(unassessedTasks)&&unassessedTasks>=1,'qa_policy_unavailable');
  need(!mergeEligible||pending===1,'qa_policy_unavailable');
  const hits=new Set(categories.filter(name=>(registry[name]??[]).some(pattern=>changedFiles.some(file=>matchesPath(file,pattern)))));
  const reasons=[];
  if(pending===0)reasons.push('feature_complete');
  for(const name of categories.slice(0,-1))if(hits.has(name))reasons.push(name);
  if(unassessedTasks>=5)reasons.push('five_tasks_without_qa');
  if(hits.has('api')&&!mergeEligible)reasons.push('api');
  if(reasons.length)return {status:'triggered',score:null,reason:reasons.join(',')};
  return {status:'skipped',score:null,reason:hits.has('api')&&mergeEligible?'merged_to_feature_qa':'no_fixed_trigger'};
}

// Plug directly into the existing trusted qaDecisionProvider seam. The host
// confirms the supplied inventory source; JS owns the decision and binding.
export function createHostQaDecisionProvider({assess,timeoutMs,criticalPaths={}}) {
  const registry=readQaCriticalPaths(criticalPaths);
  need(typeof assess==='function'&&Number.isSafeInteger(timeoutMs)&&timeoutMs>0&&timeoutMs<=60000,'qa_assessment_invalid');
  return Object.freeze({timeoutMs,async decide(raw,signal){
    const input=json(raw);
    shape(input,['specsDir','codeProject','feature','identity','packageDigest',...(Object.hasOwn(input,'previousDecisionId')?['previousDecisionId']:[]),
      ...(Object.hasOwn(input,'changedFiles')?['changedFiles']:[])]);
    // previousDecisionId names an older recorded decision that an explicit
    // recovery supersedes; it only derives a distinct id, never the assessment.
    const {previousDecisionId=null,changedFiles:rawFiles={paths:[],source:'unavailable'},...binding}=input;
    const changedFiles=readQaChangedFiles(rawFiles);
    need(changedFiles.source!=='unavailable'||!Object.values(registry).some(patterns=>patterns.length),'qa_policy_unavailable');
    if(previousDecisionId!==null)id(previousDecisionId);
    validIdentity(binding.identity);hex(binding.packageDigest);
    const context=inspectCmAiQaTaskContext({...binding,taskId:binding.identity.taskId});
    const unassessedTasks=history(binding,context);
    need(!signal.aborted,'cancelled');
    try{readQaAssessment(await assess(freeze({...binding,pending:context.pending,mergeEligible:context.mergeEligible,
      unassessedTasks,changedFiles,criticalPaths:registry}),signal));}
    catch(error){
      // A missed answer window is a transport outcome, not a QA decision. It is
      // reported like the outer decision timer: retryable, and nothing durable.
      if(error?.code==='host_request_timeout')throw Object.assign(new Error('QA assessment timed out'),{code:'qa_decision_timeout'});
      throw error;
    }
    need(!signal.aborted,'cancelled');
    // Assessment is read-only. A task/log change while it was pending requires
    // another decision; do not bind an answer to different policy inputs.
    const current=inspectCmAiQaTaskContext({...binding,taskId:binding.identity.taskId});
    need(digest(current)===digest(context)&&history(binding,current)===unassessedTasks,'stale_qa');
    const result=decideHostQaPolicy({changedFiles:changedFiles.paths,criticalPaths:registry,pending:context.pending,mergeEligible:context.mergeEligible,unassessedTasks});
    const bound={identity:binding.identity,packageDigest:binding.packageDigest,...(previousDecisionId===null?{}:{previousDecisionId})};
    return freeze({...result,decisionId:`qa-${digest(bound).slice(0,48)}`,
      identity:binding.identity,packageDigest:binding.packageDigest,changedFilesSource:changedFiles.source,at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')});
  }});
}
