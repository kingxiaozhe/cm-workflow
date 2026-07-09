#!/usr/bin/env bash
# cm 工作流状态条 · Claude Code 底部实时显示（官方 statusLine 机制）
# 输出原则: 大白话,路过的人扫一眼能懂;工程细节收在行尾暗色角标
input=$(cat)

PTR="$HOME/.claude/cm-current-specs"
if [ -f "$PTR" ]; then
  SPECS=$(cat "$PTR" 2>/dev/null)
  ST="$SPECS/.cm-status.json"
  if [ -f "$ST" ]; then
    python3 - "$ST" "$SPECS" <<'EOF' && exit 0
import json, sys, os, re
try:
    s = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
SPECS = sys.argv[2]
G, Y, B, R, D = "\033[32m", "\033[33m", "\033[1m", "\033[0m", "\033[2m"

PHASE = {  # 节点 → 人话阶段
    "N1": ("🚀", "启动准备"), "N2": ("📋", "规划任务"), "N3": ("🔨", "开发中"),
    "N4": ("🔍", "检查代码"), "N5": ("💾", "保存进度"), "N6": ("🧪", "质量检测"),
    "N7": ("🧹", "整理现场"), "N8": ("📦", "收尾总结"),
}
node = s.get("node", ""); st = s.get("state", "")
det = s.get("detail", "")[:44]; feat = s.get("feature", ""); task = s.get("task", "")
feat_name = re.sub(r"^\d+\.", "", feat)  # 去掉编号前缀

def progress(feature):
    """当前 feature 的任务进度: (完成数, 总数, 当前序号)"""
    try:
        md = open(os.path.join(SPECS, feature, "tasks.md"), encoding="utf-8").read()
        items = re.findall(r"^- \[( |x)\] (T-\d+)", md, re.M)
        active = [(c, t) for c, t in items]
        done = sum(1 for c, _ in active if c == "x")
        cur = next((i + 1 for i, (c, _) in enumerate(active) if c == " "), len(active))
        return done, len(active), cur
    except Exception:
        return None

icon, phase = PHASE.get(node, ("⚙", "运行中"))
tag = f"{D} ·{node}{' '+task if task else ''}{R}"   # 工程角标,暗色收尾

if st == "paused_for_human":
    print(f"{Y}🖐 等你确认：{det} —— 流程已暂停,回 Claude Code 回复即可{R}{tag}")
elif st == "done":
    print(f"{G}✅ 全部完成!{R} 所有任务已交付,收尾报告见会话{tag}")
else:
    p = progress(feat) if feat else None
    prog = f"（进度 {p[0]}/{p[1]}）" if p else ""
    body = f"{det}" if det else phase
    fpart = f"{B}{feat_name}{R} · " if feat_name else ""
    print(f"{G}{icon} {phase}{R} {fpart}{body}{D}{prog}{R}{tag}")
EOF
  fi
fi

# 兜底：无 cm 执行时显示模型与目录
echo "$input" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
    m = d.get("model", {}).get("display_name", "")
    w = d.get("workspace", {}).get("current_dir", "").rstrip("/").split("/")[-1]
    print(f"{m} · {w}")
except Exception:
    print("cm")' 2>/dev/null || echo "cm"
