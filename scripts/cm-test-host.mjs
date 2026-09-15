#!/usr/bin/env node
// Shared Codex/Claude current-conversation entry. Configuration is supplied by
// the trusted host before startup, never by a test-case/model response.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmTestHost} from '../runtime/js/cm-test/host.mjs';
import {inspectCmTestRecovery} from '../runtime/js/cm-test/recovery.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {need} from '../runtime/js/cm-ai/effect-contract.mjs';
import {openTestSession} from '../runtime/js/cm-test/session.mjs';

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  let bridge,session;
  try{
    if(argv.length===1&&argv[0]==='--help'){
      output.write('Optional serve trailing --session-dir ABS_PRIVATE_DIR preserves the original run and effects. Explicit JSONL resume {resolution:null} consumes recorded results; unknown original host/command results require {key,requestDigest,result,evidence,cleanup:"completed"}. Never redispatch unknown actions. Unknown log/publication writes require manual reconciliation. inspect remains read-only history.\n');
      output.write('cm-test-host.mjs serve --config ABSOLUTE_JSON\ncm-test-host.mjs inspect --config ABSOLUTE_JSON --run-id ID --log-file ABSOLUTE_LOG\nInspect is read-only historical recovery, never command replay. Config: {skillDir,project,runtime,arguments,sources,commands,environment,logHome}. Commands are trusted startup capabilities, not model output. JSONL start/status/cancel; host replies test_cases/qa_logic/qa_browser. No provider or repair. See skills/cm-test/references/js-host.md.\n');return 0;
    }
    const sessionDir=argv[0]==='serve'&&argv.at(-2)==='--session-dir'?argv.at(-1):null;
    if(sessionDir!==null)argv=argv.slice(0,-2);
    const inspecting=argv.length===7&&argv[0]==='inspect'&&argv[3]==='--run-id'&&argv[5]==='--log-file';
    need((inspecting||(argv.length===3&&argv[0]==='serve'))&&argv[1]==='--config'&&path.isAbsolute(argv[2]),'invalid_arguments');
    const stat=fs.lstatSync(argv[2]);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'cm_test_config_invalid');
    const configuration=JSON.parse(fs.readFileSync(argv[2],'utf8'));
    if(inspecting){
      output.write(JSON.stringify(inspectCmTestRecovery(configuration,{runId:argv[4],logFile:argv[6]}))+'\n');return 0;
    }
    need(path.resolve(configuration.skillDir,'../..','scripts/cm-test-host.mjs')===fileURLToPath(import.meta.url),'entry_path_invalid');
    bridge=createHostToolBridge();
    if(sessionDir!==null)session=openTestSession(sessionDir,configuration);
    const host=createCmTestHost(configuration,{call:(...args)=>bridge.call(...args),session});
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    try{await serveCmAiHost({host,input,output,toolBridge:bridge});}finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){error.write(JSON.stringify({error:{code:cause?.code??'cm_test_host_failed'}})+'\n');return 1;}
  finally{bridge?.close();session?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
