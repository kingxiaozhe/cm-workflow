# CM run logging contract

CM records workflow events at two levels:

```text
{SPECS_DIR}/运行日志.jsonl
${CM_WORKFLOW_LOG_HOME:-~/.cm-workflow/logs}/
├── index.jsonl
└── runs/YYYY-MM/{run_id}.jsonl
```

The specs log is the portable recovery and audit source of truth. The user-global
tree is a private analysis mirror across projects, sessions, Codex, and Claude
Code. It is not telemetry and nothing is transmitted off the machine.

## Writer

Resolve `scripts/cm-log-event.py` from the active CM Workflow root. It uses only
the Python standard library:

```bash
python3 "{CM_WORKFLOW_ROOT}/scripts/cm-log-event.py" \
  --workflow cm-ai \
  --event task_start \
  --runtime codex \
  --project-root "{CODE_PROJECT}" \
  --specs-dir "{SPECS_DIR}" \
  --detail "正在开发登录接口" \
  --data-json '{"node":"N3","feature":"1.login","task":"T-003","role":"coder"}'
```

Use `runtime: codex`, `claude`, or `unknown` according to the runtime actually
observed. Optional `role` and `model_observed` values describe visible
configuration only; never infer an exact backend model.

The writer prints one compact JSON result containing `event_id`, `run_id`,
project/global log paths, `global_written`, `pointer_written`, `deduplicated`,
and `degraded`.
Preserve the returned `run_id` for a standalone flow. With a specs directory,
`.cm-run.json` stores the active run id so a resumed session automatically
continues the same run. If that pointer is unavailable, the writer reconstructs
the active/terminal state from the authoritative project log. After `run_done`,
the next `run_start` creates a new run.

## Event envelope

Each output line contains:

```json
{
  "schema_version": 1,
  "event_id": "<uuid>",
  "run_id": "<stable run id>",
  "at": "<ISO-8601 with timezone>",
  "workflow": "cm-ai",
  "event": "task_start",
  "phase": "start",
  "runtime": "codex",
  "project": "my-app",
  "project_path": "<canonical path when known>",
  "specs_path": "<canonical path when known>",
  "detail": "<one plain-language line>"
}
```

Existing project logs without these fields remain valid historical input. New
events use this envelope. Event-specific fields are supplied by `--data-json`
and may not replace envelope fields.

## Required lifecycle events

| Workflow/action | Event | Phases or required data |
| --- | --- | --- |
| each workflow run | `run_start` / `run_done` | start once; terminal result in detail/data |
| PRD and approval | `spec_lifecycle` | `generated`, `awaiting_review`, `approved`, `changed` |
| N1–N8 | existing node/task/review/degrade/pause/resume/decision/error/qa/done events | preserve existing semantics |
| standalone or N6 tests | `test_run` | `start`, `complete`; modes, case counts, result, report |
| External Expert | `external_expert` | `route`, `dispatch`, `complete`; route/mode/state/evidence metadata |
| Git delivery | `delivery` | `commit`, `push`, `pull_request`; identifiers only after success |

Do not invent `push` or `pull_request` events before the remote side effect
succeeds. External Expert `dispatch` records the observed dispatch state, not
mere intent. `LOCAL` selected without AUTO or an explicit External Expert
invocation does not need an event.

## Write and degradation rules

1. When `{SPECS_DIR}` exists, write the project event first, then mirror the
   identical event id into the global run file.
2. A global-mirror failure appends a project-side `degrade` event with
   `phase: global_log`, warns once, and returns success. The project log remains
   authoritative.
3. A project-log failure returns non-zero; do not claim the event was recorded.
4. A standalone flow without specs has only the global destination. Global
   failure returns non-zero and must be reported.
5. `index.jsonl` contains lightweight `running` and `done` run records. Full
   events stay in per-run files, avoiding one contended global stream.
6. Global directories/files are user-private (`0700`/`0600` where supported).
   The location can be changed only through the explicit
   `CM_WORKFLOW_LOG_HOME` environment variable.
7. A run keeps the global file selected at its start even when it crosses a
   month boundary. Pointer failure degrades to project-log recovery and does not
   invalidate events that were already durably appended.
8. `.cm-run.lock` and the private global `.cm-write.lock` serialize concurrent
   writers. Completely identical retries in one run reuse a deterministic
   `event_id`; callers must include an attempt/task identifier in `data` when
   two otherwise identical events are intentionally distinct.

## Privacy and size boundary

Logs contain metadata, counts, identifiers, relative evidence references, and
short decisions. Never log:

- complete prompts or model responses;
- source, diff, document, or local-file contents;
- API keys, tokens, passwords, cookies, authorization headers, private keys, or
  recovery codes;
- customer data, browser state, databases, or internal endpoints.

Keep `detail` to one line and at most 500 characters. Put test/review detail in
`.reviews/`, External Expert detail in `.external/`, and code truth in Git. The
writer rejects sensitive field names, but callers still own content
minimization and redaction.
