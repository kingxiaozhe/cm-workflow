# CM model-call efficiency contract

This contract reduces repeated API context and verbose model output without
reducing requirements, tests, independent review, approval, or evidence. It is
an execution contract for model-call owners; it is not a model gateway and does
not claim visibility into calls made by Codex, Claude, or a declared adapter.

## Minimal role packet

Build one packet for the current role and current task. Reference durable files
by path and include only the slices needed for the decision; do not paste the
same project overview, full specs, full source files, or prior conversation into
every role call.

| Role | Required dynamic packet |
| --- | --- |
| `analyst` | current requirement, relevant business-map slice, known constraints, unresolved questions |
| `planner` | analyst result, affected modules/interfaces, approved constraints, acceptance-criteria candidates |
| `coder` | one task, mapped ACs, relevant design contracts, allowed files, verification commands, current attempt |
| `tester` | test contract/cases in scope, declared commands, environment facts, concise failure evidence when retrying |
| `reviewer` | current task handoff, task-only diff/new files, mapped ACs and rules, verification summary, pre-task dirty exclusions |
| `browser_qa` | selected browser cases, target environment/route, setup and cleanup facts, expected observable results |

Every packet states `workflow`, `stage`, `role`, objective, stable artifact
references, current identifiers, constraints, and expected output shape. A
missing required item is reported as missing; it is not replaced with guessed
context. The reviewer package in `runtime/review.md` and test evidence in
`runtime/test-contract.md` remain minimum quality requirements, not optional
content to trim.

Start targeted. Escalate only when a concrete dependency, ambiguity, changed
shared contract, or review finding shows that the packet is insufficient.
Record the reason and newly added scope; do not reread or resend unchanged full
context. `cm-prd` additionally follows its progressive context-scope contract.

## Stable prefix

When an integration owns the prompt assembly, keep reusable instructions in
this order:

1. safety and authorization boundary;
2. CM workflow/stage boundary;
3. applicable project rules;
4. role contract;
5. output schema.

Append the dynamic role packet after that prefix. Keep stable sections byte-for-
byte unchanged during one run when their source has not changed. Put timestamps,
attempt ids, diffs, task text, test output, and conversation history only in the
dynamic packet.

Prompt caching is optional. Enable it only through an adapter/runtime capability
that is actually available, and only report cache reads/writes returned by that
adapter. A stable prefix improves reuse even when no cache API exists, but CM
must never claim a cache hit from prefix stability alone.

## Compact output

Ask each role for its decision artifact, not a narration of its reasoning:

- analyst/planner: deltas, decisions, open questions, AC/task mappings;
- coder: changed paths, verification, blockers, scope deviation;
- tester/browser QA: case verdicts, counts, failing identifiers, evidence paths;
- reviewer: findings first, verdict, blocking count, reviewed scope.

Do not repeat the prompt, full specs, source, diff, or successful command output.
For failures retain the exit code, failing case/command, first actionable error
and evidence path; avoid arbitrary truncation that hides the root error. Durable
detail stays in the existing specs/review/test artifacts. Main logs keep only
safe identifiers, counts, outcomes, and short summaries.

## Verified usage event

### Bundled OpenAI-compatible boundary

`roles.*.adapter: openai-compatible` resolves to `managed-adapter`. The role
owner invokes the bundled standard-library boundary instead of treating it as
unavailable:

```bash
export CM_OPENAI_COMPATIBLE_ENABLED=true
export CM_OPENAI_COMPATIBLE_BASE_URL="https://models.example.invalid/v1"
export CM_OPENAI_COMPATIBLE_API_KEY="<set outside project config>"

python3 "{CM_WORKFLOW_ROOT}/scripts/cm-openai-compatible-call.py" \
  --workflow cm-prd --stage design_generation --role planner --runtime codex \
  --requested-model planner-default --call-id "{unique_call_id}" \
  --project-root "{CODE_PROJECT}" --specs-dir "{SPECS_DIR}" \
  --run-id "{run_id}" < "{ROLE_PACKET_JSON}"
```

The stdin JSON has exactly two fields. The adapter canonicalizes the stable
prefix in the declared order, so callers do not depend on JSON key order.
`dynamic_packet` requires the seven fields shown below and permits only one
optional `context` object for role-specific material. Its workflow, stage, and
role must match the CLI identity; rejected packets create neither a claim nor an
HTTP request:

```json
{
  "stable_prefix": {
    "safety": "applicable safety and authorization boundary",
    "workflow": "current CM workflow and stage boundary",
    "project_rules": "only the applicable stable project rules",
    "role": "current role contract",
    "output_schema": "compact role output schema"
  },
  "dynamic_packet": {
    "workflow": "cm-prd",
    "stage": "design_generation",
    "role": "planner",
    "objective": "current objective",
    "identifiers": {},
    "constraints": [],
    "context": {"requirement": "only the task-relevant material"},
    "expected_output": "compact plan"
  }
}
```

The three environment variables are invocation authority, endpoint, and secret;
none belong in `.cm-workflow.yml`, command arguments, evidence, or logs. HTTP is
accepted only for loopback fixtures; remote endpoints require HTTPS. The adapter
connects directly to the configured endpoint and does not inherit environment
proxy settings or follow redirects. It
first records an atomic `model_call/claimed` event, then sends the packet, prints
only the model's text result to stdout, and writes one verified `model_usage`
event at the same response boundary. A repeated or concurrent invocation with
the same run and `call_id` is rejected before HTTP, including a call id that
already has a completion, so retries that represent a new provider call must use
a new `call_id`. `--run-id` is required when no
`--specs-dir` is provided, keeping the claim and completion in one global-only
run. Exit states are:

- `0`: model result returned and usage event recorded;
- `1`: call/response failed and an error outcome was recorded;
- `2`: configuration or input was rejected before any HTTP call;
- `3`: model result returned in stdout but usage logging failed—do not
  automatically repeat the model call.
- `4`: model call or response failed and the error outcome could not be logged;
  the pre-call claim remains unresolved and must not be treated as completed
  evidence.

The role owner records a warning/blocking outcome for nonzero exits and never
silently substitutes another model.

This boundary returns text; it does not edit files, run commands, approve specs,
or satisfy N4 by itself. The local orchestrator applies accepted results and
retains all existing execution and review gates. Other adapters remain
`declared-adapter` until they have their own verified boundary.

### Event contract

The component that actually owns a completed model-call boundary may write one
`model_usage/complete` event through `scripts/cm-log-event.py`:

```bash
python3 "{CM_WORKFLOW_ROOT}/scripts/cm-log-event.py" \
  --workflow cm-prd --event model_usage --phase complete --runtime codex \
  --project-root "{CODE_PROJECT}" --specs-dir "{SPECS_DIR}" \
  --detail "planner model call completed" \
  --data-json '{"call_id":"planner-20260806-0001","stage":"design_generation","role":"planner","adapter":"company-api","requested_model":"planner-default","effective_model":"provider-model-v2","source":"api","purpose":"cm-prd:design_generation","usage_state":"observed","input_tokens":1200,"output_tokens":300,"cache_read_tokens":800,"cache_write_tokens":0,"duration_ms":2500,"outcome":"success"}'
```

Rules:

1. `call_id` is a non-secret id unique to one real call within the run. The
   bundled boundary claims it before HTTP and refuses reuse; a distinct or
   recovery call uses a new id. The writer still deduplicates an exact retry of
   a standalone event write.
2. `workflow`, `runtime`, `stage`, `role`, `adapter`, `requested_model`, `source`,
   and `purpose` form the safe call identity. A completion for an existing claim
   must match all eight fields; ordering is claim first, completion second.
3. `observed` means the adapter/runtime returned the values. Input and output
   counts are required; cache counts and duration are optional.
4. `unavailable` carries no token counts. It may carry a measured `duration_ms`
   when the integration observed the call boundary but received no usage data.
5. A Skill that cannot see the call boundary or adapter response writes only its
   normal route/progress evidence; it does not fabricate a `model_usage` event.
6. `requested_model` is configuration. `effective_model` is present only when
   the runtime/provider reports it. Do not infer either from a subscription badge.
7. Never log prompts, responses, source code, diffs, customer data, credentials,
   headers, endpoints, or provider payloads. The writer accepts only the small
   model-usage field allowlist and rejects negative counts.
8. Token counts are not cost. CM v1 does not estimate money or combine cache
   counters into input/output totals.

Read the private local summary with:

```bash
python3 "{CM_WORKFLOW_ROOT}/scripts/cm-usage-report.py" --last 10
python3 "{CM_WORKFLOW_ROOT}/scripts/cm-usage-report.py" --last 10 --json
```

The report deduplicates event ids and per-run call ids, rejects malformed usage
rows and conflicting claim identities, requires claim-before-completion ordering,
separates observed and unavailable calls, and never guesses missing usage.
A bundled `openai-compatible` usage row without its prior claim is invalid and
is never counted; other call-owning adapters may still emit standalone usage.
A `model_call/claimed` row without a matching valid completion is reported as an
unresolved claim; it is not counted as a completed call, outcome, or Token usage.
