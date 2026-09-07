#!/usr/bin/env bash
# Dependency-free regression fixtures for shell/runtime portability.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/cm-shell-compat.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT HUP INT TERM
FAILURES=0

fail() {
  echo "FAIL: $*" >&2
  FAILURES=$((FAILURES + 1))
}

REAL_PYTHON=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
    "$candidate" -c 'import sys; raise SystemExit(sys.version_info < (3, 9))' >/dev/null 2>&1; then
    REAL_PYTHON="$(command -v "$candidate")"
    break
  fi
done

if [ -z "$REAL_PYTHON" ]; then
  echo "shell compatibility fixtures: BLOCKED (Python 3.9+ not found)" >&2
  exit 2
fi

REAL_NODE=""
if command -v node >/dev/null 2>&1 &&
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  REAL_NODE="$(command -v node)"
fi
if [ -z "$REAL_NODE" ]; then
  echo "shell compatibility fixtures: BLOCKED (Node.js 18+ not found)" >&2
  exit 2
fi

# The runtime checker must continue to work when a platform exposes only
# `python`, even though `python3` is unavailable on PATH. Node.js remains a
# declared runtime requirement for the JavaScript config authority.
FAKE_BIN="$TMP_ROOT/compat-bin"
mkdir -p "$FAKE_BIN"
printf '%s\n' '#!/usr/bin/env bash' "exec \"$REAL_PYTHON\" \"\$@\"" > "$FAKE_BIN/python"
printf '%s\n' '#!/usr/bin/env bash' 'exit 127' > "$FAKE_BIN/python3"
printf '%s\n' '#!/usr/bin/env bash' "exec \"$REAL_NODE\" \"\$@\"" > "$FAKE_BIN/node"
chmod +x "$FAKE_BIN/python" "$FAKE_BIN/python3" "$FAKE_BIN/node"

if PATH="$FAKE_BIN:/usr/bin:/bin" "$ROOT/scripts/cm-check-runtime.sh" \
  >"$TMP_ROOT/python-fallback.out" 2>&1; then
  :
else
  cat "$TMP_ROOT/python-fallback.out" >&2
  fail "runtime checker must support the python fallback with Node.js present"
fi

# The Codex installer performs the same fallback before it validates its
# arguments. An invalid option gives us a side-effect-free smoke check.
if PATH="$FAKE_BIN:/usr/bin:/bin" "$ROOT/install-codex.sh" --invalid \
  >"$TMP_ROOT/installer-python-fallback.out" 2>&1; then
  fail "Codex installer must reject an invalid option"
elif grep -q 'Usage:' "$TMP_ROOT/installer-python-fallback.out" &&
  ! grep -q 'Python 3.9+ not found' "$TMP_ROOT/installer-python-fallback.out"; then
  :
else
  cat "$TMP_ROOT/installer-python-fallback.out" >&2
  fail "Codex installer must support the python fallback with Node.js present"
fi

# Missing Node.js must fail before an installer can mutate user directories.
NO_NODE_BIN="$TMP_ROOT/no-node-bin"
mkdir -p "$NO_NODE_BIN"
cp "$FAKE_BIN/python" "$NO_NODE_BIN/python"
cp "$FAKE_BIN/python3" "$NO_NODE_BIN/python3"
if PATH="$NO_NODE_BIN:/usr/bin:/bin" "$ROOT/install-codex.sh" --yes \
  >"$TMP_ROOT/installer-no-node.out" 2>&1; then
  fail "Codex installer must reject a PATH without Node.js"
elif grep -q 'Node.js 18+ not found' "$TMP_ROOT/installer-no-node.out"; then
  :
else
  cat "$TMP_ROOT/installer-no-node.out" >&2
  fail "Codex installer must explain the Node.js requirement"
fi

make_git_fixture() {
  repo="$1"
  specs="$2"
  task_mtime_delta="$3"
  mkdir -p "$repo" "$specs/1-demo"
  git -C "$repo" init -q
  git -C "$repo" config user.email "cm-workflow@example.invalid"
  git -C "$repo" config user.name "cm-workflow fixture"
  printf '%s\n' 'base' > "$repo/src.js"
  git -C "$repo" add src.js
  git -C "$repo" commit -qm "fixture: baseline"
  printf '%s\n' '- [ ] T-001: fixture task' > "$specs/1-demo/tasks.md"
  last_commit_ts="$(git -C "$repo" log -1 --format=%ct)"
  "$REAL_PYTHON" - "$specs/1-demo/tasks.md" "$last_commit_ts" "$task_mtime_delta" <<'PY'
import os
import sys

path, commit_ts, delta = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
timestamp = commit_ts + delta
os.utime(path, (timestamp, timestamp))
PY
  printf '%s\n' 'changed' >> "$repo/src.js"
  git -C "$repo" add src.js
}

# A fresh tasks file must allow a strict commit check. The old implementation
# used macOS-incompatible `find -newermt` and rejected this valid case.
fresh_repo="$TMP_ROOT/fresh-repo"
fresh_specs="$TMP_ROOT/fresh-specs"
make_git_fixture "$fresh_repo" "$fresh_specs" 10
if (
  cd "$fresh_repo"
  PATH="$FAKE_BIN:/usr/bin:/bin" CM_SPECS_DIR="$fresh_specs" CM_TASK_CHECK_STRICT=1 \
    /bin/bash "$ROOT/templates/hooks/pre-commit-cm-task-check"
); then
  :
else
  fail "strict hook must allow a source commit when tasks.md is newer"
fi

# An unchanged/stale tasks file must still block strict source commits.
stale_repo="$TMP_ROOT/stale-repo"
stale_specs="$TMP_ROOT/stale-specs"
make_git_fixture "$stale_repo" "$stale_specs" -10
if (
  cd "$stale_repo"
  PATH="$FAKE_BIN:/usr/bin:/bin" CM_SPECS_DIR="$stale_specs" CM_TASK_CHECK_STRICT=1 \
    /bin/bash "$ROOT/templates/hooks/pre-commit-cm-task-check"
); then
  fail "strict hook must block a source commit when tasks.md is stale"
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "shell compatibility fixtures: FAILED ($FAILURES)" >&2
  exit 1
fi

echo "shell compatibility fixtures: PASSED"
