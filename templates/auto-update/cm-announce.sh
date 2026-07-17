#!/usr/bin/env bash
# SessionStart hook：把 cm-update.sh 留下的更新播报，在 Claude Code 启动时报给用户。
# 报完即删——只报一次。没有待播报内容时输出空，不打扰。
set -uo pipefail

ANNOUNCE="$HOME/.cm-workflow/pending-announce"
[ -s "$ANNOUNCE" ] || exit 0

msg="$(cat "$ANNOUNCE")"
rm -f "$ANNOUNCE"

# 用 jq 转义，消息里的引号/换行/中文都不会破坏 JSON
if command -v jq >/dev/null 2>&1; then
  jq -n --arg m "$msg" '{systemMessage: $m}'
else
  # jq 缺席时的兜底：手工转义最低限度的字符
  esc="$(printf '%s' "$msg" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk '{printf "%s\\n", $0}')"
  printf '{"systemMessage": "%s"}\n' "$esc"
fi
