// Fixed current-conversation capabilities over the existing N6/N8 adapters.
import fs from 'node:fs';
import path from 'node:path';
import {digest,json,need,shape,validIdentity,hex} from './effect-contract.mjs';
import {createHostQaDecisionProvider,readQaCriticalPaths} from './host-qa-policy.mjs';
import {markImplicitQaDecision} from './implicit-qa-decision.mjs';
import {createHostQaExecutor} from './host-qa-executor.mjs';
import {loadConfig} from '../../../scripts/cm-workflow-config.mjs';
import {validateTestCases} from '../../../scripts/validate-test-cases.mjs';
import {QA_ENVIRONMENT_CARRIERS} from './qa-environment.mjs';

// Browser capability is a property of the launching session, not of the project.
// The host cannot probe whether this session can drive a browser; it can only
// require a fresh explicit assertion, so a mismatch surfaces at launch
// instead of at the last QA step. Declaration, not detection.
export function featureHasBrowserCases(specsDir,feature,codeProject){
  const source=path.join(specsDir,feature,'test-cases.json');
  if(!fs.existsSync(source))return false;
  const stat=fs.lstatSync(source);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=1024*1024,'test_cases_invalid');
  const bytes=fs.readFileSync(source);let contract;
  try{contract=json(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}
  catch{need(false,'test_cases_invalid');}
  need(validateTestCases(contract).length===0,'test_cases_invalid');
  const config=loadConfig({projectRoot:codeProject});
  // Match QA applicability before pending tasks defer execution.
  return contract.cases.some(item=>item.kind==='browser'&&(item.blocking||config.policies.tests.includes('browser')));
}

export function readBrowserCapability(value,applicable){
  const carriers=Array.isArray(applicable)?[...new Set(applicable)].sort():applicable?['browser']:[];
  const invalid=reason=>{throw Object.assign(new Error('invalid_arguments'),{code:'invalid_arguments',reason});};
  if(!carriers.every(carrier=>Object.values(QA_ENVIRONMENT_CARRIERS).some(values=>values.includes(carrier))))
    invalid(`QA environment carrier is not supported: ${carriers.join(', ')}`);
  if(carriers.length===0){
    if(value!==undefined)invalid('--browser-qa 只在启用 QA（--workflow-config 的 qa 不为 null）且本 feature 有 blocking 或策略启用的交互式用例时使用；本次没有适用的交互式 QA，去掉 --browser-qa');
    return null;
  }
  const reason=`--browser-qa available|unavailable declares whether this session can run interactive QA for carrier(s): ${carriers.join(', ')}.`;
  if(value===undefined)throw Object.assign(new Error('browser_capability_required'),{code:'browser_capability_required',reason});
  if(!['available','unavailable'].includes(value))invalid('--browser-qa 只接受 available 或 unavailable');
  if(value!=='available')throw Object.assign(new Error('browser_capability_unavailable'),{code:'browser_capability_unavailable',reason});
  return 'available';
}

export function readHostWorkflowConfiguration(file){
  const stat=fs.lstatSync(file);
  need(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=64*1024,'invalid_workflow_config');
  return validateHostWorkflowConfiguration(JSON.parse(fs.readFileSync(file,'utf8')));
}

export function validateHostWorkflowConfiguration(raw){
  const config=json(raw);
  shape(config,['qa','documentationPaths','applicableAgentFiles',
    ...(Object.hasOwn(config,'knowledgeCloseout')?['knowledgeCloseout']:[])]);
  if(Object.hasOwn(config,'knowledgeCloseout'))need(typeof config.knowledgeCloseout==='boolean','invalid_workflow_config');
  for(const key of ['documentationPaths','applicableAgentFiles'])
    need(Array.isArray(config[key])&&config[key].length<=256&&config[key].every(item=>typeof item==='string'),'invalid_workflow_config');
  if(config.qa!==null){
    shape(config.qa,['commands','environment',...(Object.hasOwn(config.qa,'timeoutMs')?['timeoutMs']:[]),
      ...(Object.hasOwn(config.qa,'criticalPaths')?['criticalPaths']:[])]);
    if(Object.hasOwn(config.qa,'criticalPaths'))readQaCriticalPaths(config.qa.criticalPaths);
    // A real browser walkthrough of one blocking case runs for minutes, so this
    // follows the shared call-timeout range rather than a fixed minute. The
    // default below is unchanged; only an explicit configuration may raise it.
    if(Object.hasOwn(config.qa,'timeoutMs'))need(Number.isSafeInteger(config.qa.timeoutMs)
      &&config.qa.timeoutMs>0&&config.qa.timeoutMs<=3600000,'invalid_workflow_config');
  }
  return config;
}

export function createHostWorkflowCapabilities({definition,configuration,bridge,allowQa,runtime='codex',protectedExecution=false,bootstrap=null,parallelMember=false,controlPolicy=null}){
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  const {specsDir,codeProject,feature,requirements}=definition;
  const logHome=path.join(specsDir,'.reviews','host-log-mirror');
  const result={applicableAgentFiles:configuration.applicableAgentFiles,
    documentationProvider:{timeoutMs:60000,inspect:(request,signal)=>bridge.call('documentation_inspect',request,signal)}};
  if(!protectedExecution&&configuration.documentationPaths.length)result.documentationSync={paths:configuration.documentationPaths,
    run:(request,signal)=>bridge.call('documentation_sync',request,signal)};
  // The N6 disposition is required even when execution is disabled. Its
  // fixed checkpoints and registered path matches may require QA;
  // only a configured executor can then supply actual execution evidence.
  // Legacy qa:null keeps its historical caller-supplied disposition contract.
  if(configuration.qa!==null||controlPolicy!==null){
    result.qaLogHome=logHome;
    const requestTimeout={timeoutMs:configuration.qa?.timeoutMs??60000};
    // The assessment is a read-only confirmation; the decision itself comes from
    // the host policy (host-qa-policy.mjs). A v2 run whose policy disables QA has
    // nobody to ask when it runs unattended, so the host confirms it here; the
    // decision, its triggers and its record are unchanged.
    const assess=controlPolicy?.qa==='disabled'?async()=>({confirmed:true})
      :(request,signal)=>bridge.call('qa_assess',request,signal,requestTimeout);
    result.qaDecisionProvider=parallelMember?createParallelMemberQaDecisionProvider():createHostQaDecisionProvider({timeoutMs:60000,
      criticalPaths:configuration.qa?.criticalPaths??{},assess});
  }
  if(configuration.qa!==null&&(controlPolicy===null||controlPolicy.qa==='run')){
    need(allowQa===true,'qa_authorization_required');
    const requestTimeout={timeoutMs:configuration.qa.timeoutMs??60000};
    // requestTimeoutMs stays outside the fingerprinted executor configuration;
    // timed-out QA recovery reads older case_blocked rows against it.
    result.qaExecutor=Object.freeze({...createHostQaExecutor({specsDir,codeProject,feature,requirements,runtime,
      ...(definition.codeProjects?{codeProjects:definition.codeProjects}:{}),
      ...(bootstrap?{bootstrap:{requirements:bootstrap.configuration.bootstrapRequirements,scope:definition.scope}}:{}),
      commands:configuration.qa.commands,environment:configuration.qa.environment,timeoutMs:1800000,logHome,
      ...(protectedExecution?{specsRoot:specsDir}:{}),
      logic:(request,signal)=>bridge.call('qa_logic',request,signal,requestTimeout),
      browser:(request,signal)=>bridge.call('qa_browser',request,signal,requestTimeout)}),requestTimeoutMs:requestTimeout.timeoutMs});
  }
  return result;
}

export function createParallelMemberQaDecisionProvider(){
  return Object.freeze({timeoutMs:60000,async decide(raw,signal){
    const binding=json(raw);shape(binding,['specsDir','codeProject','feature','identity','packageDigest',
      ...(Object.hasOwn(binding,'changedFiles')?['changedFiles']:[])]);
    validIdentity(binding.identity);hex(binding.packageDigest);need(!signal.aborted,'cancelled');
    return {decisionId:`qa-${digest({identity:binding.identity,packageDigest:binding.packageDigest}).slice(0,48)}`,
      identity:binding.identity,packageDigest:binding.packageDigest,status:'skipped',
      reason:'parallel_member_deferred',score:null,
      ...(binding.changedFiles?{changedFilesSource:binding.changedFiles.source}:{}),at:new Date().toISOString().replace(/\.\d{3}Z$/,'Z')};
  }});
}

// v2 的 N6 判定不依赖 workflow 配置；没有 --workflow-config 时只补判定本身，
// 不加执行器、文档核对或写回，避免改变这类运行的其他请求。
export function createImplicitQaDecision({definition,bridge,parallelMember=false,controlPolicy}){
  const {qaLogHome,qaDecisionProvider}=createHostWorkflowCapabilities({definition,
    configuration:{qa:null,documentationPaths:[],applicableAgentFiles:[]},bridge,allowQa:false,parallelMember,controlPolicy});
  return {qaLogHome,qaDecisionProvider:markImplicitQaDecision(qaDecisionProvider)};
}
