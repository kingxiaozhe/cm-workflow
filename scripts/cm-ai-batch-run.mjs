// Trusted in-process batch driver. Task lifecycle and completion remain owned
// by the existing runner; only transitions between task runs are logged here.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openControlRun,validateRunDefinition} from './cm-ai-run.mjs';
import {digest,json,shape,need,id,hex} from '../runtime/js/cm-ai/effect-contract.mjs';
import {scanRows,findCmAiQaDecision,latestCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {checkParallelWrite} from './cm-task-gate.mjs';
import {parseFeatureTaskText} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {inspectRunClosure} from './cm-log-event.mjs';

const writer=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
const key=task=>`${task.feature}/${task.taskId}`;
export function createCmAiBatch({configuration,executionFor,logHome,runtime='codex',checkCommands=null,checkTimeoutMs=60000}){
  const config=json(configuration);
  shape(config,['version','repositoryId','batchId','specsDir','codeProject','tasks',...['codeProjects','parallel'].filter(name=>Object.hasOwn(config,name))]);
  need(config.version===1);id(config.repositoryId);id(config.batchId);need(config.batchId.length>=8);
  need(typeof executionFor==='function'&&typeof logHome==='string'&&path.isAbsolute(logHome));
  need(Array.isArray(config.tasks)&&config.tasks.length>0&&config.tasks.length<=256);
  need(['codex','claude'].includes(runtime),'invalid_runtime');
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
  const groups=validateGroups(config,plans),membership=new Map(groups.flatMap(group=>group.map(key=>[key,group])));
  const first=plans.keys().next().value,planDigest=digest(config),log=path.join(config.specsDir,'运行日志.jsonl');
  let active=null,busy=false,cancelled=false,liveKey=first;
  const executions=new Map(),members=new Map();
  let releaseLock=null,completeTail=Promise.resolve();
  async function executionForKey(taskKey){
    if(!executions.has(taskKey)){
      const execution=await executionFor(json(plans.get(taskKey)),{parallelMember:membership.has(taskKey)});
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
        &&['batch_start','batch_handoff','batch_cancel','batch_member_ready','batch_merge_conflict','batch_merge_started','batch_merge_blocked'].includes(row.phase))rows.push(row);
    });
    if(groups.length)return parallelProgress(rows);
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
      '--runtime',runtime,'--project-root',config.codeProject,'--specs-dir',config.specsDir,'--run-id',config.batchId,
      '--detail',phase==='batch_handoff'?'Task QA and context completed; advance to next task':
        phase==='batch_start'?'Approved task batch started':'Batch cancelled',
      '--data-json',JSON.stringify({repository_id:config.repositoryId,plan_digest:planDigest,...data})],
    {timeout:10000,maxBuffer:1024*1024,encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}});
    need(!result.error&&result.status===0&&result.signal===null,'batch_log_failed');
    const receipt=JSON.parse(result.stdout);need(receipt.run_id===config.batchId,'batch_log_failed');
  }
  async function open(taskKey){
    const definition=plans.get(taskKey),state=path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json');
    return openControlRun(definition,fs.existsSync(state)?'resume':'create',await executionForKey(taskKey),
      membership.has(taskKey)?{parallelSelection:{version:1,group:membership.get(taskKey).map(key=>plans.get(key).identity.taskId)}}:{});
  }
  function parallelProgress(rows){
    const done=new Set(),ready=new Map(),merging=new Map();let stopped=false,code=null;
    for(const [index,row] of rows.entries()){
      need(row.schema_version===1&&row.repository_id===config.repositoryId&&row.plan_digest===planDigest,'batch_plan_mismatch');
      need(!stopped&&plans.has(row.from_key),'batch_history_invalid');
      if(row.phase==='batch_start'){need(index===0,'batch_history_invalid');continue;}
      need(index>0&&rows[0].phase==='batch_start','batch_history_invalid');
      if(row.phase==='batch_cancel'){stopped=true;code='cancelled';continue;}
      if(['batch_merge_conflict','batch_merge_blocked'].includes(row.phase)){stopped=true;code=row.code;continue;}
      if(row.phase==='batch_member_ready'){
        need(membership.has(row.from_key)&&!ready.has(row.from_key),'batch_history_invalid');
        hex(row.checkpoint);hex(row.package_digest);ready.set(row.from_key,row);continue;
      }
      if(row.phase==='batch_merge_started'){
        need(ready.has(row.from_key)&&!merging.has(row.from_key),'batch_history_invalid');merging.set(row.from_key,row);continue;
      }
      need(!done.has(row.from_key),'batch_history_invalid');hex(row.checkpoint);hex(row.package_digest);
      if(membership.has(row.from_key))need(ready.has(row.from_key)&&merging.has(row.from_key),'batch_history_invalid');
      done.add(row.from_key);
      need(row.to_key===[...plans.keys()].find(key=>!done.has(key)),'batch_history_invalid');
    }
    return {rows,current:[...plans.keys()].find(key=>!done.has(key)),stopped,code,done,ready,merging};
  }
  const location=key=>{const definition=plans.get(key);return {
    worktree:path.resolve(config.codeProject,'..','.cm-worktrees',config.batchId.slice(0,8),definition.identity.taskId),
    branch:`cm/${definition.feature.replace(/^\d+\./,'')}/${definition.identity.taskId}`};};
  function verifyMerged(row){
    const definition=plans.get(row.from_key),state=JSON.parse(fs.readFileSync(path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json'),'utf8'));
    const {revision,...body}=state;
    need(revision===row.checkpoint&&digest(body)===revision,'batch_checkpoint_mismatch');
    const binding={specsDir:config.specsDir,feature:definition.feature,identity:row.identity,packageDigest:row.package_digest};
    need(findCmAiQaDecision(binding)?.status==='skipped'&&inspectRunClosure(log,definition.identity.runId).closed,'batch_qa_not_ready');
    git(config.codeProject,['merge-base','--is-ancestor',row.merge_commit,'HEAD'],'batch_merge_history_changed');
  }
  function prepareGroup(group){
    const state=progress(),remaining=group.filter(key=>!state.done.has(key));
    for(const key of remaining){
      const {worktree,branch}=location(key);
      if(!fs.existsSync(worktree)){
        need(!state.ready.has(key),'batch_worktree_missing');
        fs.mkdirSync(path.dirname(worktree),{recursive:true});
        git(config.codeProject,['worktree','add','-b',branch,worktree,'HEAD'],'batch_worktree_failed');
      }
      need(git(worktree,['branch','--show-current'])===branch,'batch_worktree_mismatch');
      const definition=plans.get(key);
      plans.set(key,validateRunDefinition({...definition,codeProject:worktree,
        ...(definition.codeProjects?{codeProjects:definition.codeProjects.map(root=>path.join(worktree,path.relative(config.codeProject,root)))}:{})}));
    }
    // Include the main checkout as the second assignment after a partial merge.
    const assignments=remaining.map(key=>`${plans.get(key).identity.taskId}=${location(key).worktree}`);
    if(assignments.length===1)assignments.push(`T-batch-main=${config.codeProject}`);
    if(assignments.length)checkParallelWrite({repo:config.codeProject,assignment:assignments});
  }
  async function driveMember(key,request){
    const run=await open(key);if(run.blocked)return {outcome:'blocked',code:run.blocked.reason};
    members.set(key,run);
    try{
      let status=await run.host.handle({version:1,operation:'status',requestId:request.requestId,identity:plans.get(key).identity});
      const call=async(operation,extra={})=>{
        need(!cancelled,'cancelled');
        status=await run.host.handle({version:1,operation,requestId:request.requestId,identity:status.identity,
          ...(['decision','complete','qa','context_refresh'].includes(operation)?{packageDigest:status.packageDigest}:{}),...extra});
        return status;
      };
      for(let round=status.identity.attempt;round<=2;round++){
        if(status.code===null&&['ready','changes_requested'].includes(status.state)
          ||status.state==='blocked'&&status.code==='developer_result_invalid')await call('start');
        if(['reported','advanced'].includes(status.outcome)&&(status.code===null&&status.state==='awaiting_review'
          ||status.state==='pending_review'&&status.code==='review_transport_timeout'))await call('decision');
        if(status.outcome==='advanced'&&status.code===null&&status.state==='changes_requested'&&status.identity.attempt===round+1)continue;
        if(['reported','advanced'].includes(status.outcome)&&status.code===null&&status.state==='approved'){
          const completion=completeTail.then(()=>call('complete'));
          completeTail=completion.then(()=>{},()=>{});await completion;
        }
        break;
      }
      if(status.state==='fixture_completed'&&status.code===null){
        await call('qa');
        if(status.code==='qa_skipped')await call('context_refresh',{testRunId:null});
      }
      if(status.outcome!=='refreshed'||status.pendingAction!=='start_next_task')return status;
      need(inspectRunClosure(log,plans.get(key).identity.runId).closed,'batch_resources_open');
      record('batch_member_ready',{from_key:key,checkpoint:run.checkpoint(),package_digest:status.packageDigest,
        identity:status.identity,...location(key)});
      return null;
    }finally{members.delete(key);run.close();}
  }
  async function mergeMember(row){
    const key=row.from_key,{worktree,branch}=location(key);
    need(row.worktree===worktree&&row.branch===branch,'batch_worktree_mismatch');
    // Reopen the unchanged member root to verify its actual completion and QA.
    const run=await open(key);
    try{
      need(!run.blocked&&run.checkpoint()===row.checkpoint,'batch_checkpoint_mismatch');
      const status=await run.host.handle({version:1,operation:'status',requestId:'batch-merge-status',identity:row.identity});
      need(status.state==='fixture_completed'&&status.code===null&&status.packageDigest===row.package_digest,'batch_checkpoint_mismatch');
      need(findCmAiQaDecision({specsDir:config.specsDir,feature:plans.get(key).feature,
        identity:row.identity,packageDigest:row.package_digest})?.status==='skipped','batch_qa_not_ready');
    }finally{run.close();}
    let intent=progress().merging.get(key);
    if(!intent){
      git(worktree,['add','-A']);
      if(git(worktree,['status','--porcelain']))git(worktree,['commit','-m',`${plans.get(key).identity.taskId}: ${taskDescription(config,plans.get(key))}`]);
      need(git(config.codeProject,['status','--porcelain'])==='','batch_main_dirty');
      intent={from_key:key,expected_old:git(config.codeProject,['rev-parse','HEAD']),member_commit:git(worktree,['rev-parse','HEAD'])};
      record('batch_merge_started',intent);
    }
    const current=git(config.codeProject,['rev-parse','HEAD']);
    if(current===intent.expected_old){
      const restore=unionAttributes(config.codeProject);
      let result;
      try{result=spawnSync('git',['-C',config.codeProject,'merge','--no-ff','--no-edit',intent.member_commit],gitOptions());}
      finally{restore();}
      if(result.error||result.status!==0){
        const files=git(config.codeProject,['diff','--name-only','--diff-filter=U']).split('\n').filter(Boolean);
        git(config.codeProject,['merge','--abort'],'batch_merge_abort_failed');
        need(git(config.codeProject,['rev-parse','HEAD'])===intent.expected_old,'batch_merge_history_changed');
        record('batch_merge_conflict',{from_key:key,code:'merge_conflict',files,expected_old:intent.expected_old});
        return {outcome:'blocked',code:'merge_conflict',batchId:config.batchId,files};
      }
    }else{
      // A crash may happen after Git commits but before the handoff log append.
      const parents=git(config.codeProject,['show','-s','--format=%P','HEAD']).split(' ');
      need(parents.length===2&&parents[0]===intent.expected_old&&parents[1]===intent.member_commit,'batch_merge_history_changed');
    }
    const merge_commit=git(config.codeProject,['rev-parse','HEAD']);
    let post_merge_check='skipped';
    if(checkCommands?.length){
      const check=createHostCheck({cwd:config.codeProject,commands:checkCommands,timeoutMs:checkTimeoutMs});
      const results=await check({identity:row.identity},{signal:new AbortController().signal});
      post_merge_check=results.every(item=>item.outcome==='passed')?'passed':'failed';
      if(post_merge_check==='failed'){
        record('batch_merge_blocked',{from_key:key,code:'post_merge_check_failed',merge_commit,post_merge_check});
        return {outcome:'blocked',code:'post_merge_check_failed',batchId:config.batchId};
      }
    }
    const done=progress().done;done.add(key);
    const next=[...plans.keys()].find(key=>!done.has(key));need(next,'parallel_final_task_excluded');
    record('batch_handoff',{from_key:key,to_key:next,checkpoint:row.checkpoint,package_digest:row.package_digest,
      identity:row.identity,merge_commit,post_merge_check});
    git(config.codeProject,['worktree','remove',worktree]);git(config.codeProject,['branch','-d',branch]);
    return null;
  }
  async function parallelGroup(group,request){
    const initial=progress();
    if(request.operation==='status')return {outcome:'reported',state:'parallel',batchId:config.batchId,
      ready:group.filter(key=>initial.ready.has(key)),merged:group.filter(key=>initial.done.has(key))};
    if(!initial.rows.length)record('batch_start',{from_key:liveKey});
    if(request.operation==='cancel'){record('batch_cancel',{from_key:liveKey});return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};}
    prepareGroup(group);
    // Resolve every member's actual worktree preflight before any start dispatch.
    for(const key of group.filter(key=>!initial.done.has(key))){
      try{await executionForKey(key);}catch(cause){
        if(cause.code!=='review_preflight_failed')throw cause;
        return {outcome:'blocked',state:'blocked',code:'review_preflight_failed',batchId:config.batchId,
          currentTask:key,identity:plans.get(key).identity};
      }
    }
    need(!cancelled,'cancelled');
    const results=await Promise.allSettled(group.filter(key=>!initial.ready.has(key)&&!initial.done.has(key)).map(key=>driveMember(key,request)));
    for(const result of results){if(result.status==='rejected')throw result.reason;if(result.value)return {...result.value,batchId:config.batchId};}
    for(const row of progress().ready.values()){
      if(!group.includes(row.from_key)||progress().done.has(row.from_key))continue;
      const result=await mergeMember(row);if(result)return result;
    }
    return null;
  }
  return Object.freeze({async handle(raw){
    const request=json(raw);shape(request,['operation','requestId']);id(request.requestId);
    need(['advance','status','cancel'].includes(request.operation));
    if(request.operation==='cancel'&&busy){
      cancelled=true;
      if(members.size){record('batch_cancel',{from_key:liveKey});
        await Promise.all([...members].map(([key,run])=>run.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(key).identity})));
        return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};}
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
      releaseLock=acquireBatchLock(config);
      const initial=progress();liveKey=initial.current;
      if(initial.stopped)return {outcome:'blocked',code:initial.code??'cancelled',batchId:config.batchId};
      // Validate durable checkpoints, not old live snapshots: later approved
      // tasks may legitimately change the same code paths.
      for(const row of initial.rows.filter(row=>row.phase==='batch_handoff')){
        if(membership.has(row.from_key)){verifyMerged(row);continue;}
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
        if(membership.has(liveKey)){
          const result=await parallelGroup(membership.get(liveKey),request);
          if(result)return result;liveKey=progress().current;continue;
        }
        active=await open(liveKey);
        if(active.blocked)return {outcome:'blocked',code:active.blocked.reason,batchId:config.batchId};
        // batch.lock serializes selection across processes; child locks remain run-local.
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
    }finally{active?.close();active=null;releaseLock?.();releaseLock=null;busy=false;}
  }});
}

function gitOptions(){return {encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}};}
function git(cwd,args,code='batch_git_failed'){
  const result=spawnSync('git',['-C',cwd,...args],gitOptions());
  need(!result.error&&result.status===0&&result.signal===null,code);return result.stdout.trim();
}
function taskDescription(config,definition){
  const parsed=parseFeatureTaskText(fs.readFileSync(path.join(config.specsDir,definition.feature,'tasks.md'),'utf8'),{allowDependencyPunctuation:true});
  need(!parsed.error,'parallel_task_invalid');return parsed.tasks.find(task=>task.id===definition.identity.taskId)?.description??definition.identity.taskId;
}
function validateGroups(config,plans){
  const groups=config.parallel??[];need(Array.isArray(groups),'invalid_parallel_groups');const used=new Set();
  for(const group of groups){
    need(Array.isArray(group)&&group.length>=2&&group.length<=4,'invalid_parallel_group');
    need(group.every(key=>plans.has(key)&&!used.has(key))&&new Set(group).size===group.length,'invalid_parallel_group');
    const feature=plans.get(group[0]).feature;
    need(group.every(key=>plans.get(key).feature===feature),'parallel_feature_mismatch');
    const parsed=parseFeatureTaskText(fs.readFileSync(path.join(config.specsDir,feature,'tasks.md'),'utf8'),{allowDependencyPunctuation:true});
    need(!parsed.error,'parallel_task_invalid');
    const ids=new Set(group.map(key=>plans.get(key).identity.taskId));
    need([...ids].every(id=>parsed.tasks.some(task=>task.id===id&&!task.dropped)),'parallel_task_invalid');
    need([...ids].every(id=>(parsed.dependencies.get(id)??[]).every(dep=>!ids.has(dep))),'parallel_dependency_conflict');
    const ordered=parsed.tasks.filter(task=>!task.dropped),last=ordered.at(-1);
    need(last&&!ids.has(last.id)&&plans.has(`${feature}/${last.id}`),'parallel_final_task_excluded');
    const paths=new Set();
    for(const key of group)for(const file of plans.get(key).scope){
      need(!paths.has(file),'parallel_scope_overlap');paths.add(file);
    }
    for(const key of group)used.add(key);
  }
  return groups;
}
function acquireBatchLock(config){
  const directory=path.join(config.specsDir,'.reviews','.execution');fs.mkdirSync(directory,{recursive:true,mode:0o700});
  need(fs.realpathSync(directory)===directory,'batch_lock_invalid');
  const target=path.join(directory,'batch.lock');
  for(let attempt=0;attempt<3;attempt++){
    let fd;
    try{fd=fs.openSync(target,'wx',0o600);}catch(error){
      if(error.code!=='EEXIST')throw error;
      const stat=fs.lstatSync(target);need(stat.isFile()&&!stat.isSymbolicLink(),'batch_lock_invalid');
      const owner=JSON.parse(fs.readFileSync(target,'utf8'));
      need(Number.isSafeInteger(owner.pid)&&owner.pid>0,'batch_lock_invalid');
      let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      need(!alive,'batch_locked');
      const current=fs.lstatSync(target);need(current.ino===stat.ino&&current.dev===stat.dev,'batch_locked');fs.unlinkSync(target);continue;
    }
    const stat=fs.fstatSync(fd);
    try{fs.writeFileSync(fd,JSON.stringify({batchId:config.batchId,pid:process.pid,at:new Date().toISOString()}));fs.fsyncSync(fd);}
    finally{fs.closeSync(fd);}
    return ()=>{const current=fs.lstatSync(target);need(current.ino===stat.ino&&current.dev===stat.dev,'batch_lock_changed');fs.unlinkSync(target);};
  }
  need(false,'batch_locked');
}
function unionAttributes(repo){
  const target=git(repo,['rev-parse','--path-format=absolute','--git-path','info/attributes']);
  const exists=fs.existsSync(target);
  if(exists)need(fs.lstatSync(target).isFile()&&!fs.lstatSync(target).isSymbolicLink(),'batch_attributes_invalid');
  const before=exists?fs.readFileSync(target):null;
  const after=Buffer.concat([before??Buffer.alloc(0),Buffer.from('\nAGENTS.md merge=union\n')]);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,after);
  return ()=>{need(fs.readFileSync(target).equals(after),'batch_attributes_changed');
    if(before===null)fs.unlinkSync(target);else fs.writeFileSync(target,before);};
}
