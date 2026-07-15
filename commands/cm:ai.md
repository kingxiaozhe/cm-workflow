# /cm:ai — 自动开发

`$ARGUMENTS` — specs 文件夹路径 + 代码项目路径。

```bash
/cm:ai specs在~/projects/my-app-specs，代码在~/code/my-app
/cm:ai ~/projects/specs 前端~/code/fe 后端~/code/api
```

## 流程图

按此流程执行，到达每个节点时读取 `~/.claude/commands/cm-ai-nodes/` 下对应的节点文件获取详细规则。

```text
START
  │
  ▼
[N1: 初始化] ── 解析输入、扫描 features、加载上下文
  │
  ▼
┌─► [N2: 进入 Feature] ── 读取 specs、分析依赖、输出执行计划
│     │
│     ▼
│   ┌─► [N3: 执行 Task] ── 检查 skill → 开发
│   │     │
│   │     ▼
│   │   [N4: Review] ── AI 自审 → Codex Review
│   │     │
│   │     ▼
│   │   [N5: 标记完成] ── tasks.md 标 [x]、写 LESSONS.md
│   │     │
│   │     ▼
│   │   [N6: QA 评估] ── 评分决定是否触发 cm-qa-engineer
│   │     │
│   │     ▼
│   │   [N7: 上下文管理] ── /clear → 重新加载 specs
│   │     │
│   │     ▼
│   │   还有未完成 task? ──YES──┘
│   │     │
│   │    NO
│   │     │
│   │     ▼
│   └── Feature 完成 → /clear
│         │
│         ▼
│       还有下一个 Feature? ──YES──┘
│         │
│        NO
│         │
│         ▼
      [N8: 完成] ── 调用 cm-doc-syncer → 输出总结
        │
        ▼
       END
```

## 全局规则

**暂停（仅灾难级）：** 不可逆破坏（删数据、动线上、不可回滚迁移）、资金/密钥/合规风险、交付形态级架构错向、环境阻塞到无法继续。
**不暂停（多方案自主决策）：** 执行中出现多个可选方案时——技术选型、实现路径、库/工具选择、审查意见分歧——**自己分析利弊选最优解直接执行，不询问**。代价是留痕义务：把「选了什么 / 为什么 / 放弃了什么」写进任务汇报，方向性取舍追记 LESSONS.md——人可以事后翻案，但流程不为选择题停车。业务逻辑歧义按需求文档最合理解释执行并显式记录所做假设，仅当触及灾难级清单才暂停。
**度量：** 每次暂停问人，恢复后在当前任务的 METRICS.md 记录里人工介入计 1 次并注明原因（见 N5）。
**状态落盘（供状态条/看板实时点亮节点）：** 每进入一个节点（N1–N8），覆盖写入 `{SPECS_DIR}/.cm-status.json` 单行 JSON：
`{"node":"N4","feature":"1.xxx","task":"T-005","detail":"一句话当前动作","state":"running","at":"HH:MM:SS"}`
——**detail 必须写大白话**，标准是"路过的非工程师扫一眼能懂"：写"正在开发数据接口"不写"cm-backend-engineer 执行 T-004"；写"第2轮代码审查"不写"对抗式子agent复审"；写"确认一下：原型里有3个按钮点了没反应,要做吗?"不写"原型死区待确认"。节点号/任务号由状态条自动放在行尾角标，detail 里不要再写。
——暂停等人时 `state` 改为 `paused_for_human`（detail 写等什么），全部完成时 N8 写 `done`。N1 时**额外把 specs 绝对路径写入 `~/.claude/cm-current-specs`**（终端状态条据此定位）。每节点一次写入，成本可忽略，不得跳过。
**运行日志（事后复盘与工作流优化的原始证据）：** 与状态落盘同节奏，把关键事件**追加**（不覆盖）到 `{SPECS_DIR}/运行日志.jsonl`，一行一个 JSON：
`{"at":"2026-07-15T14:22:10","node":"N3","feature":"1.xxx","task":"T-005","event":"task_start","detail":"一句话大白话"}`
**必记事件（event 取值固定）**：`node_enter`（每次进节点）、`task_start` / `task_done`（done 的 detail 记一次通过与否）、`review`（轮次+拦截数+通道: codex/子agent/自审）、`degrade`（降级及失败原文）、`pause` / `resume`（等什么、人答了什么）、`decision`（多方案自主决策: 选了什么/为什么/放弃了什么）、`error`（执行报错与重试）、`qa`（N6 结论）、`done`（N8 收尾）。
写日志与写 .cm-status.json 同时机同成本，不得跳过；只追加不清理不截断。**反馈工作流问题时，把这份文件连同 METRICS.md 一起带回**——它是定位流程卡点、优化节点设计的第一手依据。

**终端任务清单镜像：** 进入每个 feature（N2）时，把该 feature 的任务镜像到 Claude Code **内置任务清单**（TaskCreate/TodoWrite，一任务一条，含编号与标题）；N3 开始执行置 in_progress，N5 标记时同步置 completed——终端原生渲染勾选进度，无需任何外部工具。**断点恢复时**：已完成（`[x]`）任务直接以 completed 状态镜像或跳过，`[DROPPED]` 不镜像——不得重复创建条目。

**执行策略：** AI 自主决策串行或并行（无依赖 + 不同项目 → 并行，否则串行）。
