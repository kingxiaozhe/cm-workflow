# Installation

## Requirements

- Git, Python 3.9 or newer, and Node.js 18 or newer.
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
The optional project configuration template is installed at
`~/plugins/cm-workflow/templates/cm-workflow.yml`.

## Local cross-project logs

The installers do not create or upload logs. On the first logged workflow
event, the shared writer creates:

```text
~/.cm-workflow/logs/index.jsonl
~/.cm-workflow/logs/runs/YYYY-MM/{run_id}.jsonl
```

Set `CM_WORKFLOW_LOG_HOME` before starting Codex or Claude Code to choose a
different local root. On POSIX systems these global directories and files are
restricted to the current user. They contain normalized operational metadata,
not prompts, model responses, source text, external conversation URLs, or
credentials. A specs-local `运行日志.jsonl` remains the authoritative record.

## Claude Code on macOS/Linux

```bash
./install.sh
```

All CM-owned destination files are checked before any copy. The bundle is
all-or-nothing: declining a conflict changes nothing, and a failed post-install
check restores the previous CM files. Use `--yes` only when you intentionally
accept replacement of all listed CM files:

```bash
./install.sh --yes
```

The installer runs the shared mechanical check before reporting success. Start a
new Claude Code session, then run `/cm-check`. The installer also keeps the
historic `/cm:check` alias on macOS/Linux. The installed manual is available at
`~/.claude/cm-workflow/docs/user-guide.md` unless `CLAUDE_HOME` overrides the
destination.
The two disabled-by-default auto-update helper scripts are copied to
`~/.cm-workflow`; overriding `CLAUDE_HOME` alone therefore does not make an
installer run fully isolated. Override both `HOME` and `CLAUDE_HOME` for an
authorized temporary-directory smoke test.
The optional project configuration template is installed at
`$CLAUDE_HOME/templates/cm-workflow.yml` (or `~/.claude/templates/cm-workflow.yml`).
The installed `/cm-ai` Skill invokes the same read-only
`$CLAUDE_HOME/scripts/cm-ai-admission.mjs` N1/N2 authority used by Codex; no
Claude-specific workflow fork is installed.

## Claude Code on Windows

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Existing CM files are listed before replacement. Windows uses the same
all-or-nothing transaction and restores the previous CM files if validation
fails. Use `-Force` for an intentional unattended install:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Force
```

Core Markdown workflows use `/cm-*` names such as `/cm-check`, `/cm-ai`, and
`/cm-test`. The PowerShell installer and `/cm-check` delegate the shared
mechanical check to Git Bash; set `CLAUDE_CODE_GIT_BASH_PATH` if Bash is not on
`PATH`. Windows cannot store the historic colon filenames used by `/cm:*`, so
those aliases are macOS/Linux only. Bash-based statusline and visualization
helpers likewise require WSL or Git Bash.
The optional project configuration template is installed at
`$CLAUDE_HOME/templates/cm-workflow.yml` (or `%USERPROFILE%\.claude\templates\cm-workflow.yml`).
The installed `/cm-ai` Skill uses the same Node.js admission entry as other
platforms; any admitted task still uses the shared Review/N5 gates.

## Optional Claude auto-update (macOS/Linux)

The Bash installer copies the updater on a best-effort basis but does not activate
it. A copy failure is reported as a warning and does not invalidate a core runtime
that already passed its installed self-check. The PowerShell
installer intentionally does not copy this Bash-based updater; Windows users who
want it must run the Bash installer from WSL or Git Bash. To enable it on a
supported Bash environment, add the following commands to Claude Code's
`hooks.SessionStart` configuration after reviewing the scripts:

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

For a Codex install registered by the installer, remove the enabled plugin and
its local cache with:

```bash
codex plugin remove cm-workflow@personal
```

This intentionally leaves the local `~/plugins/cm-workflow` source and the
`personal` marketplace definition available for inspection or reinstall. Remove
those separately only after reviewing that they are still CM-owned.

Claude Code compatibility installs do not have an automatic uninstall because
their destination directories may contain user-modified copies. Remove only the
CM-owned paths you have reviewed, or restore from your own backup.
