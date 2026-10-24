// The batch configuration /cm-ai runs, computed from the approved tasks.md
// instead of written by the session. One feature at a time (the one admission
// selects). Tasks that can run together share a parallel group; everything else
// keeps the batch's serial order. The batch host validates the result again
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

export const PARALLEL_DEFAULTS=Object.freeze({enabled:true,max:2});
// The project's parallel settings ({enabled,max}); absent keys take the defaults.
export function parallelSettings(config){
  const value=config?.parallel??{};
  const settings={...PARALLEL_DEFAULTS,...value};
  need(typeof settings.enabled==='boolean'&&Number.isInteger(settings.max)&&settings.max>=1&&settings.max<=4,'invalid_parallel_settings');
  return Object.freeze(settings);
}

// {mode:'batch',feature,config,groups}, {mode:'serial',feature,reason} or
// {mode:'complete'} when no task is left; any other admission state refuses with
// the admission's own reason.
export function planCmAiBatch({specsDir,codeProject,feature=null,repositoryId,batchId,settings=PARALLEL_DEFAULTS}){
  const admission=inspectCmAiAdmission({specsDir,codeProject,...(feature===null?{}:{feature})});
  if(admission.state==='complete'&&!admission.requestedFeatureComplete)return {mode:'complete'};
  if(admission.state!=='ready'||admission.requestedFeatureComplete)throw Object.assign(new Error('batch_plan_not_ready'),
    {code:'batch_plan_not_ready',reason:`admission ${admission.state}: ${admission.requestedFeatureComplete?'feature_tasks_terminal':admission.reason}`});
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
  const tasks=remaining.map(task=>({feature:selected,taskId:task.id,scope:[...scopes.tasks.get(task.id).scope],requirements:[]}));
  const groups=settings.enabled&&settings.max>=2?group(parsed,remaining,scopes,settings.max):[];
  const key=taskId=>`${selected}/${taskId}`;
  const config={batch:{version:1,repositoryId,batchId,specsDir,codeProject,tasks,
    ...(groups.length?{parallel:groups.map(members=>members.map(key))}:{})},
    workflows:Object.fromEntries(tasks.map(task=>[key(task.taskId),null]))};
  return {mode:'batch',feature:selected,config,groups};
}

function group(parsed,remaining,scopes,max){
  const deps=parsed.dependencies;
  const reaches=(from,target,seen=new Set())=>{
    if(seen.has(from))return false;seen.add(from);
    const direct=deps.get(from)??[];
    return direct.includes(target)||direct.some(dep=>reaches(dep,target,seen));
  };
  const last=parsed.tasks.filter(task=>!task.dropped).at(-1)?.id;
  const order=new Map(remaining.map((task,index)=>[task.id,index]));
  const candidate=task=>task.id!==last&&!scopes.tasks.get(task.id).device;
  // A group starts at its first member, so that task's prerequisites still to run must
  // come before it. A later member needs no separate check: any task between the
  // group's start and it either joined (and the dependency check saw it) or closed
  // the group.
  const readyBefore=(task,start)=>(deps.get(task.id)??[]).every(dep=>!order.has(dep)||order.get(dep)<start);
  const groups=[];let current=[];
  const close=()=>{if(current.length>=2)groups.push(current.map(task=>task.id));current=[];};
  for(const task of remaining){
    if(!candidate(task)){close();continue;}
    const fits=current.length<max&&current.every(other=>!reaches(task.id,other.id)&&!reaches(other.id,task.id)
        &&!scopesOverlap(scopes.tasks.get(other.id).scope,scopes.tasks.get(task.id).scope));
    if(current.length&&fits){current.push(task);continue;}
    close();
    if(readyBefore(task,order.get(task.id)))current=[task];
  }
  close();
  return groups;
}
