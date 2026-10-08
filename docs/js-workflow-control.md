# JS workflow 控制与当前会话入口

## cm-ai 当前任务进度

cm-ai 宿主返回的可选 `guidance` 说明当前阻塞与下一步：`summary` 是普通话摘要，
`nextStep` 是处理步骤，`recoveryOperation` 是原宿主已有的操作名，`prerequisites` 是恢复前提。
`authorizationGranted` 固定为 false；它不授予派发权限，也不替代原 `state`、`code`、
`reason`、`pendingAction` 或完成门禁。结果未确认、拒绝或仍有在途操作时，不建议直接重跑。
单任务／批次驾驶员把同一说明打印到 stderr，stdout 仍为 JSON；状态卡展示同一摘要。
读取 status 只计算说明，不更新状态卡或执行存档；历史运行沿原配置恢复，不迁移记录。
批次说明按批次入口调整：保留原批次配置和 PLAN，从原批次 `advance` 续接；不套用单任务
`--mode` 或成员的放弃、规则包恢复、规格换绑操作。批次不支持的出口只说明需核对，不派发。

- `blocked/develop_checks_not_passed`、`develop_package_too_large` 等且原 `pendingAction=resume`：
  根据 reason 修复代码、环境或材料，保留原配置及 runId，以 `--mode resume` 启动，再发送 `advance`。
  这会重做本轮交付和检查；提示不提供新审查授权。改变 scope 须先走规格变更。
- 规则交付后的审查包失败，仅原宿主明确 `pendingAction=bootstrap_review_recover` 时：核对规则、
  handoff 与原证据，以原配置 resume，显式 `--allow-bootstrap-review-recovery` 并提供 reason，
  再发送 `bootstrap_review_recover`，不重新派发开发。
- `unknown`：先核对原运行、实际文件及进程。只有原宿主报告可放弃操作时，才说明对应的
  `abandon_effect`／`abandon_review`、显式权限与 reason；旧进程须退出，放弃不代表成功。
- 完成复核可重试时只建议 `complete`；旧 `checks_not_passed`、规格漂移、规则基准冲突、
  已完成任务的补正审查和未知阻塞不获得通用开发重试许可。

例如：检查失败时显示“开发检查未通过，尚未进入独立审查”，而不只显示错误代码。
精确失败检查、文件和证据继续保留在原 reason 中；说明不复述 provider 原始输出。

当前会话宿主在真实开始开发、执行检查、核对交付和启动审查时更新 specs 下的
`.cm-status.json`，并记录成对的 `progress/start`、`progress/complete` 事件。
状态卡绑定 feature、task、run_id、attempt；只有观察到 provider 的新线程事件才显示
`reviewing`。检查通过后等待授权显示 `awaiting_review`，不把检查通过写成审查通过。
阻断沿用真实 code；完成开发检查后仍明确等待 QA／收尾，不提前显示整个 run 完成。

`cm-ai-drive.mjs` 和 `cm-ai-batch-drive.mjs` 在 stderr 输出每项检查的开始、结果与退出码，
包含共享 QA 执行器中的命令。stdout 保留结构化控制结果。普通模式继续转发原有命令输出；保护模式只增加命令边界提示，
不转发原始输出、不改变沙箱。手写 bridge 若用 `capture_output` 等方式缓冲输出，CM 无法
取得它尚未转发的中间内容；无需为这个显示修复重跑或修改正在执行的业务任务。

状态卡展示最近开始的阶段，不汇总并行任务；旧 QA／收尾结果仍记在原运行历史，不能覆盖
其他任务的状态卡。只读 `status` 不落盘刷新。事件更新没有定时心跳，最后更新时间不能
证明进程仍存活；状态文件也不能代替 journal、独立审查或任务完成门禁。
恢复时重放 QA 配置修订、补齐缺失的日志镜像，都不算新阶段，不会重新认领或刷新状态卡。

## cm-fix 本地 unknown 步骤的人工放弃

`stage=unknown` 时，原 intent 不自动重派。宿主先检查旧进程已停止及可能留下的本地改动；
明确决定重做后，以 `--allow-abandon` 启动 cm-fix 宿主，发送
`{"requestId":"abandon-1","operation":"abandon_step","reason":"具体原因"}`。
原因必须是非空单行，最多 1000 UTF-8 字节；每个运行最多 8 次。QA-fix 子宿主使用
`--allow-qa-fix-abandon`，在 `fix_action` 中传 `fixOperation:"abandon_step"` 及 `reason`。
驾驶员的 PLAN 提供 `reason` 和 `--allow-abandon`，不需要答案文件。

允许的 `pending` 为 `reproduce`、`diagnose`、`observation_reproduce`、`observation_diagnose`、
`test_author`、`red_test`、`baseline`、`repair`、`regression`、`retrospective`、`walkthrough`、
`post_review_regression`、`revision_test_author`、`revision_test_check`、`revision_repair`、
`revision_regression`、`revision_retrospective`、`revision_walkthrough`、`revision_post_review_regression`。
`cause_review`、`final_review`、`revision_final_review`、`learning_writeback`、
`revision_learning_writeback`、`handoff`、`revision_handoff` 一律拒绝本操作，返回 `fix_abandon_unavailable`。
第一轮最终审查的既有人工续审仍是其唯一出口；原因审查与第二轮最终审查见下节 `abandon_review`。

放弃追加 `fix-abandoned-N` 记录和 `abandon` 日志；记录绑定旧 intent 摘要，`status.abandoned` 显示步骤、原因和时间。
重做回到原待执行阶段，intent/result 用 `-retry-N-` ID；红灯输出加 `-retry-N.md`，旧记录和输出保留。
`advance`/`run` 不自行放弃，放弃不跳过原阶段的校验、授权和独立审查。

## cm-fix 原因审查与第二轮最终审查的一次性放弃重审

原因审查或第二轮最终审查已登记但没有审查结论（宿主中途被杀、超时、断连或取消）时，`status.stage=unknown`
并带 `reviewAbandonable:"cause_review"|"revision_final_review"`。宿主确认旧审查进程已退出后，以专用的 `--allow-abandon-review`
（不是 `--allow-abandon`；QA-fix 父宿主为 `--allow-qa-fix-abandon-review`，经 `fix_action` 的 `fixOperation:"abandon_review"`；
父运行自己的 `--allow-abandon-review` 不会传给子运行）发送
`{"requestId":"abandon-review-1","operation":"abandon_review","reason":"具体原因"}`，原因规则同 `abandon_step`。
每个运行可放弃一次原因审查、一次第二轮最终审查，与 cm-ai 的 `abandon_review` 对应；同一种审查重审仍无结论返回
`fix_review_abandon_budget_exhausted`。

放弃记录 `fix-cause-abandoned` / `fix-revision-final-abandoned` 绑定原 invocationId、登记摘要、已知线程及无结论结果的摘要，
写 `abandon` 日志，回到待审阶段；回放逐项核对这些绑定。重审需原审查权限与一次新授权，使用
`fix-cause-retry-*` / `fix-revision-final-retry-*` 记录，审查线程不能复用被放弃的线程。
子运行身份仍由 qaSource 固定，所以这是恢复原子运行的途径，不需要也不能新建同源子运行。

审查等待改用审查配置 `timeoutMs`（默认 900000 毫秒，同时交给 worker），不再用复现命令超时；
原因审查到时追加 `transport_timeout` 结果而不是停在无记录状态。

## cm-fix 最终 Review 未知结果的人工续审

attempt 1 的最终 Review 已登记、已记录实际线程但结果为 unknown 时，可以在原任务中人工续审。
首次续审沿用原一次授权；此后每次续审必须新增绑定最新未知调用的启动授权，不能沿用旧权限无限重试。
无已知线程、已取消、已有完整 verdict、业务 attempt 2 的 Review 未知或内容漂移均不能使用。
宿主先确认旧调用已停止、展示原 invocationId/packageDigest 和本次原因并取得明确授权；不能从超时、模型建议或启动旧参数推断同意。
`previousInvocationStopped:true` 是受信宿主对此事实的确认，不是 JS 自动检测进程退出。

在原 `cm-fix-host.mjs serve --mode resume` 参数中追加 `--allow-final-review-recovery`，发送：

```json
{"requestId":"recover-review","operation":"recover_final_review","invocationId":"原调用ID","packageDigest":"原审查包SHA256","previousInvocationStopped":true,"reason":"用户批准一次续审；旧调用已停止"}
```

字段必须取自最新执行记录，不能生成替代值。此操作只写一条绑定授权记录、重核当前内容并回到待审，不调用 provider。
再次 `final_review` 必须同时有本次授权的 `--allow-final-review-recovery` 和 `--allow-final-review`，重启后也如此。
新调用及实际线程必须与旧调用不同；原 attempt、红测、修复、Learning、handoff 和未知调用历史不改写。
内容漂移、审批不匹配或重复消费同一次授权立即停止。成功结果仍通过 `publish_review → check_n5 → post_review_regression → walkthrough → finish` 原门禁；没有第二条完成路径。

若续审也返回 unknown，先用原 `status` 获取 `finalReviewInvocation`。宿主核对旧调用停止、当前包未变并取得用户新的**一次调用**批准后，在新启动参数中追加：

```text
--allow-final-review-recovery --final-review-recovery-invocation 最新未知调用的invocationId
```

之后仍发送上面的 `recover_final_review`，其中 invocationId/packageDigest 必须换成最新记录。
该绑定只授权紧接着的一次续审；再次失败不能复用它。准备后重启执行 `final_review` 也必须携带同一绑定及 `--allow-final-review`。
每次追加授权/登记/结果，旧记录不改写，原 task/attempt、修复、测试和handoff不重做。续审不得复用任何早先最终审查线程；业务修正轮次原有线程排除规则保持不变。
首轮旧记录无需迁移；新增续审轮次只区分调用，不增加业务修复轮次。读取 status 或持久授权记录不等于取得本次启动权限。

## cm-fix 进度摘要

原 `status` 响应新增 `progress`，保留原状态字段：

- `completed`：已有记录支持的里程碑；`evidenceScope=recorded_history_not_fresh_execution`，不是重新执行或当前源码验证。
- `current`、`blocker`、`nextAction`、`requiresUser`：当前阶段、阻断及下一动作；已具备启动权限的待审状态不会重复要求人工确认。
- `remaining`：当前正常路径上的剩余阶段；未覆盖/未知分支返回 null，不猜百分比或后续修正次数。
- `finished`：只有原 owner 当前 stage=completed 且 completionEligible=true 才为 true；历史通过或审查approved不能替代完成门禁。
- `executionActive` 只反映当前宿主内存中的在途操作，不写入历史；在途时摘要显示等待，不将暂时unknown误报为需要续审。
- 未知最终审查时的 `recovery` 仅给出绑定值、已准备续审次数及是否需要新绑定；`authorizationGranted=false`，不自动续审、不证明旧进程停止。

摘要由 JS 从原状态计算，不新增数据库、模型调用、LangGraph依赖或云追踪。其他工作流入口未在本次批量改造。
这项恢复实现和离线验证不代表真实 Review 已成功，也不自动扩大之前“最多一次调用、失败不重试”的授权。

## cm-idea 当前会话访谈

普通访谈无需提前选保存根。用户中途决定保存时，draft_ready可发送 `{"requestId":"prepare-save","operation":"prepare_save","saveRoot":"规范绝对Git根或cwd"}`；仅绑定根、无写入，同一会话不允许换根。随后finish仍需当前用户对精确path/content确认，不用重启或重新生成草稿。普通Skill的references/js-host.md已接此默认顺序。

保存前按原访谈合同由宿主探测Git根（无Git取cwd），只有本次有保存意图才在启动参数追加 `--save-root "{规范绝对根目录}"`。普通访谈不探测保存目录。draft_ready时发送 `{"requestId":"save-1","operation":"finish","filename":"prd-product.md"}`；文件名只接受ASCII字母/数字起始及点、下划线、连字符的.md名。目标固定为该根的prd子目录，不跟随符号链接、不覆盖同名文件。

宿主处理idea_confirm_save，向当前用户展示payload.path完整路径和content，等待真实明确决定，沿原信封只返回 `{"decision":"approved"}` 或 `{"decision":"rejected"}`。启动参数与模型建议不替代用户确认，JS字段检查也不证明对话真实发生。拒绝保持draft_ready；批准后才创建prd目录和0600文件，并复用不可覆盖文件发布/精确回读；仅saved后报告真实路径。冲突或异常停止，save_unknown不盲重试或删文件。此处复用的是低层文件写入器，不生成审查凭证，也不执行cm-prd或开发。

启动 `node "{CM_WORKFLOW_ROOT}/scripts/cm-idea-host.mjs" serve --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-idea"`。收到host_ready，发送 `{"requestId":"idea-1","operation":"start","text":"用户实际点子"}`；宿主处理idea_interview，先读payload.reference及匹配领域包，输出前对照原example-prd。原访谈规则仍是事实源，不联网、不写文件、不探测保存目录、不代跑cm-prd或开发。

沿原host_result信封返回question（status/question/productType）、draft（status/content/maturity/productType/followup）或blocked（status/reason）。question正文遵守一次一题；JS只校验字段，不证明语义上只问一题或草稿质量。productType为A–E，尚不确定时question可为null；首稿必须L1。awaiting_user/draft_ready后，以 `{"requestId":"idea-2","operation":"advance","text":"用户实际回答或修改要求","maturity":"L1"}` 继续；用户明确加深后再传L2/L3，不得把模型偏好写成用户要求。

JS保留逐轮输入/输出和最近草稿，沿原status/cancel/host_close处理查询与取消。会话上下文上限256 KiB，单消息仍受共享64 KiB限制，超限不截断伪造上下文。默认没有保存或任务完成权限；保存需上文单独启用及确认。普通Skill已接入访谈和保存；需跨会话继续时，经明确私有记录许可加--session-file（详见skills/cm-idea/references/js-host.md）。同一文件/工作目录恢复问答、草稿、成熟度和保存根；pending只消费原返回，unknown不重调，cancel不复活，写入未知不凭同字节认领。未启用仍是关闭即失去内存的兼容模式，旧无记录对话不可恢复。宿主字段通过不等于真实访谈已验收。

## 初始化草稿被退回后修正

同一会话停在 verification_blocked、review_changes_requested 或 review_blocked 时，宿主处理具体意见后发送 `{"requestId":"revision-1","operation":"prepare_revision","documents":[{"path":"原目标路径","content":"修正后的完整正文"}]}`。documents 必须提供原完整路径集合，不新增或删除目标；示例只展示一项，实际须全部提供。原文件漂移或结构核验失败会拒绝修正，不覆盖磁盘。

接受后回到 draft_generated，继续原 advance 核验、必要的用户确认与新独立审查。旧核验/确认/审查不再是当前批准，revisionHistory保留上一轮记录并进入新审查包；不重跑项目分析或模型生成。该操作由宿主明确发起，不自动循环重试；用户已拒绝、取消、已批准或已开始写入的状态不接受此操作。启用显式私有会话记录时可恢复未归档草稿及退回历史；默认内存模式仍不能恢复；修正不授予写入或任务完成权限。

## 初始化首次分析

在普通 cm-init-host serve 会话 ready 时发送 `{"requestId":"analyze-1","operation":"start"}`，宿主处理 init_analyze：根目录 observations 仅为线索，须读取实际语言清单、子项目、README、CI、配置及已有规则，按项目证据分析命令、模块和版本控制。不执行未经授权的命令，不建 Git、不安装、不写规则或调用额外 provider。

沿原 host_result 返回 `{"status":"analyzed","selection":{"versionControl":"none","modules":[],"analysis":"实际分析"},"evidence":"实际依据与覆盖范围","noGitDecision":"explicit_user_refusal"}`；none 仅能在用户明确拒绝 Git 后使用，remote/local 的 noGitDecision 为 null，不能伪造用户决定。需要先建 Git 时停止交由另行授权的动作，完成后重新分析；证据不足返回 `{"status":"blocked","reason":"具体缺口"}`。

analysis_ready 后发送无 selection 的 advance，生成使用同一选择，并在新审查包保留 analysisResult。JS复查根目录观察是否变化，但不证明完整源码未变；宿主报告不是运行验证或授权。已有预分析 selection 的 advance 兼容保留，普通Skill已按地图步骤在先、宿主分析在后的顺序接线；地图实际执行仍复用codebase-context，而非新增JS扫描器。analysis_blocked/失败不自动重发；取消沿原会话协议。

## 初始化中断后的只读检查

恢复后的新审查包绑定旧 packageDigest 与本次随机 resumptionId，使“只存档、尚未写文件”的恢复也能保存新的独立审查记录，不与旧档案争用同名文件。此标识仅区分审查材料，不是写入授权或新的任务状态。

需要继续未写部分时，在原 `cm-init-host.mjs serve --skill-dir PATH --project PATH --host-context ID` 启动参数最后追加 `--resume-draft DIGEST`；本次有写入授权才在它之前加 `--allow-write`。载入仅复用旧正文和选择，不复用审查通过或用户确认；有冲突拒绝启动。无冲突的部分草稿从 init_verify 继续，重新核验、必要时确认约束变更及独立审查，再通过原写入分支只派发未匹配正文的目标。已经全部匹配时仅返回 rules_present，不发宿主请求或标记任务完成。旧档案保留；这不是未知调用自动重放，也不自动解决冲突。

已存在写前归档时，可在新进程执行：

```bash
node "${WORKFLOW_ROOT}/scripts/cm-init-entry.mjs" --inspect-recovery <packageDigest> --skill-dir "${WORKFLOW_ROOT}/skills/cm-init" --project "$PROJECT"
```

读取固定 `.reviews/cm-init-<packageDigest>.md`，核对项目、内容摘要、原规则和档案权限，逐文件返回 written/not_written/conflict。总体 matches_reviewed_draft 只表示当前文件匹配草稿，不证明历史调用成功或任务完成；incomplete/conflict 都不自动写入。档案损坏、路径不安全时拒绝读取。输出不含原文；档案仍是私密本地数据而非新的授权。宿主需先核对当前状态，再处理后续授权；受控草稿恢复见上文，未归档状态现可用显式私有会话记录续接，但未知写入不重放。

本入口启动已有 `createCmAiHost` / task runner / store，不是新的任务状态机。
默认 `cm-ai-run.mjs` CLI 仍是无 provider 控制层：可创建、查询、取消并重新打开运行记录；
`advance/start/resume/decision/complete` 等执行请求明确返回 `execution_adapter_required`。
该 control-only 命令不能用于开发业务。源 `skills/cm-ai` 已为明确选择 JS workflow 的
请求接入会话入口指引；未默认替换全部日常流程，安装版本及真实业务验收仍未确认。
另有显式启用的 `cm-ai-host.mjs` 当前会话开发/检查与按轮授权审查接线，见下文；
默认不调用 reviewer，真实 provider 验收仍未完成。

## cm-check：机械与语义检查接线

`cm-check-host.mjs serve --skill-dir PATH --project PATH [--config PATH]`通过共享JSONL通道先请求check_runtime，宿主运行原平台checker一次并保留实际输出/退出码；机械失败停止，通过才请求check_semantic。原八组由当前宿主按原Skill清单检查，JS校验完整覆盖、源/配置摘要和证据路径行号，再汇总PASSED/FAILED/BLOCKED。五项可选增强只列configured/degraded/unknown，不误报为核心失败。

无provider、安装、自动修复、持久化或任务完成权限。原cm-check-entry和sh/ps1机械入口不变，不重复运行机械检查。输出是current_host报告，字段校验不是语义真实性或指定模型运行证明；原平台检查器仍按平台能力降级。详见[宿主接线](../skills/cm-check/references/js-host.md)。

## cm-test：中断执行续接与Git子模块

`cm-test-host.mjs serve --config ABS_JSON --session-dir ABS_PRIVATE_DIR`可显式保留原runId、执行结果及精确源码/输入/日志绑定；默认仍内存运行。新进程status后发送resume，不新开run、不重跑已记录的宿主调用或命令。未决host/command仅接受原实际结果和cleanup证据，未知log/publish写入停人工核对，不盲目重试或推定成功。取消持久、源文件/配置/用例/原日志漂移阻断，报告仍不可覆盖；原inspect继续只读历史，不变成执行入口。详见[cm-test宿主引用](../skills/cm-test/references/js-host.md#中断执行续接)。

源码快照现支持已初始化Git子模块递归内容、HEAD、index与工作区状态，并允许sources引用子模块文件；未初始化/冲突/别名或超限阻断，不自动init/update/fetch。临时本地Git夹具证明脏内容和HEAD变化可检出，不代替真实项目验收。恢复不授予provider、安装、修复或Git交付权限，历史结果不代表当前源码重新执行通过。

## cm-init：未归档会话恢复

启动`cm-init-host.mjs serve`时末尾可追加`--session-file ABS_JSON`，经用户明确许可将分析、草稿、核验/确认、修正历史与原调用结果写入0600私有文件；默认仍是内存模式。新进程绑定同一项目、Skill与模板，status后从原stage继续；在途操作用resume，recorded只消费原结果，unknown须原宿主实际输出及callId/requestDigest/evidence，不重发调用。显式取消保留，原结果未应用成功不丢弃。

已有目标仍沿原核验器回读，不冒称全源码快照；历史检查及确认不是本次重新验真。新作者身份保留到自审排除集合，恢复不继承`--allow-write`。已进入写入的未知状态停止，用原已审档案核对，不从同字节推定调用成功；两种恢复启动选项不可混用。详细信封见[cm-init宿主引用](../skills/cm-init/references/js-host.md#中断后恢复)。旧版未记录内容无法凭空恢复。

## cm-init：项目分析输入与业务地图选择

`cm-init` step 1 先调用同一 entry 的 `--analyze-project`（其余参数同下），读取 `projectAnalysis`。它列出根目录、项目清单、选定配置路径和根级指令文件；Node package 额外提供脚本名称、依赖名称及清单摘要，不输出脚本正文或依赖值，不运行配置或脚本。`commandEvidence: manifest_declaration_only` 不是执行通过，缺少脚本时也不编造默认 build/test 命令。

该观察不是递归项目分析：非 Node 清单、子项目、CI 和已有 `.claude/` 内容仍须宿主补读，链接明确列为未覆盖。技术栈和模块判断、版本控制检测、保守规则生成及写前核验仍在后续迁移范围。无写入或外发授权。

`cm-init` 的 step 1.5 已消费只读 JS 观察，不再由对话凭文件数量印象决定扫描模式：

```bash
node scripts/cm-init-entry.mjs --inspect-project \
  --skill-dir /absolute/cm-workflow/skills/cm-init --project /absolute/project
```

查看 `projectScan.action`、`reason` 和 `observations`：缺少 codebase-context Skill 时先跳过、不遍历项目；无清单且无源码目录时跳过；已有业务地图时增量；无地图且源文件超过 30 个时全量，否则跳过。观察到符号链接则返回 `blocked/project_inventory_incomplete`，不跟随它们；超过 10000 个目录项或读取失败则报错，不声称已完成判定。缺 Skill 时未观察的文件数及地图状态为 null。

该操作只读文件名和类型，不读取源码内容、不执行扫描器、不写业务地图或项目规则。`full/incremental` 仍由原 codebase-context 流程执行；原空项目准入及默认 CLI 行为不变。项目技术栈分析、规则生成、已有约束保留与写前核验仍是后续迁移范围，不能将这一项视为完整 cm-init JS 化。

### cm-init 宿主草稿生成

原 entry 导出的 `generateCmInitRules(input, selection, host)` 串起原准入、项目观察、现有模板与目标正文读取、一次宿主生成、目标范围核对和已有草稿结构核验。

```javascript
const result = await generateCmInitRules(
  {skillDir: '/absolute/cm-workflow/skills/cm-init', project: '/absolute/project'},
  {versionControl: 'local', modules: ['frontend'], analysis: '宿主完成的项目分析与证据说明'},
  {generate: async (request, signal) => ({status: 'generated', documents: await hostDraft(request, signal)}), signal}
);
```

这是受信进程内接口，`hostDraft` 由宿主提供，不是仓库内置模型调用；CLI JSON 不可指定模块、执行代码或选择 provider。`modules` 只接受 frontend/miniprogram/backend-api/database/smart-contract/finance；固定保留 coding-style/testing/security，remote/local 增加 git-workflow，none 不生成它。版本控制和模块选择是宿主输入，不代表 JS 已独立验证 Git 状态或分析语义。

生成请求含选中模板及两个入口、选中 rules 的原有正文，供保守合并；缺模板标 `fallbackRequired`，由原语义流程处理，不安装补全。回调失败不重试；返回 `blocked` 即停止；候选必须精确匹配本次目标。生成期间这些已有目标内容变化则拒绝旧草稿，不覆盖变化。回调必须受宿主既有权限约束，接口不是回调代码的文件系统沙箱，也不授权本地正文外发。

结果 `draft_generated` 含 documents 和既有 inspection，不代表生成质量通过或允许写入。独立语义审查、用户约束改写确认、完整命令/glob/引用核验和受控写入仍需继续。

普通 Skill step2 现已通过 `references/js-host.md` 接入 `cm-init-host.mjs serve --skill-dir PATH --project PATH`。它复用现有JSONL session/bridge，使用 init_generate、init_verify、init_confirm 和 init_review 请求；当前会话生成正文，无内置provider。一次会话最多一次分析和生成；明确提交修正版后重新核验、必要确认和独立审查，支持status/cancel/host_close；结果64 KiB共享上限保持不变，超限/断开/失败不自动重发。未归档阶段默认内存，可显式启用私有会话记录；已归档草稿可按上文恢复，不代表任务完成。真实CLI合成宿主生成/取消已验证，不等于已安装Skill或真实项目验收。

生成后再发送不带selection的advance，宿主按原合同逐项核验命令、globs、文件引用、原约束保留与规则适用性。JS绑定当前草稿，核验前后回读目标文件；接收五类checks的status/evidence和constraintChanges。未验证/失败停verification_blocked，约束变化停confirmation_required，其余停review_required。报告明确标current_host_report，既不是独立Review，也不是所有业务源码未变的证明；受控写入见下文单独授权入口。未验证项补证据或修正后可按上文prepare_revision继续，不静默放行或重新生成。

约束改写确认也已接入：confirmation_required时再advance，init_confirm携带绑定草稿的原/新约束正文，请受信宿主实际询问当前用户，仅接受该请求的approved/rejected。批准只转review_required，拒绝停止，确认前后目标变化拒绝。记录是current_host_user_decision，不是独立审查、调用grant或写入许可；JS依赖宿主真实转交用户决定，不能自行验证实际用户交互。受控写入见下文；阻断恢复仍未完成。

到达review_required后，可发送 `{"requestId":"review-package-1","operation":"final_review_package"}` 读取审查材料。包包含固定草稿、原规则正文和原始字节摘要、宿主分析选择、核验报告、已有确认与精确文件清单，并给出整个包的packageDigest。读取前后核对原目标，包内每份原文的实际字节摘要也须匹配原基线；无变化时重复读取一致。它是cm-init-draft-review-package，不是V3登记凭证，不派发reviewer、不消费审查、不写入。独立reviewer须审查完整材料，而非仅接受host报告；独立审查结果现由下文宿主入口转交，写入见下文单独授权入口。

原规则无法无损表示为UTF-8时，审查包读取明确拒绝，不以替换字符冒充原正文，也不改写源文件。

独立审查转交：启动追加 `--host-context` 绑定实际作者上下文；未提供仍可生成/核验/查看审查包，但不能推进审查。review_required时advance发init_review，由受信宿主实际派独立reviewer并核对真实工具返回，再原样转交reviewer/contextId/independent/at/result。JS拒绝同作者上下文，复用原reviewResultForPaths核对摘要、完整覆盖和findings一致性。批准只reviewed_draft，修改意见/阻断分别停止；记录current_host_review_attestation，不是V3登记receipt，也不授权写入/完成。宿主证明和字符串检查不能互相替代；不得把合成测试当真实执行证据，不得无授权调用外部provider。写入已通过下文单独授权入口接线，写前审查材料归档见下文，阻断恢复仍未完成。

受控写入需在 --host-context ID 后另加 --allow-write；只在reviewed_draft且原目标未变化时，advance才发init_write给当前主执行宿主。只编辑固定已审documents，宿主逐份写前核对expected并使用现有安全编辑工具，JS写后逐目标回读摘要。宿主written且全部一致才rules_written，否则write_incomplete；异常/断开/取消保留write_unknown及尽可能获取的实际文件状态，不自动重发或回滚。此机制不是文件系统沙箱，不验证宿主全部范围外副作用，也不是跨文件原子事务。init_write之前先保存私有不可覆盖档案 `.reviews/cm-init-<packageDigest>.md`，包含原规则、草稿、核验/确认和宿主转交的审查记录；文件0600、最多256 KiB，冲突/不安全路径/超限会阻止规则写入。档案不是写入结果、V3 receipt或任务完成凭证，含项目私密内容，不得未经授权提交或外发。未启用私有会话记录时状态/写入结果仅内存；未知写入仍按上文从档案重新核验草稿；不自动重放未知调用；rules_written不勾任务、不写运行完成日志、不声称完整初始化验收。默认启动及已有生成/核验功能不获得写权限。

### cm-init 候选规则写前结构核验

宿主按原模板生成候选正文后，可将 JSON 数组 `[{"path":"AGENTS.md","content":"..."}, ...]` 通过 stdin 送入 `cm-init-entry.mjs --inspect-draft`，其余 `--skill-dir` / `--project` 参数同上；输入总量最多 1 MiB。必须包含 AGENTS.md 和 .claude/CLAUDE.md，只允许这两个入口与原十类规则文件，不接受 settings.json 或任意业务代码路径。

读取 `draftInspection`：列出 create/modify/unchanged、前后摘要、兼容入口150行检查与独立行 `@rules/xxx.md` 引用检查。引用可指向同批候选或已有普通规则文件；链接及多硬链接目标拒绝。`existingChangeReviewRequired` 列出需要检查是否改写用户约束的现有文件，不能仅凭追加文字或摘要相同之外的启发式判断约束被保留。

`structurally_checked` 不是批准，更不是写入许可：`remainingChecks` 仍列出语义约束、命令和globs、其他文件引用、规则适用性及版本控制、独立审查、写前重新核对磁盘。该命令不保存候选、不生成规则正文、不写项目。现有 Skill 的原写前核验和人工确认要求不变；草稿生成已通过上文宿主入口接线，核验与单独授权写入均已有宿主接线，但不等于真实项目完整验收。

## 当前支持

- runner要求Node 24.14+，存储/runner准入实现允许macOS/Linux；本轮本机验证为macOS，Linux/WSL2尚缺目标环境实测，Claude隔离preflight仍限macOS。原生Windows runner仍不支持，安装器支持不等于runner支持。
- 配置要求已批准 specs 和当前选中任务。控制层与受信宿主 runner 可绑定代码根下的 specs
  子目录；代码根等于 specs 根或位于 specs 内仍拒绝。旧分根记录不变。
- specs 子目录由任务 owner 绑定，不是通用忽略目录；不进入业务 scope/requirements 或代码快照，
  恢复及完成门禁核对同一边界。宿主仍负责该目录的所有写入。
- 内置 Codex 开发 factory 不传 specsRoot 时仍使用整根 workspace-write，同仓 specs 返回
  `nested_specs_protection_required`；显式传入绑定当前 specs 的受保护 factory 见下方“受信宿主执行组装”。
  当前会话直接写文件的入口不因此获得物理隔离，也不自动切换为外部开发调用。
- 代码根支持常规 `.git` 目录或 worktree 的普通 `.git` 文件；快照不读取或跟随该元数据，
  `.git` 仍不得进入任务 scope/requirements，符号链接与多硬链接文件仍拒绝。这不是 Git 写入隔离。
- 新任务使用 V2 代码基线：现有扫描边界内的每个文件都记录路径、权限、大小和 SHA-256；
  仅 scope、requirements 及 AGENTS.md 保存正文。范围外图片或视频也逐块计算摘要，新增、删除、
  改名、改权限和正文变化仍阻断审查。正文保持每文件 1 MiB、合计 2 MiB、最多 256 文件；
  摘要清单最多 10,000 文件、累计扫描 1 GiB，序列化基线最多 8 MiB，超限明确失败。
  宿主现有单条持久记录 1 MiB 等门限仍适用；这不是任意规模仓库保证。
  已保存 V1 基线继续按原格式、容量和摘要核验，不迁移或重写历史审查凭据。
- 不读取凭证，不加载任意 JS 模块，不接受 shell command、host grant 或自报审批字段。
- 已有 tasks.md、Review 和 Learning 文件不被控制入口直接修改；`serve` 会创建运行控制记录与锁。
- 同一配置及 runId 才能 `resume`；运行身份和配置固定。此阶段记录是明确的 control-only 运行，
  不得把它的无执行记录当作真实开发证据；后续执行适配器上线使用不同 runId，旧记录保留可读。
- 配置指纹按规范化内容计算，JSON 对象字段换序不影响恢复。初始化前验证 review baseline；
  若异常退出只留下匹配的空 store，恢复时重新核对任务准入与 baseline 后完成初始化，不删除历史。

## 启动

### 多代码目录：同一个任务统一收口

需要 CoreSimulatorService、模拟器、真机、Xcode UI tests 或 Keychain 等系统服务的项目，应采用分离的 specs 根与代码根，并由具备系统访问能力的当前会话宿主在 Codex 沙箱外执行检查。单靠 `codeProjects` 多代码根配置或同仓受保护模式不能改变检查进程的沙箱：模拟器会不可用、UI tests 无法启动，SwiftPM 的 `swift build` 可能要求 `--disable-sandbox`。若宿主仍在沙箱内，就应报告环境阻断，不把失败写成通过。配置检查时将构建产物放在代码根外，例如给 `xcodebuild -derivedDataPath` 指定外部目录，避免触发 `check_output_out_of_scope`（详见下文检查产物说明）。

单任务定义或batch定义可增加`codeProjects:["{WORKSPACE}/frontend","{WORKSPACE}/backend"]`。
`codeProject`是明确选择的共同工作区根，不创建挂载或搬移目录；每个代码根必须是真实已存在、互不重叠的子目录。
scope/requirements使用相对工作区的前缀路径（如`frontend/src/view.mjs`），不得选择未声明的兄弟目录。
使用`--protected-conversation-config`；每个checkCommands条目增加`codeProject`指定上述某一个规范根，
每个声明根至少有一条已授权检查。QA commands同样增加codeProject，其他caseIds/命令合同不变。
编辑提案保留前缀路径，由固定适配器映射回每个根的本地scope；检查在各自cwd的原沙箱串行执行。
一次任务的所有根共用原身份、审查包、handoff、Review与完成门禁；根路径/配置/材料漂移不能沿旧证据冒充完成。
只快照声明根及适用上级AGENTS，不扫描无关兄弟项目；各根AGENTS进入审查材料，开发请求显式携带各根指令。
工作区级Learning写回仍由原owner处理，不借此开放子项目指令写权限。不是跨项目DAG、自动合并或额外完成路径。

### bootstrap feature：骨架与项目规范

原批准`0.bootstrap`继续使用；若不存在，则接受唯一一个数字前缀且slug恰为`bootstrap`的已批准feature（如`1.bootstrap`）。多个候选一律以`bootstrap_feature_ambiguous`拒绝。先T-001骨架、再原规范生成任务（通常T-002）。单任务增加
`--bootstrap-config PATH --allow-bootstrap-write`，配置为`{selection:null}`（骨架），或
`{selection:{versionControl,modules,analysis}}`（原cm-init规范选择）。批次用可选`bootstraps`映射，
键为实际bootstrap feature的`<feature>/T-001`等，值为同样配置，并显式传`--allow-bootstrap-write`；原逐task Review授权不变。
空项目可用`requirements:[]`，但必须绑定真实bootstrap factory；原requirements/design从已批准specs读取并进入审查包，
不在代码根生成假需求文件。普通任务仍要求代码需求材料，不能用空数组跳过审查。
规范任务scope须列完整固定目标：`AGENTS.md`、`.claude/CLAUDE.md`、原选择对应的`.claude/rules/`文件，
其余业务scope单独交原developer；指令由宿主复用init_generate/init_verify与受控写入，不交普通developer修改。
init_generate返回原`{status,documents}`；init_verify逐组核验并返回`{checks,constraintChanges,application,retrospective}`，
checks为commands/globs/file_references/constraint_preservation/rule_applicability，各含status/evidence。
constraintChanges必须空；application/retrospective沿原Learning字段。此核验不是独立Review，仍走原N4/N5。
单任务驾驶员覆盖T-001骨架和纯规范scope、单代码根、非`--protected-config`的T-002规范任务及其第2轮修订：`init_generate`读取启动前校验的`answers/init-generate.json`（第2轮只读`init-generate-a2.json`），`init_verify`的globs/file_references/constraint_preservation/rule_applicability四组与Learning读取会话核对后写的`init-verify.json`（第2轮`init-verify-a2.json`），commands组只由驾驶员在宿主接受启动（`host_ready`，宿主已完成全部启动核对）后、发送操作前于代码根实跑该文件列出的草稿命令得出（此前还用宿主自己的读取器与admission函数核对写入授权、配置文件、任务选择与bootstrap nextTask；受保护模式与宿主检查同用specs沙箱；未通过或改动了预检核对过的规范目标、运行定义、权限文件或bootstrap规格即退出2且不发送操作，create时运行停在只有init记录的ready，改用resume重跑），答案文件不能提供commands结果；修订答案须在读取首轮findings后编写，规范任务的advance不能带`--allow-review-attempt 1`跨进第2轮。续跑（第2轮或检查失败后的同轮重试）时目标文件须与运行存档记录的上次写入一致，宿主同轮重试以本轮已记录的规范证据为起点。含业务scope、`codeProjects`多根或provider开发的规范任务仍启动前退出2，需要当前AI会话直接保持`cm-ai-host.mjs serve`的交互进程依实际`host_request`应答；批次驾驶员没有此runner，预检退出2。详见[单步驾驶员](../skills/cm-ai/references/js-host.md#bootstrap-规范任务用单步驾驶员)与[当前会话宿主路径](../skills/cm-ai/references/js-host.md#bootstrap-规范任务的当前会话宿主路径)。
规则读回及证据进入同一原develop记录与handoff，然后Review，完成后N7重载。若T-001 Learning已写入AGENTS.md，规范草稿须保留其他既有约束原文；宿主把既有`## 项目教训`段按原字节合入最终草稿，再核验、写入并交独立Review。草稿修改既有教训或遗漏其他既有内容时阻断。已有用户规则冲突、未知写入或材料漂移不覆盖不重派；
缺当前写许可在派发前阻断，补许可只能沿原run恢复。此开关不授权Git初始化、安装、网络或额外provider。

配置示意（绝对路径替换为已批准的隔离目标）：

```json
{
  "version": 1,
  "specsDir": "/absolute/specs",
  "codeProject": "/absolute/code",
  "feature": "1.login",
  "identity": {"repositoryId":"project","runId":"control-1","taskId":"T-001","attempt":1},
  "scope": ["src/login.js"],
  "requirements": ["requirements.md"]
}
```

scope 和 requirements 是相对代码根的已有 runner 输入，不是额外写入授权。
键必须恰好如示例，不得任意新增字段（已声明的多代码根模式允许 `codeProjects`，显式任务选择允许生成器写入 `taskSelection`，显式批次选择允许写入 `featureSelection`）；定义参与摘要绑定，擅加字段会使同一次 run 的摘要漂移并导致 resume 失败。
用准入生成器产出定义（`--scope` 必填，填写相对代码根、逗号分隔的允许修改文件；`--requirements` 可选，省略时为空数组）：`node scripts/cm-ai-admission.mjs --specs-dir /absolute/specs --code-project /absolute/code --print-run-definition --scope src/login.js --requirements requirements.md > run.json`。需要选择当前 `nextTask` 以外的任务时加 `--task T-xxx`；只能选择同 feature、依赖已满足的 `eligibleTasks`。生成的可选 `taskSelection` 随定义进入持久配置与指纹；不加参数的旧定义及恢复指纹不变。
`--task` 的依赖判定与 `nextTask` 相同：前置任务已勾选完成或标记 DROPPED 即视为满足。选择不成立时返回 `task_selection_mismatch` 并在 `reason` 写明原因（依赖未完成、已完成、已 DROPPED、不存在或不在当前 feature）；运行定义未写 `taskSelection` 却不是 `nextTask` 时也会提示用 `--task` 重新生成。

**显式选择批次（feature）**：默认仍选编号最小、有待办任务的 feature。已批准的跨 feature 顺序要求先做后面的批次时（例如 tasks.md「跨批责任」写明先做 6 再回到 5），显式选择：
`cm-ai-admission.mjs ... --feature 6.api-native-reading --print-run-definition --scope ...` 生成带 `featureSelection: {version:1, feature}` 的运行定义；或对已有运行定义给 `cm-ai-host.mjs serve` 加 `--feature 6.api-native-reading`（须与 `feature` 一致，效果同写入该字段）。
显式选择只改变「选哪个 feature」：全部规格批准、manifest 一致、bootstrap、测试合同照常校验；所选 feature 内的任务依赖照常判定（`--task` 仍只接受依赖已满足的任务）；更早 feature 的待办任务原样保留，不改 tasks.md。
所选 feature 已无待办任务时，准入返回 `requestedFeatureComplete` 和明确 warning（项目其他 feature 仍有待办时 `state` 为 ready、`nextTask` 是项目自己的下一任务；全部完成时为 complete），`--print-run-definition` 一律以 `feature_tasks_terminal` 退出 1，宿主建运行一律以 `task_selection_mismatch` 拒绝并写明「已无待办任务」，不会为其他 feature 生成定义或建运行；名称不存在时为 `feature_selection_invalid`。所选批次最后一个任务完成后，该运行的上下文刷新仍包含它自己的规格。单步驾驶员 `cm-ai-drive.mjs` 的 `PLAN.permissions` 可写 `--feature N.slug`、`--review-runtime claude`，原样转发给宿主，驾驶员预检也按同一有效定义计算。
`featureSelection` 进入运行定义与恢复指纹：用 `--feature` 创建的运行恢复时也要带 `--feature`（或改用写入该字段的运行定义）；运行内的上下文刷新、Learning 输入、文档同步的末任务判断与 QA 跳过判断都按所选 feature 读准入。未显式选择的运行（含 0.16.6 项目补丁期间创建的运行）不写该字段，恢复与指纹不变。QA 执行计划与合并判断仍按默认准入，所选批次不是默认批次时不做跨 feature 的 QA 合并。

**当前会话跨工具审查**：普通单任务宿主可用 `--runtime codex --review-runtime claude`（或反过来）让当前会话开发、另一工具审查。两端须与有效 `.cm-workflow.yml` 的 roles/runtimes 一致，否则 `runtime_selection_mismatch`；该选择以 `reviewRuntime` 写入运行配置与指纹，恢复必须带同一选项。审查配置的 preflight 须由审查端生成（`preflight --runtime claude`）。不能与 `--protected-config`、`--external-models` 同用（它们按 roles 自行选审查端）。此选项不授权真实审查调用，按轮审查授权不变。

`tasks.md` 的任务行只有一套语法（`runtime/js/spec-task-line.mjs`），准入、cm-prd 自检与变更守卫、N5 勾选、审批 manifest 的完成标记归一化和 failover 都用它：列表项 + 复选框，任意缩进，可选 `~~`，任务号后接英文冒号、全角冒号或空白，例如 `- [ ] T-003: 描述`、`- [ ] T-003 描述`、`- [ ] T-003：描述`、嵌套的 `    - [ ] T-003: 描述`。``` / ~~~ 围栏内的行是示例，不是任务。全角冒号选择接受而非拒绝：中文输入法常打出它，failover 早已接受，拒绝它只会逼用户为标点改规格再批准。语法随批准绑定：本版本写入的批准在 `.cm-specs-status` 记 `taskGrammar: 2`；更早记录的批准继续用原解析器（准入、规格材料、N5 勾选、supersede 与 failover 都按旧规则读），例如同文件里未加围栏的 `- [ ] T-001：示例` 在旧批准下仍是说明而不是重复任务，已批准的字节含义不变；重新批准后才切换到新语法。重新批准会让全部 feature（包括本次没改的）改用新语法，因此 `--approve` 先按新语法检查每个 feature 的 tasks.md，任一无效（如上例变成重复任务），或从旧语法切换时任何 feature 的任务集合（哪些行是任务、编号、勾选状态）在新旧语法下不一致（如唯一的 `- [ ] T-099：示例` 会变成待办任务），即以 `task_grammar_conflict` 拒绝，`approveReason` 写明文件、行号和原文，提示把这类示例放进围栏或删去后再批准；不会写入 `taskGrammar: 2`，也不退回旧语法——退回会让新写的全角冒号任务行悄悄不算任务。cm-prd 变更守卫读取已批准原文时同样按其批准的语法。状态文件把上次批准的 `taskGrammar` 经 cm-prd 变更与发布一路带到下次批准（重新批准前连续多次 `cm-prd --change` 时，变更守卫按这一携带值读取原文；不带该值的待审状态不会切到新语法）；项目一旦用上新语法就不再做新旧对照，从未批准过的项目首次批准直接用新语法。cm-prd 草稿与自检始终用新语法。旧版本批准的 manifest 按旧归一化规则计算，核验时每行同时接受新旧规则的摘要，因此已批准的规格原样继续匹配（有意的小幅放宽：旧批准下全角冒号或缩进任务行的勾选变化也按运行时标记处理）；只有旧规则下批准时就已勾选的无冒号／缩进任务行，在之后再勾选别的此类任务时仍会漂移，需要重新批准一次（新批准按新规则记录）。

规格待审批时先展示摘要卡并请用户回复“开始”。只识别“开始”“开始吧”“可以开始”“确认开始”“开始执行”“现在开始”“可以，请开始开发”及其尾部标点/空白（整句匹配，“开始开发”“请开始开发”等仍不算）；泛化授权仍是 `not_approval`，提示明确回复“开始”。`--approve` 写入仍须原完整准入门禁。

```bash
node scripts/cm-ai-run.mjs serve --config /absolute/run.json --mode create
# 原配置重开已有控制记录：
node scripts/cm-ai-run.mjs serve --config /absolute/run.json --mode resume
```

stdin 每行一个既有 conversation operation，stdout 每行一个带 requestId 的结果。
只在当前可信宿主进程中使用，不把通道暴露为网络服务或交给 worker 写入。

```json
{"version":1,"operation":"status","requestId":"s1","identity":{"repositoryId":"project","runId":"control-1","taskId":"T-001","attempt":1}}
{"version":1,"operation":"cancel","requestId":"c1","identity":{"repositoryId":"project","runId":"control-1","taskId":"T-001","attempt":1}}
```

底层 JSONL transport 支持一项业务操作运行时处理 status/cancel；第二项业务操作返回
`host_busy`，不排队猜测用户意图。EOF 等待在途结果，不自动转换成用户取消。
SIGTERM 不被转义为用户取消，异常退出由既有 runner 恢复检查处理。
每行最多64KiB；无效输入不调用 host。日志/原始错误不混入 stdout 协议。
响应可能乱序，调用方必须按 requestId 关联。输出背压不阻止继续接收取消请求；
待输出响应最多64项，超限以 `output_backlog_exceeded` 关闭通道，不无限积压。

## 当前会话开发与检查

`cm-ai-host.mjs` 是需要主动启用的工具宿主通道；它复用同一 runner/store，不启动模型。
当前Skill宿主已接单/多根与显式同仓保护，平台与配置边界见“当前支持”；当前会话模式不额外派发开发模型。

单任务 `serve` 可显式加 `--runtime claude`，默认仍为 codex。该选项由受信启动宿主
提供，普通控制请求或开发结果不能更改运行时；它不启动 Claude，不是模型调用授权。
Claude 开发请求与终态保留真实 provider 标签，复用同一开发校验、Learning、runner/store、
检查与工具桥。旧 Codex 配置指纹不变，Claude 配置单独绑定 runtime；恢复不得跨端冒用。
角色日志和 QA 适配参数按所选 runtime 贯通。

Claude 单任务 Review 已接入原 V3：不带审查配置或对应轮次授权时，仍停在原
`awaiting_review / decision_required`。开启审查需 Claude 配置匹配诊断凭证和独立的
`--allow-review-attempt`；错误 provider/指纹在打开 store 前拒绝。不借用 Codex reviewer。
`preflight --config PATH --review-model MODEL --runtime claude` 生成 Claude 配置诊断，
只允许 macOS sandbox-exec 内向单一本机回环端口发送合成请求，使用临时配置目录。
本机服务最多响应一次空 GET/HEAD `/api/hello` 健康检查，消息请求始终拒绝且不转发模型；
凭证只证明工具列表/模型/传输配置，不授权 Review。不支持隔离条件时拒绝运行，禁止手造凭证。
已安装 Claude CLI 的本机诊断已通过：设置 `CLAUDE_CODE_TMPDIR` 到同一受限临时目录，
捕获第一条合规消息请求后主动终止；CLI 仍可能在停止前重发，诊断只接受 1–2 条消息请求，且每条都须通过模型、传输和工具列表检查（空工具列表或唯一的 `StructuredOutput`）。第三条请求或任一不合规请求均失败；结果保留 `message_requests`，并以 `message_requests_expected:'1-2'` 标明范围。
`stopped_by_probe:true` 是诊断主动停止，不是用户取消，也不是 Review 成功。
2026-09-17 已完成 Claude 宿主→Codex 写→Claude 审的真实模型单文件小任务验收一次，凭证为 `reviewer: claude-cli / independent: true / approved`；停在 N6 QA 待决，QA/N8 不在验收范围、仍未验收。换模型或目录须重新诊断。
隔离测试使用合成凭证和合成 Claude 进程，验证 Review→QA→文档核验→原 run_done/恢复，
不证明真实模型或完整双端交付。
批次 CLI 也支持显式 `--runtime claude`，每个子任务继续使用原独立轮次授权；
恢复时更换 runtime 被拒绝。完整 Skill 激活和真实双端 N1–N8 验收仍未完成。
本地合成会话已验证实际文件/检查及断联、取消、恢复；2026-09-17 反向路径 Codex 宿主→Claude 只读提案→宿主沙箱落盘→Codex 审也已完成真实模型单文件小任务验收一次，凭证为 `reviewer: codex-cli / independent: true / approved`，同样停在 N6 QA 待决，QA/N8 不在验收范围、仍未验收。

共享 V3 核心已能按实际登记的 Claude request 校验规范化审查事件、生成 Claude receipt、
发布 `claude-cli` Review 并沿原唯一门禁完成；实时与恢复共用相同 provider 绑定。
`claude-review-adapter.mjs` 复用原审查包/prompt 合同，只转交受信 worker，不自行调用进程。
`worker-claude.mjs` 已接入该 adapter，使用 stdin、除 CLI 内部 `StructuredOutput` 外零工具、单次派发和 POSIX 进程组清理；任何其他工具执行成功即失败并立即 SIGKILL。
审查通过 `--json-schema` 传入去除 `$schema`/`$id` 的结果 schema；该参数改变配置指纹，旧凭证须重跑 preflight。诊断只接受空工具列表或唯一的 `StructuredOutput`。
Windows 明确拒绝此 worker；CLI help 和合成协议验证不证明真实 Claude 进程兼容或物理隔离。

```bash
node scripts/cm-ai-host.mjs serve --config /absolute/run.json --mode create \
  --host-context actual-current-conversation-id --allow-development --review-config /absolute/review.json
```

`--allow-development` 只表示可信启动者已有该配置中开发/本地检查授权，不授予网络、
安装、Git、specs 修改或独立审查调用权限。恢复使用原配置（含创建时的 `--review-config`、`--runtime`、`--workflow-config` 等启动输入）、相同 host-context 和 `--mode resume`。
host-context 必须是真实当前会话身份；宿主将其排除出独立审查候选，而非接受结果自报身份。
通道只能由当前可信会话控制，不能交给开发 worker、暴露为网络服务或从项目文件自动读取回复。

启动先返回 `host_ready`（含本次随机 sessionId）。发送原 `advance` 后，JS 依次发出
`host_request`，包含 `sessionId/callId/requestDigest/kind/payload`：

- `develop`：payload 包含固定业务 scope、需求内容、原 Learning 输入和开发 prompt；
  宿主读取适用指令并用真实工具修改获准文件，再返回原开发输出。
- `check`：payload 包含代码根、任务身份、scope、requirements；宿主实际执行检查，
  返回原检查数组 `[{id,command,outcome,exitCode,evidence}]`，不能用静态判断填通过。
  该数组**就是 host_result 的 `result` 本身**，不套 `{status,value}`——那是 develop 的形状，
  用错会以 `invalid_input` 停在 `reconcile` 且重试无效。审查包另外要求数组非空、且每条
  `outcome` 为 `passed` 并且 `exitCode` 为 0；开发阶段以 `develop_checks_not_passed` 阻断，旧运行在完成阶段仍可能以终态 `checks_not_passed` 阻断：

```json
{"type":"host_result","sessionId":"from-request","callId":"from-request","requestDigest":"from-request","result":[{"id":"test","command":["npm","test"],"outcome":"passed","exitCode":0,"evidence":"实际输出摘要"}]}
```

这两类请求现在附带原配置解析器产生的 `route`（coder / tester）。每次实际角色边界
重新读代码项目配置，并通过原日志写入器记录 `decision/route`；配置错误记录脱敏 error，
不发工具请求。未观察到的适配器记录 degrade，仍只使用已获准的当前会话工具。
`route.model` 是请求别名，不切换当前会话模型、不调用远端、不写未观测 effective_model
或 model_usage。角色 Skill 的业务使用仍由当前会话负责；这不是模型路由全量实装。
旧运行恢复只有真正再次进入角色时才读取/记录，不重发已完成开发或重复历史路由。

开发检查有任一失败或不可用时，在生成审查包前停 `blocked/develop_checks_not_passed`；`reason` 列出失败 id 和证据摘要，`pendingAction: "resume"`。修好环境后在原 run `advance` 重新开发并检查，使用新 effect id，审查轮次不增加。已经审查过失败检查的旧 journal 仍按原历史回放；其完成阶段 `blocked/checks_not_passed` 保持终态，不能重新开发。

已批准任务在完成前会重新执行检查。审查回执及原 `packageDigest` 不改：完成门禁重建代码、scope、需求、指令与 handoff 等非检查字段并逐项比较；检查只比较有序的 `id`、`command`、`outcome`、`exitCode`，视觉检查在结果相同时还比较前后载体，`evidence` 诊断文字可变化。代码、handoff 字节或检查身份漂移会列出差异路径并阻断；检查期间新出现的范围外文件为可重试的 `blocked/completion_package_changed`，移走后在原运行用新的 complete effect id 重试。仅检查结果（`outcome`、`exitCode`）变化记录 `blocked/completion_checks_changed`，不标记完成；失败或不可用时 `reason` 列出检查 id 和证据摘要；视觉检查从 passed 变成 unavailable 时，即使 after 载体按合同变成 null，也先按结果漂移处理。恢复原 runId 后重新执行检查，结果恢复一致时用新的 complete effect id 继续原批准，不重新审查。`advance` 和 `complete` 均可续跑，持久 journal 回放接受该重试状态；旧 journal 与回执保持原格式。重试仍受原 effect 数量上限约束。

回复固定为以下形状；三个绑定值必须逐字取自该次请求，不要自行计算或沿用上次值：

```json
{"type":"host_result","sessionId":"from-request","callId":"from-request","requestDigest":"from-request","result":{"status":"succeeded","value":{"outcome":"implemented","application":{"status":"no_relevant_lesson","note":null},"retrospective":{"status":"no_new_lesson","candidates":[],"reason":null}}}}
```

开发失败为 `{status:"failed",code:"实际失败代码"}`；Learning 有应用/候选时使用请求中的
原结果合同，不谎报无新增。检查的 `result` 是数组，不是上述开发结果。错绑定回复被拒绝，
不会解除当前等待。正常 `status/cancel` 仍可随时发送，JS 一次只发一项工具工作。
开发返回后，原 runner 完成检查、Learning 写回与 handoff 定稿；随后返回
`awaiting_review / decision_required`。

### 交付前验证闸门（可选，`--verification-precheck`）

实测数据：末任务占一个 feature 总耗时约 79%，返工率 80%（其他任务 4%），
而打回理由**全部**是「证据没满足任务书里早就写明的验证要求」，没有一条是代码缺陷。
一轮独立审查要花一到三分钟，返工则要再赔上一整轮开发加审查。

启用后，宿主在收齐任务自身的检查之后、**构建审查包与派发独立审查之前**，
发一个 `verification_precheck` 请求，把该任务 `tasks.md` 里的**任务描述**与**验证要求**原文、
连同本次检查结果一起交给对端，由对端逐条核对本次交付并回答：

```json
{"items":[{"requirement":"记录实现前基线","satisfied":true,"evidence":"npm test tests 42 / pass 42 / fail 0"}]}
```

只要有一条 `satisfied` 为 false，任务停在 `blocked / verification_precheck_failed`，
`pendingAction` 为 `resume`——与 `developer_result_invalid` 同一条重做通道，**不消耗审查轮次**。

**它只能拦，不能放。** 通过闸门不产生审查回执、不授予任何批准、不减少后续的完整独立审查。
这与 `prd_self_check` 的定位一致：机械通过不等于语义通过，不能用自检冒充独立审查。

**为什么描述也要核对**：硬性要求经常写在任务描述里而不是验证要求段，例如
「并核对既有筛选/搜索/编辑/删除不回归」「不修改 `src/todos.js`」。只读验证要求段
等于放过这一半——实跑中末任务正是因此漏做三项回归检查、被独立审查以 P1 打回。
描述里同时混着工作量估计与背景说明，**只核对其中可判定的硬性要求**，取舍交给对端；
两段都没有写时闸门自动让路。

**一条要如实说明的限制**：任务的验证要求在 `tasks.md` 里是自由文本，
**JS 无法机械证明对端把其中每一条都枚举到了**。JS 强制的是：回答的形状、
每条都必须给出非空的证据落点、以及只有全部满足才放行。形状合规不等于语义覆盖。

对端如何核对不受限制：可以一个上下文读完全部要求，也可以一条要求派一个子 agent。
后者的价值不在快，而在每个核对者只看到一条要求与交付物、看不到开发者的推理过程。

任务没写验证要求时闸门自动让路，不自造要求。不启用该开关时，流程与之前逐字节一致。

交接文件 `{SPECS_DIR}/.reviews/{feature}-{任务}-a{轮次}-handoff.json` 以不覆盖方式发布。
撞名时按「这份旧交接有没有被审查用过」分流，判据是同轮次回执 `{feature}-{任务}-r{轮次}.md`
里的 `handoff:` 行是否指名它：

- **字节完全相同**：视为已发布（链接后崩溃的情形），直接成功，不重写文件。
- **内容不同且没有回执指名它**：这份交接属于一个在审查前就死掉的运行，会被归档到
  `.reviews/.superseded/{原文件名}.{内容摘要前16位}`（先硬链接再删除，中途崩溃不丢字节），
  然后发布新交接。归档目录是子目录，不进入 `{feature}-{任务}-r{N}.md` 的证据文件名匹配。
- **内容不同且回执指名它**：这是审查已经消费过的证据，绝不覆盖。新运行在创建 store 和开发前即返回 `handoff_exists`；attempt 1 与 attempt 2 均检查。

此时错误的 `reason` 和宿主 stderr 的 `[host]` 提示先恢复原运行的 QA：配置填错用 `--revise-qa-config PREVIOUS.json --qa-config-revision-reason …`，宿主／环境证据不足用 `--rerun-blocked-qa`。确需重跑任务时，注意 N5 已在 N6 前把任务勾为 `[x]`；先在 `tasks.md` 将该任务改回 `- [ ]`，再在新的 runId 上显式提供 `--supersede-reviewed-evidence --supersede-reason "…"`；原因限单行、500 UTF-8 字节。宿主要求 `tasks.md` 未勾选该任务，所有同 feature、task 的旧 V3 journal 均无在途操作且处于 blocked、cancelled、unknown，或 fixture_completed 且 QA 为 BLOCKED／未结束；pending develop/complete 和尚未加入 host／登记调用的 pending review 先在原 run 用 `abandon_effect` 退出，已登记的 pending review 用 `abandon_review`，不会因新 runId 自动清除。旧 writer 仍被进程持有、正常完成或无旧证据均拒绝 `supersede_unavailable`。新 journal 先追加 `evidence-superseded`，记录旧 runId、文件名、SHA-256 和原因，再归档同名 handoff／回执／具名 correction、QA 文件并写 `supersede` 事件；恢复会按记录幂等补齐。旧 journal 不改写，旧 QA UUID 报告仍留原位供旧日志引用；新运行随后按原名发布自己的证据。未使用旗标的运行维持原 journal 格式和摘要。

不带 supersede 的普通新建也做同样的代码漂移比较：同 feature、task 且未被后续运行替代的 V3 旧运行，其开工基线与当前代码树不一致时返回 `supersede_code_drift`，`reason` 列出旧 runId 与路径，出口是回到旧运行继续、手动还原后新建，或旧运行结束后用 `--supersede-reviewed-evidence --supersede-reason … --accept-superseded-code-drift` 新建（改动记入 `evidence-superseded`），不再把没审过的改动悄悄当成新运行的已有代码。批次成员新建时同样检查（并行成员在各自工作树、根不同，不受影响）；批次没有 supersede 入口，按提示还原文件，或先用单任务 supersede 结束旧运行。旧运行在交接／审查前就结束、没有任何可归档证据时，supersede 照常进行，记录里 `files` 为空、仍列出旧 runId 与接受的漂移。

替代检查还会在任何新持久状态和 `captureReviewBaseline` 之前，只比对尚未被其他旧运行的 `evidence-superseded.previousRunIds` 列出的直接前驱运行的 V2 代码基线与当前代码树的逐文件 SHA-256／存在性（含未选中文件、新增及删除）。更早的运行仍进入新记录的 `previousRunIds` 并照常归档。发现漂移时返回 `supersede_code_drift`，`reason` 与宿主 `[host]` stderr 列出最多 20 个路径及剩余数量：手动还原这些文件后重建运行；或确认保留这些改动时加 `--accept-superseded-code-drift` 重建（这些文件会被当成已有代码，不进新运行的审查改动）。该旗标仅限同时带 `--supersede-reviewed-evidence --supersede-reason` 的 create 请求，不默认启用；接受后 `evidence-superseded` 记录每个漂移路径的当前 SHA-256（删除时为 `null`）及比较的前驱 runId。检测不修改文件，也不读取代码根之外或跟随越界软链接；无法安全读取时即使带旗标也拒绝。旧 journal 没有可用逐文件基线时跳过该运行，不新增记录；这类历史运行无法获得漂移保证。

判据只认回执 **front matter 内**（首个 `---` 到下一个 `---` 之间）的 `handoff:` 行，不按固定行数截取——`handoff:` 之后的 `scope` 列表长度等于该任务的改动文件数，按行数截取会让判定依赖字段顺序。正文里出现的 `handoff:` 不算数。回执缺失视为未被消费；front matter 未闭合、起始不是 `---`、文件非普通文件或为符号链接、超过 256 KiB，一律按「已消费」处理（失败关闭），绝不因为读不懂就去覆盖审查证据。

因此同一任务失败一次后不再需要人工去 `.reviews/` 删文件才能重跑；已批准的交接仍然不可覆盖。

### 任务进行中规格变更并重新批准

运行在创建时绑定本任务的规格材料（任务描述与验证要求、全部验收标准行、设计摘录、本任务测试用例，以及该 feature 规格文件的批准哈希），此后每次开发、审查、完成都重新核对。经 `cm-prd --change` 重新批准后，哪怕只改了别的任务行，哈希也会变。此时 `status` 不再提示会被拒绝的动作：`code` 为 `spec_drift`，`reason` 列出变化的规格文件及出口，`pendingAction` 为 `spec_rebind`（可换绑）或 `none`。

- **只动了别的任务**：可换绑的判据有意从严——requirements.md 与 design.md 必须整份未变（验收标准可能跨多行续写，说明文字也可能是需求）；tasks.md 与 test-cases.json 中只允许其他任务的条目（含续行和子项）、其他任务的依赖行、只点名其他任务的行和其他任务的用例变化。新运行在材料里记录 `taskScopeDigest` 来证明这一点：它覆盖任何位置点名本任务的行（包括其他任务的子项、依赖行和说明）、本任务的整个条目、不点名任何任务的共用说明，以及本任务或点名本任务的用例；只点名其他任务的行和用例不计入；更早版本创建的运行没有该摘要，仍按原材料正常核对，但永远不能换绑。满足时用原配置恢复并显式换绑：`--mode resume --rebind-spec-material --spec-rebind-reason "原因"`（单行，≤500 UTF-8 字节，仅一次性消费、不进指纹）。journal 追加 `specification-rebound`，记录绑定材料摘要、新批准哈希、变化文件、原因与时间；它只能替换材料里的 `sources`，内容不同的材料永远无法换绑。已有开发、审查包与审查结论原样保留，下一步按原流程继续。没有漂移时该参数不写记录。
- **内容变了**（本任务描述／验证、验收标准、设计摘录或本任务用例）：换绑以 `spec_rebind_refused` 拒绝并列出变化项。出口一：还原规格改动并重新批准，本运行即可继续。出口二：`cancel` 本运行，还原本运行改动的代码后用 `--supersede-reviewed-evidence --supersede-reason …` 新建运行，开发者重新交付并重新审查。若改用 `--accept-superseded-code-drift` 保留旧代码，旧改动成为新运行的已有代码，新运行必须交付新的改动才能生成审查包。
- 批次成员不支持换绑：批次打开成员运行时不带该参数，状态不提示 `spec_rebind`，改为说明出口（还原规格改动并重新批准后继续批次，或取消批次、还原代码后用单任务宿主 supersede 重做该任务；并行组成员只有前一个出口，因为空闲时取消批次不会结束成员运行）。新批次（尚无任何成员运行）与单任务 create 一样必须带 `--review-config`，已开始的批次按原启动参数继续。
- 规格处于待审批或与批准清单不一致时，`reason` 提示先完成重新批准。运行执行中途因规格变化停在 `blocked/spec_drift` 时，`reason` 给出 supersede 出口。

宿主请求在协议层被遮蔽成 `host_request_failed` 时同样如此。哪些契约码可以透给对端
是刻意划定的边界——宿主选择暴露的走 blocked 结果带 `reason`，其余统一遮蔽——这条边界
不变；缺的只是被遮蔽的那些错误连运维也看不到。现在会在宿主进程的 stderr 输出：

```json
{"diagnostic":"host_request_failed","operation":"save_draft","code":"prd_review_sections_missing"}
```

`operation` 是对端自己发的操作名。字段取舍、脱敏规则与下述 `execution_error` 诊断一致。
协议回复一个字节未变，写 stderr 抛错也不影响回复。

失败码不在白名单内时会塌缩成 `execution_error`。塌缩的同时，宿主进程的 stderr 会输出
一行结构化诊断，便于定位真实原因：

```json
{"diagnostic":"execution_error","code":"EEXIST","syscall":"link","path":"…","dest":"…"}
```

只输出 `code`、`syscall`、`path`、`dest` 四个具名字段，且每个字段须为 1–1024 字节、
不含控制字符，否则丢弃；一个都没有时输出 `{"diagnostic":"execution_error","detail":"unavailable"}`。
**不输出 `error.message`**——它可能夹带 provider 输出或源码片段。诊断只走 stderr，
不进日志镜像、不进运行状态、不进任何摘要或 digest，也不改变失败路径本身；
写 stderr 失败时静默忽略。白名单内的失败码按原样返回，不输出诊断。
不能通过回复 `approved` 打开 V3 授权或完成任务；需要审查时使用下方可信启动选项，不能据此宣称 N1–N8 已跑完。

结束发送 `{"type":"host_close","sessionId":"from-host-ready"}`，进程确认后退出；
PTY 会关闭本进程输入回显并恢复原终端模式，须用上述消息结束，而非依赖 Ctrl-D。
EOF/断联让未完成工具调用沿原 unknown 恢复，不当成用户取消；显式 cancel 才记取消。
重开不会重发 unknown、cancelled 或已完成开发。每行回复仍限64KiB。
QA、文档可显式接入下述固定能力，多任务使用下文批次 CLI。源 Skill 显式路由见
`skills/cm-ai/references/js-host.md`；完整角色接线与安装激活仍未完成，不能自行补 JSON 或绕过待审。

### 接入 QA 与文档

首次 create 时可添加 `--workflow-config /absolute/workflow.json`；含 QA 配置还必须添加
`--allow-qa`，表示可信启动者已经核对并获准其中的具体命令、目标环境及工具使用。
恢复使用相同配置和授权选项；普通启动不自动启用。配置只接受如下固定数据，不加载模块：

```json
{
  "qa": {
    "commands": [{"id":"tests","command":["node","--test"],"caseIds":[]}],
    "environment": {"kind":"web","carrier":"browser","target":"http://127.0.0.1:3000","scope":"local"}
  },
  "documentationPaths": ["README.md"],
  "applicableAgentFiles": []
}
```

没有 QA 配置时 qa 为 null；没有文档写入时 documentationPaths 为空数组。文档路径必须已在
原业务 scope 内，AGENTS/CLAUDE 等保护指令仍不能从此写入。applicableAgentFiles 沿原 N7
相对路径合同，须列出实际适用的子目录指令；空数组不是跳过项目根指令或免除宿主读取义务。

具备文档能力的新 run 默认在原 `documentation_inspect` 中做一次只读收尾资料核对，
并将结果附在 finish/run_finalize 的 `knowledgeCloseout` 中。需要关闭时在上述配置
添加 `"knowledgeCloseout": false`；开关与版本写入原 init 快照，resume 不能改变。
旧 init 缺字段继续旧合同；旧文档答案兼容，但新 run 未收到报告会明确标记未完成。
完整范围、六面报告、失败与回退规则见
[`knowledge-closeout.md`](../skills/cm-ai/references/knowledge-closeout.md)。报告不替代原 Review/QA 或必需文档凭证。

已完成任务的一次性 QA 附加：原无 workflow 或 `qa:null` 的 run，仅在 `--mode resume`、
state 为 `fixture_completed` 时，可显式同时传入含 QA 的 `--workflow-config PATH` 和
`--allow-qa`。缺授权返回 `qa_authorization_required`；未完成返回 `qa_attach_not_completed`；
原本已有 QA 的 run 换 QA 命令、环境或预算仍返回 `fingerprint_mismatch`（配置填错时用 QA 配置修订入口）。
项目 `.cm-workflow.yml`、`~/.cm-workflow/runtimes.yml` 与插件内置默认值不进入新运行的指纹：内置 QA 执行器按它们
推出的执行计划（用例、命令、阶段、mode/case_count）在每轮 N6 重新冻结，由该轮 `test_run` 记录 mode/case_count；
旧版本创建的运行指纹含当时的 CM 配置，配置未变照常打开，已变时仍 `fingerprint_mismatch` 并在 `reason` 说明。
definition、scope、requirements、
identity、host-context、模型、保护模式、检查及其他配置保持原指纹约束。原无 workflow 时可
带入原 scope 内的 documentationPaths 和 applicableAgentFiles；已有 `qa:null` workflow
须保留这两项原值，历史只存摘要，不能猜测旧配置。附加不执行审后文档写入。

store 的 `fingerprints.config` 不覆盖，旧 journal/完成凭证保持原字节。先匹配完整原指纹，
或严格匹配去掉 QA 的原配置指纹，再绑定新增配置：`qaFingerprint` 是原 config 摘要算法
对完整恢复配置材料（含 definition、execution、QA provider/executor 与文档能力）的 SHA-256。
runner journal 使用原哈希链 envelope，新增 `kind:"result"`、
`payload:{version:3,protocol:"cm-task-runner",type:"qa-attached",record:{version:1,qaFingerprint,attachedAt,hostContextId}}`；
attachedAt 是 UTC 秒级 ISO 时间。仅允许一条，回放验证完成状态、无 pending effect 及精确格式。
后续须同时匹配原指纹和已记录的 qaFingerprint，不允许移除或替换 QA；每次启动仍须重新授权。
日志复用原 writer 写 `event:decision`、`phase:qa_attach`，业务 data 只有 feature/task/qaFingerprint；
重复恢复去重，journal 成功后日志失败可在同配置恢复时补写。

附加只连接原 N6 能力，`qa` 仍请求 `qa_assess`，QA 执行、qa_result、context_refresh、finish
沿用原门禁，不自动决定，不重跑 develop/review/complete，不清除 correction 阻断。
（2026-09-17 dogfood 事故：create 漏传 workflow 导致已完成 feature 的强制 QA 永久卡在恢复指纹校验。）

JS 通过现有通道发出固定请求，结果由原组件校验：

| kind | 当前会话的职责 | JS 的职责 |
| --- | --- | --- |
| documentation_sync | Review 前同步列明的文档，返回 `{status:"completed"}` | 原 scope 检查、最终 handoff 与 Review 覆盖 |
| qa_assess | 返回原 scores/changes 语义评估 | 原 N6 强制触发、评分及日志 |
| qa_logic | 返回原静态 verdict/evidence | 与实际命令覆盖关联，不把静态结论算执行 PASS |
| qa_browser | 用获准工具实测，返回原 verdict/evidence/environment/cleanup；PASS 只因证据不在 specs 根的 `.reviews/` 下（或缺失、为空）时，宿主带 `correction` 再问一次同一用例，只改证据重答 | 原逐例日志、证据与载体校验、QA 结果 |
| documentation_inspect | 只读核验，返回请求绑定的原文档结果 | 原 N8/finalizer，唯一 run_done |

正式 QA commands 由现有 host-check 实际执行，必须是宿主核对的已授权命令；配置文件本身
不是权限证明，也不提供 OS 沙箱。它们不能写 specs/指令、发网络、安装或做 Git，除非另获
对应权限；这里的 QA 开关不授予这些权限。浏览器能力仍受用户工具策略与目标授权约束，
缺工具/环境就返回 BLOCKED，不能换载体或伪造证据。QA FAIL/BLOCKED/unknown 不自动重试。
代码检查、Learning、Review、QA、文档核验全部通过后才由原 finalizer 返回 run_done。
run_done 是项目级声明：`finish` 与 `run_finalize` 还按权威日志核对每个已批准 feature 的最新 QA 决策——触发的 QA
须以完整 PASS 结束（用原 owner 校验器读取），阻塞决策也不算通过；任一 FAIL、BLOCKED、已触发未执行、结果未知
或旧结果已作废待下一轮，返回 `blocked/project_qa_not_passed`，`outstandingQa` 与 `reason` 列出 feature、任务、runId，
不做文档核验、不写 run_done，`.cm-status.json` 不会被改成 run_done。任务还没做完的 feature 允许中途的 skipped 决策；
任务已全部完成（均勾选或 DROPPED）的 feature 必须以 feature 完成时的 QA PASS 结束：没有任何 QA 记录（`qa_missing`，
runId 为 null）或最新决策仍是 skipped（`qa_skipped`）同样拒绝。JS 流程没有关闭 N6 的配置——`policies.tests` 不能为空，
收尾要求本运行的 QA 决策，feature 完成时的 QA 是强制的——所以这类 feature 只可能是在流程外（手工勾选或旧流程）完成的，
不被信任。恢复方法：把该 feature 的末任务在 `tasks.md` 改回 `- [ ]`，用 cm-ai 重跑它（已有审查证据时加
`--supersede-reviewed-evidence`），让 N6 在 feature 完成时补上 QA。准入选择仍按 tasks.md，只在 `warnings` 中提示这些
feature。恢复对应运行让 QA 通过后，再次 `advance` 本运行即可收尾。

已完成运行（fixture_completed）的 QA 恢复、QA 修复、配置修订与收尾先照旧核对原审查包；树已变化时，再核对
变化是否恰好是同一代码根、同一仓库、其他任务的已完成并已提交运行的审查交付（含其已登记 QA 修复）。规则是确定的：
取全部审查时间晚于本运行批准审查的这类交付包（主包取其批准审查的登记时间，QA 修复包取其最终审查的登记时间，
均为 journal 中的持久字段；没有这一时间的交付不采用），按审查时间排序（同一时间按运行 ID、包内顺序），逐个全部接续，
不挑选、不搜索（记录条数上限见本节末尾）；本运行自己的 QA 修复按其完成证据所引最终审查的登记时间插在同一序列中。每一个都必须
严格接续：它在所改路径上的审查前状态必须等于当时的组合，否则失败关闭并列出路径。最终组合必须与当前代码树的内容和
文件权限（mode）完全一致；唯一例外是本任务范围外的项目根 CM 配置文件。所以早于本运行的旧变更
不能掩盖对本运行改动的人工回退，已审的 A→B→A 之后再手工改回 B 也对不上；这类交付 AGENTS.md 教训行和对本任务文件的
修改都按此接续。其余变化——包括对本任务交付文件、需求文件或其他文件的未审改动、未完成或同任务替代运行的改动——仍是
`correction_review_required`，`reason` 列出未解释的路径。这比原先“完成后整棵树不许动”放宽了一处：只接受
已审交付与根 CM 配置，未审改动仍失败关闭。
同一代码根上独立的 `cm-fix` 运行（非 QA 修复子运行）正常收尾后也算已审交付：经它自己的只读回放读出，只认最终审查已批准
该包、`task_done` 与 `run_done` 都已绑定的运行，进行中、放弃、取消或升级为设计变更的都不算；交付内容是该审查包的逐文件变化，
顺序取其最终审查登记时间。这里只读 journal 与收尾记录已确定的事实，不再拿当前代码树重验修复证据（后续已审交付本就可能
再改这些文件），代码树仍由上面的严格接续核对。QA 修复子运行只经父运行接受后计入；记录里点名 cm-fix 运行的 `laterDeliveries`
步骤回放时同样重新读出核对。
有 QA 修复时，顺序只取接受修复时已固定的事实：接受一次修复时，所有尚未记录、已完成且审查早于该修复最终审查登记时间的
交付按审查时间排在它之前，关联记录升为 version 2，`laterDeliveries` 按顺序记下这张清单——每项只有运行 ID、包摘要和它
位于第几次修复之前，逐文件变化每次都从所列运行已核实的存档重新读出，不写进 journal。已接受的清单此后不再改变：状态核对
按记录原样严格组合，其余所有交付（包括审查早于修复、但在修复被接受之后才提交完成的交付）一律按审查时间排在最后一次修复
之后现场接续，所以不会因此被锁住；下一次修复只能在前一条记录之后追加位于它之前的交付。记录里的交付必须仍是所列运行
已完成、审查晚于本运行的真实交付包，否则 `fix_association_unverified`。打开运行时，所列运行的存档都在就逐条重新读出并
核对记录的组合摘要，不符即拒绝打开（`fix_association_unverified` / `fix_association_invalid`）；存档已不在时回放无法证明，
只核对记录的形状与前缀，此时状态核对、QA 恢复与接受新修复一律按 `correction_review_required` 失败关闭。清单为空时仍写
原 version 1 记录，旧记录按原算法回放。接受修复前按存储的实际限制（单条记录、追加输入、记录条数、整个状态文件）核对
将写入的完整记录，超出时以 `fix_record_too_large` 拒绝（QA 修复宿主返回 `qa_fix_code_unmatched`，`reason` 为该代码），
不写入、存储仍可用。只含全文清单的旧 V1 基线不支持后续交付，仍按原规则拒绝。
已知上限（极端规模，不在本次修复范围）：一条 QA 修复关联记录最多列 2048 个后续已审交付，超出时接受修复以`fix_association_invalid` 失败关闭；接受前的大小核对只覆盖单条记录、追加输入、1024 条记录与 16 MiB 状态文件，不含存储目录 32 MiB 的物理上限——崩溃时残留的 `.state.<uuid>.tmp` 临时文件计入该上限，状态文件与残留临时文件合计超出时追加仍按存储原有方式以 `limit_exceeded` 失败，处理残留临时文件走存储现有的恢复路径，本入口不自动清理。
并行批次成员（工作树根不同）
的交付不被识别；收尾发现文档需改时仍要走已审任务，不能在已完成运行内直接改。
日志镜像位于 specs/.reviews/host-log-mirror，只是原日志的可重建副本；权威仍是 specs-local 日志。
运行日志只增不减：cm-fix 收尾（check_n5 之后的完成投影、METRICS 行、观察期与恢复判断）与 cm-ai QA 读取都按行流式扫描 specs-local `运行日志.jsonl`（单行上限 1 MiB、拒绝符号链接），不再整份套用 1 MiB 的审查材料上限；cm-fix 只取 cm-fix 行，各调用方再按本运行身份筛选。日志超过 1 MiB 不影响收尾与恢复。cm-fix 与 cm-test 历史恢复的读取保留原有文件保证：单一链接的普通文件、读取前中后文件身份与大小时间不变、读到记录的大小，行按普通 JSON 解析；cm-test 恢复也不再受 32 MiB 整份上限限制。
重开复用原 QA/任务结果，只读文档核验可以再次进行，不能重发开发、文档写入或 QA。
本地命令与合成 reviewer 的 CLI 组合已走到 run_done；这不代表真实模型、浏览器或全 N6 验收。

### 配置与按轮启用独立审查

首次 create 前固定 reviewer 模型和本地诊断配置；未配置 reviewer 的旧运行保持原行为，
不能在恢复时更换模型或把旧 control-only 记录转换成执行记录。

```bash
# 只启动本机合成 sink 和只读 CLI 探测，不请求真实模型；输出保存为 review.json。
# --review-model 必须是 CLI 实际写进请求体的完整模型 id，不能用 sonnet 这类别名：
# 探测按字面比对，别名会以 request_checks 里的 model_matches:false 判失败，
# 而回执只给布尔值、不给期望值，仅看输出无法推断该填什么。
# Claude CLI 报 unrecognized_model 时 preflight 也会失败；stderr 指明被拒 id 和家族别名示例（如 CLI 2.1.x 的 claude-opus-5），可快速读取时还会显示 CLI 版本。示例不是完整模型清单。
node scripts/cm-ai-host.mjs preflight --config /absolute/run.json --review-model model-name
# 携带配置但不授权审查：开发和检查完成后等待授权。create 必须带 --review-config：
# 审查配置写进运行指纹，resume 时无法补加；不带时宿主以 review_configuration_required 拒绝并说明。
node scripts/cm-ai-host.mjs serve --config /absolute/run.json --mode create \
  --host-context actual-current-conversation-id --allow-development --review-config /absolute/review.json
# 当前会话已取得本任务本轮、该模型及发送审查包的用户授权后，才可添加对应轮次：
node scripts/cm-ai-host.mjs serve --config /absolute/run.json --mode resume \
  --host-context actual-current-conversation-id --allow-development --review-config /absolute/review.json \
  --allow-review-attempt 1
```

若改用 `cm-ai-drive.mjs` 的 `create`/`advance` 并同时传 `--allow-review-attempt 1`，需预备 `develop-a2.json`；通常先不带审查授权到 `awaiting_review`，再按 `packageDigest` 单独 `decision`，读首轮 findings 后写第 2 轮答案。第 2 轮交付与第 1 轮被要求修改的代码逐字节相同（审查包 `artifactDigest` 相同）时，运行器在送审前停在可重试的 `blocked/develop_unchanged_after_review`（`pendingAction: "resume"`），不消耗第 2 轮审查；改好答案后在原 run `advance`，以新的 develop effect id 重新交付。`resume` 时驾驶员按存档里的当前轮次发送 identity，所以第 2 轮的 `decision`、`complete`、`qa`、`finish` 等不会再因 attempt 1 身份报 `identity_mismatch`；入口对包绑定操作要求精确轮次的边界不变。

批次驾驶员没有单独的 `decision`。带 `--allow-review 任务:1` 但缺 `develop-a2.json` 时，驾驶员给该任务加启动期旗标 `--hold-revision FEATURE/TASK`：审查若要求修改，任务停在 `changes_requested`，`code:"revision_answer_required"`、`pendingAction:"resume"`，不写第 2 轮开发 intent；写好 `develop-a2.json` 后不带该旗标再 `advance` 继续同一轮修订。旗标只缩小本次启动能做的事，不持久化、不进配置指纹；审查批准时不受影响。

`develop.json.edits` 的值可以是内容文件名（写入，已有文件保留权限，新文件 0644）、`{file,mode}`、`{mode}`（只改权限位）或 `{delete:true}`；`mode` 只接受 `"0755"`、`"0644"`，改名为删旧写新；同时是 requirements 的 scope 路径不能删除，启动前拒绝，当前会话仍删除时停在可重试的 `blocked/develop_requirement_missing`（范围外改动仍先按 `unknown/out_of_scope` 处理）。运行存档单条记录上限为 1 MiB：开发检查点连同 base64 审查包须在 1 MiB 减去为后续审查与完成记录推出的预留之内。审查结果除 examinedPaths 外以 12 KiB JSON 为界（超出按固定规则截断 finding 文字与 summary、必要时从末尾省略 finding，先 P3 且至少保留一条阻断 finding，verdict 不变），完成检查点最多重复它 13 次，预留 = 13 ×（examinedPaths + 12 KiB）+ 2 ×（已有回执 + 调用 + Learning 回写）+ 96 KiB；驾驶员用宿主同一套审查包、handoff、Learning 证据与 AGENTS.md 回写代码在启动前核算（含 handoff）并拒绝超限交付，任务基线装不进一条记录时驾驶员与宿主都在建存档前拒绝；当前会话仍交付超限改动时停在可重试的 `blocked/develop_package_too_large`，不再以 `unknown/store_failure` 结束，旧 journal 格式与回放不变。开发阶段阻断在第 2 轮重做本轮交付时不再对照第 1 轮审查包（该交付本就改了代码），第 2 轮 `develop_checks_not_passed` 等因此可在原轮次重试；审查中漂移的 `review_package_changed` 仍须先恢复到已审代码。审查包的文件记录本就含 `mode`，删除为 `after:null`，审查提示会说明二者；包验证逐字段比较，事后改权限同样判为漂移，旧基线和旧包格式不变。驾驶员启动前按审查包上限拒绝单文件超过 1 MiB、材料（与审查包快照同一选取：scope、requirements 与树中全部 AGENTS.md）合计超过 2 MiB 或 256 个文件及与基线完全相同的交付，报错带路径与上限；当前会话若仍交付空改动，运行停在可重试的 `blocked/develop_empty_changes`，旧 `unknown/empty_changes` 历史按原样回放。新建运行要求 `runId` 满足运行日志规则（8–128 个字符），已有运行恢复不变。

review.json 含 `{model, disabledSkills, preflight}`，另有可选 `timeoutMs`；disabledSkills 是本机探测实际发现并
禁用的 Skill 路径，preflight 沿原配置指纹/模型/stdin 合同。探测输出不包含原始诊断、
凭证或请求正文；旧实验路径仅兼容转发到共享 runtime。通过探测不等于获准调用或模型可用。
更换 CLI/安装配置后应重新本机探测；模型和 disabledSkills 必须与运行绑定的配置一致。

`timeoutMs` 是 reviewer 进程的传输预算，单位毫秒，必须是 1 到 3600000 之间的整数，
不填且受保护配置也未给预算时使用 900000（15 分钟）；preflight 输出有效 `timeoutMs`。旧 review.json 未写此字段而受保护配置显式给出预算时，沿用后者。两者都给出时 reviewer 取 review.json 里的值，因此**调大审查超时不需要切换开发模式**。
它不进入已授权配置的摘要，所以 `review_transport_timeout` 之后可以在恢复时调大再续跑；
它只管 reviewer，不改变开发、检查或 QA 的任何超时。运行器自己的审查计时取 journal 中的调用超时（当前会话模式固定
1800000，受保护 CLI 模式为其 `timeoutMs`）与「reviewer 预算 + 60000 毫秒」中较大者；该计时同样不写入 journal。
因此预算可以超过 30 分钟，由 reviewer 自己的超时先触发、带进程退出记录，而不是被运行器在 30 分钟截断并耗掉唯一重派。

单任务和批次驾驶员的 PLAN 可给 `checks` 每项设置 `timeoutMs`，也可给 PLAN 设置 `checkTimeoutMs` 作为默认值；均须为 1..3600000 的整数毫秒，每项优先，省略时驱动默认 900000（15 分钟），启动宿主前校验。`host-check` 对其他调用方仍默认 60000。检查命令产生的构建文件应放在代码根外，例如将 `xcodebuild -derivedDataPath` 指向外部目录。若检查自己新增了未跟踪的范围外文件，状态为 `blocked/check_output_out_of_scope`，`reason` 与宿主 stderr 列出最多 20 个相对路径；移走产物后在原 run `advance` 会用新 develop effect id 重做。开发者写出的范围外文件仍按 `unknown/out_of_scope` 处理，检查前后树的比较不会给它恢复权限。

代码根快照有意缩小检查面：固定跳过 `.DS_Store`、`._*`、`.AppleDouble/`、`Thumbs.db`、`xcuserdata/`、`*.xcuserstate`、`.build/`、`.swiftpm/`、`DerivedData/`；在 Git 工作树内还跳过 Git 报告的忽略路径。任务 scope、任何 AGENTS.md 与规格不受忽略规则豁免。新基线记录最多 10,000 个、序列化最多 1 MiB 的 Git 忽略路径与目录，以及 `core.excludesFile` 的配置值／内容摘要；超限或 Git 不可用时明确记为仅使用固定列表。后续比较将基线和当前的忽略决定取并集并同时应用到两侧，忽略规则或无关 Git 配置变化本身不阻断审查；非忽略文件的真实漂移仍阻断。旧 journal 的无策略及旧版策略继续按各自原规则回放。审查结果已写入 journal、检查点尚未写入就中断时，恢复原运行会从已验证的结果补写检查点；若树此时漂移，状态为 `blocked/review_package_changed` 并保留 verdict 与路径，清理后继续原运行，不再调用 reviewer。

`--allow-review-attempt` 只能为1或2，只传递可信启动会话已经取得的那一轮授权，
不能为了让流程继续而擅自添加。不会自动批准后续轮次、换模型或重试失败；若第一轮要求
修改，原 runner 执行修复后停在第二轮待审，需第二轮单独授权。没有该选项时不调用 reviewer，
诊断不匹配则在打开 store/调用前拒绝。原 codexWorker 以只读、工具关闭、stdin 模式执行；
实际进程事件进入原 V3、独立身份校验、Review 文件及唯一完成门禁，不接收自报观察事件。
任务通过后仍会进入 QA 待决，不把任务完成当 run_done。

本地证据包含合成 reviewer 可执行进程通过原门禁，以及实际本机 CLI 的合成 loopback 探测；
二者都不是实际模型 Review。真实调用、用户级安装与 Git 交付仍分别需要明确授权。

## 受信宿主执行组装

`scripts/cm-ai-run.mjs` 的进程内 `main` 接受宿主提供的 execution；
`createCodexExecution` 组合开发、检查与独立审查适配器。JSON 配置和 stdin 不能启用它。
该路径已接 Learning、定稿 handoff、V3 审查登记与既有唯一完成门禁。

### 同仓 specs 的受保护执行适配器

可信进程内宿主可在 `createCodexExecution(configuration, authority)` 原配置中增加
`specsRoot`，值须为当前 definition.specsDir 的规范绝对路径。复用已有 Codex 原生权限配置：
开发 worker 与项目检查子进程都将该目录设为只读，业务代码仍可写；网络和项目指令保护保留。
配置构造不执行命令或模型；实际开发、审查依旧分别经过原授权回调。

将返回的原 execution 对象直接交给 `openControlRun(definition, mode, execution)` 或进程内
`main`。受保护对象被冻结，且仅在当前进程登记来源和精确代码/specs 根；复制对象、只填同名
配置字段或替换 developer/check 均不能冒充该边界。重开须用原配置重新调用同一 factory；
创建/恢复及子进程派发前重新核对真实路径，不能以 symlink 替换 specs。

此变体不能再挂接任意 qaExecutor 或 documentationSync。固定factory可在冻结前接入下述原workflow能力；
未传 specsRoot/workflow 的旧 factory 配置和恢复指纹保持兼容。
底层保持进程内 Codex 适配器，不给 JSON CLI 加载任意执行模块的开关；普通单任务入口可通过下文
显式选项调用它；Codex/Claude当前会话及批次使用下方独立的受保护文本提案接线，cm-fix使用protectSpecs，不冒用此Codex模型调用。
Node 24.14+要求不变；本地原生沙箱与合成CLI证据不是实际模型开发或Linux端到端验收，平台证据见“当前支持”。

### 项目安全检查接入

复用项目已有安全命令和宿主 `checkCommands`，不新增扫描器、配置字段或节点。
工具、规则和阻断阈值由业务项目维护；CM 负责执行命令并沿已有 handoff/Review 门禁收口。

例如项目已提供 `npm run security`，将下例合并到原受保护当前会话配置，
通过 `--protected-conversation-config PATH` 传入；保留原测试条目。此文件是宿主执行配置，
不是 `.cm-workflow.yml`。命令从当前 `codeProject` 执行，数组逐项为 argv，不作 shell 展开。

```json
{
  "checkCommands": [
    {"id": "test", "command": ["npm", "test"]},
    {"id": "security", "command": ["npm", "run", "security"]}
  ],
  "timeoutMs": 60000
}
```

示例中的 npm 脚本必须在业务项目真实存在，不能复制到 CM 自身的 package.json。
前端、后端都使用同一入口，替换为对应项目的现有命令即可；多个代码根按下述宿主合同
为每条命令指定 `codeProject`。普通当前会话宿主则通过原 check 请求执行并回报同样的检查，
JSON 配置本身不能证明执行过；未配置的安全检查不会被执行器自动发现或补齐。

| 项目命令结果 | CM 处理 |
| --- | --- |
| 检查执行完成且退出 0 | 该命令通过；全部检查通过后才可进入原独立 Review |
| 发现项目定义的阻断问题，退出非零 | 检查失败，阻止交接；在已授权范围修复后重跑 |
| 工具缺失、启动错误、超时 | 失败或不可用，阻止交接，不能记为通过 |
| 没有配置安全命令 | 没有扫描证据；若项目/任务要求扫描，主执行者须保持阻塞并报告缺口 |

接入时用一个已知问题样本验证命令确实非零、修复后才为 0。部分工具默认只报告不失败，
必须使用项目认可的退出码选项或现有包装脚本；不得通过 `|| true` 吞掉退出码。
发现漏洞和工具错误都必须阻断，CM 不从输出文字猜测漏洞等级，也不替扫描器判定“无漏洞”。
命令应可重复运行且不自动改代码；原宿主可能在审查/恢复时重新检查。

命令及简要结果进入原 `verification`，沿用内容绑定和独立审查。原始输出可能含密钥，
受保护检查器不把它放进 Review；需要定位时在原项目工具中查看并只记录脱敏结论。
扫描若需联网、登录、安装工具或上传源码，仍遵守当前项目权限，不能因加入检查自动获得授权。
此路径沿用受保护宿主的平台支持与恢复规则，不覆盖已生成的 handoff，不绕过失败或未知调用。

### 普通单任务入口选择受保护模式

当前会话（Codex或Claude）及批次也可选择 `--protected-conversation-config PATH`，文件为
`{checkCommands:[{id,command:[...argv]}],timeoutMs}`。沿原 `--allow-development` 启动；不与
`--protected-config` 混用，不增加开发模型调用。固定工厂冻结developer/check/QA能力并绑定完整定义；
复制或修改对象不能保留保护声明。批次在冻结前绑定整个workflows配置与原日志目录，恢复不换配置。

收到develop的 `editMode:"protected-text-v1"` 时，宿主只能读取并返回
`{status:"succeeded",value:{原outcome/application/retrospective},edits:[{path,beforeSha256,content[,mode]}]}`。
沿用fixed fix编辑器的scope/expected摘要、完整UTF-8/null删除；可选 `mode`（"0755"/"0644"）只用于写入的文件，新文件为 0644。
通道上限默认 64KiB，可用 `--input-limit` 调到 4 MiB，输入行与工具应答共用该上限；宿主不得先写或运行命令。
驾驶员只提交严格 UTF-8 内容，二进制文件启动前拒绝。cm-fix 的受保护提案仍不接受 `mode`。
失败仍返回原 `{status,code}`，blocked值必须空edits。实际编辑及配置中的检查由native Codex sandbox执行，
不使用宿主check回报。Claude作者/Review身份保持Claude，所需本机Codex sandbox不是Codex模型调用。
文档同步并入最后任务的同次编辑提案，QA命令受保护，语义/浏览器/文档核验仍按原宿主合同执行。
同仓子fix仍必须protectSpecs:true及各自权限；Review仍按原任务/轮次单独批准。缺载体、二进制、超限、
未知或部分写入停止并保留原恢复状态，不自动切回无保护模式。这不是对受信主宿主本身的OS隔离。

`cm-ai-host.mjs serve` 可显式增加 `--protected-config PATH`，该本地JSON文件固定为：

```json
{"model":"{已获批准的开发模型}","checkCommands":[{"id":"test","command":["node","--test","test/example.test.mjs"]}],"timeoutMs":60000}
```

配置不能指定代码/specs根、动态模块或授权回调；这些继续由原run配置、真实host-context和固定factory提供。
只有用户已明确批准当前任务该轮模型调用、发送范围及检查命令后，才使用如下启动方式：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve \
  --config "{RUN_CONFIG}" --mode create --host-context "{真实当前会话ID}" --allow-development \
  --protected-config "{PROTECTED_CONFIG}" --allow-provider-development-attempt 1 \
  --review-config "{原preflight输出文件}" --runtime codex
```

开发与检查使用原只读specs权限profile；单独`--allow-development`不授权真实开发provider。
`--allow-provider-development-attempt`只接受1或2，首次create须为1，恢复修正轮需另行批准2。
不存在批次通配授权，第二轮未获许可不能自动调用。配置/身份进入原恢复指纹，动作许可不持久冒充授权。
许可在开发effect登记前检查：R1要求修改而未授权开发第2轮时，保留changes_requested与原审查，
返回provider_development_authorization_required，不创建develop-2或伪装unknown；原运行补授权后继续。

review-config始终需要原诊断文件，可带原disabledSkills；不是实际模型可用性或独立Review许可。
没有`--allow-review-attempt`时在原待审点停止；批准后用原配置`--mode resume`并附对应审查轮次，
由原hostDecisionProvider/V3签发和登记，不新增grant或完成状态。已完成开发/审查不重复派发。

首次create可附原`--workflow-config PATH`，有QA配置仍必须另附`--allow-qa`；格式与上文“接入QA与文档”相同。
QA命令复用原native specs只读profile，日志/报告仍由原JS宿主写入；没有第二条完成路径。
最终任务的documentationPaths先检查属于原批准scope且不是保护指令，再加入同一次受保护开发调用，
开发后照常检查、定稿handoff及独立Review。文档已经准确可不改，不增加模型调用或宿主documentation_sync写入。
宿主仍通过原协议处理qa_assess/qa_logic/qa_browser与只读documentation_inspect，不能借此修改业务代码、specs或指令。
浏览器遵循既有工具/目标/证据/清理权限；宿主语义报告不等于OS沙箱或真实执行证明。缺能力/核验blocked保持原阻断。
只有原QA和文档核验通过后才由原finalizer返回run_done；恢复不重复开发、QA或文档写入，只读文档核验可重做。

进程内factory的可选configuration.workflow为`{definition,configuration}`，分别为完整原run定义与原workflow配置；
authority.workflow为`{bridge,allowQa}`，只用于组装上述固定能力，不接受任意QA/doc写入callback。
整个定义和配置绑定原恢复指纹；QA许可不作为持久批准，启动须重新提供。原无QA的已完成run可按上文的一次性附加规则恢复；未完成run仍不能临时添加。
默认会话/批次不变；受保护父模式仍不接受Claude，但允许原QA-fix参数且子配置必须protectSpecs:true（见下节）。它不授权Git、安装或发布，
也不代表全部N1–N8分支已完成。切换模式、模型、根路径或host-context不能复用旧运行。

### 宿主决定与收口

同仓QA修复复用原owner/template、每项allow-qa-fix权限与auto_fix策略，不新增循环；父protected模式要求
子configuration显式`protectSpecs:true`，缺少时建父store前返回protected_fix_required。
独立`cm-fix-host.mjs`也接受原配置顶层`protectSpecs:true`，原所有allow-*权限保持不变。
无specs项目省略specsRoot或传null，沿同一owner将档案置于docs/fixes、证据置于docs/fixes/.reviews，跳过METRICS；不造规格或任务。
纯视觉缺陷可配置kind:visual的reproduction/redTest及真实before载体，在原回归中通过qa_browser取得after载体。
两者以明确visual检查进入原审查/收尾，不用虚假红绿命令。完整配置及两种浏览器回复合同见
[cm-fix宿主接线](../skills/cm-fix/references/js-host.md#无法写自动红测的纯视觉缺陷)；缺证据、漂移或unknown按原状态停止。
其复现、红测、基线、回归及命令走查均经现有host-check的native specs只读沙箱；本机需要Codex sandbox，
但不因此调用Codex模型或改变Claude宿主/Review身份。主宿主仍受信并拥有既有日志、证据及受控Learning写入。

保护模式的fix_test_author/fix_repair带`editMode:"protected-text-v1"`与scope内的expected文件摘要。
宿主不直接写文件，只返回`{outcome,edits:[{path,beforeSha256,content}]}`：正文为完整UTF-8文本，null表示删除，
beforeSha256使用expected原值（缺文件为null），blocked要求空edits。固定沙箱进程按原scope和摘要实施，
拒绝链接或陈旧内容，随后原diff/红绿/Review/finish照常。文本提案受原64KiB通道限制；二进制/超限修改明确阻断。
这不是新模型调用或原子多文件事务：部分写入后失败仍保留原unknown，不自动重试或回滚；原恢复配置不得切换保护模式。

进程内factory可由可信authority提供developmentAttempt（1或2），在原entry开发登记前限定轮次；
实际开发仍由authorizeDevelopment回调再次检查。JSON控制消息不能传入该许可，旧调用方不增必填项。

可信 `execution.hostDecisionProvider: {decide, timeoutMs}` 可替代静态 hostDecision；
此时 hostDecision 设为 null，timeoutMs 为 1–60000ms。decide 在原 handoff/包生成后
接收只读 `{specsDir, codeProject, feature, identity, packageDigest}` 和 AbortSignal，
返回原 `{status:"approved"}`、`{status:"denied",code:"permission_denied"}` 或 null（尚无决定）。
它必须读取当前真实用户授权；不能把规格文本或模型自报当授权。JSON 配置/请求不能注入该回调。
等待期间可取消；超时返回 review_decision_timeout，晚到结果不采纳；包/状态变化拒绝。
已完成、unknown、pending_review 等历史状态不重新询问或重发，仍走原恢复边界。

`createHostReviewAuthority`（`runtime/js/cm-ai/host-review-authority.mjs`）把上述异步决定
与原同步 V3 authorize 连接：传 hostContextId、reviewerId、adapterId、decide、timeoutMs，
将返回的 hostDecisionProvider 装入 execution，authorize 装入 reviewInvocation.authorize。
只有一次性的当前身份/包批准可在60秒内签发原请求绑定 grant；拒绝、取消、错包、过期、
重复消费均不能签发。它不派发、不独立落盘；原 runner 才登记调用与恢复证据。
签名字段的 digest 是完整性绑定，不是身份认证；可信宿主与真实用户批准仍是信任边界。
该辅助接线不改变 cm-ai-host.mjs 默认未授权 Review 的限制。

执行模式的一次 `advance` 请求按当前状态推进开发 → 审查 → 完成，
使用与 `status` 相同的请求字段，不接受调用方自报批准或 packageDigest。
每阶段仍执行现有校验；缺批准、拒绝、失败、取消、unknown 或补正要求时停止。
重开后读取原状态，不重复已经完成的开发或审查。任务完成本身不代表 run_done；
只有 QA、上下文、文档核验及既有 finalizer 均通过后才返回 run_done。
首次审查要求修改时，沿 runner 的既有第 2 轮执行修复和 fresh Review；第二轮仍要求修改
则以 `review_limit` 停止，不创建第三轮。每轮仍单独经过宿主调用授权。

审查提示写明 verdict 规则：P0 为安全漏洞、数据丢失或主路径崩溃／错误结果，P1 为用户会遇到的错误行为或未满足验收标准，
P2 为合并前必须修的边界、错误处理、契约或测试缺陷，P3 为不阻断的建议；`approved` 不得有 P0–P2，`changes_requested`
至少一条 P0–P2；finding.path 只能是 examinedPaths 或 handoff 路径，规格／设计／任务文件不是 examinedPaths。
违反这些规则的答复不产生回执，状态为 `pending_review/review_verdict_invalid`，`reason` 以具体代码开头
（`contradictory_verdict`、`invalid_finding_path`、`missing_material`、`review_package_mismatch`、`invalid_finding_*`），
答复原文留在 journal 供回放复核；与传输超时共用同一 attempt 的一次重派，超出后为 `blocked/review_verdict_invalid`。

`blocked` verdict 的含义固定为：在批准 scope 内修改代码也无法让这个包通过——批准的规格自相矛盾或有误、数据块缺少必需材料、
修复需要改 scope 外文件，或需要人工决定。它是终态，第 1 轮给出也不进入第 2 轮，`reason` 写明审查给出的原因；
按原因修改规格或 scope 后以 supersede 新建运行。选择保持终态而不是把 blocked 当成第 2 轮：运行器无法判断 blocked 是否可修，
把它转成第 2 轮会让不可修的 blocked 白耗最后一轮开发与审查，也会把审查者明确的停止改成继续，削弱失败即停的边界。
可修的问题由提示要求使用 `changes_requested`，因此不会被 blocked 静默吞掉第 2 轮。

`review_limit` 或 `review_blocked` 之后用 supersede 新建的运行仍从第 1 轮开始，`priorReview` 为空，轮次与名额照常计算；
直接前驱运行最后一份审查回执的 verdict、summary 与 findings（按审查文本上限截断；前驱没有回执时沿用它自己带过来的那份）
写入新 journal 的 `evidence-superseded.carriedReview`，只在第 1 轮开发与第 1 轮独立审查请求中以 `supersededReview` 出现，
提示写明它是“previous run's findings (context, not a verdict)”，不算审查结论、不跳过审查。回放按请求摘要绑定该字段，
事后替换或删除即拒绝；没有该字段的旧记录与旧 journal 按原格式回放。
`status/cancel/advance/resume` 可以使用启动配置的原身份，返回当前轮次；
`decision/complete` 等绑定任务包的操作必须使用当前轮次身份，旧轮次请求拒绝。
任务完成后，`advance` 进入既有 QA 决策步骤；未提供绑定当前任务包的宿主决策时返回
`qa_decision_required`。触发 QA 而未提供可信执行器时停在 `qa_execution`，阻塞决策不推进。
新 QA 决策不能以低分跳过已全部完成的 feature；此时返回 `qa_mandatory_required`，
等待宿主提供正确的触发/阻塞决策，不自动签发授权。历史日志不改写，旧证据读取保持兼容。
明确跳过 QA 且宿主提供适用指令清单时，自动刷新上下文并返回下一任务或 `finish`；
恢复复用原 QA 日志，不重复记录。可信批次入口可继续派发下一任务；获准文档写回见下文，
产品 Skill 和真实会话工具宿主的完整接入仍未完成。

可信进程内 `execution` 可提供 `qaDecisionProvider: {decide, timeoutMs}`（1–60000ms），
通过原 host/entry 在实际任务完成后接收只读的
`{specsDir, codeProject, feature, identity, packageDigest}`，第二参数为 `AbortSignal`。
`decide` 返回既有完整 QA decision，必须绑定所收到的身份与包摘要；不能同时提供静态决定。
此回调只作决策，不执行 QA、外发或修改文件。JSON 配置/请求不能注入回调。

宿主可使用 `runtime/js/cm-ai/host-qa-policy.mjs` 的
`createHostQaDecisionProvider({assess, timeoutMs})` 作为上述 provider，不必自己实现N6规则。
`assess` 接收当前身份、包摘要及JS从原tasks/QA日志推导的pending、mergeEligible、
unassessedTasks；只返回语义评估：`scores`含scope/risk/accumulation/boundary（各1–5），
`changes`含api/migration/authentication/authorization/payment（布尔值）。JS决定是否触发，
不从文件名猜测API或支付风险。低分也不能跳过feature完成、migration、认证/授权/支付、
连续五项未QA；普通评分≥8触发。API仅在本feature恰剩下一项且无其他触发条件时合并，
原日志同时保留qa和decision/qa_merge。缺失历史QA留痕的已完成任务保守计入，不假设测过。
历史已绑定决定仍由原entry恢复，不重复评估。此适配器不执行测试、路由角色或授权修复。
已有绑定决策从 specs-local 日志恢复，不再次调用；取消和超时会中止等待并丢弃晚到结果，
分别报告 `cancelled` / `qa_decision_timeout`，不会自动重试。新决定校验强制 QA 政策；
已经完整校验且绑定的历史决定沿原证据消费路径继续，不重新裁决或改写日志。
适配能力和超时纳入执行配置指纹；未启用时保持旧指纹。测试可用 `qaLogHome` 隔离日志镜像。

可信 `execution.qaExecutor` 为 `{mode, caseCount, timeoutMs, run}`，可另含只读
`configuration` 纳入原执行配置指纹：模式为
`commands|browser|all`，用例数为正整数，超时 1–3600000ms。仅由已获对应工具执行授权的
宿主注入，不从 JSON 请求/规格生成可执行代码，QA 触发决定本身不授予外发、浏览器或命令权限。
宿主负责按现有 N6/test-contract 选择全部适用 blocking 用例、解析并记录角色路由、
执行只读正式命令/浏览器用例、保存逐例证据及清理；静态逻辑判断不得返回执行 PASS。
`run(request, signal)` 接收任务绑定、`codeProject/testRunId/mode/caseCount`；返回
`{result: "PASS"|"FAIL"|"BLOCKED", passed, failed, blocked, report}`，报告必须实际位于
specs `.reviews/` 内。宿主只能写获准报告，不能修产品代码或独立写 start/complete。

工作流配置的 `qa.timeoutMs` 是单条 QA 用例给宿主的应答窗口，整数 1–3600000 毫秒，
不填仍为 60000。一轮真实浏览器走查（造数据、逐步点击、每步读 DOM 与存储）按分钟计，
60 秒内做不完；超时的用例会被标记 `hostRequestTimeout` 并判 `BLOCKED`，拖垮整轮 QA。
需要真实走查时按实际耗时调大它。

被阻断的 QA 可以单独重跑，不必重做任务：批次宿主接受 `--rerun-unknown-qa` 与
`--rerun-blocked-qa`，语义、限制与 qaRound 上限沿用单任务宿主，两者互斥且都要求
`--allow-qa`。批次没有 `--mode`，所以是否生效逐任务判定——只有「已有运行记录可恢复
且该任务配了 QA 执行器」的任务才会收到这个开关，新建的运行或没有 QA 的任务直接忽略，
不会因此让整个批次启动失败。

JS 在 dispatch 前用原 writer 写 `test_run/start`（首轮），返回后重新检查任务包、
报告路径和计数，再写 `complete`，最后由原 `inspectCmAiQaResult` 裁决。
PASS 且提供 `execution.applicableAgentFiles` 时继续原上下文刷新；FAIL/BLOCKED 停止。
阶段间收到取消也停止：写 start/调用执行器前检查本次取消与 runner 的持久取消标记，
不因任务已完成仍返回 `fixture_completed` 而忽略取消，不改写历史完成事实。
重开只读最新轮结果，不重发。超时/取消通知 AbortSignal 并丢弃晚到结果；宿主必须停止并
清理工具，未取得终态的原 start 保留为 `qa_execution_unknown / reconcile`，不伪造失败或通过。
已有失败、未知结果均不自动开启第 2/3 轮；修复与重新 QA 仍需既有显式流程。
该接线已用真实本地子进程和隔离日志验证；全量 N6 角色、业务走查及双宿主实装仍未验收。

### 固定 QA 执行器

`runtime/js/cm-ai/host-qa-executor.mjs` 的 `createHostQaExecutor` 可直接装入上述位置。
可信宿主提供 specs/code 根、feature、runtime、requirements 路径、timeoutMs、logHome，
以及已获准的 `commands: [{id, command: [程序, ...参数], caseIds: [逻辑用例ID]}]`。
命令与覆盖关系是宿主根据项目声明提供的数据，不能从模型文本或用例steps直接生成执行。
可选 `logic(request, signal)` 和 `browser(request, signal)` 使用当前宿主实际工具；
适配器本身不调用模型、不启动或安装浏览器、不修代码。浏览器宿主须遵守用户选定的工具策略。

JS 读取原有效配置和测试合同，按profile确定顺序；`policies.tests`只关闭可选类型，
全部blocking用例保留。每个角色边界重新读取配置并写原decision/route，未观察到的模型
路由只记录degrade，不冒充后端调用。命令通过原host-check真实运行；同一命令可为多个
logic用例提供已声明的运行时证据，静态SUPPORTED自身不计入执行通过。

logic宿主返回`{verdict: SUPPORTED|CONTRADICTED|INSUFFICIENT_EVIDENCE, evidence: [说明]}`。
browser宿主返回`{verdict: PASS|FAIL|BLOCKED, evidence: [实际报告目录内证据文件], environment, cleanup}`；
cleanup只能为completed/not_needed/failed。有cleanup要求却未完成、载体不符或待确认用例均阻断。
environment由可信宿主预先绑定`{kind, carrier, target, scope}`，scope仅local/test；
Web仅browser，App仅模拟器/真机，小程序仅微信开发者工具/真机，不接受Web替代形态证据。
真实权限、目标环境、用例解释和具体证据真实性仍由宿主负责，声明路由不是授权。

报告逐项保留静态结论、实际命令退出、覆盖关联及浏览器证据；数量是“声明命令检查+选定用例”，
不是猜测测试框架内部通过数。配置/合同漂移拒绝继续，源码漂移保留文件并阻断，不回滚用户内容。
browser case沿原test_run日志写开始/结束，同步既有.cm-status.json；命令资源沿原resource日志
记录获得与清理结果。未结束的调用仍由原entry恢复为unknown，不重发。
该执行器配置可用于本地隔离组合；不能据此宣称完整N6、真实浏览器或双端安装已经验收。

作废任务的用例：taskIds 非空且全部是本 feature `tasks.md` 中标了 `[DROPPED …]` 的任务（例如
``- [ ] ~~T-001: …~~ `[DROPPED v6: 原因]` ``）的用例不进入计划，不论 blocking 与否、也先于 `policies.tests` 的类型筛选判定——作废任务的验收随任务一起暂缓，
没有可交付的功能可验；至少关联一个未作废任务的用例照旧。这类用例不向会话发 `qa_logic`/`qa_browser`，
只为它们声明的命令（caseIds 非空且全部是这类用例）也不运行。它们不计入用例数和通过/失败/阻断，summary 只按其余行计算；
计划另记 `dropped_task_cases: [{id, taskIds}]`、`dropped_task_commands: [{id, caseIds}]`，`test_run/start` 行同名记录，
执行报告在 `deferred_cases` 后多一节 `not_applicable`，逐项写 `verdict: NOT_APPLICABLE` 与原因
（`bound only to dropped tasks: T-00x`），永不记 PASS。剩下没有可执行的用例和命令时仍按原规则 BLOCKED
（`commands-unavailable` 或 `qa-unavailable`，证据列出这些用例），不会凭空 PASS。feature 中途时这类用例同样记入
`dropped_task_cases` 而不是 `deferred_cases`。只影响新一轮：已记录的轮次、报告和日志按原样回放，指纹配置（不读任务状态的初始计划）不变。

### QA 失败交接

`qa_result`（包括 `advance` 内的结果消费）遇到真实 FAIL 时保留 `qa_failed`，并返回
`fixHandoff`：最新合法 QA 身份/轮次、报告路径及 SHA、当前策略摘要和交接摘要。
`auto_fix: never` 返回 blocked；`explicit` 的 pendingAction 为 `fix_authorization`；
`auto` 为 `fix_dispatch`；第三轮仍失败返回 `qa_round_limit`，不再请求修复循环。
BLOCKED/unknown 不当作可修复失败；旧轮次不能覆盖新失败或未结束的调用。

这一步只准备宿主交接，`execution: not_started`，不启动 cm-fix、不授予 provider/Git
权限、不改原任务批准或报告。实际宿主派发、父子运行协调与修复后的重测接线仍待完成；
消费方必须重新核对策略、报告 SHA 与当前授权，不能把历史交接对象直接当执行许可。

底层 QA 生产者已支持显式 `qaRound: 1..3`（省略保持首轮），test_run 的 start/case/complete
使用 QA 轮次，任务 identity.attempt 不变。后续轮次只能紧接最新已结束的 FAIL；跳号、
重置、未经显式恢复的未结束调用和第4轮被拒绝。执行器从原日志读取已登记轮次，不以传入数字代替登记。
这仅补齐重测记录能力；`advance` 仍不自动发起后续轮次，不能代替独立修复及其 Review。

### N6 请求超时与无结果重跑

workflow 配置的 `qa` 在 `commands/environment` 之外可选 `timeoutMs`（1–3600000 毫秒，
默认 60000）。它限定每次 `qa_assess/qa_logic/qa_browser` bridge 请求；原命令及整轮执行
的外层时限保持不变，`qa_assess` 另受决策通道约 60 秒（外层 61 秒）上限约束。
逻辑用例超时记录 `host_request_timeout`，即使命令通过也保持 BLOCKED；浏览器超时清理状态
为 failed，不能宣称资源已清理。执行器生成真实报告，整轮按原 complete/qa_result 门禁返回 BLOCKED。
评估超时是传输结果而不是 QA 决定：无论请求看门狗还是外层计时先到，`advance` 都返回可重试的
`rejected/qa_decision_timeout`，不写 N6 决定、不启动 QA；原 run 恢复后再次 `advance` 会重新询问。
旧版本把请求看门狗超时落盘为 `blocked/host_request_timeout` 决定；这类记录默认原样回放为 `qa_blocked`，
仅在显式 `--rerun-blocked-qa` 下重新询问一次 `qa_assess`，新决定带 `previous_decision_id` 追加在旧行之后；
替代决定已落盘而首轮 start 尚未写入时，同一授权再次 `advance` 视为该恢复的延续，按普通首轮执行。
所有 N6 决定读取方（qa、qa_result、context_refresh、finish/run_finalize、QA 轮次与 cm-fix 来源）只接受
“一条超时阻断 + 一条链接替代”的两行链并读取最后一行；更长、未链接或替代非超时决定的链一律拒绝。
取消、断连与超时保留各自原因，迟到答复不会被采纳。

已 complete 的 BLOCKED 结果用 `--rerun-blocked-qa` 在同一代码上重跑，除原有宿主证据问题外，还接受会话自己回答的
browser BLOCKED（执行器在报告行写 `hostDeclaredBlocked: true`；旧报告无此标记仍不适用）、没有退出码的命令结果
（host-check 的 timeout、signal_exit、spawn_failed、output_*、cleanup_failed）以及只因这类映射命令阻断的 logic 用例
（执行器写 `commandUnavailable: true`；`[需确认]` 的 logic 用例写 `needsConfirmation: true`，任何路径都不适用）。
没有声明命令、延后用例、`[需确认]`、缺少浏览器能力仍不适用。源码漂移（执行期间范围内文件被改，执行器把全部行改为 BLOCKED 并标 `sourceChanged`）只在该行漂移前的判定是 PASS、或本身符合上述可重跑条件的 BLOCKED 时适用；执行器在报告行另记 `verdictBeforeSourceChange`，并与命令退出码、browser 的 `case_complete`/`case_blocked` 日志行、logic 映射命令的退出码交叉核对，不符按未知拒绝；没有该字段的旧报告由命令退出码和 browser 日志行推出，logic 行无法推出即拒绝。漂移前为 FAIL 的行一律不适用。重跑前运行须回到 `fixture_completed` 且无 code（代码已还原到审查包）。判定以权威输入为准：`[需确认]` 读该 feature 的
`test-cases.json`（契约里找不到的用例按未确认处理），命令阻断由报告中已记录的命令行推出，会话回答的 browser BLOCKED
以执行器在应答时追加的 `test_run/case_blocked` 日志行（`host_declared_blocked: true`）为准；`needsConfirmation`、
`commandUnavailable`、`hostDeclaredBlocked` 只作交叉核对，任一与契约、命令行或日志不符即拒绝。新写入的 superseded 行带 `recovery_rule: 2` 并按此规则回放；旧版本写入、
无该字段的 superseded 行按原规则回放，其他 `recovery_rule` 取值拒绝；配置修订的 superseded 行格式不变。有退出码的非零结果是产品 FAIL，
只有操作员在同一次恢复中加 `--qa-environment-failure "原因"`（单行、最多 500 UTF-8 字节，仅单任务宿主）声明环境故障时，
才允许替代最新 FAIL：每条 FAIL 必须是有非零退出码的命令行或只因其失败的非 `CONTRADICTED` logic 用例，browser FAIL
与已接受修复的 FAIL 拒绝；superseded 记 `reason: declared_environment_failure`、`environment_failure_reason`、`failed_cases`
与 `blocked_cases`，写入器与回放都复核这些字段。所有重跑都在 qaRound+1 执行全部用例，占用同一个最多三轮的 QA 预算。

信任边界：QA 恢复把已批准的 feature `test-cases.json` 与经日志写入器在应答或记录当时追加的 `运行日志.jsonl` 行
（N6 决定、`test_run` start/case/complete 与 superseded）视为权威，配置修订另以运行 journal 为准。`.reviews` 下的
`{testRunId}-execution.md` 执行报告是本地证据：逐例 verdict、静态结论、命令退出码和 browser 证据字段从中读取，
只与日志计数、case_blocked 行和用例契约交叉核对。刻意手改报告且保持计数一致（例如对调两个用例的 verdict）不在防御范围内；
重跑仍在同一代码上执行全部用例，此类改动最多多占一个 QA 轮次，不能伪造 PASS。

旧版本把作废任务的用例也排进了 feature 完成时的 QA，会话只能回答 BLOCKED（功能已隐藏），整轮 BLOCKED，项目门禁随之
拦住其他运行的收尾（`project_qa_not_passed`）。这样的轮次符合上面的重跑条件（会话回答的 browser BLOCKED、logic
INSUFFICIENT_EVIDENCE），在原运行上用原配置 `--mode resume … --allow-qa --rerun-blocked-qa` 再 `advance` 即可：先追加
superseded（`blocked_cases` 列出原阻断用例），新一轮按新计划只跑其余用例，作废任务的用例列入 `not_applicable`；
旧轮次的日志与报告不改写。新一轮 PASS 后原运行继续 context_refresh/finish，被门禁拦住的其他运行用原配置 `--mode resume` 再 `advance` 即可收尾。

QA 配置修订（`--revise-qa-config`）在该 run 尚无任何 `test_run` 行时也可使用，不限于 N5 之后：journal 追加
`qaRound: 0`、`testRunId: null`、绑定当时审查包（尚无则 null）的 `qa-config-revised`，运行日志写一次确定性的
`decision/qa_config_revise` 镜像，不写 superseded，首轮仍为 qaRound 1。回放允许首轮前多条 round-0 记录，但 round-0
不能出现在已消耗轮次的修订之后；恢复时若镜像缺失且已有 QA 轮次、或镜像位于首个 QA 轮次之后，均拒绝 `qa_revision_invalid`。
未决 effect、已取消或完成后代码漂移的运行仍拒绝 `qa_revision_not_completed`；首轮之后的修订规则不变。

若上一调用已有 `test_run start` 但没有 complete，默认仍是 `qa_execution_unknown`。
确认旧宿主已退出后，单任务宿主可用原配置、原身份和新授权显式恢复：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume \
  --host-context current-host --allow-development --review-config review.json \
  --workflow-config workflow.json --allow-qa --rerun-unknown-qa
```

保留原运行需要的 runtime、保护及审查配置选项；收到 host_ready 后发送原 advance。
`--rerun-unknown-qa` 是本次恢复授权，不改变持久配置指纹；create、缺少 allow-qa 或配置漂移拒绝。
仅最新调用无 complete、已记录 case_complete 的 result 全为 PASS（允许零条）、无 case_blocked、
无固定报告 `{testRunId}-execution.md`（或报告 `Overall: PASS` 且逐行 PASS 有权威依据，见下文 `qa_execution_unknown` 的处理），且原资源门禁确认无清理欠账时可重跑。
日志先写 `test_run/abandoned`（`previous_test_run_id` 为旧 ID，`reason: host_terminated`、
`partial_pass_cases: [caseId…]` 记录旧 PASS 用例，零条时为空数组），
再以新 testRunId、同一 qaRound 执行整轮；不复用部分用例，也不重跑开发、Review 或改变任务 attempt。
写 abandoned 后、写新 start 前崩溃可再次显式 resume；旧调用永远不能成为 complete 或 QA 通过证据。

整轮因 `qa_execution_timeout`（或宿主退出）中断、已记录的非 PASS 用例全是「宿主请求超时、会话没有应答」的 BLOCKED 时，
同一 `--rerun-unknown-qa` 也能恢复：无 complete、无固定报告、无 FAIL，每条 `case_blocked` 都没有 `host_declared_blocked`，
且带 `host_request_timeout: true`（当前执行器写在每条 case_blocked 行上）；旧版本写的行没有该字段，
只有其 `case_start` 到 `case_blocked` 的间隔达到 `qa.timeoutMs`（日志按秒取整，容差 1 秒）才算超时。
日志写 `test_run/superseded`（`reason: host_request_timeout`、`timed_out_cases`、`partial_pass_cases`、`request_timeout_ms`），
新 testRunId 在 qaRound+1 重跑全部命令与用例，start 以 `previous_test_run_id` 链接；回放按同一规则复核该行，旧行原样保留。
会话自己答 BLOCKED、任何 FAIL 或其他原因的 BLOCKED 仍是 `qa_execution_unknown`。对这种调用误用 `--rerun-blocked-qa`
会被拒绝为 `qa_rerun_unknown_qa_required`，提示改用 `--rerun-unknown-qa`。
新轮完整结果仍须满足原报告文件、cleanup、context_refresh 和 finalizer 合同。
任一 FAIL/BLOCKED 即使证据文件后来消失仍拒绝重跑；旧 PASS 证据文件只作历史保留。
原事故已有三个浏览器 PASS，可经显式授权重跑全部用例，不能跳过这三个用例。

宿主 JSONL 驱动必须排空一个数据块内所有完整行（通常用 continue 处理下一行），
不能在 host_response 分支提前 return。合成验证显示同步 accept 本身正常；提前 return
可使 TC-003 确认后的 TC-007 留在缓冲区，双方互等。请求看门狗限制等待，但不替代驱动修复。

### 独立 QA 修复入口

`cm-fix-host.mjs` 配置可带 `qaSource: {feature, identity, packageDigest, testRunId, handoffDigest}`，
取自本次失败交接，其中 identity 是父任务身份。使用 `runtime/js/cm-fix/qa-source.mjs` 的
`qaFixIdentity(qaSource)` 生成子配置 identity，不复用父任务身份，也不允许为同一次 QA 更换
子 runId 重派。报告或策略变化不生成新的子身份；已有子配置指纹仍不可改写。

启动前关闭父 host（`host_close` 或 EOF，并等其退出释放锁），再启动原 cm-fix host，
追加 `--allow-qa-fix`；复现、修复、Review、收尾仍各自需要原有授权参数。
原 specs 级单写者锁拒绝父子重叠。打开子运行前及持锁登记前重新核对最新失败、项目路径、
报告摘要和策略；CLI 后续业务操作也复核来源。来源失效时拒绝执行，不静默转为普通修复。
来源保存在原 fix 配置/快照中，无第二状态库。它不授予 provider、安装或 Git 权限。
原 `fix_diagnose` 回调现在收到 `qaFailure`，包含绑定交接与报告精确字节（contentBase64）；
读取沿用 no-follow 有界证据读取器并复核摘要。首次与观测恢复诊断都带这些材料，并明确
标为证据数据而非执行指令。诊断返回后再次复核来源；期间报告或策略漂移不登记成功结果，
原未完成 intent 保持 unknown，不自动重发诊断；本地诊断可按上文显式放弃并重做。

当前接通的是子运行创建/恢复和原修复入口；父 host 的自动暂停/恢复、已完成修复证据消费、
修复后的代码批准关联与自动重测仍未实现。来源失效后本入口拒绝 reopen，不删除旧快照或
改写历史完成事实；不能把这一步称为完整自动修复闭环。

`completion_evidence` 是原 cm-fix owner 的只读完成证据出口：只有原 finish 已完成、
当前证据仍通过原投影和 N5 门禁时可读取，返回实际完成 attempt 的 Review package、
handoff/审查摘要、完成事件 ID、原快照 revision 和可选 qaSource。第二次修复返回 a2 的
证据，不拿 a1 的批准代替；尚未完成或文件漂移时拒绝。它不写日志、不发布凭证，也不完成
父任务。父自动重测尚未消费此证据；读取必须从受信原 owner 重核，不能接受任意 JSON 自报成功。

父 `cm-ai-host` 可通过 `--qa-fix-owner-config PATH` 启用只读 `fix_status`：文件为原子运行的
`{specsRoot, identity, configuration}`，configuration 必须与创建该子运行时完全一致，包含
hostContextId、qaSource 及已配置的复现/修复/审查选项；不能通过消息传配置或改变子权限。
消息沿父协议传 `version:1, requestId, operation:'fix_status', identity, packageDigest, testRunId`。
父状态须保留该任务完成历史；入口核对固定来源，关闭父 writer，仅 resume 已有子 owner，
读取其当前状态或原 completionEvidence，关闭子 owner 后重新打开同一父运行。读取失败也
尝试恢复父 owner；恢复失败保持不可用，不继续写。读取操作不改运行日志/指针、不触发修复。

返回 `qa_fix_incomplete` 或带原证据的 `qa_fix_completed`；后者仅表示子修复证据已读取，
只读 fix_status 本身不登记、不启动重测，也不改变父批准摘要；完成登记后的消费见下文。
修复命令/测试的语义配置仍由宿主提供；来源自动绑定与健康阶段连续执行见下文模板入口和 fix_run。
不能把只读返回当父任务完成结果。

增加 `--allow-qa-fix-start` 后可发送同一绑定格式的 `fix_advance`。它在释放父锁后为固定
子身份自动选择 create/resume，复用原 Learning、复现及诊断，不新增派发状态库。
子 runtime 须匹配当前宿主。新建子运行时，配置 hostContextId 只能是当前真实会话或已通过父运行指纹校验的创建会话；
已有子运行沿用存档配置并校验指纹。打开子运行（含 fix_status）和签审查授权都使用当前真实会话，
首次签授权前由 cm-fix 追加 fix-host-joined-N；只读打开不写接手记录，原因审查员不能是当前会话。
父运行同会话恢复可省略 `--original-host-context`；换会话仍须提供创建运行的会话 ID，缺少时配置指纹校验拒绝。仅配置文件或 auto_fix 策略不能替代原逐项授权。
重复调用继续原状态，不重做已结束步骤或重发 unknown。执行期间 status/cancel 交给原子
owner，操作结束后恢复父 owner。该入口只接到原 red_test_required 等后续阶段，不授权
测试编写、修复写码、provider Review 或 finish；后续动作使用下述独立权限，自动重测仍待接线。
复现命令会实际执行且写原修复日志/运行指针；与只读 fix_status 的边界不同。

父请求 `fix_action` 使用相同父绑定，并增加 `fixOperation`。父入口与独立 cm-fix CLI
现在共用 `runtime/js/cm-fix/host.mjs` 的原动作分发，不复制红灯/修复/Review/收尾逻辑。
父 CLI 可分别传 `--allow-qa-fix-red-test`、`--allow-qa-fix-baseline`、
`--allow-qa-fix-regression`、`--allow-qa-fix-learning-writeback`、
`--allow-qa-fix-walkthrough`、`--allow-qa-fix-finish`；均还需启动授权，且原配置、
状态及门禁必须满足。消息不能夹带 authorized/配置来加权。原 package 读取、交接/档案
发布及 gate 操作也走共享分发，返回 actionResult；不增加一套生命周期。

受信 in-process 宿主可传原 fixExecution/fixPermissions/fixAuthorities 接入已有适配器；
父 CLI 使用独立 `--qa-fix-review-config PATH` 装配相同工厂，并分别要求
`--allow-qa-fix-test-author`、`--allow-qa-fix-repair`、`--allow-qa-fix-cause-review`、
`--allow-qa-fix-final-review`。原子配置的 causeReview 元数据必须与本次装配精确一致；
不能给已创建的子运行临时换模型、provider 或配置。启用动作前核对对应 runtime 的原
stdin 诊断；仅装配不调用 provider，调用仍经过原登记与 grant。
父 `--review-config/--allow-review-attempt` 不授予子 Review 权限，根因/最终 Review 权限也
互不代替。fix_action 仍只执行选定原动作，不表示整条修复和重测已自动化。

本地组合 `scripts/cm-ai-fix-integration.test.mjs` 使用真实父/子 owner、原日志/任务门禁，
在临时项目中从父任务完成及 QA FAIL，串到子修复、独立合成 Review、回归、走查和 finish，
再由父读取同一完成证据。开发/Review 回调为合成实现，不是 live provider 证明。
代码修复后父原完成历史和批准摘要保留；修复尚未完成登记时，`advance` 停在 correction_review_required，
不会把原批准变成新代码批准。父恢复后先核对子完成包与自身原批准的
变更组合：核对每项 before 及当前全代码快照，成功附 association，不能解释的代码变化
返回 qa_fix_code_unmatched。单独的只读关联不授予权限；完成登记后的重测消费见下文。

已通过原完成门禁的子修复，可以在后续 QA 轮次开始或通过后继续读取原 completion_evidence。
这复用原日志与固定 handoffDigest，不新增状态库；报告、策略或项目绑定变化仍会拒绝。
未完成子运行和任何新的修复动作继续要求最新失败，历史读取不能重新授权旧修复。

原 child finish 成功后，父宿主恢复原锁，再将已核实的子完成证据和代码关联登记到原
V3 journal 的 qa-fix-accepted 记录。只读 fix_status 不登记；重复相同完成证据不新增记录。
最多两次子修复按 QA 失败轮次顺序累计，恢复时复用原 journal 校验，不修改历史批准或 tasks。
父流程现已消费该登记：每次重新核对原失败 handoff 及累计代码快照后，允许原 advance
对匹配的最新失败执行下一轮 QA（最多三轮）。结果不明不重发；再次失败且无新完成修复时不再开轮。
QA 通过后复用原 context_refresh、文档核验和 run_finalize；未登记修复或代码再漂移仍阻断。
本地组合已覆盖两次完整子修复和第三轮 QA：通过后原 N7/N8 收尾，失败返回 qa_round_limit，重启不派第四轮。
第二个缺陷需要不同命令或测试时，仍由可信宿主明确提供配置，不从失败报告文本猜测。

`fix_run` 使用与 fix_advance 相同的父身份、packageDigest、testRunId 绑定，并需要
`--allow-qa-fix-start`。它在同一原子 owner 中连续执行正常阶段，各动作仍逐项检查对应
flags、配置与原门禁；完成后恢复父 owner 并登记修复证据。未知、阻塞、观察、需修订阶段
或状态不再推进时停止，不反复重试，不自动授予缺失权限。它本身不调用父 QA；之后由原 advance 重测。

也可在首次 QA 前使用 `--qa-fix-template-config PATH`，与 `--qa-fix-owner-config` 互斥。
文件格式为 `{specsRoot, feature, identity, configuration}`：identity 是父任务身份，configuration
是原修复配置，但不含 qaSource。模板 identity 可保持运行定义的初始尝试；实际请求只可在同一
repo/run/task 的原两次尝试内前进，日志和父状态仍核对实际尝试。每次 fix 请求沿用父 packageDigest/testRunId，JS 从原日志
最新已完成失败生成固定子身份和 qaSource，再走同一个原 owner。模板在宿主启动时读取并快照化；
不会随文件变化自动扩大配置。命令、scope、模型及动作权限不从报告产生，也不在绑定过程中改写。
旧轮次、未完成 QA、第三轮失败会拒绝；同一失败仍对应同一 child，改模板不能绕过已建运行的配置指纹。
因此新失败的身份/来源绑定可自动切换，但新缺陷所需的复现命令、测试选择等语义配置仍需宿主提供。

显式加 `--auto-qa-fix` 可将父 `advance` 衔接为 QA 失败 → 原 fix_run → 原重测 → N7/N8。
它必须与模板配置和 `--allow-qa-fix-start` 一起使用，且项目 `policies.auto_fix` 必须为 `auto`；
`explicit` 或 `never` 策略不会被这个开关覆盖。每个动作仍需对应权限和配置，不新增 provider grant。
整个推进期间只接受状态/取消控制，拒绝并发业务操作。取消、未知结果、阻塞、未完成修复或
模板无法复现时停止；不超过两次修复/三轮 QA。正常手动入口和默认行为不变。

本地 CLI 组合现已覆盖 Codex 和 Claude 两个 runtime：首次启动前无 QA 日志，经过 JSON
宿主消息、开发、原审查、真实临时命令 QA 失败、模板自动修复、原独立审查与完成门禁、
QA 重测通过及 N7/N8；重启只重新核验文档，不重复开发/修复/QA，父 run_done 仅一条。
该证据使用真正 CLI 子进程和仓库内合成 reviewer 可执行文件，Learning/开发/诊断/修复等
宿主回答由 fixture 提供，不是实际模型或已安装插件的运行验收。

## 项目规则文件的修改通道

开发者 scope 不能含受保护路径：`AGENTS.md`、`CLAUDE.md`、`.claude/`、`.codex/`、`.git/`、`.reviews/`、`tasks.md`、`运行日志.jsonl` 和 `.cm-*`。
`cm-ai-host.mjs serve --mode create`、批量宿主（对每个将新建的成员）和 `openControlRun` 在建运行前用开发适配器的同一规则检查 scope，
命中即返回 `protected_scope`，`reason` 列出具体路径（批量前缀任务键）；检查在冻结模型/策略配置、加批次锁、写日志、建工作树之前，
此时不写 init、不写 intent、不建 `.execution/<runId>`。已存在的运行恢复时不受此检查影响。bootstrap 规范任务按原合同只把
它自己的规则目标交给宿主，其余业务 scope 仍按此规则检查。保护范围本身不放宽，developer 仍不能写这些文件。

已批准任务要求修改规则文件时，按内容走下列受支持的途径，不放进开发 scope：

- 首次生成或按 cm-init 模板重建规则：bootstrap 规范任务（见上文 bootstrap 一节），由宿主受控写入并交独立 Review。
- 任务教训：Learning 回写，由宿主写 `AGENTS.md` 的 `## 项目教训` 段。
- 其他规则内容（如「同步项目规则」的具体差异）：作为人工步骤，由用户本人或主会话按用户指示，在 CM 运行之外修改并提交。
  放在相关任务建运行之前（基线会记录新内容）或该任务完成之后；不要在运行进行中修改：`AGENTS.md` 属于审查快照，中途改动会被判为漂移。
  cm-prd 生成任务时把这类步骤单列为人工步骤并注明不进开发 scope。

加入建运行拦截之前创建、scope 含受保护路径的运行，第一次派发开发会停在 `unknown/execution_error`、`pendingAction: reconcile`，没有出口。
这类记录现在回放为确定的 `blocked/protected_scope`：判定条件是开发 effect 只有一次没有结果的调用、无审查包、无 Learning 结果，
且运行配置的 scope 命中受保护路径（开发适配器对这种 scope 总是在派发前拒绝）。原 journal 逐字保留，不追加、不改写。
之后按原门禁用新 runId 新建运行（从 scope 移除受保护路径）；旧运行已是 `blocked`，`--supersede-reviewed-evidence` 也接受它。
尚未派发开发的旧运行恢复后发 `advance`，宿主在派发前直接记 `blocked/protected_scope`，不启动开发调用。

## 文档核验与收尾

可信宿主现在可注入 `execution.documentationSync: {paths, run}`，将最后一个任务的
项目 Markdown 文档写入放在原 developer 调用成功后、检查/Learning handoff/Review 之前。
`paths` 必须已属于任务批准 scope；`run(request, signal)` 只写收到的路径并返回
`{status: "completed"}`。写入前后使用原快照检查代码根的非文档路径没有变化。
该宿主回调不得发起新模型调用或改 specs；不增加 developer 之外的作者上下文。
`AGENTS.md`、`CLAUDE.md` 和保护目录不通过此接口放开，主执行者指令写回仍按原合同。
原持久 developer 调用承载取消、超时、未知结果及恢复；不另建文档任务或重发状态。
所有 feature 仅剩当前任务时才执行，文档已是最新可不改；结果与代码进入同一审查包。

上下文返回全部完成后，`advance` 自动调用原 `finish`；文档确认通过才调用原
`run_finalize`。没有可信文档结果时返回 `documentation_sync_required`，不写 run_done。
宿主可注入既有 `documentationResult` 或只读的
`documentationProvider: {inspect, timeoutMs}`（1–60000ms），不可同时提供。
`inspect(request, signal)` 接收 specs/code 根、feature、当前 identity/packageDigest/contextDigest
及 JS 生成的稳定 `syncId`，返回既有完整文档结果。核验应覆盖 N8 所需文档、交付
和发布待决材料；需要改写或缺少证据时返回 `blocked`，不能用文本批准代替实际同步。
该回调不得修改文件、外发、提交或发布；本次没有新增完成后的文档写权限。

JS 对返回结果重新核对任务包、上下文与 QA 证据，取消/超时后不采纳晚到答复；
通过结果只在当前 entry 内复用。重开会再次只读核验，稳定 syncId 使原 writer 去重
run_done；这不重复执行文档写入，也不创建第二份持久状态。
N8 发现仍需修改 README/AGENTS/项目文档时保持阻塞，经批准任务回到 Review 前处理；
本地合成核验通过不代表完整 N8 或真实项目验收完成。

## 验证和剩余工作

### cm-fix 无存量测试

没有旧测试、但可以新增缺陷回归测试的项目，可在原 baseline 配置中显式增加
`noExistingTests`（非空原因，最多1000 UTF-8字节），同时令 `testFiles`、`commands` 均为空；
`cwd`、`timeoutMs` 及原 CLI 的动作授权仍必需。具体启动示例见
`skills/cm-fix/references/js-host.md`。原有非空基线配置与历史格式不变。

这条路径不运行虚构的成功命令。原基线记录保留声明和空 observations，完成资格仍为 false；
原回归流程必须实际运行新缺陷测试并变绿。交接中 baselineDeclaration 标注
startup_host_declaration 和 existingSuitesExecuted:0，交给原最终独立 Review 核实。
JS 只校验声明及身份一致性，不证明测试目录已全面调查；已有旧测试或命令失败不能使用此分支。
恢复复用原基线、不重发已完成修复；取消、证据漂移、未知调用和最终完成门禁保持原行为。
无存量测试声明不替代纯视觉分支；纯视觉、裸项目、bootstrap及同仓保护使用本文各自显式配置，平台证据以“当前支持”为准。

### 多任务可信宿主入口

`scripts/cm-ai-batch-run.mjs` 导出 `createCmAiBatch({configuration, executionFor, logHome})`。
configuration 固定为 `{version:1, repositoryId, batchId, specsDir, codeProject, tasks}`，
另有可选 `parallel`（见下节「并行组」）和可选 `codeProjects`。
tasks 每项为 `{feature, taskId, scope, requirements}`；首项是本批次起点，之后按原
admission 返回的下一任务推进。根路径须规范绝对路径，未列入批准清单的下一任务停止，
不推测 scope。`executionFor` 只由可信宿主提供，负责零副作用地组装每任务执行适配器，
不能在组装时派发模型或写项目。所有子任务复用现有单任务主入口与完成门禁。

调用 `handle({operation:"advance"|"status"|"cancel", requestId})`；开发调用、QA、
文档核验的等待/失败直接返回，不跳过。仅原上下文刷新明确返回 `start_next_task` 时，
调度器才写项目原日志中的 `decision/batch_handoff` 并进入下一任务。
`batch_start` 绑定整批配置；交接绑定子store revision与packageDigest。恢复重新核对
历史完成、最新QA及资源闭环，再恢复没有交接的任务，因此checkbox完成不等于可以跳过。
取消记录在同一日志，重开不自动重发。没有新增任务状态数据库。

批次ID与task-run ID分开：每个任务的稳定子runId由batchId与feature/task派生；返回值
保留实际子任务identity并附batchId。最终run_done仍属于最后任务的原finalizer，
不伪造一条父run_done，也不把这项本地接线当作完整产品宿主/真实provider验收。
当前实现仍要求Node24.14+与原执行/平台能力；Linux准入已适配但缺原生端到端证据，原生Windows未接，独立CLI见下文。

### 并行组

可选 `parallel` 是「任务 key 数组」的数组，每个内层数组是一组同时开发的任务，
key 形如 `1.work/T-001`，与 `tasks` 的 `feature/taskId` 一致。省略该字段即全部串行。

每组必须同时满足，任一不满足整批拒绝启动：

| 约束 | 失败码 |
| --- | --- |
| 每组 2–4 个任务，成员不重复、不跨组复用 | `invalid_parallel_group` |
| 组内全部任务属于同一 feature | `parallel_feature_mismatch` |
| 组内任意两任务之间不存在依赖路径（按 `tasks.md` 依赖图的传递闭包判定） | `parallel_dependency_conflict` |
| 组内各任务 `scope` 两两不含相同路径 | `parallel_scope_overlap` |
| 该 feature 最后一个未 DROPPED 的任务不得进组，且必须在 `tasks` 内 | `parallel_final_task_excluded` |

末任务被排除，是因为成员 QA 会延后到它那里统一执行。

**执行方式。** 每个成员分到一个 Git 工作树与独立分支，由调度器创建：

- 工作树：`{codeProject}/../.cm-worktrees/{batchId 前 8 个字符}/{taskId}`
- 分支：`cm/{feature 去掉数字前缀}/{taskId}`，从 `HEAD` 创建

启动前对整组跑一次 `check-parallel-write`。成员各自完成开发、检查与审查后在自己
分支提交，再由调度器按任务顺序逐个 `git merge --no-ff` 合回主 checkout——**合并是串行的**，
合并完成后移除该成员工作树。首次推进前主工作区必须干净（含未跟踪文件），否则整批停止
并列出文件；被阻断的成员保留其 WIP 提交与原因，不自动丢弃。

**QA 延后。** 成员的 N6 自动记为 `skipped`（`reason: parallel_member_deferred`，固定评分 4），
不逐任务跑 QA；整个 feature 的 QA 在末任务触发一次，覆盖合并后的结果。

**并行的边界。** 当前会话通道一次只接一个工具调用，成员的开发请求按序排队，
第二个成员的 `develop` 只在第一个被应答之后才发出。真正重叠的是成员 runner 的状态推进
与各自的独立审查进程，**不是写代码本身**；使用者不应据此预期成倍提速。要让编码真正并发，
需要为成员配置各自的 provider 开发派发，而不是依赖当前会话。

**前置条件。** 并行成员会在各自工作树里单独跑一次 review preflight，因此 `--review-config`
是并行的硬前置：缺它整批立即以 `review_preflight_failed` 停止，一行代码都不会开发。
串行批次没有这个要求。

**提议方。** 由 N1 决定哪些任务成组，规则见 `skills/cm-ai/references/js-host.md` 第 3.1 条。
组不起来就省略该字段，正常串行；不为组而组。

### 当前会话多任务 CLI

`scripts/cm-ai-batch-host.mjs` 将同一个当前会话通道接到上述 createCmAiBatch，
没有第二个调度循环。配置文件包含 `{batch, workflows}`：batch 是上述完整原配置；
workflows 的键与 batch.tasks 的 `feature/taskId` 一一对应，值为单任务 workflow 配置或 null。
例如两个键为 `1.login/T-001`、`1.login/T-002`；不能漏项、夹带其他任务或通配权限。
将 README 等文档写入配置放到最后任务，路径仍须属于该任务原 scope。

```bash
node scripts/cm-ai-batch-host.mjs serve --config /absolute/batch.json \
  --host-context actual-current-conversation-id --allow-development \
  --review-config /absolute/review.json --allow-qa \
  --allow-review '1.login/T-001:1'
```

review.json 与单任务入口相同；有 QA 配置仍必须获得对应命令/工具授权再加 allow-qa。
每个 allow-review 只传递已取得的那个 feature/task/attempt 的 Review 授权；可重复列出
多个明确获准条目，不能把一次授权套给其他任务或第二轮。未列出的审查仍停在待审，
不是全批取消。恢复重新启动同一配置和 host-context，列出此时实际获准的条目即可；
没有 create/resume 切换，也不删除或重置记录，原 batch 根据原 journal 恢复。

控制请求只有 `{"operation":"advance","requestId":"a1"}`（或 status/cancel），
子任务 identity 由原 batch 生成并随结果返回。host_ready/request/result/close 与单任务相同；
每个工具请求携带真实子任务 identity，必须按当次请求处理，不能复用前一任务结果。
只在 QA/上下文完成后交接，最后仍由原 finalizer 产生唯一 run_done。显式取消沿原日志持久阻断，
重开不自动恢复；整个 workflows map 绑定原 child 配置指纹，未来任务配置漂移也不能悄悄采纳。
本地双任务 CLI/真实命令与文档/合成 reviewer 的恢复组合已通过，不是实际模型或双宿主验收。

#### 启动与推进的前置条件

下列四项不满足时，现象都不易从返回值直接看出，逐条核对可省掉一次排查：

- **每个任务都要有 `qa` 配置，不只是末任务。** `workflows[key].qa` 为 `null` 时
  `createHostWorkflowCapabilities` 不装 `qaDecisionProvider`，该任务开发与检查完成后
  QA 决策恒为空，状态停在 `fixture_completed / qa_decision_required`，**批次不会自行推进，
  再发 advance 也没有反应**。需要某个任务不跑 QA 时，仍给它 `qa` 配置，由评估结果决定跳过。
- **适用测试用例需要交互 QA 时必须显式传 `--browser-qa available|unavailable`**，
  包括 QA 环境的 `browser`、`ios-simulator` 等载体；错误原因会列出该 feature 的载体。旗标名称保留兼容；这是声明不是探测，创建与恢复都要重新给。
- **首次推进前主工作区必须干净，含未跟踪文件**，否则 `batch_main_dirty` 并列出文件。
  上一批次的产出未提交即会触发。
- **`batch.tasks` 的首项必须等于准入的 `nextTask`**，否则 `task_selection_mismatch`。
  上一轮已把某任务标完成时，新批次要从下一个未完成任务起，不能沿用旧任务清单。
  `--allow-review` 列出的条目也必须落在本批次任务集合内，否则启动即 `review_task_mismatch`。

`review_transport_timeout` 且无结果返回时，状态会带 `pendingAction: "resume"`；
`review_provider_failed`（审查 CLI 未登录、限流、过载、模型不存在等且没有结论）与 `review_verdict_invalid` 同样如此。
此时应按该提示走恢复并重新给出审查授权；继续发 `advance` 会消耗掉这次机会，
随后状态转为 `blocked / pendingAction: none`，只能换新 `batchId` 重来。

### `pendingAction: "reconcile"` 时该做什么

新建单任务运行的代码根快照固定忽略 `.DS_Store`、`._*`、`.AppleDouble/`、`Thumbs.db`、`xcuserdata/`、`*.xcuserstate`、`.build/`、`.swiftpm/`、`DerivedData/`，并用固定环境下的 Git ignored 结果跳过被忽略目录；Git 不可用或结果超限时只用固定列表并在基线标明。任务 scope、AGENTS.md 和 specs 仍检查：Git 可用时单独查询 ignored AGENTS.md，缺 Git 时只扫描被跳过目录的名字以寻找 AGENTS.md，不读取其他文件内容。基线记录有界的忽略决定；恢复、审查与完成时将基线和当前决定的并集用于两侧比较。**这是有意缩小的检查面**：被忽略的构建产物与 IDE 状态不作为代码审查证据；旧 journal 仍按原策略回放。

`reconcile` 的意思是**这一步的结果未知**——不是失败，也不是成功，JS 拒绝替你猜。
它只有两个来源：

| 状态 | 含义 | 恢复路径 |
| --- | --- | --- |
| `blocked/develop_checks_not_passed` | 开发检查失败或不可用，审查包未生成 | 根据 `reason` 的 id 和证据修复环境，在原 run `advance`；不消耗审查轮次 |
| `blocked/checks_not_passed` | 旧运行的已审包在完成门禁发现失败检查 | 终态；不得重新开发 |
| `blocked/check_output_out_of_scope` | 检查新增了范围外产物 | 移走产物并改检查输出路径，在原 run `advance`；新 develop effect id 重做 |
| `blocked/completion_checks_changed` | 已审包的完成前复查结果变化 | 修好检查环境，在原 run `advance` 或 `complete`，保留原审查回执；complete 不占六个 effect 名额，与 `completion_package_changed` 合计最多重试 3 次 |
| `blocked/completion_retry_limit` | 完成前复查第 4 次仍被拦下；运行器写入 `completion-retry-limit`，没有新的 complete intent | 终态；按 `reason` 修好检查环境（不稳定的检查、在代码根生成新文件的命令），用 `--supersede-reviewed-evidence` 新建运行 |
| `state: "unknown"` | 某个有副作用的步骤抛了异常或返回了无法判定的终态，做没做成不确定 | 单任务 V3 审查调用已登记、无结果时可用下述 `abandon_review`；其他情况见下 |
| `state: "unknown"` + `execution_error`，`pendingAction: "reconcile"`，且 stderr 显示驱动未应答 `init_generate`／`init_verify` | 驾驶员断联，原 develop effect 结果未定；旧版驾驶员可能错误退出 0 | 先核对原 host 与子进程及代码根实际写入；仅满足下述 pending effect 条件时在原 run 用 `abandon_effect`，之后按原新运行门禁使用当前会话宿主路径；不要原样重发 `advance` |
| `blocked/develop_checks_not_passed`，bootstrap 规范任务 | 规范已写入，`PLAN.checks` 未通过 | 修好检查环境后在原 run `advance`；同一轮以原答案重试，驾驶员与宿主只接受本运行存档记录的那次写入，他人改动先还原 |
| `blocked/bootstrap_verification_failed`，bootstrap 规范任务 | 当前会话宿主路径中 `init_verify` 有核验组不是 verified/not_applicable 或缺证据；宿主在写入规范前停止，`reason` 列出未通过的组与证据 | 本轮规范文件未写入，本运行的 Learning 与已记录规范证据保持不变。按证据修正项目或生成内容后在原 run `advance`：同一轮新 develop effect id 重新询问 `init_generate`／`init_verify`，宿主只接受磁盘文件仍与本运行已记录哈希一致（第 1 轮尚无写入时为不存在）；占用计数调用与 effect，受 `develop_retry_limit` 约束。`constraintChanges` 非空或回复结构错误仍停在 `unknown`。旧版本记录的 `unknown` + `bootstrap_verification_blocked` 按原样重放，不改判。单步驾驶员在启动宿主前实跑命令，未通过不会进入宿主 |
| `blocked/protected_scope` | 任务 scope 含受保护的规则或工作流文件；开发在派发前被拒绝，未写入文件。旧版本创建的运行原记为 `unknown/execution_error`，现按原记录回放为此状态 | 终态；从 scope 移除 `reason` 列出的路径，按原门禁用新 runId 新建运行；规则文件走「项目规则文件的修改通道」 |
| `state: "unknown"` + pending develop/complete intent（后面可有 control 记录） | 宿主在 effect intent 后、checkpoint 前退出 | `pendingAction: "abandon_effect"`；核对旧 host 与它启动的进程后，在原 run 显式退出 |
| `state: "unknown"` + pending review intent，尚无 host-joined／review 登记 | reviewer 启动前退出 | `pendingAction: "abandon_effect"`；确认旧 host 已退出后在原 run 显式退出 |
| `state: "unknown"` + 已登记且无结果的 review invocation | 审查调用未完成 | `pendingAction: "abandon_review"`；核对旧 host 和 reviewer 进程后在原 run 显式退出 |
| `state: "unknown"` + `transport_timeout`，结果已入 journal 且有最终消息 | reviewer 给出最终消息后被超时截断，结论从未被接收 | `pendingAction: "abandon_review"`；确认 reviewer 已退出后在原 run 显式放弃这条结果，再按一次重派恢复 |
| `state: "blocked"` + `develop_retry_limit` | 可重试的开发阻断反复出现，剩余调用名额已不够再交付一次并送审，或剩余 effect 名额已不够交付并送审（complete、QA 与文档不占 effect，已批准的运行总能进入完成）；运行器在派发开发前写入 `develop-retry-limit`，没有 intent、没有开发调用 | 终态；按 `reason` 中上次阻断原因修好根因，用 `--supersede-reviewed-evidence` 新建运行 |
| `state: "pending_review"` + `review_provider_failed` | 审查 CLI 没给结论就失败（`reason` 首段为类别，如 `reviewer_auth_failed`） | 按 `reason` 先登录或等额度，再带本轮审查授权恢复；同一 attempt 只重派一次 |
| `state: "pending_review"` + `review_verdict_invalid` | 审查答复违反 verdict 规则（`reason` 首段为具体代码） | 带本轮审查授权恢复重派；同一 attempt 只重派一次 |
| `state: "fixture_completed"` + `code: "qa_execution_unknown"` | 一次 QA 调用没拿到终态，工具可能还在跑或已被中断 | `--rerun-unknown-qa` |
| `state: "blocked"` + `code: "review_package_changed"` | 独立审查已返回 verdict，但代码根在调用期间漂移；reason 列出路径 | 清理或还原后在原 run 继续 `advance`，不再调用 reviewer |
| `state: "blocked"` + `code: "completion_package_changed"` | 完成复核时代码根或证据漂移；reason 列出路径 | 清理后在原 run 重发 `complete` |

**`reconcile` 不是一个可以发送的操作。** 三件事都不管用，而且会让情况更糟：

- 带 `identity` 发 `advance` → `invalid_input`；
- 不带 `identity` 发 `advance` → 原样重放同一个 `reconcile` 状态。这两者交替出现，
  按「同一个响应码连续出现才算卡住」做的空转检测会被交替清零，驱动可能空转到上限。
  **判定卡住应当只看 `pendingAction`，不要看错误码。**
- 换 `batchId` 也不一定管用：批次任务的 `runId` 是 `task-{digest({batchId, task})}`，
  换批次号确实会换 runId、拿到全新日志，但如果真正的阻塞物在批次外（例如
  `.reviews/` 下上一次运行留下的文件），换号无济于事。

**`state: "unknown"` 的处理顺序**：

1. 先看宿主进程的 stderr。被塌缩成 `execution_error` 的失败会在那里留下一行
   `{"diagnostic":"execution_error","code":…}`，多数情况足以定位（例如 `EEXIST` 会
   带上冲突的 `path` 与 `dest`）。
2. 若是单任务 V3 journal 停在 `review-invocation-registered` 或 `review-invocation-started`，且没有
   `review-invocation-result`，先确认旧 host 和 review 进程都已退出，再按下述命令在**原 runId** 上
   发送 `abandon_review`。若 develop/complete 的 `effect-intent` 后仅有 control 记录，先确认旧 host 与它启动的检查、构建进程均已退出，再用下述 `abandon_effect`。review 的 `effect-intent` 后尚无 `host-joined` 和 `review-invocation-registered` 时，也可确认旧 host 退出后使用 `abandon_effect`；一旦登记 review，改走 `abandon_review`。这是操作员对进程已退出的确认；宿主无法自行验证。
   provider-mode 开发和已写 `task-commit-intent` 的运行不能走 `abandon_effect`。先核对 `tasks.md` 是否已改名或勾选、提交回执及旧进程，再按原提交恢复路径处理；不要猜测提交未发生。`review_package_changed` 和 `completion_package_changed` 是有路径的可恢复阻断，先清理或还原后继续原运行；`develop_checks_not_passed`、`check_output_out_of_scope` 和 `completion_checks_changed` 属于上表可恢复的 blocked 状态，先走原运行；旧 `checks_not_passed` 为终态。旧版驾驶员在 bootstrap T-002 的 `init_generate` 断联并返回 `unknown/reconcile` 时，也先按原 journal 核对 pending develop intent、旧进程和实际指令文件；符合条件才在原 run 显式 `abandon_effect`，然后按新运行的旧证据、代码漂移和 writer 门禁重新建 run，并改用当前会话宿主应答。其他未知状态按诊断处理真实原因，核对无未结操作后再考虑新的运行；旧 unknown 不会被自动重分类。
3. 不要手工改写执行日志或伪造一个终态。已完成的提交、已登记的审查记录都不因此作废，
   重跑是从该任务重新开始，不是从整个 feature 重新开始。

**`qa_execution_unknown` 的处理**：按上文 `--rerun-unknown-qa` 的条件恢复。
它只接受「已记录的用例结果全部 PASS，且没有定稿执行报告、或报告为全 PASS 并逐行有权威依据」的未完成调用，
以及整轮超时中断、非 PASS 只有宿主请求超时 BLOCKED 的未完成调用（进入下一轮）；
其他 FAIL/BLOCKED 或资源未关闭的仍然拒绝，不会伪造通过。

质检执行结束时运行已不是原状态（例如执行期间范围内文件被改，状态变为 `correction_review_required`）：
宿主先把本次调用观察到的 BLOCKED 或 FAIL 写成 `test_run/complete`（漂移时为 BLOCKED、各行 `sourceChanged`），再返回 `stale_qa`；
把代码还原到审查包后，按已完成的 BLOCKED 用 `--rerun-blocked-qa` 重跑。观察到的 PASS 不在状态已变时记为完成：
该调用保留为 `qa_execution_unknown`，任何读取方都不把它当通过；确认后用 `--rerun-unknown-qa` 丢弃并重跑，前提是报告 `Overall: PASS`、
每行都是 PASS 且有权威依据（命令退出码 0、browser 的 `case_complete` PASS 日志行、契约已确认且映射命令都退出 0 的 logic）。旧版本在写出固定报告 `{testRunId}-execution.md` 之后、
写 complete 之前就返回 `stale_qa`，留下「有报告、无 complete」的调用（`qa_execution_unknown`）：确认旧宿主已退出、代码已还原后，
在原 run 用 `--rerun-blocked-qa` 恢复。宿主以该报告为本次结果（报告 `Overall` 须与逐行 verdict 一致），报告中每条 PASS 行也须有上述权威依据，按上段同一规则判定每条非 PASS 行，
superseded 行另记 `incomplete_report: true`，回放同样以报告复核；FAIL、无法判定的漂移行、`--qa-environment-failure` 均不适用。
日志不改写，旧调用保留原 start 与 case 行。

**单任务无结果 Review 的显式退出**（批次不支持）：保留原 `run.json`、review 配置及原 host 身份，
写一个 `abandon-review.json`；若原运行还用了 protected 或 workflow 配置，`permissions` 中也带上原配置参数。

```json
{"config":"run.json","mode":"resume","hostContext":"new-host-id","originalHostContext":"old-host-id","runtime":"claude","permissions":["--review-config","review.json","--allow-abandon-review"],"reason":"已确认旧 host 与 review 进程退出"}
```

```bash
node scripts/cm-ai-drive.mjs --plan abandon-review.json abandon_review
```

也可用 `cm-ai-host.mjs serve --config run.json --mode resume --host-context new-host-id --original-host-context old-host-id --allow-development --review-config review.json --allow-abandon-review --runtime claude` 启动原 run，向 JSONL 输入发送
`{"version":1,"requestId":"abandon-1","operation":"abandon_review","identity":{"repositoryId":"…","runId":"…","taskId":"…","attempt":1},"reason":"已确认旧 host 与 review 进程退出"}`。
`reason` 必须非空、单行、最多 500 UTF-8 字节；旗标只允许本次宿主调用一次，不进入配置指纹。
前提不满足时拒绝且 journal 不变。成功后追加绑定 effect、invocation、registered／started 记录摘要、
原因和时间的 `review-invocation-abandoned`，并写 `review_abandoned` 运行日志；旧记录保留。
同一操作也用于 checkpoint 已写入、状态为 unknown 且结果从未被接收的最近一次审查：被超时截断的最终消息，
或旧版本记为 unknown 且属于上述可重试类别的失败。此时记录另外绑定 `resultDigest`，原 invocation 记为 abandoned，
其 effect 不再占六个 effect 名额，被放弃的调用（含上述无结果登记调用）也不占六次调用名额；旧版 `timed_out` 且无 inspection、observation_invalid 与工具／上下文越界仍无此出口。
状态变为 `pending_review/review_abandoned`、`pendingAction: "resume"`。重新启动原 run 的宿主，带新的
`--allow-review-attempt 1`（第二轮用 2）并发送 `advance`；会取得新 grant、新 invocation。
同一 attempt 的 transport timeout 与 abandon 共用**最多一次重派**，额度已用完时拒绝 abandon。
旧 invocation 以后到达的结果不会被接受。若决定终止，在 abandon 后发送普通 `cancel`，
得到 durable `cancelled`；unknown 上直接 `cancel` 只报告原状态，不会声称已取消。

**单任务未完成 effect 的显式退出**（批次不支持）：适用于 develop/complete intent 后仅有 control 记录，或 review intent 后尚无 host-joined／review 登记且仅有 control 记录。保留原配置与 runId，确认旧 host 和相关子进程均已退出，再用 `mode:"resume"`、原 runtime 和 `--allow-abandon-effect` 启动原运行。driver PLAN 提供 `permissions:["--allow-abandon-effect"]` 及非空单行、最多 500 UTF-8 字节的 `reason`：

```bash
node scripts/cm-ai-drive.mjs --plan abandon-effect.json abandon_effect
```

原宿主也可接收 `{"version":1,"requestId":"abandon-effect-1","operation":"abandon_effect","identity":{"repositoryId":"…","runId":"…","taskId":"…","attempt":1},"reason":"已确认旧 host 和检查进程退出"}`。成功后 journal 在对应 `effect-intent` 与其后连续 control 记录之后追加 `effect-abandoned`，绑定 effect id、kind、intent 摘要、前一条记录摘要、原因和时间；运行日志写 `effect_abandoned`，状态成为终态 `cancelled/effect_abandoned`。不会重跑 effect、修改代码根或取消 `tasks.md` 勾选。没有 pending effect、已加入 host 或登记调用的 pending review、provider-mode 开发及已有 `task-commit-intent` 分别拒绝；已登记的 review 使用 `abandon_review`，任务提交已开始时须按上文核对。新建运行仍受 handoff 冲突、显式 supersede、旧 writer 与代码漂移门禁约束。

`node --test scripts/cm-ai-run.test.mjs` 验证真实 store 创建/取消/恢复和零 provider 调用；
另用真实 host/runner + 隔离假 developer 验证长任务期间的控制可达性。
这不是实际 provider 运行、跨平台完整支持或 P1/P2 总验收。

下一步：接实际宿主授权启动和工作区保护，修正普通项目目录约束，
再激活 Skill 入口及后续阶段调度。上述进程内组装不等于真实 provider 或实装验收。

## cm-prd：规格生成、需求变更与恢复

原材料在审查中途真正改变时，可经用户明确授权执行 `replace_inputs`，保留不可覆盖的旧批次记录并终止它；以 `--predecessor` 关联独立的新 specs 目录，从分析开始全量重审。旧批次只读，不继承旧批准；具体参数、恢复方式和限制见 `skills/cm-prd/references/js-change-recovery.md` 的“原材料改变”章节。

当前同一宿主支持新建、原C1–C8变更和已审整稿受控修订。操作及返回合同以
`skills/cm-prd/references/js-host.md`、`js-change-recovery.md`和CLI帮助为准。
`--change`后分析→需求→设计→任务/测试合同→自检→展示精确提案→当前用户decision→save_draft；
只写awaiting_review，不自动批准或开发。清单增删、已完成任务保护、用户用例特殊确认与旧审查历史保留由JS控制。
`--session`恢复私有问答/草稿/风险/轮次；unknown只接原宿主实际回执，不重发调用。
下方保留生成/审查子模块合同；旧单独模块“内存”指该模块本身，不否定当前CLI持久化。

### 设计先行阶段

已有整稿但尚未发起任一阶段审查，且原两轮自检尚有余额时，可发送
`{requestId,operation:"promote_design",draftDigest,reason}`，绑定当前整稿并说明真实风险依据。
JS将原稿需求/设计投影为同编号design_ready，原整稿和已用轮次保留；再走原风险选择、设计保存/审查/处置。
后续任务修订消耗原剩余自检轮次，并把旧整稿写入原selfCheckHistory，不重置计数。
已保存时要求整批完整、原文精确一致且0600；部分保存、用户改动、额外测试合同、design/split有尝试/证据/回执、
已审设计或轮次耗尽均拒绝，保留现场。promote_design本身不写文件或授权审查。
保存升级后的任务复用原替换操作；--allow-spec-write且当前设计处置/自检绑定有效时，先不可覆盖保存
`.reviews/prd-task-revision-{原draftDigest}.md`的原稿/新版，再仅替换tasks和既有测试合同；需求/设计保持当前已处置字节。
保存清单不增删，第三种内容或split已开始拒绝；异常留draft_save_unknown与归档，同会话原样显式重入可补缺，不自动重试。
归档不是审批；跨进程恢复用原session，已审整稿更改范围用prepare_revision进入需人审的C模式，不重置原审查。

首次full_draft生成期间发现原9.5风险，prd_generate可按payload.riskDiscovery返回status:design及整批需求/设计，
不包含tasks或测试合同。JS在同一会话转design_ready，保留原分析问答，不消耗自检轮次；
随后原select_design_reviews→save_design→需审feature审查/处置→tasks→自检/split/人审。
仅尚无整稿/自检历史/已处置设计时允许此转换；已有整稿的后续风险升级不得借此清空历史或重置轮次。
本地CLI合成回包验证首次生成转入设计后到awaiting_review，非真实语义风险发现证明。

design_ready 可发送 `{requestId,operation:"select_design_reviews",draftDigest,risks:[{feature,signals,evidence}]}`，
signals 使用原摘要的五项9.5布尔信号，evidence须非空且来自实际核对；覆盖当前设计全部feature，绑定精确draftDigest。
此选择每会话只设置一次，非审批或语义验证。命中任一信号的feature沿原design Review/处置；
全false的feature拒绝design调用、必须尚无任何design attempt/r1/receipt，且需求/设计保持保存原字节。
全部高风险处置完成后，同批advance生成所有feature任务；低风险无额外design凭证。缺选择的旧调用保持全部需审兼容行为。
选择由CLI checkpoint持久化；跨进程保留原值，不能据此降级既有审查、改写风险或重试。

analysis_ready 后可发送 `{requestId,operation:"plan_design",text:"真实设计要求"}`，复用 prd_generate，
payload.phase 为 design，只接受 requirements.md 与 design.md，不接受 tasks.md/test-cases.json。
疑问进入 awaiting_design_user，advance 携真实回答仍留在设计阶段，不能切到整稿生成。
design_ready 可沿原 final_review_package/final_review 的 design 阶段准备及审查，复用原唯一 r1/claim；
设计处置之前不放行 split、自检、save_draft 或任务生成。此阶段不写审批或完成状态。
design_ready 可用 `{requestId,operation:"save_design"}` 配合原 --allow-spec-write 保存需求与设计；
复用原整批冲突检查、不可覆盖0600发布及回读，不生成 tasks/test-cases，不以缺任务为由伪造占位文件。
相同内容可显式补缺，冲突拒绝保留用户文件，异常 design_save_unknown 保留现场，不自动重试。
设计修订处置后 advance 已接任务生成；不要手写文件或跳转整稿绕过。
设计两文件已可通过原 correct_findings 修订并由 review_disposition 写原处置回执；
仅原 design 包恰为需求/设计两文件时使用设计结构校验，不要求尚未生成的 tasks。
仍只允许修改 design.md，完整路径/逐项决定/UTF8/归档与恢复核对不变；已有整稿与 split 保留原机械自检。
设计结构检查不证明语义修复，后续完整规格仍需原10.5；处置完成不代表规格获批。
advance 从每个原 feature 的 design-r1 和已完成原 receipt 读取当前设计，要求需求正文仍等于原稿，
design 精确匹配处置哈希；冻结当前清单和证据，在生成、自检、保存边界重查。未处置或漂移不派生任务。
prd_generate phase=tasks_after_design 携 acceptedDesign，只允许增加 tasks/适用测试合同，feature顺序、编号、
需求和设计正文默认保留。仅整稿自检明确失败后，原重生成可附非空 selfCheckRevisionReason 修订
同清单内的需求/设计正文；不增删 feature 或文件。checkpoint 记录 selfCheckRevision，将原因、
前后 SHA、轮次与原失败记录绑定，保留历史和两轮上限。自检通过后 save_draft 先归档修订证据，
再保存新版；部分写入显式恢复，额外漂移仍拒绝。后续优先接受已完成 split 回执，其次已保存自检修订，
最后原设计基线。split 审修订版，不另发设计审查；摘要风险信息逐项说明原因、改动文件及审查边界。
未走该路径不新增 checkpoint 字段、绑定或回执。任务草稿继续原 split 审查和人审停点。
升级项仍留在原 finding/receipt 供摘要卡，不因生成任务变成已批准；语义判断仍是宿主报告。
Skill 已分流全部低风险与含高风险的批次（包括混合风险），设计后登记完整风险选择，仅高风险消耗design Review；
风险选择跨进程恢复与生成中新风险升级仍待收口。
本地实际 CLI 合成响应已覆盖设计生成→保存→设计审查/修订/处置→任务→自检/保存→split审查/处置→
高风险摘要→awaiting_review，两个阶段各一轮，不代表真实 provider、人工批准或开发完成。

### 当前会话 CLI：规格草稿、保存与审查（仍需人工审批）

`{requestId,operation:"prepare_summary"}`从磁盘读取完整manifest、当前规格、原design/split审查及处置回执，复用原mechanics生成任务/AC/测试合同计数与未勾选的人审清单。prd_summary宿主补交付形态、估时、开放问题、风险、上下文/平台/UI基准和逐feature的原9.5风险信号与依据。这些补充及语义风险判断是host报告，不是JS独立核验；缺失来源不可伪造。原split处置必须完成；命中方案风险时design处置也必须完成，已有未知design调用不能当低风险跳过。原回执必须覆盖阶段要求的全部文件。
evidenceDigest绑定完整feature清单、原状态文件和精确规格/审查文件hash，等待后重新核对；summaryDigest另绑定摘要全文，包括宿主说明、风险判断、blockers与清单。同证据重新生成不同摘要时，旧summaryDigest不能发布新稿。返回human_summary_prepared、blockers、readyForAwaitingReview，绝不等于人工批准。启用--allow-spec-write后发`{requestId,operation:"publish_summary",summaryDigest}`，只能消费当前宿主准备的精确摘要；核对仍有效后写原`.cm-specs-status`的awaiting_review/features/specFiles/testCases，保留原manifest语义。成功后写原spec_lifecycle generated/awaiting_review；本进程仅允许status/cancel与关闭，不顺势开发。写入不确定则返回awaiting_review_write_unknown，需检查现场，不自动重试。
当前run_done仍保守记incomplete，不把等待人审等同于已批准或开发完成；阶段计时及跨进程摘要恢复已由当前session接通。测试已由产品链路走到awaiting_review，宿主总结/提案/审查/上下文自检均为合成响应，不证明真实需求语义验收。

宿主以`--allow-spec-write`显式启用草稿保存后，可在当前上下文自检报告通过时发`{requestId,operation:"save_draft"}`。请求不携带文件内容或路径；analysis回读来源/配置并提供当前草稿，draft-save仅保存其feature三件套及可选test-cases.json。复用不可覆盖发布逻辑，整批预检冲突、逐文件0600保存、最终精确回读；不同内容与链接拒绝。draft_saved只证明原稿保存，不写审批状态，不完成任务。中途异常返回draft_save_unknown和已观察写入，保留现场；同一草稿显式恢复可补缺文件，不能覆盖已有不同内容。当前CLI通过原session恢复未保存草稿。

宿主可发`{requestId,operation:"review_findings",stage:"design"|"split",feature:"1.slug"}`只读原r1的结论、findings、原产物摘要及门禁状态，不需要内存草稿或重新派发。读取复用原publisher的完整校验与精确字节比较，缺失/损坏/身份错配直接拒绝，不修复文件。此入口只支持当前JS宿主归档；旧自由文本r1仍沿原门禁人工处置，不自动转换。返回review_findings_ready不是处置完成，未授权落盘、审批或任务完成。

显式`--allow-disposition-write`启用`{requestId,operation:"review_disposition",stage,feature,packageDigest,decisions,artifacts}`。decisions逐一覆盖原finding：`{id,status:"applied"|"escalated",evidence:[说明],changedPaths:[原包路径]}`；artifacts是原包完整文件清单与当前精确sha256。所有文件必须已经安全落盘；未解释的变化、未实改的applied、blocked审查、包身份不符均拒绝。design仅允许修改design.md；split采纳修正通过下述owner重跑原10.5，不接受JSON布尔值跳过。
`createPrdDispositionOwner`先核对原包/逐项处置/已存文件，读取当前规格运行原mechanics，再经现有prd_self_check请求宿主按原spec-self-check.md核对代码、用户用例及所有pending项。完整回包绑定冻结后的当前draft摘要；写原receipt前重读原r1及当前artifact哈希。机械/上下文明确失败仍写处置回执，返回disposition_recorded和self_check_failed；取消或漂移拒绝写入，不自动修复或重试。上下文仍是host报告，不是独立review。
修正自检的开始/结果保存为原.reviews中的固定`prd-{slug}-split-correction-check-start.json`与`...-result.json`，复用不可覆盖0600发布。绑定原package、当前规格正文/摘要、逐项决定与原review投影；先占用再请求宿主，先存结果再写原处置回执。相同输入的已存结果经原validator验证后复用：通过继续原门禁；失败保留原结果，记录待人工裁决回执；只有开始没有结果则disposition_self_check_unknown，不重发。损坏、权限异常或输入变化直接拒绝；这两份文件不是任务状态库或独立Review凭证。
新进程已验证通过/失败/中断前缀恢复且零宿主重调；覆盖的是这套新记录，升级前未留记录的在途调用不能据此推断未调用，仍需人工核对。记录不捕获整个业务代码工作树，宿主上下文语义仍是报告证据，不能把规格输入一致扩称完整项目无变化。无结果时的真实调用追踪和完整会话恢复仍待收口。
既有三类回执只有汇总计数，无法证明重入时每条finding仍分配相同处置。有findings的恢复返回disposition_details_need_verification及全部原findings，不把本次输入作为已保存决定、不输出未经核实的未决子集；需核对原逐项处置。零finding原样恢复可沿原already_recorded返回。
`review-disposition.mjs`调用原record/inspect，design回执绑定design.md，split绑定完整规格文件；无发现/全采纳/仍有分歧分别记录no_findings/applied/escalated；修正单次自检失败记录self_check_failed。门禁的completed仅表示原处置记录完成，不是规格审批或任务完成；escalated仍返回原未决findings供摘要卡人工判断。处置依据是当前宿主报告，JS检查文件与覆盖，不证明语义修复；逐项说明随响应返回，旧三类回执仍仅持久保存原合同计数及哈希。新失败回执另保存correction_check，绑定原检查输入、决定和结果摘要；共享门禁必须核验真实失败记录，design或实际通过不接受该值。摘要与awaiting_review使用上方入口，人工批准仍在既有流程。

拆分补正的 `self_check_failed` 只表示处置完成，不能推导检查通过。`prepare_summary` 强制把失败项目和证据
加入 `riskCard` 及摘要风险点，允许 `publish_summary` 发布待审；已记录的机械失败保留失败状态，
损坏的测试合同只显示计数未知，不编造零用例。未登记的新失败仍阻断。后续需求／设计读取沿用完整 split 回执的
文件身份规则，`prepare_revision` 可进入受控修订；修订快照同时绑定失败检查文件，历史不覆盖，不补审或重试。

同时启用--allow-spec-write和--allow-review-write时，`{requestId,operation:"correct_findings",stage,feature}`把原r1 findings与原版本规格交给prd_correct宿主请求。返回完整原路径清单与逐项decisions；主宿主复用disposition-plan检查对应关系，再跑原mechanics，拒绝越界、漏项、未解释修改、勾选任务或编码损失。design只修改design.md，不发第二次review。
在改规格前写不可覆盖的`.reviews/prd-{slug}-{stage}-correction.md`，保存原文件正文、原包身份和逐项提案；它是私有host报告，不是批准或处置回执。每次替换前核对原r1精确SHA、原gate仍待处置及全部文件当前hash，0600临时文件替换后fsync/回读；失败保留correction_save_unknown现场，不回滚或重新生成。既有归档返回correction_recovery_required，须走下方显式恢复入口。correction_saved返回decisions/artifacts供上方原自检与处置，不完成审批。当前仅证明临时CLI产品代码完成原稿保存→修订写入→自检→原处置，宿主提案/自检/review仍为合成响应，未做真实语义验收。
`{requestId,operation:"inspect_correction",stage,feature}`只读原v1修订档案：严格UTF8、精确字节重构、原包/feature/stage、完整原文件sha和正文、逐项处置及机械检查后，对当前文件标记matches_correction或needs_correction。只接受原稿或档案修订稿；第三种内容/不安全路径/权限异常直接拒绝。此只读入口在人审停点后也可用。
`{requestId,operation:"resume_correction",stage,feature}`须同样显式启用spec和review写入，只补原档案未完成写入；复用初次写入函数，逐步核对档案/r1/gate/所有文件版本，已匹配文件不重写，已完成处置不得再补改。没有宿主生成或review调用；新进程可读取同一v1档案继续。已完整写入时返回原decisions/artifacts，原处置已完成则提示检查旧回执；这不是审批或新的自检证明。测试重建了全未写和多文件部分写入前缀并由新Node进程补齐，不等于断电/跨平台验收。无档案调用中断、修正自检轮次和完整会话恢复仍待收口。

宿主启动时显式追加`--allow-review-write --host-context {真实作者上下文ID}`后，自检报告通过可发`{requestId,operation:"final_review",stage:"design"|"split",feature:"1.slug",mode:"independent"|"self-degraded"}`。这只启用原dispatch/r1写入，不授权provider/CLI启动或外发；当前宿主仍须有真实审查通道权限。独立/降级模式在占用前选定，占用后不能切换补审。
`review-host.mjs`串联重新准备/核对原包→原claim→`prd_review`宿主请求→再核对→原r1发布。请求给出精确packageDigest/examinedPaths、真实作者ID、代码项目及steelman-review参考；宿主核实真实独立上下文并原样转交结果，不得自行伪造来源。取消/status沿同一JSONL控制通道，reviewState单独展示审查进度。
登记后的断连/无效响应/中止保留review_unknown或review_cancelled和原占用，不自动重发。成功为review_recorded，该操作本身不写处置/规格/审批、不完成任务；日志关闭仍incomplete。当前仅临时目录真实CLI配合合成review响应通过，未实际运行独立产品reviewer。保存、修订和处置走上方独立启用的入口；跨进程真实调用句柄追踪与未知结果恢复仍待接线。

`review-publication.mjs`提供主宿主专用`publishPrdReview({specs,reviewPackage,packageDigest,authorContextId,response})`：只有已有dispatch且原包hash匹配才能发布固定r1。response沿原result验证器（verdict/packageDigest/examinedPaths/findings/summary），外层reviewer/contextId/independent/at；独立渠道仅原PRD支持的codex-subagent/codex-cli，contextId不得等于作者。self-degraded要求同作者context、independent:false及单行degradedReason。真实上下文和原样结果必须由受信宿主核实，字段不能证明发生了调用；不要从任意用户JSON直接写独立审查证据。
设计审查scope为requirements/design，拆分审查为requirements/design/tasks；未投喂的测试合同不冒充已审查。复用原不可覆盖writer，以0600发布并精确回读；原样重复发布可验证，不同结果冲突停止。r1内保留原包和完整宿主响应，含私有材料不得自动提交或外发；它不是V3 receipt、处置回执或规格批准。发布后原gate进入resume_disposition，不创建disposition或修改任务。
发布模块已通过上方显式启用的宿主流程接线；证据仍限临时目录实写及合成review响应，不能当成独立产品审查已运行。

原`cm-prd-review-gate.mjs`新增`claim`命令（Python薄包装同步可用），沿原--stage/--feature/--evidence/--receipt参数额外传`--package-sha256`。这是写入动作，调用前须已有本轮审查记录写入授权和真实`.reviews`目录；`--allow-log-write`本身不授权它，宿主需上方独立启用条件才串联调用。
claim以wx独占创建相邻`prd-{feature}-{stage}-dispatch.json`并fsync文件；POSIX同时fsync目录，Windows未做目录fsync，尚无Windows断电持久性证据。同一阶段只有一个调用者成功；记录绑定审查包hash，结果dispatch_claimed仅表示占用，不是provider或完成授权。
持久记录存在而r1未出现时，原inspect返回dispatch_unknown；损坏/不完整/不安全记录直接报错，均不可重发。准备包必须仍匹配原hash；r1存在后沿原resume_disposition/completed继续，不能再claim。没有自动删除/重置/重试入口；如果进程在claim后中断，先核对原调用真实状态，不能把“没有r1”当成从未调用。当前CLI可按原callId/digest恢复原宿主实际回执；没有回执仍保持unknown，不追踪或新建外部provider进程。

自检报告通过后，可发`{requestId,operation:"final_review_package",stage:"design"|"split",feature:"1.feature-slug"}`只读准备审查。stage仍须按原Step9.5风险触发/Step10.6选择，本接口不替代风险判断。内部直接调用原inspectPrdReview；返回gate的dispatch_once/dispatch_unknown/resume_disposition/completed及原r1/disposition路径，不派发、不写文件，dispatchAuthorized:false。
存在dispatch记录时，unknown、恢复处置及已处置结果始终携带原package_sha256，准备接口均核对，不允许把旧包A的恢复结果配给新包B。无dispatch的历史记录保持原兼容检查。审后修正通过原correction归档关联审查包与处置产物；当前新包不匹配会阻断，不能借此重审。
design包保留requirements/design全文，相关代码/规范由原审查流程读取；split包提取需求「功能需求」节、tasks全文、design关键模块/架构/接口/数据/安全/技术决策/波及面等节，缺所需节时阻断而不静默发送三件套全文。附完整草稿文件哈希和包digest，当前仅支持所列中英文标题。
split必须包含方案概览节（方案摘要/概述/功能模块设计/架构，或Summary/Design Summary/Overview/Architecture）；只有接口等细节节不够。中英文摘要必须保留正文，否则明确阻断，不能因其他节非空就声称包完整。
同名slug不同编号会共用旧凭证文件名，因此准备阶段拒绝冲突；拒绝不安全证据路径和r2。发现既有r1/处置时，当前草稿每份文件必须与磁盘精确相同，才展示原门禁恢复结果，不能用旧处置给另一份内存草稿背书。此处只是准备包；调用/发布/保存/处置各走上方显式启用流程，最终摘要卡与awaiting_review写入见上方prepare_summary/publish_summary。不要直接根据dispatch_once调用provider或把此响应当review receipt。

草稿返回后自动执行`self-check.mjs`的机械子集，复用原N1任务解析/依赖检查及测试合同validator，不复制另一套任务语法。检查任务≤15、任务未完成/未丢弃、依赖无环、AC声明、TC引用已有AC/Task、每AC有TC覆盖（存在合同才执行），代码围栏中的示例不算草稿声明。报告绑定draftDigest；失败进入draft_self_check_failed并保留草稿，不能沿正常draft_ready前进。
机械通过仍仅为`mechanical_subset_passed`，`completeSelfCheck:false`。draft_ready后的advance接`prd_self_check`，宿主按原spec-self-check.md读取相关代码/地图和需求，逐feature回全部pending检查（id/status/evidence）。报告必须绑定当前draftDigest、完整feature与检查清单；只有二开附加项可附理由记not_applicable，其余缺证据记failed。宿主报告不等于JS独立观察或独立Review，后续审查门禁不变。
失败进入self_check_failed（机械失败为draft_self_check_failed）；下一advance让原planner修订现有feature，拒绝新增/删除/改名或编号漂移。初稿为第1轮，最多第2轮；旧轮次摘要和机械/上下文报告进入selfCheckHistory，当前contextCheck随新稿清空。第2轮仍失败进入self_check_needs_human，不能再生成第3轮或重跑同轮自检；错误/断连也不自动重发。通过为self_check_reported_passed，仍未Review/批准/落盘。当前所有状态在内存，跨会话不恢复；不要用重启来规避轮次。

analysis_ready后继续发送`advance`及当前生成要求，CLI改调planner的`prd_generate`。请求仅含分析结论、用户回答、材料记录/来源引用和用户用例，不重发全部需求正文；模型/adapter仍是请求路由元数据。planner不在当前runtime时明确阻断，不偷换provider。设计基准或其他材料决策不明时返回question，进入awaiting_planning_user，下一次advance带真实用户回答继续规划。
宿主返回`{status:"draft",summary,features:[{name,documents:[{path,content}],testCasesReason}]}`，或question/blocked；请求instructions中有完整字段格式。name为kebab slug，JS按当前已有编号最大值+1分配目录名，不依赖模型自报编号。每feature只接受requirements.md/design.md/tasks.md和可选test-cases.json，拒绝路径逃逸/重复/缺三件套；原测试合同validator校验JSON，禁生成用例配置仍保留用户用例。有test-cases.json时testCasesReason必须为null；无测试合同时必须是no_observable_behavior或合法的generation_disabled。tasks.md依赖每任务一行，多前置任务用逗号：`- T-003 依赖 T-001, T-002`。
draft_ready只表示内存草稿结构及上述机械子集检查通过，返回draft及绑定实际目录的digest；无规格文件写入，无task完成位或审批位。上下文自检沿上方宿主流程执行，设计审查/拆分审查/人工批准仍待接线；不能把testCasesReason自报、结构完整或合成测试当作语义验收。当前整个生成回包最多65536字节（64 KiB），超限的操作者诊断列出实际序列化字节数；尚无大规格分块、草稿落盘及恢复。关闭仍记录incomplete。

PDF/HTML现通过同一CLI的`prd_materials`宿主请求处理，先于prd_analyze且每份当前材料只处理一次。宿主复用已有获准PDF读取工具或Codex内置浏览器，不新装解析库、不启动本机浏览器；不可用或未授权时返回`{status:"blocked",reason:"原因"}`，不降级成静态遍历。这里仅新增宿主接线和报告校验，不内置PDF解析器或浏览器驱动。
请求含`responseShape`：processed.records中每份记录绑定原path/sha256；PDF带pageCount及从1连续编号的pages（page/text/evidence）；HTML带pages（url/interactiveCount/elements/evidence），元素含id/action/result/kind/screenshot/question，kind为function或dead_zone，后者必须给question。每页元素数量需与interactiveCount相等、ID唯一；截图和工具引用为宿主报告，不是JS实测证明。PDF空白/扫描/过大等无法按现协议忠实返回的材料明确blocked，不虚构文字。
所有原型死区先直接返回用户问题，收到下一轮真实回答才继续分析；处理结果缓存并附入分析上下文，文件哈希变化仍停止。`materialEvidence.source=host_reported_material_processing`且`independentVerification=false`，不修改原始sourceInspection的交互验证标志，不构成Review/完成凭证。材料模块保留64KiB正文校验；不分块截断。材料结果随原session恢复；未知格式仍拒绝，普通Skill已接当前宿主。

`node "{CM_WORKFLOW_ROOT}/scripts/cm-prd-host.mjs" serve --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-prd" --project "{代码项目}" --specs "{规格目录}" --runtime codex --allow-log-write`（Claude宿主传claude；可选`--cases`支持UTF-8 Markdown/文本用例，其他格式仍待处理）。`--allow-log-write`只启用原日志/指针/锁及镜像写入，不授权规格修改或provider；镜像位置沿原`CM_WORKFLOW_LOG_HOME`配置。底层继续由Python平台锁适配器调用JS日志权威实现。
收到host_ready后发`{"requestId":"prd-1","operation":"start","text":"当前真实用户请求"}`；宿主按prd_analyze的原Skill参考执行分析，通过原host_result信封回question/analyzed/blocked。有澄清时传`advance`及真实用户回答；status/cancel沿原通信协议。首次start写一次run_start，每轮分析先写带analysis_turn的route decision；正文不写日志。关闭/EOF记录run_done的incomplete、blocked或cancelled，不记录成功、不改审批位。分析就绪不是工作流完成。终态日志异常不自动重试。
这是真实CLI及原日志接线；目前无跨会话分析恢复、规格落盘或普通Skill激活，关闭会话后不能续接内存中的澄清/草稿。下文模块层描述的回调由本CLI接入，模块本身仍不拥有日志文件。

#### 调用契约中容易踩空的几处

控制请求的字段集是**严格**的：`cm-prd-host.mjs` 对每个 operation 逐一 `shape` 校验，
**少给必填字段和多给不属于该 operation 的字段一样会被拒**。被拒时错误通道统一返回
`host_request_failed`（只有宿主主动暴露的失败才带 reason 走 blocked 结果），
因此无法从返回值分辨是哪种问题，照下列逐条核对可省掉一次排查：

- `advance` / `start` / `plan_design` **必须带 `text`**，且非空。
- `save_draft` / `prepare_summary` 等**不接受 `draftDigest`**；只有
  `promote_design` 与 `select_design_reviews` 带 `draftDigest`，`publish_summary` 带
  `summaryDigest`。多给一个字段即被拒。
- 用 `--session prd-ID` 恢复既有会话时**不要再发 `start`**，否则 `prd_turn_not_ready`；
  先 `status` 读回当前 stage 再继续。
- `prd_analyze` 回复的 `analyzed.sourcePaths` 必须**覆盖 `sources` 的全部条目**，
  用与之相同的相对路径；只列本轮相关的那几份会以
  `prd_source_coverage_invalid` 拒绝。提供 `--cases` 时另含其绝对路径。
- 每条验收标准都要被至少一条测试用例的 `acIds` 覆盖，否则机械自检
  `acceptance_test_coverage_missing`。

split 审查对文档章节标题有硬要求，不满足时 `final_review_package` 只返回
`host_request_failed`（真实原因是 `prd_review_sections_missing`）：

- `requirements.md` 必须有匹配 `^##\s+(功能需求|Functional requirements)\s*$` 的章节——
  写成「## 功能要求」不匹配。
- `design.md` 必须有方案摘要/概述/架构/功能模块/技术/接口/数据/波及/安全一类的
  `##` 章节，`split` 阶段另单独校验一次摘要类标题。

当前宿主校验失败仍向调用方返回原 `host_request_failed`，现仅在本地 stderr 的结构化诊断中
附字段、预期格式与尺寸；原错误码和审批、审查门禁不变。`cm-prd-review-gate` 的每个拒绝都带稳定 `code`
（如 `prd_review_artifact_changed`、`prd_review_receipt_evidence_mismatch`、`prd_review_evidence_invalid`、
`prd_review_receipt_invalid`、`prd_review_dispatch_invalid`），`reason` 只含回执/证据/派发文件名与校验过的规格相对路径
（改动文件另附记录与当前 SHA-256），不再只有 `detail:"unavailable"`；内容为 `null` 的回执与非法 UTF-8 同样带码，
绝对或越界的产物路径只报回执名；文件读不了（权限等）同样带码与规格相对文件名，不输出绝对路径；计数类拒绝写明回执与字段。CLI 与 Python 版的报错文字不变。审查 `response.at` 必须是
`new Date().toISOString()` 形式，例如 `2026-09-08T00:00:00.000Z`。

`runtime/js/cm-prd/analysis.mjs` 提供 `createCmPrdAnalysis({input,runtime,analyze,record})` 会话分析控制层；input沿用来源入口参数。先准入、解析analyst/planner配置，再读取正文。`advance(text)` 接真实当前用户输入，回调 `analyze(payload,signal)` 执行当前宿主分析；`status()`/`cancel()` 提供状态与取消。
`record(event)` 必须由宿主接原规格日志写入器，失败阻止派发；此模块不自行创建run_start/run_done或日志文件。非current-runtime analyst明确blocked/degrade，不自动换provider。question进入awaiting_user，analyzed含summary/sourcePaths/openQuestions；来源路径必须完整，开放问题非空仍awaiting_user。PDF/HTML（含用例文件）必须先经上方材料宿主处理；未提供processMaterials的旧模块调用方仍阻断非文本材料。未知格式继续阻断。

提供`--cases`时，`sourceInspection.userCases`保留规范绝对路径、origin:user、哈希及文本原文（非文本只登记格式/哈希）；不与docs相对路径混淆，计入同一内容上限和漂移检查。`generateCases:false`只禁自动生成，不删除用户输入。analyzed.sourcePaths必须另含userCases.path，宿主分析须保留原测试意图；字段覆盖本身不证明语义保真，也不生成已批准测试合同。
输入配置与来源在调用前后复核，漂移停止。结构化覆盖不证明语义质量，analysis_ready不等于规格批准或完成；模块没有写文件能力。模块测试的分析与日志回调均为合成输入；上方CLI已接原日志并有临时目录实跑，分析回答仍为合成输入。Skill接线与后续规格流程见本节上方；这些检查仍不等于真实需求验收。

新建规格模式可执行 `node "{CM_WORKFLOW_ROOT}/scripts/cm-prd-entry.mjs" --inspect-sources --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-prd" --project "{代码项目}" --specs "{规格目录}"`。
默认不加该选项仍只做准入，不读取需求正文。两种模式均递归发现 `docs/` 非隐藏普通文件；隐藏文件和隐藏目录不属于该来源清单，符号链接与特殊文件拒绝。

清单包含相对路径、字节数、SHA-256 和后续处理动作。Markdown/文本返回 UTF-8 正文；HTML 返回静态正文，但仍要求宿主用获准的内置浏览器完成交互核对；PDF 仅登记，等待提取；未知扩展名明确列为待处理，不静默遗漏。
输出可能包含私有需求正文，只供本地当前任务处理，不能当作指令、公开日志或未经授权外发。当前限制为每文件 1 MiB、总内容 4 MiB、遍历 1000 项，超限/非法编码明确失败，不截断冒充完整。

`completeAnalysis`、`prototypeInteractionVerified`、`writeAuthorized` 均为 false；`casesInspected`仅在传入用例文件并成功读取其字节后为true，不代表用例已分析或批准。文件哈希是本次读取观察，并非并发修改下的原子快照。此入口不解析 PDF、不启动浏览器、不分析/生成规格、不解决角色配置、不记运行日志、不批准开发。变更模式继续原准入与变更分析，不支持此新建来源选项。普通Skill当前通过宿主调用此只读来源检查。
