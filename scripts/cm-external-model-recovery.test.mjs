import test from 'node:test';
import {EXECUTION_POLICY_V1} from '../runtime/js/cm-ai/execution-policy.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {writeHandoff,writeReview} from '../experiments/js-orchestration/native-gate-fixture.mjs';
import {acquireExternalRunGuard} from '../runtime/js/cm-ai/external-run-guard.mjs';
const grant=(request,issuedAt)=>{
  const value={version:1,kind:'cm-review-dispatch-grant',grantId:'grant-'+request.invocationId,adapterId:'codex-review-adapter',
    invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,reviewerId:'reviewer',logicalContextId:request.contextId,
    packageDigest:request.payload.reviewPackage.packageDigest,hostContextId:'host',decisionId:'decision-'+request.invocationId,decision:'approved',issuedAt,expiresAt:issuedAt+60000};
  return {...value,grantDigest:digest(value)};
};
async function fixture(fn,review,{strict=true,timeoutMs=2000,externalDeveloper=false,policyOnly=false}={}){
  const tmp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-external-recovery-'))),root=path.join(tmp,'code'),specsRoot=path.join(tmp,'specs');
  fs.mkdirSync(root);fs.mkdirSync(specsRoot);fs.mkdirSync(path.join(specsRoot,'feature'));fs.mkdirSync(path.join(specsRoot,'.reviews'));
  const tasksPath=path.join(specsRoot,'feature/tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');fs.writeFileSync(path.join(root,'code.js'),'old\n');fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'strict-run',taskId:'T-001',attempt:1},owner={tasksPath,feature:'feature',specsRoot,identity:{repositoryId:'fixture',runId:'strict-run'},fingerprints:{workflow:digest('strict'),config:digest(strict),inputs:digest('inputs')},create:true};
  let store=openTaskExecutionStore(owner),calls=0,developerCalls=0;
  const options={root,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['host'],timeoutMs,
    ...(policyOnly?{executionPolicy:EXECUTION_POLICY_V1}:{}),
    ...(strict&&!policyOnly?{externalModels:{schemaVersion:1,providers:{codex:{model:'fixture',effort:'low'}}}}:{}),
    developer:{provider:'codex',requestedModel:externalDeveloper?'fixture':'current-session',contextId:'developer',run:request=>{
      developerCalls++;if(externalDeveloper)return new Promise(()=>{});
      fs.writeFileSync(path.join(root,'code.js'),'new '+request.identity.attempt+'\n');writeHandoff(path.join(specsRoot,'.reviews/feature-T-001-a'+request.identity.attempt+'-handoff.json'),root,['code.js'],request.identity.attempt);return {version:1,invocationId:request.invocationId,contextId:request.contextId,provider:'codex',effectiveModel:'unknown',status:'succeeded',accepted:true,result:{outcome:'implemented'}};
    }},reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,available:true,contexts:['review-1','review-2'],run:(request,control)=>{calls++;const result=review(request,control);if(result?.status==='succeeded')writeReview(path.join(specsRoot,'.reviews/feature-T-001-r'+request.identity.attempt+'.md'),path.join(specsRoot,'.reviews/feature-T-001-a'+request.identity.attempt+'-handoff.json'),request.identity.attempt,result.value.verdict);return result;}}],
    check:()=>[{id:'check',command:['controlled'],outcome:'passed',exitCode:0,evidence:'fixture'}],
    taskCompletion:{reviewsDir:path.join(specsRoot,'.reviews'),handoffs:[path.join(specsRoot,'.reviews/feature-T-001-a1-handoff.json'),path.join(specsRoot,'.reviews/feature-T-001-a2-handoff.json')]},
    reviewInvocation:{developerThreadId:'developer-thread',excludedThreadIds:['host'],hostContextId:'host',authorize:(request,{authorizationAt})=>grant(request,authorizationAt)}};
  const make=mode=>createTaskRunner({...options,persistence:{store,mode,version:3}});
  const reopen=()=>{store.close();store=openTaskExecutionStore({...owner,create:false});return make('resume');};
  const records=()=>store.snapshot().records;
  const prefix=type=>{
    const snapshot=store.snapshot(),index=snapshot.records.findIndex(row=>row.payload.type===type);assert(index>=0);store.close();
    const {revision,...body}=snapshot;body.records=body.records.slice(0,index+1);
    fs.writeFileSync(path.join(specsRoot,'.reviews/.execution/strict-run/state.json'),JSON.stringify({...body,revision:digest(body)})+'\n');
    store=openTaskExecutionStore({...owner,create:false});return make('resume');
  };
  const effect=(kind,attempt=1,id=kind+'-'+attempt)=>({version:1,id,identity:{...identity,attempt},kind});
  const guard=(override={})=>acquireExternalRunGuard({specsDir:specsRoot,codeProject:root,feature:'feature',identity:{...identity,runId:'another-run'},...override});
  try{await fn({make:()=>make('create'),reopen,prefix,effect,records,guard,closeStore:()=>store.close(),calls:()=>calls,developerCalls:()=>developerCalls});}finally{store.close();fs.rmSync(tmp,{recursive:true,force:true});}
}
const start=(request,onEvent)=>{onEvent({event:'thread.started',provider_thread:'actual-review-'+request.identity.attempt});onEvent({event:'turn.started',item_type:null});};
const noTerminal=(request,{onEvent})=>{start(request,onEvent);onEvent({event:'process_closed',exit_code:143,signal:null,timed_out:true});return {status:'failed',code:'timeout'};};
const noClose=(request,{onEvent})=>{start(request,onEvent);return new Promise(()=>{});};
test('cancelled external developer without terminal evidence cannot be replaced by another run',()=>fixture(async f=>{
  const runner=f.make(),pending=runner.executeEffect(f.effect('develop'));
  await new Promise(resolve=>setImmediate(resolve));runner.cancel();const result=await pending;
  assert.equal(result.state,'cancelled');assert.equal(f.developerCalls(),1);assert.equal(result.calls[0].terminal,'cancelled');
  const restored=f.reopen();assert.equal(restored.status().state,'cancelled');
  const before=JSON.stringify(f.records());assert.throws(f.guard,{code:'external_prior_attempt_unresolved'});assert.equal(JSON.stringify(f.records()),before);
},noTerminal,{externalDeveloper:true}));
for(const [name,review] of [['close without provider terminal',noTerminal],['outer timeout without close',noClose]])test(name+' stays unknown live and resumed; manual exits cannot redispatch',()=>fixture(async f=>{
  let runner=f.make();assert.equal((await runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const reviewed=await runner.executeEffect(f.effect('review'));assert.equal(reviewed.state,'unknown',JSON.stringify(reviewed));
  assert.equal(reviewed.reviewInvocation.result.reconciliationRequired,true);assert.equal(f.calls(),1);
  const rows=f.records(),before=JSON.stringify(rows);runner=f.reopen();assert.equal(runner.status().state,'unknown');
  for(const call of ['abandonReview','abandonEffect'])assert.equal(runner[call]({allowed:true,reason:'claimed stopped'}).code,'external_review_reconciliation_required');
  assert.equal((await runner.executeEffect(f.effect('review',1,'review-retry'))).outcome,'rejected');assert.equal(f.calls(),1);assert.equal(JSON.stringify(f.records()),before);
  assert.throws(f.guard,{code:'external_prior_attempt_unresolved'});assert.equal(JSON.stringify(f.records()),before);
  assert.throws(()=>f.guard({identity:{repositoryId:'fixture',runId:'other-task-run',taskId:'T-002',attempt:1}}),{code:'external_prior_attempt_unresolved'});
  assert.throws(()=>f.guard({feature:'other-feature',identity:{repositoryId:'fixture',runId:'other-feature-run',taskId:'T-002',attempt:1}}),{code:'external_prior_attempt_unresolved'});assert.equal(f.calls(),1);
  const init=rows[0].payload;assert.equal(readRunnerHistory(rows,init.config,3).state.state,'unknown');
},review,{timeoutMs:40}));
for(const type of ['review-invocation-registered','review-invocation-started','review-invocation-result'])test(type+' crash prefix preserves original attempt and rejects old abandonment paths',()=>fixture(async f=>{
  let runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));runner=f.prefix(type);
  assert.equal(runner.status().state,'unknown');assert.equal(runner.status().pendingReviewInvocation,undefined);assert.equal(runner.status().pendingEffectKind,undefined);
  const before=JSON.stringify(f.records());assert.equal(runner.abandonReview({allowed:true,reason:'process exited'}).code,'external_review_reconciliation_required');
  assert.equal(runner.abandonEffect({allowed:true,reason:'process exited'}).code,'external_review_reconciliation_required');
  await runner.executeEffect(f.effect('review',1,'new-call'));assert.equal(f.calls(),1);assert.equal(JSON.stringify(f.records()),before);
  assert.throws(f.guard,{code:'external_prior_attempt_unresolved'});
},noTerminal));
test('legacy missing marker keeps the local no-result redispatch contract (two per round)',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));assert.equal((await runner.executeEffect(f.effect('review'))).state,'pending_review');
  const second=await runner.executeEffect(f.effect('review',1,'retry'));
  assert.equal(second.state,'blocked');assert.equal(second.reviewRedispatchStopRequired,true);assert.equal(f.calls(),2);
  assert.equal(runner.abandonReview({allowed:true,reason:'reviewer stopped'}).state,'pending_review');
  const spent=await runner.executeEffect(f.effect('review',1,'retry-2'));
  assert.equal(spent.state,'blocked');assert.equal(spent.code,'review_redispatch_limit');assert.equal(f.calls(),3);
},noTerminal,{strict:false}));
test('valid changes_requested permits a fresh separately authorized second attempt and completion',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));assert.equal((await runner.executeEffect(f.effect('review'))).state,'changes_requested');
  await runner.executeEffect(f.effect('develop',2));assert.equal((await runner.executeEffect(f.effect('review',2))).state,'approved');
  const done=await runner.executeEffect(f.effect('complete',2));assert.equal(done.state,'fixture_completed',JSON.stringify(done));assert.equal(f.calls(),2);
  const registered=f.records().filter(row=>row.payload.type==='review-invocation-registered');assert.equal(registered.length,2);assert.notEqual(registered[0].payload.grant.invocationId,registered[1].payload.grant.invocationId);
  assert.throws(()=>f.guard({identity:{repositoryId:'fixture',runId:'next-task-run',taskId:'T-002',attempt:1}}),{code:'external_prior_writer_active'});
  f.closeStore();
  const next=f.guard({identity:{repositoryId:'fixture',runId:'next-task-run',taskId:'T-002',attempt:1}});next.close();assert.equal(f.calls(),2);
},(request,{onEvent})=>{
  start(request,onEvent);onEvent({event:'item.completed',item_type:'agent_message'});onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
  return {status:'succeeded',value:{verdict:request.identity.attempt===1?'changes_requested':'approved',packageDigest:request.payload.reviewPackage.packageDigest,
    examinedPaths:reviewPaths(request.payload.reviewPackage),findings:request.identity.attempt===1?[{id:'F1',severity:'P2',path:'code.js',message:'Repair',evidence:'Fixture'}]:[],summary:'Controlled review'}};
}));

test('optimization-only new run binds unknown original attempt live/replay without legacy redispatch',()=>fixture(async f=>{
  let runner=f.make();await runner.executeEffect(f.effect('develop'));
  const result=await runner.executeEffect(f.effect('review'));assert.equal(result.state,'unknown');assert.equal(f.calls(),1);
  const original=JSON.stringify(f.records());runner=f.reopen();assert.equal(runner.status().state,'unknown');
  assert.equal(runner.abandonReview({allowed:true,reason:'local exit'}).code,'external_review_reconciliation_required');
  assert.equal((await runner.executeEffect(f.effect('review',1,'another'))).outcome,'rejected');
  assert.equal(f.calls(),1);assert.equal(JSON.stringify(f.records()),original);
  assert.throws(f.guard,{code:'external_prior_attempt_unresolved'});
  assert.throws(()=>f.guard({feature:'another',identity:{repositoryId:'fixture',runId:'off-flag-run',taskId:'T-002',attempt:1}}),{code:'external_prior_attempt_unresolved'});
  const init=f.records()[0].payload;assert.deepEqual(init.config.executionPolicy,EXECUTION_POLICY_V1);
  assert(!Object.hasOwn(init.config,'externalModels'));assert.equal(readRunnerHistory(f.records(),init.config,3).state.state,'unknown');
},noTerminal,{policyOnly:true}));
