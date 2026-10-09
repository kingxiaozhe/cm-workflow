import {createNativeUsageLog} from './native-usage-log.mjs';
import {readExecutionPolicy} from './execution-policy.mjs';
import {selectExternalModels} from './external-models.mjs';
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
import {checklistGaps} from './checklist-coverage.mjs';
import {specsPermissionArgs} from './codex-config.mjs';
import {createProjectExecution} from './host-project-execution.mjs';
import {codeProjectPaths,codeProjectInstructionPaths,resolveCodeProjects} from './code-projects.mjs';
import {readProjectInstructionContext} from './cm-ai-context-refresh.mjs';
import {validateDocumentationPaths} from './host-documentation.mjs';
import {verifySpecificationMaterial} from './specification-material.mjs';
import {isFinalCmAiTask} from './cm-ai-admission.mjs';
import {createHostBootstrap} from './host-bootstrap.mjs';
import {withHostProgress} from './host-progress.mjs';
import {digest,id,hex,json,need,shape,freeze,arrayItems} from './effect-contract.mjs';
export const protectedTextInstructions='\nProtected current-host mode: do not write files or run commands. Return {status,value,edits} on success; '
  +'value retains the original implementation/Learning contract. edits is [{path,beforeSha256,content[,mode]}], complete UTF-8 text or null for deletion; '
  +'optional mode "0755" or "0644" sets the permission bits of a written file. '
  +'Only the supplied scope and expected hashes are allowed. The fixed sandbox applies these edits. On failure return {status,code} without edits. '
  +'status must be exactly "succeeded" on success (with value and edits) or "failed" (with code). Return the object through the structured output schema; never wrap it in markdown fences.';
const protectedConversations=new WeakMap();
export const conversationProtection=execution=>protectedConversations.get(execution)??null;
const externalConversations=new WeakMap();
export const externalConversationDefinition=execution=>externalConversations.get(execution)??null;
// An explicit reviewer budget wins over the protected-mode budget: it is the
// narrower knob, and raising it must not require switching development mode.
// Absent both, the worker default applies. Returns a spread-ready fragment so
// an unset budget never plants an undefined timeoutMs on the worker options.
// Between the task's own checks and the independent review. It may only block:
// passing it is not an approval, produces no receipt and consumes no review
// round. A satisfied gate still leaves the full independent review ahead.
//
// One deliberate limit, stated rather than papered over: a task's verification
// is free text, so JS cannot prove every requirement in it was enumerated. What
// is enforced mechanically is the shape, that each returned requirement cites a
// nonempty evidence location, and that the gate passes only when every returned
// requirement is satisfied. Mechanical shape is not semantic coverage.
export function readVerificationPrecheck(raw){
  const value=json(raw,256*1024);shape(value,['items']);
  const items=arrayItems(value.items);
  need(items.length>0&&items.length<=64,'verification_precheck_invalid');
  for(const item of items){
    shape(item,['requirement','satisfied','evidence']);
    need(typeof item.satisfied==='boolean','verification_precheck_invalid');
    for(const field of ['requirement','evidence']){
      const text=item[field];
      need(typeof text==='string'&&text.trim().length>0&&Buffer.byteLength(text,'utf8')<=2000
        &&!/[\x00-\x08\x0b-\x1f]/.test(text),'verification_precheck_invalid');
    }
  }
  return freeze({satisfied:items.every(item=>item.satisfied===true),
    unsatisfied:items.filter(item=>item.satisfied!==true).map(item=>item.requirement),
    evidence:items.map(item=>item.evidence).join('\n')});
}

// The delivered evidence usually lives in the scope files (a walkthrough
// document, a baseline note), not in the gate answers, so the coverage
// reminder reads both. Unreadable, oversized, symlinked or binary entries are
// skipped: a file this reminder cannot read is the review's problem, not its
// own, and it must never turn a readable delivery into a failure.
const COVERAGE_FILE_LIMIT=256*1024;
export function deliveredText(codeProject,scope){
  if(typeof codeProject!=='string'||!Array.isArray(scope))return '';
  const parts=[];
  for(const entry of scope.slice(0,64)){
    if(typeof entry!=='string'||entry.length===0)continue;
    try{
      const file=path.join(codeProject,entry);
      const info=fs.lstatSync(file);
      if(!info.isFile()||info.isSymbolicLink()||info.size>COVERAGE_FILE_LIMIT)continue;
      const body=fs.readFileSync(file,'utf8');
      if(!body.includes('\u0000'))parts.push(body);
    }catch{/* a file the reminder cannot read simply contributes nothing */}
  }
  return parts.join('\n');
}

export function resolveReviewTimeout(review,protection){
  if(review?.timeoutMs!=null)return {timeoutMs:review.timeoutMs};
  if(protection)return {timeoutMs:protection.timeoutMs};
  return {timeoutMs:900000};
}
// The runner races each review against its own timer. That timer must outlast
// the reviewer's budget, or a budget raised above the runner's journaled call
// timeout (fixed at 30 minutes here) is still cut at 30 minutes and the attempt's
// only redispatch is spent. The worker stops its process group about a second
// after its own deadline; the margin leaves room for that and for close.
export const REVIEW_BOUND_MARGIN_MS=60000;
export const reviewRaceTimeout=(outerTimeoutMs,reviewTimeoutMs)=>Math.max(outerTimeoutMs,reviewTimeoutMs+REVIEW_BOUND_MARGIN_MS);
export function createConversationExecution(definition,hostContextId,bridge,review=null,allowedAttempt=null,workflow=null,allowQa=false,runtime='codex',options={}){
  definition=json(definition);workflow=workflow===null?null:json(workflow);options=json(options);
  shape(options,[...['originalHostContextId','protection','batchWorkflowsDigest','qaLogHome','bootstrap','providerDevelopment','externalModels','reviewerRuntime','reviewRuntime','parallelMember','verificationPrecheck','executionPolicy'].filter(key=>Object.hasOwn(options,key))]);
  need(!Object.hasOwn(options,'verificationPrecheck')||typeof options.verificationPrecheck==='boolean','invalid_input');
  const executionPolicy=options.executionPolicy?readExecutionPolicy(options.executionPolicy):null;
  const parallelMember=options.parallelMember??false;need(typeof parallelMember==='boolean','invalid_input');
  const provider=options.providerDevelopment??null;
  if(provider){
    shape(provider,['model','attempt','coderRuntime','reviewerRuntime',...(Object.hasOwn(provider,'effort')?['effort']:[])]);
    need(options.protection&&review!==null,'protected_configuration_required');
    need([1,2].includes(provider.attempt),'provider_development_authorization_required');
    need(/^[a-zA-Z0-9._-]+$/.test(provider.model),'invalid_model');
    need(digest(resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime))
      ===digest({coderRuntime:provider.coderRuntime,reviewerRuntime:provider.reviewerRuntime}),'runtime_selection_mismatch');
  }
  if(Object.hasOwn(options,'reviewerRuntime'))need(options.externalModels&&['codex','claude'].includes(options.reviewerRuntime)
    &&options.reviewerRuntime===resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime).reviewerRuntime,'runtime_selection_mismatch');
  // --review-runtime: the current session develops, the other tool reviews.
  // It must match the declared roles/runtimes and is bound into the run (the
  // configuration key reviewRuntime, as the 0.16.6 project patch wrote it).
  need(options.reviewRuntime===undefined||['codex','claude'].includes(options.reviewRuntime),'invalid_runtime');
  need(options.reviewRuntime===undefined||provider===null&&!Object.hasOwn(options,'reviewerRuntime'),'invalid_input');
  const coderRuntime=provider?.coderRuntime??runtime,reviewerRuntime=provider?.reviewerRuntime??options.reviewerRuntime??options.reviewRuntime??runtime;
  if(options.reviewRuntime!==undefined)need(digest(resolveProtectedRuntimes(loadConfig({projectRoot:definition.codeProject}),runtime))
    ===digest({coderRuntime,reviewerRuntime}),'runtime_selection_mismatch');
  const externalModels=options.externalModels?selectExternalModels(options.externalModels,provider?[coderRuntime,reviewerRuntime]:[reviewerRuntime]):null;
  if(externalModels){
    const selected=externalModels.providers[reviewerRuntime];need(review!==null&&review.model===selected.model&&review.effort===selected.effort,'external_model_configuration_conflict');
    if(provider){const selected=externalModels.providers[coderRuntime];need(provider.model===selected.model&&provider.effort===selected.effort,'external_model_configuration_conflict');}
  }else need(!Object.hasOwn(provider??{},'effort')&&!Object.hasOwn(review??{},'effort'),'external_model_feature_required');
  let bootstrap=null;
  if(options.bootstrap){
    shape(options.bootstrap,['selection','allowWrite']);
    bootstrap=createHostBootstrap({definition,workflowRoot:path.resolve(fileURLToPath(new URL('../../..',import.meta.url))),
      selection:options.bootstrap.selection,bridge,allowWrite:options.bootstrap.allowWrite});
  }
  const protection=options.protection??null;
  if(protection){shape(protection,['checkCommands','timeoutMs']);specsPermissionArgs({cwd:definition.codeProject,specsRoot:definition.specsDir});}
  need(!definition.codeProjects||protection,'multi_root_protection_required');
  const projectExecution=protection?createProjectExecution({definition,protection,executionPolicy}):null;
  const check=projectExecution?.check??null;
  const documentationPaths=workflow?validateDocumentationPaths(workflow.documentationPaths,definition.scope):[];
  need(['codex','claude'].includes(runtime),'invalid_runtime');
  const allowedAttempts=allowedAttempt===null?[]:Array.isArray(allowedAttempt)?json(allowedAttempt):[allowedAttempt];
  need(allowedAttempts.length<=2&&new Set(allowedAttempts).size===allowedAttempts.length
    &&allowedAttempts.every(value=>value===1||value===2),'invalid_review_attempt');
  const author='cm-conversation-author',reviewContexts=['cm-conversation-review-1','cm-conversation-review-2'];
  const durableHostContextId=options.originalHostContextId??hostContextId;
  for(const context of [hostContextId,durableHostContextId]){
    id(context);need(![author,...reviewContexts].includes(context),'not_independent');
  }
  // Keep the unverified native permissions boundary intact for this first host
  // slice too. A transport is not physical protection of nested specs.
  need(protection||!definition.specsDir.startsWith(definition.codeProject+path.sep),'nested_specs_protection_required');
  const configuration={kind:'cm-current-conversation-v1',...(parallelMember?{parallelMember}:{}),definitionDigest:digest(definition),hostContextId:durableHostContextId,
    ...(runtime==='claude'?{runtime}:{}),
    ...(options.reviewRuntime===undefined?{}:{reviewRuntime:options.reviewRuntime}),
    ...(executionPolicy?{executionPolicy}:{}),
    ...(externalModels?{externalModels}:{}),
    ...(provider?{providerDevelopment:{model:provider.model,coderRuntime,reviewerRuntime,...(externalModels?{effort:provider.effort}:{})}}:{}),
    ...(protection?{protection}:{}),
    ...(bootstrap?{bootstrap:bootstrap.configuration}:{}),
    ...(options.batchWorkflowsDigest?{batchWorkflowsDigest:options.batchWorkflowsDigest}:{}),
    ...(review?{review:{version:1,model:review.model,disabledSkills:review.disabledSkills,...(externalModels?{effort:review.effort}:{})}}:{}),
    ...(workflow?{workflow}: {})};
  const reviewOptions={cwd:definition.codeProject,model:review?.model??'unconfigured',...(externalModels?{effort:review.effort}:{}),preflight:review?.preflight??null,
    disabledSkills:review?.disabledSkills??[],
    ...resolveReviewTimeout(review,protection),
    promptTransport:'stdin',schemaPath:fileURLToPath(new URL('./review-result.schema.json',import.meta.url))};
  need(!allowedAttempts.length||review!==null,'review_configuration_required');
  if(allowedAttempts.length||provider)need((reviewerRuntime==='codex'?preflightMatches:claudePreflightMatches)(reviewOptions.preflight,reviewOptions),'tool_preflight_missing');
  need(reviewerRuntime!=='claude'||!review||review.disabledSkills.length===0,'invalid_review_config');
  // Preserve P4a's unauthorizable placeholder bytes for existing unconfigured runs.
  const reviewProvider=review?reviewerRuntime:'codex', adapterId=`${reviewProvider}-review-adapter`;
  const authority=review?createHostReviewAuthority({hostContextId,reviewerId:'reviewer',adapterId,
    decide:async binding=>allowedAttempts.includes(binding.identity.attempt)?{status:'approved'}:null}):null;
  // Reread role declarations at each boundary; never switch a bound invocation.
  // onWorker (provider development, task-runner.mjs) journals the worker's
  // identity right before and right after the spawn; a journal failure kills
  // the new process group like a refused role route does.
  const dispatchSpawn=(role,identity,signal,onWorker=null)=>{
    const configuration=loadConfig({projectRoot:definition.codeProject});
    need(digest(resolveProtectedRuntimes(configuration,runtime))===digest({coderRuntime,reviewerRuntime}),'runtime_selection_mismatch');
    return (cli,args,options)=>{
      onWorker?.({phase:'spawning'});
      const child=spawn(cli,args,options);
      if(Number.isInteger(child.pid)){
        try{onWorker?.({phase:'started',pid:child.pid});
          resolveHostRole({definition,identity,role,signal,runtime,configuration,
          dispatchedRuntime:role==='coder'?coderRuntime:reviewerRuntime});}
        catch(error){child.on('error',()=>{});child.stdin?.on('error',()=>{});
          try{options.detached?process.kill(-child.pid,'SIGKILL'):child.kill('SIGKILL');}catch{}throw error;}
      }
      return child;
    };
  };
  const used=new Set();
  // The gate is opt-in: without it the flow is byte-for-byte what it was.
  // The runner contract is exactly {satisfied}. Which requirements failed is
  // what the operator needs to act on, so it goes to this process's stderr the
  // same way other host diagnostics do, not into the runner state.
  const verificationGate=options.verificationPrecheck===true?async(request,control)=>{
    const verdict=readVerificationPrecheck(await bridge.call('verification_precheck',
      {...request,codeProject:definition.codeProject,feature:definition.feature,
        scope:definition.scope},control.signal));
    if(!verdict.satisfied)try{
      process.stderr.write(JSON.stringify({diagnostic:'verification_precheck_failed',
        task:request.identity.taskId,attempt:request.identity.attempt,
        unsatisfied:verdict.unsatisfied})+'\n');
    }catch{/* diagnostics never change the verdict */}
    // Advisory only. An enumerated list in the task text whose entries are not
    // all present in the delivery is the cheapest rejection to catch, but
    // wording differs legitimately ("列表为空" vs "空列表"), so this reports and
    // never rejects: the verdict below is the gate's, untouched.
    try{
      const gaps=checklistGaps([request.description,request.verification]
        .filter(text=>typeof text==='string').join('\n'),
        [verdict.evidence,deliveredText(definition.codeProject,definition.scope)].join('\n'));
      if(gaps.length>0)process.stderr.write(JSON.stringify({diagnostic:'checklist_coverage',
        task:request.identity.taskId,attempt:request.identity.attempt,advisory:true,
        gaps:gaps.map(gap=>({total:gap.total,missing:gap.missing}))})+'\n');
    }catch{/* diagnostics never change the verdict */}
    return {satisfied:verdict.satisfied};
  }:null;
  const outerTimeoutMs=provider?protection.timeoutMs:1800000;
  const progress=(request,control,stage,run,selectedRuntime=runtime)=>withHostProgress({definition,
    identity:request.identity,runtime:selectedRuntime,stage,signal:control.signal},run);
  const execution={configuration,timeoutMs:outerTimeoutMs,excludedContexts:[durableHostContextId],hostDecision:null,applicableAgentFiles:[],
    ...(verificationGate?{verificationGate:(request,control)=>progress(request,control,'verifying',()=>verificationGate(request,control))}:{}),
    ...(bootstrap?{bootstrap}:{}),
    ...(provider?{developmentAttempt:provider.attempt}:{}),
    ...(workflow?createHostWorkflowCapabilities({definition,configuration:workflow,bridge,allowQa,runtime,protectedExecution:protection!==null,bootstrap,parallelMember}):{}),
    ...(options.qaLogHome?{qaLogHome:options.qaLogHome}:{}),
    ...(authority?{hostDecisionProvider:authority.hostDecisionProvider}:{}),
    developer:{provider:coderRuntime,requestedModel:provider?.model??'current-session',contextId:author,run:async(request,control)=>{
      const bound=(coderRuntime==='codex'?readCodexDeveloperRequest:readClaudeDeveloperRequest)(request);
      if(provider){
        need(bound.identity.attempt===provider.attempt&&digest({...bound.identity,attempt:1})===digest(definition.identity),'permission_denied');
        need(!used.has(bound.invocationId),'duplicate_dispatch');used.add(bound.invocationId);
      }
      const route=provider?null:resolveHostRole({definition,identity:bound.identity,role:'coder',signal:control.signal,runtime});
      let developerUsage=null;const developerLog=executionPolicy&&provider?createNativeUsageLog({definition,request:bound,provider:coderRuntime,role:'developer'}):null;
      const processWorker=provider?(coderRuntime==='codex'?codexDeveloperWorker:claudeDeveloperWorker)({
        ...(developerLog?{onUsageClaim:()=>developerLog.claimed(),onUsage:value=>{developerUsage=value;}}:{}),
        cwd:definition.codeProject,model:provider.model,...(externalModels?{effort:provider.effort}:{}),timeoutMs:protection.timeoutMs,
        ...(coderRuntime==='codex'?{specsRoot:definition.specsDir}:{}),
        spawnProcess:dispatchSpawn('coder',bound.identity,control.signal,typeof control.onWorker==='function'?control.onWorker:null)}):null;
      const worker=async({prompt})=>{
        if(provider&&coderRuntime==='codex'){
          if(documentationPaths.length)prompt='Synchronize approved documentation inside this invocation: '+JSON.stringify(documentationPaths)+'\n'+prompt;
          const response=await processWorker({prompt},control);
          developerLog?.complete(developerUsage??{usage_state:'unavailable'},response.status==='succeeded'?'success':response.status==='cancelled'?'cancelled':'error');
          return response;
        }
        const expected=projectExecution?projectExecution.expected(bound.payload.scope):null;
        if(protection){
          prompt+=protectedTextInstructions;
          if(!parallelMember&&documentationPaths.length&&isFinalCmAiTask({specsDir:definition.specsDir,codeProject:definition.codeProject,
            feature:definition.feature,taskId:bound.identity.taskId,featureSelection:definition.featureSelection?.feature}))prompt+=' Include necessary documentation synchronization in the same edits: '+JSON.stringify(documentationPaths);
        }
        const response=provider?await processWorker({prompt:prompt+'\n'+JSON.stringify({editMode:'protected-text-v1',expected})},control):json(await bridge.call('develop',{request:bound,prompt,codeProject:definition.codeProject,route,
          ...(definition.codeProjects?{codeProjects:resolveCodeProjects(definition.codeProject,definition.codeProjects),
            projectInstructions:definition.codeProjects.map(root=>({codeProject:root,files:readProjectInstructionContext(root)}))}:{}),
          ...(protection?{editMode:'protected-text-v1',expected}: {})},control.signal));
        if(provider)developerLog?.complete(developerUsage??{usage_state:'unavailable'},response.status==='succeeded'?'success':response.status==='cancelled'?'cancelled':'error');
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
                shape(edit,['path','beforeSha256','content',...(Object.hasOwn(edit,'mode')?['mode']:[])]);
                need(!Object.hasOwn(edit,'mode')||edit.content!==null&&['0644','0755'].includes(edit.mode),'protected_edit_invalid');
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
            // The applying sandbox subprocess is journaled like the worker (V9).
            try{await projectExecution.commit({scope:bound.payload.scope,
              edits,expected,identity:bound.identity,signal:control.signal,
              ...(typeof control.onWorker==='function'?{onApply:event=>control.onWorker(event)}:{})});}
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
      return progress(bound,control,'developing',()=>createDeveloperRun({worker,provider:coderRuntime,requestedModel:provider?.model??'current-session',
        protectedCurrentSession:protection!==null&&provider===null})(bound,control),coderRuntime);
    }},
    check:(request,control)=>progress(request,control,'checking',()=>{
      if(check)return check(request,control);
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
        let observedUsage=null;const usageLog=executionPolicy?createNativeUsageLog({definition,request,provider:reviewerRuntime,role:'reviewer'}):null;
        const selectedOptions={...reviewOptions,...(usageLog?{onUsageClaim:()=>usageLog.claimed(),onUsage:value=>{observedUsage=value;}}:{}),...(provider?{spawnProcess:dispatchSpawn('reviewer',request.identity,control.signal)}:{})};
        return progress(request,control,'review_starting',async observation=>{
          const observedControl={...control,onEvent:event=>{
            control.onEvent(event);
            if(event.event==='thread.started')observation.reviewStarted();
          }};
          const result=await (reviewerRuntime==='codex'?createCodexReviewRun(codexWorker(selectedOptions),executionPolicy)(request,observedControl)
            :createClaudeReviewRun(claudeWorker(selectedOptions),executionPolicy)(request,observedControl));
          usageLog?.complete(observedUsage??{usage_state:'unavailable'},result.status==='succeeded'?'success':result.status==='cancelled'?'cancelled':'error');
          return result;
        },reviewerRuntime);
      }}],
    reviewInvocation:{developerThreadId:author,excludedThreadIds:[durableHostContextId],hostContextId,
      // Not journaled (unlike timeoutMs above), so a resumed run may raise it.
      timeoutMs:reviewRaceTimeout(outerTimeoutMs,reviewOptions.timeoutMs),
      authorize:authority?.authorize??(()=>({status:'denied',code:'permission_denied'}))},
  };
  if(definition.codeProjects)execution.applicableAgentFiles=[...new Set([...execution.applicableAgentFiles,
    ...codeProjectInstructionPaths(codeProjectPaths(definition.codeProject,definition.codeProjects))
      .filter(file=>file!=='AGENTS.md'&&fs.existsSync(path.join(definition.codeProject,file)))])];
  if(protection){freeze(execution);protectedConversations.set(execution,freeze({codeProject:definition.codeProject,
    specsRoot:definition.specsDir,definitionDigest:digest(definition)}));}
  if(externalModels||executionPolicy){freeze(execution);externalConversations.set(execution,digest(definition));}
  return execution;
}
