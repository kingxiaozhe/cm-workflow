// Approved 0.bootstrap instruction task, inside the original develop effect.
// A factory capability owns only init's fixed paths; never a developer grant.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {cmInitRuleTargets,generateCmInitDraft,validateCmInitSelection} from '../cm-init/draft-generation.mjs';
import {inspectCmInitDraft,readCmInitSource} from '../cm-init/draft-inspection.mjs';
import {replaceSessionFile} from '../cm-prd/session.mjs';
import {readReviewSourceFiles,readReviewBaseline} from './review-package.mjs';
import {inspectCmAiBootstrapTask} from './cm-ai-admission.mjs';
import {readProjectInstructionContext,createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective} from './cm-ai-context-refresh.mjs';
import {validateDeveloperScope,readDeveloperRequest} from './developer-adapter.mjs';
import {digest,json,shape,need,freeze,validIdentity,hex,requestFor,terminalFor} from './effect-contract.mjs';

const capabilities=new WeakMap();
const categories=['commands','globs','file_references','constraint_preservation','rule_applicability'];
const sha=bytes=>bytes===null?null:createHash('sha256').update(bytes).digest('hex');
const same=(a,b)=>need(digest(a)===digest(b),'bootstrap_binding_changed');
const canonical=root=>need(typeof root==='string'&&path.isAbsolute(root)&&fs.realpathSync(root)===root
  &&fs.lstatSync(root).isDirectory(),'bootstrap_root_invalid');

export function readBootstrapEvidence(raw,configuration,identity){
  const value=json(raw);
  shape(value,['version','workflow','phase','identity','invocationId','configurationDigest','files','contextFiles','evidenceDigest']);
  need(value.version===1&&value.workflow==='cm-ai'&&value.phase==='bootstrap_instructions','bootstrap_evidence_invalid');
  validIdentity(value.identity);same(value.identity,identity);same(value.configurationDigest,digest(configuration));
  need(typeof value.invocationId==='string'&&value.invocationId.length>0,'bootstrap_evidence_invalid');
  need(Array.isArray(value.files)&&value.files.length===configuration.instructionPaths.length,'bootstrap_evidence_invalid');
  same(value.files.map(file=>file.path),configuration.instructionPaths);
  for(const file of value.files){shape(file,['path','beforeSha256','afterSha256']);
    if(file.beforeSha256!==null)hex(file.beforeSha256);hex(file.afterSha256);}
  need(Array.isArray(value.contextFiles),'bootstrap_evidence_invalid');
  for(const file of value.contextFiles){shape(file,['scope','path','sha256']);need(file.scope==='project','bootstrap_evidence_invalid');hex(file.sha256);}
  for(const file of value.files)need(value.contextFiles.some(item=>item.path===file.path&&item.sha256===file.afterSha256),'bootstrap_context_missing');
  const {evidenceDigest,...body}=value;same(evidenceDigest,digest(body));return value;
}

// Journal validation consumes data only. Callback provenance is checked at
// construction by bootstrapConfiguration, never inferred from this descriptor.
export function validateBootstrapReviewPackage(pkg,evidence,configuration,identity,writeback){
  const value=readBootstrapEvidence(evidence,configuration,identity);
  for(const file of value.files){
    const change=pkg.changes.find(item=>item.path===file.path);
    const expected=file.path==='AGENTS.md'&&writeback.outcome==='written'?writeback.agentsFile.sha256:file.afterSha256;
    need(change?.after?.sha256===expected&&pkg.scope.includes(file.path),'bootstrap_review_mismatch');
  }
  return value;
}

export function bootstrapConfiguration(capability,{root,identity,scope,feature}){
  const configuration=capabilities.get(capability);need(configuration,'bootstrap_capability_required');
  same(configuration.codeProject,root);same(configuration.identity, {...identity,attempt:1});
  same(configuration.scope,scope);need(feature==='0.bootstrap','bootstrap_task_required');return configuration;
}

export function createHostBootstrap({definition,workflowRoot,selection,bridge,allowWrite}){
  const data=json(definition);validIdentity(data.identity);need(data.identity.attempt===1&&data.feature==='0.bootstrap','bootstrap_task_required');
  canonical(data.codeProject);canonical(data.specsDir);canonical(workflowRoot);
  need(typeof bridge?.call==='function'&&typeof allowWrite==='boolean','bootstrap_configuration_invalid');
  // Construction is non-writing and may occur during resume. Only the runner's
  // validated original empty baseline permits an in-progress scaffold below.
  const selected=inspectCmAiBootstrapTask({specsDir:data.specsDir,codeProject:data.codeProject,taskId:data.identity.taskId},true);
  const mode=selected.mode,choice=mode==='scaffold'?null:validateCmInitSelection(selection);
  const instructionPaths=mode==='scaffold'?[]:cmInitRuleTargets(choice);
  need(Array.isArray(data.scope)&&new Set(data.scope).size===data.scope.length
    &&instructionPaths.every(file=>data.scope.includes(file)),'bootstrap_scope_required');
  const businessScope=data.scope.filter(file=>!instructionPaths.includes(file));
  if(businessScope.length)validateDeveloperScope(businessScope);
  for(const file of instructionPaths){const target=path.join(data.codeProject,file);
    need(target!==data.specsDir&&!target.startsWith(data.specsDir+path.sep),'bootstrap_specs_overlap');}
  const bootstrapRequirements={specsRoot:data.specsDir,feature:data.feature,
    files:readReviewSourceFiles(data.specsDir,['0.bootstrap/requirements.md','0.bootstrap/design.md'])};
  const policyDigest=digest(instructionPaths.slice(2).map(file=>{
    const relative='templates/rules/'+path.basename(file);return [relative,sha(readCmInitSource(workflowRoot,relative))];}));
  const configuration=json({version:1,mode,codeProject:data.codeProject,specsDir:data.specsDir,feature:data.feature,
    identity:data.identity,scope:data.scope,businessScope,instructionPaths,workflowRoot,selection:choice,policyDigest,bootstrapRequirements});
  const used=new Set();
  const admission=baseline=>{
    const original=readReviewBaseline(baseline);
    same(original.bootstrapRequirements,bootstrapRequirements);
    if(mode==='scaffold')need(original.files.length===0,'bootstrap_original_not_empty');
    return inspectCmAiBootstrapTask({specsDir:data.specsDir,codeProject:data.codeProject,taskId:data.identity.taskId},mode==='scaffold').admission;
  };
  const capability={configuration,inspectAdmission:admission,
    assertWriteAuthorized(){need(allowWrite,'bootstrap_write_authorization_required');},
    async run(request,control,develop,{previous=null,previousWriteback=null,baseline}={}){
    need(allowWrite,'bootstrap_write_authorization_required');
    need(!control.signal.aborted,'cancelled');
    same({...request.identity,attempt:1},data.identity);same(request.payload.scope,data.scope);
    need(!used.has(request.invocationId),'bootstrap_dispatch_unknown');
    const currentAdmission=admission(baseline);
    need(currentAdmission.nextTask?.feature===data.feature&&currentAdmission.nextTask.id===request.identity.taskId,'bootstrap_task_required');
    const prior=previous===null?null:readBootstrapEvidence(previous,configuration,{...request.identity,attempt:request.identity.attempt-1});
    if(mode==='instructions')need(request.identity.attempt===1?prior===null:prior!==null,'bootstrap_prior_evidence_required');
    const originals=instructionPaths.map(file=>({path:file,bytes:readCmInitSource(data.codeProject,file)}));
    for(const file of originals){
      const expected=file.path==='AGENTS.md'&&prior!==null&&previousWriteback?.outcome==='written'
        ?previousWriteback.agentsFile.sha256:prior?.files.find(item=>item.path===file.path).afterSha256??null;
      need(sha(file.bytes)===expected,'bootstrap_instruction_conflict');
    }
    used.add(request.invocationId);
    const current=()=>{
      canonical(data.codeProject);
      for(const file of originals)need(sha(readCmInitSource(data.codeProject,file.path))===sha(file.bytes),'bootstrap_instruction_conflict');
    };
    let response=null;
    if(businessScope.length){
      const {requestDigest,...body}=request;
      const scoped=requestFor({...body,payload:{...request.payload,scope:businessScope,
        requirements:[...request.payload.requirements,...bootstrapRequirements.files]}});
      readDeveloperRequest(scoped,request.provider);
      response=terminalFor(await develop(scoped,control),scoped);
      if(response.status!=='succeeded')return terminalFor(response,request);
    }
    if(mode==='scaffold'){
      need(response!==null,'bootstrap_business_scope_required');
      // The scaffold still cannot create project instructions. Native workers
      // enforce this; the host also rejects an inconsistent synthetic result.
      need(readProjectInstructionContext(data.codeProject).length===0,'bootstrap_instruction_conflict');
      return terminalFor(response,request);
    }
    current();need(!control.signal.aborted,'cancelled');
    const draft=await generateCmInitDraft({project:data.codeProject,workflowRoot,selection:choice},{signal:control.signal,
      generate:(payload,signal)=>bridge.call('init_generate',{...payload,bootstrap:{identity:request.identity,
        invocationId:request.invocationId,requirements:[...request.payload.requirements,...bootstrapRequirements.files],
        priorReview:request.payload.priorReview}},signal)});
    need(draft.status==='draft_generated'&&draft.inspection.status==='structurally_checked','bootstrap_generation_blocked');
    const verified=json(await bridge.call('init_verify',{project:data.codeProject,selection:choice,documents:draft.documents,
      inspection:draft.inspection,categories,learningInput:request.payload.learningInput,
      instructions:'Verify every generated instruction against the approved bootstrap selection and current project. Do not write files, install or dispatch providers. Return {checks,constraintChanges,application,retrospective}; checks use status/evidence. Application and retrospective use the original developer Learning response fields. Unverified assertions block. This is host verification, not independent Review.'},control.signal));
    shape(verified,['checks','constraintChanges','application','retrospective']);shape(verified.checks,categories);
    for(const check of Object.values(verified.checks)){shape(check,['status','evidence']);
      need(['verified','not_applicable'].includes(check.status)&&typeof check.evidence==='string'&&check.evidence.trim(),'bootstrap_verification_blocked');}
    need(Array.isArray(verified.constraintChanges)&&verified.constraintChanges.length===0,'bootstrap_constraint_confirmation_required');
    const learning=request.payload.learningInput;
    need(learning?.feature==='0.bootstrap','bootstrap_learning_required');
    shape(verified.application,['status','note']);shape(verified.retrospective,['status','candidates','reason']);
    const binding={feature:learning.feature,identity:request.identity,learningDigest:learning.learningDigest};
    const application=createCmAiTaskLearningApplication({...binding,...verified.application});
    const retrospective=createCmAiTaskLearningRetrospective({...binding,...verified.retrospective});
    current();need(!control.signal.aborted,'cancelled');
    same(inspectCmInitDraft({project:data.codeProject,documents:draft.documents}).changes,draft.inspection.changes);
    // All targets are prechecked before the first write. Interruption stays in
    // the runner's original unknown develop effect, never an automatic retry.
    for(const document of draft.documents){
      need(!control.signal.aborted,'cancelled');canonical(data.codeProject);
      let parent=data.codeProject;
      for(const part of document.path.split('/').slice(0,-1)){
        parent=path.join(parent,part);try{fs.mkdirSync(parent,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
        canonical(parent);
      }
      const before=originals.find(file=>file.path===document.path).bytes;
      replaceSessionFile(data.codeProject,document.path,before===null?null:new TextDecoder('utf8',{fatal:true}).decode(before),document.content);
    }
    const after=inspectCmInitDraft({project:data.codeProject,documents:draft.documents});
    need(after.status==='structurally_checked'&&after.changes.every(file=>file.action==='unchanged'),'bootstrap_write_unknown');
    const contextFiles=readProjectInstructionContext(data.codeProject).map(({content,...file})=>file);
    // Optional module rules must be reachable through the generated entry.
    const evidenceBody={version:1,workflow:'cm-ai',phase:'bootstrap_instructions',identity:request.identity,
      invocationId:request.invocationId,configurationDigest:digest(configuration),
      files:instructionPaths.map(file=>{const change=draft.inspection.changes.find(item=>item.path===file);
        return {path:file,beforeSha256:change.beforeSha256,afterSha256:change.afterSha256};}),contextFiles};
    const bootstrap=readBootstrapEvidence({...evidenceBody,evidenceDigest:digest(evidenceBody)},configuration,request.identity);
    return terminalFor({version:1,invocationId:request.invocationId,contextId:request.contextId,provider:request.provider,
      effectiveModel:response?.effectiveModel??'host-bootstrap',status:'succeeded',accepted:true,
      ...(response?.providerThreadId?{providerThreadId:response.providerThreadId}:{}),
      result:{outcome:'implemented',application,retrospective,bootstrap}},request);
  }};
  freeze(capability);capabilities.set(capability,configuration);return capability;
}
