# N2: 进入 Feature

1. 读取该 feature 的 requirements.md、design.md、tasks.md
2. 断点恢复：`[x]` 已完成 → 跳过，`[DROPPED]` → 跳过，`[CHANGED]` → 按更新后描述执行
3. 如该 feature 所有任务已完成 → 跳过，进入下一个 feature

## 教训定向注入（防复发，两个动作）

- **筛相关教训**：按本 feature 的领域/模块/技术栈关键词从 `LESSONS.md` 筛出相关条目（`[仅记忆]` 级优先——`[已结构化]` 的已有代码防线兜底），把要点列进执行计划输出；并行派发时相关教训随 specs 摘录一并写进 agent 指令。全量加载靠注意力,定向注入才可靠（实跑教训：Infinity 防线教训在库仍复发）
- **必扫「待触发备忘」段**：逐条判断触发条件是否与本 feature 相关——命中 → 升级为任务或在执行计划中显式认领；未命中 → 不动。扫过即在执行计划输出一行 `📌 备忘扫描: 命中 {N} 条 / 共 {N} 条`，零条也要输出（可见性纪律）

## 执行计划

分析 tasks.md 的依赖关系，自行决定串行或并行：

| 串行 | 并行 |
| ---- | ---- |
| 有显式依赖 | 无依赖 |
| 会修改同一文件/模块 | 分属不同代码项目 |
| 涉及共享状态定义（schema、API、design token） | 天然隔离 |

并行时用 Agent 工具派发子 agent，**优先使用 `cm-*-agent` 预定义角色**（cm-frontend-agent / cm-ui-agent / cm-miniprogram-agent / cm-backend-agent / cm-database-agent / cm-contract-agent，见 agents/ 目录）。派发指令必须包含：任务编号、该任务的 specs 摘录、design.md 中的接口契约。所有任务都有依赖时退化为全串行。

**分工原则**：并行干活的用 agent（agent 管纪律：只做指定任务、不碰界外文件、不自行标记、规范汇报）；串行把关的用 skill（QA、doc-syncer 不做 agent）。agent 产出返回后，仍逐个走 N4 → N5。

### 并行模式升级：Agent Teams（可选）

同时满足以下条件时，将并行组升级为 Agent Teams 队友（而非子 agent）：

- 环境已启用 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
- 并行组内的任务分属**不同代码项目**（如前端仓库 + 后端仓库）

队友规则：

1. **一个队友绑定一个代码项目**，绝不允许两个队友修改同一文件
2. 生成提示中必须包含：该任务的 specs 摘录、design.md 中的接口契约、应使用的工种 skill 名称（如 `cm-frontend-engineer`）
3. 队友在**接口契约变更**时（API 字段、schema、事件格式）立即用消息通知相关队友同步，不等任务结束
4. 队友完成后，产出仍**逐个回到 N4（审查）→ N5（标记）** 走完质量门禁，不因并行而跳过
5. 该并行组结束后关闭所有队友，再进入下一组

任一条件不满足 → 维持默认行为（Agent 工具派子 agent 或串行）。Teams 是可选加速器，不是硬依赖。

输出：

```text
📂 Feature {N}/{总数} — {feature名}
📋 执行计划：
  串行 1: T-001 → T-002
  并行 2: T-003 + T-004
  串行 3: T-005 ← 依赖 T-003, T-004
```
