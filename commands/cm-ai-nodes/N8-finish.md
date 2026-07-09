# N8: 完成

所有 feature 的所有任务完成后：

## 1. 调用 cm-doc-syncer

调用 `cm-doc-syncer` skill 完成文档同步：

- README 精炼更新（架构 + 业务 + 快速开始）
- .claude/CLAUDE.md 和 rules/ 同步
- specs CHANGELOG 按日期生成
- 文档一致性验证

## 2. 生产发布待决清单

调用 `cm-devops-engineer` skill **编制**（只编制，不执行生产发布）。**staging 验证状态的数据源是 `{SPECS_DIR}/RELEASES.md`**，不凭记忆：

- 已通过 staging 验证的 feature 清单及版本（读 RELEASES.md）
- 生产迁移清单与执行顺序（含备份点）
- 新增环境变量清单（值由人在生产环境配置）
- 回滚预案位置

**生产发布由人决策触发**，不属于本流程的自动动作。

## 3. 度量汇总

读取 `{SPECS_DIR}/METRICS.md`，输出门槛对照（试点/灰度评审的直接输入）：

```text
📊 度量汇总
任务: {N} 个 | 人工介入均值: {x} 次/任务 | 一次通过率(复审仅1轮): {x}%
Codex 拦截: 共 {N} 条 | QA: 触发 {N} 次/通过 {N} | 总耗时: {x}
```

## 4. 输出总结

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
