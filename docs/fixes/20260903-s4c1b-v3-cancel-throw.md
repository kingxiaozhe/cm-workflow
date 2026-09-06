# S4-C1b-V3 authorization cancel-then-throw

Status: fixed and independently approved. Accepted replacement review task:
`T-FIX-cancel-throw-v2`.

## Symptom

A trusted V3 reviewer authorization callback may call `runner.cancel()` and then
throw. The cancel control is durably written and adapter dispatch is avoided, but
the catch path changes the terminal state to `unknown/authorization_invalid`.
Checkpoint validation then cannot persist the cancel/non-cancelled mismatch, so
recovery degrades to `unknown/reconciliation_required`.

## Reproduction

Command:

```bash
node --test experiments/js-orchestration/review-invocation-v3.test.mjs
```

Pre-fix result on 2026-09-03: exit 1, 30 tests, 29 passed, 1 failed. The sole
failure was `V3 cancellation inside authorize remains durable when the callback
throws`, where actual `end.state` was `unknown` and expected was `cancelled`.

## Root cause

`runner.cancel()` persists the authoritative `control` record and sets the shared
controller/state to cancelled. The exceptional exit from `authorize` then calls
`halt('unknown', ...)` unconditionally, replacing the causally established terminal
state before the effect checkpoint is written.

## Repair decision

In the existing authorization catch, return immediately when state is already
cancelled or the shared controller is aborted. Otherwise preserve the existing
authorization-error classification. This is smaller than changing checkpoint
validation or adding another terminal/result variant, and keeps cancellation
causality at the boundary where it is lost.

Rejected alternatives:

- Relaxing checkpoint validation would accept internally contradictory histories.
- Reclassifying every authorization exception as cancellation would invent cancel
  authority when no durable control exists.
- Redesigning V3 or adding a new durable record type is unnecessary.

## Impact and regression scope

Product impact is limited to the reviewer authorization callback's exceptional exit
before registration and dispatch. Regression must cover the focused V3 suite, full
Node orchestration suite, runtime/public/diff/shell gates, unchanged safety findings,
and fresh independent review of the two product-file hashes.

## Learning check

Candidate: reentrant host callbacks must preserve durable cancellation on both normal
and exceptional exits before dispatch. It remains recorded in task evidence rather
than being mixed into the already dirty root `AGENTS.md`, matching the human-approved
two-product-file correction scope.

## Review history

- Independent R1 found zero product-code defects and independently confirmed both the
  cancel-then-throw and ordinary-throw branches. It requested one evidence-envelope
  correction: the installed workflow gate accepted a newer top-level
  `implementation_sha256`, but the source repository's current authoritative schema
  rejects that field.
- Attempt 2 preserves the exact product bytes and moves the combined implementation
  digest into the schema-supported evidence list. No shared schema or gate was widened.

The source repository gate cannot form attempt 2 from an attempt-1 handoff that was
itself schema-invalid. The original handoff, attempted follow-up, and R1 review were
therefore preserved as failed audit evidence. A replacement attempt-1 handoff using
only repository-supported fields passed N4 and received a fresh independent review.

## Result

- Repair: the authorization catch returns immediately when durable cancellation or
  its shared abort signal has already won; ordinary exceptions still become
  `unknown/authorization_invalid`.
- Focused regression: red 29/30 before repair; green 30/30 before and after review.
- Full regression: 964/964 before and after review.
- Other gates: runtime/public/diff/shell passed; public safety retained the exact
  five pre-existing out-of-scope findings, unwaived.
- Independent review:
  `docs/fixes/.reviews/fix-cancel-throw-v2-T-FIX-cancel-throw-v2-r1.md` — approved,
  zero findings. Repository N5 returned `outcome: approved`.
- No provider, install, Git, receipt/completion, F01, real task, or AGENTS write.
