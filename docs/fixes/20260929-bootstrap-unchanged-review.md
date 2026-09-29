# Bootstrap rule refresh with an unchanged target

Status: regression passing; independent review approved.

## Reproduction and cause

A later bootstrap task refreshed five of six fixed instruction files. `init_generate`, `init_verify`, and both task checks passed; the sixth file was byte-identical to its input. The handoff correctly listed five `changed_files`, but `validateBootstrapReviewPackage` required all six target paths in `pkg.changes`. The initial regression test failed with `bootstrap_review_mismatch` before the fix.

The package contract records actual differences in `changes` and the remaining selected files in `unchangedScope`. The task had already persisted its write evidence, checks, and handoff before package validation, so the old generic failure path checkpointed `unknown/execution_error` with no reviewable package. Re-dispatching development would discard the original review baseline for the five written files.

## Repair

- Validate changed targets against their final SHA and unchanged targets against `unchangedScope` and its SHA. Attempt 1 also checks the write's before SHA; attempt 2 may start from attempt 1's artifact or restore the original baseline.
- Classify a new `bootstrap_review_mismatch` as `blocked` with a recovery hint.
- Add a one-use, resume-only `bootstrap_review_recover` operation. It accepts only a completed bootstrap develop checkpoint with a successful developer call, retained passing checks, write evidence, and no pending effect or package. It verifies the final files, Learning handoff, changed-file set, implementation digest, and reconstructed package before appending a replayable recovery record and moving the original run to `awaiting_review`. It does not run a developer, checks, or reviewer.
- Expose the operation through the host and standard single-step driver with an explicit permission flag and reason. A changed handoff or file is rejected without a journal append.

## Evidence

- Focused red: `scripts/cm-ai-bootstrap-merge.test.mjs` failed on the unchanged target with `bootstrap_review_mismatch` before the validator fix.
- Synthetic end-to-end: a persisted legacy `unknown/execution_error` checkpoint recovered to the same package digest, then independently reviewed and completed with no second developer call. A deliberately mismatched handoff was rejected without appending.
- CI-collected tests: `scripts/cm-ai-bootstrap-merge.test.mjs`, `scripts/cm-bootstrap-review-recovery.test.mjs`, and `scripts/cm-ai-drive.test.mjs`.
- Additional bootstrap fixture: `scripts/cm-ai-bootstrap.test.mjs` covers the same-feature refresh, attempt-2 retries, and fail-closed recovery.
- Independent review: `docs/fixes/.reviews/20260929-bootstrap-unchanged-review-r1.md` (approved after two findings were fixed).

The observed external run remains untouched while its host configuration and writer state are checked. Recovery must resume its original run ID and keep its existing handoff; do not supersede it while the five rule changes are unreviewed.
