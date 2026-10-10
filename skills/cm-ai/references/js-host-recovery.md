# JS 宿主恢复：开发、审查、完成、规格与重跑

本文是 [js-host.md](js-host.md) 的恢复引用：运行停在阻断、待审失败、unknown 或被拒绝时，按 js-host.md 的停机路由表读取对应一节。QA 恢复见 [js-host-qa-recovery.md](js-host-qa-recovery.md)。

## 开发交付阻断与存档限额

失败或不可用的检查会在开发阶段停 `blocked/develop_checks_not_passed`，`reason` 列出检查 id 与证据摘要；修复环境后在原 run `advance` 会重新开发和检查，不消耗独立审查轮次。旧运行在完成阶段的 `blocked/checks_not_passed` 保持终态，不能重新开发。

运行存档每条记录最多 1 MiB（1048576 字节），开发检查点要装下整个审查包（内容按 base64 计），还要给随后的审查与完成记录留足空间。
这部分预留按有界的审查结果推出：审查结果除 examinedPaths 外最多 12 KiB（12288 字节）JSON，超出时宿主先把每条 finding 的
message、evidence 与 summary 截到同一上限并标注，仍放不下再从末尾省略 finding（先 P3，至少保留一条阻断 finding），verdict、
id、severity、path 不变；完成检查点最多重复这份结果 13 次，另加已有回执与调用的两份重复和 96 KiB 固定开销。小任务的预留约
260 KB，单个文本文件约 550 KiB 以内可以通过。驾驶员用与宿主相同的审查包、handoff、Learning 证据与 AGENTS.md 回写代码算出交付后的
检查点（含 handoff），超出即启动前拒绝并列出最大的改动文件；新建运行的任务基线装不进一条记录时同样启动前拒绝，宿主在建存档前
也会拒绝。当前会话若仍交付了这么大的改动，结果是可重试的 `blocked/develop_package_too_large`，缩小或移出这些文件后
`--mode resume` 再 `advance`，不会再以 `unknown/store_failure` 结束。旧版已经写成 `unknown/limit_exceeded` 的开发检查点，只有在
第 1 轮开发调用成功、检查全过且尚未生成审查包时才会按同一阻断投影；第 2 轮旧记录无法证明检查属于当前 effect，保留原状态。原 journal 不改写，恢复后的下一条检查点携带新状态。这些阻断的 `reason` 用同一个有界规则生成：每个路径最多
300 个字符（超长的保留开头和文件名），放不下的以「等 N 个」汇总，整条不超过存档回放允许的 8192 个字符。任务 handoff 的 256 KiB 上限不会被合法交付触及：改动文件来自不超过 64 KiB 的运行定义，
检查结果不超过 64 KiB，按这些上限能拼出的最大 handoff 约 219 KB（有测试固定）；提高任一上限时须同步处理 handoff 上限。
上述通用迁移不适用于 instruction bootstrap：规则写入通道不能因此取得一次新的开发派发；它保留原运行的保守 `unknown/limit_exceeded`，由规则通道单独处置。
这些开发阶段阻断（含 `develop_checks_not_passed`）在第 2 轮同样可在原轮次重试：重做本轮交付时不再要求代码与第 1 轮审查包一致，
新审查包仍对照任务基线检查范围外改动。审查包本就逐文件记录
`mode`（十进制权限位）且删除记为 `after:null`，审查者可见，事后改动权限同样算包漂移。驾驶员在启动宿主前拒绝：
格式不对的条目、删除或改权限的文件在交付前不存在、单个 scope 文件超过 1 MiB、审查材料（按审查包快照计：scope、
requirements 与树中全部 AGENTS.md 正文）合计超过 2 MiB 或 256 个文件，以及交付后与任务基线完全相同（`edits:{}` 或内容和权限都没变）；报错写明
文件路径和上限。当前会话若仍交付了空改动，结果是可重试的 `blocked/develop_empty_changes`（旧版本记为
`unknown/empty_changes` 的历史按原样回放），修正后 `--mode resume` 再 `advance` 同一轮开发。
运行定义的 `runId` 须为 8–128 个字符（运行日志要求），新建运行前即拒绝；已有运行的恢复不受影响。
当前会话模式下开发应答未通过交付合同校验（如 `application.note` 超过 512 个字符或含换行），旧版记为终态 `blocked/failed`；现在 status 显示可重试的 `blocked/develop_answer_invalid`（`pendingAction=resume`，`reason` 写明字段上限），`--mode resume` 后 `advance` 先追加 `develop-answer-retry` 记录，再以新 effect id 重发同一轮开发：会话已写的代码保留，交付仍按本轮起点生成并经检查和独立审查，审查轮次不变；被拒应答不占计数名额（每运行最多 2 次），仍受 `develop_retry_limit` 约束。开发请求的指令里已写明这些上限。
开发应答超过宿主请求上限（固定 30 分钟）记为 `unknown/call_timeout`；若代码根仍与该轮开发开始时一致（第 2 轮为已审的第 1 轮审查包，第 1 轮为任务基线），status 投影为 `blocked/develop_call_timeout`（`pendingAction=resume`），`--mode resume` 后 `advance` 先追加 `develop-timeout-retry` 记录再以新 effect id 重发同一轮开发，审查轮次不变，超时调用不占计数名额（每运行最多 2 次），仍受 `develop_retry_limit` 约束；代码根已变化（会话超时后写过文件）或起点无法核对时，当前会话（非受保护）开发改走「应答缺失、无效或迟到」的 `develop_redo` 确认重发，其余仍为 `unknown/reconcile`；已写入重试记录后（含记录后宿主退出再恢复）仍在派发前再次比对起点，变化则拒绝 `develop_timeout_root_changed` 且不派发，迟到应答以 `host_response_late` 拒绝。

批次驾驶员：`develop.json.edits` 的格式与启动前检查同单任务；尚未开跑的后续任务不看代码树，只做答案本身就能判定的检查（单文件不超 1 MiB、答案写入的 scope 文件合计不超 2 MiB 等）；运行存档单条记录上限要看该任务开跑时的基线，驾驶员事先无法核算，超限交付在写入后由宿主拦下，停在可重试的 `blocked/develop_package_too_large`，缩小或移出大文件后重试。

当单次 `develop` 回答超过默认 64 KiB 时，在单任务或批次 `PLAN.permissions` 传
`["--input-limit","1048576"]`；上限为 4 MiB（4194304 字节）。这是宿主输入传输限额，
同时约束输入行和工具应答（`cm-ai-host`、`cm-ai-batch-host`、`cm-fix-host` 一致；cm-fix 驾驶员用 PLAN
`inputLimit`），不改变运行定义或恢复指纹；恢复时可调整。受保护模式下驾驶员会先估算 develop 应答大小，
超过上限时启动前退出 2 并给出应加的值。超长输入行结束会话时报 `request_too_large`（不再是笼统的
`host_launch_failed`）；宿主拒收应答（`host_response_too_large` 或 `host_response_mismatch`）时驾驶员
不再等待，结束会话并退出 1，这一步记为 `unknown`。

## 第 2 轮答案缺失

若第 1 轮已经待审且计划带
`--allow-review-attempt 1`，`advance` 可能在同一次调用中进入第 2 轮；缺 `develop-a2.json` 时会在
启动宿主前退出 2，并提示当前 `packageDigest`。此时先以该 digest 调用 `decision` 单独运行审查，
读取 `.reviews/<feature>-<task>-r1.md` 的 findings，针对 findings 写好 `develop-a2.json`，再调用
`advance`。

## 应答缺失、无效或迟到

会话没给出可用应答时，宿主不再停在 `unknown/reconcile`，而是给出可重试的阻断；旧运行恢复后按原 journal 同样投影，原记录不改写，新记录只追加。
每种出口每运行最多 2 次；用满后同样的卡点显示为明确的上限阻断（`check_answer_retry_limit`、`complete_recheck_limit`、`develop_redo_limit`，`pendingAction=none`），reason 写明剩下的出口：查清根因后用 `--supersede-reviewed-evidence` 新建运行，本运行留在盘上的改动需还原或加 `--accept-superseded-code-drift`。上限阻断由 journal 推导，不另写记录。所有提问都有应答期限（`CM_HOST_ANSWER_TIMEOUT_MINUTES`，见 `docs/user-guide.md`），到期后才到的应答一律拒收为 `host_response_late`。

单任务与批次驾驶员按宿主将显示的投影状态（而不是原始回放状态）决定预检哪一轮的开发答案：`develop_call_timeout`、`develop_answer_invalid`、`develop_dispatch_failed` 预检本轮 `develop*.json`；`check_answer_*` 本轮不再问开发。第 1 轮恢复且带首轮审查授权（单任务 `--allow-review-attempt 1`、批次 `--allow-review 任务:1`）时，同一次 `advance` 可能在审查要求修改后进入第 2 轮，驾驶员也预检 `develop-a2.json`；没有这份答案时，单任务驾驶员给宿主加 `--hold-revision`、批次给该任务加 `--hold-revision`，任务在审查后停在 `changes_requested`（`revision_answer_required`），不发起答不上的第 2 轮开发。`develop_redo` 由驾驶员 PLAN 的 `mode:resume`、`permissions:["--allow-develop-redo"]` 与 `reason` 发出。

- `blocked/check_answer_missing`、`blocked/check_answer_invalid`（`pendingAction=resume`）：开发已交付并写回 Learning，之后的检查或验证预检超时、断开、迟到或答复格式不合格（旧记录 `unknown/call_timeout`、`execution_error`、`invalid_input` 等，最后一次开发调用 `succeeded`）。
  先确认上一次检查命令已停止，再 `--mode resume` 后 `advance`：宿主追加 `develop-recheck` 记录，用新 effect id 只重跑检查、验证预检、handoff 与审查包，沿用原交付的 Learning 输入，不重发开发、不占开发调用与 effect 名额，重新划定检查新建文件。
- `blocked/develop_out_of_scope`（`pendingAction=resume`）：开发已交付并写回 Learning，但建 handoff 或审查包时发现改动超出任务 scope（旧记录 `unknown/out_of_scope`，不只是检查新建的文件）。reason 列出路径。这些可能是会话越界写的，也可能是你自己的改动：还原或移出代码根（确需改动先走规格变更扩大 scope），再 `--mode resume` 后 `advance`：宿主追加 `develop-recheck`（`code: develop_out_of_scope`），只重跑检查、预检、handoff 与审查包，不重发开发、不占名额，每运行最多 2 次。
- `blocked/develop_answer_missing`，`pendingAction=develop_redo`：当前会话开发（非受保护、非 provider、非规则 bootstrap）的应答没拿到——超时后代码根已变化或起点无法核对（`unknown/call_timeout`）、会话断开或应答形状错（`unknown/unknown`、旧 `execution_error`）、只回了 `failed` 没有结果（`blocked/failed`）。
  会话可能仍在写文件，宿主看不到，所以 `advance` 不会重发。先确认会话已停止修改代码，再 `--mode resume --allow-develop-redo` 启动并发送 `develop_redo`（单行 reason，最多 500 UTF-8 字节，写进 `develop-answer-redo` 记录）；之后 status 为 `pendingAction=resume`，`advance` 用新 effect id 重发本轮开发。
  盘上改动保留；审查包始终对照本运行创建时拍下的任务基线（重发时不重拍），所以丢失应答期间写入的内容都会进检查与独立审查。不占调用与 effect 名额，每运行最多 2 次；受保护模式下代码根变化可能是半写入，不走此出口。
- provider 开发（Codex 直写、Claude 提案由宿主应用）结果不明——`unknown/call_timeout`、`unknown/unknown`、提案未通过本地校验的 `blocked/failed`（`invalid_result`）、启动失败或报告失败的 `blocked/unavailable`——同样显示 `blocked/develop_answer_missing`、`pendingAction=develop_redo`，但只限新版本记了 worker 进程身份（`workerJournal` + `develop-worker`）的 effect。
  发送 `develop_redo` 时宿主按记录核对进程组（含应用提案的子进程）；Claude provider 还要代码根仍等于本轮起点（记 `basis`，否则 `develop_redo_root_changed`）：已退出（或从未启动）才写 `develop-answer-redo`（带 `worker` 绑定）；仍在运行拒绝为 `develop_redo_worker_process_alive`，核对不了拒绝为 `develop_redo_worker_process_unknown`，没记身份拒绝为 `develop_redo_worker_identity_unrecorded`。不带原因的 `blocked` 答复仍是终态，不走此出口。
- `blocked/develop_dispatch_failed`（`pendingAction=resume`）：开发请求在派发给会话之前就失败了——宿主自己的角色路由出错（运行日志写不进 `role_log_failed`、工作流角色配置无效 `invalid_workflow_config`），开发调用没有结果、没有派发、没有写盘。
  修好 reason 指出的宿主环境后 `--mode resume` 再 `advance`：宿主追加 `develop-dispatch-retry` 记录，用新 effect id 重发本轮开发，不占名额，每运行最多 2 次。
  每次重发前（含写下记录后宿主退出、恢复再发）都核对代码根仍等于本轮起点（第 1 轮为任务基线，第 2 轮为已审第 1 轮包）；起点无法核对或代码根已变，改走上一条 `develop_redo` 确认重发，派发时拒绝为 `develop_dispatch_root_changed`。用满 2 次后同样改走 `develop_redo`。
  旧版本把同样的失败记成 `unknown/execution_error`（形状同 api-native-reading-T-006 的旧记录），同样按上述起点核对处理。
- `blocked/complete_recheck_failed`（`pendingAction=complete`）：完成前复查没拿到可用应答或宿主在写提交意图前出错（`unknown/call_timeout`、`execution_error` 等，后者先按 stderr 的 diagnostic 修好原因，如缺失的 handoff），且 task-commit-intent 尚未写入、tasks.md 未改动。`--mode resume` 后 `complete`（或 `advance`）：宿主追加 `complete-recheck` 记录，用新 effect id 重新复查并完成，不重新开发或审查。已写 task-commit-intent 的仍按「放弃审查调用与 effect」处理。

## 重试名额与完成前复查

一个运行最多 6 次计数调用（本地拒绝的开发结果、自动重派的审查和被放弃的调用不计）和 6 个计数 effect（只有 develop、review；complete、
QA、文档与收尾不占名额；本地拒绝的开发结果、检查产物越界、自动重派的审查和被放弃的审查结果不计）。任何可重试的开发阻断反复出现、
剩余调用或 effect 名额已不够再交付一次并送审时，运行器在派发开发前写入 `develop-retry-limit` 并停在终态
`blocked/develop_retry_limit`（`pendingAction: none`）；按 reason 中的上次阻断原因修好根因后用 supersede 新建运行。
`evidence` 摘要文字变化且检查 `id/command/outcome/exitCode` 不变时可完成；代码、handoff 漂移（reason 列出路径）或 Learning handoff 核对不一致为终态 `blocked/package_mismatch`，越界 scope/需求漂移保持 `blocked/out_of_scope`。完成复查答复的检查清单（编号或命令）与审查包不同、或仅 `outcome/exitCode` 变化时为可恢复的 `blocked/completion_checks_changed`，reason 写明两边的检查编号。#160 之后的旧版本把检查清单差异记成原因只有 `package_mismatch` 的终态（如 picks-feed-T-001-r2），回放时投影为 `completion_checks_changed`；更早没有原因的形状（如 bootstrap-T-001-r6，#160 前比对了检查证据文字，但同一形状也可能是 Learning handoff 不一致或代码漂移）无法证明只是检查差异，仍是终态，按原样 supersede；"handoff 文件名不带 runId 导致串号"的推断已排除（两次都是检查清单或证据差异）。处理方式：先修好检查环境，再用原 runId、原配置 `--mode resume` 执行 `advance`（或 `complete`）；新 complete effect id 重跑检查，原 Review 回执与 packageDigest 不变，不新开 run 或重审。complete 本身不占六个 effect 名额，审查已批准的运行总能进入完成；这类完成前复查阻断（含 `completion_package_changed`）
单独最多重试 3 次；第 4 次仍被拦下时运行器写入 `completion-retry-limit`，停在终态 `blocked/completion_retry_limit`（`pendingAction: none`），
先修好检查环境再 supersede 新建运行。旧 journal 按原格式回放。

## 恢复参数与跨会话接手

恢复参数与创建时不一致时 `fingerprint_mismatch` 的 `reason` 会点名差异（runtime、审查配置、
host-context 或其余只存指纹的配置），`invalid_arguments` 也写明是哪个参数。

原配置指纹和 init 元数据仍绑定创建会话，旧记录不改；开发结果和审查授权使用当前真实会话。
新会话首次签审查授权前追加 `host-joined`，仅打开或 status 不写；创建会话、已加入会话和当前会话
都排除为审查员，当过审查员的线程不能回来当宿主。最多记录 16 个接手会话。
支持 V3 会话父运行及其 QA-fix 子运行；旧 protected 兼容分支、batch 不支持此跨会话入口，原授权仍须逐项提供。
QA-fix 新建子运行的配置 hostContextId 只能是当前会话或父运行的持久创建会话；已有子运行沿用原配置并校验指纹。
子运行打开（含 fix_status）和审查授权使用当前真实会话；首次签授权前由 cm-fix 记录 fix-host-joined-N，
只读打开不写接手记录，causeReview.contextId 不能是当前会话。子 runtime 仍须匹配宿主。

## 审查配置诊断失败

Claude CLI 报 `unrecognized_model` 时 preflight 会失败并在 stderr 指明被拒 id、可用的家族别名示例（如 CLI 2.1.x 的 `claude-opus-5`），可快速取得时也打印 CLI 版本；示例不是完整模型清单。
Claude 诊断只做回环请求捕获，`stopped_by_probe` 表示诊断自身终止，不发送工作流 cancel。
执行策略批次（未开外部模型）的并行成员预检缓存现在放在 `.reviews/external-preflight/<batchId>/`。旧版本放在运行目录 `.reviews/.execution/<batchId>/`，外部运行守卫会把它当成无法核实的运行，成员一律打不开。批次宿主打开成员前会核对这个旧目录：只含本批次并行成员的 `preflight-<task>.json`（0700 目录、0600 单链接文件），且每份仍绑定本次 `--review-config` 的模型、禁用技能和该成员 worktree 的指纹时，逐个移到新位置复用（新位置已有相同内容就删旧副本），不再重做回环。其他情况返回 `legacy_preflight_cache_invalid`，`reason` 写明目录和不符合的地方，宿主不移动任何文件；只读核对、确认没有进程在写后把该目录移出 `.reviews/.execution`，再用同一配置重启批次宿主并 `advance`，成员会重新预检。

## 审查计时与快照忽略

运行器对每次审查计时的上限取「journal 里的调用超时」与「审查预算 + 60000 毫秒余量」中较大者；这个上限不写入 journal，所以把 review-config 的 `timeoutMs` 调到 30 分钟以上（最多 3600000）不会再在 30 分钟被运行器截断，恢复时也可继续调大。
新运行的代码根快照固定忽略 `.DS_Store`、`._*`、`.AppleDouble/`、`Thumbs.db`、`xcuserdata/`、`*.xcuserstate`、`.build/`、`.swiftpm/`、`DerivedData/`，也跳过 Git 报告为 ignored 的目录及路径；任务 scope、AGENTS.md 与 specs 仍须验证。基线有界保存 Git 忽略路径与目录，后续将基线和当前忽略决定的并集应用到比较两侧；规则文件和无关 Git 配置变化本身不阻断审查。Git 不可用或忽略结果超限时基线标明仅用固定列表。这有意缩小代码根检查面，被忽略的产物不构成已审代码；旧 journal 沿旧规则回放。

## 规格漂移、代码漂移与审查失败

规格经 `cm-prd --change` 重新批准后，在途运行的 `status` 报 `spec_drift` 并列出变化文件：只动了其他任务的条目、依赖或用例
（requirements.md、design.md 整份未变，本任务条目含续行未变）时
`pendingAction: spec_rebind`，用原配置 `--mode resume --rebind-spec-material --spec-rebind-reason "原因"` 显式换绑，
已有开发与审查结论保留；内容有变时 `pendingAction: none`，还原规格后继续，或 cancel、还原代码后 supersede 重做。
普通 create 遇到同任务未被替代的旧运行留下的未审改动时返回 `supersede_code_drift`，按提示还原或 supersede。
审查期间代码根非忽略路径漂移时，`blocked/review_package_changed` 保留 verdict、回执与最多 20 个差异路径；清理或还原后在原 run 继续 `advance`，不会重派 reviewer。结果已入 journal 而检查点未写入时，恢复会从同一结果补写检查点；结果仍可用，不消耗新轮次。审查前的漂移拒绝 `decision`，完成前的漂移拒绝 `complete`，均列出路径；完成检查期间新增文件进入可重试的 `blocked/completion_package_changed`，清理后在原 run 重发 `complete`。未匹配时 `pendingAction` 不提示会被拒绝的动作。
审查传输超时且没有结果事件时，记录 `pending_review/review_transport_timeout`，可用 `--mode resume` 后 advance，
每轮重新取得 Review 授权、grant 与 invocation 后重派；每轮的无结论重派见下文「每轮无结论重派」。
审查 CLI 没调用工具、没给结论就失败且进程已退出时（未登录 `reviewer_auth_failed`、额度 `reviewer_billing_error`、
限流 `reviewer_rate_limited`、服务端错误或过载 `reviewer_server_error`、模型不存在 `reviewer_model_not_found`、
其他 API 错误 `reviewer_api_error`、进程报告失败 `reviewer_provider_failed`、没有 init 或无法识别的事件
`reviewer_stream_unrecognized`、没有结论就退出 `reviewer_exited`），记录新的 `failed` 结果并停在
`pending_review/review_provider_failed`，`reason` 以类别开头并写明先登录还是等待；处理后按超时同样的方式恢复重派。
审查答复违反 verdict 规则（`contradictory_verdict`、`invalid_finding_path`、`missing_material`、`review_package_mismatch`、
`invalid_finding_severity/id/shape`）时不产生回执，停在 `pending_review/review_verdict_invalid`，`reason` 以该代码开头。
这两类与传输超时、abandon 共用每轮的无结论重派。工具或上下文越界等仍为 unknown；其中 Claude 审查进程在边界被停（`unexpected_tool_or_content`，
代码后带 `{k,m,b,t,e}` 摘要：拒绝点、消息类型、块类型、工具名、is_error，不含正文）且进程已退出、没有最终消息、不是超时、
摘要属于 `user_content`／`empty_content`／`tool_attempt_limit`（旧记录没有摘要、分不清原因，按兼容决定同样允许）时，`pendingAction` 为 `abandon_review`，可按下文显式放弃并重派一次；
`tool_result_not_error`（非 StructuredOutput 工具成功执行）等真正越界仍为 unknown，只能 cancel。Claude CLI 自己注入的提醒（`isSynthetic` 的 user 文本，如要求调用 StructuredOutput）
现在按通知处理，不再触发该停机；审查结论只认 `structured_output`，文字回答不是结论（`invalid_output_json`）。
`blocked` verdict 表示在批准范围内改代码也无法通过（规格矛盾、缺材料、需改范围外文件或需人工决定），
是终态且不进入第 2 轮；`reason` 写明审查给出的原因，按原因修规格或范围后新建运行。审查提示已写明这一定义，
可修复的问题必须用 `changes_requested`。
已有最终消息但被超时截断（或旧版本记为 unknown、属于上述可重试类别）的审查不会自动重派；`pendingAction`
为 `abandon_review`，操作员确认后用下述 `abandon_review` 留痕放弃这条从未被接收的结果，journal 追加带
`resultDigest` 的 `review-invocation-abandoned`，再按一次重派恢复。旧 journal 按原样回放，旧 unknown 不自动改类；
旧版本以 `unexpected_assistant` 等不在上述类别的代码记下的失败仍需 reconcile。兼容Codex/Claude当前会话，保留原runtime与Review授权。

### 每轮无结论重派

一轮审查（attempt）最多无结论重派 **2 次**，单独计数，不算两轮审查轮次，也不占调用与 effect 名额；重派只在本轮没有接收任何结论时发生，所以不会出现第三份结论。三种来源共用这 2 次：

- 第一次可重试的结束（`review_transport_timeout`、`review_provider_failed`、`review_verdict_invalid`）自动回到 `pending_review`；
- 操作员的 `abandon_review`（已登记无结果、已有未被接收的结果，或下面的进程已退出中断）；
- 本轮第二次可重试的结束：存档里仍是 `blocked/<同码>`（旧版本到此为止）。宿主只中止了原调用、没有等到审查进程退出，不能证明它已停止，所以状态保持 `blocked`，带 `reviewRedispatchStopRequired: true`、`pendingAction: abandon_review`，`reason` 以 `review_redispatch_stop_required:` 开头。操作员确认原审查进程（含子进程）已退出后，以 `--allow-abandon-review` 发送 `abandon_review`（单行 reason），宿主追加 `review-redispatch`（绑定 effect、invocation、attempt、码、确认原因与时间），状态回到 `pending_review`，之后 `advance` 重新取得授权并重派。未确认前 `advance` 不派发。

2 次用完后，可重试的结束显示 `blocked/review_redispatch_limit`，`reason` 写明先查登录、额度、网络或答复格式，再用 `--supersede-reviewed-evidence` 新建运行；`abandon_review` 拒绝为 `review_abandon_budget_exhausted`。回放从存档重新推导：伪造、重复或第三次 `review-redispatch` 一律 `runner_review_redispatch`；没有该记录的旧存档按原样回放。

worker 已证明审查进程退出、又没有结论的中断，`pendingAction` 为 `abandon_review`：`spawn_failed` 且没有任何事件（进程从未启动），或观测到非超时的 `process_closed` 且没有最终消息（`output_limit`、`prompt_write_failed`、`thread_mismatch`、`cli_diagnostic`；`invalid_output_json` 的最终消息无法解析，没有可对账的结论）。宿主不能证明重派安全的仍为 unknown，状态的 `reason` 与 `abandon_review` 的拒绝码一致并指向 supersede：

| 码 | 情形 |
|---|---|
| `review_process_unverified` | worker 报告进程组清理不明（`process_cleanup_unknown`） |
| `review_observation_invalid` | 审查事件流本身不合法（`observation_invalid`） |
| `review_boundary_unverified` | 工具或内容越界后退出，或退出前可能已收到结论 |
| `review_abandon_budget_exhausted` | 本轮 2 次已用完 |

外部模型与执行策略的审查不走以上出口：流里有回执就先 `reconcile_review` 对账采纳；没有回执宿主无法证明旧调用已停，`abandon_review`／`abandon_effect` 拒绝为 `external_review_reconciliation_required`，按 status 的 `reviewReconciliation.reason` 向原宿主或 provider 核对。

### 已批准规格材料（第 24 步）

新 run 的开发请求与审查包携带同一份只读 `specification`：`feature`、`task:{id,description,verification?}`、全部 `acceptanceCriteria:[{id,text}]`、`designExcerpt`、本任务 `taskIds` 匹配的 `testCases`、`sources:[{path,sha256}]`。任务描述保留 `~预估`，verification 保留「验证要求」中本任务的行；设计按 UTF-8 最多 64 KiB，超限加 `truncated:true`，未提供 test-cases.json 时用空数组及三项来源。

宿主复用 `.cm-specs-status.specFiles` manifest 校验完整批准清单及读取字节；来源路径相对 specsDir，哈希沿用 manifest 的任务/AC 运行期勾选规范化规则，其他正文保持精确绑定。新建、开发派发、受保护提案写入、审查及完成前发现不一致以 `spec_drift` 阻断；已有 run 即使规格重新批准也不能替换其原始材料。baseline 保存材料及私有规格根供回放和重验，审查包只携带材料，参与 `packageDigest`。

`requirements` 是可选补充材料（代码项目内 README 等，可用 `[]`），不再承担唯一的任务描述来源。按 specification 的 AC 与接口契约实现和审查；材料不构成扩权授权，不改变 scope、protected_specs、Review 或完成门禁。旧 baseline/package/receipt 缺少新字段时按原格式校验，不重写历史摘要。

（真实 dogfood 事故：specs 在代码根之外，受保护 coder 和 reviewer 只能看到代码根 requirements，缺少任务行、AC 与接口契约，曾需手工复制规格摘要才可开发。）

## 放弃审查调用与 effect

单任务 V3 的审查调用若已登记（可能已 started）但没有 result，或如上所述已有未被接收的结果，操作员先确认旧 host 与 Review 进程都退出，
再用原 runId 恢复并显式放弃该调用：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume --host-context new-host-id --original-host-context old-host-id --allow-development --review-config review.json --allow-abandon-review --runtime claude
```

向宿主 JSONL 输入发送 `{"version":1,"requestId":"abandon-1","operation":"abandon_review","identity":{"repositoryId":"…","runId":"…","taskId":"…","attempt":1},"reason":"已确认旧进程退出"}`。
`reason` 为非空单行、≤500 UTF-8 字节。旗标一次性消费，不持久化、不影响配置指纹；宿主无法验证进程已退出。
成功后 journal 追加 `review-invocation-abandoned` 并写 `review_abandoned` 运行日志，状态为
`pending_review/review_abandoned`，`pendingAction: resume`。新宿主以原配置、原 runId 和新的
`--allow-review-attempt 1`（第二轮为 2）恢复并发送 `advance`，重新签发 grant、登记新 invocation。
与本轮其他无结论重派共用每轮 2 次（见上文）；用完则拒绝为 `review_abandon_budget_exhausted`，拒绝结果带 `reason`。
宿主在审查结果已写入存档、检查点还没写时退出（结果不是结论），恢复后 `pendingAction` 同样是 `abandon_review`；放弃记录带该结果的 `resultDigest`，并且必须紧跟在结果记录之后。
旧 invocation 的迟到结果不能再接收；若要终止，abandon 后普通 `cancel` 才能得到 durable cancelled。
批次路径不支持此操作。driver 可用 `node scripts/cm-ai-drive.mjs --plan abandon-review.json abandon_review`；
PLAN 需 `mode:"resume"`、原配置、`originalHostContext`、`permissions` 包含 `--allow-abandon-review`、`reason`。

宿主在 `develop`、`complete` 或尚未登记的 `review` 中途退出，只留下 `effect-intent`（其后仅有 control、`host-joined` 或 provider 的 `develop-worker` 记录）且没有 checkpoint 时，恢复后是 `unknown/reconciliation_required`，`pendingAction: abandon_effect`。操作员先确认原 host、会话写入和相关子进程均已退出；随后用原 runId、原配置和原 runtime 执行：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume --host-context new-host-id --original-host-context old-host-id --allow-development --review-config review.json --allow-abandon-effect --runtime claude
```

向宿主发送 `{"version":1,"requestId":"abandon-effect-1","operation":"abandon_effect","identity":{"repositoryId":"…","runId":"…","taskId":"…","attempt":1},"reason":"已确认旧 host 和检查进程退出"}`；driver 可用 `node scripts/cm-ai-drive.mjs --plan abandon-effect.json abandon_effect`，PLAN 需 `mode:"resume"`、`permissions:["--allow-abandon-effect"]` 和单行非空、最多 500 UTF-8 字节的 `reason`。旗标只消费一次，不进入原配置指纹。

运行不再作废：journal 追加绑定 effect id、kind、intent 摘要、前一条记录摘要与原因的 `effect-interrupted`，运行日志写 `effect_interrupted`，结果 `outcome: recorded`，运行从这一步自己的可重试阻断继续：

- `develop` → `blocked/develop_interrupted`，`pendingAction: resume`。`advance` 用新 effect id（`develop-N…-resume-K`）重发本轮；被中断的调用留一条 `abandoned` 审计记录，不占调用与 effect 名额。盘上改动保留，审查包仍对照运行创建时的任务基线，经检查与独立审查。bootstrap 规范任务在派发前照常核对规则文件，写到一半会停在 `bootstrap_instruction_conflict` 并列出路径。
- 受保护当前会话开发和 Claude provider 开发：写入是由 sandbox 子进程应用提案，代码根必须仍等于本轮起点（`basis`），否则拒绝为 `effect_interrupt_root_changed`／`effect_interrupt_root_unpinned`；先把列出的文件还原到本轮起点再重试，半成品不会当成新交付送审。应用提案的子进程同样记 `develop-worker`（`apply_spawning`；`apply_started` 带 pid），宿主核对它们都已退出才放行。
- provider 开发：新版本在 intent 上标 `workerJournal`，并在 worker 启动前后写 `develop-worker`（`spawning`；`started` 带 pid 即进程组、`ps` 启动时间）。宿主按记录核对进程组：已退出（或从未启动）才写 `effect-interrupted`（带 `worker` 绑定）；仍在运行拒绝为 `effect_interrupt_worker_process_alive`，Windows、无权限、读不到启动时间拒绝为 `effect_interrupt_worker_process_unknown`，只记到 `spawning` 拒绝为 `effect_interrupt_worker_identity_incomplete`，旧版本没记身份拒绝为 `effect_interrupt_worker_identity_unrecorded`（只能手工确认后新建运行替代）。
- `review`（未登记）→ `awaiting_review`，`advance` 重新取得授权并派发，不占重派次数。
- `complete`（无 `task-commit-intent`）→ 回到中断前的状态（通常 `approved`），`complete` 重新复查并完成。

同一类步骤每运行最多这样恢复 2 次。第 3 次中断时状态显示 `unknown/effect_interrupt_limit`，`abandon_effect` 只能按旧规则写 `effect-abandoned` 作废本运行（记过写入方的开发要带进程组已退出的证明），之后 supersede 新建运行。

已登记但无结果的 review 仍走上方 `abandon_review`；本轮 2 次无结论重派已用完（`review_abandon_budget_exhausted`）时，`abandon_effect` 按旧规则写 `effect-abandoned` 作废运行（必须绑定最后一条记录），之后可走下方 supersede，不再死锁。

已写 `task-commit-intent` 而没有检查点时（含恢复本身写完提交结果后又中断），状态为 `blocked/complete_commit_interrupted`，`pendingAction: complete`，`abandon_effect` 拒绝为 `effect_abandon_commit_pending`。发送 `complete`：宿主只按 journal 里的提交计划核对 `tasks.md`——已是提交后的内容就补记 `task-commit-result` 与检查点；仍是提交前的字节和文件状态、计划引用的证据未变、代码仍等于审查通过的交付，就按原计划写完再补记；提交结果已在存档里时只补检查点，不再碰 tasks.md、不重复写结果；否则拒绝为 `commit_recovery_conflict`／`commit_recovery_code_changed` 并保留现场，不重新复查或开发。

旧版本写下的 `effect-abandoned` 仍按终态 `cancelled/effect_abandoned` 回放。批次路径没有 `abandon_review`，也不接入 `abandon_effect`。不想在原运行继续时，blocked 的运行可按下方显式 supersede 新建，仍须通过旧 writer 和代码漂移检查。

## 开发结果校验失败

开发结果先通过完整 value/Learning 合同校验，再由沙箱落盘；本地校验失败记录 `failed` / `invalid_result`，原校验码保留在 `result.reason`。
当前会话返回 `blocked` / `developer_result_invalid` 时，修正回复后用原配置、身份和 runId 以 `--mode resume` 启动并 `advance`，同一 attempt 重新 develop，不消耗 provider 轮次。
`no_new_lesson` 必须 `candidates:[]` 且 `reason:null`（实跑事故：非空 reason 曾在文件落盘后抛错，被误记为 unknown，原 runId 无法恢复）。
重送已落盘提案时核对新的 expected 哈希：提案内容与磁盘一致才作为同一次实现继续；不一致返回 `protected_edit_stale`，保留文件并报告冲突，不能强制覆盖。
worker 异常、超时或传输歧义仍是 `unknown`，旧 unknown 历史不自动重分类；其他 blocked 原因也不能使用此重试入口。

## bootstrap 规范任务的恢复

恢复：`init-verify` 命令未通过或改动了绑定文件时，驾驶员不发送操作并关闭宿主。`mode:resume` 的运行存档不变，修正后原样重跑；`mode:create` 时宿主已建好运行（`ready`，只有 init 记录、未执行开发步骤），修正后把 PLAN.mode 改为 `resume` 重跑。规范写入后若 `PLAN.checks` 未通过，宿主停在可重试的 `blocked/develop_checks_not_passed`，规范文件保留在磁盘上：修好检查环境后在原运行 `advance`（`mode:resume`），同一轮以同一组答案重试，宿主把本运行已记录的写入当作起点，不另建运行。

如实返回未通过的核验组（status 不是 verified/not_applicable，或缺证据）时，宿主不写规范，运行停在同轮可重试的 `blocked/bootstrap_verification_failed`（`reason` 列出未通过的组与证据）；按证据修正后在原 run 再次 `advance`，宿主重新询问 `init_generate`／`init_verify`，不要新建运行。

派发前可判定的规则基准冲突停在 `blocked/bootstrap_instruction_conflict`，修复目标后原 run `resume`；若要采用新的提交，用新 runId 重建。生成后的并发漂移仍按 unknown 保留证据，不覆盖或自动重派。

规则文件、检查与 handoff 已写入，但审查包构建因目标证据不符而停在 `blocked/bootstrap_review_mismatch`，或旧宿主把同一阶段记为 `unknown/execution_error` 时，先确认旧 writer 已退出并保留原文件。仅原 run 的 attempt 1 可用 `bootstrap_review_recover`：以原 run 定义和原审查／workflow／bootstrap 配置 `--mode resume`，增加一次性 `--allow-bootstrap-review-recovery`；请求携带原任务 identity 和单行 `reason`。标准 driver 用 `node scripts/cm-ai-drive.mjs --plan recovery.json bootstrap_review_recover`，PLAN 为 `mode:"resume"`、`permissions` 含上述旗标及原配置路径、`reason`；换会话还须 `originalHostContext`。此操作不读取生成答案、不重派开发或检查，而是核对六个目标当前 SHA、原 handoff 的 changed_files 与 implementation 摘要，重建原审查包，并在 journal 追加可回放的 `bootstrap-review-recovered`。成功后是 `awaiting_review`，须另行授权独立 `decision`；若文件或 handoff 漂移，拒绝并保持原记录不变。

## 已完成运行上的后续改动

已完成运行的 QA 恢复、QA 修复、配置修订和收尾先核对原审查包。代码树已变化时，只接受两类变化：同一代码根与仓库中
其他任务已完成并已提交运行的审查交付（及其已登记的 QA 修复）——包括其 AGENTS.md 教训行和对本任务文件的修改；以及
本任务范围外的项目根 CM 配置文件。规则是确定的：审查时间晚于本运行批准审查的这类交付全部按审查时间排序、逐个严格接续
（所改路径的审查前状态必须等于当时的组合），本运行的 QA 修复按其最终审查时间插在同一序列中；不挑选、不搜索、不设
上限；最终组合必须与当前内容和文件权限完全一致。其余变化，包括对本任务交付文件、需求文件或其他文件的未审改动（例如
已审 A→B→A 之后手工改回 B），仍返回 `correction_review_required`，`reason` 列出未解释的路径。同一任务的替代运行、
未完成运行和并行批次成员（工作树根不同）的改动不被采纳。同一代码根上独立的 `cm-fix` 运行正常收尾（最终审查批准该包、`task_done` 与 `run_done` 已绑定）后也算已审交付，按其最终审查登记时间排序；进行中、放弃、取消或升级的不算，QA 修复子运行只经父运行接受计入。接受 QA 修复时，尚未记录且审查早于该修复最终审查的已完成交付排在它之前，以 version 2 关联记录（`laterDeliveries`，
只含运行 ID、包摘要与位于第几次修复之前）存进 journal，逐文件变化每次从已核实的存档读出；记录此后不变，其余交付（含审查
早于修复、但在接受之后才提交的交付）一律排在最后一次修复之后现场接续。记录里的交付须仍是所列运行已完成、且审查晚于本运行
的真实交付包：打开时存档都在就重新核对组合，不符拒绝打开；存档已不在则只能确认记录形状，状态核对与后续操作一律失败关闭。
将写入的完整记录超出存储限制时以 `fix_record_too_large` 拒绝、不写入。旧 version 1 记录照原样回放。
上限：一条关联记录最多 2048 个后续已审交付，超出失败关闭；大小核对不含存储目录 32 MiB 物理上限，崩溃残留的 `.state.<uuid>.tmp` 计入该上限，超出时追加以 `limit_exceeded` 失败，残留文件走存储现有恢复路径处理。
收尾发现文档需要改时，仍走经审查的任务，不能在已完成运行内直接改。

## 已审交接后的任务重跑

同名 handoff 已被审查回执消费时，新运行在创建 store 和开发前就拒绝 `handoff_exists`，错误的 `reason` 保留恢复提示。QA 配置错误用 [QA 恢复](js-host-qa-recovery.md#qa-配置修订) 的 `--revise-qa-config` 恢复原运行；宿主或环境证据不足用 `--rerun-blocked-qa` 恢复原运行。确需重新开发同一任务时，使用新的 runId 和下列显式授权：

```bash
node scripts/cm-ai-host.mjs serve --config run-new.json --mode create \
  --host-context {本次宿主身份} --allow-development --review-config review.json \
  --supersede-reviewed-evidence --supersede-reason "说明为什么要重跑任务"
```

原因必须为单行、非空、最多 500 UTF-8 字节。N5 会在 N6 前把任务勾为 `[x]`：若 QA BLOCKED 后确需重新开发，先在 `tasks.md` 将该任务改回 `- [ ]`，再用新 runId 和上述两个旗标创建运行；仍可恢复原 QA 时优先走原运行。只接受同 feature、task 的新运行：`tasks.md` 未勾选该任务，且每个旧运行的 V3 journal 已是无在途操作的 blocked、cancelled、unknown，或 fixture_completed 且 QA 为 BLOCKED／尚未结束；旧 writer 仍被进程持有也拒绝。pending develop/complete 和未加入 host／登记调用的 pending review 须先在原 run 用 `abandon_effect` 退出，已登记 pending review 须用 `abandon_review`，之后再建新运行。已完成或仍可继续的旧运行、没有旧运行或可归档文件同样拒绝。旧运行的 journal 不改写、不以新运行身份重开。

创建新 journal 和捕获新基线前，只把当前代码树与尚未被其他旧运行替代的直接前驱运行的 V2 开工基线逐文件比对，包含未选中文件及新增、删除路径；所有旧运行仍进入 `previousRunIds` 和归档。差异返回 `supersede_code_drift`，`reason` 和 `[host]` stderr 最多列出 20 个路径及其余数量。操作员可手动还原这些文件后重建运行；或确认保留这些改动时，在上述两个旗标之外加 `--accept-superseded-code-drift` 重建（这些文件会被当成已有代码，不进新运行的审查改动）。接受时新运行的 `evidence-superseded` 记录存下每个漂移路径、当前 SHA-256（删除时为 `null`）及被比较的前驱 runId。该旗标仅限新建运行，不默认启用。检测只读代码根，不跟随越界软链接；无法安全读取时即使带旗标也拒绝。没有可用逐文件基线的旧 journal 跳过此检测，不改写历史记录。

使用 `cm-ai-drive.mjs` 时，将两个必需参数放入新运行 PLAN 的 `permissions`；接受代码漂移时再加入 `--accept-superseded-code-drift`。缺少必需参数、单独使用接受旗标或 `mode: "resume"` 时，驾驶员在启动宿主前拒绝。

新运行先在自己的 journal 追加 `evidence-superseded`，绑定原因、旧 runId、文件名和 SHA-256，然后用先硬链接再解除原链接的方式把该任务同名 handoff、review 及具名 correction／QA 文件移至 `.reviews/.superseded/{原文件名}.{摘要前16位}`，并写 `supersede` 运行日志。归档中断后以同一新 runId 执行 `resume` 会按记录补齐；未用此旗标的运行不增加记录或改动旧证据。历史 QA 的 UUID 报告仍由旧 runId 日志引用，保持原位。新 handoff 和 review 使用原文件名，旧证据只在归档中留史。

旧运行因 `review_limit`／`review_blocked` 等停下时，`evidence-superseded` 另存 `carriedReview`：直接前驱最后一份审查回执的 verdict、summary 与 findings（按审查文本上限截断；前驱没有回执时沿用它自己带过来的那份）。新运行仍从第 1 轮开始、名额不变，只在第 1 轮开发与第 1 轮独立审查请求中附上只读的 `supersededReview`，提示注明它是上个运行的发现、不是结论；回放按请求摘要绑定，事后替换即拒绝。没有该字段的旧记录照原格式回放。

## 批次成员的恢复操作

批次宿主 `cm-ai-batch-host.mjs` 以前只收 `advance`、`status`、`cancel`、`reconcile_review` 和两个 QA 重跑开关，成员停在下面这些状态时整批卡住。
现在批次把单任务宿主的同名恢复操作转给**当前停住的那个成员**的运行（同一 cm-ai 入口、只带这一项权限），不跨成员：

| 成员 `pendingAction` | 批次启动参数（每个任务一次） | 批次操作 |
|---|---|---|
| `develop_redo` | `--allow-develop-redo FEATURE/TASK` | `{"operation":"develop_redo","requestId":"…","taskKey":"FEATURE/TASK","reason":"会话已停止修改代码"}` |
| `abandon_effect`（含第 2 批的中断续跑 `recorded`） | `--allow-abandon-effect FEATURE/TASK` | 同上，`operation:"abandon_effect"` |
| `abandon_review` | `--allow-abandon-review FEATURE/TASK` | 同上，`operation:"abandon_review"` |
| `bootstrap_review_recover` | `--allow-bootstrap-review-recovery FEATURE/TASK` | 同上，`operation:"bootstrap_review_recover"` |

先确认旧宿主、会话写入或子进程已停止，再关掉批次宿主，用同一批次配置加对应参数重新启动，发送批次操作；之后 `advance` 继续本批次（`develop_redo` 之后由 advance 重发本轮开发，驾驶员照样按投影后的状态预检答案）。
`reason` 单行、不超过 500 UTF-8 字节，规则与次数上限同单任务宿主；授权用一次即失效。
拒绝码：没有授权 `batch_member_action_authorization_required`（`reason` 写明参数）；不是当前停住的成员 `batch_member_action_not_current`；成员还没有运行存档或 worktree 不在 `batch_member_action_unavailable`。
整批 `cancel` 之后仍永久停止，转发操作返回 `cancelled`。成员状态里的 `guidance` 已改为指向这些批次参数与操作。

QA：`--qa-environment-failure 原因` 随 `--rerun-blocked-qa` / `--rerun-unknown-qa` 使用，交给有 QA 的已存在成员。
不支持、启动即拒绝的单任务参数：`--revise-qa-config`（`batch_qa_revision_unavailable`：每个成员的运行指纹绑定整批 workflows，改一个成员会让其他成员都无法恢复，单任务宿主也打不开批次成员运行）和 `--rebind-spec-material`（`batch_spec_rebind_unavailable`）；`reason` 写明出口（`--rerun-blocked-qa`，或取消本批次后用单任务宿主 supersede 新建运行）。

并行组：普通批次的并行成员进入终态仍改排串行第二代（保留 WIP 分支）。外部模型或执行策略批次以前一律停在 waiting、永远不改排；现在只在成员可在自己运行里恢复（`pendingAction` 为上表操作或 `reconcile_review`）时停下，返回 `batch_parallel_member_recovery_required`，`reason` 与 `guidance` 写明批次操作（对账用 `reconcile_review` 的 `taskKey`、`invocationId`），worktree 保留；结果未确认或审查未终结（`unknown`，如 `unknown/transport_incomplete`、`reviewReconciliation.available:false` 时的 `pendingAction:"reconcile"`，以及 `pending_review`）返回 `batch_parallel_member_unresolved`，同样留在原运行、不删 worktree、不建第二代，`reason` 写明出口（有回执就批次 `reconcile_review`；出现 `abandon_*` 用对应批次操作；都没有只能取消批次后用单任务宿主 supersede 新建运行）；只有成员**原始存档**也是已 checkpoint 的 `blocked`、且没有在途 effect（旧调用已返回、写入方已停）才与普通批次一样改排串行第二代——宿主显示的投影不算数，例如原始状态为 `unknown`、只是重做额度用完而显示为 `blocked/develop_redo_limit` 的成员同样返回 `batch_parallel_member_unresolved`（结果带 `rawState`）；改排后这次 `advance` 先停在 `batch_member_rescheduled`（`rescheduled` 列出成员），不在同一次里开发第二代。第二代是新运行、从第 1 轮开始：按 WIP 分支准备 `answers/<feature>/<task>/develop.json`（批次驾驶员在 resume 时会按日志里的 `batch_member_blocked` 预检第二代的第 1 轮答案与 `qa_assess`，已交接的任务不再预检），再 `advance`。

资源闭合：批次交接前对 `cleanup_failed` 的 QA 命令资源先由宿主核对进程组已退出并补记 `released`（第 2 批）；仍未闭合时返回 `batch_resources_open`，`reason` 列出未释放的资源及原因（进程组仍在、没有记录进程身份、无法核实）。
