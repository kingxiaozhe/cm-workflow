// Review ends that never started a reviewer, and their operator exits:
//   A. raw pending_review/permission_denied (the authorization was refused, nothing was
//      registered or dispatched);
//   B. blocked/review_not_dispatched_limit (three registrations voided before dispatch).
// Both are left only by an explicit, audited operator confirmation (abandon_review with a
// reason), bounded per review round, replayed by the same functions the live runner uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTaskRunner} from '../runtime/js/cm-ai/task-runner.mjs';
import {openTaskExecutionStore} from '../runtime/js/cm-ai/task-owner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory,completedEffectCount,projectedRunnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {strictPriorAttemptResolved,sameTaskPriorAttemptResolved} from '../runtime/js/cm-ai/external-run-guard.mjs';
import {createCmAiConversationEntry} from '../runtime/js/cm-ai/cm-ai-conversation-entry.mjs';
import {operatorGuidance,guidanceText} from '../runtime/js/cm-ai/operator-guidance.mjs';

const checks=[{id:'check',command:['synthetic'],outcome:'passed',exitCode:0,evidence:'fixture'}];
const grantFor=(request,authorizationAt,change=grant=>grant)=>{
  const body={version:1,kind:'cm-review-dispatch-grant',grantId:`grant-${request.invocationId}`,adapterId:`${request.provider}-review-adapter`,
    invocationId:request.invocationId,requestDigest:request.requestDigest,identity:request.identity,
    reviewerId:'reviewer',logicalContextId:request.contextId,packageDigest:request.payload.reviewPackage.packageDigest,
    hostContextId:'actual-main',decisionId:'decision-1',decision:'approved',issuedAt:authorizationAt,expiresAt:authorizationAt+60000};
  change(body);return {...body,grantDigest:digest(body)};
};
const events=onEvent=>{
  onEvent({event:'thread.started',provider_thread:'actual-review'});
  onEvent({event:'turn.started',item_type:null});
  onEvent({event:'item.completed',item_type:'agent_message'});
  onEvent({event:'turn.completed',item_type:null});
  onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
};
const denied={status:'denied',code:'permission_denied'};
// Each authorization takes the next scripted step: 'deny' (refused), 'expire' (a grant
// that is already stale at dispatch, so the review is never dispatched) or 'ok'.
const script=(...steps)=>{
  const queue=[...steps];
  return (request,{authorizationAt})=>{
    const step=queue.shift()??'ok';
    return step==='deny'?denied:grantFor(request,authorizationAt,grant=>{if(step==='expire')grant.expiresAt=150;});
  };
};

async function fixture(fn,{authorize,times=[100,101,200],changesFirst=false}={}) {
  const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-review-exit-')));
  const root=path.join(temp,'code'),specsRoot=path.join(temp,'specs'),reviewsDir=path.join(specsRoot,'.reviews');
  fs.mkdirSync(root);fs.mkdirSync(reviewsDir,{recursive:true});
  const tasksPath=path.join(specsRoot,'tasks.md');fs.writeFileSync(tasksPath,'- [ ] T-001: fixture\n');
  fs.writeFileSync(path.join(root,'code.js'),'old\n');fs.writeFileSync(path.join(root,'requirements.md'),'fixture\n');
  const identity={repositoryId:'fixture',runId:'review-exit',taskId:'T-001',attempt:1};
  const owner={tasksPath,feature:'feature',specsRoot,identity:{repositoryId:identity.repositoryId,runId:identity.runId},
    fingerprints:{workflow:digest('review-exit'),config:digest('fixture'),inputs:digest('original')},create:true};
  let dispatches=0,store=openTaskExecutionStore(owner);
  const options={root,identity,scope:['code.js'],requirements:['requirements.md'],excludedContexts:['main'],timeoutMs:1000,
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer-logical',run:request=>{
      fs.writeFileSync(path.join(root,'code.js'),request.identity.attempt===1?'new\n':'new 2\n');return {version:1,invocationId:request.invocationId,
        contextId:request.contextId,provider:request.provider,effectiveModel:'fixture',status:'succeeded',accepted:true,
        result:{outcome:'implemented'}};}},
    reviewers:[{id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',allowed:true,
      available:true,contexts:['review-logical-1','review-logical-2'],run:(request,{onEvent})=>{
        dispatches++;events(onEvent);
        const rework=changesFirst&&request.identity.attempt===1;
        return {status:'succeeded',value:{verdict:rework?'changes_requested':'approved',packageDigest:request.payload.reviewPackage.packageDigest,
          examinedPaths:reviewPaths(request.payload.reviewPackage),
          findings:rework?[{id:'F1',severity:'P2',path:'code.js',message:'Repair',evidence:'Synthetic'}]:[],summary:'Synthetic review'}};}}],check:()=>checks,
    taskCompletion:{reviewsDir,handoffs:[path.join(reviewsDir,'a1.json'),path.join(reviewsDir,'a2.json')]},
    reviewInvocation:{developerThreadId:'actual-developer',excludedThreadIds:['actual-main'],
      authorize:authorize??script()}};
  const make=mode=>{
    const old=Date.now,values=[...times];Date.now=()=>values.length>1?values.shift():values[0];
    try{return createTaskRunner({...options,persistence:{store,mode,version:3}});}finally{Date.now=old;}
  };
  const reopen=()=>{store.close();store=openTaskExecutionStore({...owner,create:false});return make('resume');};
  const effect=(kind,attempt=1)=>({version:1,id:`${kind}-${attempt}`,identity:{...identity,attempt},kind});
  const retry=(n,attempt=1)=>({...effect('review',attempt),id:`review-${attempt}-retry-${n}`});
  const records=()=>store.snapshot().records;
  const history=()=>readRunnerHistory(records(),records()[0].payload.config,3);
  try{return await fn({root,tasksPath,options,effect,retry,make:()=>make('create'),reopen,records,history,
    getStore:()=>store,dispatches:()=>dispatches,identity});}
  finally{store.close();fs.rmSync(temp,{recursive:true,force:true});}
}
const types=records=>records.map(row=>row.payload.type);
const confirmations=records=>records.filter(row=>row.payload.type==='review-dispatch-confirmed');
const reasonFor='已核对原因，确认重新授权';

function rechain(records){
  let previousDigest=null;
  for(const row of records){row.previousDigest=previousDigest;const {digest:old,...body}=row;row.digest=digest(body);previousDigest=row.digest;}
  return records;
}
function resequence(records){
  records.forEach((row,index)=>{row.seq=index+1;row.id=`runner.${String(index+1).padStart(6,'0')}`;});
  return rechain(records);
}

// ---- A. permission_denied ------------------------------------------------------------

test('A a refused review authorization stops at permission_denied and asks for an explicit confirmation',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  const end=await runner.executeEffect(f.effect('review'));
  assert.deepEqual([end.state,end.code,f.dispatches()],['pending_review','permission_denied',0]);
  assert.equal(end.reviewDispatchConfirmRequired,true);
  assert.match(end.reason,/^permission_denied: .*从未启动.*abandon_review/);
  // Nothing was registered or dispatched: no call, no registration, and no effect slot.
  assert.deepEqual(end.calls.map(call=>call.terminal),['succeeded']);
  assert.equal(types(f.records()).includes('review-invocation-registered'),false);
  assert.equal(completedEffectCount(f.history().state.cache,f.history().state.calls),1);
  // Without the confirmation no new review effect is admitted, and nothing is journaled.
  const before=f.records().length,resumed=f.reopen();
  const refused=await resumed.executeEffect(f.retry(1));
  assert.deepEqual([refused.outcome,refused.code],['rejected','review_dispatch_confirmation_required']);
  assert.equal(f.records().length,before);assert.equal(f.dispatches(),0);
  // The cached denied result still replays for its own effect id.
  assert.deepEqual((await resumed.executeEffect(f.effect('review'))).code,'permission_denied');
},{authorize:script('deny','ok')}));

test('A the confirmation is journaled with its reason and one fresh authorization redispatches the same round',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const resumed=f.reopen(),confirmed=resumed.abandonReview({allowed:true,reason:reasonFor});
  assert.deepEqual([confirmed.state,confirmed.code],['pending_review','permission_denied_confirmed'],JSON.stringify(confirmed));
  assert.equal(confirmed.reviewDispatchConfirmRequired,undefined);
  const rows=confirmations(f.records());assert.equal(rows.length,1);
  const {payload}=rows[0];
  assert.deepEqual([payload.effectId,payload.attempt,payload.code,payload.reason],['review-1',1,'permission_denied',reasonFor]);
  assert.match(payload.at,/^\d{4}-\d{2}-\d{2}T.*Z$/);
  assert.equal(f.dispatches(),0,'the confirmation itself dispatches nothing');
  // The confirmed state survives a restart and the next review runs under a fresh authorization.
  const again=f.reopen();assert.deepEqual([again.status().state,again.status().code],['pending_review','permission_denied_confirmed']);
  const approved=await again.executeEffect(f.retry(1));
  assert.equal(approved.state,'approved',JSON.stringify(approved));assert.equal(f.dispatches(),1);
  assert.deepEqual(f.reopen().status(),approved);
  assert.equal(readRunnerHistory(f.records(),f.records()[0].payload.config,3).state.state,'approved');
},{authorize:script('deny','ok')}));

test('A every denial needs its own confirmation: a second denial asks again, the third stops at the limit',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  assert.equal(f.reopen().abandonReview({allowed:true,reason:reasonFor}).code,'permission_denied_confirmed');
  const second=await f.reopen().executeEffect(f.retry(1));
  assert.deepEqual([second.state,second.code,second.reviewDispatchConfirmRequired],['pending_review','permission_denied',true]);
  assert.equal(f.reopen().abandonReview({allowed:true,reason:'第二次确认'}).code,'permission_denied_confirmed');
  const third=await f.reopen().executeEffect(f.retry(2));
  assert.deepEqual([third.state,third.code],['blocked','review_permission_denied_limit']);
  assert.match(third.reason,/^review_permission_denied_limit: .*3 次.*2 次/);
  assert.equal(third.reviewDispatchConfirmRequired,undefined);
  assert.equal(f.dispatches(),0);
  // No further confirmation and no further review, and nothing is journaled.
  const before=f.records().length,limited=f.reopen();
  const result=limited.abandonReview({allowed:true,reason:'again'});
  assert.deepEqual([result.outcome,result.code],['rejected','review_permission_denied_limit']);
  const refused=await limited.executeEffect(f.retry(3));
  assert.deepEqual([refused.outcome,refused.code],['rejected','review_permission_denied_limit']);
  assert.equal(f.records().length,before);
  // Replay shows the same block from the same functions.
  const history=f.history(),config=f.records()[0].payload.config;
  assert.deepEqual([history.state.state,history.state.code],['pending_review','permission_denied']);
  const projected=projectedRunnerStatus(history,config);
  assert.deepEqual([projected.state,projected.code,projected.reason],[third.state,third.code,third.reason]);
  assert.deepEqual(f.reopen().status(),third);
  // The denied ends hold no effect slot (develop + nothing else).
  assert.equal(completedEffectCount(history.state.cache,history.state.calls),1);
},{authorize:script('deny','deny','deny')}));

test('A the confirmation needs the one-shot permission and a single-line reason, and only fits a denied end',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  // A review that is not denied (still ready for its first review) has nothing to confirm.
  const early=f.reopen().abandonReview({allowed:true,reason:reasonFor});
  assert.deepEqual([early.outcome,early.code],['rejected','review_abandon_unavailable']);
  await f.reopen().executeEffect(f.effect('review'));
  const before=f.records().length;
  for(const [raw,code] of [[{allowed:false,reason:reasonFor},'review_abandon_authorization_required'],
    [{allowed:true,reason:' '},'review_abandon_reason_required'],[{allowed:true,reason:'a\nb'},'review_abandon_reason_required'],
    [{allowed:true,reason:'x'.repeat(501)},'review_abandon_reason_required']]){
    const result=f.reopen().abandonReview(raw);
    assert.deepEqual([result.outcome,result.code],['rejected',code],JSON.stringify(raw));
  }
  assert.equal(f.records().length,before);
  assert.equal(f.reopen().abandonReview({allowed:true,reason:reasonFor}).code,'permission_denied_confirmed');
  // A confirmed end is not denied any more: a second confirmation is refused.
  const twice=f.reopen().abandonReview({allowed:true,reason:reasonFor});
  assert.deepEqual([twice.outcome,twice.code],['rejected','review_abandon_unavailable']);
  assert.equal(confirmations(f.records()).length,1);
},{authorize:script('deny')}));

test('A replay refuses forged, duplicate, misplaced and over-limit confirmations; an old archive replays as written',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const old=structuredClone(f.records()),config=old[0].payload.config;
  // A journal written before this exit existed: the denied end, nothing after it.
  const archived=readRunnerHistory(old,config,3);
  assert.deepEqual([archived.state.state,archived.state.code],['pending_review','permission_denied']);
  const projectedOld=projectedRunnerStatus(archived,config);
  assert.deepEqual([projectedOld.state,projectedOld.code,projectedOld.reviewDispatchConfirmRequired],['pending_review','permission_denied',true]);
  // A review intent right after an unconfirmed denial is refused by replay too.
  const intent=structuredClone(old.findLast(row=>row.payload.type==='effect-intent'));
  const {digest:ignored,...body}=JSON.parse(JSON.stringify(intent).replaceAll('review-1','review-1-retry-1'));
  const forgedIntent={...body,seq:old.length+1,id:`runner.${String(old.length+1).padStart(6,'0')}`,previousDigest:old.at(-1).digest};
  assert.throws(()=>readRunnerHistory([...old,{...forgedIntent,digest:digest(forgedIntent)}],config,3),{code:'runner_stage'});
  f.reopen().abandonReview({allowed:true,reason:reasonFor});
  const records=structuredClone(f.records()),at=records.findIndex(row=>row.payload.type==='review-dispatch-confirmed');assert(at>0);
  for(const change of [p=>{p.attempt=2;},p=>{p.code='grant_expired';},p=>{p.effectId='review-1-retry-1';},p=>{p.extra=true;},
    p=>{delete p.reason;},p=>{p.reason='';},p=>{p.reason='a\nb';},p=>{p.at='yesterday';}]){
    const forged=structuredClone(records);change(forged[at].payload);
    assert.throws(()=>readRunnerHistory(rechain(forged),config,3),{code:/^(runner_review_dispatch_confirm|invalid_input)$/});
  }
  const duplicate=structuredClone(records);duplicate.push(structuredClone(records[at]));
  assert.throws(()=>readRunnerHistory(resequence(duplicate),config,3),{code:'runner_review_dispatch_confirm'});
  // Not placed after a review effect's denied end (before any review ran).
  const misplaced=structuredClone([...records.slice(0,at-2),records[at]]);
  assert.throws(()=>readRunnerHistory(resequence(misplaced),config,3));
  assert.equal(readRunnerHistory(records,config,3).state.code,'permission_denied_confirmed');
},{authorize:script('deny')}));

test('A the conversation entry never redispatches a denied end on its own; abandon_review confirms, then decision redispatches',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  const resumed=f.reopen();
  const entry=createCmAiConversationEntry({specsDir:path.dirname(f.tasksPath),codeProject:f.root,feature:'feature',
    identity:f.identity,runner:resumed,allowAbandonReview:true,hostDecision:null,
    hostDecisionProvider:{timeoutMs:1000,decide:async()=>({status:'approved'})}});
  const request=(operation,extra={})=>({version:1,operation,requestId:operation,identity:f.identity,...extra});
  const status=await entry.handle(request('status'));
  assert.deepEqual([status.state,status.code,status.pendingAction,status.reviewDispatchConfirmRequired],
    ['pending_review','permission_denied','abandon_review',true]);
  assert.match(guidanceText(status),/abandon_review/);
  const before=f.records().length;
  // Even a standing host approval does not redispatch a denied end.
  const decided=await entry.handle(request('decision',{packageDigest:status.packageDigest}));
  assert.equal(decided.outcome,'reported');assert.equal(decided.code,'permission_denied');assert.equal(f.records().length,before);
  const advanced=await entry.handle(request('advance'));
  assert.notEqual(advanced.state,'approved');assert.equal(f.dispatches(),0);
  const result=await entry.handle(request('abandon_review',{reason:reasonFor}));
  assert.deepEqual([result.outcome,result.state,result.code,result.pendingAction],['abandoned','pending_review','permission_denied_confirmed','resume'],JSON.stringify(result));
  assert.match(guidanceText(result),/新的审查授权/);
  const repeated=await entry.handle(request('abandon_review',{reason:'again'}));
  assert.equal(repeated.code,'review_abandon_authorization_required');
  const reviewed=await entry.handle(request('decision',{packageDigest:result.packageDigest}));
  assert.equal(reviewed.state,'approved',JSON.stringify(reviewed));
  assert.equal(f.records().filter(row=>row.payload.type==='effect-intent').at(-1).payload.effect.id,'review-1-retry-1');
},{authorize:script('deny','ok')}));

// ---- B. review_not_dispatched_limit --------------------------------------------------

async function toLimit(f){
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  await runner.executeEffect(f.effect('review'));
  await f.reopen().executeEffect(f.retry(1));
  return f.reopen().executeEffect(f.retry(2));
}

test('B the limit block asks for an explicit confirmation; one confirmation grants two more redispatches',()=>fixture(async f=>{
  const limit=await toLimit(f);
  assert.deepEqual([limit.state,limit.code,limit.reviewDispatchConfirmRequired],['blocked','review_not_dispatched_limit',true]);
  assert.match(limit.reason,/^review_not_dispatched_limit: .*3 次.*abandon_review/);
  const before=f.records().length,rejected=await f.reopen().executeEffect(f.retry(3));
  assert.deepEqual([rejected.outcome,rejected.code],['rejected','review_not_dispatched_limit']);assert.equal(f.records().length,before);
  const confirmed=f.reopen().abandonReview({allowed:true,reason:'宿主已修好，授权不会再过期'});
  assert.deepEqual([confirmed.state,confirmed.code],['pending_review','grant_expired'],JSON.stringify(confirmed));
  assert.equal(confirmed.reviewDispatchConfirmRequired,undefined);
  const rows=confirmations(f.records());assert.equal(rows.length,1);
  assert.deepEqual([rows[0].payload.effectId,rows[0].payload.attempt,rows[0].payload.code],['review-1-retry-2',1,'grant_expired']);
  // Replay and a restart agree.
  assert.deepEqual(f.reopen().status(),confirmed);
  const approved=await f.reopen().executeEffect(f.retry(3));
  assert.equal(approved.state,'approved',JSON.stringify(approved));assert.equal(f.dispatches(),1);
  assert.deepEqual(f.reopen().status(),approved);
},{authorize:script('expire','expire','expire','ok')}));

test('B the extension is itself capped: two more voided registrations end in a limit with no further exit',()=>fixture(async f=>{
  await toLimit(f);
  assert.equal(f.reopen().abandonReview({allowed:true,reason:'第一次确认'}).state,'pending_review');
  await f.reopen().executeEffect(f.retry(3));
  const last=await f.reopen().executeEffect(f.retry(4));
  assert.equal(f.dispatches(),0);
  assert.deepEqual([last.state,last.code,last.reviewDispatchConfirmRequired],['blocked','review_not_dispatched_limit',undefined]);
  assert.match(last.reason,/^review_not_dispatched_limit: .*5 次.*已确认延长 1 次.*用满/);
  const before=f.records().length,limited=f.reopen();
  const again=limited.abandonReview({allowed:true,reason:'第二次确认'});
  assert.deepEqual([again.outcome,again.code],['rejected','review_not_dispatched_limit']);
  const refused=await limited.executeEffect(f.retry(5));
  assert.deepEqual([refused.outcome,refused.code],['rejected','review_not_dispatched_limit']);
  assert.equal(f.records().length,before);
  const history=f.history(),config=f.records()[0].payload.config,projected=projectedRunnerStatus(history,config);
  assert.deepEqual([projected.state,projected.code,projected.reason],[last.state,last.code,last.reason]);
  // A forged second confirmation or a sixth review intent is refused by replay.
  const records=structuredClone(f.records()),at=records.findIndex(row=>row.payload.type==='review-dispatch-confirmed');
  const second=structuredClone(records);
  second.push({...structuredClone(records[at]),payload:{...records[at].payload,effectId:'review-1-retry-4'}});
  assert.throws(()=>readRunnerHistory(resequence(second),config,3),{code:'runner_review_dispatch_confirm'});
  const intent=structuredClone(records.findLast(row=>row.kind==='intent'&&row.payload.effect?.id==='review-1-retry-4'));
  const {digest:ignored,...body}=JSON.parse(JSON.stringify(intent).replaceAll('review-1-retry-4','review-1-retry-5'));
  const forged={...body,seq:records.length+1,id:`runner.${String(records.length+1).padStart(6,'0')}`,previousDigest:records.at(-1).digest};
  assert.throws(()=>readRunnerHistory([...records,{...forged,digest:digest(forged)}],config,3),{code:'runner_stage'});
},{authorize:script('expire','expire','expire','expire','expire','ok')}));

test('B a confirmation is refused before the limit and without permission or reason, and never forged into replay',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  // One voided registration only: still redispatchable on its own, nothing to confirm.
  const early=f.reopen().abandonReview({allowed:true,reason:reasonFor});
  assert.deepEqual([early.outcome,early.code],['rejected','review_abandon_unavailable']);
  await f.reopen().executeEffect(f.retry(1));
  const limit=await f.reopen().executeEffect(f.retry(2));assert.equal(limit.code,'review_not_dispatched_limit');
  const before=f.records().length;
  for(const [raw,code] of [[{allowed:false,reason:reasonFor},'review_abandon_authorization_required'],
    [{allowed:true,reason:''},'review_abandon_reason_required'],[{allowed:true,reason:'a\r\nb'},'review_abandon_reason_required']]){
    const result=f.reopen().abandonReview(raw);assert.deepEqual([result.outcome,result.code],['rejected',code]);
  }
  assert.equal(f.records().length,before);
  // A record forged into a journal that is not at the limit is refused by replay.
  const config=f.records()[0].payload.config,all=structuredClone(f.records());
  f.reopen().abandonReview({allowed:true,reason:reasonFor});
  const real=f.records().findLast(row=>row.payload.type==='review-dispatch-confirmed');
  const firstEnd=all.findIndex(row=>row.payload.type==='effect-checkpoint'&&row.payload.checkpoint?.code==='grant_expired');
  const early2=structuredClone(all.slice(0,firstEnd+1));
  early2.push({...structuredClone(real),payload:{...real.payload,effectId:'review-1'}});
  assert.throws(()=>readRunnerHistory(resequence(early2),config,3),{code:'runner_review_dispatch_confirm'});
},{authorize:script('expire','expire','expire')}));

test('B the extension counts per review round, so a later round has its own',()=>fixture(async f=>{
  const limit=await toLimit(f);assert.equal(limit.code,'review_not_dispatched_limit');
  f.reopen().abandonReview({allowed:true,reason:reasonFor});
  const records=f.records();
  assert.equal(confirmations(records).length,1);assert.equal(confirmations(records)[0].payload.attempt,1);
  // The count is read from the journal for this attempt only.
  const history=f.history();
  assert.deepEqual(history.answerGaps.reviewDispatchConfirmed,{1:{denied:0,extended:1},2:{denied:0,extended:0}});
},{authorize:script('expire','expire','expire')}));

test('B the conversation entry names abandon_review for an extendable limit and nothing for a spent one',()=>fixture(async f=>{
  await toLimit(f);
  const request=(operation,extra={})=>({version:1,operation,requestId:operation,identity:f.identity,...extra});
  const entryFor=runner=>createCmAiConversationEntry({specsDir:path.dirname(f.tasksPath),codeProject:f.root,feature:'feature',
    identity:f.identity,runner,allowAbandonReview:true,hostDecision:{status:'approved'}});
  const entry=entryFor(f.reopen());
  const status=await entry.handle(request('status'));
  assert.deepEqual([status.state,status.code,status.pendingAction,status.reviewDispatchConfirmRequired],
    ['blocked','review_not_dispatched_limit','abandon_review',true]);
  assert.match(status.guidance.nextStep,/abandon_review/);assert.equal(status.guidance.recoveryOperation,'abandon_review');
  const result=await entry.handle(request('abandon_review',{reason:reasonFor}));
  assert.deepEqual([result.outcome,result.state,result.code,result.pendingAction],['abandoned','pending_review','grant_expired','resume'],JSON.stringify(result));
  await f.reopen().executeEffect(f.retry(3));
  await f.reopen().executeEffect(f.retry(4));
  const spent=await entryFor(f.reopen()).handle(request('status'));
  assert.deepEqual([spent.state,spent.code,spent.pendingAction],['blocked','review_not_dispatched_limit','none']);
  assert.equal(spent.reviewDispatchConfirmRequired,undefined);assert.equal(spent.guidance.recoveryOperation,null);
},{authorize:script('expire','expire','expire','expire','expire')}));

// ---- guidance and the exits that really exist -----------------------------------------

const guidanceFor=(state,code,pendingAction,extra={})=>operatorGuidance({workflow:'cm-ai',
  identity:{repositoryId:'r',runId:'run',taskId:'T-001',attempt:1},state,code,pendingAction,outcome:'reported',...extra});

test('A guidance names the confirmation exit for a refused authorization and the exact manual step once it is spent',()=>{
  const denied=guidanceFor('pending_review','permission_denied','abandon_review',{reviewDispatchConfirmRequired:true});
  assert.equal(denied.recoveryOperation,'abandon_review');assert.equal(denied.authorizationGranted,false);
  assert.match(denied.summary,/从未启动|没有派发/);assert.match(denied.nextStep,/--allow-abandon-review/);
  assert.match(denied.nextStep,/授权/);assert.match(denied.prerequisites.join(' '),/2 次/);
  const confirmed=guidanceFor('pending_review','permission_denied_confirmed','resume');
  assert.equal(confirmed.recoveryOperation,'advance');assert.match(confirmed.nextStep,/新的审查授权|重新取得/);
  const spent=guidanceFor('blocked','review_permission_denied_limit','none');
  assert.equal(spent.recoveryOperation,null);assert.equal(spent.authorizationGranted,false);
  // The exact safe manual step: cancel, then a superseding new run for ordinary runs only.
  assert.match(spent.nextStep,/cancel/);assert.match(spent.nextStep,/--supersede-reviewed-evidence/);
  assert.match(spent.nextStep,/外部模型|执行策略/);assert.match(spent.nextStep,/还原|另存/);
  assert.match(spent.nextStep,/不要加 --accept-superseded-code-drift/);
});

test('B guidance names the extension exit for an extendable limit, the exact manual step for a spent one',()=>{
  const extendable=guidanceFor('blocked','review_not_dispatched_limit','abandon_review',{reviewDispatchConfirmRequired:true});
  assert.equal(extendable.recoveryOperation,'abandon_review');assert.equal(extendable.authorizationGranted,false);
  assert.match(extendable.nextStep,/授权.*过期|时钟/);assert.match(extendable.nextStep,/--allow-abandon-review/);
  assert.match(extendable.prerequisites.join(' '),/只能确认 1 次/);
  const expired=guidanceFor('pending_review','grant_expired','resume');
  assert.equal(expired.recoveryOperation,'advance');assert.match(expired.summary,/从未启动/);
  assert.match(expired.nextStep,/新的审查授权|重新取得/);
  const spent=guidanceFor('blocked','review_not_dispatched_limit','none');
  assert.equal(spent.recoveryOperation,null);assert.equal(spent.authorizationGranted,false);
  assert.match(spent.nextStep,/cancel/);assert.match(spent.nextStep,/--supersede-reviewed-evidence/);
  assert.match(spent.nextStep,/外部模型|执行策略/);assert.match(spent.nextStep,/还原|另存/);
  assert.match(spent.nextStep,/不要加 --accept-superseded-code-drift/);
});

test('the superseding new run named for an ordinary run is admitted; the external-run guard refuses a not-dispatched strict prior run',()=>fixture(async f=>{
  await toLimit(f);
  // cancel from the raw pending_review end journals cancelled, which supersede accepts.
  const cancelled=f.reopen().cancel();assert.equal(cancelled.state,'cancelled');
  const history=f.history(),records=f.records();
  assert.equal(history.state.state,'cancelled');assert.equal(history.pending,null);
  const ordinary=records[0].payload.config,strict={...ordinary,externalModels:{providers:{}}};
  assert.equal(strictPriorAttemptResolved(ordinary,history,records),true);
  // A strict (external-model) prior run whose last review was never dispatched keeps its reconciliation
  // flag, so the guard refuses a new run on the same code root: no new-run exit exists for it.
  assert.equal(history.state.reviewInvocation.result.reconciliationRequired,true);
  assert.equal(strictPriorAttemptResolved(strict,history,records),false);
  assert.equal(sameTaskPriorAttemptResolved(history),false);
},{authorize:script('expire','expire','expire')}));

test('the refused-authorization limit has a new-run exit even for an external-model run: no registration left a reconciliation mark',()=>fixture(async f=>{
  const runner=f.make();await runner.executeEffect(f.effect('develop'));await runner.executeEffect(f.effect('review'));
  f.reopen().abandonReview({allowed:true,reason:reasonFor});
  await f.reopen().executeEffect(f.retry(1));
  f.reopen().abandonReview({allowed:true,reason:reasonFor});
  const limit=await f.reopen().executeEffect(f.retry(2));assert.equal(limit.code,'review_permission_denied_limit');
  assert.equal(f.reopen().cancel().state,'cancelled');
  const history=f.history(),records=f.records(),strict={...records[0].payload.config,externalModels:{providers:{}}};
  assert.equal(history.state.reviewInvocation,null);
  assert.equal(strictPriorAttemptResolved(strict,history,records),true);
  assert.equal(sameTaskPriorAttemptResolved(history),true);
},{authorize:script('deny','deny','deny')}));

// ---- redispatch effect ids are derived from the round's own cache ------------------------
// A refused authorization registers nothing, so reviewInvocation keeps the PREVIOUS round's
// value; ids counted from it repeated an earlier id, the cache answered, and the run stayed stuck.

async function roundTwo(f,{round1Expiries}){
  const runner=f.make();await runner.executeEffect(f.effect('develop'));
  await runner.executeEffect(f.effect('review'));
  for(let n=1;n<=round1Expiries;n++)await f.reopen().executeEffect(f.retry(n));
  const changed=f.reopen().status();assert.equal(changed.state,'changes_requested',JSON.stringify(changed));
  assert.equal((await f.reopen().executeEffect(f.effect('develop',2))).state,'awaiting_review');
  const identity={...f.identity,attempt:2};
  const entryFor=()=>createCmAiConversationEntry({specsDir:path.dirname(f.tasksPath),codeProject:f.root,feature:'feature',
    identity,runner:f.reopen(),allowAbandonReview:true,hostDecision:null,
    hostDecisionProvider:{timeoutMs:1000,decide:async()=>({status:'approved'})}});
  const handle=async(operation,extra={})=>{
    const entry=entryFor();
    const status=await entry.handle({version:1,operation:'status',requestId:'s',identity});
    return entry.handle({version:1,operation,requestId:operation,identity,
      ...(operation==='decision'?{packageDigest:status.packageDigest}:{}),...extra});
  };
  const intents=()=>f.records().filter(row=>row.payload.type==='effect-intent'&&row.payload.effect.kind==='review'
    &&row.payload.effect.identity.attempt===2).map(row=>row.payload.effect.id);
  // One decision or confirmation: the journal must grow (the cache was not hit) and no id repeats.
  const step=async(operation,extra)=>{
    const before=f.records().length,result=await handle(operation,extra);
    assert(f.records().length>before,`${operation} left the journal unchanged: ${JSON.stringify(result)}`);
    assert.equal(new Set(intents()).size,intents().length,`repeated id in ${intents()}`);
    return result;
  };
  return {handle,step,intents};
}

test('round 1 retry, round 2 denial confirmed and denied again: every confirmation redispatches under a new id',()=>fixture(async f=>{
  const {step,intents,handle}=await roundTwo(f,{round1Expiries:1});
  assert.equal((await step('decision')).code,'permission_denied');
  const denied=await handle('status');
  assert.deepEqual([denied.state,denied.code,denied.pendingAction],['pending_review','permission_denied','abandon_review'],JSON.stringify(denied));
  assert.equal((await step('abandon_review',{reason:reasonFor})).code,'permission_denied_confirmed');
  const again=await step('decision');assert.deepEqual([again.state,again.code],['pending_review','permission_denied'],JSON.stringify(again));
  assert.equal((await step('abandon_review',{reason:reasonFor})).code,'permission_denied_confirmed');
  const approved=await step('decision');assert.equal(approved.state,'approved',JSON.stringify(approved));
  assert.equal(f.dispatches(),2);assert.equal(intents().length,3);
},{authorize:script('expire','ok','deny','deny','ok'),changesFirst:true}));

test('round 1 retry, round 2 denial confirmed, expiry before dispatch, then resume: the resume registers and dispatches',()=>fixture(async f=>{
  const {step,intents,handle}=await roundTwo(f,{round1Expiries:1});
  assert.equal((await step('decision')).code,'permission_denied');
  assert.equal((await step('abandon_review',{reason:reasonFor})).code,'permission_denied_confirmed');
  const expired=await step('decision');assert.deepEqual([expired.state,expired.code],['pending_review','grant_expired'],JSON.stringify(expired));
  const status=await handle('status');assert.equal(status.code,'grant_expired');assert.equal(status.pendingAction,'resume');
  const approved=await step('decision');assert.equal(approved.state,'approved',JSON.stringify(approved));
  assert.equal(intents().length,3);
},{authorize:script('expire','ok','deny','expire','ok'),changesFirst:true}));

test('round 1 with two voided registrations, then round 2 with two confirmations and an expiry: no earlier id comes back',()=>fixture(async f=>{
  const {step,intents,handle}=await roundTwo(f,{round1Expiries:2});
  assert.equal((await step('decision')).code,'permission_denied');
  assert.equal((await step('abandon_review',{reason:reasonFor})).code,'permission_denied_confirmed');
  assert.equal((await step('decision')).code,'permission_denied');
  assert.equal((await step('abandon_review',{reason:reasonFor})).code,'permission_denied_confirmed');
  const expired=await step('decision');assert.deepEqual([expired.state,expired.code],['pending_review','grant_expired'],JSON.stringify(expired));
  assert.equal((await handle('status')).code,'grant_expired');
  const approved=await step('decision');assert.equal(approved.state,'approved',JSON.stringify(approved));
  assert.equal(f.dispatches(),2);assert.equal(intents().length,4);
},{authorize:script('expire','expire','ok','deny','deny','expire','ok'),changesFirst:true}));
