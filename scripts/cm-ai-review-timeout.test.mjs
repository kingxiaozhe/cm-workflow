import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,runnerStatus,completedEffectCount} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {abandonReviewPlanError,buildCmAiDriveRequest,buildCmAiDriveHostArgs} from './cm-ai-drive.mjs';
import {recordReviewAbandonment} from '../runtime/js/cm-ai/review-abandon-log.mjs';




const checks=[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const grantFor=(request,authorizationAt,change=grant=>grant)=>{
  const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.invocationId}`,adapterId:`${request.provider}-review-adapter`,
    invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,
    reviewerId:'reviewer',logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,
    hostContextId:'actual-main',decisionId:'decision-1',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
  change(body);return {...body,grantDigest:digest(body)};
};
const events=(onEvent,thread='actual-review')=>{
  onEvent({event:'thread.started',provider_thread:thread});
  onEvent({event:'turn.started',item_type:null});
  onEvent({event:'item.completed',item_type:'agent_message'});
  onEvent({event:'turn.completed',item_type:null});
  onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
};

async function fixture(fn,{reviewRun,authorize,times,timeoutMs=1000,provider='codex'}={}) {
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
      fs.writeFileSync(path.join(root,'code.js'),'new\n');return {version:1,invocationId:request.invocationId,
        contextId:request.contextId,provider:request.provider,effectiveModel:'fixture',status:'succeeded',accepted:true,
        result:{outcome:'implemented'}};}},
    reviewers:[{id:'reviewer',adapterId:`${provider}-review-adapter`,provider,requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-logical-1','review-logical-2'],run:(request,control)=>{
        dispatches++;lateEvent=control.onEvent;return (reviewRun??defaultRun)(request,control);
      }}],check:()=>checks,
    taskCompletion:{reviewsDir,handoffs:[path.join(reviewsDir,'a1.json'),path.join(reviewsDir,'a2.json')]},
    reviewInvocation:{developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],
      authorize:authorize??((request,{authorizationAt})=>grantFor(request,authorizationAt))}};
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

const timeoutRun=(request,{onEvent})=>{
  onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});
  onEvent({event:'turn.started',item_type:null});
  onEvent({event:'process_closed',exit_code:143,signal:null,timed_out:true});
  return {status:'failed',code:'timeout'};
};
const retryEffect=(f,attempt=1)=>({...f.effect('review',attempt),id:`review-${attempt}-retry-1`});

test('V3 expired dispatch grant is journaled as grant_expired without adapter dispatch',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'pending_review');assert.equal(end.code,'grant_expired');assert.equal(f.dispatches(),0);
  assert.equal(end.reviewInvocation.result.outcome,'not_dispatched');
  assert.equal(end.reviewInvocation.result.reason,'grant_expired');
  assert.equal(end.reviewInvocation.result.dispatchAt,200);
  assert.equal(end.reviewInvocation.registration.grant.expiresAt,150);
  assert.equal(end.calls.at(-1).terminal,'not_dispatched');assert.equal(end.receipt,null);
  const saved=f.getStore().snapshot();
  assert.equal(readRunnerHistory(saved.records,saved.records[0].payload.config,3).state.code,'grant_expired');
  assert.deepEqual(saved.records.slice(-3).map(record=>record.payload.type),
    ['review-invocation-registered','review-invocation-result','effect-checkpoint']);
  assert.deepEqual(f.reopen().status(),end);
},{times:[100,101,200],authorize:(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.expiresAt=150;})}));

test('V3 non-monotonic dispatch clock is journaled as clock_invalid without adapter dispatch',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'pending_review');assert.equal(end.code,'clock_invalid');assert.equal(f.dispatches(),0);
  assert.equal(end.reviewInvocation.result.outcome,'not_dispatched');
  assert.equal(end.reviewInvocation.result.reason,'clock_invalid');
  assert.equal(end.reviewInvocation.result.dispatchAt,99);
  assert.equal(end.reviewInvocation.registration.registeredAt,101);
  assert.equal(end.calls.at(-1).terminal,'not_dispatched');assert.equal(end.receipt,null);
  const saved=f.getStore().snapshot();
  assert.equal(readRunnerHistory(saved.records,saved.records[0].payload.config,3).state.code,'clock_invalid');
  assert.deepEqual(f.reopen().status(),end);
},{times:[100,101,99]}));

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
  const blocked=await resumed.executeEffect(retryEffect(f));assert.equal(blocked.state,'blocked');
  assert.equal(blocked.code,'review_transport_timeout');assert.deepEqual(f.reopen().status(),blocked);
  assert.equal((await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-2'})).code,'stage_mismatch');
  assert.equal(f.dispatches(),2);
},{timeoutMs:20,reviewRun:(request,{onEvent})=>{
  onEvent({event:'thread.started',provider_thread:`thread-${request.invocationId}`});return new Promise(()=>{});
}}));

test('each attempt gets one retry without consuming the six-effect budget or reusing grants',()=>fixture(async f=>{
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
    assert.notEqual(first.reviewInvocation.registration.grant.invocationId,second.reviewInvocation.registration.grant.invocationId);
    assert.notEqual(first.reviewInvocation.registration.grant.grantDigest,second.reviewInvocation.registration.grant.grantDigest);
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
  assert.notEqual(result.reviewInvocation.registration.grant.invocationId,
    abandoned.reviewInvocation.registration.grant.invocationId);
  assert.notEqual(result.reviewInvocation.registration.grant.grantDigest,
    abandoned.reviewInvocation.registration.grant.grantDigest);
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

test('abandonment projects a deduplicated run-log event',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const interrupted=f.resumePrefix('review-invocation-started');
  interrupted.abandonReview({allowed:true,reason:'old reviewer exited'});
  const record=f.getStore().snapshot().records.at(-1),specsDir=path.dirname(f.tasksPath),logHome=path.join(specsDir,'logs');
  const input={specsDir,codeProject:f.root,feature:'feature',identity:f.options.identity,record,logHome};
  recordReviewAbandonment(input);recordReviewAbandonment(input);
  const events=fs.readFileSync(path.join(specsDir,'运行日志.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(row=>row.event==='review_abandoned').length,1);
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

test('abandonment and transport timeout share the one redispatch budget',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const interrupted=f.resumePrefix('review-invocation-started');
  assert.equal(interrupted.abandonReview({allowed:true,reason:'exit'}).state,'pending_review');
  f.options.reviewers[0].run=timeoutRun;
  const retry=f.reopen();
  const result=await retry.executeEffect(retryEffect(f));
  assert.equal(result.state,'blocked');assert.equal(result.code,'review_transport_timeout');
  assert.equal((await f.reopen().executeEffect({...retryEffect(f),id:'review-1-retry-2'})).code,'stage_mismatch');
}));

test('conversation reports unknown cancel truthfully, then consumes abandonment authority once',()=>fixture(async f=>{
  const original=f.make();await original.executeEffect(f.effect('develop'));await original.executeEffect(f.effect('review'));
  const runner=f.resumePrefix('review-invocation-started');
  const request=(operation,extra={})=>({version:1,operation,requestId:operation,identity:f.options.identity,...extra});
  const before=f.getStore().snapshot();
  const noFlag=createCmAiConversationEntry({specsDir:path.dirname(f.tasksPath),codeProject:f.root,
    feature:'feature',identity:f.options.identity,runner});
  assert.equal((await noFlag.handle(request('abandon_review',{reason:'old process exited'}))).outcome,'rejected');
  assert.deepEqual(f.getStore().snapshot(),before);
  const entry=createCmAiConversationEntry({specsDir:path.dirname(f.tasksPath),codeProject:f.root,
    feature:'feature',identity:f.options.identity,runner,allowAbandonReview:true,hostDecision:{status:'approved'}});
  const cancelled=await entry.handle(request('cancel'));
  assert.equal(cancelled.outcome,'reported');assert.equal(cancelled.state,'unknown');
  assert.equal(cancelled.pendingAction,'abandon_review');
  const result=await entry.handle(request('abandon_review',{reason:'old host and reviewer exited'}));
  assert.equal(result.outcome,'abandoned');assert.equal(result.state,'pending_review');
  assert.equal(result.pendingAction,'resume');
  const repeated=await entry.handle(request('abandon_review',{reason:'again'}));
  assert.equal(repeated.outcome,'rejected');assert.equal(repeated.code,'review_abandon_authorization_required');
  const reviewed=await entry.handle(request('decision',{packageDigest:result.packageDigest}));
  assert.equal(reviewed.state,'approved');
  assert.equal(f.getStore().snapshot().records.filter(row=>row.payload.type==='effect-intent').at(-1).payload.effect.id,
    'review-1-retry-1');
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
  let first=true;f.options.reviewers[0].run=(request,control)=>{
    if(first){first=false;return timeoutRun(request,control);}
    events(control.onEvent,`thread-${request.invocationId}`);
    return {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
      examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Synthetic'}};
  };
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const firstResult=await runner.executeEffect(f.effect('review'));
  assert.equal(firstResult.code,'review_transport_timeout');
  const secondResult=await runner.executeEffect(retryEffect(f));
  assert.equal(secondResult.state,'approved');
  const interrupted=f.resumePrefix('review-invocation-started',true),before=f.getStore().snapshot();
  const result=interrupted.abandonReview({allowed:true,reason:'exit'});
  assert.equal(result.outcome,'rejected');assert.equal(result.code,'review_abandon_budget_exhausted');
  assert.deepEqual(f.getStore().snapshot(),before);
}));

function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}
function resequence(records){
  records.forEach((row,index)=>{row.seq=index+1;row.id=`runner.${String(index+1).padStart(6,'0')}`;});
  return rechain(records);
}
test('replay rejects mutated abandonment bindings, placement, and late old results',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const completed=structuredClone(f.getStore().snapshot().records);
  const interrupted=f.resumePrefix('review-invocation-started');
  interrupted.abandonReview({allowed:true,reason:'old process exited'});
  const records=f.getStore().snapshot().records,configuration=records[0].payload.config;
  for(const change of [
    row=>{row.registeredDigest='0'.repeat(64);},
    row=>{row.startedDigest='0'.repeat(64);},
    row=>{row.effectId='other-effect';},
    row=>{row.invocationId='other-invocation';},
    row=>{row.reason='line\nbreak';},
    row=>{row.at='invalid';},
  ]){
    const changed=structuredClone(records);change(changed.at(-1).payload);
    assert.throws(()=>readRunnerHistory(rechain(changed),configuration,3));
  }
  const reordered=structuredClone(records);
  [reordered[reordered.length-1],reordered[reordered.length-2]]=
    [reordered[reordered.length-2],reordered[reordered.length-1]];
  assert.throws(()=>readRunnerHistory(resequence(reordered),configuration,3));
  const late=structuredClone(records);
  late.push(completed.find(row=>row.payload.type==='review-invocation-result'));
  assert.throws(()=>readRunnerHistory(resequence(late),configuration,3));
  const wrongEffect=structuredClone([records[0],records.find(row=>row.payload.type==='effect-intent'),records.at(-1)]);
  assert.throws(()=>readRunnerHistory(resequence(wrongEffect),configuration,3));
}));

test('driver forwards reason and one-use flag, rejecting missing input before host launch',t=>{
  const plan={mode:'resume',hostContext:'new-host',originalHostContext:'old-host',reason:'old review exited'};
  const permissions=['--allow-abandon-review'];
  assert.equal(abandonReviewPlanError('abandon_review',plan,permissions),null);
  assert.deepEqual(buildCmAiDriveRequest('abandon_review',plan,{identity:{repositoryId:'r',runId:'run',taskId:'T-1',attempt:1}}),
    {version:1,identity:{repositoryId:'r',runId:'run',taskId:'T-1',attempt:1},reason:plan.reason});
  assert(buildCmAiDriveHostArgs(plan,permissions,'/tmp/run.json').includes('--allow-abandon-review'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cm-ai-abandon-driver-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const driver=new URL('./cm-ai-drive.mjs',import.meta.url);
  for(const extra of [{reason:plan.reason,permissions:[]},{reason:' ',permissions},
    {reason:'x'.repeat(501),permissions},{reason:'line\nbreak',permissions}]){
    const file=path.join(root,`plan-${Math.random()}.json`);
    fs.writeFileSync(file,JSON.stringify({config:'missing.json',mode:'resume',hostContext:'new-host',
      originalHostContext:'old-host',...extra}));
    const result=spawnSync(process.execPath,[driver.pathname,'--plan',file,'abandon_review'],{encoding:'utf8'});
    assert.equal(result.status,2,result.stderr);
    assert.match(result.stderr,/abandon_review 需要/);
    assert.doesNotMatch(result.stderr,/运行定义不存在/);
  }
});
test('legacy worker unknown and legacy runner timed_out checkpoints remain unknown, never resumable',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  for(const oldOutcome of ['unknown','timed_out']){
    const records=structuredClone(f.getStore().snapshot().records),configuration=records[0].payload.config;
    const result=records.find(row=>row.payload.type==='review-invocation-result').payload;
    result.outcome=oldOutcome;result.reconciliationRequired=true;
    if(oldOutcome==='timed_out')result.inspection=null;
    const view=Object.fromEntries(Object.entries(result).filter(([key])=>!['version','protocol','type','effectId','invocationId'].includes(key)));
    const checkpoint=records.at(-1).payload.checkpoint;
    checkpoint.state='unknown';checkpoint.code=oldOutcome==='unknown'?'transport_timeout':'reconciliation_required';
    checkpoint.reviewInvocation.result=view;
    checkpoint.calls.at(-1).terminal='unknown';checkpoint.calls.at(-1).resultDigest=digest(view);
    checkpoint.cache.at(-1).result=runnerStatus(checkpoint,configuration);
    const recovered=readRunnerHistory(rechain(records),configuration,3);
    assert.equal(recovered.state.state,'unknown');assert.equal(recovered.state.reviewInvocation.result.reconciliationRequired,true);
    assert.equal(completedEffectCount(recovered.state.cache),2);
  }
},{reviewRun:timeoutRun}));

test('replay rejects a fabricated pending retry after any final message',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const records=structuredClone(f.getStore().snapshot().records),configuration=records[0].payload.config;
  const result=records.find(row=>row.payload.type==='review-invocation-result').payload;
  result.observation.events.splice(2,0,{event:'item.completed',item_type:'agent_message'});
  const {inspectProviderReview}=await import('../runtime/js/cm-ai/provider-review-observation.mjs');
  // Even with a recomputed valid inspection and record chain, a result event
  // cannot claim reconciliationRequired=false.
  const before=records.filter(row=>row.payload.type==='effect-checkpoint')[0].payload.checkpoint;
  const {requestFor}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  const request=requestFor({invocationId:result.invocationId,identity:f.options.identity,role:'reviewer',provider:'codex',
    requestedModel:'fixture',contextId:'review-logical-1',payload:{reviewPackage:before.reviewPackage,priorReview:null}});
  result.inspection=inspectProviderReview(JSON.stringify(result.observation),JSON.stringify({request,
    developerThreadId:'actual-developer',excludedThreadIds:['actual-main']}));
  assert.throws(()=>readRunnerHistory(rechain(records),configuration,3),{code:'runner_invocation'});
},{reviewRun:timeoutRun}));

for(const runtime of ['codex','claude'])for(const providerMode of [false,true])
test(`factory passes exact configured timeout to ${runtime} reviewer, provider mode=${providerMode}`,async t=>fixture(async f=>{
  const {default:childProcess}=await import('node:child_process');
  const {syncBuiltinESMExports}=await import('node:module');
  const {EventEmitter}=await import('node:events');
  const {PassThrough}=await import('node:stream');
  const {createConversationExecution}=await import('../runtime/js/cm-ai/host-conversation-execution.mjs');
  const {configFingerprint}=await import('../runtime/js/cm-ai/codex-config.mjs');
  const {claudeReviewFingerprint}=await import('../runtime/js/cm-ai/worker-claude.mjs');
  const {requestFor}=await import('../runtime/js/cm-ai/effect-contract.mjs');
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const reviewPackage=f.getStore().snapshot().records.at(-1).payload.checkpoint.reviewPackage;
  fs.writeFileSync(path.join(f.root,'.cm-workflow.json'),JSON.stringify({version:1,runtimes:{available:runtime}}));
  const definition={codeProject:f.root,specsDir:path.dirname(f.options.taskCompletion.reviewsDir),feature:'feature',
    identity:f.options.identity,scope:['code.js'],requirements:['requirements.md']};
  const workerOptions={cwd:f.root,model:'fixture',promptTransport:'stdin',disabledSkills:[]};
  // Matching synthetic diagnostic data is confined to this mocked process test.
  const review={model:'fixture',disabledSkills:[],preflight:{passed:true,provider:runtime,cli_model:'fixture',
    prompt_transport:'stdin',config_fingerprint:(runtime==='codex'?configFingerprint:claudeReviewFingerprint)(workerOptions)}};
  const timeoutMs=providerMode?6789:5123;
  const execution=createConversationExecution(definition,'host-test',{call:()=>assert.fail('unexpected host call')},review,1,null,false,runtime,
    {protection:{checkCommands:[{id:'syntax',command:[process.execPath,'--version']}],timeoutMs},
      ...(providerMode?{providerDevelopment:{model:'fixture',attempt:1,coderRuntime:runtime,reviewerRuntime:runtime}}:{})});
  const timers=[],originalTimer=globalThis.setTimeout;
  t.mock.method(globalThis,'setTimeout',(fn,delay,...args)=>{timers.push(delay);return originalTimer(fn,delay,...args);});
  t.mock.method(childProcess,'spawn',()=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.kill=()=>true;
    queueMicrotask(()=>{child.stdout.end();child.stderr.end();child.emit('close',1,null);});
    return child;
  });
  syncBuiltinESMExports();
  try{
    const request=requestFor({invocationId:'synthetic-timeout-config',identity:f.options.identity,role:'reviewer',provider:runtime,
      requestedModel:'fixture',contextId:'cm-conversation-review-1',payload:{reviewPackage,priorReview:null}});
    await execution.reviewers[0].run(request,{signal:new AbortController().signal,onEvent:()=>{}});
    assert.deepEqual(timers,[timeoutMs]);
    assert.equal(execution.timeoutMs,providerMode?timeoutMs:1800000,'outer host timeout remains unchanged');
  }finally{t.mock.restoreAll();syncBuiltinESMExports();}
}));

for(const boundary of ['stale-grant','package-drift','cancelled'])
test(`retry preserves original authorization/package/cancellation boundary: ${boundary}`,()=>fixture(async f=>{
  if(boundary==='stale-grant'){
    let firstGrant;
    f.options.reviewInvocation.authorize=(request,{authorizationAt})=>firstGrant??=grantFor(request,authorizationAt);
  }
  let runner=f.make();await runner.executeEffect(f.effect('develop'));
  const pending=await runner.executeEffect(f.effect('review'));assert.equal(pending.state,'pending_review');
  if(boundary==='package-drift')fs.writeFileSync(path.join(f.root,'code.js'),'outside drift\n');
  if(boundary==='cancelled')runner.cancel();
  if(boundary!=='stale-grant')runner=f.reopen();
  const result=await runner.executeEffect(retryEffect(f));
  assert.equal(result.code,boundary==='stale-grant'?'authorization_invalid':boundary==='package-drift'?'package_mismatch':'stage_mismatch');
  assert.equal(f.dispatches(),1);
  if(boundary==='stale-grant')assert.equal(f.reopen().status().state,'unknown');
},{reviewRun:timeoutRun}));
