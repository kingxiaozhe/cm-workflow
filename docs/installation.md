# Installation

## Requirements

- Git and Python 3.
- For Codex: a current Codex installation with the bundled plugin creator
  helpers available under `CODEX_HOME`.
- For Claude Code on macOS/Linux: Bash 3.2 or newer.
- For Claude Code on Windows: Windows PowerShell 5.1 or newer, plus Git for
  Windows (Git Bash). WSL users can install and run the Bash entry inside WSL.

Clone the repository somewhere other than `~/plugins/cm-workflow`:

```bash
git clone https://github.com/kingxiaozhe/cm-workflow.git
cd cm-workflow
```

The Codex installer reserves `~/plugins/cm-workflow` as its managed install
destination and refuses to replace a source checkout located there.

## Codex

```bash
./install-codex.sh
```

The installer:

1. validates the source with CM's dependency-free repository and runtime checks;
2. also runs Codex's bundled YAML validator when PyYAML is available;
3. updates the personal marketplace through the bundled scaffold helper;
4. assembles and validates a temporary plugin;
5. replaces the managed plugin directory, applies a cachebuster, and runs
   `codex plugin add`.

If the final Codex ingestion fails, both the previous managed plugin and the
personal marketplace are restored. PyYAML is therefore an optional stronger
validation dependency, not an installation prerequisite.

Existing installs require confirmation. For an intentional unattended upgrade:

```bash
./install-codex.sh --yes
```

Start a new Codex thread after installation, then run `$cm-check`. To derive a
test-case draft from an implemented feature, use
`$cm-test {project} {feature} --generate-cases`; to verify it without modifying
source, use `$cm-test`. The installed manual is available at
`~/plugins/cm-workflow/docs/user-guide.md`.

## Claude Code on macOS/Linux

```bash
./install.sh
```

Every destination tree is checked for conflicts before copy. Use `--yes` only
when you intentionally accept replacement of all listed CM files:

```bash
./install.sh --yes
```

The installer runs the shared mechanical check before reporting success. Start a
new Claude Code session, then run `/cm-check`. The installer also keeps the
historic `/cm:check` alias on macOS/Linux. The installed manual is available at
`~/.claude/cm-workflow/docs/user-guide.md` unless `CLAUDE_HOME` overrides the
destination.

## Claude Code on Windows

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Existing files are listed before replacement. Use `-Force` for an intentional
unattended install:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Force
```

Core Markdown workflows use `/cm-*` names such as `/cm-check`, `/cm-ai`, and
`/cm-test`. The PowerShell installer and `/cm-check` delegate the shared
mechanical check to Git Bash; set `CLAUDE_CODE_GIT_BASH_PATH` if Bash is not on
`PATH`. Windows cannot store the historic colon filenames used by `/cm:*`, so
those aliases are macOS/Linux only. Bash-based statusline and visualization
helpers likewise require WSL or Git Bash.

## Optional Claude auto-update

The installer copies the updater but does not activate it. To enable it, add the
following commands to Claude Code's `hooks.SessionStart` configuration after
reviewing the scripts:

```json
[
  {
    "type": "command",
    "command": "~/.cm-workflow/cm-announce.sh",
    "timeout": 5
  },
  {
    "type": "command",
    "command": "~/.cm-workflow/cm-update.sh",
    "timeout": 120,
    "async": true
  }
]
```

Set `CM_UPDATE_REMOTE` when your team intentionally uses a fork.

## Uninstall

This repository does not provide an automatic uninstall because user directories
may contain modified copies. Remove only the CM-owned paths you have reviewed,
or restore from your own backup.
