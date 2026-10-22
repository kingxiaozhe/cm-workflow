#!/usr/bin/env node
// Commander CLI. ledger and preflight only read. dispatch writes only the
// commander's own registry under the CM home; nothing here writes tasks.md or a
// journal, starts a run, or grants anything.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildLedger} from '../runtime/js/commander/ledger.mjs';
import {addDispatch,finishDispatch,readRegistry,openDispatches,registryProblem} from '../runtime/js/commander/dispatch-registry.mjs';
import {commanderPreflight} from './cm-commander-preflight.mjs';

const USAGE=`用法:
  node scripts/cm-commander.mjs ledger --specs {dir} --code-project {dir} [--json] [--now ISO时间]
      只读：汇总 tasks.md、各运行记录、运行日志与派活登记，给出唯一的下一步
  node scripts/cm-commander.mjs preflight --plan {PLAN.json} --operation {将要执行的驾驶步骤} [--json]
      只读：派活前体检（开工体检 + 本步要用的应答是否超限或无改动、设备占用、完成复查的检查漂移）；有 error 退出 1
  node scripts/cm-commander.mjs dispatch add --specs {dir} --label {说明} --deadline-minutes {分钟} [--run-id {id}] [--device {UDID}]
  node scripts/cm-commander.mjs dispatch done --specs {dir} --id {登记号} [--outcome done|failed|abandoned]
  node scripts/cm-commander.mjs dispatch list --specs {dir} [--json]
      派出的活先登记截止时间，结束时登记结果；登记只写在 CM 目录下，不进 specs。

账本与体检都不建运行、不授权；每个运行的精确待办仍以它自己的 status 为准。`;

const STATUS={todo:'待做',in_run:'在跑',stopped:'停住',done:'完成',dropped:'作废'};

export function renderLedger(ledger){
  const lines=[`specs: ${ledger.specsDir}`,`生成时间: ${ledger.generatedAt}（只读汇总，以各运行记录为准）`,''];
  for(const feature of ledger.features){
    const count=status=>feature.tasks.filter(task=>task.status===status).length;
    lines.push(`[${feature.name}] 完成 ${count('done')}，在跑 ${count('in_run')}，停住 ${count('stopped')}，待做 ${count('todo')}，作废 ${count('dropped')}`
      +(feature.error?`（tasks.md 读不了：${feature.error}）`:''));
    for(const task of feature.tasks.filter(task=>['in_run','stopped'].includes(task.status)))
      lines.push(`  ${task.id} ${STATUS[task.status]}：运行 ${task.runIds.join('、')}，${task.verified?`${task.runState}/${task.runCode??"-"}，第 ${task.attempt} 轮`+(task.pending?`，正在执行 ${task.pending}`:''):"状态未校验（本版本回放不了它的记录）"}`
        +(task.idleMinutes===null?'，无日志活动':`，${task.idleMinutes} 分钟前有活动`));
  }
  if(ledger.inconsistencies.length){lines.push('','不一致（以运行记录为准，需人工核对）：');
    for(const item of ledger.inconsistencies)lines.push(`  - ${item.kind}：${item.feature} ${item.task} ${item.runId??item.runs?.join(',')??''}`);}
  const unverified=ledger.runs.filter(run=>!run.verified).length;
  if(unverified)lines.push('',`本版本回放不了记录的运行 ${unverified} 个：只展示任务归属；取代关系只认结构核验过的，完成声明不作数。`);
  if(ledger.runsError)lines.push('',`读不了运行目录：${ledger.runsError}`);
  if(ledger.otherRuns.some(run=>run.kind==='unreadable'))
    lines.push('',`读不了的运行：${ledger.otherRuns.filter(run=>run.kind==='unreadable').map(run=>`${run.runId}(${run.code})`).join('，')}`);
  const n=ledger.next;
  lines.push('','下一步：'+(n.kind==='attend_run'?`处理 ${n.feature} ${n.task} 的运行 ${n.runId}——${n.why}`
    :n.kind==='wait_run'?`等 ${n.feature} ${n.task} 的运行 ${n.runId}——${n.why}`:n.kind==='start_task'?`开始 ${n.feature} ${n.task}——${n.why}`
    :n.kind==='check_records'?`核对运行记录——${n.why}`:n.kind==='overdue_dispatch'?`核对超时的活——${n.why}`
    :n.kind==='wait_dispatch'?`等派出的活——${n.why}`:n.why),`  做法：${n.how}`);
  if(ledger.queue.length)lines.push(`  之后还要处理：${ledger.queue.map(t=>t.runId??t.kind).join('，')}`);
  return lines.join('\n');
}

const DECISION={wait:'等待',spec_change:'规格变更（需用户批准）',human_sync:'人工同步（需用户）',escalate:'交维护者',read_status:'先读 status 再定'};
function renderNext(ledger,lines){
  const n=ledger.next;
  if(n.decision)lines.push(`  决策：${DECISION[n.decision.decision]}——${n.decision.why}`,...n.decision.steps.map(step=>`    · ${step}`),
    ...(n.decision.candidates.length?[`    可能的出口：${n.decision.candidates.join('；')}`]:[]));
}

const FLAGS={ledger:['--specs','--code-project','--now'],preflight:['--plan','--operation'],
  'dispatch add':['--specs','--label','--deadline-minutes','--run-id','--device'],'dispatch done':['--specs','--id','--outcome'],
  'dispatch list':['--specs','--now']};
function parse(argv){
  const command=argv[0]==='dispatch'?`dispatch ${argv[1]}`:argv[0],rest=argv.slice(argv[0]==='dispatch'?2:1);
  if(!FLAGS[command])return null;
  const options={command,devices:[]};
  for(let i=0;i<rest.length;i++){
    const key=rest[i];
    if(key==='--json'){options.json=true;continue;}
    if(!FLAGS[command].includes(key)||rest[i+1]===undefined)return null;
    if(key==='--device')options.devices.push(rest[++i]);else options[key.slice(2)]=rest[++i];
  }
  const required={ledger:['specs','code-project'],preflight:['plan','operation'],'dispatch add':['specs','label','deadline-minutes'],
    'dispatch done':['specs','id'],'dispatch list':['specs']}[command];
  return required.every(key=>options[key])?options:null;
}

export function main(argv){
  const options=parse(argv);
  if(!options)return {code:2,text:USAGE};
  if(options.command==='ledger'){
    const ledger=buildLedger({specsDir:path.resolve(options.specs),codeProject:path.resolve(options['code-project']),
      ...(options.now?{now:options.now}:{})});
    if(options.json)return {code:0,text:JSON.stringify(ledger,null,2)};
    const lines=renderLedger(ledger).split('\n');renderNext(ledger,lines);
    return {code:0,text:lines.join('\n')};
  }
  if(options.command==='preflight'){
    const {findings}=commanderPreflight(path.resolve(options.plan),{operation:options.operation});
    const count=level=>findings.filter(item=>item.level===level).length,errors=count('error'),warns=count('warn'),skipped=count('info');
    const summary=errors+warns?`派活前体检：${errors} 个 error，${warns} 个 warn`+(skipped?`，另有 ${skipped} 项跳过`:'')
      :skipped?`派活前体检完成：已核对的项目没有阻塞，但有 ${skipped} 项跳过，见上`:'派活前体检通过：没有发现可提前识别的阻塞';
    const text=options.json?JSON.stringify({errors,warns,skipped,findings}):[...findings.map(item=>`[${item.level}] ${item.code}: ${item.message}`),summary].join('\n');
    return {code:errors?1:0,text};
  }
  const specs=path.resolve(options.specs);
  if(options.command==='dispatch add'){
    const minutes=Number(options['deadline-minutes']);
    const {id,deadline}=addDispatch(specs,{label:options.label,deadlineMinutes:Number.isInteger(minutes)?minutes:NaN,
      runId:options['run-id']??null,resources:options.devices.map(device=>`device:${device}`)});
    return {code:0,text:options.json?JSON.stringify({id,deadline}):`已登记 ${id}，截止 ${deadline}`};
  }
  if(options.command==='dispatch done'){
    finishDispatch(specs,{id:options.id,...(options.outcome?{outcome:options.outcome}:{})});
    return {code:0,text:`已登记结束 ${options.id}`};
  }
  const registry=readRegistry(specs),open=openDispatches(registry,options.now??new Date().toISOString()),problem=registryProblem(registry);
  if(options.json)return {code:problem?1:0,text:JSON.stringify({open,invalidLines:registry.invalid,torn:registry.torn,error:registry.error,problem})};
  if(problem)return {code:1,text:`派活登记有问题（${problem}），下面只列出能读到的记录，不能当作完整：\n`
    +(open.map(job=>`${job.overdue?'[超时]':'[进行]'} ${job.id} ${job.label}，截止 ${job.deadline}`).join('\n')||'（没有能读到的未结束记录）')};
  return {code:0,text:open.length?open.map(job=>`${job.overdue?'[超时]':'[进行]'} ${job.id} ${job.label}，截止 ${job.deadline}`
    +(job.resources.length?`，占用 ${job.resources.join('、')}`:'')).join('\n'):'没有未结束的登记'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {code,text}=main(process.argv.slice(2));(code===0?process.stdout:process.stderr).write(text+'\n');process.exitCode=code;}
  catch(error){process.stderr.write(`cm-commander: ${error.code??error.message}\n`);process.exitCode=1;}
}
