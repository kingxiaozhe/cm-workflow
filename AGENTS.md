# CM Workflow repository

This repository is the Codex-native source for a spec-driven development workflow. Keep Codex Skills and shared runtime contracts authoritative; `compat/claude-commands/cm-*.md` contains optional macOS/Linux aliases for the historic Claude Code `/cm:*` entrypoints.

## Commands

- Mechanical consistency: `./scripts/cm-check-runtime.sh`
- Plugin validation: `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`
- Codex local install: `./install-codex.sh`
- Claude compatibility install: `./install.sh`

## Boundaries

- Preserve `tasks.md` as the authoritative task state and keep `.cm-specs-status`, `.cm-status.json`, `运行日志.jsonl`, `.reviews/`, `METRICS.md`, and `LESSONS.md` compatible.
- Resolve plugin assets relative to the active Skill; never hardcode a Codex cache path.
- Require independent review evidence before marking work complete. Degradation must be explicit in the evidence header.
- Serial execution is the default. Parallel workers may not write specs, mark tasks complete, or commit.
- Preserve user changes and avoid destructive git operations.

## Compatibility rules

Read the relevant files under `.claude/rules/` when modifying shell scripts, documentation, security-sensitive behavior, or release/install flows. Keep `.claude/CLAUDE.md` synchronized when repository structure or commands change.
