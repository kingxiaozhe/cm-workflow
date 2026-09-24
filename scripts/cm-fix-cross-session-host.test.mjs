import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {fixHostContexts, validateCauseReviewer, MAX_FIX_JOINED_HOSTS} from '../runtime/js/cm-fix/cause-invocation.mjs';
import {validateReviewDispatchGrant} from '../runtime/js/cm-ai/durable-runner-state.mjs';
import {digest} from '../runtime/js/cm-ai/effect-contract.mjs';

const DURABLE = '01a0bfd9-e7c3-7fa2-9808-206649615754';
const LIVE = '01a0c2b5-c2e2-7af1-8831-d6702c9a0d16';
const reviewer = {reviewerId: 'fix-cause-reviewer', adapterId: 'codex-cause-review-adapter', provider: 'codex',
  requestedModel: 'gpt-6-astra', contextId: 'fix-cause-review-context', excludedThreadIds: []};

// Sessions that joined in between sit after the durable one, and the live one on
// top; the whole list stays bounded so it cannot grow without limit.
const joined = Array.from({length: MAX_FIX_JOINED_HOSTS}, (_, index) => `joined-${index + 1}`);
test('the durable host always comes first and later ones are optional but bounded', () => {
  assert.deepEqual(fixHostContexts({hostContextId: DURABLE}), [DURABLE]);
  assert.deepEqual(fixHostContexts({hostContextId: DURABLE, hostContextIds: [DURABLE, LIVE]}), [DURABLE, LIVE]);
  assert.deepEqual(fixHostContexts({hostContextId: DURABLE, hostContextIds: [DURABLE, 'joined-1', LIVE]}),
    [DURABLE, 'joined-1', LIVE]);
  assert.deepEqual(fixHostContexts({hostContextId: DURABLE, hostContextIds: [DURABLE, ...joined, LIVE]}),
    [DURABLE, ...joined, LIVE]);
  // The resumed session can never displace the session the run is bound to.
  // A malformed id is refused by the shared id() validator, a malformed set by
  // this function's own bound; both are refusals, so accept either code.
  const refused = error => ['invalid_host_context', 'invalid_input'].includes(error.code);
  for (const hosts of [[LIVE, DURABLE], [LIVE], [DURABLE, DURABLE], [DURABLE, ...joined, LIVE, 'one-too-many'], [],
    [DURABLE, LIVE, DURABLE],
    [DURABLE, ''], [DURABLE, null], 'not-an-array'])
    assert.throws(() => fixHostContexts({hostContextId: DURABLE, hostContextIds: hosts}),
      refused, JSON.stringify(hosts));
});

test('a resumed session is a host, so it cannot also be the reviewer', () => {
  assert.deepEqual(validateCauseReviewer(reviewer, [DURABLE, LIVE]), reviewer);
  for (const host of [DURABLE, LIVE])
    assert.throws(() => validateCauseReviewer({...reviewer, contextId: host}, [DURABLE, LIVE]),
      {code: 'invalid_cause_reviewer'}, host);
  // Excluding a host does not launder it into an acceptable reviewer either.
  assert.throws(() => validateCauseReviewer({...reviewer, contextId: LIVE, excludedThreadIds: [LIVE]},
    [DURABLE, LIVE]), {code: 'invalid_cause_reviewer'});
  // Every joined session is a host as well, not only the first and the live one.
  assert.throws(() => validateCauseReviewer({...reviewer, contextId: 'joined-1'}, [DURABLE, 'joined-1', LIVE]),
    {code: 'invalid_cause_reviewer'});
  assert.throws(() => validateCauseReviewer(reviewer, [DURABLE, ...joined, LIVE, 'one-too-many']),
    {code: 'invalid_cause_reviewer'});
});

// This is the claim the whole change rests on: the live session signs new grants
// while the durable session's old grants still replay. Neither may be widened
// into accepting a host the run never had.
test('a grant signed by either host is accepted and a third host is not', () => {
  const request = {identity: {repositoryId: 'wue', runId: 'r', taskId: 'T-001', attempt: 1},
    invocationId: 'invocation-1', requestDigest: digest({request: 1}), contextId: reviewer.contextId};
  const issuedAt = 1_700_000_000_000;
  const grantFor = hostContextId => {
    const body = {version: 1, kind: 'cm-review-dispatch-grant', grantId: 'grant-1',
      adapterId: reviewer.adapterId, invocationId: request.invocationId, requestDigest: request.requestDigest,
      identity: request.identity, reviewerId: reviewer.reviewerId, logicalContextId: request.contextId,
      packageDigest: digest({pkg: 1}), hostContextId, decisionId: 'decision-1', decision: 'approved',
      issuedAt, expiresAt: issuedAt + 60000};
    return {...body, grantDigest: digest(body)};
  };
  const expected = {request, reviewerId: reviewer.reviewerId, adapterId: reviewer.adapterId,
    packageDigest: digest({pkg: 1}), hostContextIds: [DURABLE, LIVE],
    authorizationAt: issuedAt, registeredAt: issuedAt + 1};
  for (const host of [DURABLE, LIVE])
    assert.equal(validateReviewDispatchGrant(grantFor(host), expected).hostContextId, host);
  assert.throws(() => validateReviewDispatchGrant(grantFor('01a0c2b5-0000-0000-0000-000000000000'), expected),
    {code: 'runner_grant'});
  // A single-host run keeps refusing the session that never owned it.
  assert.throws(() => validateReviewDispatchGrant(grantFor(LIVE), {...expected, hostContextIds: [DURABLE]}),
    {code: 'runner_grant'});
});

// The flag exists so a new session can declare the old one. It must not become a
// way to plant an arbitrary host onto a run being created.
test('--original-host-context is refused when creating a run', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-fix-cross-')));
  try {
    const cwd = path.join(root, 'code');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value=1;');
    const config = path.join(root, 'controls.json');
    fs.writeFileSync(config, JSON.stringify({specsRoot: null, identity: {repositoryId: 'fixture',
      runId: 'cross-session', taskId: 'T-FIX-cross', attempt: 1}, defect: 'Synthetic defect for the flag check',
      reproduction: {cwd, command: [process.execPath, '-e', "process.stderr.write('BUG');process.exit(3)"],
        expectedFailure: {exitCode: 3, outputIncludes: 'BUG'}, timeoutMs: 5000}}));
    const host = fileURLToPathname(new URL('./cm-fix-host.mjs', import.meta.url));
    const run = extra => {
      try {
        return execFileSync(process.execPath, [host, 'serve', '--config', config, ...extra],
          {input: '', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']});
      } catch (error) { return `${error.stdout ?? ''}${error.stderr ?? ''}`; }
    };
    assert.match(run(['--mode', 'create', '--host-context', LIVE, '--allow-reproduction',
      '--original-host-context', DURABLE]), /fix_original_host_context_unavailable/);
    // Creating without it gets past that refusal, which is what proves the refusal is
    // the flag and not the rest of the launch. How far past depends on the host: the
    // durable store needs Node >= 24.14, and CI validates on 22, where the platform
    // gate stops the launch later in openFixExecution. Either outcome clears the flag
    // check above it; only fix_original_host_context_unavailable would not.
    assert.match(run(['--mode', 'create', '--host-context', LIVE, '--allow-reproduction']),
      /host_ready|unsupported_platform/);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

function fileURLToPathname(url) { return decodeURIComponent(url.pathname); }
