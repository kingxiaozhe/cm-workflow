# CM Workflow role-routing contract

This contract is the small execution projection for the optional project
configuration. It does not replace N1–N8, create an Agent graph, or grant a
role permission to edit files.

## Load and resolve

1. N1 loads the effective config with
   `scripts/cm-workflow-config.mjs --project {CODE_PROJECT}`. A missing config uses
   the built-in defaults.
2. N7/resume and every role boundary reread the file. A changed or invalid file
   is recorded as `warning`/`error` and never silently treated as the old route.
3. Resolve one role with:

   ```bash
   node {CM_WORKFLOW_ROOT}/scripts/cm-workflow-config.mjs \
     --project {CODE_PROJECT} --role planner --runtime codex --print-role
   ```

   The result contains the role fields plus `runtime` and `route_state`.
   `model` is the requested alias; it is not proof of the backend model
   actually used. The `external_expert` route also includes its explicit
   enablement and fallback-policy fields.

## Role projection

| Workflow stage | Role | Purpose |
| --- | --- | --- |
| `cm-prd` analysis | `analyst` | understand the requirement and impact |
| `cm-prd` plan | `planner` | produce design, tasks and acceptance criteria |
| `cm-ai` implementation | `coder` | edit the approved code task |
| `cm-ai` task checks | `tester` | run the declared test contract |
| `cm-ai` N4 | `reviewer` | perform independent review; never the author shortcut |
| `cm-test` logic/commands | `tester` | inspect and execute the requested tests |
| `cm-test` browser | `browser_qa` | simulate the user in a local/test browser |
| external consultation | `external_expert` | reasoning only, under `runtime/external-expert.md` |

The mapping is metadata plus role-specific instructions. It does not reorder
N1–N8, mark tasks complete, approve specs, or replace the independent N4 gate.

## Route states

The resolver reports a conservative state:

- `current-runtime`: the active Codex/Claude runtime or `current-ai` owns the
  step;
- `local-tool`: a local tester/command tool owns the step;
- `local-browser`: `browser_qa` uses the local/test browser;
- `external-expert`: the existing explicit browser expert contract owns the
  reasoning-only consultation;
- `disabled`: the project explicitly disabled this role; do not invoke it and
  record the local skip/degrade outcome;
- `declared-adapter`: the project requested an adapter that this runtime did
  not observe. CM records the requested route, but must not claim that model or
  provider actually ran. Adapter-specific invocation remains an integration
  responsibility outside this contract.

`source` describes where credentials or execution access comes from. It is not
an authorization grant. API keys, cookies, prompts, responses and raw source
never enter the config or route log.

## Logging

At each role boundary write a `decision` event with `phase: route` and safe
metadata: `role`, `adapter`, `requested_model`, `source`, `purpose`,
`route_state`, and the current node/feature/task identifiers. Do not write
credentials, prompts, responses, source text, or an unverified
`effective_model`. Copy the resolver's `model` alias into
`requested_model`; never treat that alias as an observed backend model. If a requested adapter is unavailable, also write a
`warning` or `degrade` event with the explicit outcome.
