# Contributing

CM Workflow treats prompt references as contracts. A change is complete only
when its producers, consumers, compatibility wrappers, and checks agree.

## Development

1. Create a feature or fix branch.
2. Keep Codex Skills and `runtime/` contracts authoritative.
3. Keep `compat/claude-commands/cm-*.md` as thin optional Claude Code wrappers.
4. Update documentation and version sources when behavior changes.
5. Run:

```bash
./scripts/cm-check-runtime.sh
./scripts/cm-check-runtime.sh --routing-fixtures
bash scripts/test-shell-compat.sh
node --test scripts/cm-workflow-config.test.mjs
node --test scripts/cm-log-event.test.mjs
node --test scripts/validate-test-cases.test.mjs
python3 scripts/test-workflow-config.py  # legacy harness compatibility
node --test scripts/cm-task-gate.test.mjs
python3 scripts/test-task-gate.py
python3 scripts/validate-public-repo.py
python3 scripts/scan-public-safety.py
find . -type f -name '*.sh' -print0 | xargs -0 -n1 /bin/bash -n
```

If your local Codex includes plugin creator helpers, also run:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Changes to N1–N8, installers, or templates require the corresponding dogfood or
isolated-install evidence described in `.claude/rules/testing.md`. A release or
change to the Pi/BYZ or Codex distribution surface also requires, from a clean
checkout:

```bash
./scripts/cm-release-smoke.sh
```

This command requires local BYZ and Codex installations. It validates the Pi
manifest, checks the local workflow root through BYZ, and installs the Codex
plugin under a disposable home; it does not modify the caller's normal Codex
plugin state.

## JavaScript test groups

Use Node.js 24.14+ for the full suite, plus Python 3.9+ and Git for the fixtures
that call them. Node.js 18 remains the minimum for the shared-authority checks
listed in CI. No npm dependency install, BYZ installation or plugin installation
is needed to list or run these groups:

```bash
node scripts/cm-test-suite.mjs check
node scripts/cm-test-suite.mjs list ordinary
node scripts/cm-test-suite.mjs list native
node scripts/cm-test-suite.mjs list history
node scripts/cm-test-suite.mjs run ordinary
node scripts/cm-test-suite.mjs run native --concurrency 1
node scripts/cm-test-suite.mjs run history --concurrency 4
```

| Group | Coverage and requirements |
| --- | --- |
| `ordinary` | All `scripts/*.test.mjs` except the fixed native group; new tests are included automatically. CI runs four weighted shards. |
| `native` | Nine files that need a local Codex CLI and working native sandbox. Linux hosts must permit the sandbox's network isolation. These tests are also required by release smoke. |
| `history` | `experiments/js-orchestration/*.test.mjs`; historical compatibility evidence. CI allows this job to fail, but the local command still exits unsuccessfully on a failing test. |

The entrypoint creates temporary `CM_WORKFLOW_HOME` and `CM_WORKFLOW_LOG_HOME`
directories for each run and removes them when the runner exits. It does not
change `HOME` or `CODEX_HOME`, install tools, request external services, or retry
failures. Fixtures retain their own platform checks and local subprocess or
loopback requirements. Missing native capabilities are not a passing native run.

Use `--concurrency N` to choose test-file concurrency explicitly. Without that
option, Node's existing default applies. Select the same weighted shards as CI
with the existing `ci-test-shards.mjs` implementation:

```bash
node scripts/cm-test-suite.mjs list ordinary --shards 4 --index 0
node scripts/cm-test-suite.mjs run ordinary --shards 4 --index 0 --concurrency 2
```

Shard indices start at zero. Run indices 0 through 3 to cover all four shards.
An empty run selection, an invalid inventory, and failed tests return nonzero;
interrupts are forwarded to the test process group on POSIX. The entrypoint
does not change fixture timeouts. The fixed native list lives only in
`scripts/cm-test-suite.mjs`; `scripts/cm-test-suite.test.mjs` pins its approval
fingerprint and verifies that ordinary plus native cover every current script
test exactly once. Changes to the native list require explicit review of that
fingerprint and the reason for excluding a test from hosted CI.

## Skill trigger diagnostics

Treat trigger quality as a routing contract, not marketing copy. Test each
user-facing entry with an explicit invocation, a natural request, and an
ambiguous or incomplete request. Diagnose failures at the smallest layer:

| Symptom | Change first |
| --- | --- |
| The Skill does not trigger for a clear natural request | Add the real user wording and intent to `description` |
| The wrong Skill triggers | Add a concrete exclusion boundary and name the correct neighboring flow |
| Execution order varies after a correct trigger | Tighten the workflow steps, not the trigger copy |
| Output is generic or unverifiable | Add measurable quality and completion criteria |
| Missing input causes invented facts | Add an explicit stop, question, or `BLOCKED` rule |
| The same deterministic code is regenerated | Move that operation to `scripts/` |
| `SKILL.md` keeps growing with conditional detail | Move mode-specific material to `references/` |

Do not add a routing service or nondeterministic CI assertion for these cases.
Use the descriptions for model selection, the user guide for examples, and
focused dogfood for behavioral evidence.

## Pull requests

Explain the affected workflow stage, why the change is needed, which contracts
or wrappers changed, and the exact verification performed. Do not include
credentials, private project names, personal paths, or generated session data.
