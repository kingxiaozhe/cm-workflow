import test from 'node:test';
import assert from 'node:assert/strict';
import { runReplay, executionFingerprint } from './replay.mjs';

const args = { task_id: 'C-DEMO-001' };
const config = { scope: 'synthetic', worker: 'fake' };
const options = { args, config, runId: 'replay-c' };
function fake(calls) {
  return async (request, { stepId }) => {
    calls.push({ stepId, request });
    return { status: 'succeeded', value: { greeting: stepId === 'first' ? 'hello' : 'hello again' } };
  };
}
test('C01: fixed JS entry executes sequentially, passing first result to second', async () => {
  const calls = [];
  const result = await runReplay({ ...options, worker: fake(calls) });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(calls.map(c => c.stepId), ['first', 'second']);
  assert.ok(calls[1].request.prompt.includes('hello'));
  assert.deepEqual(result.value, { first: 'hello', second: 'hello again' });
  assert.equal(result.snapshot.status, 'succeeded');
});
test('C02: first failure or malformed result never starts the second step', async () => {
  for (const response of [null, {}, { status: 'failed', code: 'worker_failed' },
    { status: 'succeeded', value: {} }, { status: 'succeeded', value: { greeting: '' } }]) {
    let count = 0;
    const result = await runReplay({ ...options, worker: async () => { count++; return response; } });
    assert.equal(result.status, 'failed'); assert.equal(count, 1);
    assert.equal(result.code, response?.status === 'failed' ? 'worker_failed' : 'invalid_result');
  }
});
test('C05/C06: pre-cancel dispatches zero; late fake success cannot override cancellation', async () => {
  const before = new AbortController(); before.abort();
  const calls = [];
  assert.equal((await runReplay({ ...options, worker: fake(calls), signal: before.signal })).status, 'cancelled');
  assert.equal(calls.length, 0);
  const during = new AbortController(); let count = 0;
  const result = await runReplay({ ...options, signal: during.signal, worker: async () => {
    count++; during.abort(); await Promise.resolve();
    return { status: 'succeeded', value: { greeting: 'too late' } };
  } });
  assert.equal(result.status, 'cancelled'); assert.equal(count, 1);
  assert.equal(result.snapshot.status, 'cancelled');
});
test('C09: serialized checkpoint resumes through the same entry, first dispatch occurs only once', async () => {
  const uninterruptedCalls = [];
  const baseline = await runReplay({ ...options, worker: fake(uninterruptedCalls) });
  const calls = [];
  const interrupted = await runReplay({ ...options, worker: fake(calls), onCheckpoint: state => {
    if (state.records.length === 1 && state.records[0].status === 'succeeded') return 'interrupt';
  } });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(calls.length, 1);
  const snapshot = JSON.parse(JSON.stringify(interrupted.snapshot));
  const resumed = await runReplay({ ...options, worker: fake(calls), snapshot });
  assert.equal(resumed.status, 'succeeded'); assert.deepEqual(resumed.value, baseline.value);
  assert.deepEqual(calls, uninterruptedCalls);
  const again = await runReplay({ ...options, worker: fake(calls), snapshot: resumed.snapshot });
  assert.deepEqual(again.value, baseline.value); assert.equal(calls.length, 2);
});
test('C10: changed input, scope, config or workflow refuses recovery with zero calls', async () => {
  const paused = await runReplay({ ...options, worker: fake([]), onCheckpoint: () => 'interrupt' });
  for (const change of [{ args: { task_id: 'changed' } }, { config: { ...config, scope: 'changed' } },
    { config: { ...config, worker: 'other' } }, { runId: 'other' },
    { workflow: async ctx => ctx.agent('third', { prompt: 'changed' }) }]) {
    const calls = [];
    const result = await runReplay({ ...options, ...change, worker: fake(calls), snapshot: paused.snapshot });
    assert.equal(result.status, 'blocked'); assert.equal(result.code, 'snapshot_identity');
    assert.equal(calls.length, 0);
  }
});
test('C10: dependency bytes participate in execution fingerprint', () => {
  const original = executionFingerprint({ ...options, dependencies: { module: 'v1' } });
  assert.notEqual(executionFingerprint({ ...options, dependencies: { module: 'v2' } }), original);
});
test('C11: snapshot captured after dispatch begins is unknown, never automatically retried', async () => {
  let saved; const calls = [];
  await runReplay({ ...options, worker: fake(calls), onCheckpoint: state => {
    if (state.records.at(-1)?.status === 'running') saved = JSON.parse(JSON.stringify(state));
  } });
  assert.ok(saved, 'running checkpoint must exist before calling worker');
  const resumedCalls = [];
  const result = await runReplay({ ...options, worker: fake(resumedCalls), snapshot: saved });
  assert.equal(result.status, 'unknown'); assert.equal(result.code, 'reconciliation_required');
  assert.equal(resumedCalls.length, 0);
});
test('C12: terminal failure and cancellation never reopen on restore', async () => {
  for (const status of ['failed','cancelled']) {
    const controller = new AbortController();
    const first = await runReplay({ ...options, signal: controller.signal, worker: async () => {
      if (status === 'cancelled') controller.abort();
      return { status: 'failed', code: 'test_failure' };
    } });
    const calls = [];
    const result = await runReplay({ ...options, worker: fake(calls), snapshot: first.snapshot });
    assert.equal(result.status, 'blocked'); assert.equal(result.code, 'run_terminal');
    assert.equal(calls.length, 0);
  }
});
test('C13: inconsistent prefix, early return and appended step block without new calls', async () => {
  let mode = 'normal';
  // Deliberately impure test injection: same function bytes, different control flow.
  const workflow = async ctx => {
    if (mode === 'early') return {};
    const first = await ctx.agent(mode === 'rename' ? 'changed' : 'first', { prompt: 'first' });
    if (mode === 'extra') await ctx.agent('extra', { prompt: 'extra' });
    return first;
  };
  const initial = await runReplay({ ...options, workflow, worker: fake([]) });
  for (const changed of ['early','rename','extra']) {
    mode = changed; const calls = [];
    const result = await runReplay({ ...options, workflow, worker: fake(calls), snapshot: initial.snapshot });
    assert.equal(result.status, 'blocked', changed); assert.equal(result.code, 'replay_diverged');
    assert.equal(calls.length, 0);
    assert.equal(result.snapshot.status, 'succeeded');
  }
});
test('C13: missing, corrupt or malformed cache refuses before workflow or worker starts', async () => {
  const complete = await runReplay({ ...options, worker: fake([]) });
  const corruptions = [
    s => { s.records.pop(); }, s => { delete s.records[0].value; },
    s => { s.records[0].value.greeting = 'corrupt'; }, s => { s.records[1] = null; },
    s => { s.records = 'bad'; }, s => { s.status = 'other'; }, s => { s.records[0].status = 'pending'; },
  ];
  for (const corrupt of corruptions) {
    const snapshot = JSON.parse(JSON.stringify(complete.snapshot)); corrupt(snapshot);
    const calls = [];
    const result = await runReplay({ ...options, worker: fake(calls), snapshot });
    assert.equal(result.status, 'blocked'); assert.equal(result.code, 'invalid_snapshot');
    assert.equal(calls.length, 0);
  }
});
test('workflow inputs, requests and returned cache values are isolated frozen JSON', async () => {
  const mutableArgs = { task_id: 'C-DEMO-001' };
  const workflow = async ctx => {
    assert.equal(Object.isFrozen(ctx.args), true);
    const value = await ctx.agent('first', { prompt: 'first', schema: { type: 'object' } });
    assert.equal(Object.isFrozen(value), true);
    assert.equal(ctx.args.task_id, 'C-DEMO-001');
    return value;
  };
  const result = await runReplay({ ...options, args: mutableArgs, workflow, worker: async request => {
    assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.schema), true);
    mutableArgs.task_id = 'outside mutation';
    return { status: 'succeeded', value: { greeting: 'hello' } };
  } });
  assert.equal(result.status, 'succeeded');
});
test('C13 regression: duplicate step at interrupted history frontier dispatches nothing new', async () => {
  let secondId = 'second';
  const workflow = async ctx => {
    await ctx.agent('first', { prompt: 'first' });
    return ctx.agent(secondId, { prompt: 'second' });
  };
  const calls = [];
  const interrupted = await runReplay({ ...options, workflow, worker: fake(calls), onCheckpoint: state => {
    if (state.records[0]?.status === 'succeeded') return 'interrupt';
  } });
  assert.equal(interrupted.status, 'interrupted'); assert.equal(calls.length, 1);
  secondId = 'first'; const resumedCalls = [];
  const result = await runReplay({ ...options, workflow, worker: fake(resumedCalls),
    snapshot: JSON.parse(JSON.stringify(interrupted.snapshot)) });
  assert.equal(result.status, 'blocked'); assert.equal(result.code, 'replay_diverged');
  assert.equal(resumedCalls.length, 0); assert.equal(result.snapshot.records.length, 1);
});
