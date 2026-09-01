# CM Workflow repository

This repository is the Codex-native source for a spec-driven development workflow. Keep Codex Skills and shared runtime contracts authoritative; `compat/claude-commands/cm-*.md` contains optional macOS/Linux aliases for the historic Claude Code `/cm:*` entrypoints.

## Project facts

- Stack: Markdown prompts, Bash 3.2-compatible scripts, Python 3 standard-library tooling, PowerShell installers/checks, and optional Node.js `.mjs`/Playwright utilities.
- Framework: native Pi/BYZ package plus Codex plugin and Agent Skills, with Claude Code compatibility surfaces.
- Manifest: root `package.json` is Pi/BYZ package metadata only; it declares no npm dependencies or scripts, so there is no repository-wide dependency install or build artifact.
- Version control: `remote` (`origin`). Delivery targets Pi/BYZ package loading and local Codex/Claude Code installation.
- Business map: local scan artifacts are not committed; use `docs/architecture.md` as the public architecture map.

## Commands

- npm dependency install / development server / build: not applicable; `package.json` is package metadata, and source is edited directly.
- Mechanical consistency: `./scripts/cm-check-runtime.sh`
- Global log fixture: `./scripts/cm-check-runtime.sh --log-fixtures`
- Focused fixtures: `bash scripts/test-shell-compat.sh`, `python3 scripts/test-workflow-config.py`, `python3 scripts/test-task-gate.py`, `python3 scripts/test-cm-openai-compatible-call.py`, and `python3 scripts/test-cm-usage-report.py`
- Approved specs manifest: `python3 scripts/cm-spec-manifest.py <specs-dir>`
- PRD review recovery fixture: `python3 scripts/test-cm-prd-review-gate.py`
- Lint/safety: `python3 scripts/validate-public-repo.py`, `python3 scripts/scan-public-safety.py`, and `find . -type f -name '*.sh' -print0 | xargs -0 -n1 /bin/bash -n`
- Plugin validation: `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`
- Pi/BYZ package install: `pi install git:github.com/kingxiaozhe/cm-workflow`
- Codex local install: `./install-codex.sh`
- Claude compatibility install: `./install.sh` (Windows: `powershell -ExecutionPolicy Bypass -File install.ps1`)

Install commands modify user-level runtime directories; run them only for an intentional install or isolated smoke test.

## Key directories

- `skills/`: authoritative workflows and role capabilities.
- `runtime/`: shared context, orchestration, review, routing, logging, and gate contracts.
- `compat/claude-commands/`: thin historic aliases; never duplicate workflow logic here.
- `agents/`: Claude-compatible parallel worker definitions.
- `templates/`: generated project rules and optional local UI assets.
- `scripts/`: validators and dependency-free fixtures.
- `docs/`: installation, usage, architecture, and public examples.

## Boundaries

- Preserve feature-local `tasks.md` as the authoritative task state and keep `.cm-specs-status`, `.cm-status.json`, `.cm-run.json`, `.cm-run.lock`, `运行日志.jsonl`, `.reviews/`, `METRICS.md`, and `LESSONS.md` compatible.
- Treat the specs-local `运行日志.jsonl` as authoritative. `~/.cm-workflow/logs/` is a private, reconstructable cross-project mirror, never telemetry or a competing task-state database.
- Resolve plugin assets relative to the active Skill; never hardcode a Codex cache path.
- Require independent review evidence before marking work complete. Degradation must be explicit in the evidence header.
- Serial execution is the default. Parallel workers may not write specs, mark tasks complete, or commit.
- Preserve user changes and avoid destructive git operations.
- Keep production release, infrastructure changes, destructive migrations, and mainnet actions behind explicit human confirmation.

## Compatibility rules

Read the relevant files under `.claude/rules/` when modifying shell scripts, documentation, security-sensitive behavior, or release/install flows. Keep `.claude/CLAUDE.md` synchronized when repository structure or commands change.
