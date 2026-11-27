#!/usr/bin/env bash
# cm 工作流状态条 · Claude Code 底部实时显示（官方 statusLine 机制）
# 输出原则: 大白话,路过的人扫一眼能懂;工程细节收在行尾暗色角标
input=$(cat)

# 全局记录 ~/.claude/cm-current-specs 只是「上一次用 CM 的项目」，所有会话共用。
# 只在它属于当前会话的项目时才显示：用 Claude Code 经标准输入传来的 cwd 判断，
# 属于别处的旧状态（含「可能已中断」）整条不显示（实跑教训：别的会话显示了不相干项目的旧状态）。
# 已知限制：规格目录与代码目录互相不包含（如 ~/code/app 与 ~/projects/app-specs）时，
# 在代码目录开的会话不显示 CM 状态；要显示需在状态文件里记项目根，属另一个改动。
PTR="$HOME/.claude/cm-current-specs"
specs_belong_here() {
  CM_SL_INPUT="$input" python3 - "$1" <<'PYEOF'
import json, os, subprocess, sys
try:
    d = json.loads(os.environ.get("CM_SL_INPUT", ""))   # 脚本走 heredoc，stdin 不能再读 JSON，改走环境变量
except Exception:
    sys.exit(1)
cwd = d.get("cwd") or d.get("workspace", {}).get("current_dir") or ""
if not cwd:
    sys.exit(1)   # 拿不到当前目录就不显示,宁缺毋滥
specs, cwd = os.path.realpath(sys.argv[1]), os.path.realpath(cwd)
roots = [cwd]
try:
    # 清掉继承来的 GIT_* 环境变量：它们会让 git 指向别的仓库（别会话的旧项目）
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    top = subprocess.run(["git", "-C", cwd, "rev-parse", "--show-toplevel"],
                         capture_output=True, text=True, timeout=2, env=env).stdout.strip()
    if top:
        roots.append(os.path.realpath(top))
except Exception:
    pass

def inside(child, parent):
    # child 在 parent 内（含相同）；用 samefile 比较，大小写不敏感的文件系统上也认得同一目录
    p = child
    while True:
        try:
            if os.path.samefile(p, parent):
                return True
        except OSError:
            pass
        up = os.path.dirname(p)
        if up == p:
            return False
        p = up

# 过宽的根（/、家目录及其上级）会把别的项目也算进来：不当作项目根
home = os.path.realpath(os.path.expanduser("~"))
too_broad = lambda r: inside(home, r)
# 路径已不存在（目录被删）不比较，免得沿父目录误放行
if not (os.path.isdir(specs) and os.path.isdir(cwd)):
    sys.exit(1)
# 规格目录本身过宽（指针指向家目录等）也不显示：否则家目录下任何项目都会命中
if too_broad(specs):
    sys.exit(1)
def depth(child, root):
    return os.path.relpath(child, root).count(os.sep) + 1
ok = False
for r in roots:
    if too_broad(r) or not os.path.isdir(r):
        continue
    # specs 在项目内（最多 4 层，如 项目/specs/功能名），或当前目录在 specs 内
    if (inside(specs, r) and depth(specs, r) <= 4) or inside(r, specs):
        ok = True
sys.exit(0 if ok else 1)
PYEOF
}
if [ -f "$PTR" ]; then
  SPECS=$(cat "$PTR" 2>/dev/null)
  ST="$SPECS/.cm-status.json"
  if [ -f "$ST" ] && specs_belong_here "$SPECS"; then
    python3 - "$ST" "$SPECS" <<'EOF' && exit 0
import json, sys, os, re, time
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
age = time.time() - os.path.getmtime(sys.argv[1])   # 状态新鲜度
node = s.get("node", ""); st = s.get("state", "")
if st == "done" and age > 3600:
    sys.exit(1)   # 完成态过期 1 小时 → 回落默认显示,不再霸屏
det = s.get("detail", "")[:44]; feat = s.get("feature", ""); task = s.get("task", "")
feat_name = re.sub(r"^\d+\.", "", feat)  # 去掉编号前缀

def progress(feature):
    """当前 feature 的任务进度: (完成数, 总数, 当前序号)"""
    try:
        md = open(os.path.join(SPECS, feature, "tasks.md"), encoding="utf-8").read()
        items = re.findall(r"^- \[( |x)\] (T-[A-Za-z0-9][A-Za-z0-9._-]*)(?=[:：\s])", md, re.M)
        active = [(c, t) for c, t in items]
        done = sum(1 for c, _ in active if c == "x")
        cur = next((i + 1 for i, (c, _) in enumerate(active) if c == " "), len(active))
        return done, len(active), cur
    except Exception:
        return None

icon, phase = PHASE.get(node, ("⚙", "运行中"))
tag = f"{D} ·{node}{' '+task if task else ''}{R}"   # 工程角标,暗色收尾

if st not in ("paused_for_human", "done") and age > 600:
    # 崩溃残留检测: 运行态超 10 分钟无更新,大概率已中断——错误的仪表比没有仪表危险
    print(f"{Y}⚠ 可能已中断{R}（最后更新 {int(age//60)} 分钟前,去会话确认）{D}原状态: {phase}·{det[:20]}{R}{tag}")
elif st == "paused_for_human":
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
