# JS 宿主 QA 恢复

本文是 [js-host.md](js-host.md) 的 N6 QA 恢复引用：QA 超时、阻断、中断、配置填错或项目收尾 QA 未通过时，按 js-host.md 的停机路由表读取对应一节。

## 补挂 QA

原无workflow或`qa:null`且任务已为`fixture_completed`时，可在`--mode resume`显式提供
含QA的`--workflow-config`与`--allow-qa`，一次性附加N6；原definition/scope/requirements/identity、
创建运行的 host-context（换会话时由 `--original-host-context` 声明）、开发/审查配置仍须匹配。journal追加不可重复/修改的`qa-attached`，运行日志写
`decision/qa_attach`；后续恢复须保持已绑定配置及重新授权，`qa`仍要求`qa_assess`等原宿主请求。
不重跑开发/审查，不将任务完成当作QA通过（事故：create漏配workflow曾使feature强制QA无法补做）。

## qa_browser 证据追问

`qa_browser` 只在一种情况下被追问一次：回答是 PASS、environment 与登记值相同、cleanup 未失败，但证据列表无效，或证据不在 specs 根的 `.reviews/` 下（或缺失、为空）。请求多带 `correction: {problems, instruction}`，`problems` 逐条给出 code 与路径；把实际观察到的证据复制到 `.reviews/qa-evidence/` 下重答，verdict、environment、cleanup 按实际观察保留，不再认可 PASS 就答 FAIL 或 BLOCKED。第二次回答照原规则判定（仍不合格即 BLOCKED，超时记 hostRequestTimeout），报告行 `answerCorrection` 保留问题与首次回答的 verdict/environment/cleanup。FAIL、BLOCKED、环境不符或清理失败的回答不追问，按原规则判定，需要时走显式恢复。

## qa_assess 超时

`qa_assess` 超时不再写 N6 决定：
`advance` 返回 `rejected/qa_decision_timeout`，用原配置 `--mode resume` 再 `advance` 会重新询问。
旧版本已把这种超时记成 `阻塞:host_request_timeout` 决定的运行，默认仍按原记录返回 `qa_blocked`（结果带
`reason: host_request_timeout`）；用户同意后以 `--mode resume --allow-qa --rerun-blocked-qa` 再 `advance`，
只重新询问一次 `qa_assess`，新决定以 `previous_decision_id` 链接旧决定追加到运行日志，旧行保留；
旗标随即消费，不再用于同一次调用的 QA 重跑。若替代决定已写入、首轮 `test_run/start` 前中断，用同一条命令再 `advance`
即按普通首轮继续，不再询问 `qa_assess`，也不必去掉旗标。第二次替代、非超时阻断或其他决定一律拒绝。
（事故：AI潮 bootstrap-T-002-r2 的 N6 评估超时 60 秒后被永久阻塞，context_refresh/finish 无法通过。）

## 未 complete 的 QA 中断

无 complete 的 N6 中断只能由用户显式重跑：保留原配置（含原 `--review-config` 与 `--workflow-config`），`--mode resume --allow-qa --rerun-unknown-qa`，
之后 `advance`；运行日志先记 `test_run/abandoned`，新 testRunId 保持原 qaRound，不重跑开发/审查。
已记录 case_complete 必须全为 PASS（允许零条），且无 case_blocked；abandoned 的 partial_pass_cases 记录旧 PASS 用例。
所有用例仍全部重跑，旧 PASS 证据文件只作历史保留。任一 FAIL/BLOCKED、固定报告
`{testRunId}-execution.md` 或未清理资源都不满足恢复条件；保留 unknown/阻断供人工核对，
不删报告或日志来获得重跑资格，不伪造 complete。仅写了 abandoned 后再中断可沿同一授权入口恢复。
例外：整轮 `qa_execution_timeout` 中断、无报告、无 FAIL，且每条 case_blocked 都是宿主请求超时（行上 `host_request_timeout: true`；
旧行无此字段时须 case_start 到 case_blocked 满 `qa.timeoutMs`，且同一命令带 `--qa-environment-failure "原因"` 声明没有应答，否则 `qa_environment_failure_required`）、不是会话自答 BLOCKED，同一 `--rerun-unknown-qa`
写 `test_run/superseded`（`reason: host_request_timeout`）并在 qaRound+1 重跑全部命令与用例；对它用 `--rerun-blocked-qa` 拒绝为 `qa_rerun_unknown_qa_required`。

## 已 complete 的宿主证据或环境阻断

已 complete 的宿主证据或环境阻断可用单任务 `--mode resume --review-config {原审查配置} --workflow-config {原配置} --allow-qa --rerun-blocked-qa`，
再 `advance`：仅最新结果为 BLOCKED、failed=0、qaRound<3，且每条 BLOCKED 都是 browser 的 evidenceProblem、
cleanup=failed、环境摘要不一致、hostRequestTimeout 或会话自己回答的 BLOCKED（报告行 `hostDeclaredBlocked`，
例如模拟器当时不可用），logic 的 INSUFFICIENT_EVIDENCE 或只因映射命令没有退出码而阻断（报告行 `commandUnavailable`），或 commands 行没有退出码
（`host check: timeout/signal_exit/spawn_failed/output_*/cleanup_failed`，例如 xcodebuild 超时或被杀）时允许。
taskIds 全部是 `[DROPPED]` 任务的用例不进 QA 计划（不问会话，只为它们声明的命令也不跑），报告 `not_applicable` 节记
`NOT_APPLICABLE`，不计数；旧版本把它们排进收尾 QA 而得到的会话 BLOCKED / logic INSUFFICIENT_EVIDENCE 符合上述条件，
用本节命令在原运行重跑即按新计划执行，PASS 后被 `project_qa_not_passed` 拦住的其他运行原配置 `--mode resume` 再 `advance`。
没有声明命令（commands-unavailable）、延后用例（no-applicable-cases）、`[需确认]`（logic 报告行 `needsConfirmation`，
即使映射命令同时没有退出码）、缺浏览器能力、源码漂移和未 complete 不适用；
是否仍有 `[需确认]` 以该 feature 的 `test-cases.json` 为准，并与报告标记交叉核对（两者任一显示未确认即拒绝）；
“只因命令没有退出码”由已记录的命令行推出，报告的 `commandUnavailable` 必须一致；“会话自己回答 BLOCKED”以执行器当时经日志写入器
追加的 `test_run/case_blocked` 行上的 `host_declared_blocked: true` 为准，报告的 `hostDeclaredBlocked` 只作核对。只删改报告里的这些标记不能换来重跑资格。
旧版本报告里会话回答的 BLOCKED 没有标记，仍不适用。新写入的 superseded 行带 `recovery_rule: 2`；旧版本写入、
没有该字段的 superseded 行按旧版本原规则回放（例如 logic INSUFFICIENT_EVIDENCE 行照旧有效）。配置填错应使用下述“QA 配置修订”。
非零退出码是产品 FAIL，不会被重新归类；确认是环境造成（例如模拟器运行时缺失时 `xcodebuild test` 退出 65）时，
可在同一命令加 `--qa-environment-failure "原因"`（单行，最多 500 UTF-8 字节，必须与 `--rerun-blocked-qa` 同用，仅单任务宿主）：
只接受最新结果为 FAIL 且每条 FAIL 都是有退出码的命令行、或只因这类映射命令失败的 logic 用例；browser FAIL、
`CONTRADICTED`、已接受修复的 FAIL 均拒绝。superseded 行记 `reason=declared_environment_failure`、`environment_failure_reason`、
`failed_cases` 与 `blocked_cases`。这不是放行：新一轮在同一代码上全部重跑，真有缺陷仍会 FAIL。
先写 `test_run/superseded`（previous_test_run_id、reason=host_evidence_problem 或上述声明原因、blocked_cases），再以新 testRunId、
qaRound+1 写带 previous_test_run_id 的 start，全部用例重跑，占用同一个三轮 QA 预算；旧 PASS 仅保留历史，最多三轮，不重做 QA 决策、
开发或审查，不改 tasks。开关一次性消费且不持久化，不与 --rerun-unknown-qa 合用；仅写 superseded 后中断，
须重新显式授权恢复。complete 同步 N6 状态镜像为 qa_passed/qa_failed/qa_blocked，并显示本轮通过/失败/阻断数量。
（事故：宿主把非文件说明混入 browser evidence，导致已完成任务的收尾 QA 无法恢复。）

**信任边界（QA 恢复）**：恢复判定以这些输入为准——已批准的 feature `test-cases.json`（`[需确认]`），
以及经日志写入器在应答或记录当时追加到 `运行日志.jsonl` 的行（N6 决定、`test_run` 的 start/case/complete 计数与结果、superseded），
配置修订另以运行 journal 为准。`.reviews/{testRunId}-execution.md` 执行报告是本地证据：逐例 verdict、静态结论、命令退出码与
browser 证据字段都从报告读取，只与上述日志计数、case_blocked 行和用例契约交叉核对；有人刻意手改报告并保持计数一致
（例如对调两个用例的 verdict）不在防御范围内。重跑始终在同一代码上执行全部用例，这类改动最多多占一个 QA 轮次，不能凭空得到 PASS。

## QA 配置修订

最新 QA 已产生完整结果，或 QA 还没开跑（见下方首轮前修订），但命令、环境或 QA 预算填错时，先保留上一版 workflow JSON，再修改新文件。用户明确同意本次配置改动后，用单任务宿主恢复：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume \
  --host-context {原宿主身份} --allow-development --review-config review.json \
  --workflow-config workflow-new.json --allow-qa \
  --revise-qa-config workflow-old.json \
  --qa-config-revision-reason "补齐此前漏配的项目测试命令"
```

原运行需要的审查、保护配置和跨会话身份参数仍须照原值提供，然后发送 `advance`。旧运行只保存完整配置摘要，没有可逆的配置副本，所以必须提供上一版文件核对；不能凭一个新摘要接受任意漂移。旧文件仅用于验证，不执行其命令。

- 首轮 QA 前也可修订：只要这个 run 还没有任何 `test_run` 行（开发中、待审、已审批，或 N5 完成后 QA 决定已触发但未开跑），
  同一命令即可恢复，不必先用已知错误的命令跑一轮。journal 追加 `qaRound: 0`、`testRunId: null` 的 `qa-config-revised`
  （绑定当时的审查包，尚无审查包时为 null），运行日志写一次 `decision/qa_config_revise`；不写 superseded，首轮仍是 qaRound 1。
  首轮前可连续修订；已有 unknown effect、已取消或完成后代码漂移（correction_review_required）的运行拒绝 `qa_revision_not_completed`。
  QA 一旦开跑，后续修订照旧消耗一轮；首轮后出现的 round-0 修订或其日志镜像会在恢复时以 `qa_revision_invalid` 拒绝。
- 修订仅接受 `resume`、`--allow-qa`、非空原因和相符的上一版配置；不能与两个 QA 重跑开关合用。只允许 QA 命令、环境、QA 预算及其派生执行计划变化，任务身份、规格、开发、审查、项目策略、文档与能力配置均保持原绑定。reviewer 的纯传输超时本来就不参与授权摘要，无需本入口。
- 先追加 `qa-config-revised`，绑定前后指纹、QA 配置摘要、原因、原审查包及旧 QA 轮次；再追加 `test_run/superseded`，原因是 `qa_configuration_revision`。旧结果留在历史，不再作为当前通过或修复依据；原开发、审查、N5、任务勾选和历史字节不改写。
- 新 QA 使用新 testRunId，全部用例重跑，轮次加一且最多三轮；另行绑定实际完成的开发 attempt，第二次开发审查通过后也能恢复。未完成或结果未知的 QA 必须先核对原执行；本入口不证明资源已清理，不放宽源码漂移检查，不重置轮次，也不自动批准产品修复。
- 配置链验证成功后，后续恢复只需当前配置与原授权参数，不再需要旧文件。重复同一修订命令不会重复登记；若中断发生在 journal 写入之后，会补齐旧 QA 的作废日志，再运行下一轮。未使用此入口时，改 QA 命令、环境或预算仍报 `fingerprint_mismatch`。
- 项目 `.cm-workflow.yml`、`~/.cm-workflow/runtimes.yml` 与插件内置默认值不进入新运行的指纹。它们推出的执行计划（用例、命令、阶段、mode/case_count）由每轮 QA 在 N6 重新冻结，并记入该轮 `test_run`；所以为 `--auto-qa-fix` 设 `policies.auto_fix: auto`、执行 `cm-runtime set --user`、规范任务写出 `.cm-workflow.yml` 或升级插件后，原运行照常恢复，本入口也不再用当前配置重建旧计划。此前版本创建的运行仍按原指纹（含当时的 CM 配置）打开：配置已变时报 `fingerprint_mismatch`，`reason` 提示把这些配置恢复为创建时的内容。

本次仅支持单任务宿主；批量宿主未接入该选项。临时夹具覆盖漏命令死锁、正常续跑、连续修订与三轮上限、旧证据拒绝及中断回放；不代表真实模型或浏览器验收。

## 项目收尾核对全部 feature 的 QA

`finish` 与 `run_finalize` 在写 run_done 前核对每个已批准 feature 最新一次 QA 决策：触发的 QA 必须以完整 PASS 结束，
阻塞决策不算通过。任一 feature 最新一轮 FAIL、BLOCKED、已触发未执行、结果未知或旧结果已作废待下一轮时，返回
`blocked/project_qa_not_passed`，`outstandingQa` 与 `reason` 列出 feature、任务和 runId；不做文档核验，不写 run_done。
准入仍按 tasks.md 选下一任务，但在 `warnings` 里提示这些 feature。按对应运行的恢复入口（QA 修复、`--rerun-blocked-qa`、
`--rerun-unknown-qa` 或配置修订）让它通过后，再对本运行 `advance` 收尾。任务未做完的 feature 允许中途的 skipped 决策；
任务已全部完成的 feature 必须以 feature 完成时的 QA PASS 结束，没有 QA 记录（`qa_missing`）或最新决策是 skipped
（`qa_skipped`）同样拒绝——JS 流程不能关闭 N6，这类 feature 只可能在流程外完成。恢复：把它的末任务改回 `- [ ]`，
用 cm-ai 重跑（有审查证据时加 `--supersede-reviewed-evidence`），让 N6 补上 feature 完成时的 QA。
