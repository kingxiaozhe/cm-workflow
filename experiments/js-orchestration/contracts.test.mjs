import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, transition, restoreRun, digest } from './contracts.mjs';

const base = { runId: 'run-c', fingerprint: 'code-input-config', scope: 'synthetic',
  steps: [{ id: 'first' }, { id: 'second', dependsOn: ['first'] }] };
const event = (id, type, fields = {}) => ({ id, type, runId: base.runId,
  fingerprint: base.fingerprint, scope: base.scope, stepId: 'first', attempt: 1,
  requestHash: 'request-first', ...fields });
const host = { source: 'host', now: 10 };
const worker = { source: 'worker', now: 10 };
const dispatch = event('dispatch', 'dispatch');
const complete = event('complete', 'complete', { result: { status: 'succeeded', value: { greeting: 'hello' } } });
const running = () => transition(createRun(base), dispatch, host).state;

test('C03: duplicate completion does not advance twice, conflicting reuse is rejected', () => {
  const done = transition(running(), complete, worker);
  const again = transition(done.state, complete, worker);
  assert.equal(again.outcome, 'duplicate'); assert.deepEqual(again.state, done.state);
  const conflict = transition(done.state, { ...complete, result: { status: 'failed', code: 'different' } }, worker);
  assert.equal(conflict.code, 'event_conflict'); assert.deepEqual(conflict.state, done.state);
});
test('C04: wrong identities, old attempt and dependency order never dispatch', () => {
  const initial = createRun(base);
  for (const change of [{ runId: 'other' }, { fingerprint: 'other' }, { scope: 'other' },
    { attempt: 2 }, { stepId: 'missing' }, { stepId: 'second' }]) {
    const result = transition(initial, { ...dispatch, ...change }, host);
    assert.equal(result.outcome, 'rejected'); assert.deepEqual(result.state, initial);
  }
  assert.equal(transition(initial, complete, worker).outcome, 'rejected');
});
test('C05/C06: cancellation is terminal and late completion cannot replace it', () => {
  for (const state of [createRun(base), running()]) {
    const cancelled = transition(state, event('cancel', 'cancel'), host).state;
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(transition(cancelled, complete, worker).outcome, 'rejected');
    assert.equal(transition(cancelled, { ...dispatch, id: 'after-cancel' }, host).outcome, 'rejected');
    if (state.steps[0].status === 'running') {
      const repeated = transition(cancelled, dispatch, host);
      assert.equal(repeated.outcome, 'duplicate'); assert.deepEqual(repeated.state, cancelled);
    }
  }
});
const approvalRun = () => createRun({ ...base, steps: [{ id: 'first', requiresApproval: true }] });
const ask = event('ask', 'request_decision', { requestId: 'decision-1', expiresAt: 20 });
const approve = event('approve', 'decision', { requestId: 'decision-1', decision: 'approve' });
const approved = () => transition(transition(approvalRun(), ask, host).state, approve, host).state;
test('C07: worker cannot supply host approval or dispatch/cancel authority', () => {
  const waiting = transition(approvalRun(), ask, host).state;
  for (const e of [approve, { ...approve, source: 'host' }, dispatch, event('cancel', 'cancel')]) {
    const r = transition(waiting, e, worker);
    assert.equal(r.outcome, 'rejected'); assert.deepEqual(r.state, waiting);
  }
  for (const decision of ['deny', 'timeout']) {
    const blocked = transition(waiting, { ...approve, decision }, host).state;
    assert.equal(blocked.status, 'blocked');
  }
});
test('C08: matching approval is consumed once; missing, changed, revoked and expired reject', () => {
  assert.equal(transition(approvalRun(), dispatch, host).outcome, 'rejected');
  const state = approved();
  const action = { ...dispatch, requestId: 'decision-1' };
  const r = transition(state, action, host);
  assert.equal(r.outcome, 'applied'); assert.equal(r.state.steps[0].approval.consumed, true);
  assert.equal(transition(r.state, action, host).outcome, 'duplicate');
  assert.equal(transition(r.state, { ...action, id: 'again' }, host).outcome, 'rejected');
  assert.equal(transition(r.state, { ...approve, id: 'again-approve' }, host).outcome, 'rejected');
  for (const change of [{ requestId: 'other' }, { requestHash: 'other' }, { scope: 'other' }, { attempt: 2 }])
    assert.equal(transition(state, { ...action, ...change }, host).outcome, 'rejected');
  assert.equal(transition(state, action, { ...host, now: 20 }).outcome, 'rejected');
  const revoked = transition(state, event('revoke', 'revoke'), host).state;
  assert.equal(transition(revoked, action, host).outcome, 'rejected');
});
test('C10/C11: wrong snapshot fingerprint rejects; running restoration becomes unknown', () => {
  assert.throws(() => restoreRun(running(), { ...base, fingerprint: 'changed' }), /snapshot_identity/);
  const restored = restoreRun(JSON.parse(JSON.stringify(running())), base);
  assert.equal(restored.status, 'unknown'); assert.equal(restored.steps[0].status, 'unknown');
  assert.equal(transition(restored, { ...dispatch, id: 'after-restore' }, host).outcome, 'rejected');
  assert.equal(transition(restored, dispatch, host).outcome, 'duplicate');
});
test('C12: completed run cannot reopen; malformed completion fails explicitly', () => {
  let state = createRun({ ...base, steps: [{ id: 'first' }] });
  state = transition(state, dispatch, host).state;
  const done = transition(state, complete, worker).state;
  assert.equal(done.status, 'succeeded');
  assert.equal(transition(done, { ...dispatch, id: 'new' }, host).outcome, 'rejected');
  const failed = transition(state, { ...complete, result: null }, worker).state;
  assert.equal(failed.status, 'failed'); assert.equal(failed.steps[0].code, 'invalid_result');
});
test('unknown event and malformed envelope are rejected without mutating input', () => {
  const state = createRun(base);
  for (const e of [null, [], {}, event('unknown', 'surprise')]) {
    const r = transition(state, e, host);
    assert.equal(r.outcome, 'rejected'); assert.deepEqual(r.state, state);
  }
  assert.equal(state.steps[0].status, 'pending');
});
test('C08: host harness dispatches fake adapter once only after consuming matching approval', () => {
  let state = approvalRun(); let calls = 0;
  const submit = (e, context = host) => {
    const result = transition(state, e, context); state = result.state;
    if (e.type === 'dispatch' && result.outcome === 'applied') {
      assert.equal(state.steps[0].approval.consumed, true); calls++;
    }
  };
  submit(dispatch); submit(ask); submit(approve, worker); submit(dispatch);
  assert.equal(calls, 0);
  submit(approve);
  const action = { ...dispatch, requestId: 'decision-1' };
  submit(action); submit(action); submit({ ...approve, id: 'duplicate-approval' });
  submit({ ...action, id: 'duplicate-dispatch' });
  assert.equal(calls, 1);
});
test('restore rejects structurally damaged state before it becomes usable', () => {
  for (const change of [
    s => { s.seen = [null]; }, s => { s.seen[0].signature = ''; },
    s => { s.steps[0].requestHash = null; }, s => { s.steps[0].status = 'succeeded'; },
    s => { s.status = 'succeeded'; },
  ]) {
    const state = running(); change(state);
    assert.throws(() => restoreRun(state, base), /invalid_snapshot/);
  }
  const state = approved(); state.steps[0].approval = null;
  assert.throws(() => restoreRun(state, { ...base, steps: [{ id: 'first', requiresApproval: true }] }), /invalid_snapshot/);
});
test('JSON fingerprint rejects sparse arrays instead of colliding with empty arrays', () => {
  assert.throws(() => digest(Array(1)), /non_json_value/);
  assert.notEqual(digest([]), digest([null]));
});
test('C11 regression: changing running to pending cannot re-enable a dispatched request', () => {
  const damaged = JSON.parse(JSON.stringify(running()));
  damaged.steps[0].status = 'pending';
  let calls = 0;
  assert.throws(() => {
    const restored = restoreRun(damaged, base);
    const result = transition(restored, { ...dispatch, id: 'second-dispatch' }, host);
    if (result.outcome === 'applied') calls++;
  }, /invalid_snapshot/);
  assert.equal(calls, 0);
  // Approved pending legitimately retains its bound request; do not reject it.
  const restoredApproval = restoreRun(approved(), { ...base, steps: [{ id: 'first', requiresApproval: true }] });
  assert.equal(transition(restoredApproval, { ...dispatch, requestId: 'decision-1' }, host).outcome, 'applied');
});
