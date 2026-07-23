#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FAILURES=0

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

require_file() {
  [ -f "$ROOT/$1" ] || fail "missing $1"
}

MODE="unknown"
if [ -f "$ROOT/.codex-plugin/plugin.json" ]; then
  MODE="plugin"
  require_file "VERSION"
  require_file "AGENTS.md"
  require_file "install-codex.sh"
elif [ -f "$ROOT/templates/cm-VERSION" ]; then
  MODE="claude-compat"
else
  fail "cannot determine installation mode (missing plugin manifest and templates/cm-VERSION)"
fi
require_file "runtime/project-context.md"
require_file "runtime/orchestration.md"
require_file "runtime/review.md"

for asset in \
  templates/arch-reference.md \
  templates/hooks/pre-commit-cm-task-check \
  templates/pixel/cm-pixel.sh \
  templates/pixel/serve.sh \
  templates/refactor/cm-refactor-denies.json \
  templates/rules/finance.md \
  templates/ui-lens/cm-ui-lens-extract.mjs; do
  require_file "$asset"
done

for name in cm-idea cm-init cm-prd cm-ai cm-fix cm-refactor cm-check; do
  require_file "skills/$name/SKILL.md"
  require_file "compat/claude-commands/$name.md"
  wrapper="$ROOT/compat/claude-commands/$name.md"
  if [ -f "$wrapper" ]; then
    grep -q "skills/$name/SKILL.md" "$wrapper" || fail "legacy wrapper does not delegate to $name"
    [ "$(wc -l < "$wrapper" | tr -d ' ')" -le 8 ] || fail "legacy wrapper is not thin: compat/claude-commands/$name.md"
  fi
done

for mode in greenfield brownfield change-mode; do
  require_file "skills/cm-prd/references/$mode.md"
done

for node in N1-init N2-enter-feature N3-execute-task N4-review N5-mark-done N6-qa-eval N7-context N8-finish; do
  require_file "skills/cm-ai/references/$node.md"
done

while IFS= read -r skill; do
  dir="$(basename "$(dirname "$skill")")"
  declared="$(sed -n 's/^name:[[:space:]]*//p' "$skill" | head -n 1 | tr -d '\r\"')"
  [ "$declared" = "$dir" ] || fail "skill name mismatch: ${skill#$ROOT/} declares '$declared'"
done < <(find "$ROOT/skills" -mindepth 2 -maxdepth 2 -name SKILL.md -type f | sort)

if [ "$MODE" = "plugin" ]; then
  version="$(tr -d '[:space:]' < "$ROOT/VERSION")"
  manifest_version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"].split("+")[0])' "$ROOT/.codex-plugin/plugin.json")"
  [ "$version" = "$manifest_version" ] || fail "VERSION $version != plugin $manifest_version"
else
  version="$(tr -d '[:space:]' < "$ROOT/templates/cm-VERSION")"
fi

if [ -d "$ROOT/skills/cm-ai" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] || fail "Claude-only invocation in Codex flow: $hit"
  done < <(grep -RInE 'TaskCreate|TodoWrite|codex:review|CLAUDE_CODE_EXPERIMENTAL|~/.claude/commands' \
    "$ROOT/skills/cm-ai" "$ROOT/skills/cm-prd" "$ROOT/skills/cm-fix" "$ROOT/skills/cm-refactor" 2>/dev/null || true)
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "cm runtime check: FAILED ($FAILURES)" >&2
  exit 1
fi

echo "cm runtime check: PASSED ($MODE v$version)"
