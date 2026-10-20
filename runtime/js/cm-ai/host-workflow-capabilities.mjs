// Fixed current-conversation capabilities over the existing N6/N8 adapters.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {digest,json,need,shape,validIdentity,hex} from './effect-contract.mjs';
import {createHostQaDecisionProvider,readQaCriticalPaths} from './host-qa-policy.mjs';
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

// This fixed v2 single-task capability was always required by qa:disabled.
// It is derived from existing frozen inputs, not a new configurable workflow.
const implicitQaProviders=new WeakSet();
const attachedQaExecutors=new WeakSet();
export function implicitQaConfiguration(configuration){
  return configuration?.kind==='cm-current-conversation-v1'
    &&configuration.controlPolicy?.version===2&&configuration.controlPolicy.qa==='disabled'
    &&!Object.hasOwn(configuration,'workflow')&&configuration.parallelMember!==true;
}
export function implicitHostQaDecision(execution){
  return implicitQaConfiguration(execution?.configuration)&&(!execution.qaExecutor||isQaExecutorAttachment(execution))
    &&implicitQaProviders.has(execution.qaDecisionProvider);
}
export function isQaExecutorAttachment(execution){
  const policy=execution?.configuration?.controlPolicy;
  return implicitQaConfiguration(execution?.configuration)&&policy.development==='conversation'
    &&policy.bootstrap==='disabled'&&policy.qaFix==='disabled'
    &&attachedQaExecutors.has(execution.qaExecutor)&&implicitQaProviders.has(execution.qaDecisionProvider);
}
export function preQaExecutorMaterial(execution,material){
  need(isQaExecutorAttachment(execution)&&material.qaExecutorAttachment?.version===1,'qa_executor_attachment_required');
  const original=structuredClone(json(material));
  delete original.qaExecutor;delete original.qaExecutorAttachment;
  return original;
}
export function readQaExecutorConfiguration(raw){
  const qa=json(raw);shape(qa,['commands','environment',...(Object.hasOwn(qa,'timeoutMs')?['timeoutMs']:[])]);
  if(Object.hasOwn(qa,'timeoutMs'))need(Number.isSafeInteger(qa.timeoutMs)&&qa.timeoutMs>0
    &&qa.timeoutMs<=3600000,'invalid_workflow_config');
  return qa;
}
export function readQaExecutorConfigurationFile(file){
  const before=fs.lstatSync(file);
  need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1&&before.size<=65536,'invalid_workflow_config');
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const bytes=fs.readFileSync(fd),after=fs.fstatSync(fd),current=fs.lstatSync(file);
    need([after,current].every(s=>['dev','ino','size','mtimeMs','ctimeMs'].every(k=>s[k]===before[k]))
      &&bytes.length===before.size,'snapshot_changed');
    return readQaExecutorConfiguration(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
  }finally{fs.closeSync(fd);}
}
// This supplies a candidate capability only. The owner must register or replay
// its exact material before exposing the host, and never changes frozen policy.
export function createAttachedHostQaCapabilities({definition,configuration,qa,bridge,runtime,protectedExecution=false}){
  need(implicitQaConfiguration(configuration)&&configuration.controlPolicy.development==='conversation'
    &&configuration.controlPolicy.bootstrap==='disabled'&&configuration.controlPolicy.qaFix==='disabled','qa_executor_attachment_required');
  qa=readQaExecutorConfiguration(qa);
  const rawHome=process.env.CM_WORKFLOW_LOG_HOME??path.join(os.homedir(),'.cm-workflow','logs');
  const logHome=path.resolve(rawHome==='~'?os.homedir():rawHome.startsWith('~/')?path.join(os.homedir(),rawHome.slice(2)):rawHome);
  const {specsDir,codeProject,feature,requirements}=definition;
  const requestTimeout={timeoutMs:qa.timeoutMs??60000};
  const qaExecutor=Object.freeze({...createHostQaExecutor({specsDir,codeProject,feature,requirements,runtime,
    ...(definition.codeProjects?{codeProjects:definition.codeProjects}:{}),
    commands:qa.commands,environment:qa.environment,timeoutMs:1800000,logHome,
    ...(protectedExecution?{specsRoot:specsDir}:{}),
    logic:(request,signal)=>bridge.call('qa_logic',request,signal,requestTimeout),
    browser:(request,signal)=>bridge.call('qa_browser',request,signal,requestTimeout)}),requestTimeoutMs:requestTimeout.timeoutMs});
  attachedQaExecutors.add(qaExecutor);
  return {...createImplicitHostQaCapabilities({configuration,bridge}),qaExecutor};
}
function hostQaDecisionProvider({qa,bridge,parallelMember=false}){
  const requestTimeout={timeoutMs:qa?.timeoutMs??60000};
  return parallelMember?createParallelMemberQaDecisionProvider():createHostQaDecisionProvider({timeoutMs:60000,
    criticalPaths:qa?.criticalPaths??{},assess:(request,signal)=>bridge.call('qa_assess',request,signal,requestTimeout)});
}
export function createImplicitHostQaCapabilities({configuration,bridge}){
  need(implicitQaConfiguration(configuration),'invalid_input');
  const qaDecisionProvider=hostQaDecisionProvider({qa:null,bridge});
  implicitQaProviders.add(qaDecisionProvider);
  // Preserve the original log/mirror selection and all absent executors/docs.
  return {qaDecisionProvider};
}

export function createHostWorkflowCapabilities({definition,configuration,bridge,allowQa,runtime='codex',protectedExecution=false,bootstrap=null,parallelMember=false,controlPolicy=null,commandProjection=null}){
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
    result.qaDecisionProvider=hostQaDecisionProvider({qa:configuration.qa,bridge,parallelMember});
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
      ...(commandProjection?{commandProjection}:{}),
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
