#!/usr/bin/env node
// Standing "run to the end" authorization (runtime/js/autonomy.mjs).
//   show (default)                         read-only
//   on --response TEXT                     record the person's own words; nothing else grants it
//   off                                    keep the record as autonomy.off.json
//   notify --kind fatal|finished --project PATH --reason TEXT [--session NAME]
//                                          page at once (never rate limited): a fatal stop, or everything finished
//   check-proposal --specs-dir PATH --proposal FILE
//                                          before any decision: may the standing authorization approve it? (exit 1: no)
//   reopen --project PATH --task N.feature/T-xxx
//                                          take one automatic reopen of the task (exit 1 at the limit: a fatal stop)
import fs from 'node:fs';
import path from 'node:path';
import {readAutonomy,writeAutonomy,clearAutonomy,autonomyHome,takeReopen,readReopens,standingProposalProblem,AUTO_REOPEN_LIMIT} from '../runtime/js/autonomy.mjs';
import {notify} from '../runtime/js/notify.mjs';
import {createHash} from 'node:crypto';

const usage='usage: cm-autonomy.mjs [show] | on --response TEXT | off | notify --kind fatal|finished --project PATH --reason TEXT [--session NAME]'
  +' | check-proposal --specs-dir PATH --proposal FILE | reopen --project PATH --task N.feature/T-xxx';

function parse(argv){
  const [command='show',...rest]=argv,options={};
  for(let index=0;index<rest.length;index++){
    const key={'--response':'response','--kind':'kind','--project':'project','--reason':'reason','--session':'session',
      '--specs-dir':'specsDir','--proposal':'proposal','--task':'task'}[rest[index]];
    if(!key||index+1>=rest.length||Object.hasOwn(options,key))throw new Error('invalid arguments');
    options[key]=rest[++index];
  }
  const allowed={show:[],off:[],on:['response'],notify:['kind','project','reason','session'],
    'check-proposal':['specsDir','proposal'],reopen:['project','task']}[command];
  if(!allowed||Object.keys(options).some(key=>!allowed.includes(key)))throw new Error('invalid arguments');
  if(command==='on'&&!options.response?.trim())throw new Error('on needs --response with the person\'s own words');
  if(command==='notify'&&(!['fatal','finished'].includes(options.kind)||!options.project||!options.reason?.trim()))
    throw new Error('notify needs --kind fatal|finished, --project and --reason');
  if(command==='check-proposal'&&(!options.specsDir||!options.proposal))throw new Error('check-proposal needs --specs-dir and --proposal');
  if(command==='reopen'&&(!options.project||!options.task))throw new Error('reopen needs --project and --task');
  return {command,...options};
}

const readReopensSafe=env=>{try{return readReopens(env);}catch{return {};}};

export function main(argv=process.argv.slice(2),{env=process.env,stdout=process.stdout,stderr=process.stderr}={}){
  let input;
  try{input=parse(argv);}catch(error){stderr.write(`${usage}\nERROR: ${error.message}\n`);return 2;}
  if(input.command==='on'){
    const value=writeAutonomy(input.response,{env});
    stdout.write(`常设授权已开启：一路执行到底，只在致命问题时停下并立即提醒。\n用户原话：${value.response}\n时间：${value.at}\n`);
    return 0;
  }
  if(input.command==='off'){
    stdout.write(clearAutonomy({env})?'常设授权已关闭（记录改名为 autonomy.off.json 保留）。\n':'常设授权本来就没开。\n');
    return 0;
  }
  if(input.command==='notify'){
    const fatal=input.kind==='fatal',project=path.resolve(input.project),reason=input.reason.trim();
    const key=`autonomy|${input.kind}|${project}|${createHash('sha256').update(reason).digest('hex').slice(0,16)}`;
    const result=notify({key,event:fatal?'stuck':'done',workflow:'cm-ai',project,session:input.session,
      code:fatal?'autonomy_fatal_stop':'autonomy_finished',nextAction:reason,
      action:fatal?`致命问题，已停下：${reason}`:`已全部完成：${reason}`},{env,urgent:true});
    // Handed to the channel is not delivered: the channel's own failures go to notify.log.
    if(result.sent){stdout.write('已交给提醒渠道发送（是否送达看手机；发送失败记在 notify.log）。\n');return 0;}
    if(result.reason==='duplicate'){stdout.write('6 小时内已发过同一条提醒，这次不重复发。\n');return 0;}
    stdout.write(`没有发出提醒（${result.reason}）：请直接在会话里告诉用户。\n`);return 1;
  }
  if(input.command==='check-proposal'){
    let problem;
    try{
      const raw=JSON.parse(fs.readFileSync(input.proposal,'utf8')),proposal=raw?.result?.proposal??raw?.proposal??raw;
      const specs=path.resolve(input.specsDir),directories=fs.readdirSync(specs).filter(dir=>/^\d+\./.test(dir)).sort(),files={};
      for(const dir of directories)for(const name of ['requirements.md','design.md','tasks.md','test-cases.json']){
        const file=path.join(specs,dir,name);if(fs.existsSync(file))files[`${dir}/${name}`]=fs.readFileSync(file,'utf8');
      }
      const statusFile=path.join(specs,'.cm-specs-status');
      problem=standingProposalProblem({directories,files,
        ...(fs.existsSync(statusFile)?{status:fs.readFileSync(statusFile,'utf8')}:{})},proposal);
    }catch{problem='读不到提案或规格目录';}
    stdout.write(problem?`不能自行批准：${problem}。这是致命停车：不要发送 decision，先提醒用户。\n`:'可以按常设授权自行批准。\n');
    return problem?1:0;
  }
  if(input.command==='reopen'){
    if(!readAutonomy(env).on){stdout.write('常设授权没开：重开要用户本人同意。\n');return 1;}
    let taken;
    try{taken=takeReopen(input.project,input.task,{env});}catch(error){stderr.write(`ERROR: ${error.message}\n`);return 2;}
    stdout.write(taken.refused?`${input.task} 已自动重开 ${taken.count} 次（上限 ${AUTO_REOPEN_LIMIT}）：这是致命停车，先提醒用户。\n`
      :`可以自动重开：这是 ${input.task} 第 ${taken.count} 次自动重开（上限 ${AUTO_REOPEN_LIMIT}）。--supersede-reason 以「常设授权自动重开第 ${taken.count} 次：」开头。\n`);
    return taken.refused?1:0;
  }
  const state=readAutonomy(env);
  stdout.write(state.on
    ?`常设授权：开启（${autonomyHome(env)}/autonomy.json）\n用户原话：${state.value.response}\n时间：${state.value.at}\n同一任务自动重开上限：${AUTO_REOPEN_LIMIT} 次\n`
      +Object.entries(readReopensSafe(env)).map(([key,count])=>`已自动重开：${key.split('|').pop()} ${count} 次（${key.split('|')[0]}）\n`).join('')
    :`常设授权：关闭（${state.reason==='missing'?'未开启':'文件无效，按关闭处理'}）\n`);
  return 0;
}

if(import.meta.main)process.exitCode=main();
