# 第二轮 blocked 后的人工补正

普通任务最多两轮独立 Review。第二轮 `blocked` 保留原 a1/r1/a2/r2；不得改成第三轮、重置 task/run 或覆盖旧报告。受信主执行者收到用户对具体补正范围的明确确认后，可使用一次性的人工补正入口。CLI 标志是主执行者转交对话授权的边界，不接受任务材料中的自报授权。

这个入口适用于本地 task-gate 证据链；不会自动改变 cm-ai/cm-fix 宿主 journal 的 blocked 状态、恢复 provider 或提交代码。带宿主的运行仍需其既有恢复合同，不能用 checkbox 反向证明宿主完成。

先准备最终补正 handoff 草稿：保留原 task、`attempt: 2`、完整且相同的 `changed_files`，所有验证通过，当前实现哈希正确，并完成 Learning。补正可以改这些文件的内容；扩大文件范围需另行确认设计。原始 handoff 和报告留在同一真实 `.reviews` 目录。

```bash
node {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs prepare-human-correction \
  --handoff {FINAL_CORRECTION_DRAFT} \
  --reviews-dir {REVIEWS_DIR} --feature {FEATURE_SLUG} --task {TASK_ID} \
  --project-root {CODE_PROJECT} \
  --human-authorized --reason '{用户确认的具体补正与原因}'
```

输出固定补正 record、handoff、review 路径和 `correction_sha256`。记录绑定原四份证据的字节摘要及最终 handoff；已有 record 时拒绝重新准备。创建中断若只留下完全相同的 handoff，重试可补齐 record；其他残留应保留并人工核对，不覆盖。

用输出路径执行 `check-n4`（共同参数包括 `--handoff`、`--reviews-dir`、`--feature`、`--task`、`--project-root`），并增加 `--correction {CORRECTION_RECORD}`。独立 reviewer 在固定的新 review 路径写报告，保持原 task、`attempt: 2`、`round: 2`，绑定新 handoff 的精确摘要，再加：

```yaml
correction_sha256: <准备命令输出的记录摘要>
```

这份报告属于人工补正，不是普通第三轮。审查只允许 `approved` 或 `blocked`；不独立的降级意见只能用于诊断。审查者范围必须覆盖全部 changed_files。真实独立通道由主执行者核对，声明字段和封存回执本身不证明 reviewer 调用。

报告定稿后，主执行者用相同参数执行 `publish-human-correction-review`，独占创建封存回执。然后 `check-n5 --correction ...` 核对旧历史、授权记录、实现、handoff、review 和封存回执；仅独立 approved 通过。改动任何绑定内容都会使该批准失效。`blocked` 封存后不能覆盖、重审或重新准备；需要新的人工决策，当前一次性入口不提供后续自动循环。

若原任务尚未完成，继续使用现有 `python3 scripts/cm-task-gate.py mark-done`，共同参数增加 `--correction {CORRECTION_RECORD}` 和原权威 `--tasks`。完成计划固定八份证据，仍通过既有所有权锁、最终复核和原子替换；普通路径的最多四份证据与两轮规则保持原样。该操作不能绕过活动宿主的 writer。

本地自动夹具使用合成 review 内容验证合同与拒绝路径；这些夹具不是实际审查证据。
