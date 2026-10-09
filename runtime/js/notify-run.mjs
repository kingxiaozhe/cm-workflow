// Detached launcher for notify.mjs. Runs the user's notify command (no shell)
// with the message in CM_NOTIFY_TITLE/CM_NOTIFY_BODY and one JSON line on
// stdin, kills it after the timeout, and records only failures in notify.log.
// The workflow that started this process never waits for it.
import {spawn} from 'node:child_process';
import {appendNotifyLog} from './notify.mjs';

const [home,hash,event,workflow,timeoutRaw,separator,...command]=process.argv.slice(2);
const timeoutMs=Number(timeoutRaw);
let settled=false,timer=null;
const finish=reason=>{
  if(settled)return;settled=true;clearTimeout(timer);
  if(reason&&home)appendNotifyLog(home,Date.now(),{event,workflow,hash,result:`failed ${reason}`});
  process.exit(0);
};
try{
  if(separator!=='--'||command.length===0||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)finish('runner_arguments');
  const payload=process.env.CM_NOTIFY_PAYLOAD??'{}';
  const env={...process.env};delete env.CM_NOTIFY_PAYLOAD;
  const child=spawn(command[0],command.slice(1),{stdio:['pipe','ignore','ignore'],shell:false,windowsHide:true,env});
  timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}finish('timeout');},timeoutMs);
  child.on('error',error=>finish(`spawn_${String(error.code??'failed').toLowerCase()}`));
  child.on('exit',(code,signal)=>finish(code===0?null:signal?`signal_${signal}`:`exit_${code}`));
  child.stdin.on('error',()=>{});
  child.stdin.end(payload+'\n');
}catch(error){finish(`spawn_${String(error?.code??'failed').toLowerCase()}`);}
