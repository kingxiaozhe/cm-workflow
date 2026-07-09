# N8: 完成

所有 feature 的所有任务完成后：

## 1. 调用 cm-doc-syncer

调用 `cm-doc-syncer` skill 完成文档同步：

- README 精炼更新（架构 + 业务 + 快速开始）
- .claude/CLAUDE.md 和 rules/ 同步
- specs CHANGELOG 按日期生成
- 文档一致性验证

## 2. 生产发布待决清单

调用 `cm-devops-engineer` skill **编制**（只编制，不执行生产发布）：

- 已通过 staging 验证的 feature 清单及版本
- 生产迁移清单与执行顺序（含备份点）
- 新增环境变量清单（值由人在生产环境配置）
- 回滚预案位置

**生产发布由人决策触发**，不属于本流程的自动动作。

## 3. 输出总结

```text
🎉 全部完成

📂 Features: {完成数}/{总数}
📋 总任务: {完成数}/{总数}
📝 文档同步: 已完成
🚀 生产发布待决清单: 已编制，等待人工决策

各 Feature 摘要:
- 1.{name}: {N} 个任务 ✅ (staging 已验证)
- 2.{name}: {N} 个任务 ✅ (staging 已验证)
```
