// Trusted in-process batch driver. Task lifecycle and completion remain owned
// by the existing runner; only transitions between task runs are logged here.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openControlRun,validateRunDefinition} from './cm-ai-run.mjs';
import {digest,json,shape,need,id,hex} from '../runtime/js/cm-ai/effect-contract.mjs';
import {scanRows,findCmAiQaDecision,latestCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {inspectRunClosure} from './cm-log-event.mjs';

const writer=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
const key=task=>`${task.feature}/${task.taskId}`;
export function createCmAiBatch({configuration,executionFor,logHome}){
  const config=json(configuration);
  shape(config,['version','repositoryId','batchId','specsDir','codeProject','tasks',...(Object.hasOwn(config,'codeProjects')?['codeProjects']:[])]);
  need(config.version===1);id(config.repositoryId);id(config.batchId);need(config.batchId.length>=8);
  need(typeof executionFor==='function'&&typeof logHome==='string'&&path.isAbsolute(logHome));
  need(Array.isArray(config.tasks)&&config.tasks.length>0&&config.tasks.length<=256);
  const plans=new Map();
  for(const task of config.tasks){
    shape(task,['feature','taskId','scope','requirements']);
    need(!plans.has(key(task)));const definition=validateRunDefinition({version:1,
      specsDir:config.specsDir,codeProject:config.codeProject,...(config.codeProjects?{codeProjects:config.codeProjects}:{}),feature:task.feature,
      identity:{repositoryId:config.repositoryId,runId:`task-${digest({batchId:config.batchId,task:key(task)}).slice(0,48)}`,
        taskId:task.taskId,attempt:1},scope:task.scope,requirements:task.requirements});
    need(definition.specsDir===config.specsDir&&definition.codeProject===config.codeProject,'invalid_path');
    plans.set(key(task),definition);
  }
  const first=plans.keys().next().value,planDigest=digest(config),log=path.join(config.specsDir,'运行日志.jsonl');
  let active=null,busy=false,cancelled=false,liveKey=first;
  const executions=new Map();
  async function executionForKey(taskKey){
    if(!executions.has(taskKey)){
      const execution=await executionFor(json(plans.get(taskKey)));
      need(execution!==null&&typeof execution==='object','execution_adapter_required');
      // Preserve fixed protected-factory provenance; never clone protected callbacks.
      if(Object.isFrozen(execution)){
        need(execution.qaLogHome===logHome,'batch_log_mismatch');executions.set(taskKey,execution);
      }else executions.set(taskKey,{...execution,qaLogHome:logHome});
    }
    return executions.get(taskKey);
  }
  function progress(){
    const rows=[];
    if(fs.existsSync(log))scanRows(log,row=>{
      if(row?.workflow==='cm-ai'&&row.event==='decision'&&row.run_id===config.batchId
        &&['batch_start','batch_handoff','batch_cancel'].includes(row.phase))rows.push(row);
    });
    let current=first,stopped=false;const seen=new Set();
    for(const [index,row] of rows.entries()){
      need(row.schema_version===1&&row.repository_id===config.repositoryId
        &&row.plan_digest===planDigest,'batch_plan_mismatch');
      need(!stopped&&row.from_key===current,'batch_history_invalid');
      if(row.phase==='batch_start'){need(index===0,'batch_history_invalid');continue;}
      need(index>0&&rows[0].phase==='batch_start','batch_history_invalid');
      if(row.phase==='batch_cancel'){stopped=true;continue;}
      need(plans.has(row.to_key)&&!seen.has(row.to_key)&&row.to_key!==current,'batch_history_invalid');
      hex(row.checkpoint);hex(row.package_digest);seen.add(current);current=row.to_key;
    }
    return {rows,current,stopped};
  }
  function record(phase,data){
    const result=spawnSync('python3',[writer,'--workflow','cm-ai','--event','decision','--phase',phase,
      '--runtime','codex','--project-root',config.codeProject,'--specs-dir',config.specsDir,'--run-id',config.batchId,
      '--detail',phase==='batch_handoff'?'Task QA and context completed; advance to next task':
        phase==='batch_start'?'Approved task batch started':'Batch cancelled',
      '--data-json',JSON.stringify({repository_id:config.repositoryId,plan_digest:planDigest,...data})],
    {timeout:10000,maxBuffer:1024*1024,encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}});
    need(!result.error&&result.status===0&&result.signal===null,'batch_log_failed');
    const receipt=JSON.parse(result.stdout);need(receipt.run_id===config.batchId,'batch_log_failed');
  }
  async function open(taskKey){
    const definition=plans.get(taskKey),state=path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json');
    return openControlRun(definition,fs.existsSync(state)?'resume':'create',await executionForKey(taskKey));
  }
  return Object.freeze({async handle(raw){
    const request=json(raw);shape(request,['operation','requestId']);id(request.requestId);
    need(['advance','status','cancel'].includes(request.operation));
    if(request.operation==='cancel'&&busy){
      cancelled=true;
      if(active){
        if(progress().rows.length===0)record('batch_start',{from_key:liveKey});
        record('batch_cancel',{from_key:liveKey});
        return active.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(liveKey).identity});
      }
      return {outcome:'cancelled',code:'cancel_pending',batchId:config.batchId};
    }
    if(request.operation==='status'&&busy)return {outcome:'reported',batchId:config.batchId,currentTask:liveKey,state:'running'};
    need(!busy,'batch_busy');busy=true;
    try{
      const initial=progress();liveKey=initial.current;
      if(initial.stopped)return {outcome:'blocked',code:'cancelled',batchId:config.batchId};
      // Validate durable checkpoints, not old live snapshots: later approved
      // tasks may legitimately change the same code paths.
      for(const row of initial.rows.filter(row=>row.phase==='batch_handoff')){
        const previous=await open(row.from_key);
        try{
          need(!previous.blocked&&previous.checkpoint()===row.checkpoint,'batch_checkpoint_mismatch');
          const definition=plans.get(row.from_key),status=await previous.host.handle({version:1,operation:'status',
            requestId:request.requestId,identity:definition.identity});
          need(status.state==='fixture_completed'&&[null,'correction_review_required'].includes(status.code)
            &&status.packageDigest===row.package_digest,'batch_checkpoint_mismatch');
          const binding={specsDir:config.specsDir,feature:definition.feature,identity:status.identity,packageDigest:status.packageDigest};
          const qa=findCmAiQaDecision(binding);
          need(qa?.status==='skipped'||(qa?.status==='triggered'&&latestCmAiQaRun(binding)?.status==='passed'),'batch_qa_not_ready');
          need(inspectRunClosure(log,definition.identity.runId).closed,'batch_resources_open');
        }
        finally{previous.close();}
      }
      for(let count=0;count<plans.size;count++){
        active=await open(liveKey);
        if(active.blocked)return {outcome:'blocked',code:active.blocked.reason,batchId:config.batchId};
        // The child store holds the existing exclusive writer lock here. Reject
        // a stale selection made before another batch process advanced.
        need(progress().current===liveKey&&!progress().stopped,'batch_history_changed');
        if(progress().rows.length===0&&request.operation!=='status')record('batch_start',{from_key:liveKey});
        if(cancelled||request.operation==='cancel'){
          record('batch_cancel',{from_key:liveKey});cancelled=true;
          return active.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(liveKey).identity});
        }
        const result=await active.host.handle({version:1,operation:request.operation,requestId:request.requestId,
          identity:plans.get(liveKey).identity});
        if(cancelled)return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};
        if(result.state==='run_done'||result.pendingAction==='start_next_task')
          need(inspectRunClosure(log,plans.get(liveKey).identity.runId).closed,'batch_resources_open');
        if(result.outcome!=='refreshed'||result.pendingAction!=='start_next_task')return {...result,batchId:config.batchId};
        const next=`${result.nextTask.feature}/${result.nextTask.id}`;
        need(plans.has(next),'batch_task_scope_required');
        record('batch_handoff',{from_key:liveKey,to_key:next,checkpoint:active.checkpoint(),package_digest:result.packageDigest});
        active.close();active=null;liveKey=next;
      }
      need(false,'batch_limit');
    }finally{active?.close();active=null;busy=false;}
  }});
}
