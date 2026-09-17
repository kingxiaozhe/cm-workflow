#!/usr/bin/env node
// Read-only runtime failover aid: report the current CM workflow breakpoint and
// render a continuation brief for the other runtime. This tool never writes
// tasks.md, never marks a task done, and never authorizes completion.
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
// Single source of truth for role primary/standby; shared with the cm-ai host.
import {ROLE_ROUTING} from '../runtime/js/cm-ai/runtime-failover.mjs';

export {ROLE_ROUTING};

export class FailoverError extends Error {
  constructor(message){super(message);this.name='FailoverError';}
}

const TASK_RE=/^T-[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FEATURE_RE=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RUNTIMES=new Set(['codex','claude']);
const READ_LIMIT=1024*1024;


function readTextFile(file,label){
  let info;
  try{info=fs.lstatSync(file);}catch(error){throw new FailoverError(`cannot read ${label}: ${file}: ${error.message}`);}
  if(info.isSymbolicLink())throw new FailoverError(`${label} must not be a symlink: ${file}`);
  if(!info.isFile())throw new FailoverError(`${label} must be a regular file: ${file}`);
  if(info.size>READ_LIMIT)throw new FailoverError(`${label} exceeds the ${READ_LIMIT} byte read limit: ${file}`);
  return fs.readFileSync(file,'utf8');
}

function readDirectory(dir,label){
  let info;
  try{info=fs.lstatSync(dir);}catch(error){throw new FailoverError(`cannot read ${label}: ${dir}: ${error.message}`);}
  if(info.isSymbolicLink())throw new FailoverError(`${label} must not be a symlink: ${dir}`);
  if(!info.isDirectory())throw new FailoverError(`${label} must be a directory: ${dir}`);
  return fs.readdirSync(dir,{withFileTypes:true});
}

// `- [ ] T-001: title` / `- [x] T-002: title`; anything else is prose.
export function parseTasks(text){
  const tasks=[],seen=new Set();
  for(const line of text.split(/\r\n|[\n\r]/)){
    const match=/^[ \t]*-[ \t]+\[([ xX])\][ \t]+(T-[A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*[:：][ \t]*(.*)$/.exec(line);
    if(!match)continue;
    const id=match[2];
    if(!TASK_RE.test(id))continue;
    if(seen.has(id))throw new FailoverError(`tasks.md contains a duplicate task id: ${id}`);
    seen.add(id);
    tasks.push({id,done:match[1].toLowerCase()==='x',title:match[3].trim()});
  }
  if(tasks.length===0)throw new FailoverError('tasks.md declares no `- [ ] T-xxx:` task line');
  return tasks;
}

function parseHandoff(file){
  let payload;
  try{payload=JSON.parse(readTextFile(file,'handoff evidence'));}
  catch(error){
    if(error instanceof FailoverError)throw error;
    throw new FailoverError(`handoff evidence is not valid JSON: ${file}: ${error.message}`);
  }
  if(!payload||typeof payload!=='object'||Array.isArray(payload))
    throw new FailoverError(`handoff evidence must be a JSON object: ${file}`);
  const status=payload.status;
  if(status!=='ready_for_review'&&status!=='blocked')
    throw new FailoverError(`handoff evidence has an unknown status: ${file}`);
  const list=(value)=>Array.isArray(value)?value.filter(item=>typeof item==='string'):[];
  return {status,
    blockers:list(payload.blockers),
    scopeDeviation:list(payload.scope_deviation),
    changedFiles:list(payload.changed_files),
    contentBound:typeof payload.implementation_sha256==='string'};
}

// Review evidence carries a closed YAML header; only the verdict is needed here.
function parseReviewVerdict(file){
  const lines=readTextFile(file,'review evidence').split(/\r\n|[\n\r]/);
  if(lines[0]===undefined||lines[0].trim()!=='---')return null;
  const end=lines.findIndex((line,index)=>index>0&&line.trim()==='---');
  if(end<0)return null;
  for(const line of lines.slice(1,end)){
    const match=/^verdict[ \t]*:[ \t]*(.+)$/.exec(line);
    if(match)return match[1].trim().replace(/^["']+|["']+$/g,'');
  }
  return null;
}

function attemptEvidence(reviewsDir,entries,feature,task){
  const attempts=[];
  for(const attempt of [1,2]){
    const handoffName=`${feature}-${task}-a${attempt}-handoff.json`;
    const reviewName=`${feature}-${task}-r${attempt}.md`;
    const hasHandoff=entries.has(handoffName),hasReview=entries.has(reviewName);
    if(!hasHandoff&&!hasReview)continue;
    attempts.push({attempt,
      handoff:hasHandoff?parseHandoff(path.join(reviewsDir,handoffName)):null,
      handoffPath:hasHandoff?path.join(reviewsDir,handoffName):null,
      verdict:hasReview?parseReviewVerdict(path.join(reviewsDir,reviewName)):null,
      reviewPath:hasReview?path.join(reviewsDir,reviewName):null});
  }
  return attempts;
}

// Exhaustive breakpoint classification. Every branch names the next CM node so
// the receiving runtime resumes at a declared step instead of guessing.
export function classifyBreakpoint(task,attempts){
  if(task.done)return {node:'N5',state:'task_done',summary:'任务已在 tasks.md 标记完成'};
  const last=attempts[attempts.length-1]??null;
  if(last===null)return {node:'N3',state:'not_started',summary:'尚无交接证据，从任务执行开始'};
  if(last.handoff===null)
    return {node:'N3',state:'review_without_handoff',attempt:last.attempt,
      summary:`第 ${last.attempt} 次存在审查文件但缺交接证据，需重建交接`};
  if(last.handoff.status==='blocked')
    return {node:'N3',state:'blocked',attempt:last.attempt,
      summary:`第 ${last.attempt} 次交接为 blocked，需先处理阻塞项`,
      blockers:last.handoff.blockers,scopeDeviation:last.handoff.scopeDeviation};
  if(last.verdict===null)
    return {node:'N4',state:'awaiting_review',attempt:last.attempt,
      summary:`第 ${last.attempt} 次交接已 ready_for_review，等待独立审查`,
      changedFiles:last.handoff.changedFiles,contentBound:last.handoff.contentBound};
  if(last.verdict==='approved')
    return {node:'N5',state:'approved',attempt:last.attempt,
      summary:`第 ${last.attempt} 次审查通过，等待标记完成`};
  if(last.verdict==='changes_requested')
    return last.attempt>=2
      ? {node:'N4',state:'changes_exhausted',attempt:last.attempt,
        summary:'第 2 次审查仍要求修改，重试次数已用尽，需人工介入'}
      : {node:'N3',state:'changes_requested',attempt:last.attempt+1,
        summary:`第 ${last.attempt} 次审查要求修改，进入第 ${last.attempt+1} 次尝试`};
  if(last.verdict==='blocked')
    return {node:'N4',state:'review_blocked',attempt:last.attempt,
      summary:`第 ${last.attempt} 次审查判定 blocked，需人工介入`};
  return {node:'N4',state:'unknown_verdict',attempt:last.attempt,
    summary:`第 ${last.attempt} 次审查结论无法识别，需人工确认`};
}

function inspectFeature(featureDir,feature){
  const tasks=parseTasks(readTextFile(path.join(featureDir,'tasks.md'),'tasks.md'));
  const reviewsDir=path.join(featureDir,'.reviews');
  let entries=new Set();
  if(fs.existsSync(reviewsDir))
    entries=new Set(readDirectory(reviewsDir,'reviews directory').filter(e=>e.isFile()).map(e=>e.name));
  const pending=tasks.filter(task=>!task.done);
  const current=pending[0]??null;
  const breakpoint=current===null
    ? {node:'N6',state:'all_tasks_done',summary:'全部任务已标记完成，进入 QA 评估'}
    : classifyBreakpoint(current,attemptEvidence(reviewsDir,entries,feature,current.id));
  return {feature,featureDir,tasks,
    done:tasks.filter(task=>task.done).length,
    total:tasks.length,
    currentTask:current,
    breakpoint};
}

export function inspectSpecs(specsDir){
  const resolved=path.resolve(specsDir);
  if(fs.existsSync(path.join(resolved,'tasks.md'))){
    const feature=path.basename(resolved);
    if(!FEATURE_RE.test(feature))throw new FailoverError(`unsupported feature directory name: ${feature}`);
    return {specsDir:resolved,features:[inspectFeature(resolved,feature)]};
  }
  const features=[];
  for(const entry of readDirectory(resolved,'specs directory')){
    if(!entry.isDirectory()||!FEATURE_RE.test(entry.name))continue;
    const featureDir=path.join(resolved,entry.name);
    if(!fs.existsSync(path.join(featureDir,'tasks.md')))continue;
    features.push(inspectFeature(featureDir,entry.name));
  }
  if(features.length===0)throw new FailoverError(`no feature with tasks.md found under ${resolved}`);
  return {specsDir:resolved,features};
}

// Binary presence only. A resolvable CLI does not prove quota or auth is usable,
// so the caller must treat `available` as a necessary, not sufficient, signal.
export function probeRuntimes(runtimes=[...RUNTIMES],{run=null}={}){
  const exec=run??((command)=>{
    const result=childProcess.spawnSync(command,['--version'],
      {encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});
    if(result.error)return {ok:false,detail:result.error.code??result.error.message};
    if(result.status!==0)return {ok:false,detail:`exit ${result.status}`};
    return {ok:true,detail:(result.stdout??'').trim().split(/\r?\n/)[0]??''};
  });
  return runtimes.map(runtime=>{
    const outcome=exec(runtime);
    return {runtime,available:outcome.ok===true,
      detail:typeof outcome.detail==='string'?outcome.detail.slice(0,200):''};
  });
}

function renderBrief(report,target){
  const routing=Object.entries(ROLE_ROUTING)
    .map(([role,{primary,standby}])=>`  - ${role}: 主 ${primary} / 备 ${standby}`).join('\n');
  const blocks=report.features.map(feature=>{
    const {breakpoint:point,currentTask:task}=feature;
    const lines=[`## Feature ${feature.feature}（${feature.done}/${feature.total} 任务已完成）`,
      `- specs 目录: ${feature.featureDir}`,
      `- 断点节点: ${point.node}（${point.state}）`,
      `- 断点说明: ${point.summary}`];
    if(task)lines.push(`- 当前任务: ${task.id} — ${task.title}`);
    if(point.attempt!==undefined)lines.push(`- 尝试轮次: 第 ${point.attempt} 次`);
    if(point.blockers?.length)lines.push(`- 阻塞项: ${point.blockers.join('；')}`);
    if(point.scopeDeviation?.length)lines.push(`- 范围偏离: ${point.scopeDeviation.join('；')}`);
    if(point.changedFiles?.length)
      lines.push(`- 已改文件: ${point.changedFiles.join('、')}`,
        `- 内容绑定: ${point.contentBound?'已绑定 implementation_sha256':'缺失，N4 需要重建交接'}`);
    return lines.join('\n');
  });
  return [`# CM 断点交接简报 → ${target}`,'',
    '在目标运行时开启新会话，粘贴本简报，再按其中的断点节点续跑。',
    '',
    `角色主从（${target} 为本次接管方）：`,routing,'',
    ...blocks,'',
    '## 接管约束','',
    '- 本简报只描述落盘状态，不是完成授权；tasks.md 仍是任务状态的唯一真相。',
    '- 续跑方必须自行复跑该任务声明的验证命令，不得沿用本简报里的历史结论。',
    '- N4 独立审查不得由实现者本人完成；跨运行时接管时同样成立。',
    '- 交接证据的 implementation_sha256 与实际文件绑定，任何改动都会使旧审查失效。'].join('\n');
}

function renderStatus(report){
  const lines=[`specs: ${report.specsDir}`];
  for(const feature of report.features){
    lines.push('',`[${feature.feature}] ${feature.done}/${feature.total} 完成`,
      `  断点: ${feature.breakpoint.node} (${feature.breakpoint.state})`,
      `  说明: ${feature.breakpoint.summary}`);
    if(feature.currentTask)lines.push(`  当前任务: ${feature.currentTask.id} — ${feature.currentTask.title}`);
  }
  return lines.join('\n');
}

function parseArgv(argv){
  const options={};
  for(let index=0;index<argv.length;index++){
    const token=argv[index];
    if(!token.startsWith('--'))throw new FailoverError(`unexpected argument: ${token}`);
    const key=token.slice(2);
    if(key==='json'){options.json=true;continue;}
    const value=argv[++index];
    if(value===undefined||value.startsWith('--'))throw new FailoverError(`missing value for --${key}`);
    options[key]=value;
  }
  return options;
}

const USAGE=`用法: node scripts/cm-failover.mjs <command> [options]

命令:
  status   --specs {dir} [--json]        只读报告当前断点
  handoff  --specs {dir} --to {codex|claude} [--json]
                                         生成给另一端的续跑简报
  probe    [--json]                      探测 codex/claude CLI 是否可解析

说明: 本工具只读。它不写 tasks.md、不标记完成、不授权发布，
      probe 的 available 只代表 CLI 可解析，不代表配额或鉴权可用。`;

export function main(argv){
  const [command,...rest]=argv;
  if(command===undefined||command==='--help'||command==='-h')return {text:USAGE,code:0};
  const options=parseArgv(rest);
  if(command==='probe'){
    const results=probeRuntimes();
    return options.json
      ? {text:JSON.stringify({runtimes:results,routing:ROLE_ROUTING},null,2),code:0}
      : {text:results.map(r=>`${r.runtime}: ${r.available?'可解析':'不可用'}${r.detail?` (${r.detail})`:''}`)
        .join('\n')+'\n注意: 可解析 != 配额可用。',code:0};
  }
  if(command!=='status'&&command!=='handoff')throw new FailoverError(`unknown command: ${command}`);
  if(typeof options.specs!=='string')throw new FailoverError('--specs is required');
  const report=inspectSpecs(options.specs);
  if(command==='status')
    return {text:options.json?JSON.stringify(report,null,2):renderStatus(report),code:0};
  if(typeof options.to!=='string'||!RUNTIMES.has(options.to))
    throw new FailoverError('--to must be codex or claude');
  return {text:options.json
    ? JSON.stringify({target:options.to,routing:ROLE_ROUTING,brief:renderBrief(report,options.to),...report},null,2)
    : renderBrief(report,options.to),code:0};
}

const invoked=process.argv[1]!==undefined
  &&fs.realpathSync(process.argv[1])===fs.realpathSync(new URL(import.meta.url).pathname);
if(invoked){
  try{const {text,code}=main(process.argv.slice(2));process.stdout.write(`${text}\n`);process.exit(code);}
  catch(error){
    if(!(error instanceof FailoverError))throw error;
    process.stderr.write(`cm-failover: ${error.message}\n`);process.exit(1);
  }
}
