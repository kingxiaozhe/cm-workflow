# CM independent-review contract for Codex

Every implementation task requires an independent review before it can be marked complete. The reviewer must not inherit the author's reasoning narrative.

CM 门禁检查来源声明的格式、任务与轮次、材料摘要、当前文件和执行记录的一致性，用于防手滑与过期证据。来源声明不验证审查者身份或实际人工交互；门禁不承诺抵抗拥有完整文件写权限和 shell 能力的会话造假。fresh 上下文、审查结果、检查通过和完成复查仍是正常工作流路径的完成条件。发布、部署、资金及其他范围外动作继续遵守其单独确认要求。

N4 accepts only a `ready_for_review` implementation handoff validated through
`runtime/task-gates.md`. The handoff is author evidence, never an approval. The
review file owns the disposition that controls whether N3 retries or N5 may mark
the task complete.

External-expert consultations follow `runtime/external-expert.md`. Their
requests, responses, and adjudication belong under `.external/`, not the
task-review filename domain. Version 1 external-expert evidence never satisfies
this independent-review contract. A conversation that contributed to the plan,
diagnosis, tests, or patch is an authoring channel and cannot review the same
work independently.

When a project configures a `reviewer` role, resolve it through
`runtime/workflow-routing.md` before selecting the review channel. Record the
requested adapter/model alias and `route_state` as decision metadata only.
`cli-dispatch` proves a process was created, not a successful independent review.
`declared-adapter` is not proof that a second backend reviewed the diff; the
fresh-context and independence rules below still apply.
`managed-adapter` identifies a callable boundary, not proof that a call occurred.
Only a matching `model_usage` event proves the observed call outcome, and its
text response remains advisory unless materialized through an accepted N4
channel and evidence schema below; the adapter call alone never marks approval.
Project configuration therefore rejects `openai-compatible` for `reviewer` in
version 1 instead of spending Tokens on a result that cannot satisfy N4.

## Review package

Package transport also follows `runtime/model-efficiency.md`: keep the stable
review instructions separate from this task's dynamic evidence and request a
findings-first compact result. The minimum evidence below is never removed to
save tokens.

At task start, record the existing working-tree status and the task's intended file scope. After implementation, build a task-scoped package containing:

- the diff for files changed by this task only;
- full content for new files when the diff does not carry enough context;
- relevant requirements, acceptance criteria, design contracts, and project rules;
- verification output, including new or changed tests;
- the pre-task dirty-file list so unrelated user changes are visible as exclusions.

Do not send the whole working tree merely because it is convenient.

New `cm-review-package` version 1 packages include `unchangedScope`: sorted `{path, sha256}` entries for existing, unchanged scope files, bound into `packageDigest` without adding their bodies. These paths belong in `examinedPaths` and may receive evidence-backed findings, but must not be used to require changes to unchanged files or infer contents from hashes. Entries for files added by a recorded scope revision instead carry the full file record, contents included, and may be examined normally. Legacy packages without this field retain their original digest, path set and receipt verification.

New cm-ai runs additionally bind `specification` into the baseline, developer request and `packageDigest`: feature, task description/verification, all acceptance criteria, design excerpt (up to 64 KiB UTF-8, `truncated:true` above that), task-related test cases and approved source hashes. Review implementation against these ACs and interface contracts. Source paths are relative to the specs root, not writable code scope or extra examinedPaths. Hashes use the existing manifest normalization for runtime task/AC checkboxes. Missing optional test-cases.json yields an empty list and three sources. Live source/approval drift blocks as `spec_drift`, including reapproval of a different contract during a run; material is never silently refreshed. Historical baselines/packages without specification retain their original digest and receipt/completion rules. (Dogfood: separate specs/code roots previously hid the task and interface contracts from both developer and reviewer.)

## Channel order

1. `codex-subagent`: spawn a fresh reviewer/subagent with the runtime's no-history/fresh-context option (for example `fork_turns: none`) and provide only the review package. Ask for concrete failure scenarios, ordered by severity, and require an explicit zero-findings result when applicable.
2. `codex-cli`: if subagents are unavailable, run `codex review` only when the task changes are isolated from unrelated dirty work (clean pre-task tree or isolated worktree/commit).
3. `claude-cli`: when selected by the project declaration, the protected host must actually spawn a fresh Claude reviewer and recover its registered V3 receipt before recording `independent: true`. A two-provider declaration requires coder and reviewer on different providers; a single-provider declaration uses a fresh context on that provider.
4. The selected independent path is unavailable: pause new implementation or leave existing work pending review. `self-degraded` is diagnostic only; it cannot authorize N5 or successful completion, even if its legacy verdict says `approved`.

Do not wait for two degraded tasks or limit this pause to high-risk work. Channel
unavailability is not a code finding or an implementation review round; record
the actual channel failure without inventing a verdict. Do not switch reviewers
to erase a valid blocking finding.

The shared-JS target supports a fresh reviewer on whichever provider is available.
The shared V3 runner now also accepts Claude-bound normalized review invocations,
using the same request/package binding, registration, reviewer source declarations, replay and completion checks.
cm-ai uses the `host-review` source channel; cm-fix retains its existing
`host-authorized` contract. A cm-ai journal with old grant-channel invocations is
rejected as `runner_invocation`; preserve it and use the original version's
read-only tools to inspect history. This entry does not replay or migrate those
invocations.
Its registered result is published as `claude-cli`, never relabeled as Codex.
The single-task host connects the Claude worker only with a matching diagnostic and
the active control contract: cm-ai advances ordinary review rounds directly within
the confirmed scope, for both existing and new runs. Requests and receipts bind
the actual invocation, package and execution records to detect stale or mismatched
materials. Claude preflight uses a macOS loopback-only sandbox,
synthetic credentials and a rejecting local sink; it does not obtain a model review.
The producer permits one empty startup health probe and rejects model requests locally.
Installed CLI has passed this local request-surface probe. It uses the same bounded temporary
directory for CLAUDE_CODE_TMPDIR and stops after the first valid message request. Probe-induced
termination is not user cancellation or a successful review; real model review remains unverified.
Do not handcraft a passing diagnostic or approval to bypass readiness evidence.
Claude review streams accept `system/api_retry`, `hook_started`, `hook_response` and `commands_changed` only as `onNotice` summaries, sharing a 32-notice limit with `rate_limit_event`; they never enter observation or advance the verdict stage, and unknown system subtypes still fail closed (2026-09-17 dogfood: a transient API retry was misclassified as `unexpected_event`).
`system/ui_invalidate` is a fixed, body-free notice before or after `init`, as is
the existing `dev_intent` startup notice. Both bind the session and share the
same 32 slots; neither initializes a turn nor supplies a verdict. Missing init,
cross-session messages, unknown subtypes and post-terminal messages still fail.
The local probe still requires a compliant `/v1/messages` request; startup
health checks alone cannot pass (Claude Code 2.1.289 startup regression).
Claude probe model IDs are matched exactly against the outgoing request. Use
the full model ID when a CLI alias resolves to a different ID; a health response
or a mismatched model must not be converted into a passing diagnostic.
`system/thinking_tokens` has a separate 4096-event budget and remains subject to the worker's total 1,000,000-byte output cap; it emits no observation or notice and never advances the verdict stage (2026-09-17 dogfood: an 88-heartbeat review exceeded the former 64-event cap). The 4097th heartbeat fails with `unexpected_event`; output overflow retains `output_limit`.

## Review scope

Review correctness, edge cases, error handling, security, performance regressions, contract compliance, and the tests themselves. Reject placebo tests, implementation-detail assertions that miss behavior, and tests whose inputs share the same hidden premise as the implementation. The `scope` list must include every project-relative path in the handoff's `changed_files`; the review body must contain the actual findings or an explicit zero-findings conclusion.

Only report findings with a plausible input/state and an incorrect outcome. Style-only preferences do not block completion unless they conceal a defect or violate an explicit project rule.

## Rounds and disposition

The rules in this section apply to N4 reviews of implemented task diffs. **cm-prd Step 9.5/10.6 固定为一次审查调用**：它们是实现前的建议性审查，只复用独立通道、
findings-first 纪律和 `reviewer/independent/at/scope` 四个证据字段，不进入 N3/N4 的 attempt/review 重试协议。主执行者采纳
findings 后运行对应规格自检；未解决项进入摘要卡由人审，不得召回同一或新的 reviewer
生成 PRD `r2` 凭证。
两阶段必须用 `scripts/cm-prd-review-gate.py` 保存 disposition 回执：r1 已存在但回执
缺失时只恢复 finding 处置，不得重新调用 reviewer；回执完成后不得重审。任何 r2 文件
或 r1 内容哈希漂移都由门禁阻断。
PRD artifact 回执先比对原始字节，仅 Markdown 中 `tasks.md` 的任务、`requirements.md` 的 AC 运行期 `[x]`/`[X]` 可复用规格清单规则规范化为 `[ ]` 后匹配；代码块、其他正文与 JSON 仍精确比对。
命中时只读返回 `runtimeMarksNormalized:true`，经摘要 `reviews[stage].gate` 透传；当前草稿处置与摘要发布快照仍绑定原始字节（2026-09-17 真实项目 dogfood：已开发 specs 目录新增 feature 时摘要被历史 `[x]` 阻断）。

- Maximum two review rounds per task.
- Round 1 `changes_requested` returns to N3 and produces attempt 2 plus a new
  handoff. Round 2 cannot create attempt 3.
- Accepted findings are fixed and re-reviewed against the new attempt handoff.
- Rejected findings record a short evidence-based reason.
- Only independent `approved` permits N5; `changes_requested` permits only the next attempt;
  `blocked` permits neither N3 auto-retry nor N5.
- After round two, any remaining blocking finding becomes `blocked`. Safety or
  data-correctness disputes require human resolution; preference disputes may
  proceed only when the reviewer records `approved` and the disagreement is
  preserved in `LESSONS.md`.

A concrete local correction after the user confirms its scope may use the
one-shot task-gate entrance in `docs/human-correction.md`. It preserves the original
reports, records the correction reason and bound source declaration, seals a fresh
independent correction review, and does not reopen a host journal or reset ordinary
attempts. The record reports the supplied decision source; it does not create approval.

A separate version-two taskgate protocol, `cm-controlled-correction`, is one-shot
(`version:2`, `continuation:1`), described in `docs/cm-control-policy-v2.md`.
It supports only compatibility taskgate tasks without JS ownership. A retained
JS journal, JS run or unknown ownership evidence blocks the compatibility writer
and must be rejected before correction preparation. Do not delete that evidence
or hand-edit ownership to enter this protocol. It
records the concrete correction decision as provenance-only `operator` or `model`,
without claiming human authentication or approval. It keeps the original blocked
round-two report and every blocking finding, including P2, as immutable history.
Finalize the actual in-scope revision, relevant checks and Learning/handoff first;
then review the complete revised package through a fresh independent channel.
Only approved, zero-blocking evidence bound to the correction record, final
handoff and current implementation can enter the existing N4/N5 completion gate.
Its v2 correction review body is strict raw JSON with exactly `conclusion`,
`findings`, and `resolved_findings`. Each finding has exactly `id`, `priority`
(P0-P3), and nonempty `evidence`; ids are unique across both arrays. Active
`findings.length` equals the header's `blocking_findings`. Approved requires
`conclusion: "Zero findings."` and an empty active findings array; other verdicts
require `"Blocking findings."`. Fixed historical P2 belongs only in
`resolved_findings`. A zero-findings phrase cannot hide a remaining P2, extra prose
or a mismatched count. This structured-body rule does not change legacy human
correction review bodies.
This slice connects only owner-free compatibility taskgate correction evidence
and the exact task checkbox. cm-ai v2 single-task and batch round-two runs remain
formally blocked; no runner-owned correction completion entrance exists. Even
prepared/published taskgate evidence cannot complete a JS-owned run. No original
batch restoration, N6/N7/N8 advance or `run_done` follows this compatibility
protocol. Do not hand-edit journal or batch state to claim workflow completion.
It is not attempt 3, does not reset a host journal, and cannot coexist with the
legacy human continuation. Source labels, model output and V3 grants do not expand
real conversation authorization, code scope, external sends, Git/push, publication,
deployment or financial permissions. Safety/data-correctness disputes that need
a human decision still require that decision; unavailable review capacity remains
pending, never self-approved.

At any stage, changing reviewed code, tests, or execution instructions invalidates
approval for the changed content. N5 may record improvement suggestions, not make
new implementation changes while writing lessons. After mark-done, preserve the
old task/evidence and pause for an explicitly authorized correction; do not
automatically reopen tasks or create a new task/run to reset the two-round limit.

## Evidence file

Write each raw result to `{SPECS_DIR}/.reviews/{feature}-{task}-r{round}.md` with this header:

```yaml
---
at: <ISO-8601 with timezone>
reviewer: codex-subagent | codex-cli | claude-cli | self-degraded
independent: true | false
task: <T-xxx>
attempt: <1 or 2>
round: <1 or 2>
verdict: approved | changes_requested | blocked
blocking_findings: <non-negative integer; approved requires 0>
handoff: <feature>-<task>-a<attempt>-handoff.json
handoff_sha256: <lowercase SHA-256 from check-n4 output>
scope:
  - <reviewed file>
---
```

`attempt` 必须等于 `round`。`approved` 必须写 `blocking_findings: 0`，其他
verdict 至少为 1。`reviewer` 只能原样写上面四个值之一，不加括号、模型或其他说明；模型、推理强度等写进正文。`approved` 的正文必须有一整行只写零阻塞结论：可选「结论：」或 `Conclusion:`，加一个认可说法，可选句号，前面可带列表符或加粗，例如单独一行「结论：零阻塞发现。」。句中提及、问句、否定、引用行（`>`）和代码围栏内的行都不算。认可的说法（不区分大小写）：零发现、零阻塞发现、零阻断发现、无阻塞发现、无阻断发现、未发现阻塞、未发现阻断、zero findings、no findings、no blocking findings（清单见 `runtime/js/review-findings.mjs`）。正文整段是带 `conclusion` 字段的 JSON 时（受控补正），该字段本身必须是这样一行。头部 `at` 早于 2026-10-21T00:00:00Z 的历史凭证按启用前的判定读取（正文任意位置出现原有说法即可），新增说法不回溯；改写 `at` 只能退回旧判定，不会比旧规则更松。
手写 Markdown 凭证时，凭证由审查方按本模板完整产出（含头部），主执行者只原样保存到上述路径，不改写其中任何字段或措辞。门禁因格式拒绝时，把报错原文交回审查方重新产出；主执行者自行修改审查结论等于自我批准，不允许。JS 宿主或驾驶员依据已登记、已绑定的审查结果确定性生成凭证（如 `host-review-file.mjs`、`cm-refactor` 驾驶员）不在此列；但主执行者同样不得改动其中的审查结论、来源声明或计数。`self-degraded` 必须写 `independent: false` 并增加非空的
`degraded_reason`；其他独立通道只有在新上下文中实际执行时才可写 `true`。
`handoff_sha256` 将结论绑定到本轮 handoff 内容；handoff 改动后必须重新审查。
新 handoff 还必须包含 `implementation_sha256`，并让 N4/N5 使用
`--project-root` 复算；否则文件内容在审查后变化时无法进入 N5。历史恢复显式使用
`--allow-legacy-unbound` 时不属于内容绑定审查，必须在证据中披露。
历史 `self-degraded` 可读取和审计，但不得据此授权新完成或补造独立审查。
`reviewer` 与 `independent` 是审查来源声明；`decision_source` 若由相应入口记录，也仅表示决定来源。字段和摘要用于核对本轮材料与执行记录的一致性。主执行者仍按正常工作流取得 fresh 审查、核对任务增量及验证证据。

No matching evidence file means review did not happen. File existence alone is
not approval: the completion node must run the `cm-task-gate.py mark-done` lock
adapter, which delegates the decision and replacement to `cm-task-gate.mjs` and
revalidates the current attempt's `verdict: approved` and `independent: true` while atomically updating
the exact task checkbox.
