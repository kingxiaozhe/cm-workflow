// Commander phase 1: a read-only campaign ledger. It summarizes tasks.md, every
// run journal and the project log into one table and one next step. Each run's
// own journal stays the authority: nothing here writes, locks, dispatches or
// grants. Live-only status (pendingAction) is not recomputed; the ledger names
// the run and says to read its status through the run's own driver.
import fs from 'node:fs';
import path from 'node:path';
import {readExecutionSnapshot} from '../cm-ai/execution-snapshot.mjs';
import {readRunnerHistory} from '../cm-ai/durable-runner-state.mjs';
import {inspectCmAiAdmission,parseFeatureTaskText,validDependencies} from '../cm-ai/cm-ai-admission.mjs';
import {approvedTaskGrammar} from '../spec-task-line.mjs';
import {readEvidenceSupersession} from '../cm-ai/reviewed-evidence-supersession-record.mjs';

export const LEDGER_VERSION=1;
export const IDLE_MINUTES=45;
const LOG_LIMIT=64*1024*1024;
const STOPPED=['blocked','unknown','cancelled'];
const slug=feature=>feature.replace(/^\d+\./,'');
const at=value=>{const t=Date.parse(value);return Number.isFinite(t)?t:null;};

// Last event per run_id. A malformed line is counted, never guessed at.
export function readLogEvents(specsDir){
  const file=path.join(specsDir,'运行日志.jsonl'),runs=new Map();let invalid=0;
  let stat;try{stat=fs.lstatSync(file);}catch{return {runs,invalid,present:false};}
  if(!stat.isFile()||stat.size>LOG_LIMIT)return {runs,invalid,present:false,unreadable:true};
  for(const line of fs.readFileSync(file,'utf8').split('\n')){
    if(!line.trim())continue;
    let row;try{row=JSON.parse(line);}catch{invalid++;continue;}
    if(typeof row?.run_id!=='string'||at(row.at)===null){invalid++;continue;}
    const prior=runs.get(row.run_id);
    const entry={at:row.at,event:row.event??null,detail:typeof row.detail==='string'?row.detail.slice(0,200):null,
      workflow:row.workflow??null,feature:row.feature??null,task:row.task??null,
      runDone:Boolean(prior?.runDone)||row.event==='run_done'};
    if(!prior||at(row.at)>=at(prior.at))runs.set(row.run_id,entry);else if(entry.runDone)prior.runDone=true;
  }
  return {runs,invalid,present:true};
}

// Hints from the records: which task a run belongs to, whom it claims to have
// superseded and whether it journaled a task commit. For a run this runtime
// cannot replay they are display only, never a basis for a decision.
export function rawHints(records){
  const first=records[0]?.payload??{},config=first.config??{};
  const tasksPath=config.completion?.owner?.tasksPath;
  const superseded=records.find(r=>r?.payload?.type==='evidence-superseded')?.payload?.record?.previousRunIds;
  return {feature:typeof tasksPath==='string'?path.basename(path.dirname(tasksPath)):config.taskLearning?.feature??null,
    taskId:config.identity?.taskId??null,previousRunIds:Array.isArray(superseded)?superseded.filter(id=>typeof id==='string'):[],
    committed:records.some(r=>r?.payload?.type==='task-commit-result')};
}

// A run whose hash chain verifies but whose later records this runtime cannot
// replay may still prove its supersession: the record must sit where replay
// requires it (the second record), pass the shared record validator, and name
// this run and its own feature and task. Anything less proves nothing.
export function checkedSupersession(records,runId,hints){
  const record=records[1]?.payload;
  if(record?.type!=='evidence-superseded'||records[1].kind!=='result')return [];
  try{
    const value=readEvidenceSupersession(record.record,{feature:hints.feature,taskId:hints.taskId,newRunId:runId});
    return [...value.previousRunIds];
  }catch{return [];}
}

// The start of a run must bind together before any of its later records is
// believed: the validated snapshot identity, the init identity, and one feature
// named by both the task path and the learning binding.
export function originBound(records,snapshot,runId){
  const first=records[0],config=first?.payload?.config;
  const tasksPath=config?.completion?.owner?.tasksPath,feature=config?.taskLearning?.feature;
  return first?.kind==='result'&&first.payload.version===3&&first.payload.type==='init'
    &&snapshot?.identity?.runId===runId&&config?.identity?.runId===runId
    &&config.identity.repositoryId===snapshot.identity.repositoryId&&typeof config.identity.taskId==='string'
    &&typeof tasksPath==='string'&&typeof feature==='string'&&path.basename(path.dirname(tasksPath))===feature;
}

// One summary per run directory. Unreadable or unknown runs are kept, and they
// stop the ledger from claiming that no run is in flight.
export function readRuns(specsDir){
  const root=path.join(specsDir,'.reviews','.execution'),runs=[];
  let names;
  try{names=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name).sort();}
  catch(error){return {runs,error:error.code==='ENOENT'?null:(error.code??'read_failed')};}
  for(const runId of names){
    const file=path.join(root,runId,'state.json');
    // Only a confirmed ENOENT is an empty residue; EACCES, EIO and the like are
    // unknown, so they must not read as "no run here".
    try{fs.lstatSync(file);}catch(error){
      runs.push(error.code==='ENOENT'?{runId,kind:'empty'}:{runId,kind:'unreadable',code:error.code??'read_failed'});continue;}
    let raw;
    try{raw=JSON.parse(fs.readFileSync(file,'utf8'));}catch{runs.push({runId,kind:'unreadable',code:'store_corrupt'});continue;}
    let snapshot=null,integrity=null;
    try{snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:raw?.identity?.repositoryId,runId}});}
    catch(error){integrity=typeof error.code==='string'?error.code:'read_failed';}
    const records=snapshot?snapshot.records:Array.isArray(raw?.records)?raw.records:[],first=records[0]?.payload;
    if(first?.workflow==='cm-fix-stages-v1'&&snapshot){runs.push({runId,kind:'cm-fix',records:records.length});continue;}
    if(first?.protocol!=='cm-task-runner'||first.type!=='init'||!snapshot&&first?.workflow){
      runs.push({runId,kind:'unreadable',code:integrity??'unknown_workflow'});continue;}
    const hints=rawHints(records);
    if(snapshot)try{
      const history=readRunnerHistory(records,first.config,first.version);
      runs.push({runId,kind:'cm-ai',verified:true,feature:hints.feature,taskId:hints.taskId,state:history.state.state,
        code:history.state.code??null,attempt:history.state.attempt,pending:history.pending?.kind??null,
        committed:history.state.taskCommit!=null||hints.committed,trustedPrevious:history.supersession?.previousRunIds??[],
        claimedPrevious:hints.previousRunIds,records:records.length});
      continue;
    }catch(error){integrity=null;runs.push({runId,kind:'cm-ai',verified:false,chainVerified:true,feature:hints.feature,taskId:hints.taskId,
      state:null,code:null,attempt:null,pending:null,committed:false,committedClaim:hints.committed,
      trustedPrevious:originBound(records,snapshot,runId)?checkedSupersession(records,runId,hints):[],claimedPrevious:hints.previousRunIds,records:records.length,
      unverifiedReason:typeof error.code==='string'?error.code:'read_failed'});continue;}
    runs.push({runId,kind:'cm-ai',verified:false,chainVerified:false,feature:hints.feature,taskId:hints.taskId,state:null,code:null,
      attempt:null,pending:null,committed:false,committedClaim:hints.committed,trustedPrevious:[],claimedPrevious:hints.previousRunIds,
      records:records.length,unverifiedReason:integrity});
  }
  return {runs,error:null};
}

export function readFeatureTasks(specsDir,names){
  const grammar=approvedTaskGrammar(specsDir);
  return names.map(name=>{
    let text;try{text=fs.readFileSync(path.join(specsDir,name,'tasks.md'),'utf8');}
    catch{return {name,error:'tasks_missing',tasks:[]};}
    const parsed=parseFeatureTaskText(text,{allowDependencyPunctuation:true,grammar});
    if(parsed.error)return {name,error:parsed.error,tasks:[]};
    if(!validDependencies(parsed.tasks,parsed.dependencies))return {name,error:'dependencies_invalid',tasks:[]};
    return {name,tasks:parsed.tasks.map(task=>({id:task.id,completed:task.completed,dropped:task.dropped,
      dependsOn:parsed.dependencies.get(task.id)??[]}))};
  });
}

// Phases. pending means an effect is journaled but not yet checkpointed: the
// run is executing, not stopped, even though replay projects it as unknown.
const runPhase=run=>!run.verified?'unverified':run.committed?'committed':run.pending?'executing'
  :STOPPED.includes(run.state)?'stopped':run.state==='fixture_completed'?'finishing':'in_progress';
const OPEN=['executing','in_progress','stopped','unverified'];
const sameTask=(a,b)=>slug(a.feature??'')===slug(b.feature??'')&&a.taskId===b.taskId;

// Pure composition, so every rule is testable without a disk fixture.
export function composeLedger({specsDir,admission,features,runs,runsError=null,log,now}){
  const nowMs=at(now);if(nowMs===null)throw Object.assign(new Error('invalid_now'),{code:'invalid_now'});
  const inconsistencies=[],byId=new Map(runs.filter(r=>r.kind==='cm-ai').map(r=>[r.runId,r]));
  // Only a replayed or structurally checked supersession retires a run, and only
  // when the predecessor is a run of the same task.
  const supersededBy=new Map();
  for(const run of byId.values()){
    for(const previous of run.trustedPrevious??[]){
      const prior=byId.get(previous);
      if(prior&&!sameTask(prior,run)){inconsistencies.push({kind:'supersession_task_mismatch',runId:run.runId,previous});continue;}
      supersededBy.set(previous,run.runId);
    }
    for(const previous of run.claimedPrevious??[])if(!(run.trustedPrevious??[]).includes(previous)&&byId.has(previous))
      inconsistencies.push({kind:'unverified_supersession',feature:run.feature,task:run.taskId,runId:run.runId,previous});
  }
  const taskOf=new Map(features.flatMap(f=>f.tasks.map(t=>[`${slug(f.name)}/${t.id}`,{feature:f.name,...t}])));
  const ai=[...byId.values()].map(run=>{
    const last=log.runs.get(run.runId)??null;
    return {...run,phase:runPhase(run),supersededBy:supersededBy.get(run.runId)??null,
      lastEventAt:last?.at??null,lastEvent:last?.detail??last?.event??null,runDone:last?.runDone??false,
      idleMinutes:last?Math.floor((nowMs-at(last.at))/60000):null};
  });
  // Open runs: every run not retired by a trusted supersession whose phase is
  // still open. Whether one on a checked task is history is decided below, on
  // evidence only, never on the checkmark or log age alone.
  const open=ai.filter(run=>run.supersededBy===null&&OPEN.includes(run.phase));
  // A run of a checked or dropped task is history only with evidence that
  // nothing is in flight and no activity is recent: a verified terminal state
  // with no journaled-but-unfinished effect, or an intact chain that journaled
  // the task commit. Pending effects, recent activity and anything unproven stay
  // open, so they are waited on or checked.
  const quiet=run=>run.idleMinutes===null||run.idleMinutes>=IDLE_MINUTES;
  const history=run=>{
    const task=taskOf.get(`${slug(run.feature??'')}/${run.taskId}`);
    if(!task||!(task.completed||task.dropped)||!quiet(run))return false;
    return run.verified?run.phase==='stopped':run.chainVerified===true&&run.committedClaim===true;
  };
  for(const run of open){
    const task=taskOf.get(`${slug(run.feature??'')}/${run.taskId}`);
    if(task?.completed&&run.verified)inconsistencies.push({kind:'checked_with_open_run',feature:task.feature,task:task.id,runId:run.runId});
  }
  const settledHistory=new Set(open.filter(history).map(run=>run.runId));
  const table=features.map(feature=>({name:feature.name,error:feature.error??null,tasks:feature.tasks.map(task=>{
    const mine=open.filter(run=>!settledHistory.has(run.runId)&&sameTask(run,{feature:feature.name,taskId:task.id}));
    if(mine.length>1)inconsistencies.push({kind:'multiple_open_runs',feature:feature.name,task:task.id,runs:mine.map(r=>r.runId)});
    const committed=ai.find(run=>run.supersededBy===null&&run.verified&&run.committed&&sameTask(run,{feature:feature.name,taskId:task.id}));
    if(!task.completed&&!task.dropped&&committed)
      inconsistencies.push({kind:'commit_without_check',feature:feature.name,task:task.id,runId:committed.runId});
    const shown=[...mine].sort((a,b)=>(at(b.lastEventAt)??0)-(at(a.lastEventAt)??0))[0]??null;
    const status=task.dropped?'dropped':task.completed?'done':mine.some(r=>r.phase==='stopped')?'stopped':mine.length?'in_run':'todo';
    return {id:task.id,status,dependsOn:task.dependsOn,runIds:mine.map(r=>r.runId),runId:shown?.runId??null,
      verified:shown?.verified??null,runState:shown?.state??null,runCode:shown?.code??null,attempt:shown?.attempt??null,
      pending:shown?.pending??null,lastEventAt:shown?.lastEventAt??null,idleMinutes:shown?.idleMinutes??null};
  })}));
  // One queue over all open runs and unknown records, then a single next step.
  const how='用该运行的原 PLAN 执行 cm-ai-drive.mjs status，按返回的 pendingAction 处理；账本不重算待办';
  const note=run=>run.verified?'':'（本版本回放不了它的记录，状态未校验）';
  const queue=[];
  for(const run of open){
    const task=taskOf.get(`${slug(run.feature??'')}/${run.taskId}`);
    const base={kind:'attend_run',feature:run.feature,task:run.taskId,runId:run.runId,how};
    if(settledHistory.has(run.runId))continue;
    if(task?.completed||task?.dropped){
      queue.push({rank:0,...base,why:`任务已${task.completed?'勾选':'作废'}，但运行`+(run.pending?`留着未结的 ${run.pending}`
        :!quiet(run)?` ${run.idleMinutes} 分钟前还有活动`:'没有可核验的结束记录')+note(run)});
      continue;
    }
    if(run.phase==='stopped')queue.push({rank:0,...base,why:`运行停在 ${run.state}/${run.code}`});
    else if(run.idleMinutes===null)queue.push({rank:2,...base,why:'运行没有日志活动记录'+note(run)});
    else if(run.idleMinutes>=IDLE_MINUTES)queue.push({rank:2,...base,idle:run.idleMinutes,
      why:`运行${run.pending?`有未结的 ${run.pending}，`:''} ${run.idleMinutes} 分钟没有新日志`+note(run)});
    else queue.push({rank:3,kind:'wait_run',feature:run.feature,task:run.taskId,runId:run.runId,idle:run.idleMinutes,
      why:`运行${run.pending?`正在执行 ${run.pending}，`:''} ${run.idleMinutes} 分钟前还有活动`+note(run),
      how:`等它推进；超过 ${IDLE_MINUTES} 分钟没有新日志再处理`});
  }
  const unknown=runs.filter(run=>run.kind==='unreadable');
  if(runsError)queue.push({rank:1,kind:'check_records',why:`读不了运行目录（${runsError}），不能确认有没有在途运行`,
    how:'先查 .reviews/.execution 的权限与内容；确认前不建新运行'});
  for(const run of unknown)queue.push({rank:1,kind:'check_records',runId:run.runId,
    why:`运行 ${run.runId} 的记录读不了（${run.code}），不能确认它是否在途`,how:'先人工核对该运行记录；确认前不建新运行'});
  for(const item of inconsistencies.filter(i=>i.kind==='unverified_supersession'))queue.push({rank:1,kind:'check_records',
    runId:item.runId,feature:item.feature,task:item.task,why:`${item.runId} 声称取代 ${item.previous}，但这条取代没法核验`,
    how:'人工核对两条运行记录；核对前两者都视为在途'});
  queue.sort((a,b)=>a.rank-b.rank||(a.rank===3?(a.idle??0)-(b.idle??0):(b.idle??0)-(a.idle??0)));
  const reason=admission.reason??admission.code??null;
  let next;
  if(queue.length){const {rank,idle,...first}=queue[0];next=first;}
  else if(admission.state==='ready')next={kind:'start_task',feature:admission.nextTask.feature,task:admission.nextTask.id,
    why:'没有在途运行；admission 选出的下一个任务',how:'按 cm-ai 流程为该任务建运行'};
  else if(admission.state==='complete')next={kind:'finish',why:'全部任务已完成或作废',how:'按 cm-ai 收尾流程处理 QA 与 run_done'};
  else next={kind:'admission_blocked',reason,why:`admission 返回 ${admission.state}/${reason}`,
    how:'先按 admission 的原因处理（规格审批、漂移、依赖等）'};
  const others=runs.filter(run=>run.kind!=='cm-ai').map(run=>({runId:run.runId,kind:run.kind,...(run.code?{code:run.code}:{})}));
  return {version:LEDGER_VERSION,specsDir,generatedAt:new Date(nowMs).toISOString(),authority:'journal',
    admission:{state:admission.state,reason,nextTask:admission.nextTask??null,...(admission.detail?{detail:admission.detail}:{}),
      warnings:admission.warnings??[]},
    features:table,runs:ai,otherRuns:others,runsError,inconsistencies,
    queue:queue.slice(1).map(({rank,idle,...item})=>item),log:{present:log.present,invalidLines:log.invalid},next};
}

export function buildLedger({specsDir,codeProject,now=new Date().toISOString()}){
  const root=fs.realpathSync(specsDir);
  const admission=inspectCmAiAdmission({specsDir:root,codeProject});
  const names=fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&/^\d+\.[A-Za-z0-9]/.test(e.name)
    &&fs.existsSync(path.join(root,e.name,'tasks.md'))).map(e=>e.name)
    .sort((a,b)=>Number(a.split('.')[0])-Number(b.split('.')[0])||(a<b?-1:1));
  const {runs,error}=readRuns(root);
  return composeLedger({specsDir:root,admission,features:readFeatureTasks(root,names),runs,runsError:error,
    log:readLogEvents(root),now});
}
