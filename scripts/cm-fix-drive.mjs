#!/usr/bin/env node
// cm-fix 的驾驶员：替你开宿主、发一条指令、代答宿主的反问、把结果打出来、关进程。
//
// 为什么需要它：cm-fix-host.mjs 是个服务端，靠标准输入一行一行喂 JSON。而 AI 助手每次
// 只能执行一条命令，抱不住一个长活进程，于是每个用它的人——包括模型自己——都得先
// 临时手搓一个中间人。一次真实实跑里就是这么干的，两次配错（走查模块对不上、任务编号
// 重名）根源都在这儿：没有现成的护栏。
//
// 它只是方便，不是放权：能做什么仍由宿主的 --allow-* 开关说了算；它绝不替你编诊断、
// 测试或修复内容，缺哪份答案就停在发指令之前。
//
//   node scripts/cm-fix-drive.mjs --plan PLAN.json <operation>
//
// PLAN.json（路径都相对于 PLAN.json 所在目录）：
//   {
//     "config": "fix-config.json",          宿主配置，格式见 cm-fix-host.mjs --help
//     "cwd": "/abs/project",                 代码根，须等于 config.reproduction.cwd
//     "mode": "create" | "resume",
//     "hostContext": "<当前真实会话 ID>",
//     "originalHostContext": "<旧会话 ID>", 只在换会话恢复时填
//     "runtime": "codex" | "claude",        缺省 codex
//     "reviewConfig": "review.json",         可选
//     "permissions": ["--allow-red-test", ...],   原样传给宿主，不另造一套词
//     "answers": "answers"                   答案目录
//   }
//
// answers/ 里按反问种类放文件，一种一个：
//   learning.json       {status, summary}            恢复时若存档里已有记录会自动复用
//   diagnosis.json      诊断结论对象
//   retrospective.json  {status, candidates, reason}
//   test-edits.json     {"仓库内路径": "本目录下的内容文件"}
//   repair-edits.json   同上
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {fixEvidenceNames} from '../runtime/js/cm-fix/layout.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const HOST=path.join(here,'cm-fix-host.mjs');

// 每个步骤会反问什么。宿主的规矩是「一步做了一半就永远卡住不能重试」，所以答案
// 必须在发指令之前查齐，缺一个都不发——这是驾驶员最要紧的一条护栏。
// design_change_required uses red_test (or test_author_required/author_tests).
// escalation_required uses publish_dossier/finish: neither requests answers.
const ASKS={
  advance:['learning','diagnosis'],
  author_tests:['learning','test-edits'],
  repair:['learning','repair-edits'],
  retrospective:['learning','retrospective'],
  red_test:['learning'],baseline:['learning'],regression:['learning'],
  post_review_regression:['learning'],prepare_revision:['learning'],
};
const READ_ONLY=new Set(['status','final_review_package','completion_evidence','cause_review_package']);
const KNOWN=new Set([...Object.keys(ASKS),...READ_ONLY,'cancel','handoff','publish_review','check_n5',
  'publish_dossier','learning_writeback','walkthrough','finish','final_review','cause_review',
  'recover_final_review','resume']);

const stderr=line=>process.stderr.write(`[drive] ${line}\n`);
const stop=(code,line)=>{stderr(line);process.exit(code);};

function loadPlan(){
  const argv=process.argv.slice(2);
  const at=argv.indexOf('--plan');
  const operation=argv.find((arg,index)=>index!==at&&index!==at+1&&!arg.startsWith('--'));
  if(at===-1||!argv[at+1]||!operation)stop(2,'用法: cm-fix-drive.mjs --plan PLAN.json <operation>');
  if(!KNOWN.has(operation))stop(2,`不认识的步骤 ${operation}；宿主支持的见 cm-fix-host.mjs --help`);
  const planPath=path.resolve(argv[at+1]),base=path.dirname(planPath);
  let plan;
  try{plan=JSON.parse(fs.readFileSync(planPath,'utf8'));}catch(error){stop(2,`读不了 ${planPath}: ${error.code??error.message}`);}
  for(const key of ['config','cwd','mode','hostContext','permissions','answers'])
    if(!Object.hasOwn(plan,key))stop(2,`PLAN 缺少字段 ${key}`);
  if(!['create','resume'].includes(plan.mode))stop(2,'mode 只能是 create 或 resume');
  if(!Array.isArray(plan.permissions)||plan.permissions.some(p=>!/^--allow-[a-z-]+$/.test(p)))
    stop(2,'permissions 必须是 --allow-xxx 形式的数组，原样传给宿主');
  if(plan.originalHostContext&&plan.mode!=='resume')stop(2,'originalHostContext 只在 resume 时有意义');
  const resolve=p=>path.resolve(base,p);
  return {operation,plan,paths:{config:resolve(plan.config),answers:resolve(plan.answers),
    review:plan.reviewConfig?resolve(plan.reviewConfig):null}};
}

function readJson(file,label){
  try{return JSON.parse(fs.readFileSync(file,'utf8'));}
  catch(error){if(error.code==='ENOENT')return undefined;stop(2,`${label} 不是合法 JSON: ${file}`);}
}

// 恢复时宿主要求学习记录和上次一字不差；从存档里读上次记的那份，省掉一个必踩的坑。
// 只读，且宿主仍会自己校验摘要——读错了也只是被宿主拒绝，不会放行。
function recordedLearning(config,cwd){
  const archive=config.specsRoot??path.join(cwd,'docs','fixes');
  const state=path.join(archive,'.reviews','.execution',config.identity.runId,'state.json');
  const stored=readJson(state,'存档');
  const record=stored?.records?.find(row=>row.kind==='result'&&/^fix-learning-/.test(row.id));
  return record?.payload?.application??null;
}

function preflight({operation,plan,paths}){
  const config=readJson(paths.config,'宿主配置');
  if(config===undefined)stop(2,`宿主配置不存在: ${paths.config}`);
  if(path.resolve(plan.cwd)!==path.resolve(config.reproduction?.cwd??''))
    stop(2,`PLAN.cwd 与 config.reproduction.cwd 不一致`);
  const answers={};
  const need=(kind,file)=>{const value=readJson(path.join(paths.answers,file),kind);
    if(value===undefined)stop(2,`步骤 ${operation} 会反问「${kind}」，但答案文件不存在: ${path.join(paths.answers,file)}\n        先把它写好，再来调驾驱员。缺答案而硬发指令，会把这次运行做死。`);
    return value;};
  for(const kind of ASKS[operation]??[]){
    if(kind==='learning'){
      const recorded=plan.mode==='resume'?recordedLearning(config,plan.cwd):null;
      if(recorded){answers.learning=recorded;stderr(`恢复：复用存档里已记的学习记录（${recorded.status}）`);}
      else answers.learning=need('学习记录','learning.json');
    }
    else if(kind==='diagnosis')answers.diagnosis=need('诊断','diagnosis.json');
    else if(kind==='retrospective')answers.retrospective=need('复盘','retrospective.json');
    else{
      const map=need(kind==='test-edits'?'测试内容':'修复内容',`${kind}.json`);
      for(const [target,local] of Object.entries(map)){
        const file=path.join(paths.answers,local);
        if(!fs.existsSync(file))stop(2,`${kind}.json 把 ${target} 指向 ${file}，但那个文件不存在`);
      }
      answers[kind]=map;
    }
  }
  if(plan.mode==='create'){
    // 建运行前的体检：宿主也会查，但这里把「是哪个文件」提前说清。
    const cwd=path.resolve(plan.cwd);
    for(const file of [...(config.testAuthor?.requirements??[]),...(config.repair?.requirements??[]),
      ...(config.redTest?.testFiles??[]),...(config.baseline?.testFiles??[])])
      if(!fs.existsSync(path.join(cwd,file)))stderr(`注意：配置引用的文件不存在 ${file}`);
    const archive=config.specsRoot??path.join(cwd,'docs','fixes');
    for(const name of fixEvidenceNames(config.identity,config)){
      if(!fs.existsSync(path.join(archive,'.reviews',name)))continue;
      if(/-(?:cause-)?r\d+\.md$/.test(name))stderr(`会被拦：${name} 是审查结论，这个任务编号已占住，换一个`);
      else stderr(`注意：${name} 已存在，宿主会把它归档到 .superseded/ 再继续`);
    }
    if(config.protectSpecs){
      const commands=[config.reproduction?.command,config.redTest?.command,...(config.baseline?.commands??[]).map(c=>c.command),
        ...(config.walkthrough?.flows??[]).map(f=>f.command)].filter(Array.isArray);
      for(const command of commands)
        if(command.some(arg=>/(^|\/)(tsx|vitest)$/.test(String(arg))||/\btsx\b|\bvitest\b/.test(String(arg))))
          stderr(`注意：受保护模式的沙箱跑不了 tsx / vitest 这类要开本地 socket 的命令：${command.join(' ')}\n        见 skills/cm-fix/references/js-host.md「同仓 specs 的受保护修复」`);
    }
  }
  return {config,answers};
}

function hostArgs({plan,paths}){
  return [HOST,'serve','--config',paths.config,'--mode',plan.mode,'--host-context',plan.hostContext,'--allow-reproduction',
    ...(plan.originalHostContext?['--original-host-context',plan.originalHostContext]:[]),
    '--runtime',plan.runtime??'codex',
    ...(paths.review?['--review-config',paths.review]:[]),
    ...plan.permissions];
}

function answerFor(row,answers,paths){
  const {kind,payload}=row;
  if(kind==='fix_learning')return {contextDigest:payload.contextDigest,status:answers.learning.status,summary:answers.learning.summary};
  if(kind==='fix_diagnose')return answers.diagnosis;
  if(kind==='fix_retrospective')return answers.retrospective;
  if(kind==='fix_test_author'||kind==='fix_repair'){
    const map=answers[kind==='fix_repair'?'repair-edits':'test-edits'],expected=payload.expected??{};
    const edits=[];
    for(const [target,local] of Object.entries(map)){
      // 路径不在宿主给的范围里：不能硬塞，也不能断线（断线会把运行做死）。
      // 回一个合法的 blocked，运行停在可续的状态，把原因打出来。
      if(!Object.hasOwn(expected,target)){stderr(`${target} 不在宿主本次允许的范围内，回 blocked`);return {outcome:'blocked',edits:[]};}
      edits.push({path:target,beforeSha256:expected[target],content:fs.readFileSync(path.join(paths.answers,local),'utf8')});
    }
    return {outcome:kind==='fix_repair'?'repaired':'authored',edits};
  }
  return null;
}

function main(){
  const loaded=loadPlan();
  const {answers}=preflight(loaded);
  const {operation,plan,paths}=loaded;
  const child=spawn(process.execPath,hostArgs(loaded),{cwd:path.resolve(plan.cwd),stdio:['pipe','pipe','pipe']});
  child.stderr.on('data',chunk=>process.stderr.write(chunk));
  const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
  let done=false;
  readline.createInterface({input:child.stdout}).on('line',line=>{
    let row;try{row=JSON.parse(line);}catch{process.stdout.write(line+'\n');return;}
    if(row.type==='host_ready'){send({requestId:'drive',operation});return;}
    if(row.type==='host_request'){
      const result=answerFor(row,answers,paths);
      if(result===null){
        // 预检没覆盖到的反问：没有安全的应答，只能明说。宿主会把这一步记成 unknown。
        stderr(`宿主问了预检没覆盖的问题 ${row.kind}，无法应答；这一步会留在 unknown`);
        send({type:'host_close',sessionId:row.sessionId});return;
      }
      stderr(`应答 ${row.kind}`);
      send({type:'host_result',sessionId:row.sessionId,callId:row.callId,requestDigest:row.requestDigest,result});
      return;
    }
    if(row.type==='host_response')return;
    if(row.requestId==='drive'){
      done=true;
      process.stdout.write(JSON.stringify(row,null,2)+'\n');
      if(row.result?.stage)stderr(`stage = ${row.result.stage}`);
      if(row.error)stderr(`宿主拒绝：${row.error.code}（真实原因和位置在上面 [host] 那行 diagnostic 里）`);
      process.exitCode=row.error?1:0;
      child.stdin.end();
    }
  });
  child.on('exit',code=>{if(!done){stderr(`宿主在给出结果前退出了，exit ${code}`);process.exitCode=1;}});
}

main();
