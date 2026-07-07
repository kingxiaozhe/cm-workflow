# N3: 执行 Task

## 开始标记

```text
🔨 Task {T-编号}: {任务描述} ~{预估时间}
   Feature {F}/{总F} | 任务 {N}/{总数}
```

## Skill 匹配

根据任务涉及的工种，查看可用的 `cm-*` skills：

- 前端 → `cm-frontend-engineer`
- 微信小程序 → `cm-miniprogram-engineer`
- 数据库 → `cm-database-engineer`
- 合约 → `cm-contract-engineer`
- QA/测试 → `cm-qa-engineer`
- 没有匹配 → AI 直接执行

有匹配的 skill → 调用该 skill 执行。

## 开发

- 参考 design.md 技术设计和 `.claude/rules/` 规范
- 技术选型自行选最优解，不暂停
- 业务逻辑/产品方向问题 → 暂停与用户沟通
