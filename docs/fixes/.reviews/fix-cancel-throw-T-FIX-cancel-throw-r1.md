---
at: 2026-09-03T20:10:01-07:00
reviewer: codex-subagent
independent: true
task: T-FIX-cancel-throw
attempt: 1
round: 1
verdict: changes_requested
blocking_findings: 1
handoff: fix-cancel-throw-T-FIX-cancel-throw-a1-handoff.json
handoff_sha256: d4bbcc592ca9b901b90f03bdeb49523380a5dffba291d32a1b5f85dd384eb7d5
scope:
  - experiments/js-orchestration/review-invocation-v3.test.mjs
  - experiments/js-orchestration/task-runner.mjs
---

# Findings

## P1-01 — the submitted handoff is not accepted by the repository's N4 contract

The handoff contains a top-level `implementation_sha256` field. The authoritative
`runtime/task-handoff.schema.json` does not declare that field, and
`scripts/cm-task-gate.py` requires the handoff's keys to match the schema exactly.
An independent run of the required gate failed:

```text
python3 scripts/cm-task-gate.py check-n4 \
  --task T-FIX-cancel-throw \
  --feature fix-cancel-throw \
  --reviews-dir docs/fixes/.reviews \
  --handoff docs/fixes/.reviews/fix-cancel-throw-T-FIX-cancel-throw-a1-handoff.json

ERROR: handoff has unknown fields: implementation_sha256
```

This is blocking because `runtime/review.md` requires N4 to accept the
`ready_for_review` handoff before independent approval, and N5 reloads the same
handoff through the same strict parser. The field value does equal the delegated
value `e6406c088aef3795145c74c39a644a214da414b9fa44d7260ab85f46f9ec3100`,
and the handoff bytes match the supplied SHA-256
`d4bbcc592ca9b901b90f03bdeb49523380a5dffba291d32a1b5f85dd384eb7d5`,
but neither fact makes an invalid envelope admissible.

Minimum correction: remove the unsupported top-level field. If the task wants to
retain that digest as author evidence, place it in an existing `evidence` string,
which is already schema-supported. Do not widen the shared handoff schema for this
local correction. Regenerate the handoff SHA-256, rerun N4, and request a fresh
independent review bound to the corrected handoff. The current review cannot
authorize N5 after the handoff changes.

# Product-code review

No product-code blocking finding was found in the two-file correction.

The catch in `task-runner.mjs` now checks the already authoritative cancellation
state/signal before classifying an authorization exception. It therefore preserves
durable cancellation without masking a normal exception. It does not change grant
validation, registration, dispatch, durable schema, receipt authority, or completion
authority.

The added test exercises the exact formerly failing sequence and asserts all material
outcomes: terminal `cancelled/cancelled`, zero adapter dispatch, no invocation
diagnostic/registration, durable suffix
`effect-intent -> control -> effect-checkpoint`, and identical reopened state. It is
behavioral rather than an implementation-only assertion.

An independent two-scenario temporary-tree probe used a genuine
`openTaskExecutionStore` and confirmed:

- cancel then throw: zero dispatch, `cancelled/cancelled`, the exact three-record
  suffix, `cancellationRequested:true`, and identical resume;
- plain authorization throw without cancellation: zero dispatch,
  `unknown/authorization_invalid`, no control record,
  `cancellationRequested:false`, and identical resume.

This closes the predecessor P1 without inventing cancellation authority for ordinary
authorization errors.

# Verification

- Product hashes matched the handoff evidence:
  - `experiments/js-orchestration/task-runner.mjs` —
    `9224a6007142f44b1f624cd76bc3848e7441ad97bda03c75ffeae46bf2baf626`
  - `experiments/js-orchestration/review-invocation-v3.test.mjs` —
    `8450d76555adff7dc84b03d873a447f1ef96dd06a05c1c1c2ce5580c9aa20dcb`
- `node --test experiments/js-orchestration/review-invocation-v3.test.mjs` —
  exit 0, **30/30 passed** independently.
- `node --check` on both scoped product files — exit 0.
- `git diff --check` — exit 0.
- The independent adversarial probe above passed both cancellation and non-cancellation
  branches using synthetic temporary files only; no provider, credential, real task,
  installation, or Git action was used.
- Parent-reported full Node result was **964/964 passed**, with runtime/public/diff/
  shell gates passing and the same five pre-existing safety findings. Those broader
  author results were not independently rerun here and do not override the failed N4
  evidence gate.

# Scope and residual risk

The product delta is exactly the authorized catch guard and one regression in the two
declared files. No overdevelopment, dependency, schema change, provider integration,
receipt/completion path, F01 completion, or unrelated cleanup was found.

The unchanged broader V3 limits remain: this is local host-trust fixture evidence,
not remote provenance, real provider authorization, remote cancellation, or
completion authority. The five pre-existing public-safety findings remain outside
this task and unwaived.

# Learning check

The scoped candidate is supported: reentrant host callbacks must preserve durable
cancellation on both normal and exceptional exits before dispatch. The reviewer did
not edit `AGENTS.md`; that file remains outside the human-authorized product scope.

# Verdict and next action

**changes_requested.** The two-file implementation is technically sound, but its
current handoff cannot pass N4 and therefore cannot receive a valid approval. Remove
the unsupported handoff field without changing product code, regenerate and validate
the handoff, then obtain a fresh independent review bound to its new SHA-256. Do not
run N5 or mark the task complete from this evidence.
