#!/usr/bin/env bash
# Install CM Workflow into Codex's personal local marketplace.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd -P)"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
MARKETPLACE_ROOT="$HOME/.agents/plugins"
MARKETPLACE_PATH="$MARKETPLACE_ROOT/marketplace.json"
PLUGIN_PARENT="$HOME/plugins"
PLUGIN_DEST="$PLUGIN_PARENT/cm-workflow"
STAGE="$PLUGIN_PARENT/.cm-workflow.stage.$$"
BACKUP="$PLUGIN_PARENT/.cm-workflow.backup.$$"
SCAFFOLD_PARENT="$PLUGIN_PARENT/.cm-workflow.scaffold.$$"
CREATOR_ROOT="$CODEX_HOME/skills/.system/plugin-creator"
# Codex's current official creator lives in its downloaded plugin collection.
# Older installations still supply the system-skill layout.
if [ ! -f "$CREATOR_ROOT/scripts/create_basic_plugin.py" ] &&
   [ -f "$CODEX_HOME/.tmp/plugins/.agents/skills/plugin-creator/scripts/create_basic_plugin.py" ]; then
  CREATOR_ROOT="$CODEX_HOME/.tmp/plugins/.agents/skills/plugin-creator"
fi
CREATE_PLUGIN="$CREATOR_ROOT/scripts/create_basic_plugin.py"
VALIDATE_PLUGIN="$CREATOR_ROOT/scripts/validate_plugin.py"
UPDATE_CACHEBUSTER="$CREATOR_ROOT/scripts/update_plugin_cachebuster.py"
READ_MARKETPLACE="$CREATOR_ROOT/scripts/read_marketplace_name.py"
ASSUME_YES=0
OVERWRITE_LOCAL_EDITS=0
# Records what this install wrote so the next install can tell hand edits apart.
INSTALL_MANIFEST_NAME=".cm-install-manifest.sha256"
INSTALL_MANIFEST="$PLUGIN_DEST/$INSTALL_MANIFEST_NAME"
GUARD_TMP=""
# One install transaction per target; never taken over automatically.
LOCK_DIR="$PLUGIN_PARENT/.cm-workflow.install.lock"
LOCK_HELD=0
INSTALL_COMPLETE=0
DEST_REPLACED=0
MARKETPLACE_TOUCHED=0
MARKETPLACE_EXISTED=0
MARKETPLACE_BACKUP="$PLUGIN_PARENT/.cm-workflow.marketplace.backup.$$"
FAILED_DEST="$PLUGIN_PARENT/.cm-workflow.failed.$$"
FAILED_MARKETPLACE="$PLUGIN_PARENT/.cm-workflow.marketplace.failed.$$"

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

find_node() {
  if command -v node >/dev/null 2>&1 &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  return 1
}

PYTHON_BIN=""
if PYTHON_BIN="$(find_python)"; then
  :
else
  echo "Python 3.9+ not found. Install Python or expose it as python3/python, then rerun." >&2
  exit 1
fi

if ! NODE_BIN="$(find_node)"; then
  echo "Node.js 18+ not found. Install Node.js or expose it as node, then rerun." >&2
  exit 1
fi

for arg in "$@"; do
  case "$arg" in
    --yes) ASSUME_YES=1 ;;
    --overwrite-local-edits) OVERWRITE_LOCAL_EDITS=1 ;;
    *)
      echo "Usage: $0 [--yes] [--overwrite-local-edits]" >&2
      exit 2
      ;;
  esac
done

# shellcheck source=scripts/cm-install-manifest.sh
. "$SRC_DIR/scripts/cm-install-manifest.sh"

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$INSTALL_COMPLETE" -ne 1 ]; then
    if [ "$DEST_REPLACED" -eq 1 ] && [ -e "$PLUGIN_DEST" ]; then
      mv "$PLUGIN_DEST" "$FAILED_DEST"
    fi
    if [ -d "$BACKUP" ] && [ ! -e "$PLUGIN_DEST" ]; then
      mv "$BACKUP" "$PLUGIN_DEST"
    fi
    if [ "$MARKETPLACE_TOUCHED" -eq 1 ]; then
      if [ "$MARKETPLACE_EXISTED" -eq 1 ] && [ -f "$MARKETPLACE_BACKUP" ]; then
        cp "$MARKETPLACE_BACKUP" "$MARKETPLACE_PATH"
      elif [ -f "$MARKETPLACE_PATH" ]; then
        mv "$MARKETPLACE_PATH" "$FAILED_MARKETPLACE"
      fi
    fi
  fi
  rm -rf "$STAGE" "$SCAFFOLD_PARENT" "$FAILED_DEST" "$FAILED_MARKETPLACE"
  rm -f "$MARKETPLACE_BACKUP"
  [ -z "$GUARD_TMP" ] || rm -rf "$GUARD_TMP"
  if [ "$INSTALL_COMPLETE" -eq 1 ]; then
    rm -rf "$BACKUP"
  fi
  [ "$LOCK_HELD" -ne 1 ] || rm -rf "$LOCK_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -f "$CREATE_PLUGIN" ]; then
  echo "Codex plugin creator not found: $CREATE_PLUGIN" >&2
  echo "Update Codex, then rerun this installer." >&2
  exit 1
fi

# Stop before any write when a file recorded by the previous install changed.
# --yes only accepts replacing the plugin; it never discards hand edits.
# Runs up front, again after the replace prompt (before the marketplace is
# touched), and once more right before the plugin directory is swapped, because
# another session may edit an installed file while this one waits or stages.
guard_local_edits() {
  guard_mode=${1:-initial}
  if ! cm_manifest_select_hasher; then
    echo "Neither shasum nor sha256sum was found, so local edits to the installed plugin cannot be checked. Installation stopped; nothing was changed." >&2
    return 2
  fi
  if [ -L "$PLUGIN_DEST" ]; then
    echo "Refusing to read an install manifest through a symlinked plugin directory: $PLUGIN_DEST" >&2
    return 2
  fi
  # A manifest path that exists as a directory, symlink or other non-file is a
  # corrupt manifest, not a pre-manifest install.
  if [ ! -e "$INSTALL_MANIFEST" ] && [ ! -L "$INSTALL_MANIFEST" ]; then
    [ "$guard_mode" = recheck ] ||
      echo "No previous install manifest found (first install or installed by an older version); local edits are not checked this time. A manifest is written after a successful install."
    return 0
  fi
  edits="$GUARD_TMP/local-edits"
  if cm_manifest_find_edits "$PLUGIN_DEST" "$INSTALL_MANIFEST" "$edits" "$GUARD_TMP"; then
    :
  else
    find_status=$?
    if [ "$find_status" -ne 3 ]; then
      echo "Checking installed files failed. Installation stopped; nothing was changed." >&2
      return 2
    fi
    echo "Unrecognized install manifest: $INSTALL_MANIFEST" >&2
    if [ "$OVERWRITE_LOCAL_EDITS" -eq 1 ]; then
      echo "--overwrite-local-edits given; skipping the local-edit check and writing a new manifest."
      return 0
    fi
    echo "Installation stopped; nothing was changed. Rerun with --overwrite-local-edits to replace the installed plugin." >&2
    return 1
  fi
  [ -s "$edits" ] || return 0
  if [ "$OVERWRITE_LOCAL_EDITS" -eq 1 ] && [ "$guard_mode" = recheck ]; then
    return 0
  fi
  echo "These installed CM files changed since the last install (sha256 differs from the install manifest):" >&2
  sed 's/^/    /' "$edits" >&2
  if [ "$OVERWRITE_LOCAL_EDITS" -eq 1 ]; then
    echo "--overwrite-local-edits given; these edits will be replaced."
    return 0
  fi
  echo "Installation stopped; nothing was changed. --yes does not discard local edits. Save or merge them first, then rerun with --overwrite-local-edits to discard them." >&2
  return 1
}

run_official_validation() {
  target=$1
  if [ -f "$VALIDATE_PLUGIN" ] && "$PYTHON_BIN" -c 'import yaml' >/dev/null 2>&1; then
    "$PYTHON_BIN" "$VALIDATE_PLUGIN" "$target"
  else
    echo "Warning: Codex optional YAML validator or PyYAML is unavailable; repository validation and Codex CLI validation remain required." >&2
    echo "The dependency-free repository validator and codex plugin add remain required." >&2
  fi
}

mkdir -p "$PLUGIN_PARENT"
if cm_install_lock_acquire "$LOCK_DIR" "$PLUGIN_DEST"; then
  LOCK_HELD=1
elif [ ! -d "$LOCK_DIR" ] || [ -L "$LOCK_DIR" ]; then
  echo "Cannot create the install lock: $LOCK_DIR. Installation stopped; nothing was changed." >&2
  exit 2
else
  lock_pid=$(cm_install_lock_field "$LOCK_DIR" pid)
  lock_started=$(cm_install_lock_field "$LOCK_DIR" started)
  lock_state=$(cm_install_lock_pid_state "$lock_pid")
  echo "Another CM install is writing the same target. Installation stopped; nothing was changed." >&2
  echo "    Lock: $LOCK_DIR" >&2
  echo "    Holder pid: ${lock_pid:-unknown} (started ${lock_started:-unknown})" >&2
  case "$lock_state" in
    alive) echo "    That process is still running; retry after it finishes." >&2 ;;
    not-running) echo "    That process is no longer running; the lock may be left over from an interrupted install." >&2
      echo "    After confirming no install is in progress, remove it manually and retry:" >&2
      echo "    rm -rf '$LOCK_DIR'" >&2 ;;
    *) echo "    Cannot tell whether that process is still running. After confirming no install is in progress, remove it manually and retry:" >&2
      echo "    rm -rf '$LOCK_DIR'" >&2 ;;
  esac
  exit 4
fi

GUARD_TMP="$(mktemp -d "${TMPDIR:-/tmp}/cm-install-guard.XXXXXX")"
run_local_edit_guard() {
  if guard_local_edits "$1"; then
    :
  else
    guard_status=$?
    [ "$guard_status" -eq 1 ] && exit 3
    exit "$guard_status"
  fi
}
run_local_edit_guard initial

"$PYTHON_BIN" "$SRC_DIR/scripts/validate-public-repo.py"
"$SRC_DIR/scripts/cm-check-runtime.sh" --project "$SRC_DIR"
run_official_validation "$SRC_DIR"
mkdir -p "$PLUGIN_PARENT" "$MARKETPLACE_ROOT"

if [ -d "$PLUGIN_DEST" ] && [ "$(cd "$PLUGIN_DEST" && pwd -P)" = "$SRC_DIR" ]; then
  echo "Refusing to replace the source checkout in place: $SRC_DIR" >&2
  echo "Clone CM Workflow outside ~/plugins/cm-workflow, then rerun the installer." >&2
  exit 1
fi

if [ -e "$PLUGIN_DEST" ] && [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Replace the existing Codex plugin at %s? [y/N] ' "$PLUGIN_DEST"
  read -r answer
  case "$answer" in
    y|Y) ;;
    *) echo "Installation cancelled."; exit 0 ;;
  esac
fi

run_local_edit_guard recheck

# Use the first-party helper to own marketplace.json updates, but scaffold in
# a disposable directory so an interrupted install cannot damage the plugin.
if [ -f "$MARKETPLACE_PATH" ]; then
  cp "$MARKETPLACE_PATH" "$MARKETPLACE_BACKUP"
  MARKETPLACE_EXISTED=1
fi
MARKETPLACE_TOUCHED=1
"$PYTHON_BIN" "$CREATE_PLUGIN" cm-workflow \
  --path "$SCAFFOLD_PARENT" \
  --with-skills \
  --with-marketplace \
  --marketplace-path "$MARKETPLACE_PATH" \
  --install-policy AVAILABLE \
  --auth-policy ON_INSTALL \
  --category Productivity \
  --force

# Fill only the official fresh scaffold placeholder, never an existing user name.
if [ "$MARKETPLACE_EXISTED" -eq 0 ]; then
  "$PYTHON_BIN" "$SRC_DIR/scripts/cm-codex-plugin-metadata.py" initialize-marketplace "$MARKETPLACE_PATH"
fi

mkdir -p "$STAGE"
for part in .codex-plugin skills runtime templates scripts agents compat docs assets; do
  mkdir -p "$STAGE/$part"
  cp -R "$SRC_DIR/$part/." "$STAGE/$part/"
done
for file in VERSION package.json README.md CHANGELOG.md AGENTS.md LICENSE THIRD_PARTY_NOTICES.md SECURITY.md CONTRIBUTING.md install-codex.sh install.sh install.ps1; do
  [ -f "$SRC_DIR/$file" ] && cp "$SRC_DIR/$file" "$STAGE/$file"
done

chmod +x "$STAGE/install-codex.sh" "$STAGE/install.sh" "$STAGE/scripts/cm-check-runtime.sh"
if [ -f "$UPDATE_CACHEBUSTER" ]; then
  "$PYTHON_BIN" "$UPDATE_CACHEBUSTER" "$STAGE"
else
  "$PYTHON_BIN" "$SRC_DIR/scripts/cm-codex-plugin-metadata.py" cache-version "$STAGE"
fi
"$PYTHON_BIN" "$STAGE/scripts/validate-public-repo.py"
run_official_validation "$STAGE"
"$STAGE/scripts/cm-check-runtime.sh" --project "$STAGE"

# Hash the exact bytes that will be installed (after the cache-version stamp).
(cd "$STAGE" && find . -type f | sed 's#^\./##' | LC_ALL=C sort) > "$GUARD_TMP/managed-files"
if ! cm_manifest_write "$STAGE" "$GUARD_TMP/managed-files" "$GUARD_TMP/new-manifest"; then
  echo "Writing the install manifest failed. Installation stopped; the existing plugin was not replaced." >&2
  exit 1
fi
cp "$GUARD_TMP/new-manifest" "$STAGE/$INSTALL_MANIFEST_NAME"

# Final check right before the installed plugin is swapped out; an exit here
# restores the marketplace through cleanup.
run_local_edit_guard recheck

if [ -e "$PLUGIN_DEST" ]; then
  mv "$PLUGIN_DEST" "$BACKUP"
  # Edits written by path before the rename landed in the moved directory, so
  # one last check there closes the gap after the recheck above. An exit here
  # moves the old plugin back and restores the marketplace through cleanup.
  if [ "$OVERWRITE_LOCAL_EDITS" -ne 1 ] && [ -f "$BACKUP/$INSTALL_MANIFEST_NAME" ] &&
    [ ! -L "$BACKUP/$INSTALL_MANIFEST_NAME" ]; then
    if cm_manifest_find_edits "$BACKUP" "$BACKUP/$INSTALL_MANIFEST_NAME" "$GUARD_TMP/late-edits" "$GUARD_TMP"; then
      late_status=0
    else
      late_status=$?
    fi
    if [ "$late_status" -ne 0 ] || [ -s "$GUARD_TMP/late-edits" ]; then
      echo "Installed CM files changed during the install; the previous plugin was restored and nothing was replaced:" >&2
      [ ! -s "$GUARD_TMP/late-edits" ] || sed 's/^/    /' "$GUARD_TMP/late-edits" >&2
      [ "$late_status" -eq 0 ] || [ "$late_status" -eq 3 ] || exit 2
      exit 3
    fi
  fi
fi
mv "$STAGE" "$PLUGIN_DEST"
DEST_REPLACED=1

if [ -f "$READ_MARKETPLACE" ]; then
  marketplace_name="$("$PYTHON_BIN" "$READ_MARKETPLACE" --marketplace-path "$MARKETPLACE_PATH")"
else
  marketplace_name="$("$PYTHON_BIN" "$SRC_DIR/scripts/cm-codex-plugin-metadata.py" marketplace-name "$MARKETPLACE_PATH")"
fi
codex plugin add "cm-workflow@$marketplace_name"
INSTALL_COMPLETE=1

# User runtimes.yml: only after the verified core install, before updater prompts.
if [ "$ASSUME_YES" -ne 1 ] && [ -t 0 ] && [ -t 1 ]; then
  node "$PLUGIN_DEST/scripts/cm-runtime-install.mjs"
fi

echo
echo "CM Workflow installed for Codex from: $PLUGIN_DEST"
echo "User guide: $PLUGIN_DEST/docs/user-guide.md"
echo "Start a new Codex thread, then run \$cm-check, \$cm-prd, or \$cm-test."
