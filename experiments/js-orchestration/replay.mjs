// C-only in-memory host. Workers and workflow functions are trusted test fixtures.
// No disk persistence, effects, retry or real provider adapters are wired here.
import { run } from './two-step.mjs';
import { validGreeting } from './inspect-task.mjs';
import { digest } from './contracts.mjs';
import { readFileSync } from 'node:fs';
const copy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const frozenCopy = value => { digest(value); return freeze(copy(value)); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const seal = snapshot => {
  const { integrity, ...data } = snapshot;
  return { ...copy(data), integrity: digest(data) };
};
function validSnapshot(snapshot) {
  if (!record(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.records)
    || !['active','interrupted','succeeded','failed','cancelled','blocked','unknown'].includes(snapshot.status)) return false;
  const { integrity, ...data } = snapshot;
  if (integrity !== digest(data)) return false;
  const ids = new Set();
  return snapshot.records.every((r, index) => {
    if (!record(r) || typeof r.stepId !== 'string' || !r.stepId.trim() || ids.has(r.stepId)
      || !/^[a-f0-9]{64}$/.test(r.requestHash) || !['running','succeeded'].includes(r.status)) return false;
    ids.add(r.stepId);
    return r.status === 'succeeded' ? validGreeting(r.value)
      : index === snapshot.records.length - 1 && snapshot.status !== 'succeeded';
  });
}
// Fingerprint only this fixed module graph. This is not a generic import scanner.
const sources = Object.fromEntries(['replay.mjs','two-step.mjs','inspect-task.mjs','contracts.mjs']
  .map(name => [name, readFileSync(new URL(name, import.meta.url), 'utf8')]));
export const executionFingerprint = ({ args, config, workflow = run, dependencies = sources }) =>
  digest({ args, config, workflow: String(workflow), dependencies });
class Halt extends Error {
  constructor(status, code) { super(code); this.status = status; }
}

export async function runReplay({ args, config, runId, worker, workflow = run,
  signal = new AbortController().signal, snapshot: saved, onCheckpoint = () => {} }) {
  let fingerprint;
  try { fingerprint = executionFingerprint({ args, config, workflow }); }
  catch { return { status: 'blocked', code: 'invalid_input', snapshot: null }; }
  if (saved !== undefined && (!record(saved) || saved.runId !== runId || saved.fingerprint !== fingerprint))
    return { status: 'blocked', code: 'snapshot_identity', snapshot: null };
  try {
    if (saved !== undefined && !validSnapshot(saved)) throw new Error('invalid_snapshot');
  } catch { return { status: 'blocked', code: 'invalid_snapshot', snapshot: null }; }
  const snapshot = saved ? copy(saved) : { version: 1, runId, fingerprint, status: 'active', records: [] };
  if (['failed','cancelled','blocked'].includes(snapshot.status))
    return { status: 'blocked', code: 'run_terminal', snapshot: seal(snapshot) };
  if (snapshot.status === 'unknown' || snapshot.records.some(r => r.status === 'running')) {
    snapshot.status = 'unknown';
    return { status: 'unknown', code: 'reconciliation_required', snapshot: seal(snapshot) };
  }
  const historyLength = snapshot.records.length;
  let cursor = 0;
  const checkpoint = async () => {
    if (await onCheckpoint(seal(snapshot)) === 'interrupt') throw new Halt('interrupted', 'checkpoint_interrupt');
  };
  const cancelled = () => { if (signal.aborted) throw new Halt('cancelled', 'cancelled'); };
  try {
  cancelled();
  const value = await workflow({ args: frozenCopy(args), agent: async (stepId, request) => {
    cancelled();
    const requestHash = digest(request);
    if (cursor < historyLength) {
      const cached = snapshot.records[cursor++];
      if (cached.stepId !== stepId || cached.requestHash !== requestHash || cached.status !== 'succeeded')
        throw new Halt('blocked', 'replay_diverged');
      return frozenCopy(cached.value);
    }
    if (saved?.status === 'succeeded' || snapshot.records.some(r => r.stepId === stepId))
      throw new Halt('blocked', 'replay_diverged');
    const entry = { stepId, requestHash, status: 'running' };
    snapshot.records.push(entry);
    await checkpoint();
    cancelled();
    const response = await worker(frozenCopy(request), { stepId, runId, signal });
    cancelled();
    if (response?.status !== 'succeeded' || !validGreeting(response.value))
      throw new Halt('failed', response?.status === 'failed' && typeof response.code === 'string'
        && response.code.trim() ? response.code : 'invalid_result');
    entry.status = 'succeeded'; entry.value = copy(response.value);
    cursor++;
    await checkpoint();
    return frozenCopy(response.value);
  } });
  cancelled();
  if (cursor !== snapshot.records.length) throw new Halt('blocked', 'replay_diverged');
  snapshot.status = 'succeeded';
  return { status: 'succeeded', value, snapshot: seal(snapshot) };
  } catch (error) {
    const status = signal.aborted ? 'cancelled' : error instanceof Halt ? error.status : 'failed';
    if (saved?.status !== 'succeeded') snapshot.status = status;
    return { status, code: signal.aborted ? 'cancelled'
      : error instanceof Halt ? error.message : 'execution_error', snapshot: seal(snapshot) };
  }
}
