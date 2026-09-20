# Installation

## Requirements

- Git, Python 3.9 or newer, and Node.js 18 or newer.
- For Codex: a current Codex installation with the bundled plugin creator
  helpers available under `CODEX_HOME`.
- For Claude Code on macOS/Linux: Bash 3.2 or newer.
- For Claude Code on Windows: Windows PowerShell 5.1 or newer, plus Git for
  Windows (Git Bash). WSL users can install and run the Bash entry inside WSL.

For macOS Codex, npm installation below does not require a source checkout.
For source installation, clone the repository somewhere other than `~/plugins/cm-workflow`:

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

Start a new Codex thread after installation, then run `$cm-check`. Full `cm-check`
queries npm's stable `latest` and automatically upgrades a supported managed
installation before checking the returned root. It reuses the existing installer
with `--yes`; no additional upgrade flag or confirmation is needed. Other Skills
load the new version in a new session. Finish other active CM tasks before updating.
Offline checks explicitly leave the latest version unknown. Source checkouts and
other package managers (including Pi/BYZ) retain their installation method; they
are not overwritten. Automatic installation supports macOS Codex's personal local
marketplace and macOS/Linux Claude. Other platforms report the limitation and use
their documented installer. A request to check without upgrading skips this step.
The low-level runtime checker and JS check host remain read-only for CI/install use.

To derive a
test-case draft from an implemented feature, use
`$cm-test {project} {feature} --generate-cases`; to verify it without modifying
source, use `$cm-test`. The installed manual is available at
`~/plugins/cm-workflow/docs/user-guide.md`.
The optional project configuration template is installed at
`~/plugins/cm-workflow/templates/cm-workflow.yml`.

## npm installation (macOS Codex)

Install or upgrade with the same command:

```bash
npx @aibyzero/cm-workflow@latest install
```

To pin a version, use `npx @aibyzero/cm-workflow@0.15.5 install` from outside
the CM Workflow source checkout (for example, your home directory). Inside a
checkout with the same package name and version, npm can select the local
uninstalled package and report `cm-workflow: command not found`.
The dependency-free npm entry requires macOS and Node.js 24.14+, plus the same
Python 3.9+ and Codex plugin helpers as the source installer. It does not remove
these prerequisites or add Windows/Linux support to the npm command.

Maintainers can inspect and try the actual local package:

```bash
npm pack --ignore-scripts
# Substitute the exact .tgz filename printed by npm pack:
npm exec --yes --package ./PACKAGE.tgz -- cm-workflow --help
```

Running `cm-workflow install` through npm installs into the
same `~/plugins/cm-workflow` directory and personal marketplace as the source
installer. Existing installations require confirmation; `install --yes` accepts
replacement. The npm `--yes` before `--package` only accepts npm's package-fetch
prompt; it does not accept plugin replacement. Direct edits to the managed
plugin are overwritten; source checkouts, project code and specs remain outside
the managed destination. Installing older source afterward can downgrade it.
Start a new Codex task after an upgrade. `npx --yes` accepts npm's download
prompt only; `install --yes` separately accepts replacing the managed plugin.

The isolated fixture is `python3 scripts/test-npm-install.py`. It packs the
candidate, exercises the npm command, then relocates only installer path
assignments into a temporary directory. The actual file transaction and bundled
Codex helper programs execute; the final `codex plugin add` is a test double.
It covers fresh install, source-to-package upgrade, declined replacement and
failed registration rollback. It does not prove live registry installation,
real Codex cache ingestion or a fresh-machine setup.

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
it. An interactive install now asks once whether to enable the **announcement** hook
and, on yes, adds that single `hooks.SessionStart` entry for you; it never adds the
background updater, and it never edits `settings.json` without that yes. A refusal is
remembered in `~/.cm-workflow/announce-hook-declined`; delete that file and reinstall
to be asked again. `--yes` and non-interactive installs write nothing and print the
exact entry to add. Announcing a new version and letting the tool replace itself are
separate decisions, so enabling the announcement alone leaves the updater off: with no
updater scheduled there is nothing to announce, so enable it below if you want both. A copy failure is reported as a warning and does not invalidate a core runtime
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

## Runtime declaration at installation

After a successful core install, `install.sh`, `install-codex.sh`, and `install.ps1`
ask which tools you have: Codex only, Claude only, or both. When both are selected,
choose the coder (Codex recommended, Claude reviews; or the reverse).
The shared prompt writes only `~/.cm-workflow/runtimes.yml` using a temporary file
and atomic rename. It never changes settings.json or CLAUDE.md.
An existing declaration is displayed and “Keep it? [Y/n]” (or “保留？[Y/n]”) defaults to keeping it.
`--yes` (Bash), `-Yes` (PowerShell, also implies the existing `-Force`), `-Force`,
or non-TTY input/output skips this prompt without creating or changing the file.

```yaml
# 用 cm-runtime set --user <preset> 修改用户级默认。
runtimes: {available: both}
preset: codex-codes
```

`CM_WORKFLOW_HOME` overrides the `.cm-workflow` directory for isolated testing.
Priority: project declaration > user default > undeclared. An invalid user default
blocks parsing when consulted; an explicit project declaration bypasses it.
The preset supplies coder/reviewer adapter/source defaults; explicit project role
fields still take precedence and conflicts fail validation. `cm-init` inherits the
user default without asking again and reports `来源: 用户级默认`.

Run `$cm-runtime` in Codex, `/cm-runtime` in Claude Code, or `/cm:runtime` on macOS/Linux
without arguments for three questions in your current conversation language:
`[1] Current project / [2] User default` → `[1] Codex only / [2] Claude only / [3] Both`
(with `[1] Codex writes, Claude reviews (recommended) / [2] Claude writes, Codex reviews`
when both are selected) → preview the preset/current value and confirm `[Y/n]`.
In a terminal, `node <workflow-root>/scripts/cm-runtime.mjs [--project PATH]` opens the same wizard.
Scope defaults to 1 with an existing project config, otherwise 2. Choosing 1 without a config
announces creation from the template. The tool question has no default. Ctrl+C, three consecutive
empty answers to that required question, or declining confirmation cancels without writing.
Without a TTY, no command prints usage and exits 2.

Installer prompts, terminal wizard, diagnostics and the user-file comment use Chinese or English:
`CM_WORKFLOW_LANG=zh|en` > `LC_ALL` > `LC_MESSAGES` > `LANG` > Node Intl locale > English fallback.
A locale starting with `zh` selects Chinese; other locales select English. Windows `install.ps1`
passes `(Get-Culture).Name` as the locale. Machine keys, preset/adapter names and exit codes stay unchanged.
For scripting, use explicit commands:

```text
cm-runtime show [--project PATH]
cm-runtime set codex-codes [--project PATH]
cm-runtime set --user claude-codes
cm-runtime unset --user
```

Presets: `codex-only`, `claude-only`, `codex-codes`, `claude-codes`.
For the literal terminal entry, use `node <workflow-root>/scripts/cm-runtime.mjs`.
A project set preserves every unrelated byte in an existing config; a new config
uses the distributed template. Unsetting the user file preserves project declarations.
Changes affect new runs only; existing runs retain their bound configuration.
`show` is read-only and missing CLIs only produce WARN (presence does not prove quota).
Successful `set` records a private `decision/route` through the existing log writer;
Python 3.9+ is required for its platform lock adapter. No installation or network access occurs.
