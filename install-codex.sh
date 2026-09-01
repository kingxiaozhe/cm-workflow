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
CREATE_PLUGIN="$CREATOR_ROOT/scripts/create_basic_plugin.py"
VALIDATE_PLUGIN="$CREATOR_ROOT/scripts/validate_plugin.py"
UPDATE_CACHEBUSTER="$CREATOR_ROOT/scripts/update_plugin_cachebuster.py"
READ_MARKETPLACE="$CREATOR_ROOT/scripts/read_marketplace_name.py"
ASSUME_YES=0
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

PYTHON_BIN=""
if PYTHON_BIN="$(find_python)"; then
  :
else
  echo "Python 3.9+ not found. Install Python or expose it as python3/python, then rerun." >&2
  exit 1
fi

case "${1:-}" in
  "") ;;
  --yes) ASSUME_YES=1 ;;
  *)
    echo "Usage: $0 [--yes]" >&2
    exit 2
    ;;
esac

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
  if [ "$INSTALL_COMPLETE" -eq 1 ]; then
    rm -rf "$BACKUP"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

for helper in "$CREATE_PLUGIN" "$VALIDATE_PLUGIN" "$UPDATE_CACHEBUSTER" "$READ_MARKETPLACE"; do
  if [ ! -f "$helper" ]; then
    echo "Codex plugin helper not found: $helper" >&2
    echo "Update Codex, then rerun this installer." >&2
    exit 1
  fi
done

run_official_validation() {
  target=$1
  if "$PYTHON_BIN" -c 'import yaml' >/dev/null 2>&1; then
    "$PYTHON_BIN" "$VALIDATE_PLUGIN" "$target"
  else
    echo "Warning: PyYAML is unavailable; skipping Codex's optional YAML validator." >&2
    echo "The dependency-free repository validator and codex plugin add remain required." >&2
  fi
}

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

mkdir -p "$STAGE"
for part in .codex-plugin skills runtime templates scripts agents compat docs assets; do
  mkdir -p "$STAGE/$part"
  cp -R "$SRC_DIR/$part/." "$STAGE/$part/"
done
for file in VERSION package.json README.md AGENTS.md LICENSE THIRD_PARTY_NOTICES.md SECURITY.md CONTRIBUTING.md install-codex.sh install.sh install.ps1; do
  [ -f "$SRC_DIR/$file" ] && cp "$SRC_DIR/$file" "$STAGE/$file"
done

chmod +x "$STAGE/install-codex.sh" "$STAGE/install.sh" "$STAGE/scripts/cm-check-runtime.sh"
"$PYTHON_BIN" "$UPDATE_CACHEBUSTER" "$STAGE"
"$PYTHON_BIN" "$STAGE/scripts/validate-public-repo.py"
run_official_validation "$STAGE"
"$STAGE/scripts/cm-check-runtime.sh" --project "$STAGE"

if [ -e "$PLUGIN_DEST" ]; then
  mv "$PLUGIN_DEST" "$BACKUP"
fi
mv "$STAGE" "$PLUGIN_DEST"
DEST_REPLACED=1

marketplace_name="$("$PYTHON_BIN" "$READ_MARKETPLACE" --marketplace-path "$MARKETPLACE_PATH")"
codex plugin add "cm-workflow@$marketplace_name"
INSTALL_COMPLETE=1

echo
echo "CM Workflow installed for Codex from: $PLUGIN_DEST"
echo "User guide: $PLUGIN_DEST/docs/user-guide.md"
echo "Start a new Codex thread, then run \$cm-check, \$cm-prd, or \$cm-test."
