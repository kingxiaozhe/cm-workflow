// P1-3: the develop failed before the session was asked anything (the host's
// own role routing threw). Nothing was dispatched: develop_dispatch_failed is a
// plain retryable block. A legacy journal that collapsed the same failure into
// execution_error (real api-native-reading-T-006 shape) gets it only while the
// code root still equals the round start, else the confirmed develop_redo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {gapFixture,gapExecution,gapSession,records,added} from './cm-ai-answer-gap-fixture.mjs';

test('develop_dispatch_failed: a role routing failure before dispatch redoes the round without the developer having run',async t=>{
  const f=gapFixture(t,'dispatch');
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:[{beforeDispatch:'role_log_failed'}]}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','develop_dispatch_failed','resume'],JSON.stringify(stuck));
  assert.match(stuck.reason,/未派发、未写盘/);assert.equal(stuck.guidance.recoveryOperation,'advance');
  const before=records(f),checkpoint=before.at(-1).payload.checkpoint;
  // New runs keep the routing code instead of execution_error.
  assert.deepEqual([checkpoint.state,checkpoint.code,checkpoint.calls.at(-1).terminal,checkpoint.calls.at(-1).resultDigest],
    ['unknown','role_log_failed','unknown',null]);
  assert.equal(f.calls.developer,0);
  const [delivered]=await gapSession(f,'resume',gapExecution(f,{developer:['round-1\n'],verdicts:['approved']}),[['advance',1]]);
  assert.equal(f.calls.developer,1);
  assert.deepEqual(added(f,before).slice(0,3),['develop-dispatch-retry','intent:develop-1-retry-1','effect-checkpoint'],JSON.stringify(delivered));
  assert.equal(records(f)[before.length].payload.basis,'dispatch_failed');
  assert.equal(readRunnerHistory(records(f),records(f)[0].payload.config,3).answerGaps.developDispatch,1);
});

test('develop_dispatch_failed: a legacy execution_error (T-006 shape) needs an unchanged root, else develop_redo',async t=>{
  const f=gapFixture(t,'legacy');
  // An unlisted code collapses into execution_error, exactly like older runtimes.
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:[{beforeDispatch:'legacy_unlisted_failure'}]}),[['advance',1]]);
  const before=records(f),checkpoint=before.at(-1).payload.checkpoint;
  assert.deepEqual([checkpoint.state,checkpoint.code,checkpoint.calls.at(-1).terminal,checkpoint.calls.at(-1).resultDigest],
    ['unknown','execution_error','unknown',null]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','develop_dispatch_failed','resume'],JSON.stringify(stuck));
  // Root changed since the round start: it may have been dispatched, so only the confirmed redo applies.
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'someone wrote\n');
  const [changed]=await gapSession(f,'resume',gapExecution(f),[['status',1],['advance',1]]);
  assert.deepEqual([changed.state,changed.code,changed.pendingAction],['blocked','develop_answer_missing','develop_redo'],JSON.stringify(changed));
  assert.equal(records(f).length,before.length,'nothing appended on a changed root');
  // Root restored: the plain exit applies again and the record pins the baseline.
  fs.writeFileSync(path.join(f.codeProject,'a.mjs'),'old\n');
  await gapSession(f,'resume',gapExecution(f,{developer:['round-1\n']}),[['advance',1]]);
  assert.deepEqual(added(f,before).slice(0,2),['develop-dispatch-retry','intent:develop-1-retry-1']);
  assert.equal(records(f)[before.length].payload.basis,'baseline');
});
