# CM project-context contract

This contract is shared by every CM workflow skill. Resolve paths from the active `SKILL.md`; never assume where Codex cached or installed the plugin.

## Workflow root

1. Let `SKILL_DIR` be the directory containing the active CM `SKILL.md`.
2. The workflow root is normally `SKILL_DIR/../..`.
3. Verify the candidate root contains `VERSION`, `templates/`, and `runtime/` before using it.
4. If a user explicitly provides `CM_WORKFLOW_HOME`, prefer it after the same verification.
5. Do not hardcode `~/.codex/plugins/cache`, `~/.agents/skills`, or `~/.claude` as the workflow root.

This relative rule works both from a Codex plugin (`<plugin>/skills/<name>/SKILL.md`) and the legacy Claude installation (`~/.claude/skills/<name>/SKILL.md`).

## Target project context

Read context in this order:

1. The `AGENTS.md` chain already supplied by Codex. If working outside Codex, read the nearest applicable `AGENTS.md` files from repository root to the current directory.
2. The target project `.claude/CLAUDE.md`, when present, as a compatibility project map.
3. Only the `.claude/rules/*.md` files relevant to the current task, plus `coding-style.md`, `testing.md`, and `security.md` when present.
4. The target specs files named by the active workflow.

When `AGENTS.md` and `.claude/CLAUDE.md` disagree, follow the more specific instruction that applies to the current path, unless it weakens a safety boundary. Record material conflicts in the task report.

## `cm-init` output

For an existing project, `cm-init` maintains both surfaces:

- Root `AGENTS.md`: concise Codex-native project expectations, commands, safety boundaries, and an instruction to read relevant compatibility rules.
- `.claude/CLAUDE.md` plus `.claude/rules/`: the existing CM/Claude compatibility contract.

If either surface already exists, preserve user-authored content. Propose a merge or add a clearly bounded CM section; never overwrite the whole file without explicit approval.

## Resource references

Workflow templates live under `<workflow-root>/templates/`. Flow-specific references live beside the active skill under `references/`. Always open referenced files from those resolved locations instead of relying on a user-level installation path.
