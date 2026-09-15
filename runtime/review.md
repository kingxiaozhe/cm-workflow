# CM independent-review contract for Codex

Every implementation task requires an independent review before it can be marked complete. The reviewer must not inherit the author's reasoning narrative.

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

## Channel order

1. `codex-subagent`: spawn a fresh reviewer/subagent with the runtime's no-history/fresh-context option (for example `fork_turns: none`) and provide only the review package. Ask for concrete failure scenarios, ordered by severity, and require an explicit zero-findings result when applicable.
2. `codex-cli`: if subagents are unavailable, run `codex review` only when the task changes are isolated from unrelated dirty work (clean pre-task tree or isolated worktree/commit).
3. Neither independent path is safe: pause new implementation or leave existing work pending review. `self-degraded` is diagnostic only; it cannot authorize N5 or successful completion, even if its legacy verdict says `approved`.

Do not wait for two degraded tasks or limit this pause to high-risk work. Channel
unavailability is not a code finding or an implementation review round; record
the actual channel failure without inventing a verdict. Do not switch reviewers
to erase a valid blocking finding.

The shared-JS target supports a fresh reviewer on whichever provider is available.
The shared V3 runner now also accepts Claude-bound normalized review invocations,
using the same grant, registration, independent identity, replay and completion checks.
Its registered result is published as `claude-cli`, never relabeled as Codex.
The single-task host connects the Claude worker only with a matching diagnostic and
separately authorized attempt. Claude preflight uses a macOS loopback-only sandbox,
synthetic credentials and a rejecting local sink; it does not obtain a model review.
The producer permits one empty startup health probe and rejects model requests locally.
Installed CLI has passed this local request-surface probe. It uses the same bounded temporary
directory for CLAUDE_CODE_TMPDIR and stops after the first valid message request. Probe-induced
termination is not user cancellation or a successful review; real model review remains unverified.
Do not handcraft a passing diagnostic or approval to bypass readiness evidence.

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
verdict 至少为 1。`self-degraded` 必须写 `independent: false` 并增加非空的
`degraded_reason`；其他独立通道只有在新上下文中实际执行时才可写 `true`。
`handoff_sha256` 将结论绑定到本轮 handoff 内容；handoff 改动后必须重新审查。
新 handoff 还必须包含 `implementation_sha256`，并让 N4/N5 使用
`--project-root` 复算；否则文件内容在审查后变化时无法进入 N5。历史恢复显式使用
`--allow-legacy-unbound` 时不属于内容绑定审查，必须在证据中披露。
历史 `self-degraded` 可读取和审计，但不得据此授权新完成或补造独立审查。
声明字段和 handoff 哈希不证明 reviewer 实际执行或代码快照未变；主执行者仍须
核对真实通道、任务增量及验证证据，不把当前声明门禁当成完整执行凭据机制。

No matching evidence file means review did not happen. File existence alone is
not approval: the completion node must run the `cm-task-gate.py mark-done` lock
adapter, which delegates the decision and replacement to `cm-task-gate.mjs` and
revalidates the current attempt's `verdict: approved` and `independent: true` while atomically updating
the exact task checkbox.
