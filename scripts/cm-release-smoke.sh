#!/usr/bin/env bash
# Release-only smoke for the BYZ-managed package and Codex plugin surfaces.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
SOURCE_CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SOURCE_CREATOR="$SOURCE_CODEX_HOME/skills/.system/plugin-creator"
TMP_ROOT=""
PYTHON_BIN=""

blocked() {
  echo "cm release surface smoke: BLOCKED ($1)" >&2
  exit 2
}

fail() {
  echo "cm release surface smoke: FAILED ($1)" >&2
  exit 1
}

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$TMP_ROOT" ] && [ -d "$TMP_ROOT" ]; then
    rm -rf "$TMP_ROOT"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

command -v byz >/dev/null 2>&1 || blocked "byz command not found"
command -v codex >/dev/null 2>&1 || blocked "codex command not found"
[ -d "$SOURCE_CREATOR" ] || blocked "Codex plugin creator not found at $SOURCE_CREATOR"
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    PYTHON_BIN="$(command -v "$candidate")"
    break
  fi
done
[ -n "$PYTHON_BIN" ] || blocked "Python 3.9+ not found"

# CI 覆盖不到的那一批：它们要启动 Codex 沙箱，而在 GitHub 托管机器上 bubblewrap
# 建不了网络隔离（bwrap: loopback: Failed RTM_NEWADDR），装上 codex 也没用。
# 这个脚本上面已经要求本机装了 codex，所以这里是它们唯一稳定的落点——发版必过。
# 名单要和 .github/workflows/ci.yml 的 js-tests 排除名单保持一致。
printf '%s\n' '==> Running the Codex-sandbox tests that CI cannot host'
( cd "$ROOT" && node --test \
  scripts/cm-ai-batch-host.test.mjs \
  scripts/cm-ai-bootstrap.test.mjs \
  scripts/cm-ai-host.test.mjs \
  scripts/cm-ai-multi-root.test.mjs \
  scripts/cm-ai-nested-execution.test.mjs \
  scripts/cm-fix-protected-edits.test.mjs \
  scripts/cm-host-check.test.mjs )

printf '%s\n' '==> Validating the public Pi/BYZ package manifest'
"$PYTHON_BIN" "$ROOT/scripts/validate-public-repo.py"

printf '%s\n' '==> Checking the local workflow root through BYZ'
BYZ_CM_WORKFLOW_ROOT="$ROOT" byz workflow check cm

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cm-release-smoke.XXXXXX")"
TEMP_HOME="$TMP_ROOT/home"
TEMP_CODEX_HOME="$TEMP_HOME/.codex"
mkdir -p "$TEMP_CODEX_HOME/skills/.system"
cp -R "$SOURCE_CREATOR" "$TEMP_CODEX_HOME/skills/.system/plugin-creator"

printf '%s\n' '==> Installing the Codex plugin in a disposable home'
HOME="$TEMP_HOME" CODEX_HOME="$TEMP_CODEX_HOME" \
  "$ROOT/install-codex.sh" --yes

PLUGIN_LIST="$(HOME="$TEMP_HOME" CODEX_HOME="$TEMP_CODEX_HOME" codex plugin list)"
printf '%s\n' "$PLUGIN_LIST"
printf '%s\n' "$PLUGIN_LIST" |
  grep -Eq '^cm-workflow@personal[[:space:]]+installed, enabled' ||
  fail "Codex did not report cm-workflow@personal as installed and enabled"

HOME="$TEMP_HOME" CODEX_HOME="$TEMP_CODEX_HOME" \
  "$TEMP_HOME/plugins/cm-workflow/scripts/cm-check-runtime.sh" \
  --project "$TEMP_HOME/plugins/cm-workflow"

[ -f "$TEMP_HOME/plugins/cm-workflow/CHANGELOG.md" ] || fail "installed changelog missing"
cmp -s "$ROOT/CHANGELOG.md" "$TEMP_HOME/plugins/cm-workflow/CHANGELOG.md" || fail "installed changelog differs from source"

VERSION="$(tr -d '[:space:]' < "$ROOT/VERSION")"
echo "cm release surface smoke: PASSED (v${VERSION})"
