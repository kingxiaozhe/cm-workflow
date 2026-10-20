#!/usr/bin/env node
// Commander CLI. Phase 1 only reads: it prints the campaign ledger and one next
// step. It never writes tasks.md or a journal, never starts a run and grants nothing.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildLedger} from '../runtime/js/commander/ledger.mjs';

const USAGE=`用法: node scripts/cm-commander.mjs ledger --specs {dir} --code-project {dir} [--json] [--now ISO时间]

只读：汇总 tasks.md、各运行记录与运行日志，给出唯一的下一步。
不写任何文件、不建运行、不授权；每个运行的精确待办仍以它自己的 status 为准。`;

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
    :n.kind==='check_records'?`核对运行记录——${n.why}`:n.why),`  做法：${n.how}`);
  if(ledger.queue.length)lines.push(`  之后还要处理：${ledger.queue.map(t=>t.runId??t.kind).join('，')}`);
  return lines.join('\n');
}

function parse(argv){
  const [command,...rest]=argv,options={};
  for(let i=0;i<rest.length;i++){
    const key=rest[i];
    if(key==='--json'){options.json=true;continue;}
    if(!['--specs','--code-project','--now'].includes(key)||rest[i+1]===undefined)return null;
    options[key.slice(2)]=rest[++i];
  }
  return command==='ledger'&&options.specs&&options['code-project']?options:null;
}

export function main(argv){
  const options=parse(argv);
  if(!options)return {code:2,text:USAGE};
  const ledger=buildLedger({specsDir:path.resolve(options.specs),codeProject:path.resolve(options['code-project']),
    ...(options.now?{now:options.now}:{})});
  return {code:0,text:options.json?JSON.stringify(ledger,null,2):renderLedger(ledger)};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {code,text}=main(process.argv.slice(2));(code===0?process.stdout:process.stderr).write(text+'\n');process.exitCode=code;}
  catch(error){process.stderr.write(`cm-commander: ${error.code??error.message}\n`);process.exitCode=1;}
}
