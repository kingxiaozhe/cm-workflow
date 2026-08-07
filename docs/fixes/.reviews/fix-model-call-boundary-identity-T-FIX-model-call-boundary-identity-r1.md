---
at: 2026-08-07T00:02:49-07:00
reviewer: self-degraded
independent: false
degraded_reason: fresh codex-cli review started in an isolated repository but the account weekly limit was 100 percent; subagent delegation was not authorized for this task
task: T-FIX-model-call-boundary-identity
attempt: 1
round: 1
verdict: changes_requested
blocking_findings: 4
handoff: fix-model-call-boundary-identity-T-FIX-model-call-boundary-identity-a1-handoff.json
handoff_sha256: 27dd0d380030d27dda39dc4754b1199283c7872693dfd57b2fccf124f448ea3a
scope:
  - .claude/rules/security.md
  - .claude/rules/testing.md
  - .omx/logs/execution-ledger.md
  - .omx/plans/model-usage-adapter.md
  - README.md
  - docs/fixes/20260806-model-call-boundary-identity.md
  - runtime/logging.md
  - runtime/model-efficiency.md
  - scripts/cm-log-event.py
  - scripts/cm-openai-compatible-call.py
  - scripts/cm-usage-report.py
  - scripts/test-cm-openai-compatible-call.py
  - scripts/test-cm-usage-report.py
---

Verdict: changes requested. This is a self-degraded review, not an independent
review.

Blocking findings:

1. The handoff listed only 13 paths and bound the review to the handoff JSON SHA,
   not to the implementation bytes. Additional current changes were outside the
   review scope, and an implementation file could change after review without
   invalidating N5. Red fixture: `cm-task-gate.py hash-implementation` was an
   unknown command and an unbound handoff remained eligible for N4/N5.
2. A bundled `openai-compatible` `model_usage` event could be written without a
   preceding claim, then counted as verified usage. Red fixture observed one call
   and 999 input tokens from a claimless managed completion.
3. The provider could return successfully and log `outcome: success`, after which
   writing the model result to stdout raised an unhandled `BrokenPipeError`. The
   process traceback and success usage contradicted each other.
4. Configuration accepted `reviewer.adapter: openai-compatible`, but N4 recognizes
   only `codex-subagent`, `codex-cli`, or `self-degraded` review evidence. The API
   call therefore spent tokens without being able to satisfy the review gate.

Required correction: bind each new handoff to the exact changed-file contents,
reject claimless managed usage in both writer and reporter, make stdout delivery
part of the adapter outcome boundary, and reject the unsupported managed reviewer
route before any call. A complete attempt-2 handoff must cover the entire landing
scope and rerun all focused and repository gates.
