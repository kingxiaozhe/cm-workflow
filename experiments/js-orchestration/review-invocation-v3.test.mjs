import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from './task-runner.mjs';
import {openTaskExecutionStore} from './task-owner.mjs';
import {digest} from './effect-contract.mjs';
import {readRunnerHistory,runnerPayload,runnerStatus} from './durable-runner-state.mjs';
import {reviewPaths} from './review-runner.mjs';
import {checkCompletion} from './gate-bridge.mjs';
import {createCmAiTaskLearningApplication,createCmAiTaskLearningRetrospective} from './cm-ai-context-refresh.mjs';
import {createClaudeReviewRun} from '../../runtime/js/cm-ai/claude-review-adapter.mjs';

const checks=[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const grantFor=(request,authorizationAt,change=grant=>grant)=>{
  const body={version:1,kind:'cm-review-dispatch-grant',grantId:'grant-1',adapterId:`${request.provider}-review-adapter`,
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

for(const provider of ['codex','claude'])
for(const [conflict,verdict] of [[false,'approved'],[true,'approved'],[false,'changes_requested'],[false,'blocked']])
test(`P2 V3 ${provider} publishes registered review and resumes sole completion conflict=${conflict} verdict=${verdict}`,()=>fixture(async f=>{
  f.options.taskLearning={feature:'1.feature',hostHandoff:true};
  const dir=f.options.taskCompletion.reviewsDir;
  f.options.taskCompletion.handoffs=[1,2].map(n=>path.join(dir,`feature-T-001-a${n}-handoff.json`));
  const run=f.options.developer.run;
  f.options.developer.run=request=>{
    const terminal=run(request),input=request.payload.learningInput;
    const fields={feature:input.feature,identity:input.identity,learningDigest:input.learningDigest};
    terminal.result.application=createCmAiTaskLearningApplication({...fields,status:'no_relevant_lesson',note:null});
    terminal.result.retrospective=createCmAiTaskLearningRetrospective({...fields,status:'no_new_lesson',candidates:[],reason:null});
    return terminal;
  };
  const learningInput={version:1,workflow:'cm-ai',phase:'task_learning_input',feature:'1.feature',
    identity:f.options.identity,learningFiles:[]};
  learningInput.learningDigest=digest({version:1,feature:'1.feature',identity:f.options.identity,files:[]});
  const reviewRun=f.options.reviewers[0].run;
  f.options.reviewers[0].run=(request,control)=>{
    const result=provider==='claude'?createClaudeReviewRun(({prompt},workerControl)=>{
      assert(prompt.includes(request.payload.reviewPackage.packageDigest));
      return reviewRun(request,workerControl);
    })(request,control):reviewRun(request,control);
    result.value.verdict=verdict;
    if(verdict==='changes_requested')result.value.findings=[{id:'F1',severity:'P2',path:'code.js',
      message:'Synthetic defect',evidence:'Synthetic reproduction'}];
    return result;
  };
  const runner=f.make();
  assert.equal((await runner.executeEffect({...f.effect('develop'),learningInput})).state,'awaiting_review');
  const target=path.join(dir,'feature-T-001-r1.md');
  if(conflict)fs.writeFileSync(target,'existing human evidence\n');
  const reviewed=await runner.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,verdict==='approved'?'approved':verdict);
  assert.equal(reviewed.code,conflict?'review_publication_required':verdict==='blocked'?'review_blocked':null);
  assert.equal(f.dispatches(),1);
  if(conflict){
    assert.equal(fs.readFileSync(target,'utf8'),'existing human evidence\n');
    assert.equal(runner.status().code,'review_publication_required');
    const recovered=f.reopen();
    assert.equal(recovered.status().code,'review_publication_required');
    assert.deepEqual(await recovered.executeEffect(f.effect('complete')),
      {outcome:'rejected',code:'review_publication_required'});
    assert.equal(fs.readFileSync(target,'utf8'),'existing human evidence\n');
    // Simulate the human moving the conflicting evidence aside, never overwrite it.
    fs.renameSync(target,target+'.saved');
    assert.equal((await recovered.executeEffect(f.effect('review'))).code,null);
    assert.equal(recovered.status().code,null);assert.equal(f.dispatches(),1);
    assert.equal((await recovered.executeEffect(f.effect('complete'))).state,'fixture_completed');return;
  }
  const bytes=fs.readFileSync(target);
  assert.match(bytes.toString(),new RegExp(`reviewer: ${provider}-cli`));
  assert.equal(reviewed.receipt.execution.provider,provider);
  assert.equal(reviewed.reviewInvocation.result.inspection.provider,provider);
  assert.match(bytes.toString(),new RegExp(reviewed.receipt.receiptDigest));
  if(verdict!=='approved'){
    assert.match(bytes.toString(),new RegExp(`verdict: ${verdict}`));
    assert.equal(f.reopen().status().state,verdict);
    assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [ ] T-001: fixture\n');return;
  }
  // Simulate losing only the reconstructable file after durable review acceptance.
  fs.unlinkSync(target);
  const resumed=f.reopen();
  assert.equal(resumed.status().code,'review_publication_required');
  assert.equal(fs.existsSync(target),false); // status is read-only
  assert.equal((await resumed.executeEffect(f.effect('review'))).state,'approved');
  assert.deepEqual(fs.readFileSync(target),bytes);assert.equal(f.dispatches(),1);
  assert.equal((await resumed.executeEffect(f.effect('complete'))).state,'fixture_completed');
  assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [x] T-001: fixture\n');
},{provider}));

for(const prefix of ['review-invocation-registered','review-invocation-started','review-invocation-result'])
test(`Claude V3 ${prefix} crash prefix never redispatches`,()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const resumed=f.resumePrefix(prefix);
  assert.notEqual(resumed.status().state,'approved');
  await resumed.executeEffect(f.effect('review'));assert.equal(f.dispatches(),1);
},{provider:'claude'}));

test('Claude V3 cannot reuse author identity or a Codex adapter grant',async()=>{
  await fixture(async f=>{
    const runner=f.make();await runner.executeEffect(f.effect('develop'));
    const result=await runner.executeEffect(f.effect('review'));
    assert.notEqual(result.state,'approved');assert.equal(f.reopen().status().state,result.state);
  },{provider:'claude',reviewRun:(_request,{onEvent})=>{events(onEvent,'actual-developer');return {status:'failed',code:'failed'};}});
  await fixture(async f=>{
    const runner=f.make();await runner.executeEffect(f.effect('develop'));
    const result=await runner.executeEffect(f.effect('review'));
    assert.equal(result.code,'authorization_invalid');assert.equal(f.dispatches(),0);
  },{provider:'claude',authorize:(request,{authorizationAt})=>grantFor(request,authorizationAt,g=>{g.adapterId='codex-review-adapter';})});
});

for(const sameThread of [false,true])test(`P2 real developer thread survives replay with full host exclusions and excludes author ${sameThread}`,()=>fixture(async f=>{
  f.options.reviewInvocation.excludedThreadIds=['actual-main',...Array.from({length:31},(_,i)=>`excluded-${i}`)];
  const run=f.options.developer.run;
  f.options.developer.run=request=>({...run(request),providerThreadId:sameThread?'actual-review':'actual-coder'});
  const developed=await f.make().executeEffect(f.effect('develop'));
  assert.equal(developed.state,'awaiting_review');
  assert.equal(developed.calls[0].providerThreadId,sameThread?'actual-review':'actual-coder');
  const resumed=f.reopen();assert.deepEqual(resumed.status(),developed);
  const reviewed=await resumed.executeEffect(f.effect('review'));
  assert.equal(reviewed.state,sameThread?'unknown':'approved');
  assert.deepEqual(f.reopen().status(),reviewed);
  assert.equal(reviewed.receipts.length,sameThread?0:1);
}));

test('V3 registers a completed host-authorized review as a durable receipt without completing the task',()=>fixture(async f=>{
  let runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'approved');assert.equal(end.code,null);
  assert.equal(end.receipt.kind,'cm-review-receipt');assert.equal(end.receipts.length,1);
  assert.equal(end.receipt.execution.channel,'host-authorized');
  assert.equal(end.receipt.execution.contextId,'review-logical-1');
  assert.equal(end.receipt.execution.providerThreadId,'actual-review');
  assert.equal(end.reviewInvocation.result.outcome,'observed');
  assert.equal(end.reviewInvocation.result.inspection.completionEligible,false);
  assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [ ] T-001: fixture\n');
  const records=f.getStore().snapshot().records,types=records.map(record=>record.payload.type);
  const reviewPackage=records.at(-1).payload.checkpoint.reviewPackage;
  const gateInput={receipt:end.receipt,registered:end.receipt,execution:end.calls[1],reviewPackage,identity:end.identity};
  assert.equal(checkCompletion(gateInput).outcome,'eligible');
  const missingThread=structuredClone(end.receipt);delete missingThread.execution.providerThreadId;
  const {receiptDigest:ignored,...missingThreadData}=missingThread;missingThread.receiptDigest=digest(missingThreadData);
  assert.throws(()=>checkCompletion({...gateInput,receipt:missingThread,registered:missingThread,
    execution:missingThread.execution}));
  assert.throws(()=>checkCompletion({...gateInput,execution:{...end.calls[1],providerThreadId:'other-review'}}),
    {code:'execution_mismatch'});
  assert.deepEqual(types.slice(-5),['effect-intent','review-invocation-registered','review-invocation-started',
    'review-invocation-result','effect-checkpoint']);
  assert(types.indexOf('review-invocation-registered')<types.indexOf('review-invocation-started'));
  const before=f.getStore().snapshot();assert.equal(f.lateEvent()({event:'thread.started',provider_thread:'late-thread'}),false);
  assert.deepEqual(f.getStore().snapshot(),before);
  runner=f.reopen();assert.deepEqual(runner.status(),end);assert.deepEqual(await runner.executeEffect(f.effect('review')),end);
  assert.equal(f.dispatches(),1);
  assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [ ] T-001: fixture\n');
}));

test('V3 preserves changes-requested as attempt one evidence before a fresh attempt two review',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const first=await runner.executeEffect(f.effect('review'));
  assert.equal(first.state,'changes_requested');assert.equal(first.identity.attempt,2);
  assert.equal(first.receipts.length,1);assert.equal(first.receipt.result.verdict,'changes_requested');
  await runner.executeEffect(f.effect('develop',2));const second=await runner.executeEffect(f.effect('review',2));
  assert.equal(second.state,'approved');assert.equal(second.identity.attempt,2);
  assert.equal(second.receipts.length,2);assert.equal(second.receipt.result.verdict,'approved');
  assert.equal(f.dispatches(),2);assert.equal(fs.readFileSync(f.tasksPath,'utf8'),'- [ ] T-001: fixture\n');
},{reviewRun:(request,{onEvent})=>{events(onEvent,`actual-review-${request.identity.attempt}`);
  const common={packageDigest:request.payload.reviewPackage.packageDigest,
    examinedPaths:reviewPaths(request.payload.reviewPackage)};
  return {status:'succeeded',value:request.identity.attempt===1?{...common,verdict:'changes_requested',
    findings:[{id:'finding-1',severity:'P1',path:'code.js',message:'Fix fixture',evidence:'attempt one'}],summary:'Changes required'}:
    {...common,verdict:'approved',findings:[],summary:'Approved'}};
}}));

test('V3 persists the accepted observation_invalid human-resolution variant and seals late events',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,'observation_invalid');
  assert.equal(end.reviewInvocation.started,'actual-review');assert.equal(end.reviewInvocation.result.outcome,'unknown');
  assert.equal(end.reviewInvocation.result.reason,'observation_invalid');assert.equal(end.reviewInvocation.result.inspection,null);
  assert.equal(end.reviewInvocation.result.reconciliationRequired,true);assert.equal(end.receipt,null);
  const before=f.getStore().snapshot();assert.equal(f.lateEvent()({event:'turn.completed',item_type:null}),false);
  assert.deepEqual(f.getStore().snapshot(),before);const restored=f.reopen();assert.deepEqual(restored.status(),end);
  assert.deepEqual(await restored.run(),end);assert.equal(f.dispatches(),1);
},{reviewRun:(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:'actual-review'});
  onEvent({event:'item.completed',item_type:'reasoning'});return {status:'failed',code:'invalid_event'};}}));

for(const [name,authorization,expected] of [
  ['denied',()=>({status:'denied',code:'permission_denied'}),['pending_review','permission_denied']],
  ['wrong request',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.requestDigest=digest('other');}),['unknown','authorization_invalid']],
  ['wrong host',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.hostContextId='unbound-host';}),['unknown','authorization_invalid']],
  ['wrong adapter',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.adapterId='other-adapter';}),['unknown','authorization_invalid']],
  ['wrong invocation',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.invocationId='other-invocation';}),['unknown','authorization_invalid']],
  ['wrong identity',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.identity={...grant.identity,taskId:'T-002'};}),['unknown','authorization_invalid']],
  ['wrong reviewer',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.reviewerId='other-reviewer';}),['unknown','authorization_invalid']],
  ['wrong logical context',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.logicalContextId='other-logical';}),['unknown','authorization_invalid']],
  ['wrong package',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.packageDigest=digest('other');}),['unknown','authorization_invalid']],
  ['expired before authorization',(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.issuedAt=authorizationAt-2;grant.expiresAt=authorizationAt;}),['unknown','authorization_invalid']],
])test(`V3 ${name} authorization stops before registration and dispatch`,()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const before=f.getStore().snapshot().records.length;
  const end=await runner.executeEffect(f.effect('review'));assert.deepEqual([end.state,end.code],expected);assert.equal(f.dispatches(),0);
  const added=f.getStore().snapshot().records.slice(before).map(record=>record.payload.type);
  assert.deepEqual(added,['effect-intent','effect-checkpoint']);assert.deepEqual(f.reopen().status(),end);
},{authorize:authorization}));

test('V3 expired grant after registration records not_dispatched and never runs the adapter',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'pending_review');assert.equal(end.code,'grant_expired');assert.equal(f.dispatches(),0);
  assert.equal(end.reviewInvocation.result.outcome,'not_dispatched');assert.equal(end.reviewInvocation.result.reason,'grant_expired');
  assert.deepEqual(f.getStore().snapshot().records.slice(-3).map(record=>record.payload.type),
    ['review-invocation-registered','review-invocation-result','effect-checkpoint']);assert.deepEqual(f.reopen().status(),end);
},{times:[100,101,200],authorize:(request,{authorizationAt})=>grantFor(request,authorizationAt,grant=>{grant.expiresAt=150;})}));

test('V3 explicit durable cancel is the only cancellation cause and remains reconciliation-required',()=>fixture(async f=>{
  let started,late;const ready=new Promise(resolve=>{started=resolve;});
  f.options.reviewers[0].run=(request,{signal,onEvent})=>new Promise(resolve=>{
    late=onEvent;onEvent({event:'thread.started',provider_thread:'actual-review'});started();
    signal.addEventListener('abort',()=>resolve({status:'cancelled',code:'cancelled'}),{once:true});
  });
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const pending=runner.executeEffect(f.effect('review'));
  await ready;runner.cancel();const end=await pending;assert.equal(end.state,'cancelled');assert.equal(end.code,'cancelled');
  assert.equal(end.reviewInvocation.result.outcome,'cancelled');assert.equal(end.reviewInvocation.result.reconciliationRequired,true);
  const types=f.getStore().snapshot().records.map(record=>record.payload.type);
  assert(types.indexOf('control')<types.indexOf('review-invocation-result'));
  const before=f.getStore().snapshot();assert.equal(late({event:'turn.completed',item_type:null}),false);
  assert.deepEqual(f.getStore().snapshot(),before);assert.deepEqual(f.reopen().status(),end);
}));

test('V3 local timeout is unknown, never inferred as cancellation, and never redispatched',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.reviewInvocation.result.outcome,'timed_out');
  assert.equal(end.reviewInvocation.result.reconciliationRequired,true);
  assert(!f.getStore().snapshot().records.some(record=>record.payload.type==='control'));
  const before=f.getStore().snapshot();assert.equal(f.lateEvent()({event:'turn.completed',item_type:null}),false);
  assert.deepEqual(f.getStore().snapshot(),before);const restored=f.reopen();assert.deepEqual(await restored.run(),end);assert.equal(f.dispatches(),1);
},{timeoutMs:10,reviewRun:(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:'actual-review'});return new Promise(()=>{});}}));

test('V3 synchronous cancellation inside authorize checkpoints without registration or dispatch',()=>fixture(async f=>{
  let runner;f.options.reviewInvocation.authorize=(request,{authorizationAt})=>{
    runner.cancel();return grantFor(request,authorizationAt);
  };
  runner=f.make();await runner.executeEffect(f.effect('develop'));const before=f.getStore().snapshot().records.length;
  const end=await runner.executeEffect(f.effect('review'));assert.equal(end.state,'cancelled');assert.equal(end.code,'cancelled');
  assert.equal(f.dispatches(),0);assert.equal(end.reviewInvocation,null);
  assert.deepEqual(f.getStore().snapshot().records.slice(before).map(record=>record.payload.type),
    ['effect-intent','control','effect-checkpoint']);assert.deepEqual(f.reopen().status(),end);
}));

test('V3 cancellation inside authorize remains durable when the callback throws',()=>fixture(async f=>{
  let runner;f.options.reviewInvocation.authorize=()=>{
    runner.cancel();throw new Error('authorization failed after cancellation');
  };
  runner=f.make();await runner.executeEffect(f.effect('develop'));const before=f.getStore().snapshot().records.length;
  const end=await runner.executeEffect(f.effect('review'));assert.equal(end.state,'cancelled');assert.equal(end.code,'cancelled');
  assert.equal(f.dispatches(),0);assert.equal(end.reviewInvocation,null);
  assert.deepEqual(f.getStore().snapshot().records.slice(before).map(record=>record.payload.type),
    ['effect-intent','control','effect-checkpoint']);assert.deepEqual(f.reopen().status(),end);
}));

test('V3 adapter-originated cancelled observation stays unknown without claiming local cancellation',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,'transport_cancelled');
  assert.equal(end.reviewInvocation.result.outcome,'unknown');assert.equal(end.reviewInvocation.result.inspection.observationStatus,'cancelled');
  assert(!f.getStore().snapshot().records.some(record=>record.payload.type==='control'));assert.deepEqual(f.reopen().status(),end);
},{reviewRun:(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:'actual-review'});return {status:'cancelled',code:'cancelled'};}}));

test('V3 rejected final review payload becomes durable observation_invalid without poisoning storage',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,'observation_invalid');assert.equal(end.reviewInvocation.result.reason,'observation_invalid');
  assert.equal(end.reviewInvocation.result.inspection,null);assert.equal(end.receipt,null);assert.deepEqual(f.reopen().status(),end);
},{reviewRun:(request,{onEvent})=>{events(onEvent);return {status:'succeeded',value:{verdict:'approved',packageDigest:digest('wrong'),
  examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Wrong package'}};}}));

test('V3 oversized normalized provider result becomes bounded durable observation_invalid',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,'observation_invalid');assert.equal(end.reviewInvocation.result.reason,'observation_invalid');
  assert(Buffer.byteLength(JSON.stringify(end.reviewInvocation.result.observation))<512*1024);assert.deepEqual(f.reopen().status(),end);
},{reviewRun:(request,{onEvent})=>{events(onEvent);return {status:'succeeded',value:{verdict:'approved',
  packageDigest:request.payload.reviewPackage.packageDigest,examinedPaths:reviewPaths(request.payload.reviewPackage),
  findings:[],summary:'x'.repeat(600*1024)}};}}));

test('V3 ordinary incomplete provider result is a valid durable unknown',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,'transport_incomplete');
  assert.equal(end.reviewInvocation.result.outcome,'unknown');assert.equal(end.reviewInvocation.result.inspection.observationStatus,'unknown');
  assert.deepEqual(f.reopen().status(),end);
},{reviewRun:(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:'actual-review'});
  onEvent({event:'process_closed',exit_code:1,signal:'SIGTERM',timed_out:false});return {status:'failed',code:'provider_failed'};}}));

test('V3 workflow error preserves an unresolved review across restart without redispatch',()=>fixture(async f=>{
  const runner=f.make();const live=await runner.run(async ctx=>{
    await ctx.executeEffect(f.effect('develop'));await ctx.executeEffect(f.effect('review'));throw Error('after review');
  });
  assert.equal(live.state,'unknown');assert.equal(live.code,'transport_incomplete');
  assert.equal(live.workflowError,'workflow_error');assert.equal(live.receipt,null);
  assert.deepEqual(f.reopen().status(),live);assert.equal(f.dispatches(),1);
},{reviewRun:(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:'actual-review'});
  onEvent({event:'process_closed',exit_code:1,signal:'SIGTERM',timed_out:false});return {status:'failed',code:'provider_failed'};}}));

for(const prefix of ['review-invocation-registered','review-invocation-started'])
test(`V3 workflow error preserves the ${prefix} crash prefix across restart`,()=>fixture(async f=>{
  const initial=f.make();await initial.executeEffect(f.effect('develop'));await initial.executeEffect(f.effect('review'));
  const runner=f.resumePrefix(prefix),before=runner.status();
  assert.equal(before.state,'unknown');assert.equal(before.code,'reconciliation_required');
  assert.equal(before.reviewInvocation.result,null);assert.equal(before.receipt,null);
  const live=await runner.run(async()=>{throw Error('after crash prefix');});
  assert.equal(live.state,'unknown');assert.equal(live.code,'reconciliation_required');
  assert.equal(live.workflowError,'workflow_error');assert.deepEqual(f.reopen().status(),live);
  assert.equal(f.dispatches(),1);
}));

for(const [name,thread] of [['developer','actual-developer'],['excluded','actual-main'],['logical','review-logical-1']])
test(`V3 ${name} provider thread is rejected as observation_invalid`,()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.code,'observation_invalid');assert.equal(end.reviewInvocation.started,null);
  assert.equal(end.reviewInvocation.result.reason,'observation_invalid');assert.equal(end.receipt,null);
},{reviewRun:(request,{onEvent})=>{onEvent({event:'thread.started',provider_thread:thread});return {status:'failed',code:'invalid_thread'};}}));

test('V3 registration/start/result prefixes recover as unknown and never parse as success',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const records=f.getStore().snapshot().records,config=records[0].payload.config;
  for(const type of ['review-invocation-registered','review-invocation-started','review-invocation-result']){
    const index=records.findIndex(record=>record.payload.type===type),parsed=readRunnerHistory(records.slice(0,index+1),config,3);
    assert.equal(parsed.state.state,'unknown');assert.equal(parsed.state.code,'reconciliation_required');assert(parsed.pending);
    assert.equal(parsed.state.reviewInvocation.registration.adapterId,'codex-review-adapter');
  }
  const duplicate=structuredClone(records),at=duplicate.findIndex(record=>record.payload.type==='review-invocation-started');
  duplicate.splice(at+1,0,duplicate[at]);assert.throws(()=>readRunnerHistory(duplicate,config,3));
}));

const rechain=records=>records.map((record,index,all)=>{
  const body={version:1,seq:index+1,id:`runner.${String(index+1).padStart(6,'0')}`,kind:record.kind,payload:record.payload,
    previousDigest:index?all[index-1].digest:null};const next={...body,digest:digest(body)};all[index]=next;return next;
});
test('V3 enforces the full durable envelope, hash chain, and semantic nested ordering',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const records=f.getStore().snapshot().records,config=records[0].payload.config;
  const stripped=records.map(({id,kind,payload})=>({id,kind,payload}));assert.throws(()=>readRunnerHistory(stripped,config,3));
  const changed=structuredClone(records);changed[2].digest=digest('other');assert.throws(()=>readRunnerHistory(changed,config,3));
  const previous=structuredClone(records);previous[2].previousDigest=digest('other');assert.throws(()=>readRunnerHistory(previous,config,3));
  const started=records.findIndex(record=>record.payload.type==='review-invocation-started');
  const duplicate=rechain(structuredClone([...records.slice(0,started+1),records[started],...records.slice(started+1)]));
  assert.throws(()=>readRunnerHistory(duplicate,config,3));
}));

for(const prefix of ['review-invocation-registered','review-invocation-started','review-invocation-result'])
test(`V3 durable ${prefix} crash prefix resumes without authorization or redispatch`,()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const restored=f.resumePrefix(prefix),before=f.getStore().snapshot();assert.equal(restored.status().state,'unknown');
  assert.equal(restored.status().code,'reconciliation_required');assert.equal(restored.status().reviewInvocation.registration.adapterId,'codex-review-adapter');
  assert.deepEqual(await restored.run(),restored.status());assert.deepEqual(f.getStore().snapshot(),before);assert.equal(f.dispatches(),1);
}));

test('V1/V2 representative payload and V2 status bytes remain golden',()=>{
  const cases=[
    [runnerPayload('init',{config:{x:1},baseline:{y:2},session:'s'},1),'a72a0d96bdac6f6b78e7f0fc01e1dcdb593cbe47c10db4d752ce38ac3ac8b39c'],
    [runnerPayload('effect-intent',{effect:{version:1,id:'e',identity:{repositoryId:'r',runId:'u',taskId:'t',attempt:1},kind:'develop'}},1),'69c7669e652b1274164c7c99900f1c28e10af0b939cd603f78eaa2d47de9d9a4'],
    [runnerPayload('control',{event:'cancel'},1),'b907c71ff7cf7c884f7a83f8457a281f7839660b625ed3a2cc5b8bf2901c798b'],
    [runnerPayload('effect-checkpoint',{effectId:'e',checkpoint:{state:'unknown'}},1),'8b7859c2c4f44e82faf89b673790ae0feb4f509aec5f6bb6fb65cd5933b4a1da'],
    [runnerPayload('init',{config:{x:1},baseline:{y:2},session:'s'},2),'006b4dfd431533008ee95180c2c786420240c5b3a052a9f84731e2fd90fea9aa'],
    [runnerPayload('effect-intent',{effect:{version:1,id:'e',identity:{repositoryId:'r',runId:'u',taskId:'t',attempt:1},kind:'develop'}},2),'77981d1dd1cc17923dafe7d68248ce938d445f04edf53ee822037d49d6d401d1'],
    [runnerPayload('control',{event:'cancel'},2),'913d573be19ff3a32a66d4c67d534502cb272f954089706ae9c355096c994a90'],
    [runnerPayload('effect-checkpoint',{effectId:'e',checkpoint:{state:'unknown'}},2),'d365d5c30e925cf3868501f137263eca84c5bd0980b9725846d3ee74d114fe42'],
    [runnerPayload('task-commit-intent',{effectId:'e',completeIntentDigest:'0'.repeat(64),commit:{x:1}},2),'115c02ce6a0ff5c88b6c412275105b35dac461066efd38b61697ef15559014d8'],
    [runnerPayload('task-commit-result',{effectId:'e',completeIntentDigest:'0'.repeat(64),commit:{x:1}},2),'038acdb9b749733e7b7129e8573e30809671ca0c470f12540f93549c122e96dc'],
  ];
  for(const [value,expected] of cases)assert.equal(digest(value),expected);
  const state={state:'ready',code:null,attempt:1,reviewPackage:null,currentChecks:null,receipt:null,receipts:[],calls:[],cache:[],
    priorReview:null,cancelAfterCommit:false,workflowError:null,cancellationRequested:false,taskCommit:null};
  assert.equal(digest(runnerStatus(state,{identity:{repositoryId:'r',runId:'u',taskId:'t',attempt:1}})),
    '26349f289b5c3cd54af90fb85c357a0d8902d27c958c4524e98bc12546d188ee');
});
