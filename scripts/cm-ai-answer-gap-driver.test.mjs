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
});
