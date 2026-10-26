# CM Codex orchestration contract

This contract governs `cm-ai`, `cm-fix`, and `cm-refactor` when they execute work in Codex.

## Sources of truth

- The active feature `tasks.md` is the authoritative business-task state.
- Specs, `.cm-status.json`, `.cm-run.json`, `运行日志.jsonl`, `.reviews/`, `METRICS.md`, and `LESSONS.md` are authoritative audit artifacts.
- Codex plans, subagent threads, and OMX state are disposable mirrors. Rebuild them from disk after a restart; never let them silently reverse a checked task.
- `~/.cm-workflow/logs/` (or `CM_WORKFLOW_LOG_HOME`) is a private,
  reconstructable cross-project mirror. It helps operators inspect many runs,
  but it never overrides the specs-local artifacts.

## Project role routing

An optional project `.cm-workflow.yml`/`.yaml`/`.json` is loaded through
`scripts/cm-workflow-config.mjs`; the shared contract is
`runtime/workflow-routing.md`. The effective role mapping is projected into
`cm-prd`, `cm-ai`, and `cm-test` as requested route metadata and stage
instructions:

- `cm-prd`: `analyst` → analysis, `planner` → design and task split;
- `cm-ai`: `coder` → implementation, `tester` → task checks, `reviewer` → N4;
- `cm-test`: `tester` → logic/commands, `browser_qa` → browser simulation;
- `external_expert`: reasoning-only and still governed by
  `runtime/external-expert.md`.

The route resolver records the requested adapter/model alias without claiming
an unobserved backend model. The bundled `openai-compatible` route is
`managed-adapter`; other unavailable non-local adapters are `declared-adapter`,
not a silent success. Missing configuration keeps the
built-in current-runtime/local-tool defaults. Role routing never changes task
authority, N1–N8 order, N4 independence, or Git permissions.
The project validator rejects `openai-compatible` for `reviewer` until the N4
evidence contract has a real managed-review channel; this prevents an advisory
API call followed by a second gate-eligible review.

At each model-backed role boundary, also apply `runtime/model-efficiency.md`:
send the current role's minimal packet, retain the stable instruction prefix
when the integration supports it, and request the compact role artifact. This
changes context transport only; it does not remove ACs, tests, review evidence,
or approval gates. Usage is logged only by a component that observes the actual
call response.

Only the main agent may update `tasks.md`, audit artifacts, shared status, or Git history. A worker edits only the files assigned to its task and returns a structured handoff. The main agent materializes and validates that evidence under `runtime/task-gates.md`; the worker response itself never advances workflow state.

## Optional external reasoning

CM is `EXPLICIT` by default. When the user asks for an external expert, selects
an external route, or explicitly enables AUTO for the current task, read
`runtime/external-expert.md`. AUTO may choose LOCAL, CONSULT, or VERIFY;
HANDOFF is explicit-only. The external channel may discuss, research, diagnose,
design tests, or critique, but it never becomes a code worker and never receives
workflow write authority. The main agent selects and approves outbound context,
implements accepted suggestions locally, and runs the normal verification.

Version 1 external-expert evidence is advisory and cannot satisfy N4. A global
router cannot silently enable CM AUTO. AUTO is invocation-scoped and never
authorizes local-file content; do not enable it merely because the task is
complex or the external service is already logged in.

## OMX enhancement

At workflow start, detect `omx` with `command -v omx`.

- Available: start or resume the session, inspect `omx hud`, and mirror planned tasks/review status through supported OMX commands.
- Unavailable or unhealthy: report `OMX mirror: unavailable` once and continue from disk in serial mode.

OMX absence is not a reason to skip review, evidence, task marking, QA, or documentation.

## Serial and parallel execution

For a single code root, `cm-ai` plans each feature with `scripts/cm-ai-batch-plan.mjs`: tasks whose approved `tasks.md` scope (`- 范围:`) is declared, disjoint and dependency-free, and that need no device, run in parallel Git worktrees (at most `parallel.max` per group, default 2). By default (`parallel.worktree_all`, default true) every other task also runs alone in its own worktree and is merged back in task order; only the feature's last task, the last task the batch runs and tasks marked `- 设备: 需要` run in the main checkout. A feature whose test contract has interactive (browser or simulator) QA cases gets no one-member groups, because that QA may target the main checkout; the batch host refuses one with `parallel_solo_interactive_qa`. A batch has no QA repair path, so a task that could hit a fixed N6 checkpoint (its scope or `AGENTS.md` matches a registered critical path, or it could be the fifth task without QA) also stays in the main checkout, as does every task when the main checkout's project configuration file is not byte-identical to its HEAD blob (a worktree is checked out from HEAD, so it would not see an untracked, ignored, skip-worktree or assume-unchanged local version); the planner (`--workflow-config` supplies the critical paths) and the batch host apply the same rules (`parallel_solo_qa_checkpoint`, `parallel_solo_config_untracked`, `parallel_solo_config_diverged`). That configuration check is only a pre-filter: what counts is the effective configuration both checkouts actually load once the worktree exists; the batch compares them before any develop dispatch and, when they differ, stops with `batch_member_config_diverged`, removing the worktree and branch only when provably untouched (no member run, clean status including untracked and ignored files, no commit beyond HEAD; never forced) and otherwise keeping them for the operator. A branch left by an interrupted cleanup is deleted with `git branch -d` and rebuilt when it has nothing beyond HEAD; one with its own commits stops the batch with `batch_member_branch_exists`. A task alone in its worktree still decides N6 normally; if its QA is triggered there and fails, the batch stops with `batch_solo_qa_failed`, the reviewed delivery committed on its branch, and names the exit (merge the branch, fix with `cm-fix`, continue with a new batch). Only members developed together in a group of two or more defer their QA to the feature's final QA. `parallel.worktree_all: false` keeps only real groups (two or more members); `parallel.enabled: false` in the project configuration turns worktrees off. Any task without a declared scope, and the bootstrap feature, keep the whole feature serial in the main checkout.

Outside that planner, serial is the default. `cm-ai` is explicitly allowed to delegate to Codex subagents only when all conditions hold:

1. tasks have no dependency edge between them;
2. their expected file sets do not overlap;
3. neither task writes specs, metrics, logs, project instructions, lockfiles, migrations, or Git state;
4. the available collaboration runtime can return reviewable handoffs.

If any condition is uncertain, run serially. Never parallelize destructive migrations, production operations, fund/key operations, or tasks that share an interface still under design.

Read-only parallel work does not require a worktree. Before two or more tasks
write code concurrently, assign each task a registered worktree and unique
branch, then run:

```bash
node {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs check-parallel-write \
  --repo {CODE_PROJECT} \
  --assignment T-001={WORKTREE_ONE} \
  --assignment T-002={WORKTREE_TWO}
```

Any nonzero result means **run serially**. Do not improvise a shared checkout,
detached worktree, or same-branch parallel write.

## Worker payload

Every delegated task includes:

- task id and exact title;
- relevant requirements, design contract, and acceptance criteria;
- allowed file scope;
- applicable role skill and discipline reference;
- verification command(s);
- prohibition on editing specs, status, metrics, reviews, or Git state;
- fixed handoff format from `runtime/task-gates.md`: task/attempt, status, changed
  files, verification, evidence, blockers, and scope deviations.

## Resume behavior

On every invocation, reread disk state. Treat `[x]` and `[DROPPED]` tasks as terminal unless the user explicitly reopens them. Find the first eligible unchecked task after dependency analysis. Do not trust conversation summaries for completion state.

After each task, the main agent performs review, evidence checks, checkbox update, metrics, commit, and a fresh disk reread before selecting the next task.
