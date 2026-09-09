// Fixed current-conversation factory, separate from CLI top-level execution.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCodexDeveloperRun,readCodexDeveloperRequest} from './codex-developer-adapter.mjs';
import {createClaudeDeveloperRun,readClaudeDeveloperRequest} from './claude-developer-adapter.mjs';
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
import {isFinalCmAiTask} from './cm-ai-admission.mjs';
import {createHostBootstrap} from './host-bootstrap.mjs';
import {digest,id,json,need,shape,freeze} from './effect-contract.mjs';
const protectedConversations=new WeakMap();
export const conversationProtection=execution=>protectedConversations.get(execution)??null;
export function createConversationExecution(definition,hostContextId,bridge,review=null,allowedAttempt=null,workflow=null,allowQa=false,runtime='codex',options={}){
  definition=json(definition);workflow=workflow===null?null:json(workflow);options=json(options);
  shape(options,[...['protection','batchWorkflowsDigest','qaLogHome','bootstrap'].filter(key=>Object.hasOwn(options,key))]);
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
    ...(protection?{protection}:{}),
    ...(bootstrap?{bootstrap:bootstrap.configuration}:{}),
    ...(options.batchWorkflowsDigest?{batchWorkflowsDigest:options.batchWorkflowsDigest}:{}),
    ...(review?{review:{version:1,model:review.model,disabledSkills:review.disabledSkills}}:{}),
    ...(workflow?{workflow}: {})};
  const reviewOptions={cwd:definition.codeProject,model:review?.model??'unconfigured',preflight:review?.preflight??null,
    disabledSkills:review?.disabledSkills??[],
    promptTransport:'stdin',schemaPath:fileURLToPath(new URL('./review-result.schema.json',import.meta.url))};
  need(!allowedAttempts.length||review!==null,'review_configuration_required');
  if(allowedAttempts.length)need((runtime==='codex'?preflightMatches:claudePreflightMatches)(reviewOptions.preflight,reviewOptions),'tool_preflight_missing');
  need(runtime!=='claude'||!review||review.disabledSkills.length===0,'invalid_review_config');
  // Preserve P4a's unauthorizable placeholder bytes for existing unconfigured runs.
  const reviewProvider=review?runtime:'codex', adapterId=`${reviewProvider}-review-adapter`;
  const authority=review?createHostReviewAuthority({hostContextId,reviewerId:'reviewer',adapterId,
    decide:async binding=>allowedAttempts.includes(binding.identity.attempt)?{status:'approved'}:null}):null;
  const execution={configuration,timeoutMs:1800000,excludedContexts:[hostContextId],hostDecision:null,applicableAgentFiles:[],
    ...(bootstrap?{bootstrap}:{}),
    ...(workflow?createHostWorkflowCapabilities({definition,configuration:workflow,bridge,allowQa,runtime,protectedExecution:protection!==null,bootstrap}):{}),
    ...(options.qaLogHome?{qaLogHome:options.qaLogHome}:{}),
    ...(authority?{hostDecisionProvider:authority.hostDecisionProvider}:{}),
    developer:{provider:runtime,requestedModel:'current-session',contextId:author,run:async(request,control)=>{
      const bound=(runtime==='codex'?readCodexDeveloperRequest:readClaudeDeveloperRequest)(request);
      const route=resolveHostRole({definition,identity:bound.identity,role:'coder',signal:control.signal,runtime});
      const worker=async({prompt})=>{
        const expected=projectExecution?projectExecution.expected(bound.payload.scope):null;
        if(protection){
          prompt+='\nProtected current-host mode: do not write files or run commands. Return {status,value,edits} on success; '
            +'value retains the original implementation/Learning contract. edits is [{path,beforeSha256,content}], complete UTF-8 text or null for deletion. '
            +'Only the supplied scope and expected hashes are allowed. The fixed sandbox applies these edits. On failure return {status,code} without edits.';
          if(documentationPaths.length&&isFinalCmAiTask({specsDir:definition.specsDir,codeProject:definition.codeProject,
            feature:definition.feature,taskId:bound.identity.taskId}))prompt+=' Include necessary documentation synchronization in the same edits: '+JSON.stringify(documentationPaths);
        }
        const response=json(await bridge.call('develop',{request:bound,prompt,codeProject:definition.codeProject,route,
          ...(definition.codeProjects?{codeProjects:resolveCodeProjects(definition.codeProject,definition.codeProjects),
            projectInstructions:definition.codeProjects.map(root=>({codeProject:root,files:readProjectInstructionContext(root)}))}:{}),
          ...(protection?{editMode:'protected-text-v1',expected}: {})},control.signal));
        if(response.status==='succeeded'){
          shape(response,['status','value',...(protection?['edits']:[])]);
          if(protection){
            need(Array.isArray(response.edits),'protected_edit_invalid');
            if(response.value?.outcome==='blocked')need(response.edits.length===0,'protected_edit_invalid');
            else await projectExecution.commit({scope:bound.payload.scope,
              edits:response.edits,expected,identity:bound.identity,signal:control.signal});
          }
          // This execution surface is the current trusted host, not a thread ID
          // invented by a model response. Exclude it from independent Review.
          return {status:response.status,value:response.value,providerThread:hostContextId};
        }
        shape(response,['status','code']);return response;
      };
      return (runtime==='codex'?createCodexDeveloperRun:createClaudeDeveloperRun)({worker,requestedModel:'current-session'})(bound,control);
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
        return runtime==='codex'?createCodexReviewRun(codexWorker(reviewOptions))(request,control)
          :createClaudeReviewRun(claudeWorker(reviewOptions))(request,control);
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
