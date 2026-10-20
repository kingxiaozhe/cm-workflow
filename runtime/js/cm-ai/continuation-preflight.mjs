import {readReviewScopeLimits,REVIEW_SCOPE_MESSAGE,inspectReviewScope} from './review-scope-policy.mjs';
import {providerRecoveryRequest,providerRecoverySource} from './provider-review-recovery.mjs';
import {nativeMaterialReviewBinding} from './native-material-review.mjs';
import {inspectEvidenceContinuationReviewInput,prepareCodexReviewInput,buildReviewPrompt} from './codex-review-adapter.mjs';
import {unicodeScalars,assertCodexReviewTransportProfile,planCodexReviewInput} from './codex-review-input.mjs';
import {effectiveReviewer} from './reviewer-switch.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest,need,shape,requestFor,JOURNAL_PAYLOAD_LIMIT,developCheckpointReserve} from './effect-contract.mjs';
import {controlLaunchTarget,readRunDefinition} from '../../../scripts/cm-ai-run.mjs';
import {readScopeRevisionFile,readConversationProtection} from '../../../scripts/cm-ai-host.mjs';
import {readBinaryAssetConfiguration,inspectBinaryAssetSource} from './binary-assets.mjs';
import {readRunJournal,developPreview,projectDevelopCheckpoint,plannedCheckResults,readDevelopEntry,readDriverPermissions,readDriverControl} from '../../../scripts/cm-ai-drive.mjs';
import {readControlPolicyFile,controlTarget,assertExpectedControl} from './control-policy.mjs';
import {evidenceRequest,evidenceContinuationSource,evidenceAuthorizationSource} from './valid-review-evidence-continuation.mjs';
import {projectedRunnerStatus,attemptBaseline,developBudgetExhausted,developBudget,nativeCorrectionBinding,applyNativeCorrection,applyNativeCorrectionScope,nativeReviewRetryBinding,nativeTransportReviewRetryBinding,supersededReviewPayload} from './durable-runner-state.mjs';
import {captureReviewBaseline,readReviewSourceFiles,createReviewPackage,captureScopeRevisionSources,verifyReviewPackage} from './review-package.mjs';
import {createProtectedScopeSupplement,projectProtectedScopeCommands} from './protected-scope-supplement.mjs';
import {inspectNativeReviewEvidence} from './native-review-evidence.mjs';
import {taskContinuationConditions,taskContinuationBinding,revisedScope} from './scope-revision.mjs';
import {taskContinuationNeedsSnapshot,verifyTaskExecutionSnapshot,verifyAcceptedTaskRules,captureTaskReviewOrigin,applyTaskReviewOrigin,verifyTaskReviewOrigin} from './task-review-origin.mjs';
import {packageMaterialEligible,checkpointPackageBudget} from './checkpoint-package-material.mjs';
import {oldWriterOpen} from './reviewed-evidence-supersede.mjs';
import {reviewPaths} from './review-runner.mjs';
import {appendFits,PHYSICAL_LIMIT} from './execution-store-limits.mjs';
import {taskDeclarations,approvedTaskGrammar} from '../spec-task-line.mjs';
import {RECOVERY_PHASES} from './recovery-capabilities.mjs';
const size=value=>Buffer.byteLength(JSON.stringify(value));
const fail=code=>{throw Object.assign(new Error(code),{code});};
const read=file=>readScopeRevisionFile(file);
const exact=(a,b,code)=>need(digest(a)===digest(b),code);
// No calls to host/open store/check/model. All observations are bounded reads.
export function inspectContinuationPlan(planFile){
  const base=path.dirname(fs.realpathSync(planFile)),plan=read(planFile),definition=readRunDefinition(path.resolve(base,plan.config));
  need(['create','resume'].includes(plan.mode)&&Array.isArray(plan.permissions),'invalid_input');
  plan.permissions=readDriverPermissions(plan.permissions);readDriverControl(plan,base,'status');
  const flag=name=>{const at=plan.permissions.indexOf(name);return at<0?null:plan.permissions[at+1];};
  const file=name=>{const value=flag(name);return value===null?null:path.resolve(base,value);};
  const report={version:1,readOnly:true,mode:plan.mode,identity:definition.identity,verified:[],estimates:[],unknown:[
    'future model output and reviewer verdict','future check/device/environment outcomes','owner launch fingerprint and authorization revalidation'],
    issues:[],actions:[],recoveryPhases:RECOVERY_PHASES};
  function reportReviewInput(request,existing=false,projected=false){
    const limits=readReviewScopeLimits(file('--review-config')?read(file('--review-config')).scopeLimits:undefined);
    const prompt=buildReviewPrompt(request,request.provider,journal?.config.executionPolicy??null);
    const scope=inspectReviewScope(prompt,request.payload.reviewPackage,limits);
    const input=report.currentReviewInput={requestDigest:request.requestDigest,packageDigest:request.payload.reviewPackage.packageDigest,
      ...scope.measured,scope,projected,authorizationGranted:false,
      scopeDisposition:existing?'warning_existing_review':scope.exceeded?'blocked_new_review':'within_limits'};
    if(scope.exceeded){
      input.message=REVIEW_SCOPE_MESSAGE;
      if(!existing)report.issues.push({stage:'review-scope',code:'review_scope_too_large',scope,reason:REVIEW_SCOPE_MESSAGE});
    }
    // Measurements survive even a separate hard transport refusal.
    if(request.provider==='codex'){
      const prepared=planCodexReviewInput(prompt,request,{limits});
      assertCodexReviewTransportProfile(prepared,journal?.config.binaryAssets??null);
      input.transport=prepared.material?'read_material':'inline';input.initialScalars=unicodeScalars(prepared.prompt);
    }else {input.transport='inline';input.initialScalars=unicodeScalars(prompt);}
    report.verified.push('review scope and provider presentation; no call, grant or verdict');
  }
  let journal=null,baseline=null,effective=definition,continuation=null,writerFree=true,binaryAssets=null,nativeCorrection=null,nativeReviewRetryProjection=false;
  const issue=(stage,error)=>report.issues.push({stage,code:error.code??'preflight_unavailable',...(error.condition?{condition:error.condition}:{})});
  try{
    if(plan.mode==='resume'){
      journal=readRunJournal(definition);baseline=journal.history.original;continuation=journal.history.taskContinuation;
      report.identity={...definition.identity,attempt:journal.history.state.attempt};
      report.target=controlLaunchTarget(journal.snapshot);
      report.history={records:journal.snapshot.records.length,revision:journal.snapshot.revision,
        originalBaselineDigest:baseline.baselineDigest,reviewReceipts:journal.history.state.receipts.length,
        attempt:journal.history.state.attempt,pending:journal.history.pending?.kind??null};
      exact(definition.identity,journal.config.identity,'fingerprint_mismatch');
      exact(definition.scope,journal.config.scope,'fingerprint_mismatch');
      exact(definition.requirements,journal.config.requirements,'fingerprint_mismatch');
      need(definition.codeProject===journal.config.root,'fingerprint_mismatch');
      if(plan.controlConfig)exact(readControlPolicyFile(path.resolve(base,plan.controlConfig)),journal.config.controlPolicy,'fingerprint_mismatch');
      else need(!journal.config.controlPolicy,'fingerprint_mismatch');
      report.verified.push('original definition identity/root/scope/requirements/control policy and append-only replay');
      effective={...definition,scope:journal.history.effectiveScope};
      nativeCorrection=journal.history.nativeCorrection;
      report.stage=journal.history.state.state;
      report.budget={...developBudget(journal.history.state,journal.history.developRecheckEffects),
        ...(nativeCorrection?{nativeCorrection:{developAvailable:!nativeCorrection.developConsumed,
          reviewAvailable:nativeCorrection.developConsumed&&!nativeCorrection.reviewConsumed,
          ...(nativeCorrection.reviewRetry?{technicalReviewAvailable:!nativeCorrection.reviewRetry.consumed}:{}),
          ...(nativeCorrection.transportReviewRetry?{transportReviewAvailable:!nativeCorrection.transportReviewRetry.consumed}:{})}}:{})};
      verifyAcceptedTaskRules({root:definition.codeProject,continuation});
      if(continuation&&taskContinuationNeedsSnapshot(journal.snapshot.records))verifyTaskExecutionSnapshot({root:definition.codeProject,currentFiles:continuation.currentFiles});
      writerFree=!oldWriterOpen(path.join(definition.specsDir,'.reviews','.execution'),definition.identity.runId);
      need(writerFree,'store_busy');report.verified.push('no observed writer descriptor (must recheck under owner lock)');
      need(journal.history.pending===null&&(journal.history.transaction===null
        ||journal.history.state.state==='fixture_completed'&&journal.history.transaction.resultRecord!==null),'pending_effect');
    }else{
      const protectionFile=file('--protected-conversation-config');
      if(protectionFile!==null){
        const protection=readConversationProtection(protectionFile);
        if(protection.binaryAssets){
          need(!definition.codeProjects&&!plan.permissions.includes('--bootstrap-config'),'binary_asset_configuration');
          binaryAssets=readBinaryAssetConfiguration(protection.binaryAssets,{...definition});
          need(plan.answers&&fs.realpathSync(path.resolve(base,plan.answers))===binaryAssets.sourceRoot,'binary_asset_source');
          // Pure text projection only. Publishing binary blobs is exclusively an
          // owner operation, so a readonly estimate cannot claim its final fit.
          const textScope=definition.scope.filter(p=>!binaryAssets.paths.includes(p));
          effective={...definition,scope:textScope.length?textScope:['AGENTS.md']};
          report.binaryAssets={sources:[],archiveVerified:false};
          report.unknown.push('binary archive publication, aggregate store capacity and full encoded owner package/checkpoint');
        }
      }
      baseline=captureReviewBaseline({root:definition.codeProject,specsRoot:definition.specsDir,
        identity:definition.identity,scope:effective.scope,requirements:definition.requirements,
        specification:{specsRoot:definition.specsDir,feature:definition.feature}});
      report.verified.push(binaryAssets?'non-binary baseline projection (not the owner baseline)':'new task baseline snapshot');
      report.unknown.push('new-run admission/execution config final serialized metadata');
    }
  }catch(error){issue('history/config/writer',error);writerFree=false;}
  if(baseline===null)return {...report,status:'blocked'};
  report.baseline={bytes:size(baseline),remainingPayloadBytes:JOURNAL_PAYLOAD_LIMIT-size(baseline),
    materialBytes:baseline.files.reduce((sum,row)=>sum+(Object.hasOwn(row,'contentBase64')||Object.hasOwn(row,'contentGzipBase64')?row.size:0),0),
    inventoryBytes:size(baseline.files.filter(row=>!Object.hasOwn(row,'contentBase64')&&!Object.hasOwn(row,'contentGzipBase64')))};
  let preparedOrigin=null,scope=null,binding=null;
  if(file('--task-review-origin')!==null)try{
    need(journal&&writerFree&&!['--protected-conversation-config','--protected-config','--scope-check-supplement'].some(name=>plan.permissions.includes(name)),'task_continuation_unavailable');
    need(file('--revise-scope')&&file('--expected-control')&&flag('--scope-revision-reason'),'invalid_input');
    assertExpectedControl(read(file('--expected-control')),report.target);
    report.continuationConditions=taskContinuationConditions(journal.history.state,journal.config,journal.history.scopeRevisions);
    binding=taskContinuationBinding(journal.history.state,journal.config,journal.history.scopeRevisions);
    need(!developBudgetExhausted(journal.history.state,journal.history.developRecheckEffects),'scope_revision_budget_exhausted');
    const owner=journal.config.completion.owner;
    const tasks=taskDeclarations(fs.readFileSync(owner.tasksPath,'utf8'),{grammar:approvedTaskGrammar(owner.specsRoot)}).filter(row=>row.id===definition.identity.taskId);
    need(tasks.length===1&&!tasks[0].completed,'scope_revision_task_completed');
    scope=revisedScope(read(file('--revise-scope')),journal.history.effectiveScope);
    const authorization=read(file('--task-review-origin'));
    preparedOrigin=captureTaskReviewOrigin({root:definition.codeProject,original:baseline,scope,commit:authorization.commit,
      authorization,state:journal.history.state,config:journal.config});
    continuation={...applyTaskReviewOrigin({original:baseline,scope,record:preparedOrigin,config:journal.config,state:journal.history.state})};
    verifyTaskReviewOrigin(preparedOrigin,{root:definition.codeProject,original:baseline,scope,config:journal.config,state:journal.history.state});
    effective={...definition,scope};
    if(preparedOrigin.authorization.ruleAcceptance){report.ruleAcceptance={registered:false,authorizationGranted:false,
      ownerRevalidationRequired:true,manifest:preparedOrigin.authorization.ruleAcceptance};
      report.verified.push('exact committed rule changes: original creation hashes, current bytes and HEAD; review-only paths, no developer write permission');}
    report.verified.push('fixed target, a2/r1 state, explicit exact additions and fixed Git before/current execution snapshots');
  }catch(error){preparedOrigin=null;issue('task-review-origin',error);}
  if(file('--native-correction')!==null)try{
    need(journal&&writerFree&&file('--expected-control')!==null,'native_correction_unavailable');
    assertExpectedControl(read(file('--expected-control')),report.target);
    const value=read(file('--native-correction'));
    if(value.providerReviewRecovery===true){
      providerRecoveryRequest(value);const cfg={...journal.config,scope:journal.history.effectiveScope},h=journal.history;
      const source=providerRecoverySource(journal.snapshot.records,h.state,cfg,baseline,h.nativeCorrection,h.evidenceContinuation,h.providerRecovery);
      need(digest(source)===digest(value.source),'snapshot_changed');nativeReviewRetryProjection=true;
      report.providerReviewRecovery={source,registered:false,authorizationGranted:false,remainingDevelop:0,remainingReview:0,ownerRevalidationRequired:true};
      report.unknown.push('owner must reject same-call saved results, revalidate complete package, input capacity and original writer lock before one separately authorized intent');
    }else if(value.evidenceContinuation===true||value.evidenceReview===true){
      evidenceRequest(value);const cfg={...journal.config,scope:journal.history.effectiveScope},h=journal.history;
      const source=value.evidenceReview?evidenceAuthorizationSource(journal.snapshot.records,h.state,cfg,baseline,h.evidenceContinuation)
        :evidenceContinuationSource(journal.snapshot.records,h.state,cfg,baseline,h.nativeCorrection,h.evidenceContinuation);
      need(digest(source)===digest(value.source),'snapshot_changed');
      if(value.evidenceContinuation)need(inspectNativeReviewEvidence(value.nativeEvidence,{codeProject:definition.codeProject,specsDir:definition.specsDir,identity:source.identity,scope:cfg.scope}).manifestDigest===value.manifestDigest,'evidence_continuation_manifest_changed');
      if(value.evidenceContinuation){const selected=cfg.reviewers[0],request=requestFor({invocationId:`${h.session}.${h.state.sequence+1}`,identity:source.identity,role:'reviewer',provider:selected.provider,requestedModel:selected.requestedModel,contextId:selected.contexts[1],payload:{reviewPackage:h.state.reviewPackage,priorReview:h.state.receipt.result}});
        report.evidenceReviewInput=inspectEvidenceContinuationReviewInput(request,value,{codeProject:definition.codeProject,specsDir:definition.specsDir,oldReceipt:h.state.receipt,state:h.state});}
      nativeReviewRetryProjection=true;report.evidenceContinuation={registered:false,authorizationGranted:false,remainingDevelop:0,remainingReview:0,source,ownerRevalidationRequired:true};
      report.unknown.push('owner captures immutable new evidence, verifies full original package and transport capacity; evidence registration grants no invocation');
    }else if(Object.hasOwn(value,'textEvidenceReview')){
      shape(value,['version','reason','textEvidenceReview','nativeEvidence','textManifestDigest']);
      need(value.version===1&&value.textEvidenceReview===true,'native_material_review_unavailable');
      const cfg={...journal.config,scope:journal.history.effectiveScope};
      const binding=nativeMaterialReviewBinding(journal.history.state,cfg,baseline,nativeCorrection);
      const material=inspectNativeReviewEvidence(value.nativeEvidence,{codeProject:definition.codeProject,specsDir:definition.specsDir,identity:report.identity,scope:cfg.scope});
      need(material.material.version===2&&material.material.textEvidence.manifestDigest===value.textManifestDigest,'native_material_review_evidence');
      nativeReviewRetryProjection=true;
      report.nativeMaterialReview={...binding,remainingDevelop:0,remainingReview:1,authorizationGranted:false,ownerRevalidationRequired:true};
      report.unknown.push('owner must capture and compare exact complete text supplement, verify final package/input and registration capacity before granting');
    }else if(Object.hasOwn(value,'technicalReviewRetry')||Object.hasOwn(value,'transportReviewRetry')){
      const transport=Object.hasOwn(value,'transportReviewRetry'),flag=transport?'transportReviewRetry':'technicalReviewRetry';
      nativeReviewRetryProjection=true;
      shape(value,['version','reason',flag]);
      need(value.version===1&&value[flag]===true,'native_review_retry_unavailable');
      need(typeof value.reason==='string'&&value.reason.trim()&&Buffer.byteLength(value.reason)<=500
        &&!/[\r\n\0]/.test(value.reason),'native_review_retry_reason_required');
      const cfg={...journal.config,scope:journal.history.effectiveScope};
      const retryBinding=(transport?nativeTransportReviewRetryBinding:nativeReviewRetryBinding)(journal.history.state,cfg,baseline,nativeCorrection);
      const owner=cfg.completion.owner;
      const tasks=taskDeclarations(fs.readFileSync(owner.tasksPath,'utf8'),{grammar:approvedTaskGrammar(owner.specsRoot)}).filter(row=>row.id===definition.identity.taskId);
      need(tasks.length===1&&!tasks[0].completed,'native_review_retry_task_completed');
      report.nativeReviewRetry={registered:false,...retryBinding,remainingDevelop:0,remainingReview:1,
        authorizationGranted:false,ownerRevalidationRequired:true};
      report.verified.push('native technical review retry shared durable eligibility, fixed target and unchanged saved package identity');
      report.unknown.push('native technical review retry owner launch compatibility, retained evidence and registration capacity under writer lock');
    }else{
      shape(value,['version','reason','nativeEvidence',...['scope','checkSupplement'].filter(key=>Object.hasOwn(value,key))]);
      need(value.version===1&&Object.hasOwn(value,'scope')===Object.hasOwn(value,'checkSupplement'),'native_correction_scope');
      const cfg={...journal.config,scope:journal.history.effectiveScope},state=journal.history.state;
      const correctionBinding=nativeCorrectionBinding(state,cfg,baseline,journal.history.nativeCorrection,
        journal.history.nativeReviewRecovery,journal.history.developRecheckEffects);
      const owner=cfg.completion.owner;
      const tasks=taskDeclarations(fs.readFileSync(owner.tasksPath,'utf8'),{grammar:approvedTaskGrammar(owner.specsRoot)}).filter(row=>row.id===definition.identity.taskId);
      need(tasks.length===1&&!tasks[0].completed,'native_correction_task_completed');
      const retainedEvidence=[cfg.completion.handoffs[0],path.join(cfg.completion.reviewsDir,owner.feature+'-'+definition.identity.taskId+'-r1.md'),
        cfg.completion.handoffs[1],path.join(cfg.completion.reviewsDir,owner.feature+'-'+definition.identity.taskId+'-r2.md')].map(target=>{
          const [record]=readReviewSourceFiles(path.dirname(target),[path.basename(target)]);return {path:target,sha256:record.sha256};
        });
      const record={correctionVersion:1,epoch:1,fromDigest:journal.snapshot.records.at(-1).digest,...correctionBinding,
        callLimit:8,effectLimit:8,retainedEvidence,sourceDigest:digest(retainedEvidence),reason:value.reason,
        nativeEvidence:value.nativeEvidence,at:'2000-01-01T00:00:00.000Z'};
      if(Object.hasOwn(value,'scope')){
        const material=journal.snapshot.records.findLast(row=>row.payload.protectedSupplement?.material)?.payload.protectedSupplement.material;
        if(!material){report.unknown.push('native correction frozen protected scope material unavailable; owner must validate scope and capacity');
          return {...report,status:report.issues.length?'blocked':'estimated'};}
        const scope=revisedScope(value.scope,cfg.scope);
        const protectedSupplement=createProtectedScopeSupplement(value.checkSupplement,{material,
          configFingerprint:cfg.completion.fingerprints.config,scope});
        projectProtectedScopeCommands(material.execution.protection.checkCommands,protectedSupplement,scope);
        const workflow=material.execution.workflow?.configuration??material.execution.workflow;
        if(workflow?.qa?.commands)projectProtectedScopeCommands(workflow.qa.commands,protectedSupplement,scope);
        Object.assign(record,{scope,files:captureScopeRevisionSources(definition.codeProject,baseline,scope),protectedSupplement});
      }
      applyNativeCorrection(state,cfg,baseline,record,journal.history.nativeCorrection,journal.history.nativeReviewRecovery,journal.history.developRecheckEffects);
      const next=applyNativeCorrectionScope(cfg,baseline,record);baseline=next.baseline;effective={...definition,scope:next.scope};
      nativeCorrection={...record,recordDigest:'0'.repeat(64),developConsumed:false,reviewConsumed:false};
      report.nativeCorrection={registered:false,scope:next.scope,baselineDigest:baseline.baselineDigest,
        countedCalls:correctionBinding.countedCalls,countedEffects:correctionBinding.countedEffects,
        remainingDevelop:1,remainingReview:1,authorizationGranted:false,ownerRevalidationRequired:true};
      report.verified.push('native correction shared durable predicates, fixed target, retained evidence and exact scope baseline projection');
      report.unknown.push('native correction owner launch compatibility, protected configuration, old package publication and registration capacity under writer lock');
    }
  }catch(error){issue('native-correction',error);}
  try{
    const taskBase=attemptBaseline(baseline,report.identity.attempt,continuation);
    report.taskBaseline={digest:taskBase.baselineDigest,origin:taskBase.taskReviewOrigin??null,...(binaryAssets?{diagnosticOnly:true}:{})};
    report.effectiveScope=effective.scope;
    // A stored delivery is the current fact. Later phases never project old
    // developer answers again, including after completion and source archival.
    if(journal&&(nativeReviewRetryProjection||nativeCorrection?.reviewRetry||journal.history.pending?.kind==='review'
      ||['awaiting_review','reviewing','approved','fixture_completed'].includes(journal.history.state.state))){
      const pkg=journal.history.state.reviewPackage;
      need(pkg!==null,'preflight_unavailable');
      verifyReviewPackage({root:definition.codeProject,baseline:taskBase,checks:pkg.checks,reviewPackage:pkg,
        expectedDigest:pkg.packageDigest,...(pkg.handoff?{handoffPath:path.join(journal.config.completion.reviewsDir,pkg.handoff.path)}:{})});
      report.currentPackage={packageDigest:pkg.packageDigest,packageBytes:size(pkg),changedPaths:pkg.changes.map(row=>row.path),stored:true};
      report.verified.push('stored package, current source, archived native material and handoff; developer answers are not replayed');
      if(['awaiting_review','reviewing'].includes(journal.history.state.state)||journal.history.pending?.kind==='review'||nativeReviewRetryProjection
        ||nativeCorrection?.reviewRetry&&!nativeCorrection.reviewRetry.consumed
        ||nativeCorrection?.transportReviewRetry&&!nativeCorrection.transportReviewRetry.consumed){
        const state=journal.history.state,selected=effectiveReviewer(journal.config.reviewers[0],journal.history.reviewerSwitch);
        const existing=journal.history.pending?.kind==='review'||state.state==='reviewing';
        const binding=existing?state.reviewInvocation?.registration?.binding:null;
        const request=requestFor({invocationId:binding?.invocationId??`${journal.history.session}.${state.sequence+1}`,
          identity:{...journal.config.identity,attempt:state.attempt},role:'reviewer',provider:selected.provider,
          requestedModel:selected.requestedModel,contextId:binding?.logicalContextId??selected.contexts[state.attempt-1],
          payload:{reviewPackage:pkg,priorReview:state.priorReview,
            ...supersededReviewPayload(journal.history.supersession?.carriedReview??null,state.attempt)}});
        if(binding)need(request.requestDigest===binding.requestDigest,'review_request_invalid');
        reportReviewInput(request,existing);
      }
      return {...report,status:report.issues.length?'blocked':'estimated'};
    }
    // Exact current tree package validates all unrelated files and spec material.
    const checks=plannedCheckResults(plan.checks);
    try{const current=createReviewPackage({root:definition.codeProject,baseline:taskBase,checks});
      report.currentPackage={packageBytes:size(current),changedPaths:current.changes.map(row=>row.path)};
      report.verified.push(binaryAssets?'current non-binary tree and bound specification (binary owner snapshot pending)':'current tree within effective scope and bound specification');
    }catch(error){if(error.code!=='empty_changes')throw error;}
    const answers=plan.answers?path.resolve(base,plan.answers):null,attempt=report.identity.attempt;
    const answerName=attempt===1?'develop.json':`develop-a${attempt}.json`;
    let value=answers&&fs.existsSync(path.join(answers,answerName))?read(path.join(answers,answerName)):null;
    const projected=new Map();
    for(const target of effective.scope){
      if(fs.existsSync(path.join(definition.codeProject,target))){const [record]=readReviewSourceFiles(definition.codeProject,[target]);
        projected.set(target,{path:target,contentBase64:record.contentBase64,mode:record.mode});}
    }
    if(value?.status==='succeeded')for(const [target,raw]of Object.entries(value.edits??{})){
      need((binaryAssets?definition.scope:effective.scope).includes(target),'out_of_scope');const entry=readDevelopEntry(target,raw,answers);
      if(binaryAssets?.paths.includes(target)){
        const before=fs.existsSync(path.join(definition.codeProject,target))
          ?inspectBinaryAssetSource({sourceRoot:definition.codeProject,sourcePath:target}):null;
        need(entry.kind!=='mode'&&(!entry.mode||entry.mode==='0644'),'protected_edit_invalid');
        if(entry.kind==='delete')need(before!==null,'read_failed');
        const after=entry.kind==='delete'?null:inspectBinaryAssetSource({sourceRoot:binaryAssets.sourceRoot,sourcePath:entry.local});
        report.binaryAssets.sources.push({path:target,sourcePath:entry.local??null,beforeSha256:before?.sha256??null,
          afterSha256:after?.sha256??null,size:after?.size??0,mode:after?0o644:null});
        continue;
      }
      if(entry.kind==='delete'){need(!definition.requirements.includes(target),'read_failed');projected.set(target,{path:target,contentBase64:null,mode:null});}
      else if(entry.kind==='write'){
        const [source]=readReviewSourceFiles(answers,[entry.local]);projected.set(target,{path:target,contentBase64:source.contentBase64,
          mode:entry.mode?parseInt(entry.mode,8):projected.get(target)?.mode??0o644});
      }else{need(projected.has(target),'read_failed');projected.get(target).mode=parseInt(entry.mode,8);}
    }
    if(binaryAssets){
      const proposed=new Set(report.binaryAssets.sources.map(row=>row.path));
      for(const target of binaryAssets.paths.filter(p=>!proposed.has(p))){
        if(fs.existsSync(path.join(definition.codeProject,target))){
          const current=inspectBinaryAssetSource({sourceRoot:definition.codeProject,sourcePath:target});
          report.binaryAssets.sources.push({path:target,sourcePath:null,beforeSha256:current.sha256,afterSha256:current.sha256,size:current.size,mode:current.mode});
        }else report.unknown.push(`binary delivery not yet available: ${target}`);
      }
      report.verified.push('declared binary source root, scope, stable source bytes and per-file limits; no blob publication');
    }
    const nativeProfile=nativeCorrection?.nativeEvidence??journal?.history.nativeReviewRecovery?.nativeEvidence;
    if(nativeProfile&&value?.status==='succeeded'){
      const sourceFiles=effective.scope.map(target=>{
        const record=projected.get(target);need(record?.contentBase64!==null&&record?.contentBase64!==undefined,'native_evidence_source_changed');
        return {path:target,sha256:createHash('sha256').update(Buffer.from(record.contentBase64,'base64')).digest('hex')};
      }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
      report.nativeEvidence=inspectNativeReviewEvidence(nativeProfile,{codeProject:definition.codeProject,specsDir:definition.specsDir,
        identity:report.identity,scope:effective.scope,sourceFiles});
    }else if(nativeProfile)report.unknown.push('native evidence binding to future developer source bytes');
    if(!value){report.unknown.push('developer answer / handoff / learning bytes');
      value={status:'succeeded',value:{outcome:'implemented',application:{status:'no_relevant_lesson',note:null},retrospective:{status:'no_new_lesson',candidates:[],reason:null}}};}
    const preview=developPreview({definition:effective,journal:journal?{...journal,baseline,history:{...journal.history,taskContinuation:continuation}}:binaryAssets?{baseline}:null});
    need(preview!==null,'preflight_unavailable');preview.taskContinuation=continuation;
    if(nativeCorrection)preview.nativeCorrection=nativeCorrection;
    const projection=projectDevelopCheckpoint({preview,codeProject:definition.codeProject,attempt,value,projected,checks});
    if(projection){
      const packageBytes=size(projection.pkg),inlineBytes=packageBytes+preview.restBytes+preview.resultBytes+projection.learningBytes+16*1024+512*checks.length;
      const reserve=developCheckpointReserve({examinedPathsBytes:size(reviewPaths(projection.pkg)),receiptsBytes:preview.receiptsBytes,
        callsBytes:preview.callsBytes+1024,writebackBytes:1024});
      const enabled=journal?packageMaterialEligible(journal.config,3):false;
      const capacity=checkpointPackageBudget({inlineBytes,packageBytes,reserve,enabled,referenced:false});
      report.capacity={precision:binaryAssets?'non-binary frame only; full binary owner capacity unknown':nativeProfile?'text frame only; full archived native evidence capacity unknown':'estimated future frame; projected package uses real encoder',inlineBytes,packageBytes,reserve,
        budget:capacity.budget,materialEnabled:enabled,material:capacity.material,fits:binaryAssets||nativeProfile?null:capacity.fits,...(binaryAssets?{binaryArchiveVerified:false,textMaterialFits:capacity.fits}:nativeProfile?{nativeArchiveVerified:false,textMaterialFits:capacity.fits}:{}),
        remainingPayloadBytes:JOURNAL_PAYLOAD_LIMIT-inlineBytes,
        components:{package:packageBytes,handoff:size(projection.pkg.handoff),requirements:size(projection.pkg.requirements),
          changes:size(projection.pkg.changes),learning:projection.learningBytes,existingFrame:preview.restBytes,
          result:preview.resultBytes,frameAllowance:16*1024,checkEvidenceAllowance:512*checks.length},
        recordsUsed:journal?.snapshot.records.length??0,
        stateBytes:journal?size(journal.snapshot):null,unverified:['future state/physical size, concurrent filesystem changes']};
      report.estimates.push('future development/checkpoint/review/completion reserve; real append is measured by the same storage planner');
      // A projection estimates currently supplied text only. Future model output
      // and native archives remain explicitly unknown; dispatch remeasures all.
      const selected=journal?effectiveReviewer(journal.config.reviewers[0],journal.history.reviewerSwitch)
        :file('--review-config')?{provider:flag('--review-runtime')??flag('--runtime')??'codex',requestedModel:read(file('--review-config')).model}:null;
      if(selected){
        const request=requestFor({invocationId:'preflight-projected',identity:projection.pkg.identity,
          role:'reviewer',provider:selected.provider,requestedModel:selected.requestedModel,contextId:'preflight-projected',
          payload:{reviewPackage:projection.pkg,priorReview:journal?.history.state.priorReview??null,
            ...supersededReviewPayload(journal?.history.supersession?.carriedReview??null,projection.pkg.identity.attempt)}});
        reportReviewInput(request,false,true);
      }

      if(nativeProfile)report.unknown.push('full native archived evidence, final owner checkpoint and physical storage capacity');
      if(!capacity.fits&&!nativeProfile)fail('develop_package_too_large');
    }else report.unknown.push('a successful package cannot yet be projected from this delivery');
    if(preparedOrigin&&projection&&report.issues.length===0){
      const fields={fromDigest:journal.snapshot.records.at(-1).digest,...binding,baselineDigest:baseline.baselineDigest,
        scope,taskReviewOrigin:preparedOrigin,reason:flag('--scope-revision-reason'),at:'2000-01-01T00:00:00.000Z'};
      const payload={version:3,protocol:'cm-task-runner',type:'scope-continued',...fields};
      report.registrationBytes=size(payload);need(report.registrationBytes<=JOURNAL_PAYLOAD_LIMIT,'scope_revision_too_large');
      const old=journal.snapshot,record={version:1,seq:old.records.length+1,id:`runner.${String(old.records.length+1).padStart(6,'0')}`,
        kind:'result',payload,previousDigest:old.records.at(-1).digest};
      need(appendFits(old,{id:record.id,kind:record.kind,payload,expectedRevision:old.revision}),'scope_revision_too_large');
      const directory=path.join(definition.specsDir,'.reviews','.execution',definition.identity.runId);
      let physical=0;for(const name of fs.readdirSync(directory)){
        const stat=fs.lstatSync(path.join(directory,name));need(stat.isFile()&&!stat.isSymbolicLink(),'unsupported_file');physical+=stat.size;
      }
      const {revision:discard,...body}=old,next={...body,records:[...old.records,{...record,digest:digest(record)}]};
      need(physical+size({...next,revision:digest(next)})+1<=PHYSICAL_LIMIT,'scope_revision_too_large');
      report.actions.push({operation:'resume/status --revise-scope --task-review-origin',target:report.target,
        verified:true,authorizationGranted:false,mustRevalidateUnderWriter:true});
    }
  }catch(error){issue('scope/material/capacity',error);}
  return {...report,status:report.issues.length?'blocked':report.actions.length?'ready_for_owner_validation':'estimated'};
}
