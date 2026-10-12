import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,completedEffectCount} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
const checks=[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const events=(onEvent,thread='actual-review')=>{
  onEvent({event:'thread.started',provider_thread:thread});
  onEvent({event:'turn.started',item_type:null});
  onEvent({event:'item.completed',item_type:'agent_message'});
  onEvent({event:'turn.completed',item_type:null});
  onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
};

async function fixture(fn,{reviewRun,times,timeoutMs=1000,provider='codex'}={}) {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-v3-')));
  const root=path.join(temp,'code'),specsRoot=path.join(temp,'specs'),reviewsDir=path.join(specsRoot,'.reviews');
  fs.mkdirSync(root);fs.mkdirSync(reviewsDir,{recursive:true});
  const tasksPath=path.join(specsRoot,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(root,'code.js'),'old\n');fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'review-v3',taskId:'T-001',attempt:1};
  const owner={tasksPath,feature:'feature',specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('review-v3'),config:digest('fixture'),inputs:digest('original')},create:true};
  let dispatches=0,lateEvent=null,store=openTaskExecutionStore(owner);
  const defaultRun=(request,{onEvent})=>{events(onEvent);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
      examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic review'}};};
  const options={root,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs,
    developer:{provider,requestedModel:'fixture',contextId:'developer-logical',run:request=>{
      // Attempt 2 must answer attempt 1's findings; identical bytes are refused.
      fs.writeFileSync(path.join(root,'code.js'),request.identity.attempt===1?'new\n':'new 2\n');return {version:1,invocationId:request.invocationId,
        contextId:request.contextId,provider:request.provider,effectiveModel:'fixture',status:'succeeded',accepted:true,
        result:{outcome:'implemented'}};}},
    reviewers:[{id:'reviewer',adapterId:`${provider}-review-adapter`,provider,requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-logical-1','review-logical-2'],run:(request,control)=>{
        dispatches++;lateEvent=control.onEvent;return (reviewRun??defaultRun)(request,control);
      }}],check:()=>checks,
    taskCompletion:{reviewsDir,handoffs:[path.join(reviewsDir,'a1.json'),path.join(reviewsDir,'a2.json')]},
    reviewInvocation:{developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],hostContextId:'actual-main'}};
  const make=mode=>{
    const old=Date.now,values=times?[...times]:null;if(values)Date.now=()=>values.length>1?values.shift():values[0];
    try{return createTaskRunner({...options,persistence:{store,mode,version:3}});}finally{Date.now=old;}
  };
  const reopen=()=>{store.close();store=openTaskExecutionStore({...owner,create:false});return make('resume');};
  const resumePrefix=(type,last=false)=>{
    const current=store.snapshot(),at=last?current.records.findLastIndex(record=>record.payload.type===type)
      :current.records.findIndex(record=>record.payload.type===type);assert(at>=0);store.close();
    const statePath=path.join(specsRoot,'.reviews','.execution',identity.runId,'state.json');
    const body={version:current.version,identity:current.identity,fingerprints:current.fingerprints,records:current.records.slice(0,at+1)};
    fs.writeFileSync(statePath,JSON.stringify({...body,revision:digest(body)})+'\n',{mode:0o600});
    store=openTaskExecutionStore({...owner,create:false});return make('resume');
  };
  const effect=(kind,attempt=1)=>({version:1,id:`${kind}-${attempt}`,identity:{...identity,attempt},kind});
  try{return await fn({root,tasksPath,options,effect,make:()=>make('create'),reopen,resumePrefix,getStore:()=>store,
    dispatches:()=>dispatches,lateEvent:()=>lateEvent});}
  finally{store.close();fs.rmSync(temp,{recursive:true,force:true});}
}

function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}
test('direct review binds the real request without a grant and replays completion',()=>fixture(async f=>{
  const runner=f.make();assert.equal((await runner.executeEffect(f.effect('develop'))).state,'awaiting_review');
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'approved');assert.equal(f.dispatches(),1);
  const registration=end.reviewInvocation.registration;
  assert.equal(Object.hasOwn(registration,'grant'),false);assert.equal(Object.hasOwn(registration,'authorizationAt'),false);
  assert.equal(registration.binding.invocationId,end.calls.at(-1).invocationId);
  assert.equal(registration.binding.packageDigest,end.packageDigest);
  assert.equal(registration.binding.requestDigest,end.calls.at(-1).requestDigest);
  assert.equal(registration.binding.hostContextId,'actual-main');
  assert.equal(end.calls.at(-1).channel,'host-review');
  assert.equal(f.reopen().status().state,'approved');assert.equal(f.dispatches(),1);
}));
test('direct review rejects removed authorize option',()=>fixture(async f=>{
  f.options.reviewInvocation.authorize=()=>{throw new Error('must not call');};
  assert.throws(()=>f.make(),{code:'invalid_input'});
}));
test('direct review rejects a grant registration rather than accepting a second path',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const snapshot=f.getStore().snapshot(),records=structuredClone(snapshot.records);
  const registered=records.find(record=>record.payload.type==='review-invocation-registered');
  registered.payload.grant={kind:'cm-review-dispatch-grant'};
  assert.throws(()=>readRunnerHistory(rechain(records),records[0].payload.config,3),{code:'runner_invocation'});
}));
test('direct review rejects a registration bound to a host that is neither the developer thread nor an excluded thread',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const snapshot=f.getStore().snapshot(),records=structuredClone(snapshot.records);
  const registered=records.find(record=>record.payload.type==='review-invocation-registered');
  registered.payload.binding.hostContextId='stranger-host';
  assert.throws(()=>readRunnerHistory(rechain(records),records[0].payload.config,3),{code:'runner_invocation'});
}));
test('direct review rejects altered binding even with matching registration digest',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const snapshot=f.getStore().snapshot(),at=snapshot.records.findIndex(record=>record.payload.type==='review-invocation-registered');
  const records=structuredClone(snapshot.records.slice(0,at+1));
  const registered=records.at(-1);
  registered.payload.binding.requestDigest=digest('wrong request');
  assert.throws(()=>readRunnerHistory(rechain(records),records[0].payload.config,3),{code:'runner_history_mismatch'});
}));

const timeoutRun=(request,{onEvent})=>{
  onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});
  onEvent({event:'turn.started',item_type:null});
  onEvent({event:'process_closed',exit_code:143,signal:null,timed_out:true});
  return {status:'failed',code:'timeout'};
};
const retryEffect=(f,attempt=1)=>({...f.effect('review',attempt),id:`review-${attempt}-retry-1`});


test('runner timer without a result shares pending/blocked timeout transitions and replay',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'pending_review');assert.equal(end.code,'review_transport_timeout');
  assert.equal(end.calls.at(-1).terminal,'failed');assert.equal(end.reviewInvocation.result.outcome,'timed_out');
  assert.equal(end.reviewInvocation.result.inspection.code,'transport_timeout');
  assert.equal(end.reviewInvocation.result.reconciliationRequired,false);
  const before=f.getStore().snapshot();assert.equal(f.lateEvent()({event:'item.completed',item_type:'agent_message'}),false);
  assert.deepEqual(f.getStore().snapshot(),before);
  const resumed=f.reopen();assert.deepEqual(resumed.status(),end);
  assert.deepEqual(await resumed.executeEffect(f.effect('review')),end);assert.equal(f.dispatches(),1);
  // V5: the round keeps a second no-result redispatch, but the timer only
  // aborted the reviewer: nothing is redispatched until the operator confirms
  // the original reviewer stopped (abandon_review journals review-redispatch).
  const blocked=await resumed.executeEffect(retryEffect(f));assert.equal(blocked.state,'blocked');
  assert.equal(blocked.code,'review_transport_timeout');assert.equal(blocked.reviewRedispatchStopRequired,true);
  assert.match(blocked.reason,/^review_redispatch_stop_required: /);
  const second=f.reopen();assert.deepEqual(second.status(),blocked);
  assert.equal((await second.executeEffect({...retryEffect(f),id:'review-1-retry-2'})).code,'stage_mismatch');assert.equal(f.dispatches(),2);
  const unconfirmed=f.getStore().snapshot();
  assert.equal(second.abandonReview({allowed:false,reason:'x'}).code,'review_abandon_authorization_required');
  assert.equal(second.abandonReview({allowed:true,reason:' '}).code,'review_abandon_reason_required');
  assert.deepEqual(f.getStore().snapshot(),unconfirmed);
  const confirmed=second.abandonReview({allowed:true,reason:'Original reviewer process confirmed exited'});
  assert.equal(confirmed.state,'pending_review');assert.equal(confirmed.code,'review_transport_timeout');
  const third=await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-2'});
  assert.equal(third.state,'blocked');assert.equal(third.code,'review_redispatch_limit');
  const spent=f.reopen().status();assert.deepEqual(spent,third);
  assert.match(spent.reason,/无结论重派 2 次/);
  assert.equal((await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-3'})).code,'stage_mismatch');
  assert.equal(f.dispatches(),3);
  assert.equal(f.getStore().snapshot().records.filter(row=>row.payload.type==='review-redispatch').length,1);
},{timeoutMs:20,reviewRun:(request,{onEvent})=>{
  onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});return new Promise(()=>{});
}}));

test('each attempt gets one retry without consuming the six-effect budget or reusing bindings',()=>fixture(async f=>{
  const attempts=new Map();
  f.options.reviewers[0].run=(request,control)=>{
    const attempt=request.identity.attempt,count=(attempts.get(attempt)??0)+1;attempts.set(attempt,count);
    if(count===1)return timeoutRun(request,control);
    events(control.onEvent,`thread-${request.invocationId}`);
    return {status:'succeeded',value:{verdict:attempt===1?'changes_requested':'approved',
      packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),
      findings:attempt===1?[{id:'F1',severity:'P2',path:'code.js',message:'Repair',evidence:'Synthetic'}]:[],summary:'Synthetic'}};
  };
  let runner=f.make();
  for(const attempt of [1,2]){
    assert.equal((await runner.executeEffect(f.effect('develop',attempt))).state,'awaiting_review');
    const first=await runner.executeEffect(f.effect('review',attempt));assert.equal(first.state,'pending_review');
    runner=f.reopen();assert.deepEqual(runner.status(),first);
    const second=await runner.executeEffect(retryEffect(f,attempt));
    assert.equal(second.state,attempt===1?'changes_requested':'approved');
    assert.notEqual(first.reviewInvocation.registration.binding.invocationId,second.reviewInvocation.registration.binding.invocationId);
    assert.notEqual(first.reviewInvocation.registration.binding.requestDigest,second.reviewInvocation.registration.binding.requestDigest);
    runner=f.reopen();assert.deepEqual(runner.status(),second);
  }
  const records=f.getStore().snapshot().records,history=readRunnerHistory(records,records[0].payload.config,3);
  assert.equal(history.state.cache.length,6);assert.equal(completedEffectCount(history.state.cache),4);
  const complete=await runner.executeEffect(f.effect('complete',2));
  assert.notEqual(complete.outcome,'rejected');assert.notEqual(complete.code,'limit_exceeded');
  assert.equal(f.reopen().status().state,complete.state);
}));


test('interrupted V3 review needs explicit abandonment and replays the audited exit',()=>fixture(async f=>{
  const first=f.make();await first.executeEffect(f.effect('develop'));
  await first.executeEffect(f.effect('review'));
  const runner=f.resumePrefix('review-invocation-started');
  const before=f.getStore().snapshot();
  assert.deepEqual(before.records.map(row=>row.payload.type),[
    'init','effect-intent','effect-checkpoint','effect-intent',
    'review-invocation-registered','review-invocation-started']);
  assert.equal(runner.status().state,'unknown');
  assert.equal(runner.status().code,'reconciliation_required');
  for(const input of [{reason:'operator confirmed exit'}, {allowed:true}, {allowed:true,reason:'\n'},
    {allowed:true,reason:'x'.repeat(501)}]){
    assert.equal(runner.abandonReview(input).outcome,'rejected');
    assert.deepEqual(f.getStore().snapshot(),before);
  }
  const abandoned=runner.abandonReview({allowed:true,reason:'operator confirmed exit'});
  assert.equal(abandoned.state,'pending_review');assert.equal(abandoned.code,'review_abandoned');
  assert.equal(f.getStore().snapshot().records.at(-1).payload.type,'review-invocation-abandoned');
  assert.deepEqual(f.reopen().status(),abandoned);
  const next=f.reopen();
  const result=await next.executeEffect(retryEffect(f));
  assert.equal(result.state,'approved');
  assert.notEqual(result.reviewInvocation.registration.binding.invocationId,
    abandoned.reviewInvocation.registration.binding.invocationId);
  assert.notEqual(result.reviewInvocation.registration.binding.requestDigest,
    abandoned.reviewInvocation.registration.binding.requestDigest);
}));

test('registered review without a started record can also be abandoned',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const interrupted=f.resumePrefix('review-invocation-registered');
  assert.equal(interrupted.status().state,'unknown');
  const result=interrupted.abandonReview({allowed:true,reason:'dispatch never started'});
  assert.equal(result.state,'pending_review');assert.equal(result.reviewInvocation.started,null);
  assert.equal(f.getStore().snapshot().records.at(-1).payload.startedDigest,null);
  assert.deepEqual(f.reopen().status(),result);
}));


test('abandonment is refused without a pending registered review or after a result',()=>fixture(async f=>{
  let runner=f.make();
  const initial=f.getStore().snapshot();
  assert.equal(runner.abandonReview({allowed:true,reason:'exit'}).outcome,'rejected');
  assert.deepEqual(f.getStore().snapshot(),initial);
  await runner.executeEffect(f.effect('develop'));
  const pendingDevelop=f.resumePrefix('effect-intent');
  const pendingSnapshot=f.getStore().snapshot();
  assert.equal(pendingDevelop.abandonReview({allowed:true,reason:'exit'}).outcome,'rejected');
  assert.deepEqual(f.getStore().snapshot(),pendingSnapshot);
}));

test('abandonment is refused when a review result is already journaled',()=>fixture(async f=>{
  let runner=f.make();await runner.executeEffect(f.effect('develop'));
  await runner.executeEffect(f.effect('review'));
  runner=f.reopen();const completed=f.getStore().snapshot();
  assert.equal(runner.abandonReview({allowed:true,reason:'exit'}).outcome,'rejected');
  assert.deepEqual(f.getStore().snapshot(),completed);
}));

test('abandonment and transport timeout share the round\'s two no-result redispatches',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const interrupted=f.resumePrefix('review-invocation-started');
  assert.equal(interrupted.abandonReview({allowed:true,reason:'exit'}).state,'pending_review');
  f.options.reviewers[0].run=timeoutRun;
  const retry=f.reopen();
  const result=await retry.executeEffect(retryEffect(f));
  assert.equal(result.state,'blocked');assert.equal(result.reviewRedispatchStopRequired,true);
  assert.equal(f.reopen().abandonReview({allowed:true,reason:'stopped'}).state,'pending_review');
  const last=await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-2'});
  assert.equal(last.state,'blocked');assert.equal(last.code,'review_redispatch_limit');
  assert.equal((await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-3'})).code,'stage_mismatch');
}));


test('cancel after abandonment becomes durable cancelled',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const interrupted=f.resumePrefix('review-invocation-started');
  assert.equal(interrupted.abandonReview({allowed:true,reason:'old process exited'}).state,'pending_review');
  assert.equal(interrupted.cancel().state,'cancelled');
  assert.equal(f.reopen().status().state,'cancelled');
  assert.equal(readRunnerHistory(f.getStore().snapshot().records,
    f.getStore().snapshot().records[0].payload.config,3).pending,null);
}));

test('abandonment refuses an exhausted retry before appending a record',()=>fixture(async f=>{
  let failures=2;f.options.reviewers[0].run=(request,control)=>{
    if(failures>0){failures--;return timeoutRun(request,control);}
    events(control.onEvent,`thread-${request.invocationId}`);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
      examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic'}};
  };
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const firstResult=await runner.executeEffect(f.effect('review'));
  assert.equal(firstResult.code,'review_transport_timeout');
  assert.equal((await runner.executeEffect(retryEffect(f))).reviewRedispatchStopRequired,true);
  assert.equal(f.reopen().abandonReview({allowed:true,reason:'stopped'}).state,'pending_review');
  const secondResult=await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-2'});
  assert.equal(secondResult.state,'approved');
  // Both redispatches of the round are spent (automatic + review-redispatch).
  const interrupted=f.resumePrefix('review-invocation-started',true),before=f.getStore().snapshot();
  const result=interrupted.abandonReview({allowed:true,reason:'exit'});
  assert.equal(result.outcome,'rejected');assert.equal(result.code,'review_abandon_budget_exhausted');
  assert.deepEqual(f.getStore().snapshot(),before);
}));


test('direct registration prefixes restore the owned result without redispatch',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  for(const type of ['review-invocation-result','review-invocation-started','review-invocation-registered']){
    const resumed=f.resumePrefix(type);assert.equal(resumed.status().state,type==='review-invocation-result'?'approved':'unknown');
    assert.equal(resumed.status().code,type==='review-invocation-result'?null:'reconciliation_required');
    assert.equal((await resumed.executeEffect({...f.effect('review'),id:'new-review'})).code,'stage_mismatch');
    assert.equal(f.dispatches(),1);
  }
}));
test('direct dispatch ignores obsolete elapsed authorization TTL',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'approved');assert.equal(f.dispatches(),1);
},{times:[100,1000000]}));
test('direct provider permission failure stays a real failed observation, never an authorization denial',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(f.dispatches(),1);assert.equal(end.state,'pending_review');assert.equal(end.code,'review_provider_failed');
  assert.equal(end.reviewInvocation.result.outcome,'failed');assert.equal(end.reviewInvocation.result.inspection.failure,'reviewer_auth_failed');
  assert.equal(end.reviewDispatchConfirmRequired,undefined);assert.deepEqual(f.reopen().status(),end);
},{reviewRun:(request,{onEvent})=>{
  onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});
  onEvent({event:'turn.started',item_type:null});
  onEvent({event:'turn.failed',item_type:null});
  onEvent({event:'process_closed',exit_code:1,signal:null,timed_out:false});
  return {status:'failed',code:'reviewer_auth_failed'};
}}));

for(const boundary of ['package-drift','cancelled'])test(`direct retry preserves ${boundary} boundary`,()=>fixture(async f=>{
  let runner=f.make();await runner.executeEffect(f.effect('develop'));
  const pending=await runner.executeEffect(f.effect('review'));assert.equal(pending.state,'pending_review');
  if(boundary==='package-drift')fs.writeFileSync(path.join(f.root,'code.js'),'outside drift\n');
  else runner.cancel();
  runner=f.reopen();const result=await runner.executeEffect(retryEffect(f));
  assert.equal(result.code,boundary==='package-drift'?'package_mismatch':'stage_mismatch');assert.equal(f.dispatches(),1);
},{reviewRun:timeoutRun}));
test('direct retry refuses the developer provider thread',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const pending=await runner.executeEffect(f.effect('review'));assert.equal(pending.state,'pending_review');
  const oldThread=f.options.reviewInvocation.developerThreadId;
  f.options.reviewers[0].run=(request,{onEvent})=>{events(onEvent,oldThread);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
      examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Reused thread'}};};
  const result=await f.reopen().executeEffect(retryEffect(f));assert.equal(result.state,'unknown');
  assert.equal(result.code,'observation_invalid');assert.equal(result.receipt,null);
},{reviewRun:timeoutRun}));
test('direct entry decision alias dispatches by package and refuses self-reported approval',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const input={specsDir:path.dirname(f.tasksPath),codeProject:f.root,feature:'feature',identity:f.options.identity,runner};
  for(const extra of [{hostDecision:{status:'approved'}},{hostDecisionProvider:{decide:()=>({status:'approved'}),timeoutMs:10}}])
    assert.throws(()=>createCmAiConversationEntry({...input,...extra}),{code:'invalid_input'});
  const entry=createCmAiConversationEntry(input),operation={version:1,operation:'decision',requestId:'direct-review',identity:f.options.identity,
    packageDigest:runner.status().packageDigest};
  assert.equal((await entry.handle({...operation,decision:'approved'})).code,'invalid_input');
  assert.equal((await entry.handle({...operation,packageDigest:digest('wrong-package')})).code,'stale_decision');
  assert.equal(f.dispatches(),0);
  const result=await entry.handle(operation);assert.equal(result.state,'approved');assert.equal(f.dispatches(),1);
  assert.equal((await entry.handle(operation)).state,'approved');assert.equal(f.dispatches(),1);
}));
