// Start/route events use the original lock-owning writer, never a competing log.
import path from 'node:path';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig,resolveRole} from '../../../scripts/cm-workflow-config.mjs';
import {json,need} from '../cm-ai/effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
const runtimeFor=configuration=>{
  const runtime=configuration.runtime??'codex';
  need(['codex','claude'].includes(runtime),'invalid_runtime');return runtime;
};
export function logFixEvent({specsRoot,identity,configuration,event,detail,data={},phase=null}){
  const specs=fs.realpathSync(specsRoot),project=fs.realpathSync(configuration.reproduction.cwd);
  const bare=configuration.archiveMode==='bare';
  const result=spawnSync('python3',[writer,'--workflow','cm-fix','--event',event,'--runtime',runtimeFor(configuration),
    '--project-root',project,...(bare?[]:['--specs-dir',specs]),'--run-id',identity.runId,'--detail',detail,
    '--data-json',JSON.stringify({node:'FIX',task:identity.taskId,attempt:identity.attempt,
      repository_id:identity.repositoryId,...data}),...(phase?['--phase',phase]:[])],
  {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(specs,'.reviews','host-log-mirror')},
    timeout:10000,maxBuffer:1024*1024});
  need(!result.error&&result.status===0&&result.signal===null,'fix_log_failed');
  let receipt;try{receipt=JSON.parse(result.stdout.toString('utf8'));}catch{need(false,'fix_log_failed');}
  need(receipt.run_id===identity.runId&&(bare?receipt.project_log===null&&receipt.global_written===true
    &&receipt.global_log.startsWith(path.join(specs,'.reviews','host-log-mirror','runs')+path.sep)
    :receipt.project_log===path.join(specs,'运行日志.jsonl')),'fix_log_failed');
  return json(receipt);
}

export function startFixRun({specsRoot,identity,configuration}){
  const project=configuration.reproduction.cwd,runtime=runtimeFor(configuration);
  let routes;
  try{
    const config=loadConfig({projectRoot:project});
    routes=Object.fromEntries(['coder','tester','reviewer'].map(role=>[role,resolveRole(config,role,runtime)]));
  }catch{need(false,'invalid_workflow_config');}
  const log=(event,detail,data,phase=null)=>logFixEvent({specsRoot,identity,configuration,event,detail,data,phase});
  log('run_start','Initial JS fix stages started',{});
  log('task_start','JS defect task started',{});
  for(const [role,route] of Object.entries(routes)){
    log('decision',`Current conversation fix role: ${role}`,{role,adapter:route.adapter,
      requested_model:route.model,source:route.source,purpose:'fix',route_state:route.route_state},'route');
    if(!['current-runtime','local-tool'].includes(route.route_state))
      log('degrade','Requested fix adapter not invoked; current conversation only',
        {role,adapter:route.adapter,route_state:route.route_state,outcome:'current_conversation_only'});
  }
  return json(routes);
}
