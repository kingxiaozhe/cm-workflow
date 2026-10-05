# Optional execution optimizations, v1

Enable `--execution-optimizations` on a **new** `cm-ai-host`, `cm-ai-batch-host`, `cm-fix-host` or `cm-prd-host` launch. The matching drivers accept it in `PLAN.permissions`. Existing action permissions, model choices, review grants, round limits and timeouts still apply. No provider is called by the flag itself.

The versioned policy is frozen in the new run configuration. PRD uses a separate v2 session schema; batch has a private `.cm-execution-policy-v1` binding so later members retain the same selection. Recovery reads the original snapshot even if the flag is omitted. Legacy runs remain readable and reject enabling the policy during recovery. QA creates new children with the parent's frozen policy; a legacy child cannot be retrofitted. Removing the flag disables the policy for future runs only. Do not edit snapshots or migrate old runs.

## Checks and full review evidence

An explicit `{id, command, sameExecutionAs}` check may share the immediately preceding check's physical execution when the argv, cwd, timeout and execution controls match in that plan. The source must pass. Both check identities remain in the result and the alias names its source. Identical commands without the annotation execute separately. The next plan, including final acceptance, executes fresh checks. There is no generic cache.

Review presentation stores identical complete file content once in an inline table. UTF-8 conversion must reproduce the exact bytes; other content stays base64. All acceptance criteria, interfaces, system context, checks, findings and handoff content stay in the same prompt. Reviewers still use no tools. The canonical package and digest remain unchanged. If the presentation is larger in actual UTF-8 bytes, the adapter sends the complete original format. Output evidence and existing limits remain authoritative; no truncation or on-demand fetch is introduced.

## Recover a recorded PRD response

Use `repair_review_response` only after examining the original recorded `prd_review` call. Supply `binding: {callId, requestDigest, resultDigest, packageDigest, reason}` with the exact original values and a bounded single-line reason; `resultDigest` is the shared canonical `digest(call.result)`. The driver and host validate before writing. It requires the existing `--allow-review-write` permission. Afterwards `resume` continues the original operation.

The whitelist permits only independent `degradedReason: null` omission and timestamp canonicalization of the exact same instant. Missing timezone, ambiguous timezone, invalid dates and nonzero sub-millisecond precision are refused. Verdict, findings, contexts, independence and original stored response remain unchanged. The projection and original recorded JSON bytes are retained with their binding. Repeating the same repair is idempotent. This records the stored response serialization; it does not claim to preserve network whitespace that was never stored.

UNKNOWN with no original result cannot use this operation or obtain a new provider dispatch. New cm-ai/fix runs require reconciliation against the original registered invocation and owned-process cleanup evidence. Existing budgets and fresh independent contexts govern any later authorized attempt. Adapter-sent settings and observed text do not establish provider-confirmed model selection.

## Official usage and validation

Native Codex/Claude workers capture usage only from validated original CLI terminal events. The existing authoritative logger binds it to the actual invocation claim and deduplicates by that identity. Missing or invalid usage is unavailable. Current-session bridge calls have no invented native usage. Codex cache-read and reasoning counts are subsets, never added to input/output totals; Claude cache fields remain separate components. Optional cache-write and reasoning fields remain unknown when absent. The usage report's `native_components` shows observed and unavailable call counts alongside observed subtotals. Accounting failure cannot retry, complete or alter the workflow.

Codex field mapping follows the [official SDK event contract](https://github.com/openai/codex/blob/main/sdk/typescript/src/events.ts). Actual CLI availability varies by version; the adapter preserves missing fields rather than inferring counts. A terminal's official counters are not a provider-confirmed model receipt.

Run the controlled fixtures with `node --test scripts/cm-efficiency-*.test.mjs`, then the affected host/driver, recovery, worker, review, logger and compatibility regressions. Python usage fixtures are `python3 scripts/test-cm-native-usage.py` and `python3 scripts/test-cm-usage-report.py`. Native sandbox and parallel preflight checks additionally require the existing local environment facilities.

## Offline experiment and rollback

`node scripts/cm-efficiency-offline.mjs` uses fixed synthetic evidence and local checks, verifies exact round-trip preservation and reports actual prompt bytes and physical check executions, including fresh final checks. It makes zero model calls. Bytes are not model tokens, and this experiment establishes no production cost, latency or quality savings. Dynamic recommendations and background monitoring are outside the final feature scope. Live A/B measurement and paid model evaluation require a separately approved budget and protocol.

For a source rollback, restore only this increment's files from the saved pre-edit baseline and remove only its newly added paths. Preserve all earlier user changes. No installation is needed to review or test the source; applying it to an installed plugin is a separate operation. A future-run rollback omits the flag; an already frozen run continues under its original policy and compatible source.
