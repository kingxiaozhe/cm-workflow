// A current-session develop answer the host rejects as invalid (here
// application.note over 512 characters) is a retryable block; advance journals
// develop-answer-retry and redoes the same round with a new effect id.
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
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cm-develop-answer-')));
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
const identity=attempt=>({repositoryId:'develop-answer',runId:'timeout-run',taskId:'T-002',attempt});
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
  return {configuration:{kind:'develop-answer-v1'},timeoutMs:20000,excludedContexts:['control'],
    developer:{provider:'codex',requestedModel:'current-session',contextId:'developer',run:createCodexDeveloperRun({
      requestedModel:'current-session',worker:async()=>{
        const worker=queue.shift();
        if(typeof worker==='object'){fs.writeFileSync(path.join(f.codeProject,'a.mjs'),worker.write);return {status:'succeeded',value:worker.value};}
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
const longNote={write:'round-2 draft\n',value:{...learning,application:{status:'applied',note:'很长的说明'.repeat(130)}}};

test('develop_answer_invalid: a rejected current-session answer redoes the same round with a new effect id',async t=>{
  const f=fixture(t);
  // Round 1 delivered and reviewed (changes_requested); the round-2 answer's note is too long.
  const [rejected]=await session(f,'create',['round-1\n',longNote],[['advance',1]]);
  assert.deepEqual([rejected.state,rejected.code,rejected.pendingAction],['blocked','develop_answer_invalid','resume'],JSON.stringify(rejected));
  assert.match(rejected.reason,/application\.note 超过 512 个字符/);assert.match(rejected.reason,/240 个字符/);
  assert.equal(rejected.guidance.recoveryOperation,'advance');
  // The journal holds what older runtimes wrote: blocked/failed, invalid_result, no retryable flag.
  const before=records(f),checkpoint=before.at(-1).payload;
  assert.equal(checkpoint.effectId,'develop-2');
  assert.deepEqual([checkpoint.checkpoint.state,checkpoint.checkpoint.code],['blocked','failed']);
  assert.deepEqual(checkpoint.checkpoint.calls.at(-1).failureResult,{code:'invalid_result',reason:'application_note_limit'});
  assert.equal(readRunnerHistory(before,before[0].payload.config,3).state.code,'failed');
  // The session's draft stays on disk; a resumed host projects the same block.
  assert.equal(fs.readFileSync(path.join(f.codeProject,'a.mjs'),'utf8'),'round-2 draft\n');
  const [status,redone]=await session(f,'resume',['round-2\n'],[['status',2],['advance',2]]);
  assert.deepEqual([status.state,status.code,status.pendingAction],['blocked','develop_answer_invalid','resume']);
  assert.deepEqual([redone.state,redone.code,redone.identity.attempt],['blocked','review_limit',2],JSON.stringify(redone));
  const after=records(f);
  assert.deepEqual(after.slice(0,before.length),before,'journal is append-only');
  const added=after.slice(before.length).map(row=>row.payload.type==='effect-intent'?`intent:${row.payload.effect.id}`:row.payload.type);
  assert.deepEqual(added.slice(0,3),['develop-answer-retry','intent:develop-2-retry-1','effect-checkpoint']);
  const redelivered=after[before.length+2].payload.checkpoint;
  assert.equal(redelivered.state,'awaiting_review');
  // The redone delivery is built from the round's start and goes to review.
  assert.equal(Buffer.from(redelivered.reviewPackage.changes.find(c=>c.path==='a.mjs').after.contentBase64,'base64').toString(),'round-2\n');
  assert.ok(added.includes('intent:review-2'));
  const replayed=readRunnerHistory(after,after[0].payload.config,3).state;
  assert.equal(replayed.code,'review_limit');assert.equal(replayed.receipts.length,2,'review rounds are not reset');
});
