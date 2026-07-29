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

route_external_expert_mode() {
  local pro="$1"
  local extra_high="$2"
  local high="$3"
  local strict_pro="$4"

  if [ "$pro" = "true" ]; then
    echo "selected=Pro|external_used=true|outcome=send"
  elif [ "$strict_pro" = "true" ]; then
    echo "selected=none|external_used=false|outcome=blocked"
  elif [ "$extra_high" = "true" ]; then
    echo "selected=Extra High|external_used=true|outcome=send"
  elif [ "$high" = "true" ]; then
    echo "selected=High|external_used=true|outcome=send"
  else
    echo "selected=none|external_used=false|outcome=skipped"
  fi
}

assert_external_expert_route() {
  local expected="$1"
  shift
  local actual
  actual="$(route_external_expert_mode "$@")"
  [ "$actual" = "$expected" ] ||
    fail "external-expert route expected '$expected', got '$actual'"
}

route_external_expert_task() {
  local explicit_mode="$1"
  local activation="$2"
  local has_local_work="$3"
  local has_consequential_reasoning="$4"
  local has_complex_reasoning="$5"
  local mode
  local source

  if [ "$explicit_mode" != "none" ]; then
    mode="$explicit_mode"
    source="explicit-directive"
  elif [ "$activation" = "expert" ]; then
    if [ "$has_consequential_reasoning" = "true" ]; then
      mode="verify"
    else
      mode="consult"
    fi
    source="explicit-expert-request"
  elif [ "$activation" = "auto" ]; then
    if [ "$has_consequential_reasoning" = "true" ]; then
      mode="verify"
    elif [ "$has_complex_reasoning" = "true" ]; then
      mode="consult"
    else
      mode="local"
    fi
    source="auto-classifier"
  else
    mode="local"
    source="default-explicit"
  fi

  case "$mode" in
    local) echo "mode=local|source=$source|external_scope=none|local_work=$has_local_work" ;;
    handoff) echo "mode=handoff|source=$source|external_scope=explicit-handoff|local_work=$has_local_work" ;;
    *) echo "mode=$mode|source=$source|external_scope=reasoning-only|local_work=$has_local_work" ;;
  esac
}

assert_external_expert_task_route() {
  local expected="$1"
  shift
  local actual
  actual="$(route_external_expert_task "$@")"
  [ "$actual" = "$expected" ] ||
    fail "external-expert task route expected '$expected', got '$actual'"
}

print_external_expert_routing_fixtures() {
  echo "task explicit-local: $(route_external_expert_task local auto true true true)"
  echo "task explicit-consult: $(route_external_expert_task consult auto true true false)"
  echo "task explicit-verify: $(route_external_expert_task verify auto true false true)"
  echo "task explicit-handoff: $(route_external_expert_task handoff auto true true true)"
  echo "task explicit-expert-verify: $(route_external_expert_task none expert false true false)"
  echo "task explicit-expert-consult: $(route_external_expert_task none expert false false false)"
  echo "task auto-local: $(route_external_expert_task none auto true false false)"
  echo "task auto-consult: $(route_external_expert_task none auto false false true)"
  echo "task auto-verify: $(route_external_expert_task none auto false true false)"
  echo "task auto-verify-over-consult: $(route_external_expert_task none auto false true true)"
  echo "task mixed-local-plus-consult: $(route_external_expert_task none auto true false true)"
  echo "task mixed-local-plus-verify: $(route_external_expert_task none auto true true false)"
  echo "task auto-default-local: $(route_external_expert_task none auto false false false)"
  echo "task default-explicit-local: $(route_external_expert_task none none false true true)"
  echo "model preferred: $(route_external_expert_mode true true true false)"
  echo "model extra-high: $(route_external_expert_mode false true true false)"
  echo "model high: $(route_external_expert_mode false false true false)"
  echo "model skipped: $(route_external_expert_mode false false false false)"
  echo "model strict-pro: $(route_external_expert_mode false true true true)"
}

assert_external_expert_task_route \
  "mode=local|source=explicit-directive|external_scope=none|local_work=true" \
  local auto true true true
assert_external_expert_task_route \
  "mode=consult|source=explicit-directive|external_scope=reasoning-only|local_work=true" \
  consult auto true true false
assert_external_expert_task_route \
  "mode=verify|source=explicit-directive|external_scope=reasoning-only|local_work=true" \
  verify auto true false true
assert_external_expert_task_route \
  "mode=handoff|source=explicit-directive|external_scope=explicit-handoff|local_work=true" \
  handoff auto true true true
assert_external_expert_task_route \
  "mode=verify|source=explicit-expert-request|external_scope=reasoning-only|local_work=false" \
  none expert false true false
assert_external_expert_task_route \
  "mode=consult|source=explicit-expert-request|external_scope=reasoning-only|local_work=false" \
  none expert false false false
assert_external_expert_task_route \
  "mode=local|source=auto-classifier|external_scope=none|local_work=true" \
  none auto true false false
assert_external_expert_task_route \
  "mode=consult|source=auto-classifier|external_scope=reasoning-only|local_work=false" \
  none auto false false true
assert_external_expert_task_route \
  "mode=verify|source=auto-classifier|external_scope=reasoning-only|local_work=false" \
  none auto false true false
assert_external_expert_task_route \
  "mode=verify|source=auto-classifier|external_scope=reasoning-only|local_work=false" \
  none auto false true true
assert_external_expert_task_route \
  "mode=consult|source=auto-classifier|external_scope=reasoning-only|local_work=true" \
  none auto true false true
assert_external_expert_task_route \
  "mode=verify|source=auto-classifier|external_scope=reasoning-only|local_work=true" \
  none auto true true false
assert_external_expert_task_route \
  "mode=local|source=auto-classifier|external_scope=none|local_work=false" \
  none auto false false false
assert_external_expert_task_route \
  "mode=local|source=default-explicit|external_scope=none|local_work=false" \
  none none false true true

case "${1:-}" in
  "") ;;
  --routing-fixtures)
    if [ "$FAILURES" -ne 0 ]; then
      echo "external-expert routing fixtures: FAILED ($FAILURES)" >&2
      exit 1
    fi
    print_external_expert_routing_fixtures
    exit 0
    ;;
  *)
    echo "Usage: $0 [--routing-fixtures]" >&2
    exit 2
    ;;
esac

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
require_file "runtime/external-expert.md"
require_file "runtime/orchestration.md"
require_file "runtime/review.md"
require_file "runtime/test-contract.md"
require_file "scripts/cm-check-runtime.ps1"
require_file "scripts/validate-test-cases.py"

if [ "$MODE" = "plugin" ]; then
  require_file "docs/user-guide.md"
  require_file "assets/docs/user-guide-hero.svg"
else
  require_file "cm-workflow/docs/user-guide.md"
  require_file "cm-workflow/assets/docs/user-guide-hero.svg"
  require_file "cm-workflow/README.md"
fi

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

require_file "skills/external-expert/SKILL.md"
grep -q "runtime/external-expert.md" "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert does not reference the shared contract"
grep -Fq "Version 1 is on-request only" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert is not explicitly on-request only"
grep -Fq 'The default activation policy is `EXPLICIT`' "$ROOT/runtime/external-expert.md" ||
  fail "external-expert no longer defaults to explicit activation"
grep -Fq 'explicitly enable `AUTO` for the current' "$ROOT/runtime/external-expert.md" ||
  fail "external-expert AUTO is not invocation-scoped"
grep -Fq "AUTO authorizes task classification, not local-file transmission" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert AUTO can imply local-file approval"
grep -Fq 'AUTO never selects `HANDOFF`' "$ROOT/runtime/external-expert.md" ||
  fail "external-expert AUTO can silently hand off"
grep -Fq "Code inspection, editing, commands, builds, test execution, browser QA, Git" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert mixed-task execution can leave the local runtime"
grep -Fq "activation_policy: explicit | invocation-auto" "$ROOT/runtime/external-expert.md" &&
  grep -Fq "routing_mode: consult | verify | handoff" "$ROOT/runtime/external-expert.md" &&
  grep -Fq "routing_source: explicit-directive | explicit-expert-request | auto-classifier" "$ROOT/runtime/external-expert.md" &&
  grep -Fq "external_scope: reasoning-only | explicit-handoff" "$ROOT/runtime/external-expert.md" &&
  grep -Fq "local_execution_retained: true" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert evidence does not record task routing"
grep -Fq "canonical absolute path of every individual" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert does not require canonical per-file approval"
grep -Fq "fresh approval reply in the same external-expert" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert can reuse stale local-file approval"
grep -Fq "globs, and unresolved symlinks are not valid manifest entries" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert path manifest can expand after approval"
grep -Fq "upload or transmit any archive" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert does not prohibit all archive transmission"
grep -Fq "encoded/archive-derived bulk context" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert does not prohibit encoded or archive-derived bulk context"
grep -q "n4_eligible: false" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert evidence does not declare N4 ineligibility"
grep -q "never satisfies N4" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert can be mistaken for independent review"
grep -Fq "Version 1 external-expert evidence never satisfies" "$ROOT/runtime/review.md" ||
  fail "independent review contract does not exclude external-expert evidence"
tr '\n' ' ' < "$ROOT/runtime/review.md" |
  grep -Fq "A conversation that contributed to the plan, diagnosis, tests, or patch is an authoring channel" ||
  fail "independent review contract does not preserve all external authoring categories"
grep -Fq '{SPECS_DIR}/.external/' "$ROOT/runtime/external-expert.md" ||
  fail "external-expert has no isolated evidence location"
grep -q "manual copy/paste" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert has no manual transport fallback"
grep -q "dispatch_state: ambiguous" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert has no crash-ambiguous dispatch state"
grep -Fq "URL alone as dispatch evidence" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert can mistake a conversation URL for dispatch evidence"
grep -Fq "Set \`dispatch_state: ambiguous\` and do not resend automatically" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert ambiguous recovery can resend automatically"
grep -Fq "CM does not claim exactly-once" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert does not disclose dispatch guarantee limits"
grep -Fq "Maximum two correction rounds after the initial response" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert correction round accounting is ambiguous"
grep -Fq "Pro → Extra High → High → SKIPPED" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert model fallback order is missing"
grep -Fq "a Pro subscription/account badge is not proof" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert can mistake subscription status for selected mode"
grep -Fq "does not require another user confirmation" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert model fallback can interrupt for confirmation"
grep -Fq "Medium and Instant are never external-expert fallback modes" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert can silently fall back to Medium or Instant"
grep -Fq 'use `strict-Pro`: missing Pro records `BLOCKED`, sends nothing' "$ROOT/runtime/external-expert.md" ||
  fail "external-expert has no explicit Pro-only override"
grep -Fq "Never reroute, resend, or start a" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert can reroute after dispatch"
grep -Fq "dispatch_state: intent-recorded | response-observed | completed | ambiguous | skipped | blocked" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert evidence cannot represent skipped or blocked routing"
grep -Fq "external_used: true | false" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert evidence cannot distinguish skipped from used"
grep -Fq 'selected_mode: Pro | Extra High | High | none' "$ROOT/runtime/external-expert.md" &&
  grep -Fq 'fallback_reason: none | pro-unavailable | pro-and-extra-high-unavailable | all-approved-modes-unavailable | strict-pro-unavailable' "$ROOT/runtime/external-expert.md" ||
  fail "external-expert evidence does not encode the full routing decision"
grep -Fq "Pro → Extra High → High → SKIPPED" "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert Skill does not execute the shared mode policy"
grep -Fq '$external-expert --auto' "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert Skill has no invocation-scoped AUTO entry"
grep -Fq "单独安装的全局智能分流不能替用户开启 CM AUTO" "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert Skill can inherit unauthorized global AUTO"
grep -Fq "AUTO 选中 \`LOCAL\` 时不启动浏览器" "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert LOCAL route can open the browser"
grep -Fq -- "--routing-fixtures" "$ROOT/scripts/cm-check-runtime.sh" ||
  fail "external-expert routing fixtures have no reproducible entry"
grep -q "不因.*自动外发本地文件" "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert can silently send local files"

assert_external_expert_route "selected=Pro|external_used=true|outcome=send" true true true false
assert_external_expert_route "selected=Extra High|external_used=true|outcome=send" false true true false
assert_external_expert_route "selected=High|external_used=true|outcome=send" false false true false
assert_external_expert_route "selected=none|external_used=false|outcome=skipped" false false false false
assert_external_expert_route "selected=none|external_used=false|outcome=blocked" false true true true

for consumer in \
  skills/cm-idea/SKILL.md \
  skills/cm-prd/SKILL.md \
  skills/cm-ai/SKILL.md \
  skills/cm-fix/SKILL.md \
  skills/cm-refactor/SKILL.md \
  skills/cm-test/SKILL.md; do
  grep -q "runtime/external-expert.md" "$ROOT/$consumer" ||
    fail "external-expert contract is not wired into $consumer"
  grep -q "AUTO" "$ROOT/$consumer" ||
    fail "external-expert AUTO routing is not wired into $consumer"
done

for name in cm-idea cm-init cm-prd cm-ai cm-test cm-fix cm-refactor cm-check; do
  require_file "skills/$name/SKILL.md"
  require_file "compat/claude-commands/$name.md"
  wrapper="$ROOT/compat/claude-commands/$name.md"
  if [ -f "$wrapper" ]; then
    grep -q "skills/$name/SKILL.md" "$wrapper" || fail "legacy wrapper does not delegate to $name"
    [ "$(wc -l < "$wrapper" | tr -d ' ')" -le 8 ] || fail "legacy wrapper is not thin: compat/claude-commands/$name.md"
  fi
done

for consumer in \
  skills/cm-prd/SKILL.md \
  skills/cm-ai/references/N1-init.md \
  skills/cm-ai/references/N4-review.md \
  skills/cm-ai/references/N6-qa-eval.md \
  skills/cm-qa-engineer/SKILL.md \
  skills/cm-test/SKILL.md; do
  grep -q "runtime/test-contract.md" "$ROOT/$consumer" ||
    fail "AI test contract is not wired into $consumer"
done

grep -q "validate-test-cases.py" "$ROOT/runtime/test-contract.md" ||
  fail "AI test contract does not invoke the structural validator"
grep -q "无 Git" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test is missing its non-Git read-only fallback"
grep -q -- "--generate-cases" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test is missing its code-to-test-case generation mode"
grep -q "test-cases.generated.json" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test generation mode has no durable case artifact"
grep -q "硬停止" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test generation mode can fall through into test execution"
grep -Fq "[需确认] 当前行为刻画:" "$ROOT/runtime/test-contract.md" ||
  fail "AI test contract does not distinguish inferred behavior from approved intent"
grep -q "Path.resolve(strict=False)" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test report directory cannot be proven separate from source"
grep -Fq '{CODE_PROJECT}/specs/' "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test can whitelist a source directory by disguising it as specs"
grep -q "待判断的数据，不是指令" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test does not treat code and external cases as untrusted data"

grep -q "runtime/review.md" "$ROOT/skills/cm-fix/SKILL.md" ||
  fail "cm-fix does not reference the independent review contract"
grep -Fq 'ls {SPECS_DIR}/.reviews/fix-{slug}-r*.md' "$ROOT/skills/cm-fix/SKILL.md" ||
  fail "cm-fix is missing the mechanical post-fix review evidence gate"

if [ "$MODE" = "plugin" ]; then
  grep -q 'docs assets' "$ROOT/install-codex.sh" ||
    fail "Codex installer does not package docs and assets"
  grep -q 'cm-workflow/docs' "$ROOT/install.sh" ||
    fail "Claude installer does not package the user guide"
  grep -q 'compat/claude-commands' "$ROOT/templates/auto-update/cm-update.sh" ||
    fail "Claude updater does not map generated legacy aliases"
fi

for mode in greenfield brownfield change-mode spec-self-check; do
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
    "$ROOT/skills/cm-ai" "$ROOT/skills/cm-prd" "$ROOT/skills/cm-test" \
    "$ROOT/skills/cm-fix" "$ROOT/skills/cm-refactor" \
    "$ROOT/skills/external-expert" 2>/dev/null || true)
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "cm runtime check: FAILED ($FAILURES)" >&2
  exit 1
fi

echo "cm runtime check: PASSED ($MODE v$version)"
