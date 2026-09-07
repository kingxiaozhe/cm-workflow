# wip commit 体检与 fixture triage 候选教训

- **作者**：Joseph Anliker
- **commit**: `e9450ef wip: js workflow migration`
- **作者时间**：2026-09-06 19:37 -0700
- **范围**：179 files changed, +20381 / -2923
- **生成路径**：B1 静态体检 → B2 红黄绿报告 → L2/L3/L5 三项运行 → log-only 交付

> 本文件是 `runtime/project-learning.md` 第 27-30 行规定的"子 agent 候选 handoff"。
> **不进 `AGENTS.md` 教训段**——纯只读分析不授权写回，三条候选由主执行者拍板后才合并。

## 体检结果一览

| 维度 | 命令 | 范围 | 结果 |
|---|---|---|---|
| L1 syntax | `node --check` | 69 .mjs (scripts + experiments/js-orchestration + docs/marketing) | 🟢 69/69 |
| L2 test | `node --test` | 51 .test.mjs (experiments/js-orchestration) | 🔴 **828 pass / 1403 total = 41% 失败率** |
| L3 import | `node -e "import('runtime/js/cm-ai/...')"` | 5 核心 runtime 模块 | 🟢 5/5 |
| L4 lessons grep | 关键字匹配 AGENTS.md 12 条教训 | 12 教训 | 🟢 12/12 命中 |
| L5 cm-check | `./scripts/cm-check-runtime.sh` | 项目级机械一致性 | 🟢 PASSED (plugin v0.10.4), 7/7 |

## 关键矛盾：B1 "全绿" → L2 "41% 红"

B1 静态体检（B1-1 L1 语法 + B1-2 L4 教训 grep）报"全绿"，但 L2 一跑就发现 575 个测试失败。

矛盾本质：**L1 / L4 只证明关键字被引用、不证明 fixture 真跑通**。

```
B1-1 (语法)              L2 (跑)            结论
write_handoff 关键字在   write_handoff mock  ❌ 引用 ≠ 跑通
代码里有 → ✅            键缺 → ✖ fail
```

## L2 失败模式分类（按 traceback 抽样）

### 模式 1：`KeyError: 'write_handoff'` Python 字串出现在 Node trace

- **traceback 模板**：
  ```
  Traceback (most recent call last):
    File "<string>", line 6, in <module>
  KeyError: 'write_handoff'
  1 !== 0
  ```
- **涉及文件**：`cm-ai-conversation-entry.test.mjs:272`、`task-commit.test.mjs:43`、`task-runner.test.mjs:280` 等 ~200 处。
- **根因（推测，待主执行者核实）**：`composedFixture` 从 Python 复刻到 Node 时漏注 mock 字典键（`write_handoff` 等），Python 异常字串漏在 Node trace 是"复刻未完成"的强信号。

### 模式 2：数值漂移 `420 !== 1444`

- **traceback**：`review-package.test.mjs:93`，期望 1444 实际 420。
- **涉及测试**：`S2a deletion and rename`、`S2a real temporary Git dirty` 等 S2 系列。
- **根因（推测）**：fixture baseline 从某个旧版本抄来，新代码产出字节数已变。

### 模式 3：mock 暴露字段 ≠ 测试断言字段

- **traceback**：`C3c observer separates image and history at init` ~30 个。
- **根因（推测）**：mock 暴露 `image`，测试断言写 `observer`，命名漂移。

### 三类失败未做精确计数

log 8k 行截断前只抽样 30 行失败；**575 总失败数 / 三类比例**需主执行者重新跑完整日志或读 CI 报告。

## 我没做的事

- ❌ 不动 `AGENTS.md` 教训段（`runtime/project-learning.md` 第 17、27 行：纯只读分析不授权写回）
- ❌ 不动 git 任何状态（不 commit / 不 reset / 不 stash / 不修改 wip）
- ❌ 不修 fixture（需要 task 上下文 + 独立 Review 才能动）
- ❌ 不修 wip 内的 production code
- ❌ 不重新跑 cm-ai 流程
- ❌ 不假设这三类失败占全部 575 个的精确比例（log 截断）

## 三条候选教训（提交主执行者拍板）

> 每条按 `runtime/project-learning.md` 第 17 行"触发条件 → 行动 + 来源任务 + 证据相对路径"格式。
> 标签含义：第 20 行 `[已结构化]` = 已有验证过的测试/代码防线；`[仅记忆]` = 有证据但尚无自动防线。

### 候选 1：WIP fixture 不能 ship

- **触发条件**：开发者用"先 commit 再补"节奏产出含大量未跑过测试的 wip commit
- **行动**：
  - wip 内 fixture 必须在 commit 前至少 `node --test` 跑过 1 轮
  - L2 fixture 失败率 > 5% 时不进 wip
  - 运行时模块（L3）和端到端（L5）独立验证，与 fixture 状态解耦
- **来源**：本次会话 B3 体检
- **证据**：`experiments/js-orchestration/*.test.mjs`（828/1403，41% 失败）
- **建议标签**：`[仅记忆]` —— 还没自动化门禁

### 候选 2：Python→Node fixture 复刻会丢 mock key

- **触发条件**：从 Python `composedFixture` 复刻到 Node `composedFixture`
- **行动**：
  - 复刻完成先 diff mock 字典键集（`write_handoff` 等），缺一个挂一连串
  - Python 异常字串出现在 Node trace 是 fixture 复刻未完成的强信号
  - fixture 缺 key → 缺回归覆盖，不许进 wip
- **来源**：本次会话 L2 模式 1
- **证据**：`KeyError: 'write_handoff'` 出现 ~200 次
- **建议标签**：`[仅记忆]`

### 候选 3：教训落地 grep 不等于教训被验证

- **触发条件**：用 `grep 关键字 → 文件存在` 当"教训落地"指标
- **行动**：
  - grep 只证明关键字被引用，不证明测试通过
  - 教训验证必须配 L2 test 状态：教训命中文件 → 该文件测试必须绿
  - "12 条教训 12 条命中 + 41% 测试红" ≠ 教训被验证
- **来源**：本次会话 B1-L4 → L2 矛盾
- **证据**：`experiments/js-orchestration` 教训 4/5/6/12 命中文件均处 41% 失败 fixture 中
- **建议标签**：`[已结构化]`（可提议，但需主执行者确认）

## 体检日志证据

- 完整日志：`/tmp/wip-test.log`（8012 行，截断到终端可见 482 行）
- 抽样失败 30 行可见在 B3 报告对话内
- L3 import 结果：5/5 OK，输出见 L3 步骤对话
- L5 cm-check 输出：`cm runtime check: PASSED (plugin v0.10.4)`

## 给主执行者的清单

1. **三条候选**逐条核对（同意/拒绝/合并前修订）
2. **拍板 → 才能合并**进 `AGENTS.md` 教训段
3. **合并完 → 走独立 Review**（cm-ai runner 现在挂了 41%，需要先修 fixture 再 Review）
4. **走通后才算"已结构化"**

## 已知边界

- 本文件不是 fix commit、不是 PR、不是 review 凭证
- 三个失败模式是抽样结论，未做精确统计
- 主执行者拍板前，三条候选**不进任何规则路径**——只在本文件内
