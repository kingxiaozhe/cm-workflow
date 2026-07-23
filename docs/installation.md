# Installation

## Requirements

- Git and Python 3.
- For Codex: a current Codex installation with the bundled plugin creator
  helpers available under `CODEX_HOME`.
- For Claude Code on macOS/Linux: Bash 3.2 or newer.
- For Claude Code on Windows: Windows PowerShell 5.1 or newer.

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

1. validates the source with Codex's bundled plugin validator;
2. updates the personal marketplace through the bundled scaffold helper;
3. assembles and validates a temporary plugin;
4. atomically replaces the managed plugin directory;
5. applies a Codex cachebuster and runs `codex plugin add`.

Existing installs require confirmation. For an intentional unattended upgrade:

```bash
./install-codex.sh --yes
```

Start a new Codex thread after installation, then run `$cm-check`.

## Claude Code on macOS/Linux

```bash
./install.sh
```

Every destination tree is checked for conflicts before copy. Use `--yes` only
when you intentionally accept replacement of all listed CM files:

```bash
./install.sh --yes
```

Start a new Claude Code session, then run `/cm-check`. The installer also keeps
the historic `/cm:check` alias on macOS/Linux.

## Claude Code on Windows

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Existing files are listed before replacement. Use `-Force` for an intentional
unattended install:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Force
```

Core Markdown workflows work natively and use `/cm-*` names such as `/cm-check`
and `/cm-ai`. Windows cannot store the historic colon filenames used by
`/cm:*`, so those aliases are macOS/Linux only. Bash-based statusline and
visualization helpers require WSL or Git Bash.

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
