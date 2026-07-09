#!/usr/bin/env bash
# cm 工作流可视化看板 · 纯只读,零侵入(只消费 specs 落盘文件)
# 用法: ./serve.sh /path/to/specs [端口,默认 8788]
set -euo pipefail
SPECS="${1:?用法: ./serve.sh /path/to/specs [端口]}"
PORT="${2:-8788}"
[ -d "$SPECS" ] || { echo "specs 目录不存在: $SPECS"; exit 1; }
cp "$(cd "$(dirname "$0")" && pwd)/dashboard.html" "$SPECS/.cm-dashboard.html"
echo "✓ 看板已启动: http://localhost:$PORT/.cm-dashboard.html  (Ctrl+C 停止)"
cd "$SPECS" && exec python3 -m http.server "$PORT" --bind 127.0.0.1
