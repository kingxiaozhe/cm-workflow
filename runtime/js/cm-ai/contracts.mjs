// C-only pure JSON contracts. `source` is supplied by a trusted host, not by a worker.
// This is not a real UI approval bridge or an authenticated storage format.
import { createHash } from 'node:crypto';
const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.trim().length > 0;
function canonical(v) {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (Object.keys(v).length !== v.length || !Array.from({ length: v.length }, (_, i) => Object.hasOwn(v, i)).every(Boolean))
      throw new Error('non_json_value');
    return `[${v.map(canonical).join(',')}]`;
  }
  if (record(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)))
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  throw new Error('non_json_value');
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const copy = v => JSON.parse(canonical(v));

export function createRun({ runId, fingerprint, scope, steps }) {
  if (![runId, fingerprint, scope].every(text) || !Array.isArray(steps) || !steps.length)
    throw new Error('invalid_run');
  const ids = new Set();
  const items = steps.map(s => {
    if (!record(s) || !text(s.id) || ids.has(s.id) || (s.requiresApproval !== undefined && typeof s.requiresApproval !== 'boolean'))
      throw new Error('invalid_step');
    const dependsOn = s.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || !dependsOn.every(id => ids.has(id))) throw new Error('invalid_dependencies');
    ids.add(s.id);
    return { id: s.id, dependsOn: [...dependsOn], requiresApproval: s.requiresApproval ?? false,
      attempt: 1, status: 'pending', requestHash: null, approval: null };
  });
  return { version: 1, runId, fingerprint, scope, status: 'active', steps: items, seen: [] };
}

export function transition(state, event, { source, now = 0 } = {}) {
  const reject = code => ({ state, outcome: 'rejected', code });
  if (!record(event) || !text(event.id) || !text(event.type) || !Number.isFinite(now)) return reject('invalid_event');
  if (event.runId !== state.runId || event.fingerprint !== state.fingerprint || event.scope !== state.scope)
    return reject('identity_mismatch');
  if (!['host', 'worker'].includes(source)) return reject('untrusted_source');
  let signature;
  try { signature = digest({ event, source }); } catch { return reject('invalid_event'); }
  const seen = state.seen.find(e => e.id === event.id);
  if (seen) return seen.signature === signature ? { state, outcome: 'duplicate' } : reject('event_conflict');
  if (state.status !== 'active') return reject('run_terminal');
  if (event.type === 'complete' ? source !== 'worker' : source !== 'host') return reject('untrusted_source');
  const next = copy(state);
  const step = next.steps.find(s => s.id === event.stepId);
  if (event.type === 'cancel') {
    next.status = 'cancelled';
    for (const s of next.steps) if (['pending','running','waiting_user'].includes(s.status)) s.status = 'cancelled';
  } else {
    if (!step || event.attempt !== step.attempt) return reject('step_identity_mismatch');
    if (event.type === 'request_decision') {
      if (step.status !== 'pending' || !step.requiresApproval || !text(event.requestHash)
        || !text(event.requestId) || !Number.isFinite(event.expiresAt) || event.expiresAt <= now)
        return reject('invalid_decision_request');
      step.status = 'waiting_user'; step.requestHash = event.requestHash;
      step.approval = { requestId: event.requestId, expiresAt: event.expiresAt, decision: 'waiting', consumed: false };
    } else if (event.type === 'decision') {
      if (step.status !== 'waiting_user' || event.requestHash !== step.requestHash
        || event.requestId !== step.approval?.requestId) return reject('decision_mismatch');
      if (event.decision === 'approve') {
        if (now >= step.approval.expiresAt) return reject('approval_expired');
        step.approval.decision = 'approved'; step.status = 'pending';
      } else if (['deny', 'timeout'].includes(event.decision)) {
        step.status = 'blocked'; step.approval.decision = event.decision; next.status = 'blocked';
      } else return reject('invalid_decision');
    } else if (event.type === 'revoke') {
      if (step.status !== 'pending' || step.approval?.decision !== 'approved') return reject('invalid_revocation');
      step.approval.decision = 'revoked'; step.status = 'blocked'; next.status = 'blocked';
    } else if (event.type === 'dispatch') {
      if (step.status !== 'pending' || !text(event.requestHash)
        || !step.dependsOn.every(id => next.steps.find(s => s.id === id)?.status === 'succeeded'))
        return reject('dispatch_not_ready');
      if (step.requiresApproval) {
        const a = step.approval;
        if (!a || a.decision !== 'approved' || a.consumed || now >= a.expiresAt
          || event.requestId !== a.requestId || event.requestHash !== step.requestHash)
          return reject('approval_missing_or_stale');
        a.consumed = true;
      }
      step.requestHash = event.requestHash; step.status = 'running';
    } else if (event.type === 'complete') {
      if (step.status !== 'running' || event.requestHash !== step.requestHash) return reject('completion_mismatch');
      const r = event.result;
      if (record(r) && r.status === 'succeeded' && Object.hasOwn(r, 'value')) {
        step.status = 'succeeded'; step.value = copy(r.value);
        if (next.steps.every(s => s.status === 'succeeded')) next.status = 'succeeded';
      } else {
        step.status = 'failed'; next.status = 'failed';
        step.code = record(r) && r.status === 'failed' && text(r.code) ? r.code : 'invalid_result';
      }
    } else return reject('unsupported_event');
  }
  next.seen.push({ id: event.id, signature });
  return { state: next, outcome: 'applied' };
}

export function restoreRun(snapshot, expected) {
  const baseline = createRun(expected);
  if (!record(snapshot) || snapshot.version !== 1 || snapshot.runId !== baseline.runId
    || snapshot.fingerprint !== baseline.fingerprint || snapshot.scope !== baseline.scope)
    throw new Error('snapshot_identity');
  if (!Array.isArray(snapshot.steps) || snapshot.steps.length !== baseline.steps.length || !Array.isArray(snapshot.seen)
    || !['active','succeeded','failed','blocked','cancelled','unknown'].includes(snapshot.status)) throw new Error('invalid_snapshot');
  const seenIds = new Set();
  for (const e of snapshot.seen) {
    if (!record(e) || !text(e.id) || seenIds.has(e.id) || !/^[a-f0-9]{64}$/.test(e.signature))
      throw new Error('invalid_snapshot');
    seenIds.add(e.id);
  }
  const statuses = ['pending','waiting_user','running','succeeded','failed','blocked','cancelled','unknown'];
  for (const [i, s] of snapshot.steps.entries()) {
    const b = baseline.steps[i];
    if (!record(s) || s.id !== b.id || s.attempt !== 1 || s.requiresApproval !== b.requiresApproval
      || digest(s.dependsOn) !== digest(b.dependsOn) || !statuses.includes(s.status)) throw new Error('invalid_snapshot');
    if (s.requestHash !== null && !text(s.requestHash)) throw new Error('invalid_snapshot');
    if (!s.requiresApproval && s.status === 'pending' && s.requestHash !== null) throw new Error('invalid_snapshot');
    if (['running','succeeded','failed','unknown','waiting_user'].includes(s.status) && !text(s.requestHash))
      throw new Error('invalid_snapshot');
    if (s.status === 'succeeded' && !Object.hasOwn(s, 'value')) throw new Error('invalid_snapshot');
    if (s.status === 'failed' && !text(s.code)) throw new Error('invalid_snapshot');
    if (!s.requiresApproval && (s.approval !== null || ['waiting_user','blocked'].includes(s.status)))
      throw new Error('invalid_snapshot');
    if (s.requiresApproval) {
      const a = s.approval;
      if (a === null) {
        if (s.requestHash !== null || !['pending','cancelled'].includes(s.status)) throw new Error('invalid_snapshot');
      } else {
        if (!record(a) || !text(a.requestId) || !Number.isFinite(a.expiresAt)
          || !['waiting','approved','deny','timeout','revoked'].includes(a.decision)
          || typeof a.consumed !== 'boolean' || !text(s.requestHash)) throw new Error('invalid_snapshot');
        if (s.status === 'pending' && (a.decision !== 'approved' || a.consumed)) throw new Error('invalid_snapshot');
        if (s.status === 'waiting_user' && (a.decision !== 'waiting' || a.consumed)) throw new Error('invalid_snapshot');
        if (['running','succeeded','failed','unknown'].includes(s.status) && (a.decision !== 'approved' || !a.consumed))
          throw new Error('invalid_snapshot');
        if (s.status === 'blocked' && (!['deny','timeout','revoked'].includes(a.decision) || a.consumed))
          throw new Error('invalid_snapshot');
      }
    }
    if (['running','succeeded','failed','unknown'].includes(s.status)
      && !s.dependsOn.every(id => snapshot.steps.find(item => item.id === id)?.status === 'succeeded'))
      throw new Error('invalid_snapshot');
  }
  const allDone = snapshot.steps.every(s => s.status === 'succeeded');
  if ((snapshot.status === 'succeeded') !== allDone
    || (snapshot.status === 'active' && snapshot.steps.some(s => ['failed','blocked','cancelled','unknown'].includes(s.status)))
    || (['failed','blocked','cancelled','unknown'].includes(snapshot.status)
      && !snapshot.steps.some(s => s.status === snapshot.status))) throw new Error('invalid_snapshot');
  const state = copy(snapshot);
  for (const step of state.steps) if (step.status === 'running') { step.status = 'unknown'; state.status = 'unknown'; }
  return state;
}
