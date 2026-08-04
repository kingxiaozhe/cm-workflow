# $cm-prd 阶段耗时事件

本规则复用 `runtime/logging.md` 的 `progress/start|complete`。时间以事件 envelope 的
`at` 为准，不新增计时器，不写调用方猜测的 `duration_ms`，也不启动心跳。

## 1. 事件配对

每个实际执行阶段在开始前写 `progress/start`，完成后写 `progress/complete`。一对事件
必须具有相同的 `operation_id`、`phase_name` 和 `segment`；`segment` 从 1 开始。

开始事件只记录上述三个字段。完成事件可追加以下最小元数据：

- `outcome`: `completed | awaiting_input | blocked`；
- `context_scope`、`feature_count`、`functional_count`、`ac_count`、`task_count`、
  `test_case_count`、`finding_count` 等非负计数或枚举；
- 审查阶段可记录 `reviewer`、`independent`、`verdict` 和相对 evidence 路径。

不得记录需求、源码、diff、prompt、模型回答、开放问题正文或用户回复正文。未实际执行
的阶段不写 start/complete，也不为了让图表完整伪造 `skipped`。

## 2. 新建模式边界

| operation_id / phase_name | start | complete |
| --- | --- | --- |
| `prd-context` / `context_load` | Step 4 读取项目上下文前 | 初次 `CONTEXT_SCOPE` 判定和加载完成后 |
| `prd-requirements` / `requirements_analysis` | Step 5 分析需求前 | Step 8 `requirements.md` 写完后 |
| `prd-design` / `design_generation` | Step 8.5 开始前 | Step 9 `design.md` 写完、Step 9.5 审查前 |
| `prd-design-review` / `design_review` | Step 9.5 实际触发审查前 | 审查凭证落盘且处置完成后 |
| `prd-task-split` / `task_split` | Step 10 拆任务前 | `tasks.md` 写完后 |
| `prd-spec-validation` / `spec_validation` | Step 10.4 前 | Step 10.5 测试合同校验与规格自检完成后 |
| `prd-spec-review` / `spec_review` | Step 10.6 审查前 | 审查凭证落盘且处置完成后 |

Step 9.5 未触发时不写 `prd-design-review`；已有 `decision/design_review` 继续记录跳过原因。

## 3. 变更模式边界

| operation_id / phase_name | start | complete |
| --- | --- | --- |
| `prd-context` / `context_load` | C1 定位 specs 前 | C3 现有 specs 与变更输入读取完成后 |
| `prd-requirements` / `requirements_analysis` | C4 对比分析前 | C5 `requirements.md` 更新完成后 |
| `prd-design` / `design_generation` | C6 前 | `design.md` 更新完成后 |
| `prd-task-split` / `task_split` | C7 前 | `tasks.md` 更新完成后 |
| `prd-spec-validation` / `spec_validation` | C7.5 前 | 测试合同更新、引用校验和审批位重算完成后 |

变更模式没有实际执行 Step 9.5/10.6 时，不写 review timing 事件。

## 4. 暂停、恢复与失败

需要等待用户回答、登录或选择时，在硬停车前写当前阶段 `progress/complete`，设置
`outcome: awaiting_input`。恢复后用相同 operation/phase、递增后的 `segment` 写新一对
start/complete；因此后续分析只汇总 active segments，不把人工等待算成执行耗时。

阶段无法继续时写 complete + `outcome: blocked`，随后按主流程写 warning/error/run_done。
同一 segment 不得出现两个 complete；恢复不得复用已关闭的 segment。

## 5. 最终报告

最终摘要只说明“阶段耗时事件已记录”，不在没有分析器核算时手算或猜测耗时。跨项目
分析读取 specs 权威日志或全局镜像，按 operation_id + segment 配对时间戳。
