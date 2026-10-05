import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,runnerStatus,completedEffectCount} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {abandonReviewPlanError,buildCmAiDriveRequest,buildCmAiDriveHostArgs} from './cm-ai-drive.mjs';
import {recordReviewAbandonment} from '../runtime/js/cm-ai/review-abandon-log.mjs';
import {serveCmAiHost} from '../runtime/js/cm-ai/host-session.mjs';
import {PassThrough} from 'node:stream';
import {codexWorker} from '../runtime/js/cm-ai/worker-codex.mjs';
import {claudeWorker,claudeReviewFingerprint} from '../runtime/js/cm-ai/worker-claude.mjs';
import {configFingerprint} from '../runtime/js/cm-ai/codex-config.mjs';
import {createCodexReviewRun} from '../runtime/js/cm-ai/codex-review-adapter.mjs';
import {createClaudeReviewRun} from '../runtime/js/cm-ai/claude-review-adapter.mjs';





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
  const options={externalModels:{schemaVersion:1,providers:{[provider]:{model:'fixture',effort:provider==='codex'?'high':null}}},root,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs,
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

const retryEffect=(f,attempt=1)=>({...f.effect('review',attempt),id:`review-${attempt}-retry-1`});

const lateReceiptRun=({failed=false,change=()=>{},duplicate=false}={})=>(request,{onEvent,onReconciliation,signal})=>{
  const captured=[];
  const emit=event=>{captured.push(event);return onEvent(event);};
  emit({event:'thread.started',provider_thread:`thread-${request.invocationId}`});
  emit({event:'turn.started',item_type:null});
  return new Promise(resolve=>signal.addEventListener('abort',()=>setTimeout(()=>{
    if(failed)emit({event:'turn.failed',item_type:null});
    else {emit({event:'item.completed',item_type:'agent_message'});emit({event:'turn.completed',item_type:null});}
    emit({event:'process_closed',exit_code:null,signal:'SIGTERM',timed_out:false});
    const receipt={cleanup:'owned_process_group_closed',events:captured,result:failed?{status:'failed',code:'provider_failed'}:
      {status:'succeeded',value:{verdict:'approved',packageDigest:request.payload.reviewPackage.packageDigest,
        examinedPaths:reviewPaths(request.payload.reviewPackage),findings:[],summary:'Original late result'}}};
    change(receipt);onReconciliation(receipt);if(duplicate)onReconciliation(receipt);
    resolve({status:'cancelled',code:'cancelled'});
  },5),{once:true}));
};

for(const provider of ['codex','claude'])test(`${provider} late terminal receipt survives restart and reconciles once with zero redispatch`,()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));assert.equal(end.state,'unknown');
  assert.equal(end.reviewReconciliation.available,true);
  const original=f.getStore().snapshot(),invocationId=end.reviewReconciliation.invocationId;
  assert.equal(original.records.at(-1).payload.type,'review-invocation-receipt');
  const resumed=f.reopen();assert.equal(resumed.status().reviewReconciliation.available,true);
  assert.equal(resumed.reconcileReview({invocationId:'wrong-call'}).code,'review_reconciliation_binding');
  assert.deepEqual(f.getStore().snapshot(),original);
  const results=await Promise.all([1,2,3].map(()=>Promise.resolve().then(()=>resumed.reconcileReview({invocationId}))));
  for(const result of results)assert.equal(result.state,'approved',JSON.stringify(result));
  const saved=f.getStore().snapshot();assert.deepEqual(saved.records.slice(0,original.records.length),original.records);
  assert.equal(saved.records.filter(row=>row.payload.type==='review-invocation-reconciled').length,1);
  assert.equal(f.dispatches(),1);assert.equal(results[0].calls.at(-1).effectiveModel,'unknown');
  assert.deepEqual(f.reopen().status(),results[0]);
  // This minimal fixture deliberately has no completion handoff. Accepting a
  // provider result must not bypass that existing completion gate.
  const completed=await f.reopen().executeEffect(f.effect('complete'));
  assert.notEqual(completed.outcome,'rejected');assert.notEqual(completed.state,'fixture_completed');
  assert.match(fs.readFileSync(f.tasksPath,'utf8'),/\[ \]/);
  assert.equal(f.dispatches(),1);
},{timeoutMs:20,provider,reviewRun:lateReceiptRun({duplicate:true})}));

test('reconciled provider failure spends the original one-retry budget and requires a fresh grant',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const first=await runner.executeEffect(f.effect('review'));
  const after=runner.reconcileReview({invocationId:first.reviewReconciliation.invocationId});
  assert.equal(after.state,'pending_review');assert.equal(after.code,'review_provider_failed');assert.equal(f.dispatches(),1);
  const second=await runner.executeEffect(retryEffect(f));assert.equal(second.state,'unknown');
  const final=runner.reconcileReview({invocationId:second.reviewReconciliation.invocationId});
  assert.equal(final.state,'blocked');assert.equal(final.code,'review_provider_failed');assert.equal(f.dispatches(),2);
  assert.notEqual(first.reviewInvocation.registration.grant.grantDigest,second.reviewInvocation.registration.grant.grantDigest);
  assert.equal((await runner.executeEffect({...retryEffect(f),id:'third-review'})).code,'stage_mismatch');
  assert.equal(f.dispatches(),2);assert.deepEqual(f.reopen().status(),final);
},{timeoutMs:20,reviewRun:lateReceiptRun({failed:true})}));

test('replay rejects receipt or reconciliation bindings even when an attacker recomputes the journal hash chain',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  runner.reconcileReview({invocationId:end.reviewReconciliation.invocationId});
  const original=f.getStore().snapshot().records;
  for(const [type,key,value] of [
    ['review-invocation-receipt','invocationId','other-call'],['review-invocation-receipt','effectId','review-2'],
    ['review-invocation-receipt','registeredDigest',digest('other-grant')],
    ['review-invocation-receipt','startedDigest',digest('other-thread')],
    ['review-invocation-receipt','resultDigest',digest('other-result')],
    ['review-invocation-reconciled','receiptDigest',digest('other-receipt')],
    ['review-invocation-reconciled','invocationId','other-call'],
  ]){
    const rows=structuredClone(original);rows.find(row=>row.payload.type===type).payload[key]=value;
    let previousDigest=null;for(const row of rows){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
    assert.throws(()=>readRunnerHistory(rows,rows[0].payload.config,3),`${type}/${key}`);
  }
  assert.deepEqual(f.getStore().snapshot().records,original);assert.equal(f.dispatches(),1);
},{timeoutMs:20,reviewRun:lateReceiptRun()}));

test('reconciliation is not dispatch approval and the original grant cannot authorize another invocation',()=>{
  let originalGrant;
  return fixture(async f=>{
    const runner=f.make();await runner.executeEffect(f.effect('develop'));
    const first=await runner.executeEffect(f.effect('review'));
    runner.reconcileReview({invocationId:first.reviewReconciliation.invocationId});
    assert.equal((await runner.executeEffect(retryEffect(f))).code,'authorization_invalid');
    assert.equal(f.dispatches(),1);
  },{timeoutMs:20,reviewRun:lateReceiptRun({failed:true}),authorize:(request,{authorizationAt})=>originalGrant??=grantFor(request,authorizationAt)});
});

for(const [name,change] of [
  ['only local exit',r=>{r.events=r.events.filter(e=>!['item.completed','turn.completed'].includes(e.event));r.result={status:'failed',code:'incomplete_result'};}],
  ['wrong provider thread',r=>{r.events[0].provider_thread='other-provider-call';}],
  ['wrong package',r=>{r.result.value.packageDigest=digest('another-package');}],
  ['descendant cleanup uncertain',r=>{r.cleanup='unknown';}],
])test(`reconciliation refuses ${name} without changing the original unknown`,()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));assert.equal(end.state,'unknown');assert.equal(end.reviewReconciliation.available,false);
  const before=f.getStore().snapshot();
  assert.equal(runner.reconcileReview({invocationId:end.reviewReconciliation.invocationId}).code,'review_reconciliation_evidence_required');
  assert.deepEqual(f.getStore().snapshot(),before);assert.equal(f.dispatches(),1);
  assert.equal(f.reopen().status().reviewReconciliation.available,false);
},{timeoutMs:20,reviewRun:lateReceiptRun({change})}));


test('driver request reaches the real JSONL transport and reconciles without review permission',()=>fixture(async f=>{
  const original=f.make();await original.executeEffect(f.effect('develop'));
  const end=await original.executeEffect(f.effect('review')),runner=f.reopen();
  const host=createCmAiConversationEntry({specsDir:path.dirname(f.tasksPath),codeProject:f.root,
    feature:'feature',identity:f.options.identity,runner});
  const input=new PassThrough(),output=new PassThrough();let printed='';output.on('data',chunk=>{printed+=chunk;});
  const serving=serveCmAiHost({host,input,output});
  const request={...buildCmAiDriveRequest('reconcile_review',{invocationId:end.reviewReconciliation.invocationId},
    {identity:f.options.identity}),operation:'reconcile_review',requestId:'reconcile-original'};
  input.end(JSON.stringify(request)+'\n');await serving;
  const response=printed.trim().split('\n').map(line=>JSON.parse(line)).find(row=>row.requestId==='reconcile-original');
  assert.equal(response.result.outcome,'reconciled',printed);assert.equal(response.result.state,'approved');
  assert.equal(f.dispatches(),1);
},{timeoutMs:20,reviewRun:lateReceiptRun()}));

for(const provider of ['codex','claude'])for(const failed of [false,true])
test(`${provider} actual fake CLI captures a late ${failed?'failure':'result'} through its trusted worker`,()=>fixture(async f=>{
  const script=path.join(path.dirname(f.root),'late-provider.mjs');
  fs.writeFileSync(script,`let prompt='';for await(const chunk of process.stdin)prompt+=chunk;
const marker='<cm-review-data-json>\\n',data=JSON.parse(prompt.slice(prompt.indexOf(marker)+marker.length));
const provider=${JSON.stringify(provider)},failed=${failed},thread='original-'+process.pid;
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
process.on('SIGTERM',()=>{
 const value={verdict:'approved',packageDigest:data.reviewPackage.packageDigest,examinedPaths:data.examinedPaths,findings:[],summary:'Late original CLI'};
 if(provider==='codex'){
  if(failed)out({type:'turn.failed'});
  else {out({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}});out({type:'turn.completed'});}
 }else if(failed)out({type:'result',subtype:'error_during_execution',is_error:true,num_turns:1,session_id:thread});
 else {out({type:'assistant',session_id:thread,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'text',text:'done'}]}});
  out({type:'result',subtype:'success',is_error:false,num_turns:1,session_id:thread,structured_output:value});}
 setTimeout(()=>process.exit(failed?1:0),5);
});
if(provider==='codex'){out({type:'thread.started',thread_id:thread});out({type:'turn.started'});}
else out({type:'system',subtype:'init',session_id:thread});
setInterval(()=>{},1000);
`);
  let spawns=0;
  f.options.reviewInvocation.timeoutMs=300;
  f.options.reviewers[0].run=(request,control)=>{
    const options={cwd:f.root,model:'fixture',effort:f.options.externalModels.providers[provider].effort,promptTransport:'stdin'};
    const preflight=provider==='codex'?{passed:true,cli_model:'fixture',prompt_transport:'stdin',config_fingerprint:configFingerprint(options)}:
      {passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(options)};
    const worker=(provider==='codex'?codexWorker:claudeWorker)({...options,preflight,timeoutMs:5000,schemaPath:'synthetic.schema.json',
      spawnProcess:(_cli,_args,opts)=>{spawns++;return spawn(process.execPath,[script],opts);}});
    return (provider==='codex'?createCodexReviewRun:createClaudeReviewRun)(worker)(request,control);
  };
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const first=await runner.executeEffect(f.effect('review'));
  assert.equal(first.state,'unknown');assert.equal(first.reviewReconciliation.available,true,JSON.stringify(first));
  const resumed=f.reopen(),end=resumed.reconcileReview({invocationId:first.reviewReconciliation.invocationId});
  assert.equal(end.state,failed?'pending_review':'approved',JSON.stringify(end));assert.equal(spawns,1);
  if(failed){
    const retry=await resumed.executeEffect(retryEffect(f));assert.equal(retry.state,'unknown');
    const exhausted=resumed.reconcileReview({invocationId:retry.reviewReconciliation.invocationId});
    assert.equal(exhausted.state,'blocked');assert.equal(spawns,2);
    assert.notEqual(first.reviewInvocation.registration.grant.grantDigest,retry.reviewInvocation.registration.grant.grantDigest);
  }
},{provider,timeoutMs:2000}));

test('bounded cleanup receipts arriving after the former 1750ms window are retained',()=>fixture(async f=>{
  f.options.reviewInvocation.timeoutMs=20;
  const original=f.options.reviewers[0].run;
  f.options.reviewers[0].run=(request,control)=>original(request,{...control,signal:control.signal,
    onReconciliation:value=>control.onReconciliation(value)});
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.reviewReconciliation.available,true);
  assert.equal(f.reopen().reconcileReview({invocationId:end.reviewReconciliation.invocationId}).state,'approved');
  assert.equal(f.dispatches(),1);
},{timeoutMs:3000,reviewRun:(request,control)=>{
  const delay=new AbortController();control.signal.addEventListener('abort',()=>setTimeout(()=>delay.abort(),1850),{once:true});
  return lateReceiptRun()(request,{...control,signal:delay.signal});
}}));

test('conflicting terminal receipts cannot replace the original unknown',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.reviewReconciliation.available,false);assert.equal(f.dispatches(),1);
  assert(!f.getStore().snapshot().records.some(row=>row.payload.type==='review-invocation-receipt'));
},{timeoutMs:20,reviewRun:(request,control)=>lateReceiptRun()(request,{...control,onReconciliation:value=>{
  control.onReconciliation(value);const changed=structuredClone(value);changed.result.value.summary='Conflicting result';
  control.onReconciliation(changed);
}})}));

for(const violation of ['wrong_session','tool','unknown_event','extra_terminal'])
test(`Claude actual fake CLI with ${violation} after an API error cannot issue a trusted receipt`,()=>fixture(async f=>{
  const script=path.join(path.dirname(f.root),'invalid-late-provider.mjs');
  fs.writeFileSync(script,`for await(const chunk of process.stdin){};
const out=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const session_id='original-thread',violation=${JSON.stringify(violation)};
const terminal={type:'result',subtype:'error_during_execution',is_error:true,num_turns:1,session_id};
process.once('SIGTERM',()=>{
 out({type:'assistant',session_id,parent_tool_use_id:null,error:'server_error',message:{role:'assistant',content:[{type:'text',text:'synthetic error'}]}});
 if(violation==='wrong_session')out({...terminal,session_id:'another-provider-thread'});
 if(violation==='tool')out({type:'assistant',session_id,parent_tool_use_id:null,message:{role:'assistant',content:[{type:'tool_use',id:'tool-1',name:'Shell'}]}});
 if(violation==='unknown_event')out({type:'unexpected_event',session_id});
 out(terminal);if(violation==='extra_terminal')out(terminal);
 setTimeout(()=>process.exit(1),5);
});
out({type:'system',subtype:'init',session_id});setInterval(()=>{},1000);
`);
  let spawns=0;f.options.reviewInvocation.timeoutMs=300;
  f.options.reviewers[0].run=(request,control)=>{
    const opts={cwd:f.root,model:'fixture'};
    const worker=claudeWorker({...opts,timeoutMs:5000,preflight:{passed:true,provider:'claude',prompt_transport:'stdin',
      config_fingerprint:claudeReviewFingerprint(opts)},spawnProcess:(_cli,_args,options)=>{spawns++;return spawn(process.execPath,[script],options);}});
    return createClaudeReviewRun(worker)(request,control);
  };
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));assert.equal(end.state,'unknown');assert.equal(end.reviewReconciliation.available,false);
  const original=f.getStore().snapshot();assert.equal(runner.reconcileReview({invocationId:end.reviewReconciliation.invocationId}).code,'review_reconciliation_evidence_required');
  assert.deepEqual(f.getStore().snapshot(),original);assert.equal(spawns,1);
},{provider:'claude',timeoutMs:2000}));


test('Claude actual ordinary failure has trusted terminal and reconciles without redispatch',()=>fixture(async f=>{
  const script=path.join(path.dirname(f.root),'ordinary-failure.mjs');
  fs.writeFileSync(script,`for await(const chunk of process.stdin){};const session_id='original-thread';for(const e of [{type:'system',subtype:'init',session_id},{type:'result',subtype:'error_during_execution',is_error:true,num_turns:0,session_id}])console.log(JSON.stringify(e));`);
  let spawns=0;f.options.reviewers[0].run=(request,control)=>{
    const opts={cwd:f.root,model:'fixture',effort:null};
    return createClaudeReviewRun(claudeWorker({...opts,timeoutMs:2000,preflight:{passed:true,provider:'claude',prompt_transport:'stdin',config_fingerprint:claudeReviewFingerprint(opts)},spawnProcess:(_cli,_args,options)=>{spawns++;return spawn(process.execPath,[script],options);}}))(request,control);
  };
  const runner=f.make();await runner.executeEffect(f.effect('develop'));const end=await runner.executeEffect(f.effect('review'));
  assert.equal(end.state,'unknown');assert.equal(end.reviewReconciliation.available,true,JSON.stringify(end));
  assert.equal(f.reopen().reconcileReview({invocationId:end.reviewReconciliation.invocationId}).state,'pending_review');assert.equal(spawns,1);
},{provider:'claude',timeoutMs:2000}));
