// Fixed current-conversation capabilities over the existing N6/N8 adapters.
import fs from 'node:fs';
import path from 'node:path';
import {json,need,shape} from './effect-contract.mjs';
import {createHostQaDecisionProvider} from './host-qa-policy.mjs';
import {createHostQaExecutor} from './host-qa-executor.mjs';

export function readHostWorkflowConfiguration(file){
  const stat=fs.lstatSync(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_workflow_config');
  return validateHostWorkflowConfiguration(JSON.parse(fs.readFileSync(file,'utf8')));
}

export function validateHostWorkflowConfiguration(raw){
  const config=json(raw);
  shape(config,['qa','documentationPaths','applicableAgentFiles']);
  for(const key of ['documentationPaths','applicableAgentFiles'])
    need(Array.isArray(config[key])&&config[key].length<=256&&config[key].every(item=>typeof item==='string'),'invalid_workflow_config');
  if(config.qa!==null)shape(config.qa,['commands','environment']);
  return config;
}

export function createHostWorkflowCapabilities({definition,configuration,bridge,allowQa,runtime='codex',protectedExecution=false,bootstrap=null}){
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  const {specsDir,codeProject,feature,requirements}=definition;
  const logHome=path.join(specsDir,'.reviews','host-log-mirror');
  const result={applicableAgentFiles:configuration.applicableAgentFiles,
    documentationProvider:{timeoutMs:60000,inspect:(request,signal)=>bridge.call('documentation_inspect',request,signal)}};
  if(!protectedExecution&&configuration.documentationPaths.length)result.documentationSync={paths:configuration.documentationPaths,
    run:(request,signal)=>bridge.call('documentation_sync',request,signal)};
  if(configuration.qa!==null){
    need(allowQa===true,'qa_authorization_required');
    result.qaLogHome=logHome;
    result.qaDecisionProvider=createHostQaDecisionProvider({timeoutMs:60000,
      assess:(request,signal)=>bridge.call('qa_assess',request,signal)});
    result.qaExecutor=createHostQaExecutor({specsDir,codeProject,feature,requirements,runtime,
      ...(definition.codeProjects?{codeProjects:definition.codeProjects}:{}),
      ...(bootstrap?{bootstrap:{requirements:bootstrap.configuration.bootstrapRequirements,scope:definition.scope}}:{}),
      ...configuration.qa,timeoutMs:1800000,logHome,
      ...(protectedExecution?{specsRoot:specsDir}:{}),
      logic:(request,signal)=>bridge.call('qa_logic',request,signal),
      browser:(request,signal)=>bridge.call('qa_browser',request,signal)});
  }
  return result;
}
