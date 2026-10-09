// A round-2 develop the host answer limit cut off (call_timeout) while the code
// root still equals the reviewed round-1 package is a retryable block; advance
// journals develop-timeout-retry and redoes the same round with a new effect id.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openControlRun} from './cm-ai-run.mjs';
import {buildManifest} from './cm-spec-manifest.mjs';
import {createCodexDeveloperRun} from '../runtime/js/cm-ai/codex-developer-adapter.mjs';
import {createHostCheck} from '../runtime/js/cm-ai/host-check.mjs';
import {reviewPaths} from '../runtime/js/cm-ai/review-runner.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';

const learning={outcome:'implemented',application:{status:'no_relevant_lesson',note:null},
  retrospective:{status:'no_new_lesson',candidates:[],reason:null}};
function fixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-develop-timeout-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codeProject=path.join(root,'code'),specsDir=path.join(root,'specs'),feature='1.work';
  fs.mkdirSync(codeProject);fs.mkdirSync(path.join(specsDir,feature),{recursive:true});
  fs.writeFileSync(path.join(codeProject,'a.mjs'),'old\n');
  fs.writeFileSync(path.join(codeProject,'requirements.md'),'fixture\n');
  for(const name of ['requirements.md','design.md'])fs.writeFileSync(path.join(specsDir,feature,name),'# Fixture\n');
  fs.writeFileSync(path.join(specsDir,feature,'tasks.md'),'- [ ] T-002: fixture\n');
  fs.writeFileSync(path.join(specsDir,'.cm-specs-status'),JSON.stringify({status:'approved',features:[feature],specFiles:buildManifest(specsDir)}));
  return {root,codeProject,specsDir,feature,store:path.join(specsDir,'.reviews','.execution','timeout-run','state.json')};
}
const identity=attempt=>({repositoryId:'develop-timeout',runId:'timeout-run',taskId:'T-002',attempt});
const definition=f=>({version:1,specsDir:f.specsDir,codeProject:f.codeProject,feature:f.feature,
  identity:identity(1),scope:['a.mjs'],requirements:['requirements.md']});
// answers: one per developer call in this host; 'hang' never answers (the
// session missed the host limit), a string is written to a.mjs and answered.
function execution(f,answers){
  const queue=[...answers];
  const reviewer={id:'reviewer',adapterId:'codex-review-adapter',provider:'codex',requestedModel:'fixture',
    allowed:true,available:true,contexts:['review-one','review-two'],run:(value,{onEvent})=>{
      onEvent({event:'thread.started',provider_thread:`review-thread-${value.identity.attempt}`});
      onEvent({event:'turn.started',item_type:null});onEvent({event:'item.completed',item_type:'agent_message'});
      onEvent({event:'turn.completed',item_type:null});onEvent({event:'process_closed',exit_code:0,signal:null,timed_out:false});
      const pkg=value.payload.reviewPackage;
      return {status:'succeeded',value:{verdict:'changes_requested',packageDigest:pkg.packageDigest,examinedPaths:reviewPaths(pkg),
        findings:[{id:'F1',severity:'P2',path:'a.mjs',message:'Revise',evidence:'Fixture finding'}],summary:'Fixture review'}};
    }};
  return {configuration:{kind:'develop-timeout-v1'},timeoutMs:1500,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'fixture',contextId:'developer',run:createCodexDeveloperRun({
      requestedModel:'fixture',worker:async()=>{
        const worker=queue.shift();
        if(worker==='hang')return new Promise(()=>{});
        fs.writeFileSync(path.join(f.codeProject,'a.mjs'),worker);return {status:'succeeded',value:learning};}})},
    reviewers:[reviewer],reviewInvocation:{developerThreadId:'author-thread',excludedThreadIds:['control'],
      authorize:(value,{authorizationAt})=>{const body={version:1,kind:'cm-review-dispatch-grant',
        grantId:'grant',adapterId:'codex-review-adapter',invocationId:value.invocationId,
        requestDigest:value.requestDigest,identity:value.identity,reviewerId:'reviewer',
        logicalContextId:value.contextId,packageDigest:value.payload.reviewPackage.packageDigest,
        hostContextId:'control',decisionId:'approved',decision:'approved',issuedAt:authorizationAt,
        expiresAt:authorizationAt+60000};return {...body,grantDigest:digest(body)};}},
    hostDecision:{status:'approved'},check:createHostCheck({cwd:f.codeProject,
      commands:[{id:'syntax',command:[process.execPath,'-e','0']}]})};
}
async function session(f,mode,answers,operations){
  const run=await openControlRun(definition(f),mode,execution(f,answers));
  const results=[];
  try{
    for(const [operation,attempt,extra] of operations)
      results.push(await run.host.handle({version:1,operation,requestId:`${operation}-${results.length}`,identity:identity(attempt),...extra}));
  }finally{run.close();}
  return results;
}
const records=f=>JSON.parse(fs.readFileSync(f.store,'utf8')).records;
// Round 1 delivered and reviewed (changes_requested), then the round-2 develop
// times out with nothing written.
async function timedOutRoundTwo(f){
  const [timedOut]=await session(f,'create',['round-1\n','hang'],[['advance',1]]);
  return timedOut;
}

test('develop_call_timeout: a timed-out round-2 develop with an unchanged code root redoes the round with a new effect id',async t=>{
  const f=fixture(t);
  const timedOut=await timedOutRoundTwo(f);
  // The live answer already reads the disk: nothing was written, so the block is retryable.
  assert.equal(timedOut.state,'blocked',JSON.stringify(timedOut));assert.equal(timedOut.code,'develop_call_timeout');
  assert.equal(timedOut.pendingAction,'resume');assert.equal(timedOut.guidance.recoveryOperation,'advance');
  assert.match(timedOut.guidance.summary,/开发应答超时、代码未改动/);
  // The journal holds exactly what older runtimes wrote: unknown/call_timeout.
  const before=records(f),checkpoint=before.at(-1).payload;
  assert.equal(checkpoint.effectId,'develop-2');
  assert.deepEqual([checkpoint.checkpoint.state,checkpoint.checkpoint.code],['unknown','call_timeout']);
  assert.equal(checkpoint.checkpoint.calls.at(-1).terminal,'unknown');
  assert.equal(readRunnerHistory(before,before[0].payload.config,3).state.state,'unknown');
  // A session that wrote after the limit keeps unknown/reconcile (no silent adoption).
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'late edit\n');
  const [changed]=await session(f,'resume',['round-2\n'],[['status',2],['advance',2]]);
  assert.deepEqual([changed.state,changed.code,changed.pendingAction],['unknown','call_timeout','reconcile']);
  assert.equal(records(f).length,before.length,'status/advance on a changed root must not append');
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'round-1\n');
  const [status,redone]=await session(f,'resume',['round-2\n'],[['status',2],['advance',2]]);
  assert.deepEqual([status.state,status.code,status.pendingAction],['blocked','develop_call_timeout','resume']);
  // The same advance goes on to the round-2 review, which is this run's last.
  assert.deepEqual([redone.state,redone.code,redone.identity.attempt],['blocked','review_limit',2],JSON.stringify(redone));
  const after=records(f);
  assert.deepEqual(after.slice(0,before.length),before,'journal is append-only');
  const added=after.slice(before.length).map(row=>row.payload.type==='effect-intent'?`intent:${row.payload.effect.id}`:row.payload.type);
  assert.deepEqual(added.slice(0,3),['develop-timeout-retry','intent:develop-2-retry-1','effect-checkpoint']);
  assert.equal(after[before.length+2].payload.checkpoint.state,'awaiting_review');
  assert.equal(after[before.length].payload.basis,'reviewed_package');
  assert.ok(added.includes('intent:review-2'));
  const replayed=readRunnerHistory(after,after[0].payload.config,3).state;
  assert.equal(replayed.code,'review_limit');assert.equal(replayed.receipts.length,2,'review rounds are not reset');
});

// Codex round 1 (P2): the released block keeps its start binding. A crash after
// develop-timeout-retry, or a write between the status check and dispatch,
// must not carry unreviewed edits into the redo.
function truncateAfter(f,type){
  const state=JSON.parse(fs.readFileSync(f.store,'utf8'));
  const index=state.records.findIndex(row=>row.payload.type===type);assert.ok(index>0);
  const {revision,...body}=state;body.records=state.records.slice(0,index+1);
  fs.writeFileSync(f.store,JSON.stringify({...body,revision:digest(body)})+'\n');
  return body.records;
}
test('develop_call_timeout: the released block re-verifies the round start before dispatch',async t=>{
  const f=fixture(t);
  await timedOutRoundTwo(f);
  // (a) The host wrote develop-timeout-retry and exited before the develop intent.
  const [, redone]=await session(f,'resume',['round-2\n'],[['status',2],['advance',2]]);
  assert.equal(redone.identity.attempt,2);
  const prefix=truncateAfter(f,'develop-timeout-retry');
  assert.equal(readRunnerHistory(prefix,prefix[0].payload.config,3).state.code,'develop_call_timeout');
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'late edit\n');
  const [crashed]=await session(f,'resume',['should-not-run\n'],[['advance',2]]);
  assert.deepEqual([crashed.state,crashed.code,crashed.pendingAction],['unknown','call_timeout','reconcile']);
  assert.equal(records(f).length,prefix.length,'no develop intent after a changed root');
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'late edit\n');
  // (b) Equal at the status check, changed right before dispatch: refused, nothing dispatched.
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'round-1\n');
  const target=path.join(f.codeProject,'a.mjs'),open=fs.openSync;
  // The first read of a.mjs inside executeEffect is its dispatch-time check;
  // every earlier read (the route's status checks) still sees the round start.
  let raced,changed=false;const limit=Error.stackTraceLimit;Error.stackTraceLimit=50;
  fs.openSync=(file,...rest)=>{
    if(file===target&&!changed&&/executeEffect/.test(new Error().stack)){changed=true;fs.writeFileSync(target,'raced edit\n');}
    return open(file,...rest);};
  try{[raced]=await session(f,'resume',['should-not-run\n'],[['advance',2]]);}finally{fs.openSync=open;Error.stackTraceLimit=limit;}
  assert.ok(changed,'the dispatch-time check read the root');
  assert.deepEqual([raced.outcome,raced.code],['rejected','develop_timeout_root_changed'],JSON.stringify(raced));
  assert.equal(records(f).length,prefix.length,'no develop intent after a raced change');
  assert.equal(fs.readFileSync(target,'utf8'),'raced edit\n');
});
