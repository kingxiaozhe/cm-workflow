import {inspectFixExecutionHistory} from '../cm-fix/execution.mjs';
// Reuse the existing SQLite ownership protocol; never unlock an unknown call.
import fs from 'node:fs';
import path from 'node:path';
import {openExecutionStore} from './execution-store.mjs';
import {readExecutionSnapshot} from './execution-snapshot.mjs';
import {fixReviewLedger} from '../cm-fix/review-reconciliation.mjs';
import {inspectProviderReview,inspectProviderCauseReview} from './provider-review-observation.mjs';
import {validateReviewDispatchGrant} from './durable-runner-state.mjs';
import {readRunnerHistory} from './durable-runner-state.mjs';
import {oldWriterOpen} from './reviewed-evidence-supersede.mjs';
import {digest,need,shape,id} from './effect-contract.mjs';
import {readModelJsonRecord,writeModelJson} from './model-configuration-file.mjs';
function fixCallsResolved(records,configuration){
  const ledger=fixReviewLedger(records,configuration);
  const hosts=[configuration.hostContextId,...records.filter(r=>/^fix-host-joined-/.test(r.id)).map(r=>r.payload.hostContextId)];
  for(const registration of records.filter(r=>/^fix-.*-registered$/.test(r.id))){
    const prefix=registration.id.slice(0,-'-registered'.length),request=registration.payload.request;
    const started=records.find(r=>r.id===prefix+'-started'),result=records.find(r=>r.id===prefix+'-result');
    if(!started||!result)return false;
    const cause=prefix.includes('cause'),reviewer=configuration.causeReview;
    validateReviewDispatchGrant(registration.payload.grant,{request,reviewerId:cause?reviewer.reviewerId:'fix-final-reviewer',adapterId:cause?reviewer.adapterId:`${reviewer.provider}-review-adapter`,packageDigest:request.payload.reviewPackage.packageDigest,hostContextIds:hosts,authorizationAt:registration.payload.authorizationAt,registeredAt:registration.payload.registeredAt});
    need(result.payload.dispatchAt>=registration.payload.registeredAt&&result.payload.dispatchAt<registration.payload.grant.expiresAt,'external_prior_run_unverifiable');
    const proof=ledger.receipts.get(request.invocationId);
    if(proof&&ledger.applied.has(request.invocationId))continue;
    const excluded=[...reviewer.excludedThreadIds,...hosts.slice(1),request.contextId,...records.filter(r=>r.seq<registration.seq&&/-started$/.test(r.id)&&r.payload.providerThreadId).map(r=>r.payload.providerThreadId)];
    const checked=(cause?inspectProviderCauseReview:inspectProviderReview)(JSON.stringify(result.payload.observation),JSON.stringify({request,developerThreadId:hosts[0],excludedThreadIds:[...new Set(excluded)]}));
    if(checked.observationStatus!=='completed'||checked.providerThreadId!==started.payload.providerThreadId)return false;
  }
  return true;
}
const codeBinding=codeProject=>path.join(codeProject,'.cm-external-models-v1.json');
export const externalRunGuardExists=(specsDir,codeProject)=>fs.existsSync(path.join(specsDir,'.cm-external-models-v1'))||fs.existsSync(codeBinding(codeProject));
export function acquireExternalRunGuard(definition,{strictOnly=false}={}){
  const {specsDir,codeProject,identity,feature}=definition;
  for(const folder of [specsDir,codeProject])need(path.isAbsolute(folder)&&fs.realpathSync(folder)===folder,'external_run_guard_path');
  // A code checkout belongs to one specs root; changing specs cannot hide an attempt.
  const binding={version:1,kind:'cm-external-code-binding',specsDir},file=codeBinding(codeProject);
  if(!fs.existsSync(file))try{writeModelJson(file,binding,{expectedSha256:null,replace:false});}
    catch(error){if(!['model_configuration_exists','model_configuration_changed'].includes(error.code))throw error;}
  need(digest(readModelJsonRecord(file).value)===digest(binding),'external_code_specs_conflict');
  const root=path.join(specsDir,'.cm-external-models-v1');
  try{fs.mkdirSync(root,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
  const stat=fs.lstatSync(root);
  need(stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0,'external_run_guard_path');
  const leaseId='external-provider-'+digest(codeProject).slice(0,32);
  const leaseDir=path.join(root,'.reviews/.execution',leaseId);
  const fingerprint=digest('cm-external-models-serial-lease-v1');
  const lease=openExecutionStore({specsRoot:root,identity:{repositoryId:identity.repositoryId,runId:leaseId},
    fingerprints:{workflow:fingerprint,config:fingerprint,inputs:fingerprint},create:!fs.existsSync(leaseDir)});
  try{
    const execution=path.join(specsDir,'.reviews/.execution');
    if(fs.existsSync(execution))for(const entry of fs.readdirSync(execution,{withFileTypes:true})){
      if(entry.name===identity.runId)continue;
      if(entry.name==='batch.lock'){
        const file=path.join(execution,entry.name),stat=fs.lstatSync(file);
        need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&(stat.mode&0o077)===0&&stat.size<=4096,'external_prior_run_unverifiable');
        const lock=JSON.parse(fs.readFileSync(file,'utf8'));shape(lock,['batchId','pid','at']);id(lock.batchId);
        need(Number.isSafeInteger(lock.pid)&&lock.pid>0&&typeof lock.at==='string','external_prior_run_unverifiable');
        continue;
      }
      need(entry.isDirectory()&&!entry.isSymbolicLink(),'external_prior_run_unverifiable');
      const snapshot=readExecutionSnapshot({specsRoot:specsDir,identity:{repositoryId:identity.repositoryId,runId:entry.name}});
      const init=snapshot.records[0]?.payload,config=init?.config;
      if(init?.workflow==='cm-fix-stages-v1'){
        const fix=init.configuration;need(fix?.reproduction?.cwd,'external_prior_run_unverifiable');
        if(fs.realpathSync(fix.reproduction.cwd)!==codeProject)continue;
        if(strictOnly&&!(fix.externalModels||fix.executionPolicy))continue;
        need(!oldWriterOpen(execution,entry.name),'external_prior_writer_active');
        inspectFixExecutionHistory({specsRoot:specsDir,identity:{repositoryId:identity.repositoryId,runId:entry.name}});
        // A completed parent may reopen read-only between its original serial child steps.
        if(fix.qaSource&&digest(fix.qaSource.identity)===digest(identity))continue;
        need(fixCallsResolved(snapshot.records,fix),'external_prior_attempt_unresolved');
        continue;
      }
      // An unfinished initializer has no task identity and cannot safely be ignored.
      need(config,'external_prior_run_unverifiable');
      if(strictOnly&&!(config.externalModels||config.executionPolicy))continue;
      if(config.root!==codeProject)continue;
      const history=readRunnerHistory(snapshot.records,config,init.version);
      // Unknown external work belongs to the code root, even across tasks/features.
      if(config.externalModels||config.executionPolicy)need(!history.pending&&history.state.state!=='unknown'
        &&history.state.reviewInvocation?.result?.reconciliationRequired!==true
        &&!history.state.calls.some(call=>call.requestedModel!=='current-session'
          &&!['succeeded','not_dispatched'].includes(call.terminal)
          &&!snapshot.records.some(row=>row.payload.type==='review-invocation-reconciled'&&row.payload.invocationId===call.invocationId)),'external_prior_attempt_unresolved');
      need(!oldWriterOpen(execution,entry.name),'external_prior_writer_active');
      if(config.identity.taskId!==identity.taskId
        ||config.completion?.owner?.tasksPath!==path.join(specsDir,feature,'tasks.md'))continue;
      need(!history.pending&&!['unknown','ready','awaiting_review','pending_review','changes_requested','approved'].includes(history.state.state)
        &&history.state.reviewInvocation?.result?.reconciliationRequired!==true,'external_prior_attempt_unresolved');
      need(!oldWriterOpen(execution,entry.name),'external_prior_writer_active');
    }
    return lease;
  }catch(error){lease.close();throw error;}
}
