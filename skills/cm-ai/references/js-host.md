# 当前会话作为 JS workflow 工具宿主

规格待审批时先展示摘要卡并请用户回复“开始”。`approvalIntent` 仅把“开始”“开始吧”
“可以开始”“确认开始”“开始执行”“现在开始”“可以，请开始开发”（允许尾部中英文句末标点与空白）视为
明确开始；“继续”“可以”“好”“好的”“OK”“按最优解处理”“你看着办”“行”仍不审批。
`not_approval` 时提示明确回复“开始”；写审批位仍须原 `--approve` 门禁。

## 默认控制策略 v2

新建运行先读 [control policy v2](../../../docs/cm-control-policy-v2.md)，写严格的 `POLICY.json`：

```json
{"version":2,"development":"conversation","bootstrap":"disabled","qa":"disabled","qaFix":"disabled","verification":"precheck"}
```

`verification:"auto"` 是无人值守版：同一闸门由宿主对照开发结果里的逐条 `requirements` 与宿主私有副本里的实跑（改前基线、只放入测试文件、全部放入）自动作答，不需要 `liveEvidence`；缺证据或与实跑矛盾就停在 `verification_precheck_failed` 等人。详见控制文档「闸门由宿主自动作答」。
`verification:"precheck"` 开启交付前验证闸门：审查前宿主发 `verification_precheck`，当前会话逐条回答任务描述与验证要求的满足情况和实际证据（基线计数、RED 失败用例名、位置清单等），证据写进交接文件给独立审查看。PLAN 须配 `liveEvidence`（kinds 含 `verification_precheck`，见 `../../../docs/live-evidence-drivers.md`），否则驾驶员启动前退出 2。
模型、命令和路径仍来自原配置。加载原配置不自动启用能力；policy 也不能替代所需配置。
单任务启动顺序为 `serve --config RUN.json --mode create|resume --host-context ID --control-config POLICY.json`，
后接原配置参数；**不得传任何 `--allow-*`**。批次入口同样显式提供 policy，`qaFix` 只能为 `disabled`。
当前已选任务的常规独立审查最多两轮自动推进，不需要真人每轮批准；fresh 独立审查、包绑定和完成门禁保持原要求。
普通 `advance` 不需要恢复目标。异常恢复用请求 `version:2` 与此前只读 `status` 给出的固定 `controlTarget`，
将其完整复制为 `expectedControl`；目标陈旧时停止，先核对新状态和用户原决定，不自动刷新重发。
不含 `controlConfig` 的旧 PLAN、旧运行沿 legacy；不能用 v2 执行旧运行，也不能用 legacy 执行 v2。
下文旧 `--allow-*` 恢复参考说明旧操作业务前提，v2 的启动和目标绑定以 control policy v2 文档为准。

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
| `fingerprint_mismatch`、`invalid_arguments`、`invalid_arguments`、`invalid_arguments`、`invalid_input`、`snapshot_changed` | control policy v2 文档「旧运行与迁移拒绝」「显式恢复」 |
| `parallel_dependency_conflict`、`parallel_scope_overlap` | 本文「启动前」3.1 |
| `runner_invocation`（旧 grant 审查登记） | 保留原 journal，用 `cm-ai-run.mjs inspect-history --config 原run.json` 只读查看历史；新版不回放或迁移这类登记 |
| `fingerprint_mismatch`、`invalid_arguments`、换会话恢复、`host-joined` | R「恢复参数与跨会话接手」 |
| `resume` 下的 `develop_checks_not_passed`、旧 `checks_not_passed`、`develop_package_too_large`、`develop_empty_changes`、`develop_requirement_missing`、`develop_unchanged_after_review`、`develop_call_timeout`（开发应答超时）、`develop_answer_invalid`（开发应答超出字段上限）；`unknown/limit_exceeded`、`store_failure`、`empty_changes`；`request_too_large`、`host_response_too_large`、`host_response_mismatch`；大小上限或 `runId` 长度致退出 2 | R「开发交付阻断与存档限额」 |
| `check_answer_missing`、`check_answer_invalid`、`complete_recheck_failed`、`develop_answer_missing`、`develop_redo`、`develop_redo_worker_*`、`develop_dispatch_failed`、`role_log_failed`、`host_response_late`、`check_answer_retry_limit`、`complete_recheck_limit`、`develop_redo_limit`、`documentation_sync_answer_missing`、`documentation_sync_answer_invalid`、`documentation_sync_answer_blocked`、`documentation_sync_out_of_scope`、`documentation_sync_interrupted`、`documentation_sync_stop_required`、`documentation_sync_changed_after_stop`、`documentation_sync_retry_limit` | R「应答缺失、无效或迟到」 |
| `developer_result_invalid`、`failed/invalid_result`、`protected_edit_stale` | R「开发结果校验失败」 |
| `develop_retry_limit`、`completion_checks_changed`、`completion_package_changed`、`completion_retry_limit`、`package_mismatch`、`out_of_scope` | R「重试名额与完成前复查」 |
| `review_transport_timeout`、`review_provider_failed`、`review_verdict_invalid`、verdict `blocked`、`supersede_code_drift`、`review_package_changed` | R「规格漂移、代码漂移与审查失败」「审查计时与快照忽略」 |
| `spec_drift`（`spec_rebind`／`none`） | R「规格漂移、代码漂移与审查失败」「已批准规格材料（第 24 步）」 |
| preflight `unrecognized_model`、`stopped_by_probe`；批次 `legacy_preflight_cache_invalid` | R「审查配置诊断失败」 |
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
| `provider_development_authorization_required`、`qa_decision_required`、`qa_mandatory_required`、`documentation_sync_blocked`、outcome `rejected`／`denied`、`cancelled`、其他 `none` | 本文「执行当前请求，而非手工跳节点」末段；运行能力见「启动前」第 4、5 项 |

## 当前会话手动驱动：用驱动脚本，不要自己搭 FIFO

普通单任务和 bootstrap 骨架 T-001、规范任务（通常 T-002）用 `cm-ai-drive.mjs`，批次用 `cm-ai-batch-drive.mjs`；修复用 `cm-fix-drive.mjs`，规格编写用 `cm-prd-drive.mjs`。它们负责保持宿主 stdin、应答反问并按 callId 配对结果，无需后台保活 FIFO。规范任务按下文[用单步驾驶员](js-host-modes.md#bootstrap-规范任务用单步驾驶员)准备答案文件；批次驾驶员仍不支持规范任务，启动前退出 2。`cm-ai`、批次和 `cm-prd` 驱动的 `--help` 列出计划字段；普通单任务最小调用：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-drive.mjs" --plan "{PLAN.json}" advance
```

**在 Claude Code 里调用驾驶员：** 按共享路径合同（`runtime/project-context.md`）最终解析并验证的工作流根确为默认 `~/.claude` 时，驾驶员单独一条 Bash 调用，写成 `node ~/.claude/scripts/cm-ai-drive.mjs --plan <PLAN 绝对路径> <操作>` / `node ~/.claude/scripts/cm-ai-batch-drive.mjs --plan <PLAN 绝对路径> <操作>`：前面不接 `cd`、变量赋值，也不用 `&&`、`;`、管道和别的命令连在一起；PLAN 与答案文件先用写文件工具写好。这样能匹配本技能声明的放行规则。用户显式提供的 `CM_WORKFLOW_HOME`、自定义 `CLAUDE_HOME`、源码目录或更新器返回的根指向别处时，照原写法用实际根的路径，按正常权限确认处理，不改去调用 `~/.claude` 下的另一份。需要固定工作目录时，先用单独一条 `cd` 切换，不与驾驶员连写。Codex 等其他运行时照原写法。

先按下节准备计划及真实答案文件。计划中的 `checks` 须为实际可执行的命令；驱动不接受静态检查结果代替执行。

## 探活、等待与关闭

九个单步驾驶员共用 `drive-core`，自动启用 `CM_HOST_HEARTBEAT=1`。手动驱动可在启动宿主前设置同一环境变量；未启用时保留旧 JSONL 输出。心跳只存在于当前连接，不是新的存档文件，不写 journal、不改变运行配置指纹，也不调用 runner 的 `status`。

支持探活的 `host_ready` 增加 `heartbeat:{intervalMs:5000,timeoutMs:30000}`。随后宿主立即发送、每 5 秒续发 `host_heartbeat`：

```json
{"type":"host_heartbeat","sessionId":"当前连接","pid":12345,"at":"2026-10-12T00:00:05.000Z","lastProgressAt":"2026-10-12T00:00:00.000Z","inFlight":{"requestId":"adv-1","operation":"advance","startedAt":"2026-10-12T00:00:00.000Z","stage":"check","nativeStage":null,"call":{"callId":"本次反问","kind":"check","startedAt":"2026-10-12T00:00:00.000Z","deadlineMs":1791764100000}}}
```

`inFlight:null` 表示传输层当前没有在途操作。`call:null` 表示没有等待会话回复的反问。`nativeStage` 为已接入的原生检查或 runner 开发／审查阶段，包含 `id`、`kind`、`startedAt`、`deadlineMs`；两者都为空时 `stage` 只表示 operation，不推断内部阶段或子进程状态。`deadlineMs` 是反问的绝对截止时间（Unix 毫秒）；心跳不携带业务 payload、代码或密钥。`lastProgressAt` 只随实际操作或反问变化，收到新心跳不代表工作取得进展。心跳不能证明检查通过、子进程退出或任务完成。

重复 `advance` 返回 `host_busy` 时，错误包含 `inFlight` 的原 requestId、operation、阶段和开始时间。含义是“上一步仍在执行，继续等它的结果”。驾驶员继续接收原请求结果；手动驱动也须按原 requestId 读取，不能据此关闭宿主或重派开发。

空闲时仍可发送原 `{"type":"host_close","sessionId":"…"}`。操作或反问在途时默认返回 `host_close_busy`，保持连接和原请求。确认要中断后，才发送 `{"type":"host_close","sessionId":"…","force":true}`；响应会警告原运行可能进入 `unknown`。驾驶员无法应答或应答被拒收时，会明确打印 force 中断原因。声明心跳的新宿主须先确认关闭，再结束输入；未声明能力的旧宿主使用已提示的 force + EOF 兼容路径，以保留旧宿主最终拒答结果。强制关闭、EOF、进程死亡均不等于用户取消。强制关闭后先核对原 run、实际文件和相关进程，再沿原恢复入口操作，不手改 journal 或自动重派审查。

驾驶员默认等待期限：启动 60 秒；已声明心跳的宿主连续 30 秒无心跳即失败；反问与已接入原生阶段取原截止时间的较早者，加 30 秒清理余量。嵌套检查结束后恢复外层原截止时间，同一阶段的重复心跳不能延长预算。未声明阶段期限的操作（包括旧宿主）使用 6 小时后备上限；这不是已接入检查／审查的默认预算。完成结果或关闭请求后最多再等 5 秒；故障清理先 SIGTERM，1 秒后向仍存在的自有进程组发送 SIGKILL；宿主先退出也不取消这次清理，以覆盖忽略 SIGTERM 的同组子进程。只作用于驾驶员自己创建的进程／进程组。

| 驾驶员退出码 | 含义及处理 |
| --- | --- |
| 0 | 收到正常结果；仍按结果内 state/code 判断业务是否完成 |
| 1 | 宿主业务错误、unknown／reconcile 或应答失败；核对打印的原运行结果 |
| 2 | 计划、答案预检或需人工回答的问题阻断；补齐输入再继续 |
| 70 | `host_start_timeout`：启动后未按时收到 host_ready |
| 71 | `host_start_failed`／`host_exited`：无法启动或结果前宿主退出 |
| 72 | `host_heartbeat_timeout`：已声明的心跳超时，宿主可能卡死 |
| 73 | `host_stage_timeout`：阶段截止或无阶段信息的后备期限已到 |
| 74 | `host_pipe_closed`：管道读端已关闭，无法继续写入 |
| 75 | `host_close_timeout`：结果或关闭后，宿主／继承管道未按时结束 |

驾驶员看门狗的超时是连接故障，不能写成业务成功。它只处置自己启动的宿主并中止自己的应答；不能据此认定所有脱离宿主的后代进程都已退出。旧宿主未声明心跳时保留兼容等待，但仍有启动和操作截止。宿主不会因为单项任务 `fixture_completed` 自动关闭，后续 QA 与收尾继续使用原合同。

## 单步驾驶员

仓库自带 `../../../scripts/cm-ai-drive.mjs`，按上例一次启动宿主、发送一个 operation、回答这一轮的反问并打印结果。

`PLAN.json` 与 cm-fix 驾驶员一样，以自身目录解析相对路径；填写 `config`（已批准的运行定义）、
`mode`、当前真实 `hostContext`、`runtime`、`controlConfig`（相对 PLAN 的 policy 路径）、
原样传给宿主的 `permissions`（只放配置与运行参数，v2 禁止所有 `--allow-*`）、`answers` 和
`checks: [{"id":"syntax","command":["node","--check","target.mjs"]}]`。同会话恢复可省略
`originalHostContext`；换会话恢复必须填创建运行的会话 ID，且运行存档必须已存在。第 1 轮开发结果放 `answers/develop.json`（也可用
`develop-a1.json`，两者不能同时存在）；第 2 轮只读 `answers/develop-a2.json`，绝不复用第 1 轮答案。
`edits` 把批准 scope 内路径映射到以下之一：答案目录里的内容文件名（写入；已有文件保留权限，新文件为 0644）、
`{"file":"内容文件","mode":"0755"|"0644"}`（写入并设权限）、`{"mode":"0755"|"0644"}`（只改已有文件的权限位）、
`{"delete":true}`（删除已有文件）。改名是删除旧路径加写入新路径，两个路径都要在 scope 内。同时列在
`requirements` 里的路径不能删除（审查包要求每个 requirements 文件存在），启动前即拒绝；当前会话若仍删掉了这类文件，
结果是可重试的 `blocked/develop_requirement_missing`，恢复该文件后 `--mode resume` 再 `advance`。
`resume` 时驾驶员按存档里的当前轮次发送 identity，第 2 轮的 `decision`、`complete`、`qa` 等无需手改。
v2 的 `advance` 自动执行常规审查。首次审查要求修改时才进入第 2 轮，第 2 轮只读
`develop-a2.json`。尚无该文件时驾驶员停在 `changes_requested/revision_answer_required`，
不写第 2 轮开发 intent；读取原 r1 findings 后准备实际修订，再在原 run `advance`。
纯 bootstrap 规范任务首轮始终 hold，先读真实 r1，再准备第 2 轮答案。
第 2 轮代码逐字节未变时仍停在 `blocked/develop_unchanged_after_review`，不送审、不耗第 2 轮审查。
旧入口的能力开关与答案预检见文末已有小节。
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

批次使用 `../../../scripts/cm-ai-batch-drive.mjs`，调用方式同为 `--plan PLAN.json advance|status|cancel`；
v2 PLAN 同样有 `controlConfig`，成员恢复带 `mode:"resume"`、`taskKey`、单行 `reason` 与此前
status 返回的完整批次 `expectedControl`，不带 `--allow-*`。成员原业务前提见 [批次成员的恢复操作](js-host-recovery.md#批次成员的恢复操作)。
legacy 成员恢复仍在 `permissions` 带原 `--allow-… 任务`。
`config` 指向批次宿主的 `{batch,workflows}` 定义；`answers` 下按 `feature/taskId/` 放每个任务的
`develop.json`（第 1 轮可改用 `develop-a1.json`，不得并存）、`qa-assess.json`、
`documentation-sync.json`、`documentation-inspect.json`；第 2 轮开发必须另放 `develop-a2.json`，
`checks` 按 `feature/taskId` 映射真实命令数组。新旧 cm-ai 入口均直接审查。还没有
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
`../../../docs/js-workflow-control.md` 的当前支持、会话入口、QA/文档、审查配置与批次章节，
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
   单代码根用 `cm-ai-admission.mjs --print-run-definition` 生成运行定义，不要手写。`tasks.md` 已为该任务写了 `- 范围:` 时以它为准，不传 `--scope`（传了且不一致报 `task_scope_mismatch`）；没写范围的任务 `--scope` 必填（相对代码根、逗号分隔），缺了报 `scope_required`。
   **默认先跑生成器**：`cm-ai-batch-plan.mjs --specs-dir … --code-project … --repository-id … --batch-id {新批次ID}`
   读已批准 `tasks.md`，为准入选中的功能输出 `{mode:"batch",config}`、`{mode:"serial",reason}` 或 `{mode:"complete"}`；任务按依赖排序。
   功能最后一个任务完成、项目还有下一个功能时，批次返回 `batchComplete:true` 和 `nextFeature`：用新的批次 ID 再跑生成器，接着下一个功能；
   项目最后一个功能完成时照旧返回 `run_done`（或 `run_done_degraded`）。
   `batch` 时把 `config` 原样写成批次配置文件交给 `cm-ai-batch-host.mjs`（能并行的任务已分好组，不再手写 `parallel`）；
   `serial`（有任务没写范围、脚手架功能等）时照旧逐个任务用 `cm-ai-admission.mjs --print-run-definition` 加 `cm-ai-host.mjs`。
   项目 `.cm-workflow.json` / `.cm-workflow.yml` 的 `parallel: {enabled, max}` 控制开关和每组人数（不写=开启、每组最多 2；
   `enabled: false` 时只排串行批次，不分组）。单代码根适用；多代码根仍按下文手写。
   任务列表只包含该运行计划内的任务；恢复必须使用原身份、配置和真实当前会话身份，
   单任务同会话恢复用 `--mode resume --host-context {当前真实会话ID}` 加创建时的同一组启动输入（`--review-config`、`--runtime`、`--workflow-config` 等）；换会话恢复再加 `--original-host-context {创建运行的会话ID}`；
   两个 ID 相同等同未传新参数，create 传它报 `original_host_context_unavailable`。不能冒用旧 host-context。
3.1 并行组由生成器按下列规则算出（多代码根等仍手写时照同一规则），写进 batch 配置的可选 `parallel`（任务 key 的数组的数组）。
   只组同时满足以下全部条件的任务，任一不满足就不进组；一个组都成立不了就**不写该字段**，正常串行：
   - **scope 来自 tasks.md**：新批次只把 `tasks.md` 写了 `- 范围:` 的任务放进组，batch 配置里的 scope
     照抄它（不一致报 `task_scope_mismatch`）；没写范围或写 `串行` 的任务报 `parallel_scope_undeclared`，
     标了 `- 设备: 需要` 的报 `parallel_device_task`。范围应写全：任务可能改动的每个文件，包括已有文件
     （例如注册新模块的路由表、index 导出）和测试文件。成员可以修改已有文件；写到 scope 以外会以
     `out_of_scope` 停下重做。升级前已开始的批次按原规则继续。成员各自审查只证明自己的交付；两个任务虽不改同一文件、
     却读写同一接口、配置或生成链时，组合后可能不兼容，应在 `tasks.md` 写成依赖、串行执行。
   - **scope 两两不交集**：候选之间不得有重复路径；runtime 建组时也会核对。
   - **无依赖路径**：按 `tasks.md` 依赖图计算**传递闭包**，组内任意两任务之间不得存在依赖路径。
     runner 也按传递闭包校验并以 `parallel_dependency_conflict` 拒绝，此处自行判定是为了
     提出合法的组而不是被拒后返工。
   - **同一 feature**，且排除该 feature 最后一个未 DROPPED 的任务（它承担合并后的统一 QA），也排除批次里该功能最后执行的任务。
   - **每组 2–4 个**，不足 2 个不成组；生成器按项目 `parallel.max`（默认 2）封顶。
   - **每个成员的前置任务都排在组内第一个成员之前**：整组在第一个成员处同时开工。功能最后一个任务已完成时不分组。
   能并行才并行，不为组而组；判定不确定时按串行处理。成员在各自 Git 工作树开发、串行合并回
   主分支，成员 QA 自动延后到末任务；当前会话模式下开发请求仍逐个应答，重叠的是审查与流程开销，
   不是写代码本身，不得据此承诺成倍提速。

4. 核对任务所需能力后才启动。QA 使用原测试合同与已授权命令/环境；无 QA 配置不能宣称
   已完成必需 QA。文档路径预先纳入任务批准 scope；需要 AGENTS/CLAUDE 等保护指令同步、
   bootstrap规范用 js-host-modes.md 的单步驾驶员或受信入口；其他未满足的必需能力记录具体缺口，不降格成可选项。
5. reviewer 配置在首次运行前绑定；单任务 create 必须带 `--review-config`，
   审查配置进入运行指纹，resume 不能补加，缺少时 `review_configuration_required`。
   v2 常规审查在已确认任务范围内自动推进，最多两轮，不逐轮询问真人。
   审查请求、回执与执行记录核对本轮任务和材料；reviewer/independent/decision_source 仅是来源声明。
   新旧 cm-ai 入口均直接审查；外发、安装、Git、发布或资金动作仍按其单独确认要求执行。
6. 启用外部模型配置、bootstrap 规范任务、多代码根（`codeProjects`）或同仓 specs 受保护执行／文本提案模式时，启动前先读 M（js-host-modes.md）对应一节。
7. 派发与等待的纪律（真实运行里被时限停掉的后台任务，绝大多数出在这里，不在宿主）：
   - **一步一个调用**：驾驶员一次只发一个 operation；不要把「驱动 + 检查 + 审查 + QA」合成一条长后台命令去跑。
   - **后台命令必须显式超时**：任何放到后台的命令都带明确的超时（检查类不低于 `PLAN.checks` 的 `timeoutMs`／`checkTimeoutMs`，默认 15 分钟），并核对当前工具对后台任务的时限上限；不设超时的后台命令会在工具时限到时被静默停掉，宿主的提问就此无人应答。
   - **等已有任务用运行时的等待接口**：要等某个子代理或后台任务，优先用当前运行时实际提供的任务等待／完成通知接口，不要另写「循环等文件」的后台脚本；等待条件写错就会空转到被停。确实只能等文件时，循环必须带总时长上限。
   - **非交互调用 Codex 要关输入**：`codex exec` 一类命令放后台时必须关闭标准输入（`</dev/null` 或等价写法），否则它会一直等输入直到被停。
   - **拿到终态先报告，不盲目重启**：后台任务被停、失败或超时后，先用 `status` 核对运行的真实状态并向用户报告，再决定重跑；不要在没看状态的情况下自动重启宿主或重发同一步。
8. 创建运行前体检（只读，几秒内跑完；真实运行里不少阻塞在开工前就能看出来）：
   `node "{CM_WORKFLOW_ROOT}/scripts/cm-start-check.mjs" --plan "{PLAN.json}"`。不写文件、不起宿主、不跑检查命令；Git 用扫描器的安全读取（可信 git、关闭仓库配置的 fsmonitor 与 clean/process 过滤器、不读用户配置）。只支持普通单任务、当前会话模式的 PLAN：`PLAN.permissions` 含受保护模式、provider 开发或 bootstrap 参数时退出 2，不给结论，请按下列各项手工核对。`error`（退出 1）必须先改；`warn` 逐条处理，保留要写明理由；`--strict` 让 warn 也退出 1。脚本核对：
   - scope 含受保护路径（AGENTS.md、tasks.md、`.reviews`、`.cm-*` 等）——创建必被 `protected_scope` 拒绝。scope 为空、重复，或含绝对路径、`..`、反斜杠、冒号——创建同样必被拒绝，脚本按输入不合法退出 2。
   - `PLAN.checks` 的命令重复、同一 scheme／目的地的 `xcodebuild test` 都没有 `-only-testing`（很可能各跑一遍全量）、各检查超时之和超过检查整步的 30 分钟期限（`sameExecutionAs` 不计）。实测：aihot 76 个检查步里，4 个恰在 30.0 分钟被中止，已完成的最长 29.9 分钟。
   - scope 内文件在代码根已有未提交改动（含新建）：基线会把它们当起点，交审包里看不到这部分。Git 跑不起来是 warn，代码根不是 Git 仓库是 info；有跳过项时摘要写成「体检完成……有 N 项核对被跳过」，不写「体检通过」。已有 `.git` 却被 Git 拒绝读取（仓库损坏、目录属主不同）是 warn。scope 超过 256 条创建会被拒，脚本按输入不合法退出 2。
   脚本看不到、要在创建前自己核对：
   - scope 含任务要改的测试与夹具文件；新增夹具路径一起列入，事后追加要走受控 scope 修订。
   - 检查命令是 `sh x.sh` 这类包装时，脚本内部是否又跑了同一套全量测试；脚本只认得直连的 `xcodebuild`。
   - 模拟器独占：显式指定 UDID，同一设备同一时刻只有一个会话在测；并行台数要限。aihot 记录：四台并行出现元素超时，日志量过大会让测试框架崩溃。
   - 开发答案 `application.note` 不超过 512 字（UTF-16 单位）且必填字段齐全；审查材料（截图等）先压缩到审查包上限内。
   - 不要手动把 `AGENTS.md` 等受保护指令放回代码根；教训走 Learning 写回，手放会让写回卡死。
   - 高风险任务先拆小：改动文件多（T-006 范围约 30 个）或涉及原生滚动、手势、多 iOS 版本矩阵。每个运行只有 6 次计数调用、6 个计数 effect，开发额度用完只能走 supersede 重开。
   卡住时的手机提醒（`notify.json`）只覆盖宿主和驾驶员自己看得见的事（等待应答、空转、宿主异常退出、停在要人处理的状态），且要提醒已配置、推送成功；会话派出去的后台命令它看不见，不能替代上面这几条。

## 同一引擎的双端启动

从当前活动 Skill 的本参考文件所在目录解析 `../../../scripts/`，调用对应脚本而不是依赖全局同名命令。
单任务使用 `cm-ai-host.mjs serve`；多任务使用 `cm-ai-batch-host.mjs serve`（新批次同样必须带 `--review-config`；批次成员不支持 `--rebind-spec-material`，规格变更只动其他任务时也要按 status 给出的出口还原规格或用单任务 supersede 重做），都显式传递
上述 runtime，并使用真实宿主提供的 `--host-context`。不要为了使用 Claude 改写规格、
Review 头或完成记录；provider 标签由原 adapter/V3 绑定，失败不切到另一端兜底。

需配置审查时，按文档运行单任务脚本的
`preflight --config {该代码根的单任务配置} --review-model {已选择模型} --runtime {当前端}`。
即使后续执行批次，诊断仍用同一代码根的单任务配置，不把 batch/workflows 配置传给该命令。
诊断输出直接作为 review-config 输入，不手造或修补 `passed`/指纹；失败则保留原因。
本机配置诊断通过不证明模型可用、Review 协议成功或用户已批准外发。
v2 的自动审查仍使用冻结模型和完整审查包，恢复不得改变原 scope 或身份。

## QA 与文档基础

项目在现有 workflow JSON 的 `qa.criticalPaths` 登记关键路径，格式与清单来源见 [N6 固定检查点](N6-qa-eval.md)。未登记关键路径的项目，N6 不做任何风险识别，只有这两个固定点。两点为 feature 完成及连续五项未 QA。

首次 create 可同时提供原 `--workflow-config`。v2 在 policy 中选择 `qa:"run"`；
单任务 QA 修复明确选择 `qaFix:"manual"` 或 `"auto"`，批次必须为 `disabled`。
配置缺失时如实阻断，不自动开启能力。disabled 仍执行 `qa_assess` 与原必需 QA 判定；v2 没给 `--workflow-config` 时宿主也只补这一步判定（不加执行器和文档能力），驾驶员照样要求 `qa-assess.json`；
触发后没有 executor 时停在 `qa_triggered/pendingAction:qa_execution`，不能报告 PASS 或 `run_done`。
恢复保持原策略与配置，启动型恢复使用专门文档的 `launchControlTarget`，QA 修复子恢复使用 `fix_status` 的含 child 目标。
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
| documentation_sync | 使用 cm-doc-syncer 的文档判断，只同步请求列明且获准的普通文档；这是 Review 前写入，不新增完成后写入。只回 `{"status":"completed"}` 或 `{"status":"blocked"}`，不碰列明文档以外的文件；失败后宿主只重问这一项、不重问开发。 |
| qa_assess | 核对请求的 changedFiles 清单、来源与 criticalPaths 登记，只回 `{"confirmed":true}`；JS 按固定规则决定触发，不提交风险类别或跳过理由。 |
| qa_logic / qa_browser | 使用 N6 与 cm-qa-engineer 的业务判断或获准工具；静态判断不替代真实运行，不能改变载体或伪造浏览器证据。 |
| documentation_inspect | 按 N8 只读核对必需文档及收尾证据；缺文档、度量或必需能力返回 blocked。新 run 按冻结请求默认做[收尾资料核对](knowledge-closeout.md)，结果并入总结；关闭或缺报告如实记录。 |

进入匹配角色前读取该 Skill 完整指令，但 JS 所有权不让渡给角色。实际模型路由、资源
及逐例日志由已有实现覆盖到哪里就报告到哪里；读取角色 Skill 不证明配置声明的模型已调用。
若角色要求 JS 尚未支持的控制动作，停止并报告，不在旁路手写日志/状态弥补。

回复沿用该次 sessionId/callId/requestDigest，result 严格符合该 kind 原合同；开发结果不是
check 数组，也不是 QA/文档结果。只回报已实际执行的事实，不能从项目文件自动接受回复。
工具失败返回原失败结构；超出权限不能执行。Learning 候选交由原 runner 写回与 Review，
会话不自行修改保护指令。按实际审查与执行结果填写来源声明，不制作与当前材料或执行记录不符的 Review receipt 或完成凭证。

JS 返回阻断、待授权、失败、取消、unknown 或补正要求时，报告原因并保留磁盘证据；
不重试未知调用、换 runId 绕过历史、手工勾 tasks 或启动旧兼容流程。允许 status 查询；
只有用户明确取消才发送 cancel。空闲结束用 host_close；在途关闭按上文“探活、等待与关闭”处理，断联不是用户取消。

## 汇报与能力边界

只以 JS 实际结果报告“已做、剩余、问题、下一步”。task 完成不等于 workflow 完成；
只有原 finalizer 的 run_done 且本次必需业务证据齐备，才报告该运行完成；报告末尾照 N8「输出总结」最后三行给出会话边界结论。
受控补正本轮只支持无 JS ownership 的兼容 taskgate 任务。cm-ai 单/批任务 r2 仍 blocked，
没有 runner-owned correction 完成入口；JS journal/run/unknown 证据禁止兼容 writer，不删证据或手改状态绕过。
目前 CLI 有本地真实工具与合成 reviewer 组合证据，没有完整真实双宿主业务验收。
本参考已接单/批双端源入口，但不证明已安装 Skill 已加载、真实模型Review或完整双宿主验收。
普通布局权限、完整 N6 修复/重测、bootstrap、度量与其他入口的业务迁移仍按当前证据报告。

## legacy 兼容：旧运行与旧 PLAN

本节及旧恢复参考中的 `--allow-*` 只适用于未使用 control policy v2 的原入口。
不含 `controlConfig` 的 PLAN 保持原语义；旧 journal、指纹与控制记录不改写。含旧 grant 登记的运行不支持恢复，CLI 在指纹检查前以 `runner_invocation` 拒绝。只读历史查看使用 `node scripts/cm-ai-run.mjs inspect-history --config 原run.json`，不回放或迁移授权。旧 factory 的 `--protected-config` CLI 组装恢复入口已停用；无 grant 记录时保留 `fingerprint_mismatch`，明确给出历史查看与该边界，不能由指纹猜测历史身份。
单任务原 `serve` 保留 `--allow-development`，create 的 reviewer 配置仍必须首次提供。
普通 advance 直接派发本轮 fresh 审查；单任务与批次均不再使用按轮审查参数。
`--allow-development`、`--allow-qa` 等保留为运行能力开关，不是身份或人工交互凭据。
QA 仍由原 `--workflow-config` 与 `--allow-qa` 接入，不因加载配置自动开启。

首次审查要求修改时，读取真实 r1 findings 后再准备 `develop-a2.json`，并沿原 run advance。尚无第二轮答案时驾驶员 hold 在 changes_requested/revision_answer_required，不写第二轮开发 intent。第二轮内容未变仍由 develop_unchanged_after_review 阻断。
