import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,runnerStatus,completedEffectCount} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';




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
  const resumePrefix=type=>{
    const current=store.snapshot(),at=current.records.findIndex(record=>record.payload.type===type);assert(at>=0);store.close();
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

function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}
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
