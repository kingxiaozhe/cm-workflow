# CM task handoff and review gates

This contract makes the N3 → N4 → N5 boundary mechanically checkable without
creating a second task-state database. `tasks.md` remains the authoritative
business-task state. Handoffs and review files are content-bound evidence under the
existing `{SPECS_DIR}/.reviews/` domain.

## Implementation handoff

For attempt 1 or 2, N3 writes:

```text
{SPECS_DIR}/.reviews/{feature}-{task}-a{attempt}-handoff.json
```

The document follows `runtime/task-handoff.schema.json`. A worker may report only:

- `ready_for_review`: every verification entry is `passed`; `blockers` and
  `scope_deviation` are empty;
- `blocked`: at least one blocker or scope deviation explains why N4 cannot start.

The main agent, not the worker, writes the evidence file after checking the
worker response against the actual diff and command output. A handoff never
marks `tasks.md`, approves a review, writes metrics, or authorizes Git actions.
Project paths use forward-slash, project-relative form so the evidence remains
portable across macOS, Linux, and Windows.

The gate validates declaration consistency; it does not reconstruct a task diff
from an already-dirty or multi-repository working tree. N3 remains responsible
for comparing `changed_files` with the task-scoped diff before writing handoff.

Validate the evidence before N4:

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py check-n4 \
  --handoff {HANDOFF_PATH} \
  --reviews-dir {SPECS_DIR}/.reviews \
  --feature {FEATURE_SLUG} \
  --task {T-xxx}
```

Attempt 2 is valid only when round 1 exists and has
`verdict: changes_requested`. A blocked handoff never enters N4.

## Review disposition

Each review header keeps the existing fields and adds:

```yaml
attempt: 1
verdict: approved | changes_requested | blocked
blocking_findings: 0
handoff: login-T-001-a1-handoff.json
handoff_sha256: <lowercase SHA-256 returned by check-n4>
```

`round` must equal `attempt`. The review scope must cover every `changed_files`
entry and the body must contain findings or an explicit zero-findings result.
`changes_requested` returns to N3 and produces the next attempt. N4 never edits
implementation files. Round 2 cannot create attempt 3: another blocking result
becomes `blocked` and requires human resolution under `runtime/review.md`.

N5 must let the gate validate and update the exact task checkbox in one process:

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py mark-done \
  --handoff {HANDOFF_PATH} \
  --reviews-dir {SPECS_DIR}/.reviews \
  --feature {FEATURE_SLUG} \
  --task {T-xxx} \
  --tasks {SPECS_DIR}/{FEATURE_DIR}/tasks.md
```

Only the review for the same task, attempt, and handoff with
`verdict: approved` and the same handoff SHA-256 passes. For attempt 2, N5 also
revalidates the complete attempt-1 → changes-requested chain. The write is an
atomic same-directory replacement and changes only the exact task checkbox.
`FEATURE_DIR` is the exact numbered directory name (for example `1.login`), while
`FEATURE_SLUG` is the evidence-name slug (`login`). The tasks file must be that
direct feature-local authority; a specs-root or sibling feature file is rejected.
File existence or a separate manual edit is not approval.

## Parallel-write guard

Serial work and parallel read-only work do not need this check. Before two or
more tasks write code concurrently, the main agent declares every assignment:

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py check-parallel-write \
  --repo {CODE_PROJECT} \
  --assignment T-101={WORKTREE_ONE} \
  --assignment T-102={WORKTREE_TWO}
```

Every assignment must resolve to a registered worktree of the same Git
repository, use a distinct path and a distinct non-detached branch, and have a
unique task id. Failure means **run serially**; it never means bypass the guard.
