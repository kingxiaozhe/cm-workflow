import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openFixExecution,inspectFixExecutionHistory} from '../runtime/js/cm-fix/execution.mjs';
import {createHostReviewAuthority} from '../runtime/js/cm-ai/host-review-authority.mjs';
import {acquireExternalRunGuard} from '../runtime/js/cm-ai/external-run-guard.mjs';
import {fixReviewLedger} from '../runtime/js/cm-fix/review-reconciliation.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
async function fixture(fn,{failed=false,change=()=>{},policyOnly=false}={}){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-fix-reconcile-'))),cwd=path.join(root,'code'),specsRoot=path.join(root,'specs');fs.mkdirSync(cwd);fs.mkdirSync(specsRoot);fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value=1;');
  const identity={repositoryId:'fixture',runId:'fix-original',taskId:'T-FIX-late',attempt:1};
  const reviewer={reviewerId:'fix-cause-reviewer',adapterId:'codex-cause-review-adapter',provider:'codex',requestedModel:'fake',contextId:'fix-cause-review-context',excludedThreadIds:[],workerConfigurationDigest:digest({cwd,model:'fake',effort:'low',disabledSkills:[],promptTransport:'stdin'})};
  const configuration={hostContextId:'fixture-host',defect:'Synthetic constant',externalModels:{schemaVersion:1,providers:{codex:{model:'fake',effort:'low'}}},causeReview:reviewer,reproduction:{cwd,command:[process.execPath,'-e',"console.error('BUG');process.exit(3)"],expectedFailure:{exitCode:3,outputIncludes:'BUG'},timeoutMs:1000}};
  if(policyOnly){delete configuration.externalModels;configuration.executionPolicy=EXECUTION_POLICY_V1;}
  const options={specsRoot,identity,configuration,create:true},authority=createHostReviewAuthority({hostContextId:'fixture-host',reviewerId:reviewer.reviewerId,adapterId:reviewer.adapterId,decide:async()=>({status:'approved'})});
  let owner,calls=0;
  const causeReview={timeoutMs:20,authorize:authority.authorize,run(request,{signal,onEvent,onReconciliation}){
    calls++;const events=[],emit=e=>{events.push(e);onEvent(e);};emit({event:'thread.started',provider_thread:'original-thread'});emit({event:'turn.started',item_type:null});
    return new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{
      if(failed)emit({event:'turn.failed',item_type:null});else{emit({event:'item.completed',item_type:'agent_message'});emit({event:'turn.completed',item_type:null});}
      emit({event:'process_closed',exit_code:null,signal:'SIGTERM',timed_out:false});
      const receipt={events,result:failed?{status:'failed',code:'provider_failed'}:{status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:['value.mjs'],findings:[],summary:'Original provider result'}},cleanup:'owned_process_group_closed'};change(receipt);onReconciliation(receipt);resolve({status:'cancelled',code:'cancelled'});
    },5),{once:true}));
  }};
  const state=()=>JSON.parse(fs.readFileSync(path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json')));
  const reopen=()=>{owner.close();owner=openFixExecution({...options,create:false},{causeReview});return owner;};
  try{
    owner=openFixExecution(options,{causeReview,bridge:{async call(){return {status:'diagnosed',rootCause:'Cross-layer synthetic',plan:'Repair after red',affectedPaths:['value.mjs'],affectedModules:['value'],crossLayer:true};}}});
    await owner.advance({authorized:true});const pkg=owner.causeReviewPackage();await authority.hostDecisionProvider.decide({identity,packageDigest:pkg.packageDigest},new AbortController().signal);
    const unknown=await owner.reviewCause();assert.equal(unknown.stage,'unknown',JSON.stringify(unknown));assert.equal(calls,1);
    await fn({owner:()=>owner,reopen,state,unknown,calls:()=>calls,root,configuration,specsRoot,cwd,identity});
  }finally{owner?.close();fs.rmSync(root,{recursive:true,force:true});}
}
test('fix original late success reconciles durably with zero calls and preserves original records',()=>fixture(async f=>{
  assert.equal(f.unknown.reviewReconciliation.available,true);const original=f.state(),invocationId=f.unknown.reviewReconciliation.invocationId;
  const owner=f.reopen();assert.throws(()=>owner.reconcileReview({invocationId:'wrong-call'}),{code:'review_reconciliation_binding'});assert.deepEqual(f.state(),original);
  assert.throws(()=>acquireExternalRunGuard({specsDir:f.specsRoot,codeProject:f.cwd,identity:{...f.identity,runId:'new-run'},feature:'fix'}),{code:'store_busy'});
  const result=owner.reconcileReview({invocationId});assert.equal(result.stage,'cause_review_evidence_required',JSON.stringify(result));assert.equal(f.calls(),1);
  assert.deepEqual(f.state().records.slice(0,original.records.length),original.records);assert.equal(f.state().records.filter(r=>r.id.startsWith('fix-review-reconciled-')).length,1);
  owner.reconcileReview({invocationId});assert.equal(f.state().records.filter(r=>r.id.startsWith('fix-review-reconciled-')).length,1);
  assert.equal((await owner.reviewCause()).stage,'red_test_required');assert.equal(f.calls(),1);
  assert.equal(f.reopen().status().stage,'red_test_required');assert.equal(f.calls(),1);
}));
test('fix original failed terminal is resolved but cannot approve or redispatch',()=>fixture(async f=>{
  const invocationId=f.unknown.reviewReconciliation.invocationId;assert.equal(f.unknown.reviewReconciliation.available,true);
  const result=f.reopen().reconcileReview({invocationId});assert.equal(result.stage,'review_provider_failed');assert.equal(result.completionEligible,false);
  assert.equal((await f.owner().reviewCause()).stage,'review_provider_failed');assert.equal(f.calls(),1);assert.equal(f.reopen().status().stage,'review_provider_failed');
},{failed:true}));
for(const [name,change] of [['local exit',r=>{r.events=r.events.filter(e=>e.event!=='turn.completed');}],['wrong thread',r=>{r.events[0].provider_thread='other-thread';}],['wrong package',r=>{r.result.value.packageDigest='0'.repeat(64);}],['unknown cleanup',r=>{r.cleanup='local_exit';}]])test(`fix rejects ${name} receipt and blocks manual re-dispatch`,()=>fixture(async f=>{
  assert.equal(f.unknown.reviewReconciliation.available,false);const before=f.state();const owner=f.reopen();
  assert.throws(()=>owner.reconcileReview({invocationId:'fake-call'}));assert.deepEqual(f.state(),before);
  assert.throws(()=>owner.abandonReview({authorized:true,reason:'retry'}),{code:'external_review_reconciliation_required'});
  assert.throws(()=>owner.recoverFinalReview({authorized:true}),{code:'external_review_reconciliation_required'});
  assert.equal((await owner.reviewCause()).stage,'unknown');assert.equal(f.calls(),1);
},{change}));
test('fix ledger binds receipt to exact original registered/start/result rows',()=>fixture(async f=>{
  const records=f.state().records,receipt=records.find(r=>r.id.startsWith('fix-review-receipt-'));assert(receipt);
  for(const key of ['registeredDigest','startedDigest','resultDigest']){
    const changed=structuredClone(records);changed.find(r=>r.id===receipt.id).payload[key]=digest('other');
    assert.throws(()=>fixReviewLedger(changed,f.configuration),{code:'review_reconciliation_binding'});
  }
}));

test('fix public driver reconciles stored original receipt without answers or review grant',()=>fixture(async f=>{
  f.owner().close();
  fs.writeFileSync(path.join(f.root,'fix.json'),JSON.stringify({specsRoot:f.specsRoot,identity:f.identity,defect:f.configuration.defect,reproduction:f.configuration.reproduction}));
  fs.writeFileSync(path.join(f.root,'review.json'),JSON.stringify({model:'fake',effort:'low',disabledSkills:[],timeoutMs:20,preflight:{passed:true,cli_model:'fake',prompt_transport:'stdin',config_fingerprint:configFingerprint({cwd:f.cwd,model:'fake',effort:'low'})}}));
  fs.writeFileSync(path.join(f.root,'plan.json'),JSON.stringify({config:'fix.json',reviewConfig:'review.json',cwd:f.cwd,mode:'resume',hostContext:'fixture-host',permissions:[],invocationId:f.unknown.reviewReconciliation.invocationId}));
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('./cm-fix-drive.mjs',import.meta.url)),'--plan',path.join(f.root,'plan.json'),'reconcile_review'],{encoding:'utf8',timeout:15000});
  assert.equal(run.status,0,run.stderr+run.stdout);assert.equal(JSON.parse(run.stdout).result.stage,'cause_review_evidence_required');assert.equal(f.calls(),1);
}));

test('cross-run fix guard validates the original owner grammar and does not rewrite it',()=>fixture(async f=>{
  f.owner().close();const file=path.join(f.specsRoot,'.reviews','.execution',f.identity.runId,'state.json'),before=fs.readFileSync(file);
  assert.throws(()=>acquireExternalRunGuard({specsDir:f.specsRoot,codeProject:f.cwd,identity:{...f.identity,runId:'other-run'},feature:'fix'}),{code:'external_prior_attempt_unresolved'});assert.deepEqual(fs.readFileSync(file),before);
  const state=JSON.parse(before),{revision,...body}=state;const row={version:1,seq:body.records.length+1,id:'unrecognized-fix-result',kind:'result',payload:{},previousDigest:body.records.at(-1).digest};body.records.push({...row,digest:digest(row)});
  fs.writeFileSync(file,JSON.stringify({...body,revision:digest(body)})+'\n');const altered=fs.readFileSync(file);
  assert.throws(()=>acquireExternalRunGuard({specsDir:f.specsRoot,codeProject:f.cwd,identity:{...f.identity,runId:'other-run'},feature:'fix'}),{code:'invalid_input'});assert.deepEqual(fs.readFileSync(file),altered);
}));

for(const field of ['repositoryId','runId'])test(`fix read-only history rejects a rehashed ${field} wrapper around another run`,()=>fixture(async f=>{
  f.owner().close();
  const original=f.state(),identity={repositoryId:f.identity.repositoryId,runId:f.identity.runId,[field]:'other-identity'};
  const dir=path.join(f.specsRoot,'.reviews','.execution',identity.runId);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const {revision,...body}=original;body.identity=identity;
  const file=path.join(dir,'state.json');fs.writeFileSync(file,JSON.stringify({...body,revision:digest(body)})+'\n',{mode:0o600});
  const before=fs.readFileSync(file);
  assert.throws(()=>inspectFixExecutionHistory({specsRoot:f.specsRoot,identity}),{code:'identity_mismatch'});
  assert.deepEqual(fs.readFileSync(file),before);
}));

test('optimization-only fix UNKNOWN is guarded and reconciles only its original receipt without dispatch',()=>fixture(async f=>{
  const original=f.state(),invocationId=f.unknown.reviewReconciliation.invocationId;
  assert.equal(f.unknown.reviewReconciliation.available,true);
  assert.throws(()=>f.owner().abandonReview({reason:'lost'}),{code:'external_review_reconciliation_required'});
  const owner=f.reopen();assert.equal(owner.reconcileReview({invocationId}).stage,'cause_review_evidence_required');
  assert.equal(f.calls(),1);assert.deepEqual(f.state().records.slice(0,original.records.length),original.records);
  assert.equal((await owner.reviewCause()).stage,'red_test_required');assert.equal(f.calls(),1);
},{policyOnly:true}));
