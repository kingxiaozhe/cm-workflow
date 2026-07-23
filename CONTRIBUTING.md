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
python3 scripts/validate-public-repo.py
python3 scripts/scan-public-safety.py
find . -type f -name '*.sh' -print0 | xargs -0 -n1 /bin/bash -n
```

If your local Codex includes plugin creator helpers, also run:

```bash
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

Changes to N1–N8, installers, or templates require the corresponding dogfood or
isolated-install evidence described in `.claude/rules/testing.md`.

## Pull requests

Explain the affected workflow stage, why the change is needed, which contracts
or wrappers changed, and the exact verification performed. Do not include
credentials, private project names, personal paths, or generated session data.
