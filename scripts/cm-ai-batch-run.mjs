import {readExecutionPolicy,readBatchExecutionPolicy,freezeBatchExecutionPolicy} from '../runtime/js/cm-ai/execution-policy.mjs';
import {readModelJsonRecord} from '../runtime/js/cm-ai/model-configuration-file.mjs';
import {readExternalModels} from '../runtime/js/cm-ai/external-models.mjs';
// Trusted in-process batch driver. Task lifecycle and completion remain owned
// by the existing runner; only transitions between task runs are logged here.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {openControlRun,validateRunDefinition,assertCreatableScope} from './cm-ai-run.mjs';
import {developmentRetryable,completionRetryable,reviewRetryable} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {batchOperatorGuidance} from '../runtime/js/cm-ai/operator-guidance.mjs';
import {digest,json,shape,need,id,hex,validIdentity} from '../runtime/js/cm-ai/effect-contract.mjs';
import {scanRows,findCmAiQaDecision,latestCmAiQaRun} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {checkParallelWrite,checkSoloWrite} from './cm-task-gate.mjs';
import {loadConfig} from './cm-workflow-config.mjs';
import {parseFeatureTaskText} from '../runtime/js/cm-ai/cm-ai-admission.mjs';
import {approvedTaskGrammar,TASK_GRAMMAR} from '../runtime/js/spec-task-line.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {inspectRunClosure as inspectClosure} from './cm-log-event.mjs';
import {releaseVerifiedQaResources} from '../runtime/js/cm-ai/qa-resource-release.mjs';
import {readRunnerHistory,projectedRunnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {readControlPolicy,controlTarget,readControlTarget} from '../runtime/js/cm-ai/control-policy.mjs';
import {BATCH_SEGMENT_FIELD,batchSegment,batchSegments,batchStarted,batchMemberWorktree,batchMemberBranch} from '../runtime/js/cm-ai/batch-location.mjs';
import {declaredTaskScope,assertDeclaredScope,parseTaskScopes,sessionTaskProblem,sessionTaskReason} from '../runtime/js/task-scope.mjs';
import {soloWorktreeBlocker,soloQaCounter,soloQaBase,workflowDecidesQa} from '../runtime/js/cm-ai/batch-plan.mjs';
import {strictPriorAttemptResolved,sameTaskPriorAttemptResolved} from '../runtime/js/cm-ai/external-run-guard.mjs';

const writer=fileURLToPath(new URL('./cm-log-event.py',import.meta.url));
const key=task=>`${task.feature}/${task.taskId}`;
// Generation-1 member run id; the batch host uses it to tell a new batch from a resumed one.
export const batchTaskRunId=(batchId,taskKey)=>`task-${digest({batchId,task:taskKey}).slice(0,48)}`;
// A spec rebind is a single-task resume flag; batch members cannot take it, so
// never advertise it for them. Name the exits that do exist instead. An idle
// cancel of a parallel group does not end its member runs, so a parallel
// member cannot be superseded afterwards and only the spec revert applies.
export function batchMemberResult(result,{parallel=false,taskKey=null,protocol='legacy'}={}){
  const decorate=value=>{
    const guidance=batchOperatorGuidance(value,{taskKey,protocol});
    return guidance?Object.freeze({...value,guidance}):value;
  };
  if(result?.pendingAction!=='spec_rebind')return decorate(result);
  const files=/变更文件：([^；]+)/.exec(result.reason??'')?.[1]??'规格文件';
  const revert=`规格已重新批准（变更：${files}，只动了其他任务），但批次成员不能换绑。出口：还原这些规格改动并重新批准后继续本批次`;
  return decorate(Object.freeze({...result,pendingAction:'none',
    reason:protocol==='v2'?`${revert}。v2 不支持作废旧证据后新建运行；保留原记录，不改走旧入口。`
      :parallel?`${revert}。并行组成员没有单独重做的出口。`
      :`${revert}；或取消本批次，还原该任务已改动的代码后，用单任务宿主 cm-ai-host.mjs 以 --supersede-reviewed-evidence --supersede-reason 原因 新建运行重做该任务。`}));
}
// Q24: single-task recovery operations a batch forwards to the member run it is
// stopped on, through the same cm-ai entry. option is the openControlRun one-shot
// permission; flag is the batch host launch flag that grants it for one member.
export const BATCH_MEMBER_ACTIONS=Object.freeze({
  develop_redo:Object.freeze({option:'allowDevelopRedo',flag:'--allow-develop-redo'}),
  abandon_effect:Object.freeze({option:'allowAbandonEffect',flag:'--allow-abandon-effect'}),
  abandon_review:Object.freeze({option:'allowAbandonReview',flag:'--allow-abandon-review'}),
  bootstrap_review_recover:Object.freeze({option:'allowBootstrapReviewRecovery',flag:'--allow-bootstrap-review-recovery'})});
// Pending actions a member resolves inside its own run from the batch entry.
const IN_RUN_ACTIONS=new Set([...Object.keys(BATCH_MEMBER_ACTIONS),'reconcile_review']);
// A batch may reschedule a parallel member serially (a second generation: new runId,
// attempt 1) only from a checkpointed blocked terminal: the old call returned, so it
// ended and its writer stopped. The decision reads the member's RAW persisted journal
// (history from readRunnerHistory), never the host's projected status alone: a
// projection such as blocked/develop_redo_limit can sit over a raw unknown whose last
// call nobody proved stopped. Anything unresolved (raw unknown, a pending effect, an
// open review, a pending reconcile, an operator confirmation still due) stays in its
// original run. Shared by every batch kind that reschedules.
export function memberRescheduleAllowed(status,history){
  const raw=history?.state;
  return status?.state==='blocked'&&raw?.state==='blocked'&&history.pending==null
    &&!IN_RUN_ACTIONS.has(status.pendingAction)&&status.pendingAction!=='reconcile'
    &&status.developRedoRequired!==true&&status.reviewRedispatchStopRequired!==true;
}
// The member's raw journal replay, or null when it cannot be read or replayed.
export function memberRunHistory(specsDir,runId){
  try{
    const state=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',runId,'state.json'),'utf8'));
    const records=state.records;return readRunnerHistory(records,records[0].payload.config,records[0].payload.version);
  }catch{return null;}
}
// Whether an ordinary single-task supersede on the member's own worktree would be
// admitted, by the same entry conditions: reviewed-evidence-supersede takes only a raw
// blocked, cancelled, unknown or fixture_completed run with no pending effect; the
// external run guard such a launch takes (strictOnly, when a strict binding exists on
// the root) skips a non-strict prior run but refuses a strict one that is unknown or
// holds an unreconciled call, and a same-task prior run still in flight.
export function memberSupersedeAdmitted(specsDir,runId,history){
  if(!history?.state||history.pending||!['blocked','cancelled','unknown','fixture_completed'].includes(history.state.state))return false;
  let records;
  try{records=JSON.parse(fs.readFileSync(path.join(specsDir,'.reviews','.execution',runId,'state.json'),'utf8')).records;}catch{return false;}
  const runConfig=records[0]?.payload?.config;if(!runConfig)return false;
  if(!(runConfig.externalModels||runConfig.executionPolicy))return true;
  return strictPriorAttemptResolved(runConfig,history,records)&&sameTaskPriorAttemptResolved(history);
}
export function createCmAiBatch({configuration,executionFor,logHome,runtime='codex',checkCommands=null,checkTimeoutMs=60000,
  rerunUnknownQa=false,rerunBlockedQa=false,qaEnvironmentFailure=null,holdRevisions=[],bootstrapKeys=[],memberActions={},workflows=null}){
  const config=json(configuration);
  shape(config,['version','repositoryId','batchId','specsDir','codeProject','tasks',...['externalModels','executionPolicy','codeProjects','parallel','controlPolicy','memberDevelopment'].filter(name=>Object.hasOwn(config,name))]);
  const controlPolicy=config.controlPolicy?readControlPolicy(config.controlPolicy):null;
  need(config.version===1);id(config.repositoryId);id(config.batchId);need(config.batchId.length>=8);
  need(typeof executionFor==='function'&&typeof logHome==='string'&&path.isAbsolute(logHome));
  need(Array.isArray(config.tasks)&&config.tasks.length>0&&config.tasks.length<=256);
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  if(config.externalModels)readExternalModels(config.externalModels);
  if(config.executionPolicy)readExecutionPolicy(config.executionPolicy);
  const batchGit=(cwd,args,code)=>{
    if((config.externalModels||config.executionPolicy)&&args[0]==='add'&&args[1]==='-A')args=['add','-A','--','.',':!.cm-external-models-v1.json',':!.cm-model-config.lock'];
    if((config.externalModels||config.executionPolicy)&&args[0]==='worktree'&&args[1]==='remove'){
      const file=path.join(args[2],'.cm-external-models-v1.json');
      if(fs.existsSync(file)){
        need(digest(readModelJsonRecord(file).value)===digest({version:1,kind:'cm-external-code-binding',specsDir:config.specsDir}),'external_code_specs_conflict');
        const lock=path.join(args[2],'.cm-model-config.lock');
        if(fs.existsSync(lock)){const stat=fs.lstatSync(lock);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size===0&&(stat.mode&0o077)===0,'invalid_model_configuration_lock');fs.unlinkSync(lock);}
        fs.unlinkSync(file);
      }
    }
    const output=git(cwd,args,code);
    return (config.externalModels||config.executionPolicy)&&args[0]==='status'?output.split('\n').filter(line=>!['?? .cm-external-models-v1.json','?? .cm-model-config.lock'].includes(line)).join('\n'):output;
  };
  const plans=new Map();
  for(const task of config.tasks){
    shape(task,['feature','taskId','scope','requirements']);
    need(!plans.has(key(task)));const definition=validateRunDefinition({version:1,
      specsDir:config.specsDir,codeProject:config.codeProject,...(config.codeProjects?{codeProjects:config.codeProjects}:{}),feature:task.feature,
      identity:{repositoryId:config.repositoryId,runId:batchTaskRunId(config.batchId,key(task)),
        taskId:task.taskId,attempt:1},scope:task.scope,requirements:task.requirements});
    need(definition.specsDir===config.specsDir&&definition.codeProject===config.codeProject,'invalid_path');
    // A member that will be created is refused before the batch locks, logs or
    // prepares a worktree; an existing member keeps its own recovery path.
    if(!bootstrapKeys.includes(key(task))&&!fs.existsSync(path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json')))
      try{
        assertCreatableScope(definition.scope);
        // tasks.md is the authority for a task's files once it declares them.
        assertDeclaredScope(definition);
      }catch(error){error.reason=`${key(task)}: ${error.reason}`;throw error;}
    plans.set(key(task),definition);
  }
  // Tasks whose second-round answer is not written yet stop after a changes_requested review.
  need(Array.isArray(holdRevisions)&&holdRevisions.every(item=>plans.has(item)),'invalid_input');
  const held=new Set(holdRevisions);
  need(qaEnvironmentFailure===null||(rerunUnknownQa||rerunBlockedQa)&&typeof qaEnvironmentFailure==='string','qa_recovery_authorization_required');
  need(memberActions!==null&&typeof memberActions==='object'&&Object.keys(memberActions).every(name=>Object.hasOwn(BATCH_MEMBER_ACTIONS,name)
    &&Array.isArray(memberActions[name])&&memberActions[name].every(item=>plans.has(item))),'invalid_input');
  // One-shot per launch and member, like the single-task flags.
  const actionGrants=new Map(Object.keys(BATCH_MEMBER_ACTIONS).map(name=>[name,new Set(memberActions[name]??[])]));
  need(workflows===null||typeof workflows==='object'&&!Array.isArray(workflows),'invalid_input');
  const declared=!batchStarted({specsDir:config.specsDir,batchId:config.batchId});
  const groups=validateGroups(config,plans,{declared,workflows}),membership=new Map(groups.flatMap(group=>group.map(key=>[key,group])));
  validateMemberDevelopment(config,plans,groups,{declared});
  const originalMembership=new Map(membership),originalPlans=new Map(plans);
  // A one-member group (batch-plan.mjs worktree_all) is a task developed alone in its
  // own worktree. Unlike members developed alongside others it keeps the fixed N6
  // checkpoints: its QA may run in the worktree and must pass before it is merged.
  const soloMember=key=>originalMembership.get(key)?.length===1;
  // A member is ready to merge once its QA is deferred (skipped) or, for a one-member
  // group, skipped by the ordinary decision or triggered and passed.
  const memberQaSettled=(key,binding)=>{
    const qa=findCmAiQaDecision(binding);
    return qa?.status==='skipped'||soloMember(key)&&qa?.status==='triggered'&&latestCmAiQaRun(binding)?.status==='passed';
  };
  const first=plans.keys().next().value,planDigest=digest(config),log=path.join(config.specsDir,'运行日志.jsonl');
  const batchControlTarget=async(taskKey,state=progress())=>{
    const definition=plans.get(taskKey);need(definition,'batch_member_action_unavailable');
    if(membership.has(taskKey))bindWorktree(taskKey);
    const run=await open(taskKey);need(run.controlHost,'fingerprint_mismatch');
    try{
      const observed=await run.controlHost.handle({version:2,operation:'status',requestId:'control-preview',identity:definition.identity});
      return {version:2,batchId:config.batchId,taskKey,member:observed.controlTarget,
        batchDigest:digest({planDigest,rows:state.rows})};
    }finally{run.close();}
  };
  // Q26: before any closure check, close cleanup_failed QA command resources whose
  // journaled process group the host proves gone (qa-resource-release.mjs).
  let stillOpen=[];
  const inspectRunClosure=(file,runId)=>{
    const plan=[...plans.values()].find(item=>item.identity.runId===runId);stillOpen=[];
    if(plan)try{stillOpen=releaseVerifiedQaResources({specsDir:config.specsDir,codeProject:plan.codeProject,runId,runtime,logHome}).open;}
    catch(error){if(error?.code==='qa_resource_release_failed')throw error;}
    return inspectClosure(file,runId);
  };
  // R4: an open closure names what is still open and the exit, not a bare code.
  const requireClosed=runId=>{
    if(inspectRunClosure(log,runId).closed)return;
    const listed=stillOpen.map(row=>`${row.resourceId}（${row.phase}，${row.verdict==='alive'?'进程组仍在':row.verdict==='unrecorded'?'没有记录进程身份':'无法核实'}）`);
    throw Object.assign(new Error('batch_resources_open'),{code:'batch_resources_open',
      reason:`成员运行 ${runId} 的 QA 资源或测试轮次尚未闭合${listed.length?`：${listed.join('、')}`:''}。宿主只在 cleanup_failed 记录了进程组且核实已退出时自动补记 released；先确认这些 QA 命令进程已退出，再从批次入口 advance。`});
  };
  let active=null,busy=false,cancelled=false,liveKey=first;
  const executions=new Map(),members=new Map();
  let releaseLock=null,completeTail=Promise.resolve();
  async function executionForKey(taskKey){
    if(!executions.has(taskKey)){
      const execution=await executionFor(json(plans.get(taskKey)),{parallelMember:membership.has(taskKey),
        ...(membership.has(taskKey)&&soloMember(taskKey)?{soloMember:true}:{})});
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
        &&['batch_start','batch_task_committed','batch_handoff','batch_cancel','batch_member_ready','batch_member_blocked','batch_merge_conflict','batch_merge_started','batch_merge_blocked','batch_member_qa_failed'].includes(row.phase))rows.push(row);
    });
    if(groups.length)return parallelProgress(rows);
    let current=first,stopped=false;const seen=new Set();
    for(const [index,row] of rows.entries()){
      need(row.schema_version===1&&row.repository_id===config.repositoryId
        &&row.plan_digest===planDigest,'batch_plan_mismatch');
      need(!stopped&&row.from_key===current,'batch_history_invalid');
      if(row.phase==='batch_start'){need(index===0,'batch_history_invalid');continue;}
      need(index>0&&rows[0].phase==='batch_start','batch_history_invalid');
      if(row.phase==='batch_task_committed'){
        need(typeof row.task_commit==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.task_commit),'batch_history_invalid');continue;
      }
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
        phase==='batch_start'?'Approved task batch started':phase==='batch_member_blocked'?'Preserve member WIP and reschedule serial generation 2':phase,
      '--data-json',JSON.stringify({repository_id:config.repositoryId,plan_digest:planDigest,...data})],
    {timeout:10000,maxBuffer:1024*1024,encoding:'utf8',env:{...process.env,CM_WORKFLOW_LOG_HOME:logHome}});
    need(!result.error&&result.status===0&&result.signal===null,'batch_log_failed');
    const receipt=JSON.parse(result.stdout);need(receipt.run_id===config.batchId,'batch_log_failed');
  }
  async function open(taskKey,permission={}){
    const definition=plans.get(taskKey),state=path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json');
    const mode=fs.existsSync(state)?'resume':'create',execution=await executionForKey(taskKey);
    // QA recovery is rejected outright for a created run or one without a QA
    // executor. Passing it to every task would take down the unrelated ones, so
    // only the tasks the flag can legally apply to receive it.
    const recovery=mode==='resume'&&execution?.qaExecutor&&(rerunUnknownQa||rerunBlockedQa)
      ? {rerunUnknownQa,rerunBlockedQa,...(qaEnvironmentFailure===null?{}:{qaEnvironmentFailure})} : {};
    // Q24: a forwarded recovery operation opens the member with exactly its one permission.
    need(mode==='resume'||!Object.keys(permission).length,'batch_member_action_unavailable');
    const run=await openControlRun(definition,mode,execution,{...recovery,...permission,...(held.has(taskKey)?{holdRevision:true}:{}),
      ...(membership.has(taskKey)?{parallelSelection:{version:1,group:membership.get(taskKey).map(key=>plans.get(key).identity.taskId)}}:{})});
    if(!run.host)return run;
    const decorate=host=>({...host,handle:async request=>batchMemberResult(await host.handle(request),
      {parallel:membership.has(taskKey),taskKey,protocol:controlPolicy?'v2':'legacy'})});
    return {...run,host:decorate(run.host),...(run.controlHost?{controlHost:decorate(run.controlHost)}:{})};
  }
  function parallelProgress(rows){
    const done=new Set(),ready=new Map(),merging=new Map(),blocked=new Map();let stopped=false,code=null;
    for(const [index,row] of rows.entries()){
      need(row.schema_version===1&&row.repository_id===config.repositoryId&&row.plan_digest===planDigest,'batch_plan_mismatch');
      need(!stopped&&plans.has(row.from_key),'batch_history_invalid');
      if(row.phase==='batch_start'){need(index===0,'batch_history_invalid');continue;}
      need(index>0&&rows[0].phase==='batch_start','batch_history_invalid');
      if(row.phase==='batch_task_committed'){
        need(typeof row.task_commit==='string'&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(row.task_commit),'batch_history_invalid');continue;
      }
      if(row.phase==='batch_cancel'){stopped=true;code='cancelled';continue;}
      if(['batch_merge_conflict','batch_merge_blocked'].includes(row.phase)){stopped=true;code=row.code;continue;}
      if(row.phase==='batch_member_qa_failed'){
        need(soloMember(row.from_key)&&!done.has(row.from_key)&&!ready.has(row.from_key)&&row.code==='batch_solo_qa_failed','batch_history_invalid');
        const expected=location(row.from_key);
        need(row.worktree===expected.worktree&&row.branch===expected.branch,'batch_history_invalid');
        stopped=true;code=row.code;continue;
      }
      if(row.phase==='batch_member_blocked'){
        need(originalMembership.has(row.from_key)&&!done.has(row.from_key)&&!ready.has(row.from_key)
          &&!blocked.has(row.from_key)&&row.generation===2,'batch_history_invalid');
        const expected=location(row.from_key);
        need(row.worktree===expected.worktree&&row.branch===expected.branch
          &&typeof row.code==='string'&&row.code.length>0&&typeof row.reason==='string','batch_history_invalid');
        blocked.set(row.from_key,row);continue;
      }
      if(row.phase==='batch_member_ready'){
        need(originalMembership.has(row.from_key)&&!blocked.has(row.from_key)&&!ready.has(row.from_key),'batch_history_invalid');
        hex(row.checkpoint);hex(row.package_digest);ready.set(row.from_key,row);continue;
      }
      if(row.phase==='batch_merge_started'){
        need(ready.has(row.from_key)&&!merging.has(row.from_key),'batch_history_invalid');merging.set(row.from_key,row);continue;
      }
      need(!done.has(row.from_key),'batch_history_invalid');hex(row.checkpoint);hex(row.package_digest);
      if(originalMembership.has(row.from_key)&&!blocked.has(row.from_key))need(ready.has(row.from_key)&&merging.has(row.from_key),'batch_history_invalid');
      done.add(row.from_key);
      need(row.to_key===[...plans.keys()].find(key=>!done.has(key)),'batch_history_invalid');
    }
    // The durable decision is authoritative for both the live driver and resume.
    for(const key of blocked.keys())if(membership.has(key)){
      const definition=originalPlans.get(key);
      plans.set(key,validateRunDefinition({...definition,identity:{...definition.identity,
        runId:`task-${digest({batchId:config.batchId,task:key,generation:2}).slice(0,48)}`}}));
      membership.delete(key);executions.delete(key);
    }
    return {rows,current:[...plans.keys()].find(key=>!done.has(key)),stopped,code,done,ready,merging,blocked};
  }
  // The batch prefix goes into the branch as well, not only into the worktree path.
  // A blocked member keeps its branch on purpose (its WIP is evidence), and without a
  // per-batch segment that name would block every later batch touching the same task.
  // It is the second segment rather than a suffix: refs/heads/cm/work/T-001 and
  // refs/heads/cm/work/T-001/<batch> cannot coexist, so a suffix would still collide
  // with branches left by earlier versions. Git rejects ".." and a trailing dot in a
  // ref component while batchId allows dots, so the segment normalises them.
  // batch-location.mjs: a new batch records a segment from its full id in
  // batch_start; one that started without it keeps the old 8-character prefix.
  let segments=null;
  const memberSegments=()=>segments??=batchSegments({specsDir:config.specsDir,batchId:config.batchId});
  const location=key=>{const definition=plans.get(key),current=memberSegments();return {
    worktree:batchMemberWorktree({codeProject:config.codeProject,segments:current,taskId:definition.identity.taskId}),
    branch:batchMemberBranch({segments:current,feature:definition.feature,taskId:definition.identity.taskId})};};
  function verifyMerged(row){
    const definition=plans.get(row.from_key),state=JSON.parse(fs.readFileSync(path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json'),'utf8'));
    const {revision,...body}=state;
    need(revision===row.checkpoint&&digest(body)===revision,'batch_checkpoint_mismatch');
    const binding={specsDir:config.specsDir,feature:definition.feature,identity:row.identity,packageDigest:row.package_digest};
    need(memberQaSettled(row.from_key,binding)&&inspectRunClosure(log,definition.identity.runId).closed,'batch_qa_not_ready');
    batchGit(config.codeProject,['merge-base','--is-ancestor',row.merge_commit,'HEAD'],'batch_merge_history_changed');
  }
  function prepareGroup(group){
    const state=progress(),remaining=group.filter(key=>membership.has(key)&&!state.done.has(key));
    // Members may edit existing files. The group validator already requires
    // pairwise-disjoint scopes and no dependency path, so members never write the
    // same path; merges stay serial and a git conflict still stops as
    // merge_conflict. The earlier create-only rule (#59, #187) existed because a
    // task's scope was then guessed by the session; it now comes from the batch
    // definition the scheduler validates.
    for(const key of remaining){
      const {worktree,branch}=location(key);
      if(!fs.existsSync(worktree)){
        need(!state.ready.has(key),'batch_worktree_missing');
        // A branch left without its worktree (a cleanup stopped between removing the
        // worktree and deleting the branch) is deleted only when it holds nothing beyond
        // the main checkout's HEAD (`branch -d`, never -D); one with its own commits is
        // somebody's work and stops the batch.
        if(branchExists(branch)){
          if(batchGit(config.codeProject,['rev-list',`HEAD..refs/heads/${branch}`])!=='')return memberBranchExists(key,branch);
          batchGit(config.codeProject,['branch','-d',branch],'batch_worktree_failed');
        }
        fs.mkdirSync(path.dirname(worktree),{recursive:true});
        batchGit(config.codeProject,['worktree','add','-b',branch,worktree,'HEAD'],'batch_worktree_failed');
      }
      need(batchGit(worktree,['branch','--show-current'])===branch,'batch_worktree_mismatch');
      plans.set(key,worktreeDefinition(key));
    }
    // One remaining member (a one-member group, or the rest after a partial merge) is the
    // only writer: the main checkout just waits to merge it and may be detached.
    const assignments=remaining.map(key=>`${plans.get(key).identity.taskId}=${location(key).worktree}`);
    if(assignments.length===1)checkSoloWrite({repo:config.codeProject,assignment:assignments[0]});
    else if(assignments.length)checkParallelWrite({repo:config.codeProject,assignment:assignments});
    // A one-member group decides and runs its own QA in its worktree, which reloads the
    // project configuration there. The planner's blob check is only a pre-filter (a
    // checkout filter or a second config file hidden in the main checkout pass it), so
    // the effective configurations both checkouts actually load are compared here,
    // after the worktree exists and before any develop dispatch.
    for(const key of remaining.filter(key=>soloMember(key)&&!state.ready.has(key))){
      const diverged=memberConfigDivergence(key);if(!diverged)continue;
      // Review r6: the batch never deletes the worktree or its branch here. Index flags
      // (assume-unchanged, skip-worktree) can hide work from `git status`, so no check
      // proves the directory holds nothing to keep; the operator cleans up by hand. While
      // the worktree stays, every advance reuses it and compares again.
      const {worktree,branch}=location(key);
      const cleanup=`确认 worktree ${worktree} 里没有要保留的内容后手动清理：${manualCleanupCommands({repo:config.codeProject,worktree,branch}).join('；')}（不要加 --force 或 -D，Git 拒绝时说明还有改动或独有提交，先处理）`;
      const nextStep=`${cleanup}；然后让主目录与 worktree 加载出同一份项目配置（取消改写配置的 Git 检出过滤器、删掉多余的配置文件并提交、去掉藏起本地改动的 skip-worktree/assume-unchanged），再对本批次 advance；`
        +`或在项目配置里设 parallel.worktree_all: false，剩余任务用 cm-ai-batch-plan.mjs 以新的批次 ID 重新生成批次`;
      return Object.freeze({outcome:'blocked',state:'blocked',code:'batch_member_config_diverged',batchId:config.batchId,currentTask:key,
        reason:`任务 ${key} 单独在 worktree 里开发，但 ${diverged}；QA 会按另一套配置执行，所以不开发。批次不删除该 worktree 与分支 ${branch}。出口：${nextStep}。`,
        guidance:stopGuidance(`任务 ${key} 的 worktree 与主目录加载出的项目配置不一致，未开发；worktree 与分支保留。`,`${nextStep}。`,
          ['以 worktree 建好后两边实际加载的配置为准','主目录与已完成的任务不受影响','批次不会代为删除 worktree 或分支；worktree 还在时，下次 advance 会复用它并重新比对配置'])});
    }
    return null;
  }
  function branchExists(branch){
    return spawnSync('git',['-C',config.codeProject,'rev-parse','--verify','--quiet',`refs/heads/${branch}`],gitOptions()).status===0;
  }
  function memberBranchExists(key,branch){
    const nextStep=`核对分支 ${branch} 上的提交：要保留就合并或另存，不要就在确认后自行删除；然后对本批次 advance`;
    return Object.freeze({outcome:'blocked',state:'blocked',code:'batch_member_branch_exists',batchId:config.batchId,currentTask:key,
      reason:`任务 ${key} 的成员分支 ${branch} 已存在且有主目录 HEAD 以外的提交，但对应的 worktree 不在；批次不删除它，也不在它上面开发。出口：${nextStep}。`,
      guidance:stopGuidance(`任务 ${key} 的成员分支已存在且有独有提交，批次停下。`,`${nextStep}。`,['批次不会代为删除有独有提交的分支'])});
  }
  // Both checkouts' effective configurations, loaded the way QA and the browser check
  // load them (loadConfig). A reason, or null when they are the same.
  function memberConfigDivergence(key){
    const load=root=>{try{return {value:digest(json(loadConfig({projectRoot:root})))};}catch(error){return {error:error.message??String(error)};}};
    const main=load(config.codeProject),member=load(location(key).worktree);
    if(main.error)return `主目录的项目配置无法加载（${main.error}）`;
    if(member.error)return `worktree 里的项目配置无法加载（${member.error}）`;
    return main.value===member.value?null:'worktree 与主目录加载出的有效配置不同';
  }
  function preserveBlockedMember(row){
    const {worktree,branch}=location(row.from_key);
    need(row.worktree===worktree&&row.branch===branch,'batch_worktree_mismatch');
    batchGit(config.codeProject,['rev-parse','--verify',`refs/heads/${branch}`],'batch_worktree_missing');
    if(!fs.existsSync(worktree))return;
    need(batchGit(worktree,['branch','--show-current'])===branch,'batch_worktree_mismatch');
    commitChanges(worktree,taskCommitArgs(plans.get(row.from_key).identity.taskId,taskDescription(config,plans.get(row.from_key)),row.code,row.reason));
    batchGit(config.codeProject,['worktree','remove',worktree]);
    // Keep the branch: its WIP is evidence, not approved code to merge.
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
      // A one-member group runs the whole task lifecycle like a serial task, in its
      // worktree: N6 decides with the fixed checkpoints and a triggered QA runs (and
      // must pass) here, before the member is sealed and merged. A failed or blocked
      // QA leaves the member unready, so the batch stops without merging it.
      if(soloMember(key))status=await call('advance');
      else for(let round=status.identity.attempt;round<=2;round++){
        if(status.code===null&&['ready','changes_requested'].includes(status.state)
          ||developmentRetryable(status))await call('start');
        if(['reported','advanced'].includes(status.outcome)&&(status.code===null&&status.state==='awaiting_review'
          ||reviewRetryable(status)))await call('decision');
        if(status.outcome==='advanced'&&status.code===null&&status.state==='changes_requested'&&status.identity.attempt===round+1)continue;
        if(['reported','advanced'].includes(status.outcome)
          &&(status.code===null&&status.state==='approved'||completionRetryable(status))){
          const completion=completeTail.then(()=>call('complete'));
          completeTail=completion.then(()=>{},()=>{});await completion;
        }
        break;
      }
      if(!soloMember(key)&&status.state==='fixture_completed'&&status.code===null){
        await call('qa');
        if(status.code==='qa_skipped')await call('context_refresh',{testRunId:null});
      }
      if(status.outcome!=='refreshed'||status.pendingAction!=='start_next_task')return status;
      requireClosed(plans.get(key).identity.runId);
      record('batch_member_ready',{from_key:key,checkpoint:run.checkpoint(),package_digest:status.packageDigest,
        identity:status.identity,...location(key)});
      return null;
    }finally{members.delete(key);run.close();}
  }
  // Verify a ready member's completed, QA-deferred delivery and commit it on its
  // branch. Idempotent: an already committed worktree gets no new commit.
  async function sealMember(row,commit=true){
    const key=row.from_key,{worktree,branch}=location(key);
    need(row.worktree===worktree&&row.branch===branch,'batch_worktree_mismatch');
    // A stopped batch replays without preparing its group: bind the member root here.
    if(plans.get(key).codeProject!==worktree)bindWorktree(key);
    // Reopen the unchanged member root to verify its actual completion and QA.
    const run=await open(key);
    try{
      need(!run.blocked&&run.checkpoint()===row.checkpoint,'batch_checkpoint_mismatch');
      const status=await run.host.handle({version:1,operation:'status',requestId:'batch-merge-status',identity:row.identity});
      need(status.state==='fixture_completed'&&status.code===null&&status.packageDigest===row.package_digest,'batch_checkpoint_mismatch');
      need(memberQaSettled(key,{specsDir:config.specsDir,feature:plans.get(key).feature,
        identity:row.identity,packageDigest:row.package_digest}),'batch_qa_not_ready');
    }finally{run.close();}
    if(!commit)return;
    batchGit(worktree,['add','-A']);
    if(batchGit(worktree,['status','--porcelain']))batchGit(worktree,['commit',...taskCommitArgs(plans.get(key).identity.taskId,taskDescription(config,plans.get(key)))]);
  }
  // Every member that finished and is not merged yet, in task order.
  const readyUnmerged=()=>{const state=progress();return [...plans.keys()].filter(key=>state.ready.has(key)&&!state.done.has(key));};
  // Seal each such member for the conflict guidance. A member that fails its check
  // stays unsealed and is named; the conflict itself is still returned.
  async function sealForGuidance(){
    const unsealed=[];
    for(const key of readyUnmerged()){
      try{await sealMember(progress().ready.get(key));}catch(cause){unsealed.push({taskKey:key,code:cause?.code??'batch_seal_failed'});}
    }
    return unsealed;
  }
  // status checks nothing and runs nothing: an empty Git status does not prove a
  // reviewed delivery is on its branch, and Git may run configured programs. Every
  // unmerged member is reported unverified; advance seals them and answers again.
  const unsealedReadOnly=()=>readyUnmerged().map(key=>({taskKey:key,code:'batch_seal_unverified'}));
  async function mergeMember(row){
    const key=row.from_key,{worktree,branch}=location(key);
    let intent=progress().merging.get(key);
    // A logged merge intent already names the member commit.
    await sealMember(row,!intent);
    if(!intent){
      need(batchGit(config.codeProject,['status','--porcelain'])==='','batch_main_dirty');
      intent={from_key:key,expected_old:batchGit(config.codeProject,['rev-parse','HEAD']),member_commit:batchGit(worktree,['rev-parse','HEAD'])};
      record('batch_merge_started',intent);
    }
    const current=batchGit(config.codeProject,['rev-parse','HEAD']);
    if(current===intent.expected_old){
      const restore=unionAttributes(config.codeProject);
      let result;
      try{result=spawnSync('git',['-C',config.codeProject,'merge','--no-ff','--no-edit',intent.member_commit],gitOptions());}
      finally{restore();}
      if(result.error||result.status!==0){
        const files=batchGit(config.codeProject,['diff','--name-only','--diff-filter=U']).split('\n').filter(Boolean);
        batchGit(config.codeProject,['merge','--abort'],'batch_merge_abort_failed');
        need(batchGit(config.codeProject,['rev-parse','HEAD'])===intent.expected_old,'batch_merge_history_changed');
        record('batch_merge_conflict',{from_key:key,code:'merge_conflict',files,expected_old:intent.expected_old});
        // The guidance has the operator merge every unmerged member's branch: commit
        // each reviewed delivery there first, or its branch would merge as up to date.
        const unsealed=await sealForGuidance();
        return {outcome:'blocked',code:'merge_conflict',batchId:config.batchId,files,...(unsealed.length?{unsealed}:{}),guidance:mergeConflictGuidance(key,files,unsealed)};
      }
    }else{
      // A crash may happen after Git commits but before the handoff log append.
      const parents=batchGit(config.codeProject,['show','-s','--format=%P','HEAD']).split(' ');
      need(parents.length===2&&parents[0]===intent.expected_old&&parents[1]===intent.member_commit,'batch_merge_history_changed');
    }
    const merge_commit=batchGit(config.codeProject,['rev-parse','HEAD']);
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
    batchGit(config.codeProject,['worktree','remove',worktree]);batchGit(config.codeProject,['branch','-d',branch]);
    return null;
  }
  async function parallelGroup(group,request){
    const initial=progress();
    if(request.operation==='status')return {outcome:'reported',state:'parallel',batchId:config.batchId,
      ready:group.filter(key=>initial.ready.has(key)),merged:group.filter(key=>initial.done.has(key))};
    if(!initial.rows.length)record('batch_start',{from_key:liveKey,[BATCH_SEGMENT_FIELD]:batchSegment(config.batchId)});
    if(request.operation==='cancel'){record('batch_cancel',{from_key:liveKey});return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};}
    const prepared=prepareGroup(group);if(prepared)return prepared;
    // Resolve every member's actual worktree preflight before any start dispatch.
    for(const key of group.filter(key=>membership.has(key)&&!initial.done.has(key))){
      try{await executionForKey(key);}catch(cause){
        if(cause.code!=='review_preflight_failed')throw cause;
        return {outcome:'blocked',state:'blocked',code:'review_preflight_failed',batchId:config.batchId,
          currentTask:key,identity:plans.get(key).identity};
      }
    }
    need(!cancelled,'cancelled');
    const pending=group.filter(key=>membership.has(key)&&!initial.ready.has(key)&&!initial.done.has(key));
    const results=await Promise.allSettled(pending.map(key=>driveMember(key,request)));
    if(cancelled)return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};
    // Classify every member result before merging: a member rescheduled to a serial
    // second generation is the only one a later member may merge ahead of.
    const decisions=results.map((result,index)=>{
      if(result.status==='rejected')return {kind:'rejected',reason:result.reason};
      const status=result.value;if(!status)return {kind:'none'};
      // Retryable validation, review transport and completed-task QA stay on
      // their existing recovery path; a new run must not bypass those gates.
      const terminal=['blocked','failed','unknown'].includes(status.state)
        &&!developmentRetryable(status)&&!completionRetryable(status)
        ||status.state==='pending_review'&&status.code!==null&&!reviewRetryable(status);
      const key=pending[index];
      // The safety net (batch-plan.mjs keeps tasks that could trigger QA out of one-member
      // groups): a one-member group whose own QA really failed has no QA repair path in a
      // batch. It is not merged; the batch stops with its delivery committed on its branch.
      if(soloMember(key)&&status.state==='fixture_completed'&&status.code==='qa_failed')return {kind:'qa_failed',key,status};
      if(!terminal)return {kind:'waiting',status};
      // Q25: a member that can still be resolved in its own run (original-invocation
      // receipts, interrupted effect, a redo awaiting stop confirmation) keeps its
      // worktree and stops with the batch operation named; an unconfirmed one stays
      // in its run with an explicit stop; only a raw checkpointed blocked terminal is
      // rescheduled serially. Ordinary batches follow the same rules (they used to
      // reschedule every terminal, unknown included, and develop gen 2 at once).
      if(IN_RUN_ACTIONS.has(status.pendingAction))return {kind:'recoverable',key,status};
      const history=memberRunHistory(config.specsDir,plans.get(key).identity.runId);
      if(!memberRescheduleAllowed(status,history))return {kind:'unresolved',key,status,history};
      return {kind:'reschedule',key,status};
    });
    const skipped=new Set([...progress().blocked.keys(),...decisions.filter(item=>item.kind==='reschedule').map(item=>item.key)]);
    // A merge an earlier process started (its intent is logged, its handoff is
    // not) is finished first: it may already be in Git. The rest merge in task
    // order, not completion order: a later member waits while an earlier one is
    // still unfinished (retrying, recovering, stopped), except one rescheduled to a
    // serial second generation, which is redone on top of the merged result.
    const unfinished=[...progress().merging.keys()].filter(key=>group.includes(key)&&!progress().done.has(key));
    for(const key of [...unfinished,...[...plans.keys()].filter(key=>group.includes(key)&&!unfinished.includes(key))]){
      if(progress().done.has(key))continue;
      const row=progress().ready.get(key);
      if(!row){if(skipped.has(key))continue;break;}
      const result=await mergeMember(row);if(result)return result;
    }
    let waiting=null,rejected=null,recoverable=null,unresolved=null;const rescheduled=[];
    for(const decision of decisions){
      if(decision.kind==='rejected'){rejected??=decision.reason;continue;}
      if(decision.kind==='waiting'){waiting??=decision.status;continue;}
      if(decision.kind==='recoverable'){recoverable??={key:decision.key,status:decision.status};continue;}
      if(decision.kind==='unresolved'){const {key,status,history}=decision;
        unresolved??={key,status,history,raw:history?.state?`${history.state.state}/${history.state.code??history.state.state}`:'unreadable'};continue;}
      if(decision.kind!=='reschedule')continue;
      const {key,status}=decision;
      rescheduled.push(key);
      record('batch_member_blocked',{from_key:key,code:status.code??status.state,
        reason:status.blockedReason??status.reason??status.code??status.state,...location(key),generation:2});
    }
    // Log before Git mutation so a crash during WIP commit/removal is resumable.
    for(const row of progress().blocked.values())preserveBlockedMember(row);
    if(rejected)throw rejected;
    const qaFailed=decisions.find(decision=>decision.kind==='qa_failed');
    if(qaFailed){
      // Committed before the stop is logged: a crash in between re-drives the member to
      // the same recorded failure and commits nothing new.
      commitSoloDelivery(qaFailed.key,qaFailed.status);
      const row={from_key:qaFailed.key,code:'batch_solo_qa_failed',...location(qaFailed.key)};
      record('batch_member_qa_failed',row);
      return soloQaFailedStop(row);
    }
    if(recoverable)return parallelRecoveryRequired(recoverable.key,recoverable.status);
    if(unresolved)return parallelMemberUnresolved(unresolved.key,unresolved.status,unresolved.raw,unresolved.history);
    // The second generation is a new run: stop here so the next advance (and its
    // driver) prepares that run's answers before anything is dispatched to it.
    if(rescheduled.length)return parallelMemberRescheduled(rescheduled);
    if(waiting)return {...waiting,batchId:config.batchId};
    return null;
  }
  // The member's reviewed, completed delivery, committed on its branch so the operator
  // can merge it; only the recorded QA failure kept it from the ordinary seal.
  function commitSoloDelivery(key,status){
    const {worktree,branch}=location(key),definition=plans.get(key);
    need(definition.codeProject===worktree&&fs.existsSync(worktree)&&batchGit(worktree,['branch','--show-current'])===branch,'batch_worktree_mismatch');
    const qa=findCmAiQaDecision({specsDir:config.specsDir,feature:definition.feature,identity:status.identity,packageDigest:status.packageDigest});
    need(qa?.status==='triggered'&&latestCmAiQaRun({specsDir:config.specsDir,feature:definition.feature,identity:status.identity,
      packageDigest:status.packageDigest})?.status==='failed','batch_qa_not_ready');
    batchGit(worktree,['add','-A']);
    if(batchGit(worktree,['status','--porcelain']))batchGit(worktree,['commit',...taskCommitArgs(definition.identity.taskId,taskDescription(config,definition))]);
  }
  function soloQaFailedStop(row){
    const {from_key:key,worktree,branch}=row;
    const nextStep=`在主目录 git merge --no-ff ${branch}（工作树 ${worktree}，分支上已提交该任务的已审交付）；`
      +`再用 /cm-fix 按该任务最新一轮 QA 报告（specs 的 .reviews/ 下）复现并修复，修复照常经过独立审查与回归；`
      +`然后删除该工作树与分支；剩余任务用 cm-ai-batch-plan.mjs 以新的批次 ID 重新生成批次继续，功能最后一个任务会重跑整个功能的 QA。`;
    return Object.freeze({outcome:'blocked',state:'blocked',code:'batch_solo_qa_failed',batchId:config.batchId,currentTask:key,
      reason:`单独在 worktree 里开发的任务 ${key} 自己的 QA 未通过；批次没有 QA 修复出口，不合并它，批次停止，主目录未改动。出口：${nextStep}`,
      guidance:stopGuidance(`任务 ${key} 在自己的 worktree 里 QA 未通过；批次不合并它并已停止，主目录未改动。`,nextStep,
        ['该任务已审查通过并在 tasks.md 记为完成，新批次会跳过它；不合并就会缺代码','合并进来的代码有已知 QA 失败，修复并通过 QA 前不要发布',
          '原批次不会再推进；之后每次 advance 只重复本指引'])});
  }
  const stopGuidance=(summary,nextStep,prerequisites)=>Object.freeze({summary,nextStep,recoveryOperation:null,
    prerequisites:Object.freeze(prerequisites),authorizationGranted:false});
  // Review 2026-10-27 round 1 (P3): a batch that ends on a detached main checkout leaves its
  // merges only on that commit (member branches are deleted). The finished result names the
  // commit and how to keep it; the batch never creates or switches a branch itself.
  function withDetachedSave(value){
    if(batchGit(config.codeProject,['branch','--show-current'])!=='')return value;
    const head=batchGit(config.codeProject,['rev-parse','HEAD']);
    const note=`主目录停在 detached HEAD（提交 ${head.slice(0,12)}），本批次的结果只在这个提交上：要保留就在主目录运行 git switch -c <新分支名>`;
    const guidance=value.guidance?Object.freeze({...value.guidance,prerequisites:Object.freeze([...(value.guidance.prerequisites??[]).slice(0,7),note])})
      :stopGuidance('本批次已全部完成。',note,[]);
    return {...value,detachedHead:head,guidance};
  }
  // A member whose reviewed, completed delivery does not merge (members never share a
  // scope file, so this is a file outside every scope). The batch stays stopped; the
  // operator merges by hand and plans the rest as a new batch. Redoing the task
  // serially would mean reopening a completed, reviewed task, which is not automatic.
  // Every member that finished and is not merged yet is listed, the conflicted one
  // included, in task order: each is marked complete in tasks.md, so a new plan
  // would skip it, and its code exists only on its branch (committed there before
  // the guidance is given).
  const mergeConflictGuidance=(key,files,unsealed=[])=>{
    const listed=Array.isArray(files)&&files.length?files.join('、'):'（Git 未列出）';
    const pending=readyUnmerged();
    if(!pending.includes(key))pending.push(key);
    const steps=pending.map(item=>{const {worktree,branch}=location(item);return `${item}：git merge --no-ff ${branch}（工作树 ${worktree}）`;});
    return stopGuidance(`并行成员 ${key} 的已审交付与已合并的结果在 ${listed} 上冲突；合并已撤销，主目录未改动，批次停止。`,
      `在主目录按任务顺序手动合并这些已完成未合并的成员分支：${steps.join('；')}；解决冲突后跑项目检查再提交；`
        +`然后删除这些成员工作树与分支；剩余任务用 cm-ai-batch-plan.mjs 以新的批次 ID 重新生成批次继续。`,
      [...(unsealed.length?[`以下成员的交付尚未确认提交到分支，分支里可能没有代码：${unsealed.map(item=>`${item.taskKey}（${item.code}）`).join('、')}。`
          +'先恢复缺失的工作树，再对本批次 advance 一次：它只核对并提交这些交付、重新给出本指引；这里不再列出后才能合并和清理']:[]),
        '这些任务已审查通过并在 tasks.md 记为完成，合入的是它们的已审代码；新批次会跳过它们，漏合就会缺代码',
        '合并后的组合没有经过审查，提交前必须跑项目检查','原批次不会再推进；advance 只会补提交并重复本指引']);
  };
  // reconcile_review exists only for external-model or execution-policy runs.
  const batchKind=strict=>strict?'外部模型或执行策略批次':'批次';
  // Name only exits whose entry conditions accept this member. Recoverable pendingActions
  // (develop_redo, abandon_*, an available reconcile_review) never reach here
  // (parallelRecoveryRequired); original-call reconciliation that is not available now
  // cannot become available later, so it is not offered. Supersede is offered only when
  // memberSupersedeAdmitted says the supersede check and the external run guard pass.
  // The member's own bounded diagnostic classes, kept when the batch rebuilds a stop
  // around a member result (drivers and notices act on them, never on reason text).
  const memberDiagnostics=status=>Object.freeze({
    ...(typeof status?.reviewFailure==='string'&&/^reviewer_[a-z_]{1,48}$/.test(status.reviewFailure)?{reviewFailure:status.reviewFailure}:{}),
    ...(typeof status?.developFailure==='string'&&/^developer_[a-z_]{1,48}$/.test(status.developFailure)?{developFailure:status.developFailure}:{})});
  function parallelMemberUnresolved(key,status,raw,history){
    const strict=Boolean(config.externalModels||config.executionPolicy),runId=plans.get(key).identity.runId;
    const supersedable=memberSupersedeAdmitted(config.specsDir,runId,history);
    const original=status.reviewReconciliation?`（原调用 invocationId ${status.reviewReconciliation.invocationId}${status.reviewReconciliation.providerThreadId?`、providerThreadId ${status.reviewReconciliation.providerThreadId}`:''}）`:'';
    const why=!history?.state?'原运行存档无法读取'
      :history.pending?`原运行仍有在途 ${history.pending.kind} effect`
      :!['blocked','cancelled','unknown','fixture_completed'].includes(history.state.state)?`supersede 不接受原始状态 ${raw}`
      :`外部运行守卫会拒绝在这个代码根上新建运行（原严格运行仍为 ${raw} 或有未对账的调用），原调用对账也不可用`;
    const exit=`只读核对 ${key} 原运行的记录、进程与 worktree（${location(key).worktree}）；`
      +(controlPolicy?'v2 不支持作废旧证据后新建运行；保留原批次、运行与 worktree，核对原调用与 reason 后交由维护者处理，不改走旧入口'
        :supersedable?`确认旧宿主与该成员的会话或子进程已停止写入后，取消本批次，还原该任务已改动的代码，用单任务宿主 cm-ai-host.mjs（不加 --external-models、--execution-optimizations）以该 worktree 为代码根、--supersede-reviewed-evidence --supersede-reason 原因 新建运行重做该任务`
        :`批次与单任务宿主目前都没有能处理它的操作：${why}${original}。保留批次、原运行和 worktree，不要取消批次或手改存档，把 rawState 与本 reason 交给维护者处理`);
    return Object.freeze({outcome:'blocked',state:'blocked',code:'batch_parallel_member_unresolved',batchId:config.batchId,
      currentTask:key,identity:status.identity,memberState:status.state,memberCode:status.code??null,pendingAction:status.pendingAction??null,
      ...memberDiagnostics(status),
      rawState:raw,
      reason:`${batchKind(strict)}的并行成员 ${key} 停在 ${status.state}/${status.code??status.state}（原始存档状态 ${raw}），结果尚未确认、写入方未证明已停或审查尚未终结，不改排串行（改排会换 runId、从 attempt 1 重派，绕过原调用对账与写入方停止证明）。出口：${exit}。`,
      guidance:stopGuidance('并行成员结果未确认，批次不会自动改排或重派。',`${exit}。`,
        ['不新建第二代运行，不删除该成员 worktree','先确认旧宿主与该成员的会话或子进程已停止写入'])});
  }
  function parallelMemberRescheduled(keys){
    const list=keys.join('、');
    return Object.freeze({outcome:'blocked',state:'blocked',code:'batch_member_rescheduled',batchId:config.batchId,
      currentTask:keys[0],rescheduled:Object.freeze([...keys]),
      reason:`并行成员 ${list} 已在 blocked/failed 终态存档，已改排为串行第二代（新运行、从 attempt 1 开始，WIP 留在原分支）。本次 advance 到此为止，不在同一次里开发第二代；下一次 advance 先预检第二代的开发答案再开发。`,
      guidance:stopGuidance('并行成员已改排为串行第二代，等待下一次 advance。',
        `按 WIP 分支与 reason 准备 ${list} 第二代的开发答案（answers/<feature>/<task>/develop.json，从第 1 轮开始），再从批次入口 advance。`,
        ['第二代是新运行，旧运行记录与 WIP 分支保留','开发与审查仍需原合同授权'])});
  }
  function parallelRecoveryRequired(key,status){
    const action=status.pendingAction,grant=BATCH_MEMBER_ACTIONS[action];
    const exit=controlPolicy
      ?`从原批次入口只读 status，展示并核对完整批次 controlTarget，按当前对话的具体决定固定为 expectedControl；发送 version:2 的批次操作 ${action}（taskKey ${key}、${action==='reconcile_review'?'原调用 invocationId':'单行 reason'}）；snapshot_changed 时停止，不自动刷新目标重试`
      :action==='reconcile_review'
      ?`从批次入口发送 reconcile_review（taskKey ${key}、原调用 invocationId）对账原调用回执`
      :`关闭批次宿主，带 ${grant.flag} ${key} 用同一批次配置重新启动，发送批次操作 ${action}（taskKey ${key}、单行 reason）`;
    return Object.freeze({outcome:'blocked',state:'blocked',code:'batch_parallel_member_recovery_required',batchId:config.batchId,
      currentTask:key,identity:status.identity,memberState:status.state,memberCode:status.code??null,pendingAction:action,
      ...memberDiagnostics(status),
      reason:`${batchKind(Boolean(config.externalModels||config.executionPolicy))}的并行成员 ${key} 停在 ${status.state}/${status.code??status.state}，可在它自己的运行里恢复，所以不改排串行（改排会丢掉原调用回执或中断记录）。出口：${exit}；之后 advance 继续本批次。`,
      guidance:Object.freeze({summary:'并行成员停在可在原运行内恢复的状态，批次不会自动改排。',nextStep:`${exit}；之后 advance 继续本批次。`,
        recoveryOperation:action,prerequisites:Object.freeze(['先确认旧宿主与该成员的会话或子进程已停止写入','恢复只转给该成员运行，不跨成员']),authorizationGranted:false})});
  }
  // Q24: forward one recovery operation to the member the batch is stopped on.
  function bindWorktree(taskKey){
    const {worktree,branch}=location(taskKey);
    need(fs.existsSync(worktree),'batch_member_action_unavailable');
    need(batchGit(worktree,['branch','--show-current'])===branch,'batch_worktree_mismatch');
    plans.set(taskKey,worktreeDefinition(taskKey));
  }
  // A member's definition rooted in its worktree, always mapped from the original
  // plan so binding twice (a stopped replay, then controlTarget) maps once.
  function worktreeDefinition(key){
    const {worktree}=location(key),definition=originalPlans.get(key);
    return validateRunDefinition({...definition,codeProject:worktree,
      ...(definition.codeProjects?{codeProjects:definition.codeProjects.map(root=>path.join(worktree,path.relative(config.codeProject,root)))}:{})});
  }
  // The batch-level part of a rate-limit retry target: which member, and the batch
  // log as it was when the member stopped (digest of the plan and every batch row).
  const batchLogDigest=state=>digest({planDigest,rows:state.rows});
  const rateLimitedStop=result=>result?.state==='pending_review'&&result.code==='review_provider_failed'
    &&result.reviewFailure==='reviewer_rate_limited'&&result.pendingAction==='resume'
    &&typeof result.reviewInvocationId==='string'&&typeof result.identity?.runId==='string';
  function withReviewRetryTarget(result){
    if(!rateLimitedStop(result))return result;
    const taskKey=[...plans].find(([,definition])=>definition.identity.runId===result.identity.runId)?.[0];
    if(!taskKey)return result;
    return Object.freeze({...result,taskKey:result.taskKey??taskKey,
      reviewRetryTarget:Object.freeze({taskKey,batchDigest:batchLogDigest(progress())})});
  }
  // retry_review: redispatch exactly the one rate-limited review a driver waited for.
  // batch.lock is held by the caller; the member's own decision check (expectedReviewStop,
  // cm-ai-conversation-entry.mjs) runs in the member run this process opens and whose
  // writer lock it holds. Any difference: staleRetry, nothing dispatched or written.
  async function retryReview(request,state){
    const taskKey=request.taskKey;
    const stale=why=>Object.freeze({outcome:'rejected',code:'review_retry_target_changed',staleRetry:true,
      batchId:config.batchId,taskKey,operation:'retry_review',reason:`状态已变，未自动重试：${why}；本次没有派发任何操作`});
    need(typeof taskKey==='string'&&taskKey.length>0,'invalid_input');validIdentity(request.identity);hex(request.packageDigest);hex(request.batchDigest);
    shape(request.expectedReviewStop,['invocationId']);id(request.expectedReviewStop.invocationId);
    if(!plans.has(taskKey))return stale(`${taskKey} 不是本批次的任务`);
    if(state.stopped)return stale('批次已经停止');
    if(request.batchDigest!==batchLogDigest(state))return stale('批次日志在等待期间有了新记录');
    const stopped=membership.has(state.current)
      ?membership.get(state.current).filter(key=>membership.has(key)&&!state.ready?.has(key)&&!state.done?.has(key)):[state.current];
    if(!stopped.includes(taskKey))return stale(`批次当前停在 ${stopped.join('、')}，不是 ${taskKey}`);
    if(membership.has(taskKey)){
      const {worktree,branch}=location(taskKey);
      if(!fs.existsSync(worktree)||batchGit(worktree,['branch','--show-current'])!==branch)return stale(`${taskKey} 的 worktree 已不在或换了分支`);
      bindWorktree(taskKey);
    }
    const definition=plans.get(taskKey);
    if(request.identity.repositoryId!==definition.identity.repositoryId||request.identity.runId!==definition.identity.runId
      ||request.identity.taskId!==definition.identity.taskId)return stale(`${taskKey} 的运行已不是等待时那一个`);
    if(!fs.existsSync(path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json')))
      return stale(`${taskKey} 没有运行存档`);
    const run=await open(taskKey);
    if(run.blocked)return {outcome:'blocked',code:run.blocked.reason,batchId:config.batchId};
    // Registered like a driven member, so a cancel on this host reaches it (it is
    // forwarded to the member run and logged as batch_cancel while the review runs).
    members.set(taskKey,run);
    try{
      // A cancel that arrived while the run was opening: dispatch nothing, record the
      // cancel exactly as the serial path does after its open.
      if(cancelled){
        record('batch_cancel',{from_key:taskKey});
        await run.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(taskKey).identity});
        return Object.freeze({outcome:'cancelled',code:'cancelled',batchId:config.batchId,taskKey});
      }
      const wire={operation:'decision',requestId:request.requestId,identity:request.identity,packageDigest:request.packageDigest,
        expectedReviewStop:{invocationId:request.expectedReviewStop.invocationId}};
      const result=controlPolicy?await run.controlHost.handle({version:2,...wire}):await run.host.handle({version:1,...wire});
      if(cancelled)return Object.freeze({outcome:'cancelled',code:'cancelled',batchId:config.batchId,taskKey});
      return retriedMemberResult(result,taskKey);
    }finally{members.delete(taskKey);run.close();}
  }
  // Only this review: the member keeps its own state, code and identity (approved,
  // changes_requested, a second failure). A next step the batch entry does not take
  // (complete, resume, decision) becomes the batch's advance, with guidance saying so.
  const BATCH_NEXT=new Set(['none','advance',...IN_RUN_ACTIONS]);
  function retriedMemberResult(result,taskKey){
    const base={...result,batchId:config.batchId,taskKey};
    if(result.outcome==='rejected'||result.staleRetry===true||BATCH_NEXT.has(result.pendingAction))return Object.freeze(base);
    const approved=result.state==='approved'&&result.code===null;
    return Object.freeze({...base,pendingAction:'advance',guidance:stopGuidance(
      approved?`审查限流已自动重试，${taskKey} 的审查已通过；批次停在这一步，没有顺带完成、合并或推进其他任务。`
        :`审查限流已自动重试，${taskKey} 的这次审查已有结果（${result.state}${result.code?`/${result.code}`:''}）；批次没有顺带推进。`,
      '从批次入口发送 advance 继续本批次（成员不能单独发 complete 或 decision）。',
      ['自动重试只重派了这一次审查','完成、QA、合并和后续任务由下一次批次 advance 照原流程进行'])});
  }
  async function memberAction(request,state){
    const {option,flag}=BATCH_MEMBER_ACTIONS[request.operation],taskKey=request.taskKey;
    const refuse=(code,reason)=>Object.freeze({outcome:'rejected',code,batchId:config.batchId,taskKey,operation:request.operation,reason});
    if(!plans.has(taskKey))return refuse('batch_member_action_unavailable',`taskKey ${taskKey} 不是本批次的任务`);
    const stopped=membership.has(state.current)
      ?membership.get(state.current).filter(key=>membership.has(key)&&!state.ready?.has(key)&&!state.done?.has(key)):[state.current];
    if(!stopped.includes(taskKey))return refuse('batch_member_action_not_current',
      `批次当前停在 ${stopped.join('、')}；恢复操作只转给当前停住的成员，不跨成员`);
    if(!controlPolicy&&!actionGrants.get(request.operation).has(taskKey))return refuse('batch_member_action_authorization_required',
      `${request.operation} 需要批次宿主启动参数 ${flag} ${taskKey}；关闭批次宿主，带上该参数用同一批次配置重新启动后再发送`);
    if(membership.has(taskKey))bindWorktree(taskKey);
    const definition=plans.get(taskKey);
    if(!fs.existsSync(path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json')))
      return refuse('batch_member_action_unavailable',`${taskKey} 还没有运行存档，没有可恢复的步骤`);
    const run=await open(taskKey,{[option]:true});
    if(run.blocked)return {outcome:'blocked',code:run.blocked.reason,batchId:config.batchId};
    try{
      const result=controlPolicy?await run.controlHost.handle({version:2,operation:request.operation,requestId:request.requestId,
        identity:request.expectedControl.member.identity,reason:request.reason,expectedControl:request.expectedControl.member})
        :await run.host.handle({version:1,operation:request.operation,requestId:request.requestId,
          identity:definition.identity,reason:request.reason});
      actionGrants.get(request.operation).delete(taskKey);
      return {...result,batchId:config.batchId,taskKey};
    }finally{run.close();}
  }
  return Object.freeze({controlTarget:()=>batchControlTarget(progress().current),async handle(raw){
    const request=json(raw);shape(request,['operation','requestId',...(request.operation==='reconcile_review'?['taskKey','invocationId']:[]),
      ...(request.operation==='retry_review'?['taskKey','identity','packageDigest','expectedReviewStop','batchDigest']:[]),
      ...(Object.hasOwn(BATCH_MEMBER_ACTIONS,request.operation??'')?['taskKey','reason']:[]),
      ...(controlPolicy?['version',...((IN_RUN_ACTIONS.has(request.operation??''))?['expectedControl']:[])]:[])]);id(request.requestId);
    if(controlPolicy)need(request.version===2,'fingerprint_mismatch');
    need(['advance','status','cancel','reconcile_review','retry_review',...Object.keys(BATCH_MEMBER_ACTIONS)].includes(request.operation));
    if(request.operation==='cancel'&&busy){
      cancelled=true;
      if(members.size){record('batch_cancel',{from_key:liveKey});
        await Promise.all([...members].map(([key,run])=>run.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(key).identity})));
        return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};}
      if(active){
        if(progress().rows.length===0)record('batch_start',{from_key:liveKey,[BATCH_SEGMENT_FIELD]:batchSegment(config.batchId)});
        record('batch_cancel',{from_key:liveKey});
        return active.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(liveKey).identity});
      }
      return {outcome:'cancelled',code:'cancel_pending',batchId:config.batchId};
    }
    if(request.operation==='status'&&busy)return {outcome:'reported',batchId:config.batchId,currentTask:liveKey,state:'running'};
    need(!busy,'batch_busy');busy=true;
    try{
      // Another driver holding batch.lock is moving the batch: a timed retry is stale.
      try{releaseLock=acquireBatchLock(config);}
      catch(error){if(request.operation==='retry_review'&&error?.code==='batch_locked')return Object.freeze({outcome:'rejected',
        code:'review_retry_target_changed',staleRetry:true,batchId:config.batchId,taskKey:request.taskKey,operation:'retry_review',
        reason:'状态已变，未自动重试：另一个驾驶员正在推进本批次；本次没有派发任何操作'});throw error;}
      const result=await (async()=>{
      const initial=progress();liveKey=initial.current;
      // A driver's timed rate-limit retry: checked against the frozen batch and member
      // stop while batch.lock is held, before anything else runs or is written.
      if(request.operation==='retry_review')return await retryReview(request,initial);
      if(controlPolicy&&IN_RUN_ACTIONS.has(request.operation)){
        const expected=json(request.expectedControl);shape(expected,['version','batchId','taskKey','member','batchDigest']);
        readControlTarget(expected.member);hex(expected.batchDigest);
        if(membership.has(request.taskKey))bindWorktree(request.taskKey);
        need(expected.version===2&&expected.batchId===config.batchId&&expected.taskKey===request.taskKey
          &&expected.batchDigest===digest({planDigest,rows:initial.rows}),'snapshot_changed');
      }
      const {externalModels:ignoredModels,executionPolicy:ignoredPolicy,...policyBatch}=config;
      const policy=readBatchExecutionPolicy({batch:policyBatch,started:initial.rows.length>0,enabled:!!config.executionPolicy});
      need(digest(policy)===digest(config.executionPolicy??null),'execution_policy_batch_binding');
      if(request.operation!=='status')await freezeBatchExecutionPolicy(policyBatch,policy);
      if(request.operation==='reconcile_review'){
        need((config.externalModels||config.executionPolicy)&&plans.has(request.taskKey),'review_reconciliation_unavailable');id(request.invocationId);
        if(membership.has(request.taskKey)){
          need(fs.existsSync(location(request.taskKey).worktree),'review_reconciliation_unavailable');bindWorktree(request.taskKey);
        }
        const definition=plans.get(request.taskKey);
        need(fs.existsSync(path.join(config.specsDir,'.reviews','.execution',definition.identity.runId,'state.json')),'review_reconciliation_unavailable');
        const run=await open(request.taskKey);
        try{return controlPolicy?await run.controlHost.handle({version:2,operation:'reconcile_review',requestId:request.requestId,
          identity:request.expectedControl.member.identity,invocationId:request.invocationId,expectedControl:request.expectedControl.member})
          :await run.host.handle({version:1,operation:'reconcile_review',requestId:request.requestId,identity:definition.identity,invocationId:request.invocationId});}
        finally{run.close();}
      }
      if(initial.stopped){
        const conflict=initial.code==='merge_conflict'?initial.rows.findLast(row=>row.phase==='batch_merge_conflict'):null;
        // A stop logged before its members were sealed (a crash, or an older version):
        // advance seals them; status stays read-only and reports the stop as logged.
        if(initial.code==='batch_solo_qa_failed')return soloQaFailedStop(initial.rows.findLast(row=>row.phase==='batch_member_qa_failed'));
        const unsealed=!conflict?[]:request.operation==='advance'?await sealForGuidance():unsealedReadOnly();
        return {outcome:'blocked',code:initial.code??'cancelled',batchId:config.batchId,
          ...(conflict?{files:conflict.files,...(unsealed.length?{unsealed}:{}),guidance:mergeConflictGuidance(conflict.from_key,conflict.files,unsealed)}:{})};
      }
      if(Object.hasOwn(BATCH_MEMBER_ACTIONS,request.operation))return await memberAction(request,initial);
      if(request.operation==='advance'&&!initial.rows.length){
        const dirty=batchGit(config.codeProject,['status','--porcelain']);
        if(dirty)return {outcome:'blocked',code:'batch_main_dirty',batchId:config.batchId,
          reason:`batch_main_dirty\n${dirty}`,files:dirty.split('\n')};
      }
      if(request.operation==='advance')for(const row of initial.blocked?.values()??[])preserveBlockedMember(row);
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
          requireClosed(definition.identity.runId);
        }
        finally{previous.close();}
      }
      for(let count=0;count<plans.size+groups.length;count++){
        if(membership.has(liveKey)){
          const result=await parallelGroup(membership.get(liveKey),request);
          if(result)return result;liveKey=progress().current;continue;
        }
        active=await open(liveKey);
        if(active.blocked)return {outcome:'blocked',code:active.blocked.reason,batchId:config.batchId};
        // batch.lock serializes selection across processes; child locks remain run-local.
        need(progress().current===liveKey&&!progress().stopped,'batch_history_changed');
        if(progress().rows.length===0&&request.operation!=='status')record('batch_start',{from_key:liveKey,[BATCH_SEGMENT_FIELD]:batchSegment(config.batchId)});
        if(cancelled||request.operation==='cancel'){
          record('batch_cancel',{from_key:liveKey});cancelled=true;
          return active.host.handle({version:1,operation:'cancel',requestId:request.requestId,identity:plans.get(liveKey).identity});
        }
        const result=await active.host.handle({version:1,operation:request.operation,requestId:request.requestId,
          identity:plans.get(liveKey).identity});
        if(cancelled)return {outcome:'cancelled',code:'cancelled',batchId:config.batchId};
        if(result.state==='run_done'||result.pendingAction==='start_next_task')requireClosed(plans.get(liveKey).identity.runId);
        const finished=result.state==='run_done'&&['run_done','run_done_degraded'].includes(result.code);
        const handoff=result.outcome==='refreshed'&&result.pendingAction==='start_next_task';
        if(request.operation!=='advance'||(!finished&&!handoff))return {...result,batchId:config.batchId};
        const next=handoff?`${result.nextTask.feature}/${result.nextTask.id}`:null;
        // A batch plans one feature (cm-ai-batch-plan.mjs). When its last task hands
        // off to the next feature, this batch is done: the next feature is planned as
        // a new batch. Anything else outside the plan is still refused.
        const featureDone=handoff&&!plans.has(next)&&[...plans.keys()].at(-1)===liveKey
          &&result.nextTask.feature!==plans.get(liveKey).feature;
        if(handoff&&!featureDone)need(plans.has(next),'batch_task_scope_required');
        let task_commit=commitChanges(config.codeProject,taskCommitArgs(plans.get(liveKey).identity.taskId,taskDescription(config,plans.get(liveKey))));
        if(task_commit)record('batch_task_committed',{from_key:liveKey,task_commit});
        else task_commit=progress().rows.filter(row=>row.phase==='batch_task_committed'&&row.from_key===liveKey).at(-1)?.task_commit??null;
        if(finished)return withDetachedSave({...result,batchId:config.batchId,task_commit});
        if(featureDone)return withDetachedSave({...result,batchId:config.batchId,task_commit,batchComplete:true,nextFeature:result.nextTask.feature,
          guidance:stopGuidance(`本批次的功能 ${plans.get(liveKey).feature} 已全部完成。`,
            `下一个功能是 ${result.nextTask.feature}：用 cm-ai-batch-plan.mjs 以新的批次 ID 生成它的批次再继续。`,[])});
        record('batch_handoff',{from_key:liveKey,to_key:next,checkpoint:active.checkpoint(),package_digest:result.packageDigest,task_commit});
        active.close();active=null;liveKey=next;
      }
      need(false,'batch_limit');
      })();
      // Still under batch.lock: a rate-limited member stop names the frozen target a
      // timed retry_review must find unchanged (the batch log digest and the member).
      return request.operation==='advance'?withReviewRetryTarget(result):result;
    }finally{active?.close();active=null;releaseLock?.();releaseLock=null;busy=false;}
  }});
}

// Review r7: the manual cleanup commands are copied into a shell, so every path and the
// branch are quoted; they run against the main checkout from any directory.
const shellWord=word=>/^[\w@%+=:,./-]+$/.test(word)?word:`'${word.replace(/'/g,`'\\''`)}'`;
export function manualCleanupCommands({repo,worktree,branch}){
  return [`git -C ${shellWord(repo)} worktree remove ${shellWord(worktree)}`,`git -C ${shellWord(repo)} branch -d ${shellWord(branch)}`];
}
function gitOptions(){return {encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}};}
function git(cwd,args,code='batch_git_failed'){
  const result=spawnSync('git',['-C',cwd,...args],gitOptions());
  need(!result.error&&result.status===0&&result.signal===null,code);return result.stdout.trim();
}
function commitChanges(cwd,messageArgs){
  if(!git(cwd,['status','--porcelain']).split('\n').filter(line=>!['?? .cm-external-models-v1.json','?? .cm-model-config.lock'].includes(line)).join('\n'))return null;
  git(cwd,['add','-A','--','.',':!.cm-external-models-v1.json',':!.cm-model-config.lock']);git(cwd,['commit',...messageArgs]);
  return git(cwd,['rev-parse','HEAD']);
}
// Keep the original description in the body; only the subject is summarized.
export function taskCommitArgs(taskId,description,blockedCode=null,blockedReason=null){
  let summary=description.split(/[；。\r\n\u2028\u2029]/u,1)[0].trim()
    .replace(/^~\d+min\s*/u,'').replace(/\s*~\d+min$/u,'').trim();
  summary=summary.replace(/\s+/gu,' ');
  let subject=blockedCode===null?`${taskId}: ${summary||taskId}`:`WIP ${taskId}: blocked (${blockedCode})`;
  // Count ASCII as one column and non-ASCII conservatively as two.
  const width=character=>character.codePointAt(0)<=0x7f?1:2;
  const characters=Array.from(subject);
  if(blockedCode===null&&characters.reduce((sum,character)=>sum+width(character),0)>72){
    subject='';let columns=0;
    for(const character of characters){
      if(columns+width(character)>70)break;
      subject+=character;columns+=width(character);
    }
    subject=subject.trimEnd()+'…';
  }
  return ['-m',subject,'-m',description+(blockedCode!==null&&blockedReason!==null?`\n\n${blockedReason}`:'')];
}
function taskDescription(config,definition){
  const parsed=parseFeatureTaskText(fs.readFileSync(path.join(config.specsDir,definition.feature,'tasks.md'),'utf8'),
    {allowDependencyPunctuation:true,grammar:approvedTaskGrammar(config.specsDir)});
  need(!parsed.error,'parallel_task_invalid');return parsed.tasks.find(task=>task.id===definition.identity.taskId)?.description??definition.identity.taskId;
}
// declared: a batch that has not started yet takes parallel members only from
// tasks.md scope (written at split time) and never a device task. A batch that
// started before that rule keeps resuming under the rules it began with.
// A one-member group is a task developed alone in its own worktree (batch-plan.mjs
// worktree_all) under the same member rules. Batches written before it existed never
// contain one (they were refused), so their resume is unchanged.
function validateGroups(config,plans,{declared=false,workflows=null}={}){
  const groups=config.parallel??[];need(Array.isArray(groups),'invalid_parallel_groups');const used=new Set();
  for(const group of groups){
    need(Array.isArray(group)&&group.length>=1&&group.length<=4,'invalid_parallel_group');
    need(group.every(key=>plans.has(key)&&!used.has(key))&&new Set(group).size===group.length,'invalid_parallel_group');
    const feature=plans.get(group[0]).feature;
    need(group.every(key=>plans.get(key).feature===feature),'parallel_feature_mismatch');
    const parsed=parseFeatureTaskText(fs.readFileSync(path.join(config.specsDir,feature,'tasks.md'),'utf8'),
      {allowDependencyPunctuation:true,grammar:approvedTaskGrammar(config.specsDir)});
    need(!parsed.error,'parallel_task_invalid');
    const ids=new Set(group.map(key=>plans.get(key).identity.taskId));
    need([...ids].every(id=>parsed.tasks.some(task=>task.id===id&&!task.dropped)),'parallel_task_invalid');
    // Direct edges are not enough: with A -> B -> C, a group of {A, C} has no direct edge
    // between its members while A still needs C. Walk the whole prerequisite closure.
    const reaches=(from,target,seen=new Set())=>{
      if(seen.has(from))return false;seen.add(from);
      const deps=parsed.dependencies.get(from)??[];
      return deps.includes(target)||deps.some(dep=>reaches(dep,target,seen));
    };
    need([...ids].every(id=>[...ids].every(other=>other===id||!reaches(id,other))),'parallel_dependency_conflict');
    const ordered=parsed.tasks.filter(task=>!task.dropped),last=ordered.at(-1);
    need(last&&!ids.has(last.id)&&plans.has(`${feature}/${last.id}`),'parallel_final_task_excluded');
    // The batch runs in plan order: the feature's last planned task collects the
    // members' deferred QA, so it cannot be a member either (new batches).
    if(declared)need(!ids.has(plans.get([...plans.keys()].filter(key=>plans.get(key).feature===feature).at(-1)).identity.taskId),
      'parallel_final_task_excluded');
    const paths=new Set();
    for(const key of group)for(const file of plans.get(key).scope){
      need(!paths.has(file),'parallel_scope_overlap');paths.add(file);
    }
    if(declared)for(const key of group){
      const scope=declaredTaskScope(config.specsDir,plans.get(key).feature,plans.get(key).identity.taskId);
      need(scope!==null,'parallel_scope_undeclared');need(!scope.device,'parallel_device_task');
    }
    // A new batch takes a one-member group only where the planner would propose it
    // (batch-plan.mjs): same project configuration in the worktree, no interactive QA,
    // and no fixed N6 checkpoint its QA could hit there (checked below).
    if(declared&&group.length===1){
      const blocked=soloWorktreeBlocker({specsDir:config.specsDir,codeProject:config.codeProject,feature});
      if(blocked)throw Object.assign(new Error(blocked.code),{code:blocked.code,reason:`${group[0]}: ${blocked.reason}`});
    }
    for(const key of group)used.add(key);
  }
  if(declared)checkSoloQaCheckpoints(config,plans,groups,workflows);
  return groups;
}
// Grammar 3 execution table (batch-plan.mjs): batch.memberDevelopment names the members
// the session develops, {"feature/T-xxx":"session"}. It is part of the configuration (so
// of planDigest) and absent from batches without such members, which keep their exact
// plan digest. Present, it must match tasks.md (the 开发: 会话 marks of the approved
// grammar 3) and the narrow rule: one session task per feature, its last task, never a
// parallel member. A new batch on grammar 3 without the table is refused the same way;
// a started one without it resumes as it began.
function validateMemberDevelopment(config,plans,groups,{declared}){
  const table=config.memberDevelopment,grammar=approvedTaskGrammar(config.specsDir);
  if(table!==undefined)need(table!==null&&typeof table==='object'&&!Array.isArray(table)&&Object.keys(table).length>0
    &&Object.entries(table).every(([taskKey,value])=>plans.has(taskKey)&&value==='session'),'invalid_member_development');
  // External models and execution policy rewrite the reviewer identity and the abandon
  // rules; a session member is not supported with either in this round.
  if(table!==undefined)need(!config.externalModels&&!config.executionPolicy,'session_member_unsupported_config');
  if(table===undefined&&(!declared||grammar!==TASK_GRAMMAR))return;
  const grouped=new Set(groups.flat());
  for(const feature of new Set([...plans.values()].map(plan=>plan.feature))){
    const text=fs.readFileSync(path.join(config.specsDir,feature,'tasks.md'),'utf8');
    const parsed=parseFeatureTaskText(text,{allowDependencyPunctuation:true,grammar});need(!parsed.error,'parallel_task_invalid');
    const sessions=grammar===TASK_GRAMMAR?parseTaskScopes(text,{grammar}).sessions:new Set();
    const problem=sessionTaskProblem(parsed.tasks,sessions);
    if(problem)throw Object.assign(new Error(problem.code),{code:problem.code,reason:`${feature}/tasks.md：${sessionTaskReason(problem)}`});
    for(const [taskKey,plan] of plans){
      if(plan.feature!==feature)continue;
      const session=sessions.has(plan.identity.taskId);
      if(session&&grouped.has(taskKey))throw Object.assign(new Error('session_task_parallel'),{code:'session_task_parallel',reason:`${taskKey}：会话任务不能进并行组`});
      if(session!==Object.hasOwn(table??{},taskKey))throw Object.assign(new Error('member_development_mismatch'),{code:'member_development_mismatch',
        reason:`${taskKey}：批次执行表与 tasks.md 的「开发: 会话」标记不一致；用 cm-ai-batch-plan.mjs 重新生成批次配置`});
    }
  }
}
// The planner's walk along the batch order (soloQaCounter), with the launched workflows
// and control policy. The count spans features (and a feature that closes drops its tasks
// from floor), so a one-member group needs a one-feature batch. Its groups must be
// contiguous in that order: a blocked member reruns when it is the first unfinished task,
// so a member placed after outside tasks would rerun (and maybe reset the count) after them.
function checkSoloQaCheckpoints(config,plans,groups,workflows){
  const solos=groups.filter(group=>group.length===1);
  if(!solos.length)return;
  const features=new Set([...plans.values()].map(plan=>plan.feature));
  if(features.size>1)throw Object.assign(new Error('parallel_solo_multi_feature'),{code:'parallel_solo_multi_feature',
    reason:`${solos[0][0]}: 批次含多个功能时不能单独开 worktree（QA 计数跨功能累计，推算不准）；按功能分别生成批次（cm-ai-batch-plan.mjs）`});
  const order=[...plans.keys()];
  for(const group of groups){
    const at=group.map(key=>order.indexOf(key));
    if(Math.max(...at)-Math.min(...at)!==group.length-1)throw Object.assign(new Error('parallel_solo_split_group'),{code:'parallel_solo_split_group',
      reason:`${group.join(',')}: 有单独开 worktree 的任务时，同组成员必须在任务顺序里相邻（被阻断的成员改回主目录重做的时点才可推算）；按顺序重排或用 cm-ai-batch-plan.mjs 重新生成`});
  }
  const [feature]=features,groupOf=new Map(groups.flatMap(group=>group.map(key=>[key,group]))),placed=new Set();
  const counter=soloQaCounter(soloQaBase({specsDir:config.specsDir,codeProject:config.codeProject,feature,repositoryId:config.repositoryId}));
  for(const key of plans.keys()){
    if(placed.has(key))continue;
    const group=groupOf.get(key)??[key];group.forEach(member=>placed.add(member));
    if(group.length>1){counter.placeGroup(group.length);continue;}
    const scope=plans.get(key).scope,workflow=workflows?.[key]??null;
    const rule=groupOf.has(key)?counter.check(scope,workflow):null;
    if(rule)throw Object.assign(new Error('parallel_solo_qa_checkpoint'),{code:'parallel_solo_qa_checkpoint',
      reason:`${key}: 单独在 worktree 里开发时 QA 可能按固定检查点触发（${rule}），批次没有 QA 修复出口；让它在主目录串行（用 cm-ai-batch-plan.mjs 带 --workflow-config 重新生成）`});
    counter.place(groupOf.has(key)?'solo':'main',scope,{workflow,hostDecides:workflowDecidesQa(workflow)||Boolean(config.controlPolicy)});
  }
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
