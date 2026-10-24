# Installation

单任务外部模型的可选配置入口见 [外部模型配置](external-models.md)。配置向导不会安装、
切换当前宿主模型或迁移运行；本阶段需在合法单任务计划显式启用。

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

To pin a version, use `npx @aibyzero/cm-workflow@0.17.1 install` from outside
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
prompt; it does not accept plugin replacement. Files of the managed plugin that
were edited after the last install stop the replacement (see
[Local edits, install lock and known limitations](#local-edits-install-lock-and-known-limitations));
files the installer never recorded are removed with the old plugin directory.
Source checkouts, project code and specs remain outside the managed destination. Installing older source afterward can downgrade it.
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

Both Bash installers refuse to discard local edits; see
[Local edits, install lock and known limitations](#local-edits-install-lock-and-known-limitations).

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

### Claude Code 权限建议（可选）

安装器把 CM 脚本放在 `$CLAUDE_HOME/scripts/`（默认 `~/.claude/scripts/`），不会代改项目的 `.claude/settings.json`。如需减少普通驱动调用的重复提示，可由项目所有者审阅后在项目配置中添加以下示例；自定义 `CLAUDE_HOME` 时替换路径：

```json
{
  "permissions": {
    "allow": [
      "Bash(node ~/.claude/scripts/cm-ai-drive.mjs:*)",
      "Bash(node ~/.claude/scripts/cm-ai-batch-drive.mjs:*)",
      "Bash(node ~/.claude/scripts/cm-fix-drive.mjs:*)",
      "Bash(node ~/.claude/scripts/cm-prd-drive.mjs:*)",
      "Bash(node ~/.claude/scripts/cm-ai-host.mjs --help)"
    ]
  }
}
```

这只是启动命令的建议规则，不是 CM 的运行授权；计划文件里的操作与权限仍须逐项审查。覆盖旧审查证据的 `--supersede-reviewed-evidence`、保留前驱代码漂移的 `--accept-superseded-code-drift`、SwiftPM 的 `--disable-sandbox`、QA 重跑的 `--rerun-unknown-qa`／`--rerun-blocked-qa`、放弃审查的 `--allow-abandon-review`，以及修改权限配置，都应由用户针对本次动作确认。尤其 `--supersede-reviewed-evidence` 和 `--accept-superseded-code-drift` 可以写在驱动的 `PLAN.permissions` 中，单凭上面的 Bash 通配规则无法识别；无法逐次审阅计划时，不要启用这些通配规则。要试改驱动脚本，请把副本放在项目或临时工作目录，不在 `~/.claude/scripts/` 原地编辑。若组织级权限策略继续拒绝，即使项目规则允许也应遵循该策略。

## Local edits, install lock and known limitations

Applies to `install.sh` and `install-codex.sh` (not `install.ps1`).

**Install manifest.** A successful install records the sha256 of each core file
it wrote: `<CLAUDE_HOME>/cm-workflow/install-manifest.sha256` (default
`~/.claude/...`) and `~/plugins/cm-workflow/.cm-install-manifest.sha256`.
`__pycache__` and `.DS_Store` files are copied but not recorded, and the optional
updater scripts in `~/.cm-workflow` are outside the core install and the manifest.
A file name containing a backslash is refused.

**Local edits.** On reinstall, a recorded file that still exists but whose
sha256 changed is a local edit. A symlink, a directory, or a symlinked parent at
a recorded path also counts. The installer lists the files and exits with
status 3; `--yes` and an interactive `y` do not bypass this. Pass
`--overwrite-local-edits` only to discard those edits. A manifest that is
malformed or not a regular file also stops the install, and so does any
check that cannot read its own files or cannot search a directory holding a
recorded file (that is never taken as "deleted"). Without a previous
manifest (first install or an older version) the check is skipped with a
notice, so edits made before the first manifest cannot be detected. A recorded
file that was deleted is not treated as an edit.

The check runs before anything is written, again after the overwrite prompt,
and again in the middle of the transaction:

| Installer | When the late check finds a change | What is left |
| ---- | ---- | ---- |
| `install.sh` | Right before each file is copied (content, file type and parent path) | Exit 3 after files were already written: the files written so far are rolled back; the changed file is untouched |
| `install-codex.sh` | After the old plugin directory is renamed aside | Exit 3: the old directory is moved back and the marketplace restored |

The npm entry and `$cm-check` automatic upgrades only pass `--yes`. When the
installer stops for local edits, `$cm-check` reports the upgrade as `blocked`
(its CLI exits 1, not 3). Save your edits, then run the Bash installer yourself
with `--overwrite-local-edits` if you want to discard them.

**Install lock.** One install per real target at a time. The lock is a
directory next to the target named `.<target name>.cm-install.lock`:
`~/..claude.cm-install.lock` for the default Claude target (two dots: the target
name itself starts with a dot) and `~/plugins/.cm-workflow.cm-install.lock` for
Codex. Paths are resolved to their physical location first, so `CLAUDE_HOME`
spellings such as `~/.claude/.` and a Claude install aimed at
`~/plugins/cm-workflow` share the same lock. A second install exits with status 4
and names the holder pid, its start time and whether it is still running. A
leftover lock is never taken over automatically: the installer prints a
shell-quoted `rm -rf` command to run after you confirm no install is in progress.
The lock is released on success, on failure, and on HUP/INT/TERM, including a
signal sent to the whole process group: the lock `mkdir` and the Codex rename run
with those signals ignored, so their result is always recorded before the
installer exits.

**Paths.** The install root must not be a symlink (`CLAUDE_HOME=/link/.` is
refused); its parent directories are resolved with `pwd -P`. For Codex,
`~/plugins`, `~/plugins/cm-workflow`, `~/.agents`, `~/.agents/plugins` and
`marketplace.json` must not be symlinks, and the marketplace must be a regular
file. Use real directories at those paths. The marketplace and its two parent
directories are checked again right before the marketplace is written and right
before a rollback writes it back; if a rollback finds the wrong type there, it
writes nothing, reports the rollback as incomplete and keeps the marketplace
backup.

**Rollback.** A failed install restores what it wrote. It trusts only complete
records of its own list of written files that name a file this install manages;
a record cut short (for example by a full disk) or an unknown one is not used and
makes the rollback incomplete. If a restore step itself
fails, the installer still tries the remaining steps and releases the lock, reports
that the rollback is incomplete (`回滚不完整` / `rollback is incomplete`), and keeps the recovery copies
(`.cm-claude.backup.<pid>` next to the Claude target, holding the previous files
and `.cm-previous-install-manifest`; for Codex the listed backup, failed-plugin
and marketplace-backup paths under `~/plugins`).
If `~/plugins` itself cannot be searched when a Codex install fails, the
installer cannot tell what is there: it restores nothing under it, reports the
rollback as incomplete, prints the expected recovery paths, and leaves the lock
for you to remove after restoring access.

Protection boundary (decided for this feature):

> 安装器以用户本人账号运行，「安装进行途中有人故意把受管目录或其父目录替换成符号链接」不在本功能防护范围内——能这样做的人本来就能直接改家目录任何文件，安装器挡不住。本功能要防的是别的会话手改已装文件后被静默覆盖。入口处已有的静态链接拒绝保留。

In English: the installers run as you. Deliberately swapping a managed directory
or one of its parents for a symlink while an install runs is out of scope,
because whoever can do that can already change any file in your home directory.
This feature protects files that another session edited from being silently
overwritten. The symlink refusals at the entry checks stay.

Known limitations:

| Limitation | Why / what to do |
| ---- | ---- |
| No atomic exclusion against people editing files | A file can still change between its check and its copy, and a rollback can overwrite an edit made to a file after it was written. Do not edit installed CM files while an install runs. |
| Readers see the transaction | `install.sh` copies file by file, so a running CM session can read a mix of versions or a half-written file; `install-codex.sh` leaves the plugin directory briefly missing between its two renames. Finish active CM tasks first, then start a new session after installing. |
| SIGKILL, power loss, kernel or storage failure | The exit trap cannot run and there is no persistent recovery journal. The lock and the backup directory may remain; recover by hand using them. |
| No manifest yet; deleted and unrecorded files | Without a manifest nothing can be judged. A deleted recorded file is not an edit. Codex replaces the whole directory, so unrecorded files you added there are removed; Claude leaves files it does not install in place. |
| Windows and the optional updater | `install.ps1` has none of this protection. `~/.cm-workflow/cm-update.sh` and `cm-announce.sh` are not in the manifest. |
| No forced overwrite from npm or `$cm-check` | Intentional: they stop on local edits; run the Bash installer yourself to discard edits. |
| `~/.cm-workflow/cm-update.sh` deletes first | The optional auto-updater uses its own lock and older path list and deletes files removed upstream before it runs `install.sh`, outside this lock and check. It can delete a file and then stop on a local edit. |
| Other marketplace writers and Codex internal state | The lock only coordinates CM installers. Do not manage other Codex plugins while CM installs: a rollback restores the whole previous `marketplace.json`. Cleanup does not undo Codex cache or registration side effects of `codex plugin add`. |
| Directories replaced while an install runs | Out of scope (see the boundary above). Partial checks remain: the marketplace structure is re-checked before its directory is first created, before it is written and before a rollback writes it; the Codex local-edit checks stop with status 2 when `~/plugins` is no longer the physical directory resolved at start, and then the lock is not deleted through the replaced path (remove it by hand). Other write points are not re-checked. |
| Temporary manifest | `install.sh` writes the new manifest to a random `.install-manifest.XXXXXX` file created by `mktemp` next to it and removes only that file on failure. |
| File names | The manifest is line based; names containing a newline or a backslash are not supported. |
| Test hook | `CM_INSTALL_TEST_HOOK` exists for the repository's fault-injection tests. It is unset normally; when set, the installer runs that program at fixed points, so never set it outside tests. |

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

## Optional companion skills (Matt Pocock)

CM recommends twelve skills from [mattpocock/skills](https://github.com/mattpocock/skills)
(MIT) for work between CM stages, such as grilling a plan before `cm-prd` or finding
refactoring opportunities before `cm-refactor`. CM never depends on them and never
downloads them on its own. After installing, `install.sh` and `install-codex.sh`
list the ones missing from `~/.claude/skills` and `~/.agents/skills` and print one
command; later installs shorten this to one line while the same set is missing.
`/cm-check` reports the same status.

To install them, run the printed command, for example:

```bash
node ~/.claude/scripts/cm-matt-skills.mjs install
```

The command fetches only commit `5beb35b` into a private temporary repository,
reads files straight from git without a checkout, and checks every file and the
upstream `LICENSE` against the SHA-256 list built into the script. Any mismatch,
extra or missing file, or non-regular file aborts the whole install before
anything is written. Each skill is copied with `LICENSE` into both skill
directories; a skill whose name already exists is skipped and reported, never
overwritten, and a skills directory that is not a usable directory is reported
as a failure. Nothing downloaded is executed: git runs without your git
configuration, hooks or credential helpers, over https or local paths only;
proxy settings are taken from `https_proxy`-style environment variables.
`--source <https URL or path>` uses a mirror, which must serve the pinned commit
by id; the commit and checksums still apply. Start a new session to see newly
installed skills.

## Optional skill hints (trial)

A `UserPromptSubmit` hook that reads each message you type, matches it against a
keyword table and, when a skill fits, asks the model to mention it in one line at
the end of its reply. It only hints; it never runs a skill. Matching is local
keyword and optional regex matching: nothing is sent anywhere and no tokens are
spent on it. Messages over 2000 characters and text inside ``` fences are
skipped, at most two skills are hinted per message, and each skill at most once
per session. Sessions that CM itself launches set `CM_SKILL_HINTS=off`.

The installer does not enable it yet. To try it:

```bash
node ~/.claude/scripts/cm-skill-hints.mjs enable
```

This copies the script, CM's table and the author-skill checker
(`cm-matt-skills.mjs`) to `~/.cm-workflow/skill-hints/` and adds
one `UserPromptSubmit` hook to `~/.claude/settings.json` and `~/.codex/hooks.json`
(`--claude` or `--codex` for one side), keeping every other setting and hook. A
file it cannot parse is left untouched. Codex asks you to trust the new hook the
first time it runs; CM does not trust it for you. If the file changes while
`enable` is writing it, nothing is written and you are asked to run it again. Run
`enable` again after updating CM to refresh the copied table.

Your own rules live in `~/.cm-workflow/skill-hints.local.json`, which CM never
overwrites. They take precedence over CM's table:

```json
{
  "enabled": true,
  "disable": ["fix-bug"],
  "rules": [
    {"id": "my-review", "skill": "codex-review", "keywords": ["二审", "交叉审查"], "reason": "让 Codex 独立审一遍"}
  ]
}
```

`"enabled": false` turns hints off; `disable` lists CM rule ids to switch off; a
user rule with the same `id` as a CM rule replaces it. `patterns` (regular
expressions) share a 200 ms budget per message; past it they count as no match. An
author skill (`grill-me`, `handoff`, `wayfinder`) is only hinted when its pinned
author version (see above) is installed for that host; otherwise its CM
counterpart is hinted, if there is one. Per-session state (a few hundred bytes
each, under `~/.cm-workflow/skill-hints/state/`) is never removed, so a session
resumed later does not repeat a hint.
`~/.cm-workflow/logs/skill-hints.jsonl` records rule id, skill, host and time of
each hint and of each adoption (you typed the skill within the next five
messages), never message text; it drops its older half past 1 MB. `/cm-check`
reports whether the hook is wired, the switch and the rule counts.

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
offer an optional user-default setup. First-time setup defaults to skipping; an existing
declaration is displayed and “Keep it? [Y/n]” defaults to keeping it.
Only opting in asks which tools you have: Codex only, Claude only, or both, and which
tool codes when both are selected. Preview the target, fields and impact, then explicitly
confirm `[y/N]` to save. Enter at this final step does not save.
The shared prompt writes only `~/.cm-workflow/runtimes.yml` using a temporary file
and atomic rename. It never changes settings.json or CLAUDE.md.
An invalid existing declaration is reported and preserved; setup does not overwrite it.
Configuration changes after the preview invalidate that confirmation and require a fresh preview.
The installer checks user defaults only, not effective configuration in individual projects.
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
without arguments to display current effective configuration, source and model aliases. Choose:
`[1] Keep current configuration (recommended, default)`, `[2] Change runtime preset`, or
`[3] Advanced model configuration` (documentation and validation only). Keeping missing
configuration does not create any file. Only option 2 starts the wizard:
`[1] Current project / [2] User default` → `[1] Codex only / [2] Claude only / [3] Both`
(with `[1] Codex writes, Claude reviews (recommended) / [2] Claude writes, Codex reviews`
when both are selected) → preview the fields and effective impact and confirm `[y/N]`.
In a terminal, `node <workflow-root>/scripts/cm-runtime.mjs [--project PATH]` opens the same wizard.
Scope defaults to 1 with an existing project config, otherwise 2. Choosing 1 without a config
announces creation from the template. The tool question has no default. Ctrl+C, three consecutive
empty answers to that required question, EOF, declining confirmation or Enter at confirmation
cancels without writing. Invalid configuration is reported and preserved, not automatically repaired.
Project overrides are shown explicitly. Model aliases are retained across adapter changes;
validation does not prove provider compatibility, model access or quota.
Without a TTY, no command prints usage and exits 2.

Installer prompts, terminal wizard, diagnostics and the user-file comment use Chinese or English:
`CM_WORKFLOW_LANG=zh|en` > `LC_ALL` > `LC_MESSAGES` > `LANG` > Node Intl locale > English fallback.
A locale starting with `zh` selects Chinese; other locales select English. Windows `install.ps1`
passes `(Get-Culture).Name` as the locale. Machine keys, preset/adapter names and exit codes stay unchanged.
For scripting, use explicit commands:

```text
cm-runtime show [--project PATH]
cm-runtime preview codex-codes [--project PATH] [--json]
cm-runtime set codex-codes [--project PATH] --expect-preview <preview_sha256>
cm-runtime set codex-codes [--project PATH]
cm-runtime set --user claude-codes
cm-runtime unset --user
```

Presets: `codex-only`, `claude-only`, `codex-codes`, `claude-codes`.
For the literal terminal entry, use `node <workflow-root>/scripts/cm-runtime.mjs`.
A project set preserves every unrelated byte in an existing config; a new config
uses the distributed template. Unsetting the user file preserves project declarations.
It is not a reset of all configuration. The conversational wizard uses readonly `preview`
and `set --expect-preview` to bind approval to the displayed inputs. Preserve the same
project working directory, language, runtime and user configuration directory across both calls.
For user defaults, run `preview <preset> --user` in the code project directory to show its
effective overrides. Stale previews must be regenerated and explicitly confirmed again.
Changes affect new runs only; existing runs retain their bound configuration.
`show` is read-only and missing CLIs only produce WARN (presence does not prove quota).
Successful `set` records a private `decision/route` through the existing log writer;
Python 3.9+ is required for its platform lock adapter. No installation or network access occurs.
