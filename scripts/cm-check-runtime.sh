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

find_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done
  return 1
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

PROJECT_PATH="$PWD"
CONFIG_PATH=""
REQUESTED_MODE=""
PRINT_EFFECTIVE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project)
      [ "$#" -ge 2 ] || { echo "Usage: $0 [--project PATH] [--config PATH] [--print-effective] [--routing-fixtures|--log-fixtures]" >&2; exit 2; }
      PROJECT_PATH="$2"
      shift 2
      ;;
    --config)
      [ "$#" -ge 2 ] || { echo "Usage: $0 [--project PATH] [--config PATH] [--print-effective] [--routing-fixtures|--log-fixtures]" >&2; exit 2; }
      CONFIG_PATH="$2"
      shift 2
      ;;
    --routing-fixtures|--log-fixtures)
      [ -z "$REQUESTED_MODE" ] || { echo "Usage: $0 [--project PATH] [--config PATH] [--print-effective] [--routing-fixtures|--log-fixtures]" >&2; exit 2; }
      REQUESTED_MODE="$1"
      shift
      ;;
    --print-effective)
      PRINT_EFFECTIVE=1
      shift
      ;;
    *)
      echo "Usage: $0 [--project PATH] [--config PATH] [--print-effective] [--routing-fixtures|--log-fixtures]" >&2
      exit 2
      ;;
  esac
done

case "$REQUESTED_MODE" in
  "") ;;
  --routing-fixtures)
    if [ "$FAILURES" -ne 0 ]; then
      echo "external-expert routing fixtures: FAILED ($FAILURES)" >&2
      exit 1
    fi
    print_external_expert_routing_fixtures
    exit 0
    ;;
  --log-fixtures)
    if python_bin="$(find_python)"; then
      "$python_bin" "$ROOT/scripts/test-cm-log-event.py"
      exit $?
    fi
    echo "cm global log fixture: FAILED (Python 3 not found)" >&2
    exit 1
    ;;
esac

PYTHON_BIN=""
if PYTHON_BIN="$(find_python)"; then
  :
else
  PYTHON_BIN=""
fi

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
require_file "runtime/logging.md"
require_file "runtime/orchestration.md"
require_file "runtime/review.md"
require_file "runtime/task-gates.md"
require_file "runtime/task-handoff.schema.json"
require_file "runtime/test-contract.md"
require_file "runtime/workflow-config.md"
require_file "runtime/workflow-routing.md"
require_file "scripts/cm-check-runtime.ps1"
require_file "scripts/cm-log-event.py"
require_file "scripts/test-cm-log-event.py"
require_file "scripts/cm-prd-timing.py"
require_file "scripts/test-cm-prd-timing.py"
require_file "scripts/cm-task-gate.py"
require_file "scripts/test-task-gate.py"
require_file "scripts/cm_workflow_config.py"
require_file "scripts/test-workflow-config.py"
require_file "scripts/validate-test-cases.py"
require_file "scripts/cm-spec-manifest.py"
require_file "scripts/test-spec-manifest.py"
require_file "scripts/cm-prd-review-gate.py"
require_file "scripts/test-cm-prd-review-gate.py"

if [ -n "$PYTHON_BIN" ]; then
  "$PYTHON_BIN" "$ROOT/scripts/test-cm-log-event.py" ||
    fail "cm global log fixture failed"
  "$PYTHON_BIN" "$ROOT/scripts/test-cm-prd-timing.py" ||
    fail "cm-prd timing fixture failed"
  "$PYTHON_BIN" "$ROOT/scripts/test-workflow-config.py" ||
    fail "cm workflow config fixture failed"
  "$PYTHON_BIN" "$ROOT/scripts/test-task-gate.py" ||
    fail "cm task gate fixture failed"
  "$PYTHON_BIN" "$ROOT/scripts/test-spec-manifest.py" ||
    fail "cm spec manifest fixture failed"
  "$PYTHON_BIN" "$ROOT/scripts/test-cm-prd-review-gate.py" ||
    fail "cm-prd review recovery fixture failed"
  if [ -n "$PROJECT_PATH" ]; then
    if [ -n "$CONFIG_PATH" ]; then
      if [ "$PRINT_EFFECTIVE" -eq 1 ]; then
        "$PYTHON_BIN" "$ROOT/scripts/cm_workflow_config.py" --project "$PROJECT_PATH" --config "$CONFIG_PATH" --print-effective ||
          fail "project workflow config validation failed"
      else
        "$PYTHON_BIN" "$ROOT/scripts/cm_workflow_config.py" --project "$PROJECT_PATH" --config "$CONFIG_PATH" ||
          fail "project workflow config validation failed"
      fi
    elif [ "$PRINT_EFFECTIVE" -eq 1 ]; then
      "$PYTHON_BIN" "$ROOT/scripts/cm_workflow_config.py" --project "$PROJECT_PATH" --print-effective ||
        fail "project workflow config validation failed"
    else
      "$PYTHON_BIN" "$ROOT/scripts/cm_workflow_config.py" --project "$PROJECT_PATH" ||
        fail "project workflow config validation failed"
    fi
  fi
else
  fail "Python 3 is required for CM global logging"
fi

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
  templates/cm-workflow.yml \
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
tr -d '\r' < "$ROOT/runtime/review.md" | tr '\n' ' ' |
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
grep -Fq '${CM_WORKFLOW_LOG_HOME:-~/.cm-workflow/logs}' "$ROOT/runtime/logging.md" ||
  fail "global logging contract has no stable default root"
grep -Fq "specs log is the portable recovery and audit source of truth" "$ROOT/runtime/logging.md" ||
  fail "global logging can displace the project source of truth"
grep -Fq "global-mirror failure" "$ROOT/runtime/logging.md" ||
  fail "global logging has no project-side degradation rule"
grep -Fq "Never log:" "$ROOT/runtime/logging.md" ||
  fail "global logging contract has no privacy boundary"
grep -Fq 'event-based. Do not add a background heartbeat' "$ROOT/runtime/logging.md" ||
  fail "global logging contract can require a background heartbeat"
grep -Fq '`resource/acquired`' "$ROOT/runtime/logging.md" &&
  grep -Fq '`resource/released`' "$ROOT/runtime/logging.md" &&
  grep -Fq '`resource/cleanup_failed`' "$ROOT/runtime/logging.md" ||
  fail "temporary resource lifecycle is not fully paired"
grep -Fq '`requested_model`, `effective_model`' "$ROOT/runtime/logging.md" ||
  fail "model routing identity is not explicit in the logging contract"
grep -Fq '`test_run/case_start`' "$ROOT/skills/cm-ai/references/N3-execute-task.md" &&
  grep -Fq '`test_run/case_start`' "$ROOT/skills/cm-qa-engineer/SKILL.md" ||
  fail "long-running test case checkpoints are not wired into N3 and QA"
grep -Fq '`resource/acquired`' "$ROOT/skills/cm-ai/references/N8-finish.md" &&
  grep -Fq '`resource/released`' "$ROOT/skills/cm-ai/references/N8-finish.md" &&
  grep -Fq '不得写 `run_done`' "$ROOT/skills/cm-ai/references/N8-finish.md" ||
  fail "N8 does not block completion on unreleased temporary resources"
grep -Fq 'RESOURCE_GUARDED_EVENTS = TERMINAL_EVENTS | {"task_done"}' \
  "$ROOT/scripts/cm-log-event.py" &&
  grep -Fq 'completion blocked by unclosed resources' \
    "$ROOT/scripts/cm-log-event.py" ||
  fail "log writer does not enforce resource closure on completion"
grep -Fq 'TEST_RUN_GUARDED_EVENTS = TERMINAL_EVENTS | {"task_done"}' \
  "$ROOT/scripts/cm-log-event.py" &&
  grep -Fq 'completion blocked by incomplete test_run' \
    "$ROOT/scripts/cm-log-event.py" ||
  fail "log writer does not enforce test_run closure on completion"
grep -Fq '本 Skill 不重复写调用级边界' \
  "$ROOT/skills/cm-qa-engineer/SKILL.md" &&
  grep -Fq 'standalone `$cm-test` 不创建该文件' \
  "$ROOT/skills/cm-qa-engineer/SKILL.md" ||
  fail "QA log ownership or standalone cm-test status boundary is not explicit"
grep -Fq "sensitive log field is forbidden" "$ROOT/scripts/cm-log-event.py" ||
  fail "global log writer does not reject sensitive field names"
grep -Fq -- "--log-fixtures" "$ROOT/scripts/cm-check-runtime.sh" ||
  fail "global logging fixtures have no reproducible entry"

for consumer in \
  skills/cm-prd/SKILL.md \
  skills/cm-ai/SKILL.md \
  skills/cm-fix/SKILL.md \
  skills/cm-refactor/SKILL.md \
  skills/cm-test/SKILL.md \
  skills/external-expert/SKILL.md; do
  grep -q "runtime/logging.md" "$ROOT/$consumer" ||
    fail "global logging contract is not wired into $consumer"
done
for consumer in \
  skills/cm-prd/SKILL.md \
  skills/cm-ai/references/N8-finish.md \
  skills/cm-fix/SKILL.md \
  skills/cm-refactor/SKILL.md \
  skills/cm-test/SKILL.md \
  skills/external-expert/SKILL.md; do
  grep -q "run_done" "$ROOT/$consumer" ||
    fail "terminal run_done is not wired into $consumer"
done

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

for reference in \
  skills/cm-idea/references/idea-to-prd.md \
  skills/cm-idea/references/example-prd.md \
  skills/cm-idea/references/domains/trading.md; do
  require_file "$reference"
done
grep -q "references/idea-to-prd.md" "$ROOT/skills/cm-idea/SKILL.md" ||
  fail "cm-idea does not delegate to its internal interview reference"

if grep -Fq '二开且修改存量模块（方案错误会伤及老功能）' \
  "$ROOT/skills/cm-prd/SKILL.md"; then
  fail "cm-prd still sends every brownfield edit through full design review"
fi
grep -Fq '仅修改存量模块不再单独触发本步' \
  "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq '独立规格审查（方案 + 任务拆分）' \
    "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq '跳过(低风险,并入独立规格审查)' \
    "$ROOT/skills/cm-prd/SKILL.md" ||
  fail "cm-prd low-risk design review merge is not fully wired"

prd_design_review_section=$(sed -n '/^### Step 9\.5:/,/^### Step 10:/p' \
  "$ROOT/skills/cm-prd/SKILL.md")
prd_spec_review_section=$(sed -n '/^### Step 10\.6:/,/^### Step 11:/p' \
  "$ROOT/skills/cm-prd/SKILL.md")
[ "$(printf '%s' "$prd_design_review_section" | grep -Fc 'ROUND_LIMIT=1')" -eq 1 ] &&
  [ "$(printf '%s' "$prd_spec_review_section" | grep -Fc 'ROUND_LIMIT=1')" -eq 1 ] &&
  printf '%s' "$prd_design_review_section" | grep -Fq '后续 10.5 自检' &&
  printf '%s' "$prd_spec_review_section" | grep -Fq '重跑一次 10.5 自检' &&
  printf '%s' "$prd_design_review_section" | grep -Fq '禁止 review → 修正 → 再 review' &&
  printf '%s' "$prd_spec_review_section" | grep -Fq '禁止 review → 修正 → 再 review' &&
  printf '%s' "$prd_design_review_section" | grep -Fq '包括 `self-degraded`' &&
  printf '%s' "$prd_spec_review_section" | grep -Fq '包括 `self-degraded`' &&
  printf '%s' "$prd_design_review_section" | grep -Fq '不得生成 `design-r2.md`' &&
  printf '%s' "$prd_spec_review_section" | grep -Fq '不得生成 `split-r2.md`' &&
  grep -Fq 'cm-prd Step 9.5/10.6 固定为一次审查调用' \
    "$ROOT/runtime/review.md" &&
  grep -Fq 'The rules in this section apply to N4 reviews of implemented task diffs.' \
    "$ROOT/runtime/review.md" &&
  grep -Fq 'Maximum two review rounds per task.' "$ROOT/runtime/review.md" &&
  grep -Fq 'reviewer/independent/at/scope' "$ROOT/runtime/review.md" ||
  fail "cm-prd pre-implementation reviews are not mechanically limited to one round"
printf '%s' "$prd_design_review_section" | grep -Fq 'cm-prd-review-gate.py inspect --stage design' &&
  printf '%s' "$prd_spec_review_section" | grep -Fq 'cm-prd-review-gate.py inspect --stage split' &&
  printf '%s' "$prd_design_review_section" | grep -Fq 'resume_disposition' &&
  printf '%s' "$prd_spec_review_section" | grep -Fq 'resume_disposition' &&
  grep -Fq 'r1 内容哈希漂移' "$ROOT/runtime/review.md" ||
  fail "cm-prd single-round reviews have no crash-safe disposition recovery gate"

require_file "skills/cm-prd/references/context-scope.md"
grep -Fq 'references/context-scope.md' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq 'CONTEXT_SCOPE=targeted|full' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq 'decision/context_scope' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq 'targeted_to_full' "$ROOT/skills/cm-prd/references/context-scope.md" &&
  grep -Fq 'Step 9.5 的任何方案对抗审查触发条件' \
    "$ROOT/skills/cm-prd/references/context-scope.md" &&
  grep -Fq '页面/UI、共享组件、Hook、Store' \
    "$ROOT/skills/cm-prd/references/context-scope.md" &&
  grep -Fq '00–09 全部 10 份' "$ROOT/skills/cm-prd/references/context-scope.md" &&
  grep -Fq '上下文范围: {定向 / 完整 / 定向→完整（reason_code）}' \
    "$ROOT/skills/cm-prd/SKILL.md" ||
  fail "cm-prd progressive context routing is not fully wired"
grep -Fq '禁止再次' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq '全量读取未变化的 CLAUDE/rules' "$ROOT/skills/cm-prd/SKILL.md" ||
  fail "cm-prd can still reread all project rules before design"
if grep -Fq '按 `codebase-context` skill dev 模式加载 10 份文档' \
  "$ROOT/skills/cm-prd/SKILL.md"; then
  fail "cm-prd still unconditionally loads all codebase-context documents"
fi

require_file "skills/cm-prd/references/phase-timing.md"
grep -Fq 'references/phase-timing.md' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq 'prd-context' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'prd-requirements' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'prd-design-review' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'prd-spec-validation' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'prd-spec-review' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'C1 定位 specs 前' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'outcome: awaiting_input' "$ROOT/skills/cm-prd/references/phase-timing.md" &&
  grep -Fq 'operation_id + segment' "$ROOT/skills/cm-prd/SKILL.md" ||
  fail "cm-prd phase timing is not fully wired"
grep -Fq 'PRD phase timing' "$ROOT/runtime/logging.md" &&
  grep -Fq 'callers do not write guessed `duration_ms`' "$ROOT/runtime/logging.md" ||
  fail "logging contract does not protect cm-prd timing semantics"

for reference in \
  skills/cm-miniprogram-engineer/references/platform-readiness.md \
  skills/cm-miniprogram-engineer/references/release-checklist.md; do
  require_file "$reference"
done
grep -q "references/platform-readiness.md" "$ROOT/skills/cm-miniprogram-engineer/SKILL.md" &&
  grep -q "cm-miniprogram-engineer/references/platform-readiness.md" "$ROOT/skills/cm-prd/SKILL.md" ||
  fail "miniprogram platform readiness is not wired into engineer and PRD"
for consumer in \
  runtime/test-contract.md \
  skills/cm-prd/SKILL.md \
  skills/cm-test/SKILL.md \
  skills/cm-qa-engineer/SKILL.md \
  skills/cm-ai/references/N6-qa-eval.md \
  skills/cm-ai/references/N8-finish.md \
  skills/cm-devops-engineer/SKILL.md; do
  grep -q "cm-miniprogram-engineer/references/release-checklist.md\|references/release-checklist.md" "$ROOT/$consumer" ||
    fail "miniprogram release checklist is not wired into $consumer"
done
grep -q "Web target" "$ROOT/runtime/test-contract.md" &&
  grep -q 'BLOCKED' "$ROOT/skills/cm-miniprogram-engineer/references/release-checklist.md" ||
  fail "miniprogram tests can silently substitute Web evidence"
grep -Fq '{CM_WORKFLOW_ROOT}/skills/cm-miniprogram-engineer/references/release-checklist.md' \
  "$ROOT/runtime/test-contract.md" ||
  fail "miniprogram test reference is not anchored to CM_WORKFLOW_ROOT"
grep -Fq '发布验证: {staging/体验版已验证 | 未执行/待人工 | 不适用}' \
  "$ROOT/skills/cm-ai/references/N8-finish.md" ||
  fail "N8 feature summary can overclaim staging verification"
grep -Fq '远程平台上传' "$ROOT/skills/cm-devops-engineer/SKILL.md" &&
  grep -Fq '必须由 task 明确写出目标与通道' "$ROOT/skills/cm-devops-engineer/SKILL.md" ||
  fail "remote platform staging upload lacks explicit task authorization"
if grep -Eq '≤ *2MB|超 *2MB' \
  "$ROOT/skills/cm-miniprogram-engineer/SKILL.md" \
  "$ROOT/templates/rules/miniprogram.md"; then
  fail "miniprogram package limit is hardcoded instead of runtime-verified"
fi

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

ARCHITECTURE_DOC="$ROOT/docs/architecture.md"
if [ "$MODE" != "plugin" ]; then
  ARCHITECTURE_DOC="$ROOT/cm-workflow/docs/architecture.md"
fi
grep -q "runtime/workflow-config.md" "$ARCHITECTURE_DOC" ||
  fail "architecture does not describe the optional workflow config"
grep -q "cm_workflow_config.py" "$ROOT/runtime/workflow-config.md" ||
  fail "workflow config contract does not name its validator"
grep -q "runtime/workflow-routing.md" "$ROOT/runtime/orchestration.md" ||
  fail "orchestration does not describe project role routing"
grep -q "enabled: false" "$ROOT/runtime/external-expert.md" ||
  fail "external-expert config cannot disable the role explicitly"
grep -q '`reviewer` role' "$ROOT/runtime/review.md" &&
  grep -q '`route_state`' "$ROOT/runtime/review.md" ||
  fail "independent review contract does not record configured reviewer route"
grep -q "browser_qa" "$ROOT/runtime/test-contract.md" ||
  fail "test contract does not resolve browser QA role"
grep -q -- "--role" "$ROOT/skills/cm-prd/SKILL.md" ||
  fail "cm-prd does not resolve configured roles"
grep -q -- "--role" "$ROOT/skills/cm-ai/SKILL.md" ||
  fail "cm-ai does not resolve configured roles"
grep -q -- "--role" "$ROOT/skills/cm-test/SKILL.md" ||
  fail "cm-test does not resolve configured roles"
grep -q "从代码项目根解析 .*coder.*tester.*reviewer" "$ROOT/skills/cm-fix/SKILL.md" ||
  fail "cm-fix does not project configured implementation roles"
grep -q "配置错误" "$ROOT/skills/cm-fix/SKILL.md" &&
  grep -q '`BLOCKED`' "$ROOT/skills/cm-fix/SKILL.md" ||
  fail "cm-fix does not block invalid project configuration"
grep -q "从代码项目根解析 .*coder.*tester.*reviewer" "$ROOT/skills/cm-refactor/SKILL.md" ||
  fail "cm-refactor does not project configured implementation roles"
grep -q "配置错误" "$ROOT/skills/cm-refactor/SKILL.md" &&
  grep -q '`BLOCKED`' "$ROOT/skills/cm-refactor/SKILL.md" ||
  fail "cm-refactor does not block invalid project configuration"
grep -q "enabled: false" "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert Skill does not honor disabled project route"
grep -q "配置错误" "$ROOT/skills/external-expert/SKILL.md" &&
  grep -q '`BLOCKED`' "$ROOT/skills/external-expert/SKILL.md" ||
  fail "external-expert Skill does not block invalid project configuration"
grep -q -- "--print-effective" "$ROOT/skills/cm-check/SKILL.md" ||
  fail "cm-check does not expose the effective workflow config"
grep -Fq 'policies.generate_cases' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq 'policies.tests' "$ROOT/skills/cm-ai/references/N6-qa-eval.md" &&
  grep -Fq 'policies.auto_fix' "$ROOT/skills/cm-ai/references/N6-qa-eval.md" &&
  grep -Fq 'DELIVERY_MODE=diff|branch|draft-mr' "$ROOT/skills/cm-ai/references/N1-init.md" &&
  grep -Fq 'delivery/pull_request' "$ROOT/skills/cm-ai/references/N8-finish.md" ||
  fail "workflow policies are parsed but not consumed by their execution nodes"
grep -Fq 'cm-spec-manifest.py' "$ROOT/skills/cm-prd/SKILL.md" &&
  grep -Fq -- '--status-file' "$ROOT/skills/cm-ai/references/N1-init.md" &&
  grep -Fq 'specFiles' "$ROOT/runtime/test-contract.md" ||
  fail "spec approval does not bind the full requirements/design/tasks/test manifest"
grep -Fq '已审批 design.md' "$ROOT/skills/cm-miniprogram-engineer/SKILL.md" &&
  grep -Fq '不得重复询问' "$ROOT/skills/cm-miniprogram-engineer/SKILL.md" &&
  grep -Fq '规格缺失或互相矛盾' "$ROOT/skills/cm-miniprogram-engineer/SKILL.md" ||
  fail "miniprogram execution can reopen an approved design-baseline decision"
if [ "$MODE" = "plugin" ]; then
  grep -q "cm-workflow.yml" "$ROOT/install.sh" ||
    fail "Claude Bash installer does not package the workflow config template"
  grep -q "cm-workflow.yml" "$ROOT/install.ps1" ||
    fail "Claude PowerShell installer does not package the workflow config template"
else
  require_file "templates/cm-workflow.yml"
fi

grep -q "runtime/review.md" "$ROOT/skills/cm-fix/SKILL.md" ||
  fail "cm-fix does not reference the independent review contract"
grep -Fq 'T-FIX-{slug}' "$ROOT/skills/cm-fix/SKILL.md" &&
  grep -Fq 'cm-task-gate.py check-n4' "$ROOT/skills/cm-fix/SKILL.md" &&
  grep -Fq 'cm-task-gate.py check-n5' "$ROOT/skills/cm-fix/SKILL.md" ||
  fail "cm-fix is missing the content-bound post-fix review gate"
grep -Fq 'T-REFACTOR-{slug}' "$ROOT/skills/cm-refactor/SKILL.md" &&
  grep -Fq 'cm-task-gate.py check-n4' "$ROOT/skills/cm-refactor/SKILL.md" &&
  grep -Fq 'cm-task-gate.py check-n5' "$ROOT/skills/cm-refactor/SKILL.md" ||
  fail "cm-refactor is missing the content-bound review gate"
grep -Fq 'auto_fix: `never`' "$ROOT/skills/cm-ai/references/N6-qa-eval.md" &&
  grep -Fq '调用 `$cm-fix`' "$ROOT/skills/cm-ai/references/N6-qa-eval.md" &&
  grep -Fq '不得在 N6 直接修改' "$ROOT/skills/cm-ai/references/N6-qa-eval.md" ||
  fail "N6 QA repairs can bypass the structured fix review path"

grep -q "task-handoff.schema.json" "$ROOT/runtime/task-gates.md" ||
  fail "task gate contract does not bind the handoff schema"
grep -q "tasks.md.*authoritative" "$ROOT/runtime/task-gates.md" ||
  fail "task gate contract can become a competing task-state database"
grep -q "check-parallel-write" "$ROOT/runtime/orchestration.md" &&
  grep -q "run serially" "$ROOT/runtime/orchestration.md" ||
  fail "parallel writes do not fail closed to serial execution"
grep -q "check-n4" "$ROOT/skills/cm-ai/references/N3-execute-task.md" &&
  grep -q "handoff.json" "$ROOT/skills/cm-ai/references/N3-execute-task.md" ||
  fail "N3 does not produce and validate the structured task handoff"
grep -q "verdict: approved | changes_requested | blocked" "$ROOT/skills/cm-ai/references/N4-review.md" &&
  grep -q "attempt:" "$ROOT/skills/cm-ai/references/N4-review.md" &&
  grep -q "handoff:" "$ROOT/skills/cm-ai/references/N4-review.md" &&
  grep -q "handoff_sha256:" "$ROOT/skills/cm-ai/references/N4-review.md" ||
  fail "N4 evidence cannot drive the mechanical review transition"
grep -q "mark-done" "$ROOT/skills/cm-ai/references/N5-mark-done.md" &&
  grep -q "verdict: approved" "$ROOT/skills/cm-ai/references/N5-mark-done.md" &&
  grep -Fq -- '--tasks {SPECS_DIR}/{FEATURE_DIR}/tasks.md' \
    "$ROOT/skills/cm-ai/references/N5-mark-done.md" &&
  grep -Fq -- '--tasks {SPECS_DIR}/{FEATURE_DIR}/tasks.md' \
    "$ROOT/runtime/task-gates.md" ||
  fail "N5 does not require an approved current-attempt review"

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
  if [ -n "$PYTHON_BIN" ]; then
    manifest_version="$("$PYTHON_BIN" -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"].split("+")[0])' "$ROOT/.codex-plugin/plugin.json")"
    [ "$version" = "$manifest_version" ] || fail "VERSION $version != plugin $manifest_version"
  else
    fail "Python 3 is required to compare the Codex plugin version"
  fi
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
