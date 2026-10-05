// Existing authoritative logger/lock adapter, no telemetry or execution authority.
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const writer=fileURLToPath(new URL('../../../scripts/cm-log-event.py',import.meta.url));
export function createNativeUsageLog({definition,request,provider,role,workflow='cm-ai'}){
  const identity={call_id:request.invocationId,stage:role==='developer'?'develop':'review',role,
    adapter:provider+'-cli',requested_model:request.requestedModel,source:'native-cli-terminal',purpose:'workflow-execution'};
  let claimed=false,completed=false;
  const write=(event,phase,data)=>{
    try{
      const result=spawnSync('python3',[writer,'--workflow',workflow,'--event',event,'--phase',phase,
        '--runtime',provider,'--project-root',definition.codeProject,...(definition.specsDir?['--specs-dir',definition.specsDir]:[]),
        '--run-id',request.identity.runId,'--detail','Native CLI usage accounting','--data-json',JSON.stringify(data)],
        {encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
      if(result.error||result.status!==0)throw Error('unavailable');return true;
    }catch{try{process.stderr.write('[usage] usage_record_unavailable\n');}catch{}return false;}
  };
  return {
    claimed(){if(claimed)return;claimed=true;write('model_call','claimed',identity);},
    complete(usage,outcome){
      if(completed||!claimed)return;completed=true;
      write('model_usage','complete',{...identity,provider,...usage,outcome,
        feature:definition.feature,task:request.identity.taskId,attempt:request.identity.attempt});
    },
  };
}
