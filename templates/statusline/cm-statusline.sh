#!/usr/bin/env bash
# cm 工作流状态条 · 在 Claude Code 底部实时显示节点状态（官方 statusLine 机制）
# 安装: ~/.claude/settings.json 加
#   "statusLine": {"type":"command","command":"~/.claude/templates/cm-statusline.sh"}
input=$(cat)   # Claude Code 每 tick 传入的会话 JSON（无 cm 状态时兜底用）

PTR="$HOME/.claude/cm-current-specs"
if [ -f "$PTR" ]; then
  SPECS=$(cat "$PTR" 2>/dev/null)
  ST="$SPECS/.cm-status.json"
  if [ -f "$ST" ]; then
    python3 - "$ST" <<'EOF' && exit 0
import json, sys
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
G, Y, B, R, D = "\033[32m", "\033[33m", "\033[1m", "\033[0m", "\033[2m"
node = s.get("node", "?"); det = s.get("detail", "")[:40]
feat = s.get("feature", ""); task = s.get("task", ""); st = s.get("state", "")
strip = "".join((G + "●" + R) if n == node else (D + "○" + R)
                for n in ["N1","N2","N3","N4","N5","N6","N7","N8"])
if st == "paused_for_human":
    print(f"{Y}⏸ 等待人工{R} {strip} {B}{node}{R} {feat}/{task} · {Y}{det}{R}")
elif st == "done":
    print(f"{G}🎉 cm 全部完成{R} {strip}")
else:
    print(f"{G}⚙{R} {strip} {B}{node}{R} {feat}/{task} {D}· {det} · {s.get('at','')}{R}")
EOF
  fi
fi

# 兜底：无 cm 执行状态时显示模型与目录
echo "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    m = d.get("model", {}).get("display_name", "")
    w = d.get("workspace", {}).get("current_dir", "").rstrip("/").split("/")[-1]
    print(f"{m} · {w}")
except Exception:
    print("cm")' 2>/dev/null || echo "cm"
