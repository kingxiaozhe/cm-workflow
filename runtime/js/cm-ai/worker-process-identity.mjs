// Process identity of a detached provider worker (its pid is also its process
// group id) and the host's later check that the whole group is gone. Only a
// definite ESRCH, or a pid that now belongs to a process started at another
// time, proves "gone"; Windows, permission errors and unreadable start times
// stay "unknown" and never grant a redo.
import {spawnSync} from 'node:child_process';

export const MAX_START_TIME_LENGTH=64;
export const validWorkerPid=pid=>Number.isSafeInteger(pid)&&pid>1&&pid<=0x7fffffff;
export const validStartTime=value=>value===null||typeof value==='string'&&value.length>0
  &&value.length<=MAX_START_TIME_LENGTH&&/^[\x20-\x7e]+$/.test(value);

// `ps -o lstart=` in the C locale: a stable, second-resolution start time.
export function readProcessStartTime(pid,{platform=process.platform,run=spawnSync}={}){
  if(platform==='win32'||!validWorkerPid(pid))return null;
  try{
    const result=run('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',timeout:5000,
      env:{...process.env,LC_ALL:'C',LANG:'C'},maxBuffer:4096});
    if(result.error||result.status!==0)return null;
    const value=String(result.stdout).trim().replace(/\s+/g,' ');
    return validStartTime(value)?value:null;
  }catch{return null;}
}

// 'gone' | 'alive' | 'unknown'
export function inspectWorkerGroup({pid,startTime},{platform=process.platform,kill=process.kill.bind(process),
  startTimeOf=value=>readProcessStartTime(value,{platform})}={}){
  if(platform==='win32'||!validWorkerPid(pid)||!validStartTime(startTime))return 'unknown';
  const probe=target=>{try{kill(target,0);return 'present';}catch(error){return error?.code==='ESRCH'?'absent':'unknown';}};
  const group=probe(-pid);
  if(group==='absent')return 'gone';
  if(group==='unknown')return 'unknown';
  // A process group exists under this id. POSIX never reuses a pid while a
  // group with that id still exists, so a leader started at another time
  // means the recorded worker group ended before the pid was reused.
  const leader=probe(pid);
  if(leader==='unknown')return 'unknown';
  if(leader==='absent')return 'alive';
  if(startTime===null)return 'unknown';
  const current=startTimeOf(pid);
  if(current===null)return 'unknown';
  return current===startTime?'alive':'gone';
}
