#!/usr/bin/env node
// Fixed, no-provider control entry. Executing adapters are a subsequent slice.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {digest as sha} from '../runtime/js/cm-ai/contracts.mjs';
import {resolveCodeProjects,codeProjectPaths,assertCodeProjectSelections} from '../runtime/js/cm-ai/code-projects.mjs';
import {preQaConfigurations,readQaAttachment} from '../runtime/js/cm-ai/qa-attachment.mjs';
import {recordCmAiQaAttachment} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {isSupportedExecutionPlatform} from '../runtime/js/cm-ai/execution-platform.mjs';
import {readExecutionSnapshot} from '../runtime/js/cm-ai/execution-snapshot.mjs';
import {hasLegacyQaPlanFingerprint,previousQaMaterial,qaConfigurationSlice,qaExecutorMaterial,qaInvariantDigest,qaRevisionChain,verifyQaRevisionMaterial} from '../runtime/js/cm-ai/qa-config-revision.mjs';
import {hasCmAiQaRun,inspectCmAiQaRevisionTarget,recordCmAiQaConfigurationRevision} from '../runtime/js/cm-ai/cm-ai-qa-log.mjs';
import {prepareReviewedEvidenceSupersession,archiveReviewedEvidence,recordEvidenceSupersession,assertNoUnrecordedPriorCode} from '../runtime/js/cm-ai/reviewed-evidence-supersede.mjs';
import {explainFingerprintMismatch} from '../runtime/js/cm-ai/launch-mismatch.mjs';
import {recordReviewAbandonment} from '../runtime/js/cm-ai/review-abandon-log.mjs';
import {recordEffectAbandonment} from '../runtime/js/cm-ai/effect-abandon-log.mjs';
import {reviewConsumedHandoff,reviewedHandoffConflict} from '../runtime/js/cm-ai/host-handoff.mjs';
import {RUN_ID_RULE,validRunId} from './cm-log-event.mjs';
import {JOURNAL_PAYLOAD_LIMIT,boundedReason} from '../runtime/js/cm-ai/effect-contract.mjs';

const usage='cm-ai-run.mjs serve --config RUN_DEFINITION.json --mode create|resume (no provider dispatch)\nNew runs bind approved specification material from specsDir; requirements may be [] or supplemental code-project files. Manifest drift blocks as spec_drift; legacy journals retain their original format.';
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

// Also bounds every changed-file list a task handoff can carry (see the handoff
// size test): raising it means revisiting the 256 KiB handoff limit.
export const RUN_DEFINITION_LIMIT=64*1024;
export function readRunDefinition(file){
  const info=fs.lstatSync(file);
  if(!info.isFile()||info.isSymbolicLink())fail('invalid_config: not a regular file');
  if(info.size>RUN_DEFINITION_LIMIT)fail('invalid_config: file exceeds 64KiB');
  return validateRunDefinition(JSON.parse(fs.readFileSync(file,'utf8')));
}
export function validateRunDefinition(input){
  const value=structuredClone(input);
  const keys=['version','specsDir','codeProject','feature','identity','scope','requirements'];
  if(value&&Object.hasOwn(value,'codeProjects'))keys.push('codeProjects');
  if(value&&Object.hasOwn(value,'taskSelection'))keys.push('taskSelection');
  if(!value||typeof value!=='object')fail('invalid_config: expected an object');
  const unexpected=Object.keys(value).filter(key=>!keys.includes(key));
  const missing=keys.filter(key=>!Object.hasOwn(value,key));
  if(unexpected.length||missing.length)fail('invalid_config: '+[
    ...(unexpected.length?[`unexpected keys ${unexpected.join(',')}`]:[]),
    ...(missing.length?[`missing keys ${missing.join(',')}`]:[]),
  ].join('; '));
  if(value.version!==1)fail('invalid_config: version must be 1');
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
  if(Object.hasOwn(value,'taskSelection')&&(!value.taskSelection||value.taskSelection.version!==1
    ||Object.keys(value.taskSelection).sort().join(',')!=='taskId,version'
    ||value.taskSelection.taskId!==value.identity.taskId))fail('invalid_task_selection');
  for(const key of ['scope','requirements']){
    if(!Array.isArray(value[key])||(!value[key].length&&!(key==='requirements'))||value[key].length>256
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
// Create-time only: an existing journal keeps resuming (and can be abandoned)
// exactly as before, while a new run can no longer strand its first develop
// effect on a run ID the run log refuses.
export function assertCreatableRunId(identity){
  if(!validRunId(identity?.runId))fail(`invalid_config: identity.runId must be ${RUN_ID_RULE} (run log requirement)`);
}

// Definition is data, never an import path, command, grant or executable callback.
// legacyQa rebuilds the historical QA executor form for stores created before
// the built-in plan left the fingerprint; it is never used to create a store.
export function runConfigMaterial(definition,execution,{parallelSelection=null,bootstrapConfig=null,legacyQa=false}={}){
  if(execution===null)return parallelSelection===null?definition:{definition,parallelSelection};
  return {definition,...(parallelSelection===null?{}:{parallelSelection}),execution:execution.configuration,
    ...(bootstrapConfig?{bootstrap:bootstrapConfig}:{}),
    ...(Object.hasOwn(execution,'developmentAttempt')?{developmentAuthorization:'per-attempt-v1'}:{}),
    ...(execution.hostDecisionProvider?{hostDecisionProvider:{version:1,timeoutMs:execution.hostDecisionProvider.timeoutMs}}:{}),
    ...(execution.qaDecisionProvider?{qaDecisionProvider:'host-v1',qaTimeoutMs:execution.qaDecisionProvider.timeoutMs}:{}),
    ...(execution.qaExecutor?{qaExecutor:qaExecutorMaterial(execution.qaExecutor,legacyQa)}:{}),
    ...(execution.applicableAgentFiles?{applicableAgentFiles:execution.applicableAgentFiles}:{}),
    ...(execution.documentationProvider?{documentationProvider:{version:1,timeoutMs:execution.documentationProvider.timeoutMs}}:{}),
    ...(execution.documentationResult?{documentationResult:execution.documentationResult}:{}),
    ...(execution.documentationSync?{documentationSync:{version:1,paths:execution.documentationSync.paths}}:{})};
}
const LEGACY_QA_FINGERPRINT_REASON='运行指纹与当前配置不符。若此运行由之前的版本创建，它的指纹还含有当时生效的 CM 配置'
  +'（项目 .cm-workflow.yml、~/.cm-workflow/runtimes.yml 与插件内置默认值）：把这些配置恢复为创建时的内容即可恢复；'
  +'现在新建的运行不再把这些可变配置写进指纹。否则请核对 run.json、--workflow-config、宿主身份及授权参数是否与创建时一致。';

export async function openControlRun(definition,mode,execution=null,{rerunUnknownQa=false,rerunBlockedQa=false,qaEnvironmentFailure=null,parallelSelection=null,qaConfigRevision=null,supersedeReason=null,acceptSupersededCodeDrift=false,allowAbandonReview=false,allowAbandonEffect=false,allowBootstrapReviewRecovery=false,holdRevision=false,specRebindReason=null}={}){
  // Check before importing node:sqlite: legacy Node users get a useful error.
  if(!isSupportedExecutionPlatform())fail('unsupported_runner_platform');
  const {conversationProtection}=await import('../runtime/js/cm-ai/host-conversation-execution.mjs');
  if(!['create','resume'].includes(mode))fail('invalid_mode');
  if(mode==='create')assertCreatableRunId(definition?.identity);
  if(supersedeReason!==null&&mode!=='create')fail('supersede_unavailable');
  if(allowAbandonEffect&&mode!=='resume')fail('effect_abandon_unavailable');
  if(allowBootstrapReviewRecovery&&mode!=='resume')fail('bootstrap_review_recovery_unavailable');
  if(typeof holdRevision!=='boolean')fail('invalid_input');
  if(specRebindReason!==null&&(mode!=='resume'||execution===null||typeof specRebindReason!=='string'||!specRebindReason.trim()
    ||Buffer.byteLength(specRebindReason,'utf8')>500||/[\r\n\0]/.test(specRebindReason)))fail('spec_rebind_unavailable');
  if(typeof acceptSupersededCodeDrift!=='boolean'||acceptSupersededCodeDrift&&supersedeReason===null)
    fail('supersede_unavailable');
  if(qaConfigRevision!==null&&(mode!=='resume'||!execution?.qaExecutor||rerunUnknownQa||rerunBlockedQa
    ||typeof qaConfigRevision.reason!=='string'||!qaConfigRevision.reason.trim()||qaConfigRevision.reason.length>500
    ||/[\r\n\0]/.test(qaConfigRevision.reason)||!qaConfigRevision.previousWorkflow))fail('qa_revision_authorization_required');
  if(typeof rerunUnknownQa!=='boolean'||typeof rerunBlockedQa!=='boolean'||rerunUnknownQa&&rerunBlockedQa
    ||(rerunUnknownQa||rerunBlockedQa)&&(mode!=='resume'||!execution?.qaExecutor))fail('qa_recovery_authorization_required');
  const {openTaskExecutionStore}=await import('../runtime/js/cm-ai/task-owner.mjs');
  const {createCmAiHost}=await import('../runtime/js/cm-ai/host.mjs');
  const {inspectCmAiAdmission,matchesCmAiTaskSelection,explainCmAiTaskSelection}=await import('../runtime/js/cm-ai/cm-ai-admission.mjs');
  const {captureReviewBaseline}=await import('../runtime/js/cm-ai/review-package.mjs');
  if(execution!==null){
    const {shape,json,validCallTimeout}=await import('../runtime/js/cm-ai/effect-contract.mjs');
    shape(execution,['configuration','developer','reviewers','reviewInvocation','check','hostDecision','excludedContexts','timeoutMs',
      ...['bootstrap','developmentAttempt','hostDecisionProvider','qaDecisionProvider','qaLogHome','qaExecutor','applicableAgentFiles','documentationProvider','documentationResult','documentationSync','verificationGate'].filter(key=>Object.hasOwn(execution,key))]);
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
  const tasksPath=path.join(specsDir,feature,'tasks.md');
  const featureSlug=feature.replace(/^\d+\./,'');
  const reviewsDir=path.join(specsDir,'.reviews');
  const supersession=mode==='create'&&supersedeReason!==null
    ?prepareReviewedEvidenceSupersession({specsDir,codeProject,feature,identity,reason:supersedeReason,tasksPath,
      acceptSupersededCodeDrift}):null;
  let bootstrapConfig=null;
  if(execution?.bootstrap){
    const {bootstrapConfiguration}=await import('../runtime/js/cm-ai/host-bootstrap.mjs');
    bootstrapConfig=bootstrapConfiguration(execution.bootstrap,{root:codeProject,identity,scope,feature});
  }
  if(parallelSelection!==null)parallelSelection=JSON.parse(JSON.stringify(parallelSelection));
  if(parallelSelection!==null&&definition.taskSelection)fail('task_selection_mismatch');
  const selection=parallelSelection??definition.taskSelection??null;
  const selectedRoots=definition.codeProjects?codeProjectPaths(codeProject,resolveCodeProjects(codeProject,definition.codeProjects)):null;
  if(selectedRoots){
    if(!execution||conversationProtection(execution)===null)fail('multi_root_protection_required');
    for(const root of definition.codeProjects){
      const selected=inspectCmAiAdmission({specsDir,codeProject:root});
      if(mode==='create'&&!matchesCmAiTaskSelection(selected,feature,identity.taskId,selection))
        return {blocked:selected,close:()=>{}};
    }
  }
  const developer=execution?.documentationSync
    ?(await import('../runtime/js/cm-ai/host-documentation.mjs')).withHostDocumentation({developer:execution.developer,
      documentationSync:execution.documentationSync,specsDir,codeProject,feature,scope,parallelSelection:selection}):execution?.developer;
  const admission=inspectCmAiAdmission({specsDir,codeProject});
  if(mode==='create'&&admission.state!=='ready')return {blocked:admission,close:()=>{}};
  if(mode==='create'&&!matchesCmAiTaskSelection(admission,feature,identity.taskId,selection))
    throw Object.assign(new Error('task_selection_mismatch'),{code:'task_selection_mismatch',
      reason:explainCmAiTaskSelection(admission,{feature,taskId:identity.taskId,selection})});
  const handoffs=[1,2].map(attempt=>path.join(reviewsDir,`${featureSlug}-${identity.taskId}-a${attempt}-handoff.json`));
  if(mode==='create'&&supersession===null){
    for(const [index,handoff] of handoffs.entries()){
      if(fs.existsSync(handoff)&&reviewConsumedHandoff(reviewsDir,path.basename(handoff),index+1))reviewedHandoffConflict();
    }
    assertNoUnrecordedPriorCode({specsDir,codeProject,feature,identity,tasksPath});
  }
  // Reuse the runner's real validator before creating durable state. A failed
  // baseline must not strand an otherwise unused run ID.
  const specification={specsRoot:specsDir,feature};
  const baselineOptions={root:codeProject,specsRoot:specsDir,identity,scope,requirements,specification,
    ...(bootstrapConfig?{bootstrapRequirements:bootstrapConfig.bootstrapRequirements}:{}),
    ...(selectedRoots?{codeProjectPaths:selectedRoots}:{})};
  if(mode==='create'){
    // The baseline is journaled as one record. One that cannot fit even on its own
    // is refused here, before any store exists; the runner checks the exact record.
    const preview=captureReviewBaseline(baselineOptions),bytes=Buffer.byteLength(JSON.stringify(preview));
    if(bytes>JOURNAL_PAYLOAD_LIMIT){
      const largest=preview.files.filter(file=>Object.hasOwn(file,'contentBase64')).sort((a,b)=>b.size-a.size).slice(0,3)
        .map(file=>`${file.path} ${file.size} bytes`);
      throw Object.assign(new Error(boundedReason(`limit_exceeded: the task baseline alone is ${bytes} bytes, above the journal record limit `
        +`${JOURNAL_PAYLOAD_LIMIT}; largest baseline material: `,largest)),{code:'limit_exceeded'});
    }
  }
  const storeIdentity={repositoryId:identity.repositoryId,runId:identity.runId};
  // Every fingerprint check below runs against one candidate material and
  // closes its store before the next candidate is tried.
  const openFor=material=>{
    const fingerprints={workflow:sha(execution===null?'cm-ai-control-v1':'cm-ai-host-execution-v1'),
      config:sha(material),inputs:sha({feature,task:identity.taskId})};
    const storeOptions={tasksPath,feature:featureSlug,specsRoot:specsDir,identity:storeIdentity,fingerprints,create:mode==='create'};
    let store,attaching=false,priorMaterial=null;
    if(qaConfigRevision!==null)priorMaterial=previousQaMaterial(material,qaConfigRevision.previousWorkflow);
    try{store=openTaskExecutionStore(storeOptions);}
    catch(error){
      if(mode!=='resume'||error.code!=='fingerprint_mismatch')throw error;
      const snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:storeIdentity});
      const last=qaRevisionChain(snapshot).revisions.at(-1);
      if(priorMaterial&&last?.toFingerprint===fingerprints.config&&last.fromFingerprint===sha(priorMaterial)
        &&last.reason===qaConfigRevision.reason)priorMaterial=null;
      if(priorMaterial||snapshot.records.some(row=>row.payload.type==='qa-config-revised')){
        verifyQaRevisionMaterial(snapshot,material,priorMaterial);
        store=openTaskExecutionStore({...storeOptions,fingerprints:{...fingerprints,config:snapshot.fingerprints.config}});
      }
      if(!store){
        for(const previous of preQaConfigurations(material)){
          try{store=openTaskExecutionStore({...storeOptions,fingerprints:{...fingerprints,config:sha(previous)}});break;}
          catch(cause){if(cause.code!=='fingerprint_mismatch')throw cause;}
        }
        if(!store){error.reason=explainFingerprintMismatch({snapshot,definition,execution,fingerprints});throw error;}
        attaching=true;
      }
    }
    try{
      const chain=qaRevisionChain(store.snapshot());
      if(chain.revisions.length&&chain.fingerprint!==fingerprints.config&&!priorMaterial)
        throw Object.assign(new Error('fingerprint_mismatch'),{code:'fingerprint_mismatch',
          reason:'QA 配置与最后一次 --revise-qa-config 修订后的配置不同；请用修订后的 --workflow-config 恢复'});
      if(chain.revisions.length||priorMaterial)verifyQaRevisionMaterial(store.snapshot(),material,priorMaterial);
      const attachments=store.snapshot().records.filter(row=>row.payload.type==='qa-attached');
      if(attachments.length>1)fail('qa_attachment_duplicate');
      const attached=attachments.length?readQaAttachment(attachments[0].payload.record):null;
      if(attached&&!chain.revisions.length&&!priorMaterial&&attached.qaFingerprint!==fingerprints.config)
        throw Object.assign(new Error('fingerprint_mismatch'),{code:'fingerprint_mismatch',
          reason:'启动配置与事后附加 QA 时绑定的配置不同；请用附加 QA 时的 --workflow-config 与参数恢复'});
      if(attaching&&store.snapshot().records.length===0)fail('qa_attach_not_completed');
      return {material,fingerprints,store,attaching,priorMaterial,chain,attached};
    }catch(error){store.close();throw error;}
  };
  let opened;
  try{opened=openFor(runConfigMaterial(definition,execution,{parallelSelection,bootstrapConfig}));}
  catch(error){
    // Only resume may fall back, and only to the exact historical QA form.
    if(mode!=='resume'||error.code!=='fingerprint_mismatch'||!hasLegacyQaPlanFingerprint(execution?.qaExecutor))throw error;
    try{opened=openFor(runConfigMaterial(definition,execution,{parallelSelection,bootstrapConfig,legacyQa:true}));}
    catch(cause){
      if(cause.code!=='fingerprint_mismatch')throw cause;
      throw Object.assign(error,{reason:error.reason?`${error.reason}。${LEGACY_QA_FINGERPRINT_REASON}`:LEGACY_QA_FINGERPRINT_REASON});
    }
  }
  const {material:configMaterial,fingerprints,store,attaching,priorMaterial,chain,attached}=opened;
  try{
    let runnerMode=mode;
    if(mode==='resume'&&store.snapshot().records.length===0){
      // Only the genuine, fingerprint-matching empty initializer can be finished.
      // Never reset/recreate a journal that contains any event.
      if(!matchesCmAiTaskSelection(admission,feature,identity.taskId,selection))
        fail('initialization_admission_required');
      captureReviewBaseline(baselineOptions);
      runnerMode='create';
    }
    const unavailable=()=>fail('execution_adapter_required');
    const host=createCmAiHost({
      runner:{root:codeProject,identity,scope,requirements,specification,...(selectedRoots?{codeProjectPaths:selectedRoots}:{}),excludedContexts:['control-host'],
        developer:{provider:'codex',requestedModel:'unconfigured',contextId:'control-developer',run:unavailable},
        reviewers:[],check:unavailable,taskCompletion:{reviewsDir,handoffs},taskLearning:{feature},
        persistence:{store,mode:runnerMode,version:execution===null?2:3},
        ...(execution===null?{}:{providerDevelopment:protectedExecutions.has(execution)
          ||Boolean(execution.configuration.providerDevelopment)}),
        ...(execution===null?{}:{developer,reviewers:execution.reviewers,
          ...(execution.bootstrap?{bootstrap:execution.bootstrap}:{}),
          reviewInvocation:execution.reviewInvocation,check:execution.check,
          excludedContexts:execution.excludedContexts,timeoutMs:execution.timeoutMs,
          ...(Object.hasOwn(execution,'verificationGate')?{verificationGate:execution.verificationGate}:{}),
          taskLearning:{feature,hostHandoff:true}})},
      // The entry validates the declaration (single line, with --rerun-blocked-qa) before any durable write.
      entry:{specsDir,codeProject,feature,identity,rerunUnknownQa,rerunBlockedQa,...(qaEnvironmentFailure===null?{}:{qaEnvironmentFailure}),allowAbandonReview,allowAbandonEffect,allowBootstrapReviewRecovery,...(holdRevision?{holdRevision}:{}),...(selection===null?{}:{parallelSelection:selection}),...(execution===null?{}:{hostDecision:execution.hostDecision,
        ...Object.fromEntries(['developmentAttempt','hostDecisionProvider','qaDecisionProvider','qaLogHome','qaExecutor','applicableAgentFiles','documentationProvider','documentationResult'].filter(key=>Object.hasOwn(execution,key)).map(key=>[key,execution[key]]))})},
    });
    const logAbandonments=()=>{
      for(const record of store.snapshot().records.filter(row=>row.payload.type==='review-invocation-abandoned'))
        recordReviewAbandonment({specsDir,codeProject,feature,identity,record,
          runtime:execution?.reviewers?.[0]?.provider??'codex',
          ...(execution?.qaLogHome?{logHome:execution.qaLogHome}:{})});
      for(const record of store.snapshot().records.filter(row=>row.payload.type==='effect-abandoned'))
        recordEffectAbandonment({specsDir,codeProject,feature,identity,record,
          runtime:execution?.developer?.provider??'codex',
          ...(execution?.qaLogHome?{logHome:execution.qaLogHome}:{})});
    };
    if(mode==='resume')logAbandonments();
    const recorded=store.snapshot().records.find(row=>row.payload.type==='evidence-superseded')?.payload.record??null;
    if(supersession!==null||recorded!==null){
      const record=host.supersedeEvidence(supersession??recorded);
      archiveReviewedEvidence(reviewsDir,record);
      recordEvidenceSupersession({specsDir,codeProject,identity,record,
        ...(execution?.qaLogHome?{logHome:execution.qaLogHome}:{})});
    }
    if(attaching||attached){
      const record=host.attachQa(attached??{version:1,qaFingerprint:fingerprints.config,
        attachedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),hostContextId:execution.configuration.hostContextId});
      // Repeating this deterministic log write also repairs a crash after the
      // journal append; neither the attachment nor QA dispatch is repeated.
      recordCmAiQaAttachment({specsDir,codeProject,feature,identity,record,
        ...(execution.qaLogHome?{logHome:execution.qaLogHome}:{})});
    }
    const qaBinding={specsDir,codeProject,feature,identity,
      ...(execution?.qaLogHome?{logHome:execution.qaLogHome}:{})};
    // Repair a crash after the journal append, before the log supersession.
    for(const record of chain.revisions)recordCmAiQaConfigurationRevision({...qaBinding,identity:{...identity,attempt:record.taskAttempt},packageDigest:record.packageDigest},record);
    if(specRebindReason!==null){
      // Consumed once on this launch; the journal record is the audit trail.
      host.rebindSpecification({version:1,reason:specRebindReason,at:new Date().toISOString()});
    }
    if(priorMaterial){
      if(sha(priorMaterial)===fingerprints.config)fail('qa_revision_unchanged');
      const current=await host.handle({version:1,operation:'status',requestId:'qa-revision-status',identity});
      // No QA round of this run has started: record a round-0 revision that
      // supersedes nothing and consumes no round. The runner re-checks state.
      const beforeQa=!hasCmAiQaRun({specsDir,feature,identity:current.identity});
      if(!beforeQa&&(current.state!=='fixture_completed'||current.code!==null))fail('qa_revision_not_completed');
      const binding={...qaBinding,identity:current.identity,packageDigest:current.packageDigest};
      const target=beforeQa?{testRunId:null,qaRound:0}:inspectCmAiQaRevisionTarget(binding);
      const record=host.reviseQa({version:1,fromFingerprint:sha(priorMaterial),toFingerprint:fingerprints.config,
        invariantDigest:qaInvariantDigest(configMaterial),previousQaDigest:sha(qaConfigurationSlice(priorMaterial)),qaDigest:sha(qaConfigurationSlice(configMaterial)),
        reason:qaConfigRevision.reason,hostContextId:execution.configuration.hostContextId,
        revisedAt:new Date().toISOString().replace(/\.\d{3}Z$/,'Z'),packageDigest:current.packageDigest??null,
        testRunId:target.testRunId,qaRound:target.qaRound,taskAttempt:current.identity.attempt});
      recordCmAiQaConfigurationRevision(binding,record);
    }
    return {host:{async handle(request){
      if(execution===null&&!['status','cancel'].includes(request.operation)){
        // Do not imply an unavailable execution adapter was dispatched.
        return {outcome:'blocked',code:'execution_adapter_required',providerCalls:0};
      }
      const result=await host.handle(request);
      if(['abandon_review','abandon_effect'].includes(request.operation)&&result.outcome==='abandoned')logAbandonments();
      return result;
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
    // Config diagnostics contain field names/reasons, never field values or provider text.
    const code=typeof cause.code==='string'&&(/^[a-z_]+$/.test(cause.code)
      ||cause.code.startsWith('invalid_config: '))?cause.code:'control_failed';
    error.write(JSON.stringify({error:{code}})+'\n');return 1;
  }finally{run?.close();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=await main();
