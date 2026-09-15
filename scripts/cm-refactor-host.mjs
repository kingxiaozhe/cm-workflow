#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmRefactorHost} from '../runtime/js/cm-refactor/host.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
export async function main(argv=process.argv.slice(2)){
  let bridge;
  try{
    if(argv.length===1&&argv[0]==='--help'){
      process.stdout.write('cm-refactor-host.mjs serve --config ABSOLUTE_JSON\nLight/batch tracks: start/status/cancel/resume/finish over original host JSONL. Durable original review rounds; unknown effects require actual host reconciliation. Judge preparation, assembly and pre-review Learning/rules/memos share N4/N5. No provider, install or Git delivery. See skills/cm-refactor/references/js-host.md.\n');return 0;
    }
    need(argv.length===3&&argv[0]==='serve'&&argv[1]==='--config'&&path.isAbsolute(argv[2]),'invalid_arguments');
    const stat=fs.lstatSync(argv[2]);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'refactor_config_invalid');
    const config=JSON.parse(fs.readFileSync(argv[2],'utf8'));
    need(path.resolve(config.skillDir,'../..','scripts/cm-refactor-host.mjs')===fileURLToPath(import.meta.url),'entry_path_invalid');
    bridge=createHostToolBridge({responseLimit:2*1024*1024});const host=createCmRefactorHost(config,{call:(...args)=>bridge.call(...args)});
    const raw=process.stdin.isTTY&&typeof process.stdin.setRawMode==='function';if(raw)process.stdin.setRawMode(true);
    try{await serveCmAiHost({host,input:process.stdin,output:process.stdout,toolBridge:bridge,inputLimit:2*1024*1024});}finally{if(raw)process.stdin.setRawMode(false);}
    return 0;
  }catch(error){process.stderr.write(JSON.stringify({error:{code:error.code??'refactor_host_failed'}})+'\n');return 1;}
  finally{bridge?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
