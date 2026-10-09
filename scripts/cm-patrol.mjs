#!/usr/bin/env node
// 只读巡检：找出「登记过、进程却已不在」的 CM 宿主，合并成一条卡住提醒。
// 宿主活着但没人推进由宿主自己的空转计时负责（runtime/js/cm-ai/host-session.mjs）；
// 这里只抓宿主已死（被杀、崩溃、机器重启）而没来得及收尾的情况。
// 只读 <home>/hosts 下的登记文件和进程是否存在（process.kill(pid,0)），不读日志、
// 不读项目文件、不写任何流程状态；提醒发出后只删除已报告的登记文件。
// 用法：node cm-patrol.mjs           巡检并提醒
//       node cm-patrol.mjs --report  只把结果以 JSON 打到标准输出，不提醒、不删文件
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HOST_REGISTRY_MAX_AGE_MS,hostRegistryDir,notify,readNotifyConfig} from '../runtime/js/notify.mjs';

const NAME=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const MAX_LISTED=6;
const text=value=>typeof value==='string'&&value?value:null;

// A pid the current user cannot signal (EPERM) still exists; only ESRCH is gone.
export function processAlive(pid){
  if(pid===process.pid)return true;
  try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}
}

function readEntry(file){
  try{
    const value=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1)return null;
    if(!Number.isSafeInteger(value.pid)||value.pid<=0)return null;
    const at=Date.parse(value.at);if(!Number.isFinite(at))return null;
    return {file,pid:value.pid,at,sessionKey:text(value.sessionKey),workflow:text(value.workflow)??'cm',project:text(value.project),
      runId:text(value.runId),task:text(value.task),stage:text(value.stage),operation:text(value.operation)};
  }catch{return null;}
}

// {live, dead, stale, invalid}: dead = registered within 48 hours, process gone.
export function inspectHosts({env=process.env,now=Date.now()}={}){
  const result={live:[],dead:[],stale:[],invalid:0};
  let names;
  try{names=fs.readdirSync(hostRegistryDir(env)).filter(name=>NAME.test(name));}catch{return result;}
  for(const name of names){
    const entry=readEntry(path.join(hostRegistryDir(env),name));
    if(!entry){result.invalid++;continue;}
    if(now-entry.at>HOST_REGISTRY_MAX_AGE_MS||entry.at>now)result.stale.push(entry);
    else if(processAlive(entry.pid))result.live.push(entry);
    else result.dead.push(entry);
  }
  return result;
}

const stamp=at=>new Date(at).toISOString().slice(11,16)+'Z';
const line=entry=>[entry.workflow,entry.runId,entry.task,entry.stage??entry.operation,`最后动静 ${stamp(entry.at)}`].filter(Boolean).join(' ');

// One notice for every dead host found in this pass. The key names the set, so
// the same set is not resent within the notice window; reported entries are
// removed so the next pass only sees new ones.
export function patrol({env=process.env,now=Date.now(),report=false}={}){
  const hosts=inspectHosts({env,now});
  const summary={at:new Date(now).toISOString(),live:hosts.live.length,dead:hosts.dead.length,stale:hosts.stale.length,invalid:hosts.invalid,
    deadHosts:hosts.dead.map(entry=>({workflow:entry.workflow,pid:entry.pid,runId:entry.runId,task:entry.task,stage:entry.stage,at:new Date(entry.at).toISOString()}))};
  if(report)return {...summary,notice:'report_only'};
  if(!readNotifyConfig(env))return {...summary,notice:'off'};
  if(hosts.dead.length===0)return {...summary,notice:'none'};
  const dead=[...hosts.dead].sort((a,b)=>a.at-b.at);
  const workflows=new Set(dead.map(entry=>entry.workflow)),projects=new Set(dead.map(entry=>entry.project).filter(Boolean));
  const listed=dead.slice(0,MAX_LISTED).map(line);
  if(dead.length>MAX_LISTED)listed.push(`另有 ${dead.length-MAX_LISTED} 个`);
  const sent=notify({key:`dead|${dead.map(entry=>entry.sessionKey??entry.file).sort().join(',')}`,event:'dead',
    workflow:workflows.size===1?[...workflows][0]:'cm',project:projects.size===1?[...projects][0]:null,
    runId:dead.length===1?dead[0].runId:null,task:dead.length===1?dead[0].task:null,
    stage:`${dead.length} 个宿主进程已不在`,code:'host_process_gone',
    nextAction:`${listed.join('；')}。请回到会话用 status 核对运行状态，需要时按恢复说明接手`},{env,now});
  if(sent.sent||sent.reason==='duplicate')for(const entry of dead){try{fs.unlinkSync(entry.file);}catch{}}
  return {...summary,notice:sent.sent?'sent':sent.reason};
}

if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url)){
  const report=process.argv.includes('--report');
  const result=patrol({report});
  if(report)process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
