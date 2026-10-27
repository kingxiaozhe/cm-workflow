// The batch configuration /cm-ai runs, computed from the approved tasks.md
// instead of written by the session. One feature at a time (the one admission
// selects). Tasks that can run together share a parallel group. With
// `worktree_all` (the default) every other task that could be a member gets a
// group of its own, so it is developed in its own worktree and merged back in
// task order like any member; the excluded tasks below keep the batch's serial
// order in the main checkout. The batch host validates the result again
// (cm-ai-batch-run.mjs validateGroups); this module only proposes.
//
// Grouping, greedy in tasks.md order, a group of at most `max` members:
// - every remaining task declares its files (`- 范围:`); otherwise the whole
//   feature stays serial (an undeclared task cannot be proven independent);
// - members share no dependency path (transitive), no file, need no device and
//   none is the feature's last task (its QA collects the members' deferred QA);
// - a member's prerequisites all come before the group's first member, because
//   the whole group starts there.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {inspectCmAiAdmission,parseFeatureTaskText} from './cm-ai-admission.mjs';
import {approvedTaskGrammar} from '../spec-task-line.mjs';
import {parseTaskScopes,scopesOverlap,BOOTSTRAP_FEATURE} from '../task-scope.mjs';
import {need} from './effect-contract.mjs';
import {featureHasBrowserCases} from './host-workflow-capabilities.mjs';
import {decideHostQaPolicy,qaUnassessedTaskCounts} from './host-qa-policy.mjs';
import {findConfig} from '../../../scripts/cm-workflow-config.mjs';

// One-member groups (worktree_all) and N6. A task alone in a worktree decides its QA
// like a serial task and would run a triggered QA in that worktree, where the batch
// has no QA repair path. So a task gets a one-member group only when, by the same
// rules the decision uses, it cannot trigger QA there; the planner and the batch
// host (cm-ai-batch-run.mjs validateGroups) apply these two checks alike.
//
// Feature-wide: the worktree must see the same project configuration as the main
// checkout (QA reloads it there). A worktree is checked out from HEAD, so the main
// checkout's configuration file must be byte-identical to its HEAD blob: an ignored
// or untracked file never reaches the worktree, and a skip-worktree/assume-unchanged
// local override hides from `git status` while the worktree gets the committed one;
// and no interactive (browser/simulator) case may apply, since that QA may target a
// server or app built from the main checkout. null, or {code,reason}.
export function soloWorktreeBlocker({specsDir,codeProject,feature}){
  const file=findConfig(codeProject);
  if(file){
    const name=path.basename(file);
    // cat-file reads the raw committed blob: no filters, no textconv.
    const committed=spawnSync('git',['-c','core.fsmonitor=false','-C',codeProject,'cat-file','blob',`HEAD:./${name}`],
      {timeout:10000,maxBuffer:4*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0'}});
    if(committed.error||committed.status!==0)return {code:'parallel_solo_config_untracked',
      reason:`项目配置 ${name} 不在当前提交里（未跟踪，例如被 .gitignore 忽略），worktree 里拿不到这份配置，QA 会按另一套策略执行；提交该配置后再生成批次，或让这些任务在主目录串行`};
    if(!committed.stdout.equals(fs.readFileSync(file)))return {code:'parallel_solo_config_diverged',
      reason:`主目录的项目配置 ${name} 与当前提交里的不同（可能用了 skip-worktree 或 assume-unchanged 保留本地改动），worktree 拿到的是提交里的那份，QA 会按另一套策略执行；让两者一致后再生成批次，或让这些任务在主目录串行`};
  }
  if(featureHasBrowserCases(specsDir,feature,codeProject))return {code:'parallel_solo_interactive_qa',
    reason:`功能 ${feature} 有浏览器等交互式 QA 用例，可能连接主目录启动的服务或 App；单独开 worktree 会验收到未合并的代码`};
  return null;
}
// Per task: count is the five_tasks_without_qa count its decision would see, itself
// included. The changed files are the declared scope plus the Learning targets (a
// delivery outside the scope is refused as out_of_scope). A reason, or null.
export function soloQaCheckpoint({scope,count,workflow=null}){
  const changedFiles=[...new Set([...scope,'AGENTS.md',...(workflow?.applicableAgentFiles??[])])];
  const decision=decideHostQaPolicy({changedFiles,criticalPaths:workflow?.qa?.criticalPaths??{},pending:1,mergeEligible:false,
    unassessedTasks:count});
  return decision.status==='triggered'?decision.reason:null;
}
// {count,floor} before the batch (qaUnassessedTaskCounts).
export const soloQaBase=({specsDir,codeProject,feature,repositoryId})=>qaUnassessedTaskCounts({specsDir,codeProject,feature,repositoryId});

// The five_tasks_without_qa count along the batch order, as the set of values it may
// have before the next task. A triggered QA leaves floor counted (tasks with no QA row
// at all). check() judges the next task by the largest value; then
// place() records a task in the main checkout ('main') or alone in a worktree ('solo'):
// - 'solo': check() found no checkpoint, so its QA is skipped (a blocked one reruns in
//   the main checkout with the same count and files, so skipped as well);
// - 'main': triggered once its count reaches five; below that skipped, unless its scope
//   hits a registered path: then either, since the decision sees the files actually
//   changed. (The batch's final task may trigger feature_complete; none runs after it.)
// hostDecides: the host policy decides the task's QA (a workflow configuration with qa,
// or a control policy). Without it the session supplies the decision: either.
// placeGroup() records a group developed alongside each other: each member defers its
// QA (skipped), but a blocked member reruns in the main checkout before the group
// settles and may trigger there, after any of the other members' rows.
export function soloQaCounter({count,floor}){
  let counts=new Set([count]);
  const check=(scope,workflow=null)=>soloQaCheckpoint({scope,count:Math.max(...counts)+1,workflow});
  const place=(placement,scope,{workflow=null,hostDecides})=>{
    const hits=placement==='main'&&soloQaCheckpoint({scope,count:1,workflow})!==null;
    const next=new Set();
    for(const before of counts){
      const own=before+1;
      if(!hostDecides||hits&&own<5)next.add(floor).add(own);
      else next.add(placement==='main'&&own>=5?floor:own);
    }
    counts=next;
  };
  const placeGroup=size=>{
    const next=new Set([...counts].map(before=>before+size));
    for(let rows=0;rows<size;rows++)next.add(floor+rows);
    counts=next;
  };
  return Object.freeze({check,place,placeGroup});
}
// Whether the host policy decides a task's QA under this workflow configuration (a
// control policy decides it as well; see soloQaCounter).
export const workflowDecidesQa=workflow=>workflow!==null&&workflow.qa!=null;

// worktree_all: every task that could be a group member runs in a worktree, alone
// when nothing pairs with it. false keeps only real groups (two or more members).
export const PARALLEL_DEFAULTS=Object.freeze({enabled:true,max:2,worktree_all:true});
// The project's parallel settings ({enabled,max,worktree_all}); absent keys take the defaults.
export function parallelSettings(config){
  const value=config?.parallel??{};
  const settings={...PARALLEL_DEFAULTS,...value};
  need(typeof settings.enabled==='boolean'&&Number.isInteger(settings.max)&&settings.max>=1&&settings.max<=4
    &&typeof settings.worktree_all==='boolean','invalid_parallel_settings');
  return Object.freeze(settings);
}

// {mode:'batch',feature,config,groups}, {mode:'serial',feature,reason} or
// {mode:'complete'} when no task is left; any other admission state refuses with
// the admission's own reason. Always the feature admission selects: the batch
// host admits each task through that same selection.
// workflow: optional single-task workflow configuration (the one the session passes the
// batch host for these tasks); its qa.criticalPaths and applicableAgentFiles keep tasks
// that would hit a registered path out of one-member groups.
export function planCmAiBatch({specsDir,codeProject,repositoryId,batchId,settings:given=PARALLEL_DEFAULTS,workflow=null}){
  const settings=parallelSettings({parallel:given});
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  if(admission.state==='complete')return {mode:'complete'};
  if(admission.state!=='ready')throw Object.assign(new Error('batch_plan_not_ready'),
    {code:'batch_plan_not_ready',reason:`admission ${admission.state}: ${admission.reason}`});
  const selected=admission.nextTask.feature;
  if(BOOTSTRAP_FEATURE.test(selected))return {mode:'serial',feature:selected,reason:'bootstrap_feature'};
  const grammar=approvedTaskGrammar(specsDir);
  const text=fs.readFileSync(path.join(specsDir,selected,'tasks.md'),'utf8');
  const parsed=parseFeatureTaskText(text,{allowDependencyPunctuation:true,grammar});
  need(!parsed.error,'batch_plan_tasks_invalid');
  const scopes=parseTaskScopes(text,{grammar});
  const remaining=parsed.tasks.filter(task=>!task.completed&&!task.dropped);
  need(remaining.length>0,'batch_plan_not_ready');
  if(scopes.errors.some(item=>remaining.some(task=>task.id===item.taskId)))return {mode:'serial',feature:selected,reason:'scope_invalid'};
  if(!remaining.every(task=>scopes.tasks.has(task.id)))return {mode:'serial',feature:selected,reason:'scope_undeclared'};
  // The batch runs its tasks in this order and the host admits each one when it is
  // reached, so every task must come after its prerequisites still to run.
  const schedule=executionOrder(remaining,parsed.dependencies);
  if(schedule===null)return {mode:'serial',feature:selected,reason:'dependency_order'};
  need(schedule[0].id===admission.nextTask.id,'batch_plan_order_mismatch');
  // The host requires the feature's last task in every batch with a group (its QA
  // collects the members' deferred QA); a completed last task leaves no such task.
  const lastDone=parsed.tasks.filter(task=>!task.dropped).at(-1)?.completed===true;
  const tasks=schedule.map(task=>({feature:selected,taskId:task.id,scope:[...scopes.tasks.get(task.id).scope],requirements:[]}));
  // One-member groups only where the task cannot trigger QA in its worktree (above);
  // real groups defer their QA to the last task in the main checkout.
  let solo=null;
  if(settings.worktree_all&&!soloWorktreeBlocker({specsDir,codeProject,feature:selected})){
    const counter=soloQaCounter(soloQaBase({specsDir,codeProject,feature:selected,repositoryId}));
    const scope=task=>scopes.tasks.get(task.id).scope;
    // Every task gets the same workflow. Without one (or with qa:null) the plan cannot
    // tell whether the host policy decides QA (the session may), so no certain reset.
    const hostDecides=workflowDecidesQa(workflow);
    solo={alone:task=>counter.check(scope(task),workflow)===null,
      place:(task,placement)=>counter.place(placement,scope(task),{workflow,hostDecides}),
      placeGroup:tasks=>counter.placeGroup(tasks.length)};
  }
  const groups=settings.enabled&&(settings.max>=2||solo)&&!lastDone
    ?group(parsed,schedule,scopes,settings.max,solo):[];
  const key=taskId=>`${selected}/${taskId}`;
  const config={batch:{version:1,repositoryId,batchId,specsDir,codeProject,tasks,
    ...(groups.length?{parallel:groups.map(members=>members.map(key))}:{})},
    workflows:Object.fromEntries(tasks.map(task=>[key(task.taskId),null]))};
  return {mode:'batch',feature:selected,config,groups};
}

// tasks.md order, except that a task waits for its prerequisites still to run
// (stable topological order). null when no order exists (a cycle).
function executionOrder(remaining,deps){
  const pending=new Set(remaining.map(task=>task.id)),placed=new Set(),order=[];
  while(order.length<remaining.length){
    const next=remaining.find(task=>!placed.has(task.id)&&(deps.get(task.id)??[]).every(dep=>!pending.has(dep)||placed.has(dep)));
    if(!next)return null;
    placed.add(next.id);order.push(next);
  }
  return order;
}

// solo: null (no one-member groups), or alone (whether a task may run alone in a
// worktree), place and placeGroup (told where each task runs, in the batch order).
function group(parsed,schedule,scopes,max,solo){
  const deps=parsed.dependencies;
  const reaches=(from,target,seen=new Set())=>{
    if(seen.has(from))return false;seen.add(from);
    const direct=deps.get(from)??[];
    return direct.includes(target)||direct.some(dep=>reaches(dep,target,seen));
  };
  // Neither the feature's last task nor the last one to run can be a member: the
  // task that runs last collects the members' deferred QA serially.
  const last=parsed.tasks.filter(task=>!task.dropped).at(-1)?.id,lastRun=schedule.at(-1)?.id;
  const order=new Map(schedule.map((task,index)=>[task.id,index]));
  const candidate=task=>task.id!==last&&task.id!==lastRun&&!scopes.tasks.get(task.id).device;
  // The whole group starts at its first member, so every member's prerequisites
  // still to run must come before that point.
  const readyBefore=(task,start)=>(deps.get(task.id)??[]).every(dep=>!order.has(dep)||order.get(dep)<start);
  // A candidate nothing pairs with becomes a one-member group when it may run alone.
  // Members are consecutive in the schedule, so tasks are placed in the batch order.
  const groups=[];let current=[];
  const close=()=>{
    if(current.length>=2){groups.push(current.map(task=>task.id));solo?.placeGroup(current);}
    else if(current.length===1&&solo?.alone(current[0])){groups.push([current[0].id]);solo.place(current[0],'solo');}
    else current.forEach(task=>solo?.place(task,'main'));
    current=[];
  };
  for(const task of schedule){
    if(!candidate(task)){close();solo?.place(task,'main');continue;}
    const fits=current.length>0&&current.length<max&&readyBefore(task,order.get(current[0].id))
      &&current.every(other=>!reaches(task.id,other.id)&&!reaches(other.id,task.id)
        &&!scopesOverlap(scopes.tasks.get(other.id).scope,scopes.tasks.get(task.id).scope));
    if(fits){current.push(task);continue;}
    close();
    if(readyBefore(task,order.get(task.id)))current=[task];else solo?.place(task,'main');
  }
  close();
  return groups;
}
