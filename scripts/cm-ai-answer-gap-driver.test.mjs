// Q28: the single-task and batch drivers decide which develop answers to prepare
// from the status the host will show, not the raw replay state. Raw replay of a
// retryable develop timeout reads unknown/call_timeout, so drivers prepared no
// answer and ended the real redo in host_close (#198/#199 unusable in driver mode).
import test from 'node:test';
import assert from 'node:assert/strict';
import {readRunnerHistory,projectedRunnerStatus} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {projectDevelopAttempts} from './cm-ai-drive.mjs';
import {batchDevelopAttempts} from './cm-ai-batch-drive.mjs';
import {gapFixture,gapExecution,gapSession,records} from './cm-ai-answer-gap-fixture.mjs';

const replay=f=>{const rows=records(f),config=rows[0].payload.config;return {history:readRunnerHistory(rows,config,3),config};};
test('drivers prepare the redo answer for a timed-out develop (develop_call_timeout) from the projected status',async t=>{
  const f=gapFixture(t,'driver-timeout');
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:['hang']}),[['advance',1]]);
  assert.equal(stuck.code,'develop_call_timeout');
  const {history,config}=replay(f);
  assert.deepEqual([history.state.state,history.state.code],['unknown','call_timeout']);
  // The raw replay state (what drivers used) projects no attempt.
  assert.deepEqual(projectDevelopAttempts(history.state,'advance',[]).attempts,[]);
  const projected=projectedRunnerStatus(history,config);
  assert.deepEqual([projected.state,projected.code],['blocked','develop_call_timeout']);
  assert.deepEqual(projectDevelopAttempts(projected,'advance',[]).attempts,[1]);
  assert.deepEqual(batchDevelopAttempts(projected,'1.work/T-002',[]),[1]);
});
test('drivers prepare no developer answer for a re-check (check_answer_missing)',async t=>{
  const f=gapFixture(t,'driver-recheck');
  await gapSession(f,'create',gapExecution(f,{developer:['round-1\n'],checks:['hang']}),[['advance',1]]);
  const {history,config}=replay(f),projected=projectedRunnerStatus(history,config);
  assert.deepEqual([projected.state,projected.code],['blocked','check_answer_missing']);
  assert.deepEqual(projectDevelopAttempts(projected,'advance',[]).attempts,[]);
  assert.deepEqual(batchDevelopAttempts(projected,'1.work/T-002',[]),[]);
  // Codex round 1: with the round-1 review authorized, the same advance can reach round 2.
  const reach=projectDevelopAttempts(projected,'advance',['--allow-review-attempt','1']);
  assert.deepEqual([reach.attempts,reach.reviewAfterDevelop,reach.holdable],[[2],true,true]);
  assert.deepEqual(batchDevelopAttempts(projected,'1.work/T-002',['--allow-review','1.work/T-002:1']),[2]);
  // Without a round-2 answer the driver launches with --hold-revision: the re-check and
  // its review run, then the task stops at changes_requested; no develop is asked.
  const before=f.calls.developer;
  const [held]=await gapSession(f,'resume',gapExecution(f),[['advance',1]],{holdRevision:true});
  assert.deepEqual([held.state,held.code,held.identity.attempt],['changes_requested','revision_answer_required',2],JSON.stringify(held));
  assert.equal(f.calls.developer,before);
});
test('drivers preflight both rounds for a retryable round-1 block when the round-1 review is authorized',()=>{
  const status={state:'blocked',code:'develop_call_timeout',attempt:1};
  const reach=projectDevelopAttempts(status,'advance',['--allow-review-attempt','1']);
  assert.deepEqual([reach.attempts,reach.reviewAfterDevelop],[[1,2],true]);
  assert.deepEqual(projectDevelopAttempts(status,'advance',[]).attempts,[1]);
  assert.deepEqual(batchDevelopAttempts(status,'1.work/T-002',['--allow-review','1.work/T-002:1']),[1,2]);
  assert.deepEqual(batchDevelopAttempts({...status,attempt:2},'1.work/T-002',['--allow-review','1.work/T-002:1']),[2]);
});
