# CM Codex orchestration contract

This contract governs `cm-ai`, `cm-fix`, and `cm-refactor` when they execute work in Codex.

## Sources of truth

- The active feature `tasks.md` is the authoritative business-task state.
- Specs, `.cm-status.json`, `运行日志.jsonl`, `.reviews/`, `METRICS.md`, and `LESSONS.md` are authoritative audit artifacts.
- Codex plans, subagent threads, and OMX state are disposable mirrors. Rebuild them from disk after a restart; never let them silently reverse a checked task.

Only the main agent may update `tasks.md`, audit artifacts, shared status, or Git history. A worker edits only the files assigned to its task and returns a structured handoff.

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

## Worker payload

Every delegated task includes:

- task id and exact title;
- relevant requirements, design contract, and acceptance criteria;
- allowed file scope;
- applicable role skill and discipline reference;
- verification command(s);
- prohibition on editing specs, status, metrics, reviews, or Git state;
- fixed handoff format: changed files, verification, contract deviations, follow-ups, lessons.

## Resume behavior

On every invocation, reread disk state. Treat `[x]` and `[DROPPED]` tasks as terminal unless the user explicitly reopens them. Find the first eligible unchecked task after dependency analysis. Do not trust conversation summaries for completion state.

After each task, the main agent performs review, evidence checks, checkbox update, metrics, commit, and a fresh disk reread before selecting the next task.
