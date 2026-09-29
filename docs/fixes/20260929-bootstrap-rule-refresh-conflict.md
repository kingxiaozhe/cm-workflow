# Bootstrap 规则刷新误判为冲突

## 现象与复现

同一已批准 bootstrap feature 的 T-002 已生成并完成规则文件。后续 T-010 以相同固定目标执行规则刷新时，首轮 `advance` 在 `init_generate` 之前抛出 `bootstrap_instruction_conflict`，运行落入 `unknown/execution_error`，无开发派发或文件写入。

复现尝试：T-002 完成且六个目标已提交、T-010 待执行 → T-010 首轮开发 → 旧实现把已存在规则视为无本任务证据的冲突。新增 `scripts/cm-ai-bootstrap-merge.test.mjs` 的刷新与提交基准用例在修复前失败，修复后通过。

## 根因与修法

原规则通道只认空目标、仅含 `## 项目教训` 的 `AGENTS.md`，或同一任务先前 attempt 的写入证据。它没有后续任务的可信基准。宿主又在 develop effect 内才检查目标，所以可预判的冲突被归为执行异常。

后续规则任务现在要求同一 bootstrap feature 中已有完成的规则任务，绑定代码项目 HEAD 的固定目标原始 blob 摘要，并在派发前核对暂存区和工作文件。草稿可刷新规则正文，但 `AGENTS.md` 的项目教训段必须逐字保留，仍经核验与独立 Review。基准不符时进入可回放的 `blocked/bootstrap_instruction_conflict`，不派发、不写入；还原目标及暂存区后可在原 run 恢复。若 HEAD 改变，须新建 run 绑定新提交。生成后发生的并发漂移仍保留原 `unknown` 语义。

未另建规则刷新入口：现有已批准 bootstrap 任务和固定目标合同足以表达该操作，新入口会复制审批与审查边界。旧 `unknown` 运行不会被自动改写；核实旧 writer 已关闭后，用新 runId 按现有 reviewed-evidence supersession 流程重建。

## 波及面与验证

- `host-bootstrap`、`task-runner` 和 journal replay：后续任务基准、派发前 blocked、回放。
- 规则驾驶员：同一提交基准的启动预检与合入逻辑。
- 回归：首次规则生成、后续刷新、暂存区/工作文件漂移、blocked 后原 run 恢复、生成后漂移、项目教训保留。
- 测试：`scripts/cm-ai-bootstrap-merge.test.mjs`、`scripts/cm-ai-bootstrap-flow.test.mjs`、`scripts/cm-ai-bootstrap.test.mjs`、`scripts/cm-ai-drive-bootstrap-rules.test.mjs`；`./scripts/cm-check-runtime.sh`、公开仓库验证与安全扫描。
