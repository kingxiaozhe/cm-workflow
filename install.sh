#!/usr/bin/env bash
# cm 工作流一键安装：commands / skills / agents → ~/.claude/
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
VERSION="$(cat "$SRC_DIR/VERSION" 2>/dev/null || echo 未知)"

echo "cm 工作流安装  v$VERSION"
echo "  来源: $SRC_DIR"
echo "  目标: $DEST"
echo

for part in commands skills agents; do
  src="$SRC_DIR/$part"
  dst="$DEST/$part"
  [ -d "$src" ] || { echo "跳过 $part（源目录不存在）"; continue; }

  mkdir -p "$dst"

  # 检测将被覆盖的已有文件
  conflicts=$(cd "$src" && find . -type f | while read -r f; do
    [ -e "$dst/$f" ] && echo "$f"
  done || true)

  if [ -n "$conflicts" ]; then
    echo "⚠ $part 下以下文件已存在，将被覆盖："
    echo "$conflicts" | sed 's/^/    /'
    read -r -p "  继续覆盖 $part？[y/N] " ans
    case "$ans" in
      y|Y) ;;
      *) echo "  跳过 $part"; continue ;;
    esac
  fi

  cp -R "$src/." "$dst/"
  echo "✓ $part 已安装（$(cd "$src" && find . -type f | wc -l | tr -d ' ') 个文件）"
done

# rules 模板骨架（cm:init 生成规则时的基础）
if [ -d "$SRC_DIR/templates/rules" ]; then
  mkdir -p "$DEST/templates/cm-rules"
  cp -R "$SRC_DIR/templates/rules/." "$DEST/templates/cm-rules/"
  echo "✓ rules 模板已安装 → $DEST/templates/cm-rules/（$(ls "$SRC_DIR/templates/rules" | wc -l | tr -d ' ') 个）"
fi
if [ -f "$SRC_DIR/templates/arch-reference.md" ]; then
  cp "$SRC_DIR/templates/arch-reference.md" "$DEST/templates/arch-reference.md"
  echo "✓ 架构基准参考表已安装（G1 离线兜底,联网时自动校验刷新）"
fi
if [ -d "$SRC_DIR/templates/dashboard" ]; then
  mkdir -p "$DEST/templates/cm-dashboard"
  cp -R "$SRC_DIR/templates/dashboard/." "$DEST/templates/cm-dashboard/"
  chmod +x "$DEST/templates/cm-dashboard/serve.sh"
  echo "✓ 可视化看板已安装（启动: ~/.claude/templates/cm-dashboard/serve.sh {specs路径}）"
fi
if [ -f "$SRC_DIR/templates/statusline/cm-statusline.sh" ]; then
  cp "$SRC_DIR/templates/statusline/cm-statusline.sh" "$DEST/templates/cm-statusline.sh"
  chmod +x "$DEST/templates/cm-statusline.sh"
  echo "✓ 终端状态条已安装。启用请在 ~/.claude/settings.json 加:"
  echo '    "statusLine": {"type":"command","command":"~/.claude/templates/cm-statusline.sh"}'
fi
if [ -d "$SRC_DIR/templates/pixel" ]; then
  mkdir -p "$DEST/templates/cm-pixel"
  cp -R "$SRC_DIR/templates/pixel/." "$DEST/templates/cm-pixel/"
  chmod +x "$DEST/templates/cm-pixel/cm-pixel.sh" "$DEST/templates/cm-pixel/serve.sh"
  echo "✓ 像素流水线已安装（终端版: ~/.claude/templates/cm-pixel/cm-pixel.sh；浏览器版: 同目录 serve.sh {specs路径}）"
fi

mkdir -p "$DEST/templates"
echo "$VERSION" > "$DEST/templates/cm-VERSION"

echo
echo "完成（已安装版本: v$VERSION，/cm:check 会显示它——反馈问题时请带上版本号）。"
echo "建议在 Claude Code 中运行 /cm:check 校验安装一致性。"
echo "可选依赖（无设计稿时生成设计基准）: npx skills add alchaincyf/huashu-design"
