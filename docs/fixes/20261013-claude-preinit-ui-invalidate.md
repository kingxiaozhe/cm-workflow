# Claude review preflight rejects a display notice before init

## Symptom and reproduction

Claude Code 2.1.289 emits `system/ui_invalidate` before `system/init` during a
local, synthetic review preflight. The old decoder returns `missing_init`; the
worker then stops its own process group. The probe observes only an empty
startup health request and no messages request, so it correctly refuses to pass.
Exit 143 is the cleanup consequence, not evidence of a user cancellation or a
timeout. This probe does not establish the user's account or model access.

## Affected chain and minimal change

`cm-ai-host.mjs preflight` → `previewClaudeTools` → `claudeWorker` →
`createClaudeReviewStream`. The decoder is the first failing edge. It already
accepts a bounded `dev_intent` notice before init. It now accepts the observed
`ui_invalidate` subtype there and after init, reporting only a fixed notice.

The existing session validation and shared 32-notice cap still apply. This
notice cannot initialize a turn or provide a verdict. Missing init, mismatched
sessions, unknown subtypes, post-terminal messages and tool/content violations
remain failures. Probe HTTP checks, sandbox rules, timeouts, arguments,
fingerprints, execution storage and developer parsing are unchanged.

The reproduction also used a short CLI model alias. The CLI resolves aliases
to full model IDs, while the existing probe requires the outgoing model to
equal the configured ID. Live comparisons therefore use the observed full ID;
model equality is not weakened to make the preflight pass.

## Regression evidence

- `cm-claude-review-stream.test.mjs`: pre/post-init notices preserve results and
  observer events; body-free output, session, incomplete/terminal and shared
  budget boundaries remain enforced.
- `cm-claude-worker.test.mjs`: the startup prefix no longer causes premature
  cleanup; no init or a different session cannot produce success.
- `cm-claude-probe.test.mjs`: a local sandboxed child emits the prefix before
  POST, exercising the actual failed ordering. Startup-only requests still fail.

Before the fix, six of the seven selected regression cases failed. After the
fix, all 57 tests in these three files passed. Removing only the pre-init
whitelist entry makes the selected POST regression fail again. Adjacent tests,
independent implementation review and live two-scenario outcomes are retained
in the task's local evidence; those checks are not implied by a preflight pass.

Applied project lessons: provider dialects belong at the adapter boundary;
process termination is not user cancellation; tests must be collected by CI;
real review evidence must precede task completion. 已复盘，无新增项目教训。
