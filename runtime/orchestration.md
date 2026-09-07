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
an unobserved backend model. An unavailable non-local adapter is
`declared-adapter`, not a silent success. Missing configuration keeps the
built-in current-runtime/local-tool defaults. Role routing never changes task
authority, N1–N8 order, N4 independence, or Git permissions.

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

Serial is the default. `cm-ai` is explicitly allowed to delegate to Codex subagents only when all conditions hold:

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
