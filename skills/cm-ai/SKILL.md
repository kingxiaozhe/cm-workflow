---
name: cm-ai
description: 执行已经人工审查的 CM specs，按 N1-N8 完成任务开发、独立审查、度量、QA 与文档同步；支持断点恢复和安全并行。
---

# cm-ai — 自动开发

执行前读取 `../../runtime/project-context.md`、`../../runtime/orchestration.md` 与 `../../runtime/review.md`。Codex 入口为 `$cm-ai`；Claude Code 跨平台入口为 `/cm-ai`，macOS/Linux 另有历史别名 `/cm:ai`。

`用户本轮输入` — specs 文件夹路径 + 代码项目路径。

```bash
$cm-ai specs在~/projects/my-app-specs，代码在~/code/my-app
$cm-ai ~/projects/specs 前端~/code/fe 后端~/code/api
```

## 流程图

按此流程执行，到达每个节点时读取 `references/` 下对应的节点文件获取详细规则。

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
│   │   [N4: Review] ── 主执行者自审 → 独立审查
│   │     │
│   │     ▼
│   │   [N5: 标记完成] ── tasks.md 标 [x]、写 LESSONS.md
│   │     │
│   │     ▼
│   │   [N6: QA 评估] ── 评分决定是否触发 cm-qa-engineer
│   │     │
│   │     ▼
│   │   [N7: 上下文管理] ── 从磁盘重读 specs 与项目约束
│   │     │
│   │     ▼
│   │   还有未完成 task? ──YES──┘
│   │     │
│   │    NO
│   │     │
│   │     ▼
│   └── Feature 完成 → 重建下一 Feature 的上下文
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
**节点间不停车：** 除上述灾难级与各节点显式卡点（入口闸/降级知情/形态确认/涉合规走查）外，任何节点完成后**直接进入下一节点**——不得以"我将要…是否继续?"、"完成了 X,需要我继续吗?"这类问句收尾等待。阶段性汇报写在输出里照常可见,但回合不能停在等确认上（实跑反馈:执行器习惯性在节点末尾问一句,用户被迫每阶段点头,自动化名存实亡）。
**度量：** 每次暂停问人，恢复后在当前任务的 METRICS.md 记录里人工介入计 1 次并注明原因（见 N5）。
**状态落盘（供状态条/看板实时点亮节点）：** 每进入一个节点（N1–N8），覆盖写入 `{SPECS_DIR}/.cm-status.json` 单行 JSON：
`{"node":"N4","feature":"1.xxx","task":"T-005","detail":"一句话当前动作","state":"running","at":"HH:MM:SS"}`
——**detail 必须写大白话**，标准是"路过的非工程师扫一眼能懂"：写"正在开发数据接口"不写"cm-backend-engineer 执行 T-004"；写"第2轮代码审查"不写"对抗式子agent复审"；写"确认一下：原型里有3个按钮点了没反应,要做吗?"不写"原型死区待确认"。节点号/任务号由状态条自动放在行尾角标，detail 里不要再写。
——暂停等人时 `state` 改为 `paused_for_human`（detail 写等什么），全部完成时 N8 写 `done`。N1 时可将 specs 绝对路径同步到当前运行时的状态镜像（Claude 兼容运行时为 `~/.claude/cm-current-specs`，Codex/OMX 为对应 session 状态），但 `{SPECS_DIR}/.cm-status.json` 始终是跨运行时真相。每节点一次写入，不得跳过。
**运行日志（事后复盘与工作流优化的原始证据）：** 与状态落盘同节奏，把关键事件**追加**（不覆盖）到 `{SPECS_DIR}/运行日志.jsonl`，一行一个 JSON。**`at` 一律 ISO 8601 带时区偏移**（`date +%Y-%m-%dT%H:%M:%S%z` 风格，如 `2026-07-17T10:05:25+08:00`）——实跑发现三个项目分别用了无时区/`Z`/`+08:00` 三种格式，跨项目看板排序失真：
`{"at":"2026-07-15T14:22:10","node":"N3","feature":"1.xxx","task":"T-005","event":"task_start","detail":"一句话大白话"}`
**必记事件（event 取值固定）**：`node_enter`（每次进节点）、`task_start` / `task_done`（done 的 detail 记一次通过与否）、`review`（轮次+拦截数+通道: `codex-subagent`/`codex-cli`/`self-degraded`）、`degrade`（降级及失败原文）、`pause` / `resume`（等什么、人答了什么）、`decision`（多方案自主决策: 选了什么/为什么/放弃了什么）、`error`（执行报错与重试）、`qa`（N6 结论）、`done`（N8 收尾）。
写日志与写 .cm-status.json 同时机同成本，不得跳过；只追加不清理不截断。**反馈工作流问题时，把这份文件连同 METRICS.md 一起带回**——它是定位流程卡点、优化节点设计的第一手依据。

**任务状态镜像：** `tasks.md` 是唯一权威任务源。运行时支持任务面板时，可将未完成任务镜像到 Codex/OMX 计划或 Claude 任务清单；N3/N5 同步状态。断点恢复必须由磁盘重建镜像：`[x]` 跳过或标为 completed，`[DROPPED]` 不镜像，不得重复创建条目。

**执行策略：** 遵守 `runtime/orchestration.md`；串行默认，只有无依赖、文件边界不重叠、契约已稳定且环境确实支持时才可并行。
