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

**暂停：** 业务逻辑歧义、不确定的安全问题、破坏性变更、环境阻塞。
**不暂停：** 纯技术选型 — 选最优解直接执行。
**度量：** 每次暂停问人，恢复后在当前任务的 METRICS.md 记录里人工介入计 1 次并注明原因（见 N5）。
**状态落盘（供可视化看板实时点亮节点）：** 每进入一个节点（N1–N8），覆盖写入 `{SPECS_DIR}/.cm-status.json` 单行 JSON：
`{"node":"N4","feature":"1.xxx","task":"T-005","detail":"一句话当前动作","state":"running","at":"HH:MM:SS"}`
——暂停等人时 `state` 改为 `paused_for_human`（detail 写等什么），全部完成时 N8 写 `done`。每节点一次写入，成本可忽略，不得跳过。

**执行策略：** AI 自主决策串行或并行（无依赖 + 不同项目 → 并行，否则串行）。
