// Optional "a person is needed" notices, shared by every workflow.
// Provider-neutral: runs one user-configured local command (no shell) with a
// short message built only from structured fields. It never answers, continues
// or authorizes anything, and a failure never changes a workflow's exit code,
// output or state: it only appends one line to notify.log.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';

export const NOTIFY_LIMITS=Object.freeze({sameKeyMs:6*3600*1000,perMinute:4,perDay:150,
  commandTimeoutMs:15000,titleChars:60,bodyChars:500,defaultWaitMinutes:10});
const LOCK_STALE_MS=30000,LOG_LIMIT=256*1024;

export function notifyHome(env=process.env){
  return path.resolve(env.CM_WORKFLOW_HOME||path.join(os.homedir(),'.cm-workflow'));
}

let warned=false;
const warn=reason=>{
  if(warned)return;warned=true;
  try{process.stderr.write(`[cm-notify] notify.json 无效，卡住提醒已关闭：${reason}\n`);}catch{}
};

// null = feature off. Under `node --test` only an explicit CM_WORKFLOW_HOME
// enables it, so a test suite never reaches the user's real configuration.
export function readNotifyConfig(env=process.env){
  if(env.NODE_TEST_CONTEXT&&!env.CM_WORKFLOW_HOME)return null;
  const file=path.join(notifyHome(env),'notify.json');
  let raw;
  try{raw=fs.readFileSync(file,'utf8');}catch(error){if(error.code!=='ENOENT')warn(`读不了（${error.code??'error'}）`);return null;}
  let value;
  try{value=JSON.parse(raw);}catch{warn('不是合法 JSON');return null;}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1){warn('需要 "version": 1');return null;}
  const {command}=value;
  if(!Array.isArray(command)||command.length<1||command.length>32
    ||!command.every(item=>typeof item==='string'&&item.length>0&&item.length<=4096&&!item.includes('\0'))){
    warn('command 需要 1..32 个非空字符串');return null;
  }
  if(!path.isAbsolute(command[0])){warn('command[0] 必须是绝对路径');return null;}
  const minutes=value.waitMinutes??NOTIFY_LIMITS.defaultWaitMinutes;
  if(typeof minutes!=='number'||!Number.isFinite(minutes)||minutes<=0||minutes>1440){warn('waitMinutes 需要 0..1440 之间的正数');return null;}
  return {command:[...command],waitMs:Math.max(1,Math.round(minutes*60000))};
}

// Messages carry only these structured fields. Absolute paths are redacted and
// control characters removed; every field and the whole message are bounded.
const cut=(text,max)=>{const chars=Array.from(text);return chars.length<=max?text:chars.slice(0,max-1).join('')+'…';};
function clean(value,max){
  if(typeof value!=='string'&&!(typeof value==='number'&&Number.isFinite(value)))return '';
  const text=String(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g,' ')
    .replace(/(^|[\s(（'"=:：,，])~?\/[^\s'"`，。；;、）)]+/g,'$1<路径>')
    .replace(/\s+/g,' ').trim();
  return cut(text,max);
}
const projectName=value=>typeof value==='string'&&value?clean(path.basename(value),40):'';

export function buildNotifyMessage(fields,{now=Date.now()}={}){
  const workflow=clean(fields.workflow,24)||'cm',project=projectName(fields.project);
  const headline={done:'流程已结束',waiting:'等待会话应答'}[fields.event]??'需要人处理';
  const title=cut(`CM ${workflow} ${headline}${project?` · ${project}`:''}`,NOTIFY_LIMITS.titleChars);
  const lines=[['项目',project],['流程',workflow],['运行',clean(fields.runId,64)],['任务',clean(fields.task,40)],
    ['阶段',clean(fields.stage,48)],['原因',clean(fields.code,64)],['下一步',clean(fields.nextAction,200)]]
    .filter(([,value])=>value).map(([label,value])=>`${label}：${value}`);
  lines.push(`时间：${new Date(now).toISOString()}`);
  if(fields.event!=='done')lines.push('CM 不会自动继续，请回到会话处理。');
  return {title,body:cut(lines.join('\n'),NOTIFY_LIMITS.bodyChars)};
}

const keyHash=key=>createHash('sha256').update(key).digest('hex').slice(0,16);
const pause=ms=>{try{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);}catch{}};

function takeLock(file){
  for(let attempt=0;attempt<10;attempt++){
    try{return fs.openSync(file,'wx',0o600);}
    catch(error){
      if(error.code!=='EEXIST')return null;
      try{if(Date.now()-fs.statSync(file).mtimeMs>LOCK_STALE_MS){fs.unlinkSync(file);continue;}}catch{continue;}
      pause(20);
    }
  }
  return null;
}

// Dedup and throttle across processes. Any lock or parse trouble skips the
// notice instead of waiting on it.
function reserve(home,hash,now){
  const lockFile=path.join(home,'notify-state.lock'),stateFile=path.join(home,'notify-state.json');
  const lock=takeLock(lockFile);if(lock===null)return 'state_busy';
  try{
    let state={version:1,keys:{},sends:[]};
    try{state=JSON.parse(fs.readFileSync(stateFile,'utf8'));}
    catch(error){if(error.code!=='ENOENT')return 'state_invalid';}
    if(!state||state.version!==1||!state.keys||typeof state.keys!=='object'||Array.isArray(state.keys)
      ||!Array.isArray(state.sends)||!state.sends.every(Number.isFinite)
      ||!Object.values(state.keys).every(Number.isFinite))return 'state_invalid';
    const keys=Object.fromEntries(Object.entries(state.keys).filter(([,at])=>now-at<NOTIFY_LIMITS.sameKeyMs&&at<=now));
    const sends=state.sends.filter(at=>now-at<24*3600*1000&&at<=now);
    if(Object.hasOwn(keys,hash))return 'duplicate';
    if(sends.filter(at=>now-at<60000).length>=NOTIFY_LIMITS.perMinute)return 'rate_minute';
    if(sends.length>=NOTIFY_LIMITS.perDay)return 'rate_day';
    keys[hash]=now;sends.push(now);
    const temp=`${stateFile}.${process.pid}.${randomUUID()}.tmp`;
    try{fs.writeFileSync(temp,JSON.stringify({version:1,keys,sends}),{mode:0o600});fs.renameSync(temp,stateFile);}
    catch{try{fs.unlinkSync(temp);}catch{}return 'state_write_failed';}
    return 'ok';
  }finally{try{fs.closeSync(lock);}catch{}try{fs.unlinkSync(lockFile);}catch{}}
}

function log(home,now,{event,workflow,hash,result}){
  try{
    const file=path.join(home,'notify.log');
    try{if(fs.statSync(file).size>LOG_LIMIT)fs.renameSync(file,`${file}.1`);}catch{}
    fs.appendFileSync(file,`${new Date(now).toISOString()} ${clean(event,12)||'stuck'} ${clean(workflow,24)||'cm'} key=${hash} ${result}\n`,{mode:0o600});
  }catch{}
}

function runCommand(command,message,payload,env,timeoutMs){
  return new Promise(resolve=>{
    let settled=false,timer=null,child;
    const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);resolve(result);};
    try{
      child=spawn(command[0],command.slice(1),{stdio:['pipe','ignore','ignore'],shell:false,windowsHide:true,
        env:{...env,CM_NOTIFY_TITLE:message.title,CM_NOTIFY_BODY:message.body}});
    }catch(error){finish({ok:false,reason:`spawn_${String(error.code??'failed').toLowerCase()}`});return;}
    timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish({ok:false,reason:'timeout'});},timeoutMs);
    child.on('error',error=>finish({ok:false,reason:`spawn_${String(error.code??'failed').toLowerCase()}`}));
    child.on('exit',(code,signal)=>finish(code===0?{ok:true}:{ok:false,reason:signal?`signal_${signal}`:`exit_${code}`}));
    child.stdin.on('error',()=>{});
    try{child.stdin.end(JSON.stringify(payload)+'\n');}catch{}
  });
}

// Never throws. Resolves {sent, reason}.
export async function notify(fields,{env=process.env,now=Date.now(),timeoutMs=NOTIFY_LIMITS.commandTimeoutMs}={}){
  try{
    const config=readNotifyConfig(env);if(!config)return {sent:false,reason:'off'};
    if(typeof fields?.key!=='string'||!fields.key)return {sent:false,reason:'invalid_key'};
    const home=notifyHome(env),hash=keyHash(fields.key);
    const reserved=reserve(home,hash,now);
    if(reserved!=='ok'){
      if(reserved!=='duplicate')log(home,now,{...fields,hash,result:`skipped ${reserved}`});
      return {sent:false,reason:reserved};
    }
    const message=buildNotifyMessage(fields,{now});
    const payload={...message,event:fields.event??'stuck'};
    for(const name of ['project','workflow','runId','task','stage','code','nextAction']){
      const value=name==='project'?projectName(fields.project):clean(fields[name],name==='nextAction'?200:64);
      if(value)payload[name]=value;
    }
    const result=await runCommand(config.command,message,payload,env,timeoutMs);
    if(!result.ok){log(home,now,{...fields,hash,result:`failed ${result.reason}`});return {sent:false,reason:result.reason};}
    return {sent:true,reason:'sent'};
  }catch{return {sent:false,reason:'error'};}
}

// Host side: one notice when a host_request has waited waitMinutes for the
// session's answer. The timer never keeps the process alive.
export function scheduleWaitNotice({kind,callId,workflow,project,env=process.env}){
  try{
    const config=readNotifyConfig(env);if(!config)return null;
    const minutes=Math.max(1,Math.round(config.waitMs/60000));
    const timer=setTimeout(()=>{notify({key:`wait|${workflow}|${callId}`,event:'waiting',workflow,project,stage:kind,
      code:'waiting_session_answer',nextAction:`宿主已等待会话应答约 ${minutes} 分钟，请回到会话处理`},{env});},config.waitMs);
    timer.unref?.();
    return ()=>clearTimeout(timer);
  }catch{return null;}
}

// Driver side: decide from the final host response (or the driver's own stop)
// whether a person is needed. Normal progress returns null; run end returns done.
const STUCK=new Set(['blocked','unknown','unknown_verdict','review_blocked','changes_exhausted','cancelled','failed',
  'denied','rejected','interrupted','escalated','awaiting_human_ruling','unavailable']);
const DONE=new Set(['run_done','all_tasks_done','completed','finished']);
const READ_ONLY=new Set(['status','fix_status','cancel']);
const text=value=>typeof value==='string'&&value?value:null;
export function driveNotice({host,cwd,args=[],operation,row=null,failure=null}){
  if(READ_ONLY.has(operation))return null;
  const workflow=path.basename(String(host??'')).replace(/-host\.mjs$/,'').replace(/\.mjs$/,'')||'cm';
  const result=row?.result&&typeof row.result==='object'?row.result:{};
  const progress=result.progress&&typeof result.progress==='object'?result.progress:{};
  const fields=[result.state,result.status,result.stage,result.outcome].filter(text);
  const code=text(failure)??text(row?.error?.code)??text(result.code)??text(result.blocker)??text(progress.blocker)
    ??text(result.state)??text(result.status)??null;
  const done=!failure&&!row?.error&&(result.finished===true||progress.finished===true
    ||fields.some(value=>DONE.has(value))||['run_done','run_done_degraded'].includes(result.code));
  const stuck=!done&&(Boolean(failure)||Boolean(row?.error)||result.requiresUser===true||progress.requiresUser===true
    ||result.pendingAction==='reconcile'||fields.some(value=>STUCK.has(value))
    ||[code,result.stage].some(value=>typeof value==='string'&&/limit|exhausted/.test(value)));
  if(!done&&!stuck)return null;
  const runId=text(result.identity?.runId)??text(result.runId);
  const task=text(result.identity?.taskId)??text(result.taskId);
  const attempt=Number.isSafeInteger(result.identity?.attempt)?result.identity.attempt:null;
  const stage=text(result.stage)??text(result.state)??text(result.status)??operation??null;
  const run=runId??`args:${keyHash(args.map(String).join('\0'))}`;
  return {key:[workflow,run,task??'',attempt??'',stage??'',done?'done':code??''].join('|'),
    event:done?'done':'stuck',workflow,project:cwd?path.basename(path.resolve(cwd)):null,runId,task,stage,
    code:done?(text(result.code)??'done'):code,
    nextAction:done?null:text(result.guidance?.nextStep)??text(progress.nextAction)??text(result.nextAction)};
}
