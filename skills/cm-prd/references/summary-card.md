# Step 11：摘要范围规则

- 摘要卡增加「历史 feature：N 个已登记，M 个含旧版归档说明」；M 按存在归档异常的 feature 去重，具体异常放入 `notes`。
- 摘要只裁决本会话 `currentFeatures`；历史 feature 保留完整 `documents`、`specFiles` 与发布证据哈希，审查门禁结果只登记，旧版归档或缺失回执进入 `notes`，不进入 `blockers`、新草稿机械自检或当前设计风险裁决（2026-09-17 真实项目 dogfood：已开发 specs 目录新增 feature 时，摘要因历史 feature 的 `[x]`、旧版归档与已完成任务被三重阻断）。
- 准备、复核与发布沿用同一当前 feature 清单；无草稿时只从 `.reviews/prd-sessions` 当前会话记录恢复，无法确定时报 `prd_summary_scope_unknown` 停止，不回退为全目录重审。
- 当前 feature 的回执覆盖、归档读取、机械自检仍严格执行；`[x]` 的只读规范化不豁免新任务必须待办。历史说明不表示重新审查或批准，发布 `.cm-specs-status` 仍覆盖全部 feature 规格哈希。
- 功能与任务统计、自检和设计风险裁决以当前 feature 为准；历史登记单独呈现。旧 API 不传 `currentFeatures` 时保持原严格检查语义，宿主必须显式提供范围。
