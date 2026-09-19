#!/usr/bin/env node
// Current-conversation transport for the existing batch driver, not a new loop.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCmAiBatch} from './cm-ai-batch-run.mjs';
import {createConversationExecution,readConversationReviewConfiguration,readConversationProtection,runReviewPreflight} from './cm-ai-host.mjs';
import {loadConfig,resolveProtectedRuntimes} from './cm-workflow-config.mjs';
import {preflightMatches} from '../runtime/js/cm-ai/worker-codex.mjs';
import {claudePreflightMatches} from '../runtime/js/cm-ai/worker-claude.mjs';
import {createHostToolBridge} from '../runtime/js/cm-ai/host-tool-bridge.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {validateHostWorkflowConfiguration,featureHasBrowserCases,readBrowserCapability} from '../runtime/js/cm-ai/host-workflow-capabilities.mjs';
import {digest,json,need,shape} from '../runtime/js/cm-ai/effect-contract.mjs';

const usage='cm-ai-batch-host.mjs serve --config PATH --host-context ID --allow-development [--runtime codex|claude] [--review-config PATH] [--allow-review FEATURE/TASK:1|2]... [--allow-qa] [--browser-qa available|unavailable] [--protected-conversation-config PATH | --protected-config PATH] [--allow-provider-development FEATURE/TASK:1|2]...';
const safeCode=error=>typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:'batch_host_failed';

async function memberReviewConfiguration(batch,definition,review,runtime){
  try{
    need(review!==null,'review_configuration_required');
    const options={cwd:definition.codeProject,model:review.model,disabledSkills:review.disabledSkills,promptTransport:'stdin'};
    const matches=config=>config.model===review.model&&digest(config.disabledSkills)===digest(review.disabledSkills)
      &&(runtime==='claude'?claudePreflightMatches:preflightMatches)(config.preflight,options);
    const directory=path.join(batch.specsDir,'.reviews','.execution',batch.batchId);
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    need(fs.realpathSync(directory)===directory,'invalid_preflight_cache');
    const file=path.join(directory,`preflight-${definition.identity.taskId}.json`);
    if(fs.existsSync(file)){
      const info=fs.lstatSync(file);need(info.isFile()&&!info.isSymbolicLink(),'invalid_preflight_cache');
      try{const cached=readConversationReviewConfiguration(file);if(matches(cached))return cached;}
      catch{/* Invalid or obsolete diagnostics require a fresh loopback, never a rewritten fingerprint. */}
    }
    const config=await runReviewPreflight(definition,{model:review.model,runtime,disabledSkills:review.disabledSkills});
    need(matches(config),'review_preflight_failed');
    const temporary=`${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary,JSON.stringify(config)+'\n',{flag:'wx',mode:0o600});
    try{fs.renameSync(temporary,file);}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
    return config;
  }catch{need(false,'review_preflight_failed');}
}

export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(usage+'\nOptional --protected-conversation-config PATH uses the shared current-host scoped text proposals and native sandbox checks; {checkCommands,timeoutMs}. No extra model call, same Codex/Claude runtime and per-task Review permissions. Optional --protected-config PATH {model,checkCommands,timeoutMs} enables CLI development only for per-task --allow-provider-development FEATURE/TASK:1|2 grants; mutually exclusive with --protected-conversation-config. Optional bundle.bootstraps maps approved bootstrap task keys to {selection}; --allow-bootstrap-write grants only those fixed instruction/scaffold steps. Optional batch.codeProjects uses prefixed paths and checks with codeProject per command; one task remains one completion gate.\nBatch entry requires a clean Git main checkout (including untracked files); batch_main_dirty lists dirty files before any task or worktree starts. Serial tasks are committed automatically before batch_handoff, with task_commit recording the SHA (null if unchanged). Terminal parallel members preserve WIP on their retained branches and fall back once to serial generation 2 after ready members merge.\n');return 0;}
  let bridge;
  try{
    need(argv.length>=6&&argv[0]==='serve'&&argv[1]==='--config'&&argv[3]==='--host-context'
      &&argv[5]==='--allow-development','host_launch_authorization_required');
    const stat=fs.lstatSync(argv[2]);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_batch_config');
    const bundle=json(JSON.parse(fs.readFileSync(argv[2],'utf8')));shape(bundle,['batch','workflows',...(Object.hasOwn(bundle,'bootstraps')?['bootstraps']:[])]);
    const {batch,workflows,bootstraps=null}=bundle;need(Array.isArray(batch.tasks),'invalid_batch_config');
    need(workflows!==null&&typeof workflows==='object'&&!Array.isArray(workflows),'invalid_batch_config');
    const keys=batch.tasks.map(task=>`${task.feature}/${task.taskId}`);
    if(bootstraps!==null){
      need(typeof bootstraps==='object'&&!Array.isArray(bootstraps),'invalid_bootstrap_config');
      for(const [key,config] of Object.entries(bootstraps)){
        need(keys.includes(key)&&key.startsWith('0.bootstrap/'),'bootstrap_task_required');shape(config,['selection']);
      }
    }
    need(keys.length===Object.keys(workflows).length&&keys.every(key=>Object.hasOwn(workflows,key)),'workflow_task_mismatch');
    for(const key of keys)if(workflows[key]!==null)validateHostWorkflowConfiguration(workflows[key]);
    let review=null,allowQa=false,allowBootstrap=false,runtime=null,protection=null,providerConfig=null,browserQaFlag;const approvals=new Set(),developments=new Map();
    for(let index=6;index<argv.length;index++){
      const name=argv[index];
      if(name==='--allow-qa'){need(!allowQa,'invalid_arguments');allowQa=true;}
      else if(name==='--browser-qa'){
        need(browserQaFlag===undefined&&typeof argv[index+1]==='string','invalid_arguments');browserQaFlag=argv[++index];
      }
      else if(name==='--allow-bootstrap-write'){need(!allowBootstrap&&bootstraps!==null,'invalid_arguments');allowBootstrap=true;}
      else if(name==='--protected-conversation-config'){
        need(protection===null&&providerConfig===null&&typeof argv[index+1]==='string','invalid_arguments');protection=readConversationProtection(argv[++index]);
      }
      else if(name==='--protected-config'){
        need(protection===null&&providerConfig===null&&typeof argv[index+1]==='string','invalid_arguments');
        const file=argv[++index],info=fs.lstatSync(file);
        need(info.isFile()&&!info.isSymbolicLink()&&info.size<=64*1024,'invalid_protected_config');
        providerConfig=json(JSON.parse(fs.readFileSync(file,'utf8')));shape(providerConfig,['model','checkCommands','timeoutMs']);
      }
      else if(name==='--allow-provider-development'){
        const approval=argv[++index];need(typeof approval==='string','invalid_arguments');
        const split=approval.lastIndexOf(':'),key=approval.slice(0,split),attempt=approval.slice(split+1);
        need(keys.includes(key)&&['1','2'].includes(attempt),'invalid_arguments');
        need(!developments.has(key),'invalid_arguments');developments.set(key,Number(attempt));
      }
      else if(name==='--runtime'){
        need(runtime===null&&['codex','claude'].includes(argv[index+1]),'invalid_runtime');runtime=argv[++index];
      }
      else if(name==='--review-config'){need(review===null&&typeof argv[index+1]==='string','invalid_arguments');review=readConversationReviewConfiguration(argv[++index]);}
      else if(name==='--allow-review'){
        const approval=argv[++index];need(typeof approval==='string'&&!approvals.has(approval),'invalid_arguments');
        const split=approval.lastIndexOf(':'),key=approval.slice(0,split),attempt=approval.slice(split+1);
        need(keys.includes(key)&&['1','2'].includes(attempt),'review_task_mismatch');approvals.add(approval);
      }else need(false,'invalid_arguments');
    }
    need(!developments.size||providerConfig!==null,'protected_configuration_required');
    // Same launch-time assertion as the single-task host, evaluated across every
    // task whose approved contract can select a browser case.
    readBrowserCapability(browserQaFlag,keys.some(key=>workflows[key]?.qa!=null
      &&featureHasBrowserCases(batch.specsDir,key.slice(0,key.lastIndexOf('/')),batch.codeProject)));
    need(!approvals.size||review!==null,'review_configuration_required');
    need(allowQa||!Object.values(workflows).some(item=>item?.qa!=null),'qa_authorization_required');
    bridge=createHostToolBridge();
    // The current conversation transport accepts one outstanding host call.
    // Queue those calls only; member runners and independent Review stay concurrent.
    let hostCallTail=Promise.resolve();
    const memberBridge={call(...args){
      const pending=hostCallTail.then(()=>bridge.call(...args));
      hostCallTail=pending.then(()=>{},()=>{});return pending;
    }};
    const driver=createCmAiBatch({configuration:batch,logHome:path.join(batch.specsDir,'.reviews','host-log-mirror'),
      runtime:runtime??'codex',checkCommands:(providerConfig??protection)?.checkCommands??null,checkTimeoutMs:(providerConfig??protection)?.timeoutMs??60000,
      executionFor:async(definition,{parallelMember=false}={})=>{
        const key=`${definition.feature}/${definition.identity.taskId}`;
        const attempts=[1,2].filter(attempt=>approvals.has(`${key}:${attempt}`));
        const memberReview=parallelMember?await memberReviewConfiguration(batch,definition,review,runtime??'codex'):review;
        const execution=createConversationExecution(definition,argv[4],parallelMember?memberBridge:bridge,memberReview,attempts,workflows[key],allowQa,runtime??'codex',
          {parallelMember,batchWorkflowsDigest:digest(bootstraps?{workflows,bootstraps}:workflows),qaLogHome:path.join(batch.specsDir,'.reviews','host-log-mirror'),
            // A protected CLI config also protects unauthorized tasks: they stay on the
            // current-session transport but with the same sandbox checks (protected-text edits).
            ...(protection?{protection}:providerConfig?{protection:{checkCommands:providerConfig.checkCommands,timeoutMs:providerConfig.timeoutMs}}:{}),
            ...(developments.has(key)?{
              providerDevelopment:{model:providerConfig.model,attempt:developments.get(key),
                ...resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime??'codex')},
            }:{}),...(bootstraps?.[key]?{bootstrap:{...bootstraps[key],allowWrite:allowBootstrap}}:{})});
        // Bind the entire approved capability map before the first task starts,
        // so a later task's commands/scope cannot silently change during resume.
        return execution;
      }});
    const host={async handle(request){
      try{return await driver.handle(request);}catch(cause){return {outcome:'blocked',code:safeCode(cause)};}
    }};
    const rawMode=input.isTTY&&typeof input.setRawMode==='function';if(rawMode)input.setRawMode(true);
    try{await serveCmAiHost({host,input,output,toolBridge:bridge});}
    finally{if(rawMode)input.setRawMode(false);}
    return 0;
  }catch(cause){error.write(JSON.stringify({error:{code:safeCode(cause)}})+'\n');return 1;}
  finally{bridge?.close();}
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
