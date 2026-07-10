#!/usr/bin/env bash
# cm 像素小剧场 · 终端版
# 8 个像素工位对应 N1–N8,小人走到哪个工位,流水线就跑到哪一步。
# 纯只读消费 .cm-status.json / tasks.md,零侵入。
#
# 用法:
#   ./cm-pixel.sh            # 跟随当前 cm 运行实时播放(2s 刷新,Ctrl-C 退出)
#   ./cm-pixel.sh --demo     # 演示模式:循环播放 8 节点+暂停+完成,无需真实运行
#   ./cm-pixel.sh --once     # 只渲染一帧后退出(截图/调试用)
MODE="${1:-}"
python3 - "$HOME/.claude/cm-current-specs" "$MODE" <<'PYEOF'
import json, os, re, sys, time

PTR, MODE = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else "")

# ---------- 调色板(GameBoy 绿系 + 功能色) ----------
P = {
    ".": None,               # 透明
    "k": (24, 28, 24),       # 深底
    "g": (48, 98, 48),       # 暗绿
    "G": (110, 170, 80),     # 亮绿
    "W": (224, 240, 208),    # 米白
    "y": (240, 200, 60),     # 黄(暂停/高亮)
    "o": (230, 140, 60),     # 橙(皮肤)
    "b": (90, 140, 220),     # 蓝(工装)
    "r": (210, 80, 80),      # 红
    "c": (100, 200, 200),    # 青(屏幕)
    "d": (60, 66, 60),       # 桌灰
    "m": (140, 120, 200),    # 紫(Codex机器人)
    # 分关卡底色(huashu 像素横版:晨/昼/暮/夜,暗场压灰)
    "A": (54, 42, 44), "B": (34, 44, 58), "C": (48, 38, 54), "D": (24, 24, 42),
}
ZONE = lambda i: "A" if i < 2 else ("B" if i < 5 else ("C" if i < 7 else "D"))

PHASE = {
    "N1": "启动", "N2": "规划", "N3": "开发", "N4": "审查",
    "N5": "保存", "N6": "质检", "N7": "整理", "N8": "收尾",
}
NODES = list(PHASE)

# ---------- 精灵(字符串像素图) ----------
DESK = [  # 7x4 工位:显示器+桌子
    ".ccc...",
    ".ccc...",
    "ddddddd",
    ".d...d.",
]
WORKER = [  # 5x6 小人,两帧(敲键盘手起手落)
    [".ooo.", ".ooo.", ".bbb.", "bbbbb", ".b.b.", ".b.b."],
    [".ooo.", ".ooo.", "bbbb.", ".bbbb", ".b.b.", ".b.b."],
]
WORKER_HAND_UP = [".ooo.", ".ooo.", "bbbbo", ".bbb.", ".b.b.", ".b.b."]  # 举手(暂停)
ROBOT = [".mmm.", ".mcm.", "mmmmm", ".m.m."]  # Codex 机器人(N4 常驻)
FLAG = ["G", "GG", "GGG"]  # 完成小旗

CW, CH = 78, 22  # 画布尺寸(像素);半块渲染后 = 78 x 11 行


def blank():
    cv = []
    for y in range(CH):
        row = []
        for x in range(CW):
            i = min(7, max(0, (x - 1) // 10))
            row.append(ZONE(i))
        cv.append(row)
    return cv


def blit(cv, sprite, x, y):
    for dy, row in enumerate(sprite):
        for dx, ch in enumerate(row):
            if ch != "." and 0 <= y + dy < CH and 0 <= x + dx < CW:
                cv[y + dy][x + dx] = ch


def render(cv, dim=False):
    """半块字符渲染:每两行像素合成一行字符,上像素=前景▀,下像素=背景"""
    out = []
    for y in range(0, CH, 2):
        line = []
        for x in range(CW):
            t, b = P[cv[y][x]], P[cv[y + 1][x]]
            if dim:
                t = tuple(v // 2 for v in t)
                b = tuple(v // 2 for v in b)
            line.append(f"\033[38;2;{t[0]};{t[1]};{t[2]}m\033[48;2;{b[0]};{b[1]};{b[2]}m▀")
        out.append("".join(line) + "\033[0m")
    return out


def scene(node, state, frame):
    cv = blank()
    # 地板
    for x in range(CW):
        cv[CH - 1][x] = "g"
        cv[CH - 2][x] = "g"
    # 天体: 昼区太阳 / 夜区星星(隔帧闪烁)
    for dx in range(3):
        for dy in range(2):
            cv[1 + dy][1 + 3 * 10 + 3 + dx] = "y"
    for j, (sx, sy) in enumerate([(72, 1), (75, 3), (73, 6), (76, 8), (71, 4)]):
        if (frame + j) % 4:
            cv[sy][sx] = "W"
    idx = NODES.index(node) if node in NODES else 0
    done_all = state == "done"
    for i in range(8):
        x0 = 1 + i * 10  # 每工位 10px 宽
        blit(cv, DESK, x0, CH - 6)
        if i == 3:  # N4 工位常驻 Codex 机器人(坐在桌对面)
            blit(cv, ROBOT, x0 + 4, CH - 10)
        if done_all or i < idx:
            blit(cv, ["..G", ".GG", "GGG"], x0 + 5, CH - 9)  # 已过节点插小旗
        if not done_all and i == idx:
            sprite = WORKER_HAND_UP if state == "paused_for_human" else WORKER[frame % 2]
            blit(cv, sprite, x0 + 1, CH - 12)
            cv[CH - 13][x0 + 2] = "y" if state == "paused_for_human" else "W"  # 头顶指示点
    if done_all:  # 烟花
        import random
        rnd = random.Random(frame)
        for _ in range(26):
            cv[rnd.randrange(2, 10)][rnd.randrange(2, CW - 2)] = rnd.choice("yWrcG")
    return cv


def progress(specs, feature):
    try:
        md = open(os.path.join(specs, feature, "tasks.md"), encoding="utf-8").read()
        items = re.findall(r"^- \[( |x)\] (T-\d+)", md, re.M)
        return sum(1 for c, _ in items if c == "x"), len(items)
    except Exception:
        return None


DEMO = [  # 演示剧本:(node, state, detail, feature)
    ("N1", "running", "正在检查项目环境和版本控制", ""),
    ("N2", "running", "正在读需求、排任务", "1.market-board"),
    ("N3", "running", "正在开发行情数据接口", "1.market-board"),
    ("N4", "running", "第1轮代码审查进行中", "1.market-board"),
    ("N4", "paused_for_human", "确认一下:这个按钮点了以后要跳到哪个页面?", "1.market-board"),
    ("N5", "running", "保存进度:数据接口完成", "1.market-board"),
    ("N6", "running", "质量检测和业务走查", "1.market-board"),
    ("N7", "running", "整理现场,准备下一个任务", "1.market-board"),
    ("N8", "running", "收尾:整理文档和发布清单", ""),
    ("N8", "done", "全部完成", ""),
]

BAR_W = 30


def draw(frame):
    if MODE == "--demo":
        node, state, detail, feature = DEMO[(frame // 3) % len(DEMO)]
        prog, task, age = (3, 6), "T-005", 0
    else:
        try:
            specs = open(PTR).read().strip()
            s = json.load(open(os.path.join(specs, ".cm-status.json")))
            age = time.time() - os.path.getmtime(os.path.join(specs, ".cm-status.json"))
        except Exception:
            return ["", "  ⏳ 没有运行中的 cm 工作流(等待 /cm:ai 启动…)", ""]
        node, state = s.get("node", "N1"), s.get("state", "running")
        detail, feature, task = s.get("detail", ""), s.get("feature", ""), s.get("task", "")
        prog = progress(specs, feature) if feature else None

    dim = state == "paused_for_human"
    lines = ["  \033[1mcm 像素流水线\033[0m" + ("  \033[33m⏸ 等人\033[0m" if dim else "")]
    lines += ["  " + l for l in render(scene(node, state, frame), dim=False)]
    # 工位标签
    lab = []
    for i, n in enumerate(NODES):
        name = f"{n}{PHASE[n]}"
        if state == "done" or (n != node and i < NODES.index(node) if node in NODES else False):
            lab.append(f"\033[32m{name}\033[0m")
        elif n == node and state != "done":
            lab.append(f"\033[1;33m{name}\033[0m" if dim else f"\033[1;97m{name}\033[0m")
        else:
            lab.append(f"\033[2m{name}\033[0m")
    lines.append("  " + "  ".join(lab))
    # 台词气泡(大白话,与状态条同源)
    icon = "🖐" if dim else ("🎉" if state == "done" else "💬")
    tag = f"  \033[2m{task}\033[0m" if task else ""
    lines.append(f"  {icon} {detail[:56]}{tag}")
    # 进度条
    if prog:
        d, t = prog
        fill = int(BAR_W * d / t) if t else 0
        lines.append(f"  进度 \033[32m{'█'*fill}\033[2m{'░'*(BAR_W-fill)}\033[0m {d}/{t}"
                     + (f"  \033[2m{feature}\033[0m" if feature else ""))
    if MODE != "--demo" and state not in ("done", "paused_for_human") and age > 600:
        lines.append(f"  \033[33m⚠ 可能已中断\033[0m(最后更新 {int(age//60)} 分钟前,去会话确认)")
    return lines


if MODE == "--once":
    print("\n".join(draw(0)))
    sys.exit(0)

sys.stdout.write("\033[?1049h\033[?25l")  # 备用屏 + 藏光标
try:
    f = 0
    while True:
        frame_txt = "\n".join(draw(f))
        sys.stdout.write("\033[H\033[2J" + frame_txt + "\n\n  \033[2mCtrl-C 退出\033[0m\n")
        sys.stdout.flush()
        time.sleep(1 if MODE == "--demo" else 2)
        f += 1
except KeyboardInterrupt:
    pass
finally:
    sys.stdout.write("\033[?25h\033[?1049l")
PYEOF
