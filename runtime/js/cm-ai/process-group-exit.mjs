// Whether a process group we spawned (detached, so its id is our direct child's pid)
// has really stopped: the writer-stopped proof behind every owned cleanup.
//
// Measured on macOS 26 (2026-10-27): a group whose only member is our own child that
// already exited but is not reaped yet (a zombie) answers kill(-pgid, 0|SIGTERM) with
// EPERM, and ESRCH after the reap; a group with any live member accepts the signal.
// So EPERM alone proves nothing (it is also what a live member we may not signal
// returns). It counts as stopped only when our direct child's exit has been observed
// and the process table then lists no member of the group that is not a zombie
// (zombies cannot write). Anything that cannot be proven stays unknown.
import {spawnSync} from 'node:child_process';

const unknown=()=>Object.assign(new Error('process_cleanup_unknown'),{code:'process_cleanup_unknown'});

// The group's members as [{pid,stat}], or null when the table cannot be read
// (no ps, a sandbox refusal, an unparseable line).
export function listProcessGroup(pgid,{run=spawnSync}={}){
  let result;
  try{result=run('ps',['-A','-o','pid=,pgid=,stat='],{encoding:'utf8',timeout:5000,maxBuffer:16*1024*1024,
    env:{...process.env,LC_ALL:'C'}});}
  catch{return null;}
  if(!result||result.error||result.status!==0||result.signal||typeof result.stdout!=='string')return null;
  const members=[];
  for(const line of result.stdout.split('\n')){
    if(!line.trim())continue;
    const match=/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
    if(!match)return null;
    if(Number(match[2])===pgid)members.push({pid:Number(match[1]),stat:match[3]});
  }
  return members;
}

const exited=child=>Number.isInteger(child?.exitCode)||typeof child?.signalCode==='string';
// Our direct child's exit, observed (Node emits 'exit' after reaping it). A child
// object without exit tracking can never prove it.
function childExit(child,waitMs){
  if(exited(child))return Promise.resolve(true);
  if(typeof child?.once!=='function')return Promise.resolve(false);
  return new Promise(resolve=>{
    const done=()=>{clearTimeout(timer);resolve(true);};
    const timer=setTimeout(()=>{child.off?.('exit',done);resolve(exited(child));},waitMs);
    child.once('exit',done);
  });
}

// Signal the group of our detached child: 'sent' (a member received it) or 'gone'
// (no member left that could act); throws process_cleanup_unknown otherwise.
export async function signalOwnedGroup(child,signal,{killProcess=process.kill.bind(process),listGroup=listProcessGroup,exitWaitMs=1000}={}){
  const send=()=>{
    try{killProcess(-child.pid,signal);return 'sent';}
    catch(error){return error?.code==='ESRCH'?'gone':error?.code==='EPERM'?'denied':'error';}
  };
  const first=send();
  if(first==='sent'||first==='gone')return first;
  if(first==='error'||!await childExit(child,exitWaitMs))throw unknown();
  const again=send();
  if(again==='sent'||again==='gone')return again;
  if(again==='error')throw unknown();
  const members=listGroup(child.pid);
  if(Array.isArray(members)&&members.every(member=>typeof member.stat==='string'&&member.stat.startsWith('Z')))return 'gone';
  throw unknown();
}
