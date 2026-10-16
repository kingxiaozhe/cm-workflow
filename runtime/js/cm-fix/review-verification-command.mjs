// Reviewer commands run only in their disposable copy. The authenticated CLI
// never shares its environment or network permission with project test code.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {types} from 'node:util';
import {ownedProcessCleanup} from '../cm-ai/owned-process-cleanup.mjs';

const SYSTEM_READ=['/System/Library','/System/Cryptexes','/usr/bin','/usr/sbin','/usr/lib','/usr/libexec','/usr/share',
  '/bin','/sbin','/Library/Apple','/opt/homebrew/Cellar'];
const SYSTEM_ROOTS=['/System','/usr','/bin','/sbin','/Library','/opt','/private/etc','/private/var/db'];
const unavailable=(code,output='')=>({exitCode:null,outcome:'unavailable',code,output});
const inside=(root,file)=>file===root||file.startsWith(root+path.sep);
function profile(cwd){
  // Homebrew's etc/var may hold local credentials. Only installed formulae are
  // readable, not the entire prefix. A user-installed Node needs one exact file.
  // macOS executable startup needs the root directory itself, not its children.
  const readable=[...SYSTEM_READ,cwd];
  const metadata=new Set(['/','/dev','/System','/usr','/opt','/opt/homebrew']);
  for(const leaf of [cwd,fs.realpathSync(process.execPath)]){
    for(let parent=path.dirname(leaf);;parent=path.dirname(parent)){
      metadata.add(parent);if(parent===path.dirname(parent))break;
    }
  }
  return `(version 1)(allow default)
    (deny file-read*)(deny file-write*)(deny network*)(deny signal)(deny mach-lookup)
    (allow signal (target children))
    (allow file-read* ${readable.map(p=>`(subpath ${JSON.stringify(p)})`).join(' ')}
      (literal ${JSON.stringify(fs.realpathSync(process.execPath))})
      (literal "/")
      (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))
    (allow file-read-metadata ${[...metadata].map(p=>`(literal ${JSON.stringify(p)})`).join(' ')} (subpath "/opt/homebrew/opt")
      (subpath "/opt/homebrew/bin") (subpath "/opt/homebrew/sbin"))
    (allow file-write* (subpath ${JSON.stringify(cwd)}) (literal "/dev/null"))`;
}

export async function runVerificationCommand({cwd,command,timeoutMs,signal,onSpawn=null,onClose=null}){
  try{
    if(typeof cwd!=='string'||!path.isAbsolute(cwd)||path.resolve(cwd)!==cwd
      ||fs.realpathSync(cwd)!==cwd||!fs.lstatSync(cwd).isDirectory()
      ||cwd===path.parse(cwd).root||SYSTEM_ROOTS.some(root=>inside(cwd,root)||inside(root,cwd))
      ||inside(cwd,fs.realpathSync(os.homedir()))||inside(cwd,fs.realpathSync(os.tmpdir()))
      ||cwd==='/private/tmp')
      return unavailable('verification_path_invalid');
  }catch{return unavailable('verification_path_invalid');}
  if(!Array.isArray(command)||command.length===0||command.length>128
    ||command.some(arg=>typeof arg!=='string'||arg.length===0||arg.includes('\0')||Buffer.byteLength(arg)>32768)
    ||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000
    ||!signal||typeof signal.addEventListener!=='function'
    ||[onSpawn,onClose].some(fn=>fn!==null&&typeof fn!=='function'))return unavailable('verification_command_invalid');
  if(process.platform!=='darwin'||!fs.existsSync('/usr/bin/sandbox-exec'))
    return unavailable('verification_isolation_unsupported');
  if(signal.aborted)return unavailable('verification_cancelled');
  let scratch;
  try{
    scratch=fs.mkdtempSync(path.join(cwd,'.cm-review-command-'));
    fs.chmodSync(scratch,0o700);
    const home=path.join(scratch,'home'),tmp=path.join(scratch,'tmp');
    fs.mkdirSync(home,{mode:0o700});fs.mkdirSync(tmp,{mode:0o700});
    const env={PATH:[path.dirname(fs.realpathSync(process.execPath)),'/usr/bin','/bin','/usr/sbin','/sbin','/opt/homebrew/bin'].join(':'),
      HOME:home,TMPDIR:tmp,LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
    return await new Promise(resolve=>{
      let child;
      try{child=spawn('/usr/bin/sandbox-exec',['-p',profile(cwd),...command],
        {cwd,env,shell:false,detached:true,stdio:['ignore','pipe','pipe']});}
      catch{resolve(unavailable('verification_spawn_failed'));return;}
      const cleanup=ownedProcessCleanup(child);
      let failure=null,bytes=0,retained=Buffer.alloc(0),settled=false,closeSeen=false,drainTimer,cleanupSucceeded=false;
      const notify=fn=>{
        if(fn===null||!Number.isInteger(child.pid))return;
        const result=fn(child.pid);
        if(types.isPromise(result))Promise.prototype.then.call(result,()=>{},()=>{});
        if(result!==undefined)throw Error('verification_observer_failed');
      };
      const clean=()=>cleanup().then(()=>{cleanupSucceeded=true;}).catch(()=>{failure='verification_cleanup_unknown';});
      // A detached descendant can keep pipe descriptors open after its leader
      // exits. Bound that wait too; never infer successful cleanup from silence.
      const drain=()=>{if(closeSeen||settled)return;drainTimer??=setTimeout(()=>{
        if(closeSeen||settled)return;
        failure='verification_cleanup_unknown';child.stdout.destroy();child.stderr.destroy();
        void finish(null,null);
      },1500);};
      const stop=code=>{failure??=code;void clean().then(drain);};
      const abort=()=>stop('verification_cancelled');
      const timer=setTimeout(()=>stop('verification_timeout'),timeoutMs);
      signal.addEventListener('abort',abort,{once:true});
      if(signal.aborted)abort();
      for(const stream of [child.stdout,child.stderr]){
        stream.on('data',chunk=>{
          bytes+=chunk.length;
          if(retained.length<8192)retained=Buffer.concat([retained,chunk.subarray(0,8192-retained.length)]);
          if(bytes>4*1024*1024)stop('verification_output_limit');
        });
        stream.on('error',()=>stop('verification_output_failed'));
      }
      child.once('error',()=>stop('verification_spawn_failed'));
      child.once('exit',()=>{void clean().then(drain);});
      const finish=async(exitCode,exitSignal)=>{
        if(settled)return;settled=true;
        clearTimeout(timer);clearTimeout(drainTimer);signal.removeEventListener('abort',abort);await clean();
        if(cleanupSucceeded&&failure!=='verification_cleanup_unknown'){
          try{notify(onClose);}catch{failure='verification_observer_failed';}
        }
        const output=retained.toString('utf8').slice(0,8192);
        if(failure){resolve(unavailable(failure,output));return;}
        if(exitSignal||!Number.isInteger(exitCode)){resolve(unavailable('verification_signal_exit',output));return;}
        if(exitCode!==0&&/^sandbox-exec:/m.test(output)){resolve(unavailable('verification_isolation_failed',output));return;}
        resolve({exitCode,outcome:exitCode===0?'passed':'failed',code:null,output});
      };
      child.once('close',(exitCode,exitSignal)=>{closeSeen=true;void finish(exitCode,exitSignal);});
      try{notify(onSpawn);}catch{stop('verification_observer_failed');}
    });
  }catch{return unavailable('verification_isolation_failed');}
  finally{if(scratch)try{fs.rmSync(scratch,{recursive:true,force:true});}catch{/* private disposable copy remains caller-owned */}}
}
