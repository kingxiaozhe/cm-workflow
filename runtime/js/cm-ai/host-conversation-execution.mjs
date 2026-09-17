// Fixed current-conversation factory, separate from CLI top-level execution.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {loadConfig,resolveProtectedRuntimes} from '../../../scripts/cm-workflow-config.mjs';
import {claudeDeveloperWorker,validateClaudeProposal} from './worker-claude-developer.mjs';
import {codexDeveloperWorker} from './worker-codex-developer.mjs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readCodexDeveloperRequest} from './codex-developer-adapter.mjs';
import {readClaudeDeveloperRequest} from './claude-developer-adapter.mjs';
import {createDeveloperRun,validateDeveloperValue} from './developer-adapter.mjs';
import {createCodexReviewRun} from './codex-review-adapter.mjs';
import {createClaudeReviewRun} from './claude-review-adapter.mjs';
import {claudeWorker,claudePreflightMatches} from './worker-claude.mjs';
import {codexWorker,preflightMatches} from './worker-codex.mjs';
import {createHostReviewAuthority} from './host-review-authority.mjs';
import {createHostWorkflowCapabilities} from './host-workflow-capabilities.mjs';
import {resolveHostRole} from './host-role-routing.mjs';
import {specsPermissionArgs} from './codex-config.mjs';
import {createProjectExecution} from './host-project-execution.mjs';
import {codeProjectPaths,codeProjectInstructionPaths,resolveCodeProjects} from './code-projects.mjs';
import {readProjectInstructionContext} from './cm-ai-context-refresh.mjs';
import {validateDocumentationPaths} from './host-documentation.mjs';
import {verifySpecificationMaterial} from './specification-material.mjs';
import {isFinalCmAiTask} from './cm-ai-admission.mjs';
import {createHostBootstrap} from './host-bootstrap.mjs';
import {digest,id,hex,json,need,shape,freeze} from './effect-contract.mjs';
export const protectedTextInstructions='\nProtected current-host mode: do not write files or run commands. Return {status,value,edits} on success; '
  +'value retains the original implementation/Learning contract. edits is [{path,beforeSha256,content}], complete UTF-8 text or null for deletion. '
  +'Only the supplied scope and expected hashes are allowed. The fixed sandbox applies these edits. On failure return {status,code} without edits. '
  +'status must be exactly "succeeded" on success (with value and edits) or "failed" (with code). Return the object through the structured output schema; never wrap it in markdown fences.';
const protectedConversations=new WeakMap();
export const conversationProtection=execution=>protectedConversations.get(execution)??null;
export function createConversationExecution(definition,hostContextId,bridge,review=null,allowedAttempt=null,workflow=null,allowQa=false,runtime='codex',options={}){
  definition=json(definition);workflow=workflow===null?null:json(workflow);options=json(options);
  shape(options,[...['protection','batchWorkflowsDigest','qaLogHome','bootstrap','providerDevelopment'].filter(key=>Object.hasOwn(options,key))]);
  const provider=options.providerDevelopment??null;
  if(provider){
    shape(provider,['model','attempt','coderRuntime','reviewerRuntime']);
    need(options.protection&&review!==null,'protected_configuration_required');
    need([1,2].includes(provider.attempt),'provider_development_authorization_required');
    need(/^[a-zA-Z0-9._-]+$/.test(provider.model),'invalid_model');
    need(digest(resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime))
      ===digest({coderRuntime:provider.coderRuntime,reviewerRuntime:provider.reviewerRuntime}),'runtime_selection_mismatch');
  }
  const coderRuntime=provider?.coderRuntime??runtime,reviewerRuntime=provider?.reviewerRuntime??runtime;
  let bootstrap=null;
  if(options.bootstrap){
    shape(options.bootstrap,['selection','allowWrite']);
    bootstrap=createHostBootstrap({definition,workflowRoot:path.resolve(fileURLToPath(new URL('../../..',import.meta.url))),
      selection:options.bootstrap.selection,bridge,allowWrite:options.bootstrap.allowWrite});
  }
  const protection=options.protection??null;
  if(protection){shape(protection,['checkCommands','timeoutMs']);specsPermissionArgs({cwd:definition.codeProject,specsRoot:definition.specsDir});}
  need(!definition.codeProjects||protection,'multi_root_protection_required');
  const projectExecution=protection?createProjectExecution({definition,protection}):null;
  const check=projectExecution?.check??null;
  const documentationPaths=workflow?validateDocumentationPaths(workflow.documentationPaths,definition.scope):[];
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  const allowedAttempts=allowedAttempt===null?[]:Array.isArray(allowedAttempt)?json(allowedAttempt):[allowedAttempt];
  need(allowedAttempts.length<=2&&new Set(allowedAttempts).size===allowedAttempts.length
    &&allowedAttempts.every(value=>value===1||value===2),'invalid_review_attempt');
  const author='cm-conversation-author',reviewContexts=['cm-conversation-review-1','cm-conversation-review-2'];
  id(hostContextId);need(![author,...reviewContexts].includes(hostContextId),'not_independent');
  // Keep the unverified native permissions boundary intact for this first host
  // slice too. A transport is not physical protection of nested specs.
  need(protection||!definition.specsDir.startsWith(definition.codeProject+path.sep),'nested_specs_protection_required');
  const configuration={kind:'cm-current-conversation-v1',definitionDigest:digest(definition),hostContextId,
    ...(runtime==='claude'?{runtime}:{}),
    ...(provider?{providerDevelopment:{model:provider.model,coderRuntime,reviewerRuntime}}:{}),
    ...(protection?{protection}:{}),
    ...(bootstrap?{bootstrap:bootstrap.configuration}:{}),
    ...(options.batchWorkflowsDigest?{batchWorkflowsDigest:options.batchWorkflowsDigest}:{}),
    ...(review?{review:{version:1,model:review.model,disabledSkills:review.disabledSkills}}:{}),
    ...(workflow?{workflow}: {})};
  const reviewOptions={cwd:definition.codeProject,model:review?.model??'unconfigured',preflight:review?.preflight??null,
    disabledSkills:review?.disabledSkills??[],
    ...(protection?{timeoutMs:protection.timeoutMs}:{}),
    promptTransport:'stdin',schemaPath:fileURLToPath(new URL('./review-result.schema.json',import.meta.url))};
  need(!allowedAttempts.length||review!==null,'review_configuration_required');
  if(allowedAttempts.length||provider)need((reviewerRuntime==='codex'?preflightMatches:claudePreflightMatches)(reviewOptions.preflight,reviewOptions),'tool_preflight_missing');
  need(reviewerRuntime!=='claude'||!review||review.disabledSkills.length===0,'invalid_review_config');
  // Preserve P4a's unauthorizable placeholder bytes for existing unconfigured runs.
  const reviewProvider=review?reviewerRuntime:'codex', adapterId=`${reviewProvider}-review-adapter`;
  const authority=review?createHostReviewAuthority({hostContextId,reviewerId:'reviewer',adapterId,
    decide:async binding=>allowedAttempts.includes(binding.identity.attempt)?{status:'approved'}:null}):null;
  // Reread role declarations at each boundary; never switch a bound invocation.
  const dispatchSpawn=(role,identity,signal)=>{
    const configuration=loadConfig({projectRoot:definition.codeProject});
    need(digest(resolveProtectedRuntimes(configuration,runtime))===digest({coderRuntime,reviewerRuntime}),'runtime_selection_mismatch');
    return (cli,args,options)=>{
      const child=spawn(cli,args,options);
      if(Number.isInteger(child.pid)){
        try{resolveHostRole({definition,identity,role,signal,runtime,configuration,
          dispatchedRuntime:role==='coder'?coderRuntime:reviewerRuntime});}
        catch(error){child.on('error',()=>{});child.stdin?.on('error',()=>{});
          try{options.detached?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL');}catch{}throw error;}
      }
      return child;
    };
  };
  const used=new Set();
  const execution={configuration,timeoutMs:provider?protection.timeoutMs:1800000,excludedContexts:[hostContextId],hostDecision:null,applicableAgentFiles:[],
    ...(bootstrap?{bootstrap}:{}),
    ...(provider?{developmentAttempt:provider.attempt}:{}),
    ...(workflow?createHostWorkflowCapabilities({definition,configuration:workflow,bridge,allowQa,runtime,protectedExecution:protection!==null,bootstrap}):{}),
    ...(options.qaLogHome?{qaLogHome:options.qaLogHome}:{}),
    ...(authority?{hostDecisionProvider:authority.hostDecisionProvider}:{}),
    developer:{provider:coderRuntime,requestedModel:provider?.model??'current-session',contextId:author,run:async(request,control)=>{
      const bound=(coderRuntime==='codex'?readCodexDeveloperRequest:readClaudeDeveloperRequest)(request);
      if(provider){
        need(bound.identity.attempt===provider.attempt&&digest({...bound.identity,attempt:1})===digest(definition.identity),'permission_denied');
        need(!used.has(bound.invocationId),'duplicate_dispatch');used.add(bound.invocationId);
      }
      const route=provider?null:resolveHostRole({definition,identity:bound.identity,role:'coder',signal:control.signal,runtime});
      const processWorker=provider?(coderRuntime==='codex'?codexDeveloperWorker:claudeDeveloperWorker)({
        cwd:definition.codeProject,model:provider.model,timeoutMs:protection.timeoutMs,
        ...(coderRuntime==='codex'?{specsRoot:definition.specsDir}:{}),
        spawnProcess:dispatchSpawn('coder',bound.identity,control.signal)}):null;
      const worker=async({prompt})=>{
        if(provider&&coderRuntime==='codex'){
          if(documentationPaths.length)prompt='Synchronize approved documentation inside this invocation: '+JSON.stringify(documentationPaths)+'\n'+prompt;
          return processWorker({prompt},control);
        }
        const expected=projectExecution?projectExecution.expected(bound.payload.scope):null;
        if(protection){
          prompt+=protectedTextInstructions;
          if(documentationPaths.length&&isFinalCmAiTask({specsDir:definition.specsDir,codeProject:definition.codeProject,
            feature:definition.feature,taskId:bound.identity.taskId}))prompt+=' Include necessary documentation synchronization in the same edits: '+JSON.stringify(documentationPaths);
        }
        const response=provider?await processWorker({prompt:prompt+'\n'+JSON.stringify({editMode:'protected-text-v1',expected})},control):json(await bridge.call('develop',{request:bound,prompt,codeProject:definition.codeProject,route,
          ...(definition.codeProjects?{codeProjects:resolveCodeProjects(definition.codeProject,definition.codeProjects),
            projectInstructions:definition.codeProjects.map(root=>({codeProject:root,files:readProjectInstructionContext(root)}))}:{}),
          ...(protection?{editMode:'protected-text-v1',expected}: {})},control.signal));
        if(response.status==='succeeded'){
          const edits=[];
          try{
            shape(response,['status','value',...(protection?['edits']:[]),...(provider?['providerThread']:[])]);
            if(provider){const {providerThread,...proposal}=response;id(providerThread);validateClaudeProposal(proposal);}
            if(protection){
              // Complete local validation precedes every protected write.
              validateDeveloperValue(response.value,bound);
              need(Array.isArray(response.edits),'protected_edit_invalid');
              if(response.value.outcome==='blocked')need(response.edits.length===0,'protected_edit_invalid');
              const seen=new Set();
              for(const edit of response.edits){
                shape(edit,['path','beforeSha256','content']);
                need(bound.payload.scope.includes(edit.path)&&!seen.has(edit.path),'out_of_scope');seen.add(edit.path);
                if(edit.beforeSha256!==null)hex(edit.beforeSha256);
                need(edit.content===null||typeof edit.content==='string','protected_edit_invalid');
                need(edit.content===null||Buffer.byteLength(edit.content)<=1024*1024,'limit_exceeded');
                need(edit.content!==null||edit.beforeSha256!==null,'protected_edit_invalid');
                // Reuse a previous proposal only when its exact output is
                // already present. A stale proposal never overwrites drift.
                if(edit.beforeSha256!==expected[edit.path]){
                  const after=edit.content===null?null:createHash('sha256').update(edit.content).digest('hex');
                  need(after===expected[edit.path],'protected_edit_stale');
                }else edits.push(edit);
              }
            }
          }catch(error){return {status:'failed',code:error.code==='protected_edit_stale'?'protected_edit_stale':'invalid_result',
            reason:error.code??'invalid_input'};}
          if(protection&&response.value.outcome!=='blocked'){
            if(bound.payload.specification)verifySpecificationMaterial({specificationRoot:definition.specsDir,
              specification:bound.payload.specification,identity:bound.identity});
            try{await projectExecution.commit({scope:bound.payload.scope,
              edits,expected,identity:bound.identity,signal:control.signal});}
            catch(error){
              // This code is emitted by the pre-write expected-hash check.
              // Sandbox execution/partial-write failures stay ambiguous.
              if(error.code==='protected_edit_stale')return {status:'failed',code:'protected_edit_stale'};
              throw error;
            }
          }
          // CLI session identity comes from the observed process stream; current
          // conversation responses retain the trusted host identity.
          return {status:response.status,value:response.value,providerThread:provider?response.providerThread:hostContextId};
        }
        if(provider){const {providerThread,...failure}=response;shape(failure,['status','code']);return failure;}
        shape(response,['status','code']);return response;
      };
      return createDeveloperRun({worker,provider:coderRuntime,requestedModel:provider?.model??'current-session',
        protectedCurrentSession:protection!==null&&provider===null})(bound,control);
    }},
    check:check??((request,control)=>{
      const route=resolveHostRole({definition,identity:request.identity,role:'tester',signal:control.signal,runtime});
      return bridge.call('check',{...request,codeProject:definition.codeProject,
        scope:definition.scope,requirements:definition.requirements,route},control.signal);
    }),
    // The opt-in path uses the original process adapter and observed events.
    // Diagnostic preflight alone never grants review dispatch.
    reviewers:[{id:'reviewer',adapterId,provider:reviewProvider,requestedModel:reviewOptions.model,
      allowed:true,available:true,contexts:reviewContexts,
      run:(request,control)=>{
        need(review!==null,'review_configuration_required');
        const selectedOptions={...reviewOptions,...(provider?{spawnProcess:dispatchSpawn('reviewer',request.identity,control.signal)}:{})};
        return reviewerRuntime==='codex'?createCodexReviewRun(codexWorker(selectedOptions))(request,control)
          :createClaudeReviewRun(claudeWorker(selectedOptions))(request,control);
      }}],
    reviewInvocation:{developerThreadId:author,excludedThreadIds:[hostContextId],
      authorize:authority?.authorize??(()=>({status:'denied',code:'permission_denied'}))},
  };
  if(definition.codeProjects)execution.applicableAgentFiles=[...new Set([...execution.applicableAgentFiles,
    ...codeProjectInstructionPaths(codeProjectPaths(definition.codeProject,definition.codeProjects))
      .filter(file=>file!=='AGENTS.md'&&fs.existsSync(path.join(definition.codeProject,file)))])];
  if(protection){freeze(execution);protectedConversations.set(execution,freeze({codeProject:definition.codeProject,
    specsRoot:definition.specsDir,definitionDigest:digest(definition)}));}
  return execution;
}
