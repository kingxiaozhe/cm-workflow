#!/usr/bin/env bash
# CM Workflow Claude Code compatibility installer.
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
VERSION="$(cat "$SRC_DIR/VERSION" 2>/dev/null || echo 未知)"
ASSUME_YES=0

case "${1:-}" in
  "") ;;
  --yes) ASSUME_YES=1 ;;
  *) echo "用法: $0 [--yes]" >&2; exit 2 ;;
esac

confirm_conflicts() {
  label=$1
  conflicts=$2
  [ -n "$conflicts" ] || return 0
  echo "⚠ ${label} 下以下文件已存在，将被覆盖："
  echo "$conflicts" | sed 's/^/    /'
  [ "$ASSUME_YES" -eq 1 ] && return 0
  read -r -p "  继续覆盖 ${label}？[y/N] " answer
  case "$answer" in
    y|Y) return 0 ;;
    *) echo "  跳过 $label"; return 1 ;;
  esac
}

copy_tree() {
  src=$1
  dst=$2
  label=$3
  [ -d "$src" ] || { echo "跳过 ${label}（源目录不存在）"; return 0; }
  mkdir -p "$dst"
  conflicts=$(cd "$src" && find . -type f | while read -r file; do
    [ -e "$dst/$file" ] && echo "$file"
  done || true)
  confirm_conflicts "$label" "$conflicts" || return 0
  cp -R "$src/." "$dst/"
  echo "✓ ${label} 已安装（$(cd "$src" && find . -type f | wc -l | tr -d ' ') 个文件）"
}

copy_file() {
  src=$1
  dst=$2
  label=$3
  [ -f "$src" ] || return 0
  conflicts=""
  [ -e "$dst" ] && conflicts="$(basename "$dst")"
  confirm_conflicts "$label" "$conflicts" || return 0
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  echo "✓ ${label} 已安装"
}

copy_file_atomic() {
  src=$1
  dst=$2
  label=$3
  [ -f "$src" ] || return 0
  conflicts=""
  [ -e "$dst" ] && conflicts="$(basename "$dst")"
  confirm_conflicts "$label" "$conflicts" || return 0
  mkdir -p "$(dirname "$dst")"
  tmp="${dst}.tmp.$$"
  cp "$src" "$tmp"
  chmod +x "$tmp"
  mv -f "$tmp" "$dst"
  echo "✓ ${label} 已安装"
}

echo "CM Workflow Claude Code 兼容安装  v$VERSION"
echo "  来源: $SRC_DIR"
echo "  目标: $DEST"
echo

for part in skills agents runtime scripts compat; do
  copy_tree "$SRC_DIR/$part" "$DEST/$part" "$part"
done

# Claude Code now recommends Skills, so /cm-* works on every platform. Preserve
# the historic /cm:* aliases on filesystems that allow ':' in filenames.
for wrapper in "$SRC_DIR"/compat/claude-commands/cm-*.md; do
  name="$(basename "$wrapper" .md)"
  verb="${name#cm-}"
  copy_file "$wrapper" "$DEST/commands/cm:${verb}.md" "commands/cm:${verb}.md"
done

copy_tree "$SRC_DIR/templates/rules" "$DEST/templates/rules" "templates/rules"
copy_tree "$SRC_DIR/templates/rules" "$DEST/templates/cm-rules" "templates/cm-rules"
copy_file "$SRC_DIR/templates/arch-reference.md" "$DEST/templates/arch-reference.md" "templates/arch-reference.md"
copy_tree "$SRC_DIR/templates/dashboard" "$DEST/templates/dashboard" "templates/dashboard"
copy_tree "$SRC_DIR/templates/dashboard" "$DEST/templates/cm-dashboard" "templates/cm-dashboard"
copy_tree "$SRC_DIR/templates/pixel" "$DEST/templates/pixel" "templates/pixel"
copy_tree "$SRC_DIR/templates/pixel" "$DEST/templates/cm-pixel" "templates/cm-pixel"
copy_tree "$SRC_DIR/templates/hooks" "$DEST/templates/hooks" "templates/hooks"
copy_tree "$SRC_DIR/templates/refactor" "$DEST/templates/refactor" "templates/refactor"
copy_tree "$SRC_DIR/templates/ui-lens" "$DEST/templates/ui-lens" "templates/ui-lens"
copy_file "$SRC_DIR/templates/statusline/cm-statusline.sh" "$DEST/templates/cm-statusline.sh" "templates/cm-statusline.sh"
copy_file "$SRC_DIR/templates/hooks/pre-commit-cm-task-check" "$DEST/templates/cm-task-check-hook" "templates/cm-task-check-hook"
copy_file "$SRC_DIR/templates/refactor/cm-refactor-denies.json" "$DEST/templates/cm-refactor-denies.json" "templates/cm-refactor-denies.json"
copy_file "$SRC_DIR/templates/ui-lens/cm-ui-lens-extract.mjs" "$DEST/templates/cm-ui-lens-extract.mjs" "templates/cm-ui-lens-extract.mjs"

copy_file_atomic "$SRC_DIR/templates/auto-update/cm-update.sh" "$HOME/.cm-workflow/cm-update.sh" "~/.cm-workflow/cm-update.sh"
copy_file_atomic "$SRC_DIR/templates/auto-update/cm-announce.sh" "$HOME/.cm-workflow/cm-announce.sh" "~/.cm-workflow/cm-announce.sh"

for executable in \
  "$DEST/scripts/cm-check-runtime.sh" \
  "$DEST/templates/cm-statusline.sh" \
  "$DEST/templates/cm-task-check-hook" \
  "$DEST/templates/hooks/pre-commit-cm-task-check" \
  "$DEST/templates/dashboard/serve.sh" \
  "$DEST/templates/cm-dashboard/serve.sh" \
  "$DEST/templates/pixel/cm-pixel.sh" \
  "$DEST/templates/pixel/serve.sh" \
  "$DEST/templates/cm-pixel/cm-pixel.sh" \
  "$DEST/templates/cm-pixel/serve.sh"; do
  [ -f "$executable" ] && chmod +x "$executable"
done

mkdir -p "$DEST/templates"
echo "$VERSION" > "$DEST/templates/cm-VERSION"

echo
echo "完成（已安装版本: v${VERSION}）。"
echo "建议在 Claude Code 中运行 /cm-check 校验；macOS/Linux 也保留 /cm:check 别名。"
echo "自动更新器未自动启用；按 docs/installation.md 手工配置 SessionStart hook。"
