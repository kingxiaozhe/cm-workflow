// One lock per host config file, shared by every CM script that edits it
// (cm-announce-hook, cm-skill-hints enable). Re-reading, merging and replacing
// happen inside the lock, so two CM writers never overwrite each other. Writers
// outside CM do not take it; callers still compare bytes before replacing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const STALE_MS=30000;
export const lockPath=(env,file)=>path.join(path.resolve(env.CM_WORKFLOW_HOME||path.join(env.HOME||os.homedir(),'.cm-workflow')),
  'locks',`${crypto.createHash('sha256').update(path.resolve(file)).digest('hex').slice(0,16)}.lock`);
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);

export class LockBusy extends Error{}

// Runs fn while holding the lock; throws LockBusy after waitMs. A lock left by a
// crashed writer is taken over once it is older than STALE_MS.
export function withConfigLock(env,file,fn,{waitMs=3000,now=()=>Date.now()}={}){
  const lock=lockPath(env,file);
  fs.mkdirSync(path.dirname(lock),{recursive:true});
  const deadline=now()+waitMs;
  let fd;
  for(;;){
    try{fd=fs.openSync(lock,'wx',0o600);break;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      try{if(now()-fs.lstatSync(lock).mtimeMs>STALE_MS){fs.unlinkSync(lock);continue;}}catch{/* 刚被释放 */}
      if(now()>=deadline)throw new LockBusy();
      pause(50);
    }
  }
  try{fs.writeSync(fd,String(process.pid));return fn();}
  finally{fs.closeSync(fd);try{fs.unlinkSync(lock);}catch{/* 已被接管 */}}
}
