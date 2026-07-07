# N2: 进入 Feature

1. 读取该 feature 的 requirements.md、design.md、tasks.md
2. 断点恢复：`[x]` 已完成 → 跳过，`[DROPPED]` → 跳过，`[CHANGED]` → 按更新后描述执行
3. 如该 feature 所有任务已完成 → 跳过，进入下一个 feature

## 执行计划

分析 tasks.md 的依赖关系，自行决定串行或并行：

| 串行 | 并行 |
| ---- | ---- |
| 有显式依赖 | 无依赖 |
| 会修改同一文件/模块 | 分属不同代码项目 |
| 涉及共享状态定义（schema、API） | 天然隔离 |

并行时用 Agent 工具派发子 agent。所有任务都有依赖时退化为全串行。

输出：

```text
📂 Feature {N}/{总数} — {feature名}
📋 执行计划：
  串行 1: T-001 → T-002
  并行 2: T-003 + T-004
  串行 3: T-005 ← 依赖 T-003, T-004
```
