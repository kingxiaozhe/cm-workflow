#!/usr/bin/env node
// Fixed, no-provider control entry. Executing adapters are a subsequent slice.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {digest as sha} from '../runtime/js/cm-ai/contracts.mjs';
import {resolveCodeProjects,codeProjectPaths,assertCodeProjectSelections} from '../runtime/js/cm-ai/code-projects.mjs';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';

const usage='cm-ai-run.mjs serve --config PATH --mode create|resume (no provider dispatch)';
const fail=code=>{throw Object.assign(new Error(code),{code});};
// In-process provenance only; a config flag cannot certify protected callbacks.
const protectedExecutions=new WeakMap();

// Fixed adapter assembly for a trusted host. The authority callbacks are never
// sourced from run.json or the JSONL channel. Construction performs no dispatch.
export async function createCodexExecution(configuration,authority){
  const {json,shape,need,id,text,validCallTimeout,freeze}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  const config=json(configuration);
  shape(config,['codeProject','developerModel','reviewerModel','hostContextId','developerContextId',
    'checkCommands','timeoutMs','reviewerPreflight',...['specsRoot','disabledSkills','workflow','bootstrap'].filter(key=>Object.hasOwn(config,key))]);
  text(config.codeProject);text(config.developerModel);text(config.reviewerModel);
  id(config.hostContextId);id(config.developerContextId);need(config.hostContextId!==config.developerContextId);
  need(/^[A-Za-z0-9._-]+$/.test(config.developerModel));
  need(!['codex-independent-review-1','codex-independent-review-2'].some(value=>
    value===config.hostContextId||value===config.developerContextId),'not_independent');
  validCallTimeout(config.timeoutMs);
  shape(authority,['authorizeDevelopment','authorizeReview','hostDecision',
    ...['hostDecisionProvider','developmentAttempt','workflow','bootstrap'].filter(key=>Object.hasOwn(authority,key))]);
  need(typeof authority.authorizeDevelopment==='function'&&typeof authority.authorizeReview==='function');
  if(Object.hasOwn(authority,'developmentAttempt'))need([1,2].includes(authority.developmentAttempt),'invalid_development_attempt');
  if(Object.hasOwn(authority,'hostDecisionProvider')){
    shape(authority.hostDecisionProvider,['decide','timeoutMs']);
    need(typeof authority.hostDecisionProvider.decide==='function'
      &&Number.isInteger(authority.hostDecisionProvider.timeoutMs)&&authority.hostDecisionProvider.timeoutMs>0
      &&authority.hostDecisionProvider.timeoutMs<=60000,'invalid_input');
  }
  const disabledSkills=config.disabledSkills??[];
  need(Array.isArray(disabledSkills)&&disabledSkills.length<=4096
    &&disabledSkills.every(p=>typeof p==='string'&&path.isAbsolute(p)&&!/[\n\r\0]/.test(p)),'invalid_review_config');
  const {codexWorker,preflightMatches}=await import('../runtime/js/cm-ai/worker-codex.mjs');
  const {codexDeveloperWorker}=await import('../runtime/js/cm-ai/worker-codex-developer.mjs');
  const {createCodexDeveloperRun,readCodexDeveloperRequest}=await import('../runtime/js/cm-ai/codex-developer-adapter.mjs');
  const {createCodexReviewRun}=await import('../runtime/js/cm-ai/codex-review-adapter.mjs');
  const {createHostCheck}=await import('../runtime/js/cm-ai/host-check.mjs');
  const specsRoot=config.specsRoot??null;
  if(Object.hasOwn(config,'specsRoot')){
    need(typeof specsRoot==='string','unsupported_path');
    const {specsPermissionArgs}=await import('../runtime/js/cm-ai/codex-config.mjs');
    specsPermissionArgs({cwd:config.codeProject,specsRoot});
  }
  let bootstrap=null;
  need(Object.hasOwn(config,'bootstrap')===Object.hasOwn(authority,'bootstrap'),'bootstrap_configuration_required');
  if(config.bootstrap){
    shape(config.bootstrap,['definition','selection']);shape(authority.bootstrap,['bridge','allowWrite']);
    need(specsRoot!==null&&config.bootstrap.definition.codeProject===config.codeProject
      &&config.bootstrap.definition.specsDir===specsRoot,'execution_specs_mismatch');
    const {createHostBootstrap}=await import('../runtime/js/cm-ai/host-bootstrap.mjs');
    bootstrap=createHostBootstrap({definition:config.bootstrap.definition,workflowRoot:path.resolve(fileURLToPath(new URL('..',import.meta.url))),
      selection:config.bootstrap.selection,...authority.bootstrap});
  }
  let workflowCapabilities={},documentationPaths=[],workflowDefinition=null;
  need(Object.hasOwn(config,'workflow')===Object.hasOwn(authority,'workflow'),'workflow_configuration_required');
  if(Object.hasOwn(config,'workflow')){
    need(specsRoot!==null,'protected_configuration_required');
    shape(config.workflow,['definition','configuration']);shape(authority.workflow,['bridge','allowQa']);
    need(typeof authority.workflow.bridge?.call==='function'&&typeof authority.workflow.allowQa==='boolean');
    workflowDefinition=validateRunDefinition(config.workflow.definition);
    need(workflowDefinition.codeProject===config.codeProject&&workflowDefinition.specsDir===specsRoot,'execution_specs_mismatch');
    const {validateHostWorkflowConfiguration,createHostWorkflowCapabilities}=await import('../runtime/js/cm-ai/host-workflow-capabilities.mjs');
    const {validateDocumentationPaths}=await import('../runtime/js/cm-ai/host-documentation.mjs');
    const workflow=validateHostWorkflowConfiguration(config.workflow.configuration);
    documentationPaths=validateDocumentationPaths(workflow.documentationPaths,workflowDefinition.scope);
    workflowCapabilities=createHostWorkflowCapabilities({definition:workflowDefinition,configuration:workflow,
      bridge:authority.workflow.bridge,allowQa:authority.workflow.allowQa,protectedExecution:true,bootstrap});
  }
  const reviewOptions={cwd:config.codeProject,model:config.reviewerModel,promptTransport:'stdin',
    schemaPath:fileURLToPath(new URL('../runtime/js/cm-ai/review-result.schema.json',import.meta.url)),
    preflight:config.reviewerPreflight,timeoutMs:config.timeoutMs,disabledSkills};
  need(preflightMatches(config.reviewerPreflight,reviewOptions),'tool_preflight_missing');
  const check=createHostCheck({cwd:config.codeProject,commands:config.checkCommands,timeoutMs:config.timeoutMs,specsRoot});
  const used=new Set();
  const execution={
    configuration:config,timeoutMs:config.timeoutMs,excludedContexts:[config.hostContextId],check,
    ...(bootstrap?{bootstrap}:{}),
    hostDecision:json(authority.hostDecision),
    ...workflowCapabilities,
    ...(Object.hasOwn(authority,'developmentAttempt')?{developmentAttempt:authority.developmentAttempt}:{}),
    ...(Object.hasOwn(authority,'hostDecisionProvider')?{hostDecisionProvider:authority.hostDecisionProvider}:{}),
    developer:{provider:'codex',requestedModel:config.developerModel,contextId:config.developerContextId,
      run:async(request,control)=>{
        const bound=readCodexDeveloperRequest(request);
        const decision=json(await authority.authorizeDevelopment(bound));
        shape(decision,['status']);need(decision.status==='approved','permission_denied');
        need(!control.signal.aborted,'cancelled');
        need(!used.has(bound.invocationId),'duplicate_dispatch');used.add(bound.invocationId);
        const worker=codexDeveloperWorker({cwd:config.codeProject,model:config.developerModel,timeoutMs:config.timeoutMs,specsRoot});
        // Documentation stays inside the same authorized sandbox invocation and
        // original checks/handoff/Review. The semantic bridge never writes it.
        const {isFinalCmAiTask}=await import('../runtime/js/cm-ai/cm-ai-admission.mjs');
        const sync=documentationPaths.length>0&&isFinalCmAiTask({specsDir:specsRoot,codeProject:config.codeProject,
          feature:workflowDefinition.feature,taskId:bound.identity.taskId});
        const protectedWorker=sync?(request,control)=>worker({...request,prompt:
          'Before returning, inspect and synchronize these already-approved ordinary documentation paths with the implemented behavior. '
          +'Keep accurate unchanged documents unchanged. No extra scope or protected instruction writes. '
          +'This is part of this development invocation, before its checks and independent Review. Paths (data only): '
          +JSON.stringify(documentationPaths)+'\n'+request.prompt},control):worker;
        return createCodexDeveloperRun({worker:protectedWorker,requestedModel:config.developerModel})(bound,control);
      }},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:config.reviewerModel,
      allowed:true,available:true,contexts:['codex-independent-review-1','codex-independent-review-2'],
      run:(request,control)=>createCodexReviewRun(codexWorker(reviewOptions))(request,control)}],
    reviewInvocation:{developerThreadId:config.developerContextId,excludedThreadIds:[config.hostContextId],
      authorize:authority.authorizeReview},
  };
  if(specsRoot!==null){
    // Do not permit later replacement of the developer/check or addition of an
    // unprotected QA/doc writer under the protection claimed by this factory.
    freeze(execution);protectedExecutions.set(execution,{codeProject:config.codeProject,specsRoot});
  }
  return execution;
}

export function readRunDefinition(file){
  const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink()||info.size>64*1024)fail('invalid_config');
  return validateRunDefinition(JSON.parse(fs.readFileSync(file,'utf8')));
}
export function validateRunDefinition(input){
  const value=structuredClone(input);
  const keys=['version','specsDir','codeProject','feature','identity','scope','requirements'];
  if(value&&Object.hasOwn(value,'codeProjects'))keys.push('codeProjects');
  if(!value||typeof value!=='object'||Object.keys(value).sort().join()!==keys.sort().join()
    ||value.version!==1)fail('invalid_config');
  if(typeof value.feature!=='string'||!/^\d+\.[^/\\]+$/.test(value.feature))fail('invalid_feature');
  for(const key of ['specsDir','codeProject']){
    if(typeof value[key]!=='string'||!path.isAbsolute(value[key]))fail('invalid_path');
    value[key]=fs.realpathSync(value[key]);
    if(!fs.statSync(value[key]).isDirectory())fail('invalid_path');
  }
  if(!value.identity||Object.keys(value.identity).sort().join()!=='attempt,repositoryId,runId,taskId'
    ||value.identity.attempt!==1)fail('invalid_identity');
  for(const key of ['repositoryId','runId','taskId']){
    if(typeof value.identity[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.identity[key]))fail('invalid_identity');
  }
  for(const key of ['scope','requirements']){
    if(!Array.isArray(value[key])||(!value[key].length&&!(key==='requirements'&&value.feature==='0.bootstrap'))||value[key].length>256
      ||value[key].some(p=>typeof p!=='string'||!p||p.includes('\\')||p.includes('\0')
        ||path.isAbsolute(p)||p.split('/').some(x=>!x||x==='.'||x==='..')))fail('invalid_paths');
  }
  if(Object.hasOwn(value,'codeProjects')){
    value.codeProjects=[...resolveCodeProjects(value.codeProject,value.codeProjects)];
    const prefixes=codeProjectPaths(value.codeProject,value.codeProjects);
    assertCodeProjectSelections(prefixes,[...value.scope,...value.requirements]);
    for(const root of value.codeProjects)if(root===value.specsDir||root.startsWith(value.specsDir+path.sep))fail('overlapping_roots');
  }
  return value;
}

export async function openControlRun(definition,mode,execution=null){
  // Check before importing node:sqlite: legacy Node users get a useful error.
  if(!isSupportedExecutionPlatform())fail('unsupported_runner_platform');
  const {conversationProtection}=await import('../runtime/js/cm-ai/host-conversation-execution.mjs');
  if(!['create','resume'].includes(mode))fail('invalid_mode');
  const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
  const {createCmAiHost}=await import('../runtime/js/cm-ai/host.mjs');
  const {inspectCmAiAdmission}=await import('../runtime/js/cm-ai/cm-ai-admission.mjs');
  const {captureReviewBaseline}=await import('../runtime/js/cm-ai/review-package.mjs');
  if(execution!==null){
    const {shape,json,validCallTimeout}=await import('../runtime/js/cm-ai/effect-contract.mjs');
    shape(execution,['configuration','developer','reviewers','reviewInvocation','check','hostDecision','excludedContexts','timeoutMs',
      ...['bootstrap','developmentAttempt','hostDecisionProvider','qaDecisionProvider','qaLogHome','qaExecutor','applicableAgentFiles','documentationProvider','documentationResult','documentationSync'].filter(key=>Object.hasOwn(execution,key))]);
    json(execution.configuration);validCallTimeout(execution.timeoutMs);
    if(Object.hasOwn(execution.configuration,'codeProject'))
      if(execution.configuration.codeProject!==definition.codeProject)fail('execution_root_mismatch');
    if(Object.hasOwn(execution.configuration,'workflow')&&protectedExecutions.has(execution)
      &&sha(execution.configuration.workflow.definition)!==sha(definition))fail('execution_definition_mismatch');
    const conversation=conversationProtection(execution);
    const protection=protectedExecutions.get(execution)??conversation;
    if(conversation&&conversation.definitionDigest!==sha(definition))fail('execution_definition_mismatch');
    if(protection){
      if(protection.codeProject!==definition.codeProject||protection.specsRoot!==definition.specsDir)
        fail('execution_specs_mismatch');
      const {specsPermissionArgs}=await import('../runtime/js/cm-ai/codex-config.mjs');
      specsPermissionArgs({cwd:definition.codeProject,specsRoot:definition.specsDir});
    }
    // Only the unchanged factory object can open the built-in nested execution
    // path. Custom trusted test hosts retain their existing separate contract.
    if((Object.hasOwn(execution.configuration,'codeProject')||execution.configuration.kind==='cm-current-conversation-v1')
      &&definition.specsDir.startsWith(definition.codeProject+path.sep)&&!protection)fail('nested_specs_protection_required');
  }
  const {specsDir,codeProject,feature,identity,scope,requirements}=definition;
  let bootstrapConfig=null;
  if(execution?.bootstrap){
    const {bootstrapConfiguration}=await import('../runtime/js/cm-ai/host-bootstrap.mjs');
    bootstrapConfig=bootstrapConfiguration(execution.bootstrap,{root:codeProject,identity,scope,feature});
  }
  if(requirements.length===0&&!bootstrapConfig)fail('bootstrap_capability_required');
  const selectedRoots=definition.codeProjects?codeProjectPaths(codeProject,resolveCodeProjects(codeProject,definition.codeProjects)):null;
  if(selectedRoots){
    if(!execution||conversationProtection(execution)===null)fail('multi_root_protection_required');
    for(const root of definition.codeProjects){
      const selected=inspectCmAiAdmission({specsDir,codeProject:root});
      if(mode==='create'&&(selected.state!=='ready'||selected.nextTask.feature!==feature||selected.nextTask.id!==identity.taskId))
        return {blocked:selected,close:()=>{}};
    }
  }
  const developer=execution?.documentationSync
    ?(await import('../runtime/js/cm-ai/host-documentation.mjs')).withHostDocumentation({developer:execution.developer,
      documentationSync:execution.documentationSync,specsDir,codeProject,feature,scope}):execution?.developer;
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  if(mode==='create'&&admission.state!=='ready')return {blocked:admission,close:()=>{}};
  if(mode==='create'&&(admission.nextTask.feature!==feature||admission.nextTask.id!==identity.taskId))fail('task_selection_mismatch');
  const tasksPath=path.join(specsDir,feature,'tasks.md');
  const featureSlug=feature.replace(/^\d+\./,'');
  const reviewsDir=path.join(specsDir,'.reviews');
  const handoffs=[1,2].map(attempt=>path.join(reviewsDir,`${featureSlug}-${identity.taskId}-a${attempt}-handoff.json`));
  // Reuse the runner's real validator before creating durable state. A failed
  // baseline must not strand an otherwise unused run ID.
  const baselineOptions={root:codeProject,specsRoot:specsDir,identity,scope,requirements,
    ...(bootstrapConfig?{bootstrapRequirements:bootstrapConfig.bootstrapRequirements}:{}),
    ...(selectedRoots?{codeProjectPaths:selectedRoots}:{})};
  if(mode==='create')captureReviewBaseline(baselineOptions);
  // Definition is data, never an import path, command, grant or executable callback.
  const store=openTaskExecutionStore({tasksPath,feature:featureSlug,specsRoot:specsDir,
    identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:sha(execution===null?'cm-ai-control-v1':'cm-ai-host-execution-v1'),
      config:sha(execution===null?definition:{definition,execution:execution.configuration,
        ...(bootstrapConfig?{bootstrap:bootstrapConfig}:{}),
        ...(Object.hasOwn(execution,'developmentAttempt')?{developmentAuthorization:'per-attempt-v1'}:{}),
        ...(execution.hostDecisionProvider?{hostDecisionProvider:{version:1,timeoutMs:execution.hostDecisionProvider.timeoutMs}}:{}),
        ...(execution.qaDecisionProvider?{qaDecisionProvider:'host-v1',qaTimeoutMs:execution.qaDecisionProvider.timeoutMs}:{}),
        ...(execution.qaExecutor?{qaExecutor:{version:1,mode:execution.qaExecutor.mode,
          caseCount:execution.qaExecutor.caseCount,timeoutMs:execution.qaExecutor.timeoutMs,
          ...(Object.hasOwn(execution.qaExecutor,'configuration')?{configuration:execution.qaExecutor.configuration}:{})}}:{}),
        ...(execution.applicableAgentFiles?{applicableAgentFiles:execution.applicableAgentFiles}:{}),
        ...(execution.documentationProvider?{documentationProvider:{version:1,timeoutMs:execution.documentationProvider.timeoutMs}}:{}),
        ...(execution.documentationResult?{documentationResult:execution.documentationResult}:{}),
        ...(execution.documentationSync?{documentationSync:{version:1,paths:execution.documentationSync.paths}}:{})}),inputs:sha({feature,task:identity.taskId})},
    create:mode==='create'});
  try{
    let runnerMode=mode;
    if(mode==='resume'&&store.snapshot().records.length===0){
      // Only the genuine, fingerprint-matching empty initializer can be finished.
      // Never reset/recreate a journal that contains any event.
      if(admission.state!=='ready'||admission.nextTask.feature!==feature||admission.nextTask.id!==identity.taskId)
        fail('initialization_admission_required');
      captureReviewBaseline(baselineOptions);
      runnerMode='create';
    }
    const unavailable=()=>fail('execution_adapter_required');
    const host=createCmAiHost({
      runner:{root:codeProject,identity,scope,requirements,...(selectedRoots?{codeProjectPaths:selectedRoots}:{}),excludedContexts:['control-host'],
        developer:{provider:'codex',requestedModel:'unconfigured',contextId:'control-developer',run:unavailable},
        reviewers:[],check:unavailable,taskCompletion:{reviewsDir,handoffs},taskLearning:{feature},
        persistence:{store,mode:runnerMode,version:execution===null?2:3},
        ...(execution===null?{}:{developer,reviewers:execution.reviewers,
          ...(execution.bootstrap?{bootstrap:execution.bootstrap}:{}),
          reviewInvocation:execution.reviewInvocation,check:execution.check,
          excludedContexts:execution.excludedContexts,timeoutMs:execution.timeoutMs,
          taskLearning:{feature,hostHandoff:true}})},
      entry:{specsDir,codeProject,feature,identity,...(execution===null?{}:{hostDecision:execution.hostDecision,
        ...Object.fromEntries(['developmentAttempt','hostDecisionProvider','qaDecisionProvider','qaLogHome','qaExecutor','applicableAgentFiles','documentationProvider','documentationResult'].filter(key=>Object.hasOwn(execution,key)).map(key=>[key,execution[key]]))})},
    });
    return {host:{async handle(request){
      if(execution===null&&!['status','cancel'].includes(request.operation)){
        // Do not imply an unavailable execution adapter was dispatched.
        return {outcome:'blocked',code:'execution_adapter_required',providerCalls:0};
      }
      return host.handle(request);
    }},inspectFixAssociation:host.inspectFixAssociation,acceptCompletedFix:host.acceptCompletedFix,
      checkpoint:()=>store.snapshot().revision,close:()=>store.close()};
  }catch(error){store.close();throw error;}
}

// Only a trusted in-process host supplies executable adapters/decisions. JSON
// config and protocol messages cannot load a module or turn execution on.
export async function main(argv=process.argv.slice(2),{input=process.stdin,output=process.stdout,error=process.stderr,execution=null}={}){
  if(argv.length===1&&['--help','-h'].includes(argv[0])){output.write(usage+'\n');return 0;}
  let run;
  try{
    if(argv.length!==5||argv[0]!=='serve'||argv[1]!=='--config'||argv[3]!=='--mode')fail('invalid_arguments');
    run=await openControlRun(readRunDefinition(argv[2]),argv[4],execution);
    if(run.blocked){output.write(JSON.stringify({outcome:'blocked',admission:run.blocked})+'\n');return 1;}
    await serveCmAiHost({host:run.host,input,output});return 0;
  }catch(cause){
    // No raw config/source/provider text in protocol errors.
    const code=typeof cause.code==='string'&&/^[a-z_]+$/.test(cause.code)?cause.code:'control_failed';
    error.write(JSON.stringify({error:{code}})+'\n');return 1;
  }finally{run?.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
