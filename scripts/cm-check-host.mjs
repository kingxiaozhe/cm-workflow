#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {createCmCheckHost} from '../runtime/js/cm-check/host.mjs';

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  let bridge;
  try{
    if(argv.length===1&&argv[0]==='--help'){
      output.write('cm-check-host.mjs serve --skill-dir ABS_PATH --project ABS_PATH [--config ABS_PATH]\nJSONL start/status/cancel. Current host executes check_runtime once using the existing platform checker; only exitCode 0 permits check_semantic. Eight original groups + optional degradation; complete coverage and local evidence required. No provider, install, repair, task completion or persistent state. Unknown/disconnected operations never retry.\n');return 0;
    }
    need(argv[0]==='serve'&&(argv.length===5||argv.length===7),'invalid_arguments');const request={};
    for(let i=1;i<argv.length;i+=2){
      need(['--skill-dir','--project','--config'].includes(argv[i])&&argv[i+1],'invalid_arguments');
      const key=argv[i]==='--skill-dir'?'skillDir':argv[i].slice(2);need(!Object.hasOwn(request,key),'invalid_arguments');request[key]=argv[i+1];
    }
    need(path.resolve(request.skillDir??'', '../..','scripts/cm-check-host.mjs')===fileURLToPath(import.meta.url),'entry_path_invalid');
    bridge=createHostToolBridge();const host=createCmCheckHost(request,{call:(...args)=>bridge.call(...args)});
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    try{await serveCmAiHost({host,input,output,toolBridge:bridge});}finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){error.write(JSON.stringify({error:{code:cause?.code??'check_host_failed'}})+'\n');return 1;}
  finally{bridge?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
