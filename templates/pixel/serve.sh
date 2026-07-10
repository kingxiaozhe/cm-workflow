#!/usr/bin/env bash
# cm 像素流水线(浏览器版) · 纯只读,零侵入(只消费 specs 落盘文件)
# 用法: ./serve.sh /path/to/specs [端口,默认 8799]
#   演示模式(不需要 specs 在跑): 打开 http://localhost:8799/.cm-pixel.html?demo
set -euo pipefail
SPECS="${1:?用法: ./serve.sh /path/to/specs [端口]}"
PORT="${2:-8799}"
[ -d "$SPECS" ] || { echo "specs 目录不存在: $SPECS"; exit 1; }
cp "$(cd "$(dirname "$0")" && pwd)/cm-pixel.html" "$SPECS/.cm-pixel.html"
echo "✓ 像素流水线已启动: http://localhost:$PORT/.cm-pixel.html  (Ctrl+C 停止)"
echo "  演示模式: http://localhost:$PORT/.cm-pixel.html?demo"
cd "$SPECS" && exec python3 -m http.server "$PORT" --bind 127.0.0.1
