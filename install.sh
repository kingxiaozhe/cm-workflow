#!/usr/bin/env bash
# cm 工作流一键安装：commands / skills / agents → ~/.claude/
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"

echo "cm 工作流安装"
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

echo
echo "完成。建议在 Claude Code 中运行 /cm:check 校验安装一致性。"
echo "可选依赖（无设计稿时生成设计基准）: npx skills add alchaincyf/huashu-design"
