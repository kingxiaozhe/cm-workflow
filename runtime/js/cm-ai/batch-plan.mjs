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
import {inspectCmAiAdmission,parseFeatureTaskText} from './cm-ai-admission.mjs';
import {approvedTaskGrammar} from '../spec-task-line.mjs';
import {parseTaskScopes,scopesOverlap,BOOTSTRAP_FEATURE} from '../task-scope.mjs';
import {need} from './effect-contract.mjs';

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
export function planCmAiBatch({specsDir,codeProject,repositoryId,batchId,settings:given=PARALLEL_DEFAULTS}){
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
  const groups=settings.enabled&&(settings.max>=2||settings.worktree_all)&&!lastDone
    ?group(parsed,schedule,scopes,settings.max,settings.worktree_all):[];
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

function group(parsed,schedule,scopes,max,worktree_all){
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
  // A candidate nothing pairs with becomes a one-member group under worktree_all.
  const groups=[];let current=[];
  const close=()=>{if(current.length>=(worktree_all?1:2))groups.push(current.map(task=>task.id));current=[];};
  for(const task of schedule){
    if(!candidate(task)){close();continue;}
    const fits=current.length>0&&current.length<max&&readyBefore(task,order.get(current[0].id))
      &&current.every(other=>!reaches(task.id,other.id)&&!reaches(other.id,task.id)
        &&!scopesOverlap(scopes.tasks.get(other.id).scope,scopes.tasks.get(task.id).scope));
    if(fits){current.push(task);continue;}
    close();
    if(readyBefore(task,order.get(task.id)))current=[task];
  }
  close();
  return groups;
}
