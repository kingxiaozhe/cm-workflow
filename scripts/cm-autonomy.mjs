#!/usr/bin/env node
// Standing "run to the end" authorization (runtime/js/autonomy.mjs).
//   show (default)                         read-only
//   on --response TEXT                     record the person's own words; nothing else grants it
//   off                                    keep the record as autonomy.off.json
//   notify --kind fatal|finished --project PATH --reason TEXT [--session NAME]
//                                          page at once: a fatal stop, or everything finished
import path from 'node:path';
import {readAutonomy,writeAutonomy,clearAutonomy,autonomyHome,AUTO_REOPEN_LIMIT} from '../runtime/js/autonomy.mjs';
import {notify} from '../runtime/js/notify.mjs';
import {createHash} from 'node:crypto';

const usage='usage: cm-autonomy.mjs [show] | on --response TEXT | off | notify --kind fatal|finished --project PATH --reason TEXT [--session NAME]';

function parse(argv){
  const [command='show',...rest]=argv,options={};
  for(let index=0;index<rest.length;index++){
    const key={'--response':'response','--kind':'kind','--project':'project','--reason':'reason','--session':'session'}[rest[index]];
    if(!key||index+1>=rest.length||Object.hasOwn(options,key))throw new Error('invalid arguments');
    options[key]=rest[++index];
  }
  const allowed={show:[],off:[],on:['response'],notify:['kind','project','reason','session']}[command];
  if(!allowed||Object.keys(options).some(key=>!allowed.includes(key)))throw new Error('invalid arguments');
  if(command==='on'&&!options.response?.trim())throw new Error('on needs --response with the person\'s own words');
  if(command==='notify'&&(!['fatal','finished'].includes(options.kind)||!options.project||!options.reason?.trim()))
    throw new Error('notify needs --kind fatal|finished, --project and --reason');
  return {command,...options};
}

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
      action:fatal?`致命问题，已停下：${reason}`:`已全部完成：${reason}`},{env});
    stdout.write(result.sent?'已交给提醒渠道发送。\n':`没有发送（${result.reason}）。\n`);
    return 0;
  }
  const state=readAutonomy(env);
  stdout.write(state.on
    ?`常设授权：开启（${autonomyHome(env)}/autonomy.json）\n用户原话：${state.value.response}\n时间：${state.value.at}\n同一任务自动重开上限：${AUTO_REOPEN_LIMIT} 次\n`
    :`常设授权：关闭（${state.reason==='missing'?'未开启':'文件无效，按关闭处理'}）\n`);
  return 0;
}

if(import.meta.main)process.exitCode=main();
