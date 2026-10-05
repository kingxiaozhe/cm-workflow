// Runs host-configured, already-authorized project checks. Commands may execute
// project code; specsRoot opts into Codex's native sandbox for that subprocess.
// Without specsRoot this preserves the existing direct host-check behavior.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {types} from 'node:util';
import {StringDecoder} from 'node:string_decoder';
import {cleanEnvironment,specsPermissionArgs} from './codex-config.mjs';
import {json,shape,need,id,text,validCallTimeout,validIdentity} from './effect-contract.mjs';

export function reportHostCheckProgress(event){
  const message=event.phase==='start'?`开始检查 ${event.id}`:
    `检查结束 ${event.id}: ${event.outcome} (exit ${event.exitCode??'unavailable'})`;
  try{process.stderr.write(`[check] ${message}\n`);}catch{/* display is not a check verdict */}
}
export function createHostCheck({cwd,commands,timeoutMs=60000,specsRoot=null,outputIncludes=null,onOutput=null,onProgress=null,reuseDeclared=false}){
  need(typeof reuseDeclared==='boolean','invalid_check_config');
  need(path.isAbsolute(cwd)&&fs.realpathSync(cwd)===cwd&&fs.statSync(cwd).isDirectory());
  validCallTimeout(timeoutMs);
  need(onOutput===null||typeof onOutput==='function');
  need(onProgress===null||typeof onProgress==='function');
  const notify=event=>{
    try{
      const returned=onProgress?.(Object.freeze(event));
      if(types.isPromise(returned))Promise.prototype.then.call(returned,()=>{},()=>{});
    }catch{/* observers cannot change results or prevent cleanup */}
  };
  if(outputIncludes!==null){text(outputIncludes);need(Buffer.byteLength(outputIncludes)<=1000&&!outputIncludes.includes('\0'));}
  const signature=outputIncludes===null?null:Buffer.from(outputIncludes);
  const selected=json(commands,32*1024),ids=new Set();
  need(Array.isArray(selected)&&selected.length>0&&selected.length<=32);
  for(const [index,item] of selected.entries()){
    shape(item,['id','command',...(reuseDeclared&&Object.hasOwn(item,'sameExecutionAs')?['sameExecutionAs']:[])]);id(item.id);need(!ids.has(item.id));ids.add(item.id);
    need(Array.isArray(item.command)&&item.command.length>0);
    for(const arg of item.command){text(arg);need(!arg.includes('\0'));}
    if(Object.hasOwn(item,'sameExecutionAs')){
      const previous=selected[index-1];
      need(previous&&item.sameExecutionAs===previous.id&&JSON.stringify(item.command)===JSON.stringify(previous.command),'check_reuse_binding');
    }
  }
  return async(raw,{signal})=>{
    shape(raw,['identity']);validIdentity(raw.identity);
    need(process.platform!=='win32','process_tree_unsupported');
    const results=[];
    for(const item of selected){
      let signatureMatched=false;
      need(!signal.aborted,'cancelled');
      if(Object.hasOwn(item,'sameExecutionAs')){
        const original=results[results.length-1];need(original?.outcome==='passed','check_reuse_binding');
        const evidence=`same execution as ${original.id}; ${original.evidence}`.slice(0,200);
        notify({phase:'complete',id:item.id,outcome:original.outcome,exitCode:original.exitCode,sameExecutionAs:original.id});
        results.push({id:item.id,command:item.command,outcome:original.outcome,exitCode:original.exitCode,evidence,
          ...(signature?{signatureMatched:original.signatureMatched}:{})});continue;
      }
      notify({phase:'start',id:item.id});
      const result=await new Promise(resolve=>{
        let child;
        try{
          const protectedArgs=specsRoot===null?null:specsPermissionArgs({cwd,specsRoot});
          child=spawn(protectedArgs===null?item.command[0]:'codex',protectedArgs===null?item.command.slice(1):
            ['sandbox','-P','cm-specs','--include-managed-config','-C',cwd,...protectedArgs,'--',...item.command],{cwd,env:cleanEnvironment(),
              shell:false,detached:true,stdio:['ignore','pipe','pipe']});
        }
        catch{resolve({outcome:'unavailable',exitCode:null,evidence:'host check: spawn_failed'});return;}
        let failure=null,cleanup,bytes=0;
        const counts=new Map();
        const collect=line=>{
          const match=line.trim().match(/^[^0-9A-Za-z]*(tests|suites|pass|passed|passing|fail|failed|failing|skipped|todo)\s*[:=]?\s*(\d+)\s*$/i);
          if(match&&counts.size<8&&!counts.has(match[1].toLowerCase()))counts.set(match[1].toLowerCase(),match[2]);
        };
        const kill=name=>{
          if(!Number.isInteger(child.pid)||child.pid<=0)return false;
          try{process.kill(-child.pid,name);return true;}
          catch(error){if(error.code!=='ESRCH')failure??='cleanup_failed';return false;}
        };
        const clean=()=>cleanup??=(kill('SIGTERM')
          ?new Promise(done=>setTimeout(()=>{kill('SIGKILL');done();},1000)):Promise.resolve());
        const stop=reason=>{failure??=reason;clean();};
        const abort=()=>stop('cancelled');
        signal.addEventListener('abort',abort,{once:true});
        const timer=setTimeout(()=>stop('timeout'),timeoutMs);
        if(signal.aborted)abort();
        for(const [streamName,stream] of [['stdout',child.stdout],['stderr',child.stderr]]){
          let tail=Buffer.alloc(0);
          const decoder=new StringDecoder('utf8');let pending='';
          stream.on('data',chunk=>{
            bytes+=chunk.length;if(bytes>4*1024*1024){stop('output_limit');return;}
            if(onOutput){
              try{
                const returned=onOutput({stream:streamName,chunk:Buffer.from(chunk)});
                if(types.isPromise(returned))Promise.prototype.then.call(returned,()=>{},()=>{});
                need(returned===undefined);
              }
              catch{stop('output_capture_failed');return;}
            }
            if(signature&&!signatureMatched){
              const joined=Buffer.concat([tail,chunk]);signatureMatched=joined.includes(signature);
              tail=joined.subarray(Math.max(0,joined.length-signature.length+1));
            }
            const lines=(pending+decoder.write(chunk)).split('\n');pending=lines.pop();
            for(const line of lines)collect(line);
          });
          stream.on('end',()=>collect(pending+decoder.end()));
          stream.on('error',()=>stop('output_read_failed'));
        }
        child.once('error',()=>{failure??='spawn_failed';});
        child.once('exit',clean);
        child.once('close',async(code,exitSignal)=>{
          clearTimeout(timer);signal.removeEventListener('abort',abort);await clean();
          // Keep evidence stable across repeated checks. Raw output can contain
          // credentials and nondeterministic timing; do not put it in review data.
          if(failure||exitSignal||!Number.isInteger(code))resolve({outcome:'unavailable',exitCode:null,
            evidence:`host check: ${failure??'signal_exit'}`});
          else{
            const prefix=`host check exited ${code}`,summary=[];
            for(const [label,count] of counts){
              const item=`${label} ${count}`;
              if(`${prefix} (${[...summary,item].join(', ')})`.length>200)break;
              summary.push(item);
            }
            resolve({outcome:code===0?'passed':'failed',exitCode:code,
              evidence:prefix+(summary.length?` (${summary.join(', ')})`:'')});
          }
        });
      });
      notify({phase:'complete',id:item.id,outcome:result.outcome,exitCode:result.exitCode});
      need(!signal.aborted,'cancelled');
      results.push({id:item.id,command:item.command,...result,...(signature?{signatureMatched}:{})});
      if(result.outcome!=='passed')break;
    }
    return json(results);
  };
}
