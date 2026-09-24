#!/usr/bin/env node
// cm-check 请求表（由 cm-check-host.mjs -> runtime/js/cm-check/host.mjs 推导）：
// start: check_runtime；host.mjs start() 调用 bridge.call('check_runtime')。本驾驶员实际运行
//        PLAN.checks 中与 cm-check-entry.mjs createCmCheckInvocation 完全相同的 checker+args。
// start (机械成功且非 --quick): check_semantic；host.mjs start() 的第二个 call，人工判断。
// status/cancel: 无请求；host.mjs handle()。host-session.mjs operationNames 允许 start/status/cancel。
// 该宿主没有持久会话；跨进程 resume 必须拒绝。
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createCmCheckInvocation} from './cm-check-entry.mjs';
import {loadConfig} from './cm-workflow-config.mjs';
import {stderr,stop,readJson,loadPlanFile,requireFields,preflightAnswers,driveHost} from '../runtime/js/cm-ai/drive-core.mjs';

const HOST=fileURLToPath(new URL('./cm-check-host.mjs',import.meta.url));
const KNOWN=new Set(['start','status','cancel']);
const optionalIds=['statusline','updater','subagents','isolated_review','external_browser'];
const obj=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
function valid(ok,label){if(!ok)stop(2,`答案格式错误：${label}`);}
function semantic(value,root){
  valid(obj(value)&&Object.keys(value).sort().join(',')==='checks,optional','check-semantic.json');
  valid(Array.isArray(value.checks)&&value.checks.length===8&&new Set(value.checks.map(x=>x.id)).size===8,'check-semantic.json.checks');
  for(const row of value.checks){
    valid(obj(row)&&Object.keys(row).sort().join(',')==='evidence,findings,id,status'
      &&Number.isInteger(row.id)&&row.id>=1&&row.id<=8
      &&['passed','failed','blocked','not_applicable'].includes(row.status)
      &&Array.isArray(row.evidence)&&Array.isArray(row.findings)&&row.findings.every(nonempty)
      &&(row.status==='passed'?row.findings.length===0&&row.evidence.length>0:row.findings.length>0)
      &&(row.status!=='failed'||row.evidence.length>0)
      &&(row.status!=='not_applicable'||[1,7].includes(row.id)),`check-semantic.json.checks[${row.id}]`);
    for(const evidence of row.evidence){
      valid(obj(evidence)&&Object.keys(evidence).sort().join(',')==='line,path'
        &&typeof evidence.path==='string'&&!path.isAbsolute(evidence.path)
        &&!evidence.path.split('/').includes('..')&&!evidence.path.includes('\\')
        &&Number.isSafeInteger(evidence.line)&&evidence.line>0,`check-semantic.json evidence ${row.id}`);
      const file=path.join(root,evidence.path);
      valid(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&!fs.lstatSync(file).isSymbolicLink()
        &&fs.realpathSync(file).startsWith(root+path.sep)
        &&evidence.line<=fs.readFileSync(file,'utf8').split('\n').length,
      `check-semantic.json evidence ${evidence.path}:${evidence.line}`);
    }
  }
  valid(Array.isArray(value.optional)&&value.optional.length===optionalIds.length
    &&new Set(value.optional.map(x=>x.id)).size===optionalIds.length,'check-semantic.json.optional');
  for(const row of value.optional)valid(obj(row)&&Object.keys(row).sort().join(',')==='id,reason,status'
    &&optionalIds.includes(row.id)&&['configured','degraded','unknown'].includes(row.status)
    &&nonempty(row.reason),'check-semantic.json.optional');
}
function main(){
  if(process.argv.length===3&&['--help','-h'].includes(process.argv[2])){
    process.stdout.write('用法: cm-check-drive.mjs --plan PLAN.json <start|status|cancel>\nPLAN: skillDir, project, optional config/quick, checks:[{command:[checker,...args]}], answers。start 的机械证据由实际命令产生；check-semantic.json 只存人工判断。宿主没有跨进程恢复。\n');return;
  }
  const {plan,operation,base}=loadPlanFile({name:'cm-check-drive.mjs',known:KNOWN});
  requireFields(plan,['skillDir','project']);
  if(plan.mode==='resume')stop(2,'cm-check 宿主没有持久会话，不能 resume');
  const skillDir=path.resolve(base,plan.skillDir),project=path.resolve(base,plan.project);
  const config=plan.config?path.resolve(base,plan.config):undefined;
  let invocation;
  try{invocation=createCmCheckInvocation({skillDir,project,...(config?{config}:{})});}
  catch(error){stop(2,`宿主输入无效: ${error.code??error.message}`);}
  if(config)try{loadConfig({projectRoot:project,configPath:config});}
  catch(error){stop(2,`PLAN.config 无效: ${config}: ${error.message}`);}
  const checks=plan.checks;
  if(operation==='start'){
    if(!Array.isArray(checks)||checks.length!==1||checks[0]?.id!=='check_runtime'
      ||!Array.isArray(checks[0].command)||checks[0].command.some(x=>typeof x!=='string')
      ||JSON.stringify(checks[0].command)!==JSON.stringify([invocation.checker,...invocation.args]))
      stop(2,'步骤 start 会反问 check_runtime，PLAN.checks 缺少与宿主声明完全一致的真实 checker 命令');
  }
  const answers=plan.answers?path.resolve(base,plan.answers):null;
  const answer=preflightAnswers(operation==='start'&&!plan.quick?['check_semantic']:[],kind=>{
    const file=path.join(answers??base,'check-semantic.json');
    const value=readJson(file,kind);
    if(value===undefined)stop(2,`步骤 start 会反问 ${kind}，但答案文件不存在: ${file}`);
    semantic(value,invocation.workflowRoot);return value;
  });
  driveHost({host:HOST,args:['serve','--skill-dir',skillDir,'--project',project,...(config?['--config',config]:[]),...(plan.quick?['--quick']:[])],
    cwd:project,operation,answers:answer,answerFor:row=>{
      if(row.kind==='check_semantic')return {sourceDigest:row.payload.sourceDigest,...answer.check_semantic};
      if(row.kind!=='check_runtime')return null;
      if(JSON.stringify([row.payload?.invocation?.checker,...(row.payload?.invocation?.args??[])])
        !==JSON.stringify(checks[0].command))return null;
      const [command,...args]=checks[0].command;
      const run=spawnSync(command,args,{cwd:project,encoding:'utf8',maxBuffer:16*1024*1024});
      const output=(run.stdout??'')+(run.stderr??'');
      stderr(`实际执行 check_runtime，exit ${run.status??'unavailable'}`);
      return {exitCode:run.error||run.signal?null:run.status,output,
        evidence:`drive actual checker execution: ${command}; exit ${run.status??'unavailable'}${run.error?`; ${run.error.code??run.error.message}`:''}`};
    }});
}
main();
