# CM independent-review contract for Codex

Every implementation task requires an independent review before it can be marked complete. The reviewer must not inherit the author's reasoning narrative.

External-expert consultations follow `runtime/external-expert.md`. Their
requests, responses, and adjudication belong under `.external/`, not the
task-review filename domain. Version 1 external-expert evidence never satisfies
this independent-review contract. A conversation that contributed to the plan,
diagnosis, tests, or patch is an authoring channel and cannot review the same
work independently.

## Review package

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
3. `self-degraded`: if neither independent path is safe, perform the full checklist in the main context and label the result degraded. Never describe this as independent review.

The workflow may pause after two consecutive degraded tasks so the user can restore an independent channel.

## Review scope

Review correctness, edge cases, error handling, security, performance regressions, contract compliance, and the tests themselves. Reject placebo tests, implementation-detail assertions that miss behavior, and tests whose inputs share the same hidden premise as the implementation.

Only report findings with a plausible input/state and an incorrect outcome. Style-only preferences do not block completion unless they conceal a defect or violate an explicit project rule.

## Rounds and disposition

- Maximum two review rounds per task.
- Accepted findings are fixed and re-reviewed.
- Rejected findings record a short evidence-based reason.
- After round two, safety or data-correctness disputes require human resolution; preference disputes may proceed with the disagreement recorded in `LESSONS.md`.

## Evidence file

Write each raw result to `{SPECS_DIR}/.reviews/{feature}-{task}-r{round}.md` with this header:

```yaml
---
at: <ISO-8601 with timezone>
reviewer: codex-subagent | codex-cli | self-degraded
independent: true | false
task: <T-xxx>
round: <1 or 2>
scope:
  - <reviewed file>
---
```

`self-degraded` 必须写 `independent: false`；其他两个通道只有在新上下文中执行时才可写 `true`。

No matching evidence file means review did not happen. The completion node must mechanically check for the evidence before updating `tasks.md`.
