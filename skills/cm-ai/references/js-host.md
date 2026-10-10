# 当前会话作为 JS workflow 工具宿主

规格待审批时先展示摘要卡并请用户回复“开始”。`approvalIntent` 仅把“开始”“开始吧”
“可以开始”“确认开始”“开始执行”“现在开始”“可以，请开始开发”（允许尾部中英文句末标点与空白）视为
明确开始；“继续”“可以”“好”“好的”“OK”“按最优解处理”“你看着办”“行”仍不审批。
`not_approval` 时提示明确回复“开始”；写审批位仍须原 `--approve` 门禁。

## 文档分工与停机路由

本文只写正常路径。M 按「启动前」第 6 项在启动前读；R、Q 只在运行停住时按下表读：

- M = [js-host-modes.md](js-host-modes.md)：外部模型配置、bootstrap 规范任务、多代码目录、受保护执行与文本提案模式。
- R = [js-host-recovery.md](js-host-recovery.md)：开发、审查、完成、规格、跨会话与重跑的恢复。
- Q = [js-host-qa-recovery.md](js-host-qa-recovery.md)：N6 QA 恢复与项目收尾 QA。
- C = `../../../docs/js-workflow-control.md`；E = `../../../docs/external-models.md`。

返回下表 state/code/pendingAction 或驾驶员退出 1/2 时，先读对应一节；表外代码按「执行当前请求，而非手工跳节点」末段报告并停止。

| 返回或情况 | 读哪里 |
| --- | --- |
| `decision`、`complete`、`qa`、`qa_execution`（`qa_triggered`）、`context_refresh`（`qa_passed`、`qa_skipped`、`context_refreshed`）、`documentation_sync`（`documentation_sync_required`）、`run_finalize`（`documentation_synced`）、`finish`、`start_next_task`、`changes_requested`、`revision_answer_required` | 本文「单步驾驶员」「执行当前请求，而非手工跳节点」 |
| `spec_approval`／`awaiting_spec_approval`、`not_approval` | 本文开头 |
| `original_host_context_unavailable`、`review_configuration_required` | 本文「启动前」第 3、5 项 |
| `parallel_scope_existing_file`、`parallel_dependency_conflict` | 本文「启动前」3.1 |
| `fingerprint_mismatch`、`invalid_arguments`、换会话恢复、`host-joined` | R「恢复参数与跨会话接手」 |
| `resume` 下的 `develop_checks_not_passed`、旧 `checks_not_passed`、`develop_package_too_large`、`develop_empty_changes`、`develop_requirement_missing`、`develop_unchanged_after_review`、`develop_call_timeout`（开发应答超时）、`develop_answer_invalid`（开发应答超出字段上限）；`unknown/limit_exceeded`、`store_failure`、`empty_changes`；`request_too_large`、`host_response_too_large`、`host_response_mismatch`；大小上限或 `runId` 长度致退出 2 | R「开发交付阻断与存档限额」 |
| `check_answer_missing`、`check_answer_invalid`、`complete_recheck_failed`、`develop_answer_missing`、`develop_redo`、`develop_redo_worker_*`、`develop_dispatch_failed`、`role_log_failed`、`host_response_late`、`check_answer_retry_limit`、`complete_recheck_limit`、`develop_redo_limit` | R「应答缺失、无效或迟到」 |
| `developer_result_invalid`、`failed/invalid_result`、`protected_edit_stale` | R「开发结果校验失败」 |
| `develop_retry_limit`、`completion_checks_changed`、`completion_package_changed`、`completion_retry_limit`、`package_mismatch`、`out_of_scope` | R「重试名额与完成前复查」 |
| `review_transport_timeout`、`review_provider_failed`、`review_verdict_invalid`、verdict `blocked`、`supersede_code_drift`、`review_package_changed` | R「规格漂移、代码漂移与审查失败」「审查计时与快照忽略」 |
| `spec_drift`（`spec_rebind`／`none`） | R「规格漂移、代码漂移与审查失败」「已批准规格材料（第 24 步）」 |
| preflight `unrecognized_model`、`stopped_by_probe` | R「审查配置诊断失败」 |
| `abandon_review`、`abandon_effect`、`review_abandoned`、`unknown/reconciliation_required`、`effect_abandoned`、`develop_interrupted`、`complete_commit_interrupted`、`effect_interrupt_*`、`commit_recovery_conflict`、`review_abandon_budget_exhausted` | R「放弃审查调用与 effect」 |
| `qa_device_unverified`、`documentation_sync_blocked` | QA「浏览器用例请求超时：设备可能仍被占用」「文档核对与同步」 |
| `review_redispatch`、`review_redispatch_limit`、`review_process_unverified`、`review_observation_invalid`、`review_boundary_unverified` | R「每轮无结论重派」 |
| `bootstrap_verification_failed`、`bootstrap_instruction_conflict`、`bootstrap_review_mismatch`、`bootstrap_review_recover`、`init-verify` 命令未通过 | R「bootstrap 规范任务的恢复」 |
| `correction_review_required`、`fix_record_too_large`、存储目录 `limit_exceeded` | R「已完成运行上的后续改动」 |
| `handoff_exists`、`review_limit`／`review_blocked` 后重做同一任务 | R「已审交接后的任务重跑」 |
| `develop_out_of_scope`（开发改动超出 scope，reason 列路径） | R「应答缺失、无效或迟到」 |
| `check_output_out_of_scope`、`unknown/out_of_scope`、iOS 沙箱检查失败 | M「Codex 单任务：显式受保护执行」 |
| `bootstrap_feature_ambiguous` | M「bootstrap feature 与规则写入」 |
| 补挂 QA（`qa_attach`） | Q「补挂 QA」 |
| `qa_browser` 带 `correction` | Q「qa_browser 证据追问」 |
| `qa_decision_timeout`；`qa_blocked` 且 `reason: host_request_timeout` | Q「qa_assess 超时」 |
| `qa_execution_unknown`、`qa_execution_timeout`、`qa_environment_failure_required`、`qa_rerun_unknown_qa_required`、`qa_round_invalid`（第 3 轮之后）、`qa_resources_open`、`batch_resources_open` | Q「未 complete 的 QA 中断」 |
| `qa_blocked`、`qa_result_blocked`、`qa_failed` 的宿主证据或环境原因 | Q「已 complete 的宿主证据或环境阻断」 |
| QA 命令、环境或预算填错；`qa_revision_not_completed`、`qa_revision_invalid` | Q「QA 配置修订」 |
| 收尾门禁 `project_qa_not_passed`（含未满足的 `qa_missing`／`qa_skipped`） | Q「项目收尾核对全部 feature 的 QA」 |
| 其余 `reconcile`（含 `execution_error`） | C「`pendingAction: "reconcile"` 时该做什么」 |
| `reconcile_review`、`review_evidence`（`provider_review_observed`） | E「中断与兼容边界」 |
| `verification_precheck_failed` | C「交付前验证闸门」 |
| `protected_scope` | C「项目规则文件的修改通道」 |
| `fix_authorization`、`fix_dispatch`、`qa_fix_code_unmatched`、`qa_fix_incomplete`、`qa_round_limit` | C「QA 失败交接」「独立 QA 修复入口」 |
| QA 修复子运行需要 `rediagnose`、`rerun_blocked_step`、`recover_final_review`、`revision_test_check`；`qa_fix_action_authorization_required` | cm-fix js-host「QA 修复子流程的恢复操作」 |
| 批次成员停在 `develop_redo`、`abandon_effect`、`abandon_review`、`bootstrap_review_recover`；`batch_member_action_authorization_required`、`batch_member_action_not_current`、`batch_member_action_unavailable`、`batch_parallel_member_recovery_required`、`batch_parallel_member_unresolved`、`batch_member_rescheduled`、`batch_qa_revision_unavailable`、`batch_spec_rebind_unavailable` | R「批次成员的恢复操作」 |
| `decision_required`、`permission_denied`、`provider_development_authorization_required`、`qa_decision_required`、`qa_mandatory_required`、`documentation_sync_blocked`、outcome `rejected`／`denied`、`cancelled`、其他 `none` | 本文「执行当前请求，而非手工跳节点」末段；授权见「启动前」第 5 项 |

## 当前会话手动驱动：用驱动脚本，不要自己搭 FIFO

普通单任务和 bootstrap 骨架 T-001、规范任务（通常 T-002）用 `cm-ai-drive.mjs`，批次用 `cm-ai-batch-drive.mjs`；修复用 `cm-fix-drive.mjs`，规格编写用 `cm-prd-drive.mjs`。它们负责保持宿主 stdin、应答反问并按 callId 配对结果，无需后台保活 FIFO。规范任务按下文[用单步驾驶员](js-host-modes.md#bootstrap-规范任务用单步驾驶员)准备答案文件；批次驾驶员仍不支持规范任务，启动前退出 2。`cm-ai`、批次和 `cm-prd` 驱动的 `--help` 列出计划字段；普通单任务最小调用：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-drive.mjs" --plan "{PLAN.json}" advance
```

先按下节准备计划及真实答案文件。计划中的 `checks` 须为实际可执行的命令；驱动不接受静态检查结果代替执行。

## 单步驾驶员

仓库自带 `../../../scripts/cm-ai-drive.mjs`，按上例一次启动宿主、发送一个 operation、回答这一轮的反问并打印结果。

`PLAN.json` 与 cm-fix 驾驶员一样，以自身目录解析相对路径；填写 `config`（已批准的运行定义）、
`mode`、当前真实 `hostContext`、`runtime`、原样传给宿主的 `permissions`、`answers` 和
`checks: [{"id":"syntax","command":["node","--check","target.mjs"]}]`。同会话恢复可省略
`originalHostContext`；换会话恢复必须填创建运行的会话 ID，且运行存档必须已存在。第 1 轮开发结果放 `answers/develop.json`（也可用
`develop-a1.json`，两者不能同时存在）；第 2 轮只读 `answers/develop-a2.json`，绝不复用第 1 轮答案。
`edits` 把批准 scope 内路径映射到以下之一：答案目录里的内容文件名（写入；已有文件保留权限，新文件为 0644）、
`{"file":"内容文件","mode":"0755"|"0644"}`（写入并设权限）、`{"mode":"0755"|"0644"}`（只改已有文件的权限位）、
`{"delete":true}`（删除已有文件）。改名是删除旧路径加写入新路径，两个路径都要在 scope 内。同时列在
`requirements` 里的路径不能删除（审查包要求每个 requirements 文件存在），启动前即拒绝；当前会话若仍删掉了这类文件，
结果是可重试的 `blocked/develop_requirement_missing`，恢复该文件后 `--mode resume` 再 `advance`。
`resume` 时驾驶员按存档里的当前轮次发送 identity，第 2 轮的 `decision`、`complete`、`qa` 等无需手改。
初次 `create` 或恢复到
`ready` 第 1 轮时，若 `advance` 同时带 `--allow-review-attempt 1`，审查后可能直接进入第 2 轮开发；
缺 `develop-a2.json` 会在启动前退出 2。尚未看到首轮 findings 时，从 `PLAN.permissions` 移除该审查授权，
先 `advance` 到 `awaiting_review`，再以运行返回的 `packageDigest` 执行 `decision`；读取
`.reviews/<feature>-<task>-r1.md`，如需修改则写好 `develop-a2.json` 再 `advance`。
若有意一次完成，也可预先写好 `develop-a2.json` 后带审查授权运行。`develop-a2.json` 必须针对首轮 findings 修改：
第 2 轮交付与第 1 轮被要求修改的代码逐字节相同（`artifactDigest` 相同）时停在可重试的
`blocked/develop_unchanged_after_review`，不送审、不耗第 2 轮审查；改好 `develop-a2.json` 后在原 run `advance`，
以新的 develop effect id 重新交付。
其余人工文件为
`qa-assess.json`、`documentation-inspect.json`、`documentation-sync.json`；QA 修复子运行沿用
cm-fix 的 `learning.json`、`diagnosis.json`、`test-edits.json`、`repair-edits.json` 和
`retrospective.json`；修订轮的测试和修复分别读取 `test-edits-a2.json`、`repair-edits-a2.json`。
缺答案、结构错误、路径或存档无效会在启动宿主前退出 2。

`develop` 回答可能超默认 64 KiB 时，首次启动即在 `PLAN.permissions` 传 `["--input-limit","1048576"]`（上限 4194304）；详见 R「开发交付阻断与存档限额」。

`check` 只运行计划里的真实命令；原始输出打印到驾驶员 stderr，宿主只保存实际退出码和精简证据；静态 `check.json` 不会被读取。单任务和批次 PLAN 可设 `checkTimeoutMs` 作为检查默认超时，每个 `checks` 条目可设 `timeoutMs` 覆盖；均为 1..3600000 的整数毫秒，省略时驱动默认 900000（15 分钟），启动前校验。宿主 `host-check` 对其他调用方的默认值仍是 60000。
驾驶员收到 `state: "unknown"` 或 `pendingAction: "reconcile"` 的宿主结果时退出 1，并保留原输出供原 run 恢复；不能把有结果的 JSON 当成成功。
独立审查批准后，完成前会再次运行相同检查。
`qa_logic`、`qa_browser`、`verification_precheck` 没有可信本地 runner。单步驾驶员对本任务完成后适用的 logic case 预检 `qa_logic`，包括已被 QA 命令 `caseIds` 覆盖的 case（当前 executor 仍会请求）；只对适用、`expected` 不含 `[需确认]` 的 browser case 预检 `qa_browser`。预测需要 runner 时仍在发送前拒绝，`verification_precheck` 规则不变。
本次适用的用例里有 logic 类（或无 `[需确认]` 的 browser 类）时，驾驶员完成不了这一步 QA：由当前 AI 会话以 `serve` 启动宿主，按 N6 与 cm-qa-engineer 应答 `qa_assess`，以及宿主实际问到的 `qa_logic` 或 `qa_browser`；拿不到浏览器证据时 `qa_browser` 如实回 BLOCKED，不能省略不答；环境恢复后可在原 run 用 `--rerun-blocked-qa` 重跑这一轮 QA（见 [QA 恢复](js-host-qa-recovery.md#已-complete-的宿主证据或环境阻断)“已 complete 的宿主证据或环境阻断”）。即使 logic case 已被 QA 命令覆盖也不能跳过这一问：静态判断为 `CONTRADICTED` 时，除非另有阻断条件（`[需确认]`、宿主请求超时或源码漂移会改判为 BLOCKED），该用例判失败，哪怕命令全部通过。
受保护执行由原宿主处理检查；驾驶员不把人工填写的结果冒充执行证据。一次 `advance` 可能走过多个阶段，
驾驶员会按该宿主的请求路径提前检查本次可能用到的全部答案；只读 `status` 不需要答案。

批次使用 `../../../scripts/cm-ai-batch-drive.mjs`，调用方式同为 `--plan PLAN.json advance|status|cancel`；成员恢复用 `develop_redo|abandon_effect|abandon_review|bootstrap_review_recover`（`mode:"resume"`、`taskKey`、单行 `reason`，`permissions` 带对应 `--allow-… 任务`，见 [批次成员的恢复操作](js-host-recovery.md#批次成员的恢复操作)）。
`config` 指向批次宿主的 `{batch,workflows}` 定义；`answers` 下按 `feature/taskId/` 放每个任务的
`develop.json`（第 1 轮可改用 `develop-a1.json`，不得并存）、`qa-assess.json`、
`documentation-sync.json`、`documentation-inspect.json`；第 2 轮开发必须另放 `develop-a2.json`，
`checks` 按 `feature/taskId` 映射真实命令数组。带 `--allow-review 任务:1`（或待审时带本轮授权）但还没有
`develop-a2.json` 时照常启动：驾驶员给该任务加 `--hold-revision`，审查若要求修改，任务停在
`changes_requested`（`revision_answer_required`），不写第 2 轮开发 intent；读取
`.reviews/<feature>-<task>-r1.md` 的 findings 写好 `develop-a2.json` 后再 `advance`。已在 `changes_requested`
的任务缺该文件仍在启动前退出 2。驾驶员在发批次指令前检查所有任务的答案、
scope、命令及恢复存档。批次宿主没有 `--original-host-context`，恢复必须沿用原 `hostContext`；
不能用它接管另一会话。批次的 `qa_logic`、`qa_browser`、`verification_precheck` 与 bootstrap
`init_verify` 需要驾驶员尚无的真实执行 runner，命中时启动前退出 2。受保护配置里的检查由宿主执行。

## 入口约束

本参考只负责接入已有 runner，不复制 N1–N8 状态机。相对路径从本文件解析；
插件根是 `../../..`，不得硬编码安装缓存。先读
`../../../docs/js-workflow-control.md` 的当前支持、会话入口、QA/文档、审查授权与批次章节，
使用其中真实 CLI、配置和结果合同，不发明字段或动态加载执行模块。

普通 `cm-ai` 新任务默认进入本入口，无需用户指定 JS；恢复已有运行先遵守主 Skill 的路由优先级。
进入前检查下列环境、目录与权限条件，缺口明确阻断；不得因启动失败转回兼容流程或创建替代运行。

## 启动前

1. 读取代码项目根与目标路径适用的 AGENTS、`N1-init.md`、`N2-enter-feature.md`。
   保留原批准 manifest、完整 feature 清单、task/AC、依赖、Learning 和形态确认要求。
   只提取输入与业务约束；不要执行旧节点中的手工日志/状态、Git、安装或任务标记。
2. 当前执行 CLI 支持 Codex 或 Claude 当前会话，要求Node 24.14+；macOS有本地证据，Linux实现已接但尚缺目标环境验证，原生Windows未支持。支持单根或显式多根，与
   分离或显式受保护的同仓 specs 根。由当前真实宿主确定 runtime：Codex 用 `--runtime codex`（也是默认），
   Claude 必须显式传 `--runtime claude`；单任务和批次入口相同。模型输出不得选择或更改
   runtime，恢复不得换端或冒用旧会话。Codex单任务同仓specs可显式选择 js-host-modes.md 的受保护模式；
   当前Codex/Claude及批次同仓用 js-host-modes.md 的文本提案模式；未选择保护的同仓仍阻断。不搬动specs或删除保护检查；工具会话不是OS沙箱。
3. 从已批准任务确定 scope、requirements 和顺序；不跳过未解决的 bootstrap 确认或依赖。
   单代码根用 `cm-ai-admission.mjs --print-run-definition --scope ...` 生成运行定义，不要手写；`--scope` 必填（相对代码根、逗号分隔），`--requirements` 可选。需要跳过当前 `nextTask` 时可加 `--task T-xxx`，仅接受同 feature 的 `eligibleTasks`，选择会写入运行定义并绑定恢复指纹。已批准的跨 feature 顺序要先做后面的批次时加 `--feature 数字.slug`（写入 `featureSelection`；宿主也可用同名参数），仍校验全部批准、manifest 与该批次内依赖，不改旧批次任务；恢复须保持同一选择。完整命令见产品文档。
   单任务用 `cm-ai-host.mjs`；多任务用 `cm-ai-batch-host.mjs` 的原 batch/workflows 配置。
   任务列表只包含该运行计划内的任务；恢复必须使用原身份、配置和真实当前会话身份，
   单任务同会话恢复用 `--mode resume --host-context {当前真实会话ID}` 加创建时的同一组启动输入（`--review-config`、`--runtime`、`--workflow-config` 等）；换会话恢复再加 `--original-host-context {创建运行的会话ID}`；
   两个 ID 相同等同未传新参数，create 传它报 `original_host_context_unavailable`。不能冒用旧 host-context。
3.1 多任务批次可提议并行组，写进 batch 配置的可选 `parallel`（任务 key 的数组的数组）。
   只提议同时满足以下全部条件的任务，任一不满足就不进组；一个组都成立不了就**不写该字段**，正常串行：
   - **纯新建文件**：该任务 scope 的每个路径在 `HEAD` 上都不存在（`git cat-file -e HEAD:{path}`
     判定，不看工作区——成员工作树从 HEAD 创建，未跟踪文件不算数）。任务若需改动现有文件
     来注册新模块（路由表、index 导出等），那些文件会出现在 scope 里，本条自动将其排除。runtime 在建成员工作树前对整组逐个核对，任一 scope 路径已在 `HEAD` 上就以 `parallel_scope_existing_file` 拒绝，不建任何工作树；已开工的成员不再复核。
   - **scope 两两不交集**：候选之间不得有重复路径。
   - **无依赖路径**：按 `tasks.md` 依赖图计算**传递闭包**，组内任意两任务之间不得存在依赖路径。
     runner 也按传递闭包校验并以 `parallel_dependency_conflict` 拒绝，此处自行判定是为了
     提出合法的组而不是被拒后返工。
   - **同一 feature**，且排除该 feature 最后一个未 DROPPED 的任务（它承担合并后的统一 QA）。
   - **每组 2–4 个**，不足 2 个不成组。
   能并行才并行，不为组而组；判定不确定时按串行处理。成员在各自 Git 工作树开发、串行合并回
   主分支，成员 QA 自动延后到末任务；当前会话模式下开发请求仍逐个应答，重叠的是审查与流程开销，
   不是写代码本身，不得据此承诺成倍提速。

4. 核对任务所需能力后才启动。QA 使用原测试合同与已授权命令/环境；无 QA 配置不能宣称
   已完成必需 QA。文档路径预先纳入任务批准 scope；需要 AGENTS/CLAUDE 等保护指令同步、
   bootstrap规范用 js-host-modes.md 的单步驾驶员或受信入口；其他未满足的必需能力记录具体缺口，不降格成可选项。
5. reviewer 配置在首次运行前绑定；本机 preflight 不是实际模型审查或调用许可。单任务 create
   必须带 `--review-config`（审查配置进入运行指纹，resume 不能补加，缺少时 `review_configuration_required`）。
   只有当前真实用户已授权本任务本轮、模型与发送包时，才传审查授权选项（`--allow-review-attempt`）；
   无授权可以不带授权选项运行至待审，但不能完成。
   批次按 feature/task:attempt 授权，不授权整个未来批次。
   不把开发批准转换为网络、安装、Git、发布或真实 provider 调用批准。
6. 启用外部模型配置、bootstrap 规范任务、多代码根（`codeProjects`）或同仓 specs 受保护执行／文本提案模式时，启动前先读 M（js-host-modes.md）对应一节。
7. 派发与等待的纪律（真实运行里被时限停掉的后台任务，绝大多数出在这里，不在宿主）：
   - **一步一个调用**：驾驶员一次只发一个 operation；不要把「驱动 + 检查 + 审查 + QA」合成一条长后台命令去跑。
   - **后台命令必须显式超时**：任何放到后台的命令都带明确的超时（检查类不低于 `PLAN.checks` 的 `timeoutMs`／`checkTimeoutMs`，默认 15 分钟），并核对当前工具对后台任务的时限上限；不设超时的后台命令会在工具时限到时被静默停掉，宿主的提问就此无人应答。
   - **等已有任务用运行时的等待接口**：要等某个子代理或后台任务，优先用当前运行时实际提供的任务等待／完成通知接口，不要另写「循环等文件」的后台脚本；等待条件写错就会空转到被停。确实只能等文件时，循环必须带总时长上限。
   - **非交互调用 Codex 要关输入**：`codex exec` 一类命令放后台时必须关闭标准输入（`</dev/null` 或等价写法），否则它会一直等输入直到被停。
   - **拿到终态先报告，不盲目重启**：后台任务被停、失败或超时后，先用 `status` 核对运行的真实状态并向用户报告，再决定重跑；不要在没看状态的情况下自动重启宿主或重发同一步。
   卡住时的手机提醒（`notify.json`）只覆盖宿主和驾驶员自己看得见的事（等待应答、空转、宿主异常退出、停在要人处理的状态），且要提醒已配置、推送成功；会话派出去的后台命令它看不见，不能替代上面这几条。

## 同一引擎的双端启动

从当前活动 Skill 的本参考文件所在目录解析 `../../../scripts/`，调用对应脚本而不是依赖全局同名命令。
单任务使用 `cm-ai-host.mjs serve`；多任务使用 `cm-ai-batch-host.mjs serve`（新批次同样必须带 `--review-config`；批次成员不支持 `--rebind-spec-material`，规格变更只动其他任务时也要按 status 给出的出口还原规格或用单任务 supersede 重做），都显式传递
上述 runtime，并使用真实宿主提供的 `--host-context`。不要为了使用 Claude 改写规格、
Review 头或完成记录；provider 身份由原 adapter/V3 绑定，失败不切到另一端兜底。

需配置审查时，按文档运行单任务脚本的
`preflight --config {该代码根的单任务配置} --review-model {已选择模型} --runtime {当前端}`。
即使后续执行批次，诊断仍用同一代码根的单任务配置，不把 batch/workflows 配置传给该命令。
诊断输出直接作为 review-config 输入，不手造或修补 `passed`/指纹；失败则保留原因。
本机配置诊断通过不证明模型可用、Review 协议成功或用户已批准外发；真实审查仍须第5项授权。
不带对应 `--allow-review-attempt`（单任务）或 `--allow-review feature/task:attempt`（批次）
可以准备并停在原待审点，不能自行追加这些选项推进。后续授权也不得改变原 scope 或身份。

## QA 与文档基础

首次create可同时提供原`--workflow-config`；有QA配置须另带`--allow-qa`，恢复保持原配置与授权。
QA 的 `qa_assess/qa_logic/qa_browser` 请求独立计时，workflow 的 `qa.timeoutMs` 可设 1–3600000 毫秒，
省略为 60000；`qa_assess` 的实际应答窗口另受决策通道约 60 秒上限约束。`qa_logic/qa_browser` 超时记
`host_request_timeout` 并判该用例 BLOCKED，不把已有命令 PASS 用来覆盖超时。
宿主读取 JSONL 时必须处理当前缓冲区内的全部完整行，再等下一个数据块；处理单行后不能
提前 return（事故：确认和 TC-007 请求合并到一个数据块，旧驱动只读确认而悬空等待）。

## 执行当前请求，而非手工跳节点

用当前会话可交互的进程工具启动 CLI 并保留会话句柄。收到 `host_ready` 后按文档发送
`advance`；批次控制消息不带子任务 identity，单任务按原合同携带 identity。
持续读取响应，按 requestId 关联控制结果。不要等待 `advance` 结束才处理途中 host_request。

每项 host_request 必须核对实际任务、路径、scope 与当前授权，再执行对应工作：

| 请求 | 当前会话实际执行 |
| --- | --- |
| develop | 读取 N3 的业务约束、适用项目指令与请求中的 Learning；按 N3 的技能匹配读取并使用真实工程 Skill，只修改固定业务 scope，返回原开发/Learning 结果。不要执行 N3 的手工交接/标记流程。 |
| check | 按原任务测试合同实际运行适量检查，返回实际退出码及证据；不把自审或静态推断写成测试通过。 |
| documentation_sync | 使用 cm-doc-syncer 的文档判断，只同步请求列明且获准的普通文档；这是 Review 前写入，不新增完成后写入。 |
| qa_assess / qa_logic / qa_browser | 使用 N6 与 cm-qa-engineer 的业务判断或获准工具；评分不替代 JS 的强制 QA 政策，静态判断不替代真实运行，不能改变载体或伪造浏览器证据。 |
| documentation_inspect | 按 N8 只读核对必需文档及收尾证据；缺文档、度量或必需能力返回 blocked。新 run 按冻结请求默认做[收尾资料核对](knowledge-closeout.md)，结果并入总结；关闭或缺报告如实记录。 |

进入匹配角色前读取该 Skill 完整指令，但 JS 所有权不让渡给角色。实际模型路由、资源
及逐例日志由已有实现覆盖到哪里就报告到哪里；读取角色 Skill 不证明配置声明的模型已调用。
若角色要求 JS 尚未支持的控制动作，停止并报告，不在旁路手写日志/状态弥补。

回复沿用该次 sessionId/callId/requestDigest，result 严格符合该 kind 原合同；开发结果不是
check 数组，也不是 QA/文档结果。只回报已实际执行的事实，不能从项目文件自动接受回复。
工具失败返回原失败结构；超出权限不能执行。Learning 候选交由原 runner 写回与 Review，
会话不自行修改保护指令。不要制作自报 approved、grant、Review receipt 或完成凭证。

JS 返回阻断、待授权、失败、取消、unknown 或补正要求时，报告原因并保留磁盘证据；
不重试未知调用、换 runId 绕过历史、手工勾 tasks 或启动旧兼容流程。允许 status 查询；
只有用户明确取消才发送 cancel。结束用 host_close；断联不是用户取消。

## 汇报与能力边界

只以 JS 实际结果报告“已做、剩余、问题、下一步”。task 完成不等于 workflow 完成；
只有原 finalizer 的 run_done 且本次必需业务证据齐备，才报告该运行完成。
目前 CLI 有本地真实工具与合成 reviewer 组合证据，没有完整真实双宿主业务验收。
本参考已接单/批双端源入口，但不证明已安装 Skill 已加载、真实模型Review或完整双宿主验收。
普通布局权限、完整 N6 修复/重测、bootstrap、度量与其他入口的业务迁移仍按当前证据报告。
