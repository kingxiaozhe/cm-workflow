// Current-conversation projection; the existing config and log writer remain authoritative.
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {loadConfig,resolveRole} from '../../../scripts/cm-workflow-config.mjs';
import {json,need,validIdentity} from './effect-contract.mjs';

const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));

export function resolveHostRole({definition,identity,role,signal,runtime='codex'}){
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  validIdentity(identity);need(['coder','tester'].includes(role),'invalid_role');
  need(!signal.aborted,'cancelled');
  const log=(event,data,detail)=>{
    const result=spawnSync('python3',[writer,'--workflow','cm-ai','--event',event,'--phase','route',
      '--runtime',runtime,'--project-root',definition.codeProject,'--specs-dir',definition.specsDir,
      '--run-id',identity.runId,'--detail',detail,'--data-json',JSON.stringify({node:'N3',
        feature:definition.feature,task:identity.taskId,attempt:identity.attempt,
        repository_id:identity.repositoryId,role,...data})],
    {env:{...process.env,CM_WORKFLOW_LOG_HOME:path.join(definition.specsDir,'.reviews','host-log-mirror')},
      timeout:10000,maxBuffer:1024*1024});
    need(!result.error&&result.status===0&&result.signal===null,'role_log_failed');
    const receipt=JSON.parse(result.stdout.toString('utf8'));
    need(receipt.run_id===identity.runId&&receipt.project_log===path.join(definition.specsDir,'运行日志.jsonl'),'role_log_failed');
  };
  let route;
  try{route=resolveRole(loadConfig({projectRoot:definition.codeProject}),role,runtime);}
  catch{
    // Do not echo parser errors: they can contain user configuration values.
    log('error',{outcome:'invalid_workflow_config'},'Workflow role configuration invalid; no tool request');
    need(false,'invalid_workflow_config');
  }
  log('decision',{adapter:route.adapter,requested_model:route.model,source:route.source,
    purpose:role==='coder'?'implementation':'task_checks',route_state:route.route_state},`Current conversation role: ${role}`);
  if(!['current-runtime','local-tool'].includes(route.route_state))
    log('degrade',{adapter:route.adapter,requested_model:route.model,route_state:route.route_state,
      outcome:'current_conversation_only'},'Requested role adapter not invoked; current conversation tools only');
  // Metadata does not select a model, invoke an adapter, or grant any tool permission.
  need(!signal.aborted,'cancelled');
  return json(route);
}
