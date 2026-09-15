#!/usr/bin/env bash
# CM Workflow Claude Code compatibility installer.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
DEST_PARENT="$(dirname "$DEST")"
VERSION="$(cat "$SRC_DIR/VERSION" 2>/dev/null || echo 未知)"
STAGE="$DEST_PARENT/.cm-claude.stage.$$"
BACKUP="$DEST_PARENT/.cm-claude.backup.$$"
ASSUME_YES=0
INSTALL_COMPLETE=0
DEST_TOUCHED=0

case "${1:-}" in
  "") ;;
  --yes) ASSUME_YES=1 ;;
  *) echo "用法: $0 [--yes]" >&2; exit 2 ;;
esac

if ! command -v node >/dev/null 2>&1 ||
  ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Node.js 18+ 未找到。请安装 Node.js 并确保 node 在 PATH 中，然后重试。" >&2
  exit 1
fi

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$INSTALL_COMPLETE" -ne 1 ] && [ "$DEST_TOUCHED" -eq 1 ]; then
    while IFS= read -r relative; do
      [ -n "$relative" ] || continue
      target="$DEST/$relative"
      saved="$BACKUP/$relative"
      if [ -f "$saved" ]; then
        mkdir -p "$(dirname "$target")"
        cp -p "$saved" "$target"
      elif [ -f "$target" ] || [ -L "$target" ]; then
        rm -f "$target"
      fi
    done < "$STAGE/.cm-managed-files"
    echo "安装失败，已回滚本次写入。" >&2
  fi
  rm -rf "$STAGE" "$BACKUP"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

stage_tree() {
  src=$1
  relative=$2
  [ -d "$src" ] || return 0
  mkdir -p "$STAGE/$relative"
  cp -R "$src/." "$STAGE/$relative/"
}

stage_file() {
  src=$1
  relative=$2
  [ -f "$src" ] || return 0
  mkdir -p "$(dirname "$STAGE/$relative")"
  cp "$src" "$STAGE/$relative"
}

assert_safe_target() {
  relative=$1
  if [ -L "$DEST" ]; then
    echo "拒绝写入符号链接安装目录: $DEST" >&2
    return 2
  fi
  if [ -e "$DEST" ] && [ ! -d "$DEST" ]; then
    echo "安装目录必须是普通目录: $DEST" >&2
    return 2
  fi

  parent_relative=$(dirname "$relative")
  current=$DEST
  remaining=$parent_relative
  while [ -n "$remaining" ] && [ "$remaining" != "." ]; do
    case "$remaining" in
      */*) component=${remaining%%/*}; remaining=${remaining#*/} ;;
      *) component=$remaining; remaining="" ;;
    esac
    current="$current/$component"
    if [ -L "$current" ]; then
      echo "拒绝写入符号链接父目录: $current" >&2
      return 2
    fi
    if [ -e "$current" ] && [ ! -d "$current" ]; then
      echo "安装目标父路径不是目录: $current" >&2
      return 2
    fi
  done

  target="$DEST/$relative"
  if [ -L "$target" ]; then
    echo "拒绝覆盖符号链接目标: $target" >&2
    return 2
  fi
  if [ -e "$target" ] && [ ! -f "$target" ]; then
    echo "安装目标必须是普通文件: $target" >&2
    return 2
  fi
}

confirm_bundle_conflicts() {
  conflicts=""
  while IFS= read -r relative; do
    [ -n "$relative" ] || continue
    target="$DEST/$relative"
    if ! assert_safe_target "$relative"; then
      return 2
    fi
    [ -e "$target" ] && conflicts="${conflicts}${relative}
"
  done < "$STAGE/.cm-managed-files"
  [ -n "$conflicts" ] || return 0
  echo "⚠ 以下 CM 文件已存在，将作为一个整体更新："
  printf '%s' "$conflicts" | sed '/^$/d; s/^/    /'
  [ "$ASSUME_YES" -eq 1 ] && return 0
  read -r -p "  继续原子更新全部 CM 文件？[y/N] " answer
  case "$answer" in
    y|Y) return 0 ;;
    *) echo "安装已取消，未修改现有运行时。"; return 1 ;;
  esac
}

copy_file_atomic() {
  src=$1
  dst=$2
  label=$3
  [ -f "$src" ] || return 0
  if [ -e "$dst" ] && [ "$ASSUME_YES" -ne 1 ]; then
    read -r -p "⚠ ${label} 已存在，继续覆盖？[y/N] " answer
    case "$answer" in
      y|Y) ;;
      *) echo "  跳过 $label"; return 0 ;;
    esac
  fi
  if ! mkdir -p "$(dirname "$dst")"; then
    return 1
  fi
  tmp="${dst}.tmp.$$"
  if ! cp "$src" "$tmp" || ! chmod +x "$tmp" || ! mv -f "$tmp" "$dst"; then
    rm -f "$tmp"
    return 1
  fi
  echo "✓ ${label} 已安装"
}

echo "CM Workflow Claude Code 兼容安装  v$VERSION"
echo "  来源: $SRC_DIR"
echo "  目标: $DEST"
echo

mkdir -p "$DEST_PARENT" "$STAGE"
for part in skills agents runtime scripts compat; do
  stage_tree "$SRC_DIR/$part" "$part"
done
stage_tree "$SRC_DIR/docs" "cm-workflow/docs"
stage_tree "$SRC_DIR/assets" "cm-workflow/assets"
stage_file "$SRC_DIR/README.md" "cm-workflow/README.md"

for wrapper in "$SRC_DIR"/compat/claude-commands/cm-*.md; do
  name="$(basename "$wrapper" .md)"
  verb="${name#cm-}"
  stage_file "$wrapper" "commands/cm:${verb}.md"
done

stage_tree "$SRC_DIR/templates/rules" "templates/rules"
stage_tree "$SRC_DIR/templates/rules" "templates/cm-rules"
stage_file "$SRC_DIR/templates/arch-reference.md" "templates/arch-reference.md"
stage_file "$SRC_DIR/templates/cm-workflow.yml" "templates/cm-workflow.yml"
stage_tree "$SRC_DIR/templates/dashboard" "templates/dashboard"
stage_tree "$SRC_DIR/templates/dashboard" "templates/cm-dashboard"
stage_tree "$SRC_DIR/templates/pixel" "templates/pixel"
stage_tree "$SRC_DIR/templates/pixel" "templates/cm-pixel"
stage_tree "$SRC_DIR/templates/hooks" "templates/hooks"
stage_tree "$SRC_DIR/templates/refactor" "templates/refactor"
stage_tree "$SRC_DIR/templates/ui-lens" "templates/ui-lens"
stage_file "$SRC_DIR/templates/statusline/cm-statusline.sh" "templates/cm-statusline.sh"
stage_file "$SRC_DIR/templates/hooks/pre-commit-cm-task-check" "templates/cm-task-check-hook"
stage_file "$SRC_DIR/templates/refactor/cm-refactor-denies.json" "templates/cm-refactor-denies.json"
stage_file "$SRC_DIR/templates/ui-lens/cm-ui-lens-extract.mjs" "templates/cm-ui-lens-extract.mjs"
printf '%s\n' "$VERSION" > "$STAGE/templates/cm-VERSION"

for executable in \
  "$STAGE/scripts/cm-check-runtime.sh" \
  "$STAGE/templates/cm-statusline.sh" \
  "$STAGE/templates/cm-task-check-hook" \
  "$STAGE/templates/hooks/pre-commit-cm-task-check" \
  "$STAGE/templates/dashboard/serve.sh" \
  "$STAGE/templates/cm-dashboard/serve.sh" \
  "$STAGE/templates/pixel/cm-pixel.sh" \
  "$STAGE/templates/pixel/serve.sh" \
  "$STAGE/templates/cm-pixel/cm-pixel.sh" \
  "$STAGE/templates/cm-pixel/serve.sh"; do
  [ -f "$executable" ] && chmod +x "$executable"
done

(cd "$STAGE" && find . -type f ! -name .cm-managed-files | sed 's#^\./##' | sort) \
  > "$STAGE/.cm-managed-files"

if confirm_bundle_conflicts; then
  :
else
  conflict_status=$?
  [ "$conflict_status" -eq 1 ] && exit 0
  exit "$conflict_status"
fi

mkdir -p "$BACKUP"
while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  if [ -f "$DEST/$relative" ]; then
    mkdir -p "$(dirname "$BACKUP/$relative")"
    cp -p "$DEST/$relative" "$BACKUP/$relative"
  fi
done < "$STAGE/.cm-managed-files"

mkdir -p "$DEST"
DEST_TOUCHED=1
while IFS= read -r relative; do
  [ -n "$relative" ] || continue
  mkdir -p "$(dirname "$DEST/$relative")"
  cp -p "$STAGE/$relative" "$DEST/$relative"
done < "$STAGE/.cm-managed-files"

"$DEST/scripts/cm-check-runtime.sh" --project "$SRC_DIR"
INSTALL_COMPLETE=1

copy_file_atomic "$SRC_DIR/templates/auto-update/cm-update.sh" "$HOME/.cm-workflow/cm-update.sh" "~/.cm-workflow/cm-update.sh" ||
  echo "⚠ 可选更新器安装跳过: ~/.cm-workflow/cm-update.sh" >&2
copy_file_atomic "$SRC_DIR/templates/auto-update/cm-announce.sh" "$HOME/.cm-workflow/cm-announce.sh" "~/.cm-workflow/cm-announce.sh" ||
  echo "⚠ 可选更新器安装跳过: ~/.cm-workflow/cm-announce.sh" >&2

echo
echo "完成（已安装版本: v${VERSION}）。"
echo "建议在 Claude Code 中运行 /cm-check 校验；macOS/Linux 也保留 /cm:check 别名。"
echo "使用手册: $DEST/cm-workflow/docs/user-guide.md"
echo "自动更新器未自动启用；按 docs/installation.md 手工配置 SessionStart hook。"
