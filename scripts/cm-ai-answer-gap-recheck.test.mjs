// V3 (P1-1): the developer call succeeded and its delivery is on disk, but the
// later task check (or the completion re-check) never got a usable answer. The
// run shows a retryable block; advance journals develop-recheck/complete-recheck
// and re-runs only those steps. The developer is never dispatched again.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {readRunnerHistory} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {gapFixture,gapExecution,gapSession,records,added} from './cm-ai-answer-gap-fixture.mjs';

test('check_answer_missing: a timed-out check after a delivered develop re-runs only the checks, then complete_recheck_failed re-runs only completion',async t=>{
  const f=gapFixture(t,'recheck');
  // Round 1 delivers; its check never answers (the runner limit stops it).
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:['round-1\n'],checks:['hang']}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','check_answer_missing','resume'],JSON.stringify(stuck));
  assert.match(stuck.reason,/原记录 unknown\/call_timeout/);
  assert.equal(stuck.guidance.recoveryOperation,'advance');assert.match(stuck.guidance.nextStep,/只重跑检查/);
  const before=records(f),checkpoint=before.at(-1).payload.checkpoint;
  // The journal keeps exactly what older runtimes wrote (real T-005/T-008 shape).
  assert.deepEqual([checkpoint.state,checkpoint.code,checkpoint.calls.at(-1).terminal],['unknown','call_timeout','succeeded']);
  assert.equal(readRunnerHistory(before,before[0].payload.config,3).state.state,'unknown');
  assert.equal(f.calls.developer,1);
  // Resume: re-check approves; then the completion re-check never answers.
  const resumed=gapExecution(f,{checks:['ok','hang'],verdicts:['approved']});
  const [status,advanced]=await gapSession(f,'resume',resumed,[['status',1],['advance',1]]);
  assert.deepEqual([status.state,status.code,status.pendingAction],['blocked','check_answer_missing','resume']);
  assert.equal(f.calls.developer,1,'the re-check never dispatches the developer');
  assert.deepEqual([advanced.state,advanced.code,advanced.pendingAction],['blocked','complete_recheck_failed','complete'],JSON.stringify(advanced));
  assert.equal(advanced.guidance.recoveryOperation,'complete');
  const steps=added(f,before);
  assert.deepEqual(steps.slice(0,3),['develop-recheck','intent:develop-1-retry-1','effect-checkpoint']);
  assert.ok(steps.includes('intent:review-1')&&steps.includes('intent:complete-1'));
  const after=records(f);assert.deepEqual(after.slice(0,before.length),before,'journal is append-only');
  const rechecked=after[before.length+2].payload.checkpoint;
  assert.equal(rechecked.state,'awaiting_review');assert.equal(rechecked.calls.length,1,'no new developer call');
  assert.equal(Buffer.from(rechecked.reviewPackage.changes.find(c=>c.path==='a.mjs').after.contentBase64,'base64').toString(),'round-1\n');
  // Re-checked completion: complete-recheck, then the run completes.
  const middle=records(f);
  const [done]=await gapSession(f,'resume',gapExecution(f,{checks:['ok']}),[['advance',1]]);
  assert.deepEqual([done.state,done.pendingAction],['fixture_completed','qa'],JSON.stringify(done));
  assert.deepEqual(added(f,middle).slice(0,2),['complete-recheck','intent:complete-1-retry-1']);
  assert.match(fs.readFileSync(path.join(f.specsDir,f.feature,'tasks.md'),'utf8'),/\[x\] T-002/);
  const final=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.equal(final.state.state,'fixture_completed');
  assert.deepEqual(final.answerGaps,{developRecheck:1,completeRecheck:1});
  assert.equal(final.state.receipts.length,1,'one review round');
});

test('check_answer_invalid: a malformed check answer is re-checked at most twice per run, then stays unknown',async t=>{
  const f=gapFixture(t,'invalid');
  const [stuck]=await gapSession(f,'create',gapExecution(f,{developer:['round-1\n'],checks:['invalid']}),[['advance',1]]);
  assert.deepEqual([stuck.state,stuck.code,stuck.pendingAction],['blocked','check_answer_invalid','resume'],JSON.stringify(stuck));
  const [first]=await gapSession(f,'resume',gapExecution(f,{checks:['hang']}),[['advance',1]]);
  assert.deepEqual([first.state,first.code],['blocked','check_answer_missing'],JSON.stringify(first));
  const [second]=await gapSession(f,'resume',gapExecution(f,{checks:['invalid']}),[['advance',1]]);
  assert.deepEqual([second.state,second.code,second.pendingAction],['unknown','invalid_input','reconcile'],JSON.stringify(second));
  assert.equal(f.calls.developer,1);
  const history=readRunnerHistory(records(f),records(f)[0].payload.config,3);
  assert.equal(history.answerGaps.developRecheck,2);
  // Effects and calls stay inside the run budget: the sources hold no slot.
  assert.deepEqual(records(f).filter(row=>row.payload.type==='effect-intent').map(row=>row.payload.effect.id),
    ['develop-1','develop-1-retry-1','develop-1-retry-2']);
});
