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

if [ ! -x "$ROOT/install.sh" ]; then
  fail "Claude Bash installer must remain directly executable"
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

# Rejecting any conflict in the Claude compatibility installer must be an
# all-or-nothing cancellation. A stale Skill mixed with a new runtime is not a
# usable degraded install.
claude_fixture="$TMP_ROOT/claude-atomic"
claude_home="$claude_fixture/home"
claude_dest="$claude_fixture/.claude"
mkdir -p "$claude_home" "$claude_dest/skills/cm-ai"
printf '%s\n' 'stale cm-ai skill' > "$claude_dest/skills/cm-ai/SKILL.md"
(
  cd "$claude_fixture"
  find . -type f -exec shasum -a 256 {} \; | sort
) > "$TMP_ROOT/claude-before.sha"
printf 'n\n' | HOME="$claude_home" CLAUDE_HOME="$claude_dest" \
  /bin/bash "$ROOT/install.sh" > "$TMP_ROOT/claude-install.out" 2>&1 || true
(
  cd "$claude_fixture"
  find . -type f -exec shasum -a 256 {} \; | sort
) > "$TMP_ROOT/claude-after.sha"
if cmp -s "$TMP_ROOT/claude-before.sha" "$TMP_ROOT/claude-after.sha"; then
  :
else
  cat "$TMP_ROOT/claude-install.out" >&2
  fail "Claude installer cancellation must not leave a partial upgrade"
fi

claude_success="$TMP_ROOT/claude-success"
mkdir -p "$claude_success/home"
if HOME="$claude_success/home" CLAUDE_HOME="$claude_success/.claude" \
  /bin/bash "$ROOT/install.sh" --yes > "$TMP_ROOT/claude-success.out" 2>&1 &&
  [ -f "$claude_success/.claude/skills/cm-ai/SKILL.md" ] &&
  [ "$(cat "$claude_success/.claude/templates/cm-VERSION")" = "$(cat "$ROOT/VERSION")" ]; then
  :
else
  cat "$TMP_ROOT/claude-success.out" >&2
  fail "Claude Bash installer must complete an isolated atomic install"
fi

claude_optional_blocked="$TMP_ROOT/claude-optional-blocked"
mkdir -p "$claude_optional_blocked/home"
printf '%s\n' 'occupied' > "$claude_optional_blocked/home/.cm-workflow"
if HOME="$claude_optional_blocked/home" \
  CLAUDE_HOME="$claude_optional_blocked/.claude" \
  /bin/bash "$ROOT/install.sh" --yes > "$TMP_ROOT/claude-optional-blocked.out" 2>&1 &&
  [ -f "$claude_optional_blocked/.claude/skills/cm-ai/SKILL.md" ] &&
  grep -q '可选更新器安装跳过' "$TMP_ROOT/claude-optional-blocked.out"; then
  :
else
  cat "$TMP_ROOT/claude-optional-blocked.out" >&2
  fail "optional updater failure must not invalidate the verified core install"
fi

installer_fail_bin="$TMP_ROOT/installer-fail-bin"
mkdir -p "$installer_fail_bin"
printf '%s\n' '#!/usr/bin/env sh' 'exit 127' > "$installer_fail_bin/python3"
printf '%s\n' '#!/usr/bin/env sh' 'exit 127' > "$installer_fail_bin/python"
chmod +x "$installer_fail_bin/python3" "$installer_fail_bin/python"

claude_rollback="$TMP_ROOT/claude-rollback"
mkdir -p "$claude_rollback/home" "$claude_rollback/.claude/skills/cm-ai"
printf '%s\n' 'stale cm-ai skill' > "$claude_rollback/.claude/skills/cm-ai/SKILL.md"
(
  cd "$claude_rollback"
  find . -type f -exec shasum -a 256 {} \; | sort
) > "$TMP_ROOT/claude-rollback-before.sha"
if HOME="$claude_rollback/home" CLAUDE_HOME="$claude_rollback/.claude" \
  PATH="$installer_fail_bin:/usr/bin:/bin" \
  /bin/bash "$ROOT/install.sh" --yes > "$TMP_ROOT/claude-rollback.out" 2>&1; then
  fail "Claude Bash installer must fail when the installed self-check fails"
fi
(
  cd "$claude_rollback"
  find . -type f -exec shasum -a 256 {} \; | sort
) > "$TMP_ROOT/claude-rollback-after.sha"
if cmp -s "$TMP_ROOT/claude-rollback-before.sha" "$TMP_ROOT/claude-rollback-after.sha"; then
  :
else
  cat "$TMP_ROOT/claude-rollback.out" >&2
  fail "Claude Bash installer must restore all managed files after self-check failure"
fi

claude_directory_collision="$TMP_ROOT/claude-directory-collision"
mkdir -p "$claude_directory_collision/home" \
  "$claude_directory_collision/.claude/skills/cm-ai/SKILL.md"
printf '%s\n' 'keep directory collision' \
  > "$claude_directory_collision/.claude/skills/cm-ai/SKILL.md/marker.txt"
(
  cd "$claude_directory_collision"
  find . -type f -exec shasum -a 256 {} \; | sort
) > "$TMP_ROOT/claude-directory-before.sha"
if HOME="$claude_directory_collision/home" \
  CLAUDE_HOME="$claude_directory_collision/.claude" \
  /bin/bash "$ROOT/install.sh" --yes > "$TMP_ROOT/claude-directory.out" 2>&1; then
  fail "Claude Bash installer must reject a directory at a managed file path"
fi
(
  cd "$claude_directory_collision"
  find . -type f -exec shasum -a 256 {} \; | sort
) > "$TMP_ROOT/claude-directory-after.sha"
if cmp -s "$TMP_ROOT/claude-directory-before.sha" "$TMP_ROOT/claude-directory-after.sha"; then
  :
else
  cat "$TMP_ROOT/claude-directory.out" >&2
  fail "Claude Bash installer must not partially write after a directory collision"
fi

claude_symlink="$TMP_ROOT/claude-symlink"
claude_external="$TMP_ROOT/claude-symlink-external"
mkdir -p "$claude_symlink/home" "$claude_symlink/.claude" "$claude_external"
ln -s "$claude_external" "$claude_symlink/.claude/skills"
if HOME="$claude_symlink/home" CLAUDE_HOME="$claude_symlink/.claude" \
  /bin/bash "$ROOT/install.sh" --yes > "$TMP_ROOT/claude-symlink.out" 2>&1; then
  fail "Claude Bash installer must reject a symlinked managed ancestor"
fi
if [ -n "$(find "$claude_external" -type f -print -quit)" ]; then
  cat "$TMP_ROOT/claude-symlink.out" >&2
  fail "Claude Bash installer must not write through a managed ancestor symlink"
fi

if command -v pwsh >/dev/null 2>&1; then
  powershell_cancel="$TMP_ROOT/powershell-cancel"
  mkdir -p "$powershell_cancel/home" "$powershell_cancel/.claude/skills/cm-ai"
  printf '%s\n' 'stale cm-ai skill' > "$powershell_cancel/.claude/skills/cm-ai/SKILL.md"
  (
    cd "$powershell_cancel"
    find . -type f -exec shasum -a 256 {} \; | sort
  ) > "$TMP_ROOT/powershell-before.sha"
  printf 'n\n' | USERPROFILE="$powershell_cancel/home" \
    CLAUDE_HOME="$powershell_cancel/.claude" \
    pwsh -NoProfile -File "$ROOT/install.ps1" \
      > "$TMP_ROOT/powershell-cancel.out" 2>&1 || true
  (
    cd "$powershell_cancel"
    find . -type f -exec shasum -a 256 {} \; | sort
  ) > "$TMP_ROOT/powershell-after.sha"
  if cmp -s "$TMP_ROOT/powershell-before.sha" "$TMP_ROOT/powershell-after.sha"; then
    :
  else
    cat "$TMP_ROOT/powershell-cancel.out" >&2
    fail "Claude PowerShell installer cancellation must not leave a partial upgrade"
  fi

  powershell_success="$TMP_ROOT/powershell-success"
  mkdir -p "$powershell_success/home"
  if USERPROFILE="$powershell_success/home" CLAUDE_HOME="$powershell_success/.claude" \
    pwsh -NoProfile -File "$ROOT/install.ps1" -Force \
      > "$TMP_ROOT/powershell-success.out" 2>&1 &&
    [ -f "$powershell_success/.claude/skills/cm-ai/SKILL.md" ] &&
    [ "$(tr -d '\r\n' < "$powershell_success/.claude/templates/cm-VERSION")" = "$(cat "$ROOT/VERSION")" ]; then
    :
  else
    cat "$TMP_ROOT/powershell-success.out" >&2
    fail "Claude PowerShell installer must complete an isolated atomic install"
  fi

  powershell_rollback="$TMP_ROOT/powershell-rollback"
  mkdir -p "$powershell_rollback/home" "$powershell_rollback/.claude/skills/cm-ai"
  printf '%s\n' 'stale cm-ai skill' > "$powershell_rollback/.claude/skills/cm-ai/SKILL.md"
  (
    cd "$powershell_rollback"
    find . -type f -exec shasum -a 256 {} \; | sort
  ) > "$TMP_ROOT/powershell-rollback-before.sha"
  if USERPROFILE="$powershell_rollback/home" CLAUDE_HOME="$powershell_rollback/.claude" \
    PATH="$installer_fail_bin:/usr/bin:/bin" \
    pwsh -NoProfile -File "$ROOT/install.ps1" -Force \
      > "$TMP_ROOT/powershell-rollback.out" 2>&1; then
    fail "Claude PowerShell installer must fail when the installed self-check fails"
  fi
  (
    cd "$powershell_rollback"
    find . -type f -exec shasum -a 256 {} \; | sort
  ) > "$TMP_ROOT/powershell-rollback-after.sha"
  if cmp -s "$TMP_ROOT/powershell-rollback-before.sha" "$TMP_ROOT/powershell-rollback-after.sha"; then
    :
  else
    cat "$TMP_ROOT/powershell-rollback.out" >&2
    fail "Claude PowerShell installer must restore all managed files after self-check failure"
  fi

  powershell_directory_collision="$TMP_ROOT/powershell-directory-collision"
  mkdir -p "$powershell_directory_collision/home" \
    "$powershell_directory_collision/.claude/skills/cm-ai/SKILL.md"
  printf '%s\n' 'keep directory collision' \
    > "$powershell_directory_collision/.claude/skills/cm-ai/SKILL.md/marker.txt"
  (
    cd "$powershell_directory_collision"
    find . -type f -exec shasum -a 256 {} \; | sort
  ) > "$TMP_ROOT/powershell-directory-before.sha"
  if USERPROFILE="$powershell_directory_collision/home" \
    CLAUDE_HOME="$powershell_directory_collision/.claude" \
    pwsh -NoProfile -File "$ROOT/install.ps1" -Force \
      > "$TMP_ROOT/powershell-directory.out" 2>&1; then
    fail "Claude PowerShell installer must reject a directory at a managed file path"
  fi
  (
    cd "$powershell_directory_collision"
    find . -type f -exec shasum -a 256 {} \; | sort
  ) > "$TMP_ROOT/powershell-directory-after.sha"
  if cmp -s "$TMP_ROOT/powershell-directory-before.sha" "$TMP_ROOT/powershell-directory-after.sha"; then
    :
  else
    cat "$TMP_ROOT/powershell-directory.out" >&2
    fail "Claude PowerShell installer must not partially write after a directory collision"
  fi

  powershell_symlink="$TMP_ROOT/powershell-symlink"
  powershell_external="$TMP_ROOT/powershell-symlink-external"
  mkdir -p "$powershell_symlink/home" "$powershell_symlink/.claude" "$powershell_external"
  ln -s "$powershell_external" "$powershell_symlink/.claude/skills"
  if USERPROFILE="$powershell_symlink/home" CLAUDE_HOME="$powershell_symlink/.claude" \
    pwsh -NoProfile -File "$ROOT/install.ps1" -Force \
      > "$TMP_ROOT/powershell-symlink.out" 2>&1; then
    fail "Claude PowerShell installer must reject a symlinked managed ancestor"
  fi
  if [ -n "$(find "$powershell_external" -type f -print -quit)" ]; then
    cat "$TMP_ROOT/powershell-symlink.out" >&2
    fail "Claude PowerShell installer must not write through a managed ancestor symlink"
  fi
fi

if [ "$FAILURES" -ne 0 ]; then
  echo "shell compatibility fixtures: FAILED ($FAILURES)" >&2
  exit 1
fi

echo "shell compatibility fixtures: PASSED"
