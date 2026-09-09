# JS workflow 控制与当前会话入口

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
- 不读取凭证，不加载任意 JS 模块，不接受 shell command、host grant 或自报审批字段。
- 已有 tasks.md、Review 和 Learning 文件不被控制入口直接修改；`serve` 会创建运行控制记录与锁。
- 同一配置及 runId 才能 `resume`；运行身份和配置固定。此阶段记录是明确的 control-only 运行，
  不得把它的无执行记录当作真实开发证据；后续执行适配器上线使用不同 runId，旧记录保留可读。
- 配置指纹按规范化内容计算，JSON 对象字段换序不影响恢复。初始化前验证 review baseline；
  若异常退出只留下匹配的空 store，恢复时重新核对任务准入与 baseline 后完成初始化，不删除历史。

## 启动

### 多代码目录：同一个任务统一收口

单任务定义或batch定义可增加`codeProjects:["{WORKSPACE}/frontend","{WORKSPACE}/backend"]`。
`codeProject`是明确选择的共同工作区根，不创建挂载或搬移目录；每个代码根必须是真实已存在、互不重叠的子目录。
scope/requirements使用相对工作区的前缀路径（如`frontend/src/view.mjs`），不得选择未声明的兄弟目录。
使用`--protected-conversation-config`；每个checkCommands条目增加`codeProject`指定上述某一个规范根，
每个声明根至少有一条已授权检查。QA commands同样增加codeProject，其他caseIds/命令合同不变。
编辑提案保留前缀路径，由固定适配器映射回每个根的本地scope；检查在各自cwd的原沙箱串行执行。
一次任务的所有根共用原身份、审查包、handoff、Review与完成门禁；根路径/配置/材料漂移不能沿旧证据冒充完成。
只快照声明根及适用上级AGENTS，不扫描无关兄弟项目；各根AGENTS进入审查材料，开发请求显式携带各根指令。
工作区级Learning写回仍由原owner处理，不借此开放子项目指令写权限。不是跨项目DAG、自动合并或额外完成路径。

### 0.bootstrap：骨架与项目规范

原批准`0.bootstrap`先T-001骨架、再原规范生成任务（通常T-002）。单任务增加
`--bootstrap-config PATH --allow-bootstrap-write`，配置为`{selection:null}`（骨架），或
`{selection:{versionControl,modules,analysis}}`（原cm-init规范选择）。批次用可选`bootstraps`映射，
键为`0.bootstrap/T-001`等，值为同样配置，并显式传`--allow-bootstrap-write`；原逐task Review授权不变。
空项目可用`requirements:[]`，但必须绑定真实bootstrap factory；原requirements/design从已批准specs读取并进入审查包，
不在代码根生成假需求文件。普通任务仍要求代码需求材料，不能用空数组跳过审查。
规范任务scope须列完整固定目标：`AGENTS.md`、`.claude/CLAUDE.md`、原选择对应的`.claude/rules/`文件，
其余业务scope单独交原developer；指令由宿主复用init_generate/init_verify与受控写入，不交普通developer修改。
init_generate返回原`{status,documents}`；init_verify逐组核验并返回`{checks,constraintChanges,application,retrospective}`，
checks为commands/globs/file_references/constraint_preservation/rule_applicability，各含status/evidence。
constraintChanges必须空；application/retrospective沿原Learning字段。此核验不是独立Review，仍走原N4/N5。
规则读回及证据进入同一原develop记录与handoff，然后Review，完成后N7重载。已有用户规则、未知写入或材料漂移不覆盖不重派；
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
捕获第一条合规消息请求后主动终止，防止 CLI 内部修复/重试发出第二条请求；
`stopped_by_probe:true` 是诊断主动停止，不是用户取消，也不是 Review 成功。
当前证据只有本机配置/工具表验证，没有真实模型审查结果；换模型或目录须重新诊断。
隔离测试使用合成凭证和合成 Claude 进程，验证 Review→QA→文档核验→原 run_done/恢复，
不证明真实模型或完整双端交付。
批次 CLI 也支持显式 `--runtime claude`，每个子任务继续使用原独立轮次授权；
恢复时更换 runtime 被拒绝。完整 Skill 激活和真实双端 N1–N8 验收仍未完成。
本地合成会话已验证实际文件/检查及断联、取消、恢复，尚未在真实 Claude 会话运行。

共享 V3 核心已能按实际登记的 Claude request 校验规范化审查事件、生成 Claude receipt、
发布 `claude-cli` Review 并沿原唯一门禁完成；实时与恢复共用相同 provider 绑定。
`claude-review-adapter.mjs` 复用原审查包/prompt 合同，只转交受信 worker，不自行调用进程。
`worker-claude.mjs` 已接入该 adapter，使用 stdin、工具关闭、单次派发和 POSIX 进程组清理。
Windows 明确拒绝此 worker；CLI help 和合成协议验证不证明真实 Claude 进程兼容或物理隔离。

```bash
node scripts/cm-ai-host.mjs serve --config /absolute/run.json --mode create \
  --host-context actual-current-conversation-id --allow-development
```

`--allow-development` 只表示可信启动者已有该配置中开发/本地检查授权，不授予网络、
安装、Git、specs 修改或独立审查调用权限。恢复使用原配置、相同 host-context 和 `--mode resume`。
host-context 必须是真实当前会话身份；宿主将其排除出独立审查候选，而非接受结果自报身份。
通道只能由当前可信会话控制，不能交给开发 worker、暴露为网络服务或从项目文件自动读取回复。

启动先返回 `host_ready`（含本次随机 sessionId）。发送原 `advance` 后，JS 依次发出
`host_request`，包含 `sessionId/callId/requestDigest/kind/payload`：

- `develop`：payload 包含固定业务 scope、需求内容、原 Learning 输入和开发 prompt；
  宿主读取适用指令并用真实工具修改获准文件，再返回原开发输出。
- `check`：payload 包含代码根、任务身份、scope、requirements；宿主实际执行检查，
  返回原检查数组 `[{id,command,outcome,exitCode,evidence}]`，不能用静态判断填通过。

这两类请求现在附带原配置解析器产生的 `route`（coder / tester）。每次实际角色边界
重新读代码项目配置，并通过原日志写入器记录 `decision/route`；配置错误记录脱敏 error，
不发工具请求。未观察到的适配器记录 degrade，仍只使用已获准的当前会话工具。
`route.model` 是请求别名，不切换当前会话模型、不调用远端、不写未观测 effective_model
或 model_usage。角色 Skill 的业务使用仍由当前会话负责；这不是模型路由全量实装。
旧运行恢复只有真正再次进入角色时才读取/记录，不重发已完成开发或重复历史路由。

回复固定为以下形状；三个绑定值必须逐字取自该次请求，不要自行计算或沿用上次值：

```json
{"type":"host_result","sessionId":"from-request","callId":"from-request","requestDigest":"from-request","result":{"status":"succeeded","value":{"outcome":"implemented","application":{"status":"no_relevant_lesson","note":null},"retrospective":{"status":"no_new_lesson","candidates":[],"reason":null}}}}
```

开发失败为 `{status:"failed",code:"实际失败代码"}`；Learning 有应用/候选时使用请求中的
原结果合同，不谎报无新增。检查的 `result` 是数组，不是上述开发结果。错绑定回复被拒绝，
不会解除当前等待。正常 `status/cancel` 仍可随时发送，JS 一次只发一项工具工作。
开发返回后，原 runner 完成检查、Learning 写回与 handoff 定稿；随后返回
`awaiting_review / decision_required`。不能通过回复 `approved` 打开 V3 授权或完成任务；
需要审查时使用下方可信启动选项，不能据此宣称 N1–N8 已跑完。

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

JS 通过现有通道发出固定请求，结果由原组件校验：

| kind | 当前会话的职责 | JS 的职责 |
| --- | --- | --- |
| documentation_sync | Review 前同步列明的文档，返回 `{status:"completed"}` | 原 scope 检查、最终 handoff 与 Review 覆盖 |
| qa_assess | 返回原 scores/changes 语义评估 | 原 N6 强制触发、评分及日志 |
| qa_logic | 返回原静态 verdict/evidence | 与实际命令覆盖关联，不把静态结论算执行 PASS |
| qa_browser | 用获准工具实测，返回原 verdict/evidence/environment/cleanup | 原逐例日志、证据与载体校验、QA 结果 |
| documentation_inspect | 只读核验，返回请求绑定的原文档结果 | 原 N8/finalizer，唯一 run_done |

正式 QA commands 由现有 host-check 实际执行，必须是宿主核对的已授权命令；配置文件本身
不是权限证明，也不提供 OS 沙箱。它们不能写 specs/指令、发网络、安装或做 Git，除非另获
对应权限；这里的 QA 开关不授予这些权限。浏览器能力仍受用户工具策略与目标授权约束，
缺工具/环境就返回 BLOCKED，不能换载体或伪造证据。QA FAIL/BLOCKED/unknown 不自动重试。
代码检查、Learning、Review、QA、文档核验全部通过后才由原 finalizer 返回 run_done。
日志镜像位于 specs/.reviews/host-log-mirror，只是原日志的可重建副本；权威仍是 specs-local 日志。
重开复用原 QA/任务结果，只读文档核验可以再次进行，不能重发开发、文档写入或 QA。
本地命令与合成 reviewer 的 CLI 组合已走到 run_done；这不代表真实模型、浏览器或全 N6 验收。

### 配置与按轮启用独立审查

首次 create 前固定 reviewer 模型和本地诊断配置；未配置 reviewer 的旧运行保持原行为，
不能在恢复时更换模型或把旧 control-only 记录转换成执行记录。

```bash
# 只启动本机合成 sink 和只读 CLI 探测，不请求真实模型；输出保存为 review.json。
node scripts/cm-ai-host.mjs preflight --config /absolute/run.json --review-model model-name
# 携带配置但不授权审查：开发和检查完成后等待授权。
node scripts/cm-ai-host.mjs serve --config /absolute/run.json --mode create \
  --host-context actual-current-conversation-id --allow-development --review-config /absolute/review.json
# 当前会话已取得本任务本轮、该模型及发送审查包的用户授权后，才可添加对应轮次：
node scripts/cm-ai-host.mjs serve --config /absolute/run.json --mode resume \
  --host-context actual-current-conversation-id --allow-development --review-config /absolute/review.json \
  --allow-review-attempt 1
```

review.json 仅含 `{model, disabledSkills, preflight}`；disabledSkills 是本机探测实际发现并
禁用的 Skill 路径，preflight 沿原配置指纹/模型/stdin 合同。探测输出不包含原始诊断、
凭证或请求正文；旧实验路径仅兼容转发到共享 runtime。通过探测不等于获准调用或模型可用。
更换 CLI/安装配置后应重新本机探测；模型和 disabledSkills 必须与运行绑定的配置一致。

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

### 普通单任务入口选择受保护模式

当前会话（Codex或Claude）及批次也可选择 `--protected-conversation-config PATH`，文件为
`{checkCommands:[{id,command:[...argv]}],timeoutMs}`。沿原 `--allow-development` 启动；不与
`--protected-config` 混用，不增加开发模型调用。固定工厂冻结developer/check/QA能力并绑定完整定义；
复制或修改对象不能保留保护声明。批次在冻结前绑定整个workflows配置与原日志目录，恢复不换配置。

收到develop的 `editMode:"protected-text-v1"` 时，宿主只能读取并返回
`{status:"succeeded",value:{原outcome/application/retrospective},edits:[{path,beforeSha256,content}]}`。
沿用fixed fix编辑器的scope/expected摘要、完整UTF-8/null删除和64KiB通道限制；宿主不得先写或运行命令。
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
整个定义和配置绑定原恢复指纹；QA许可不作为持久批准，启动须重新提供。旧运行未配置workflow不能恢复时临时添加。
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
重置、未结束调用和第4轮被拒绝。执行器从原日志读取已登记轮次，不以传入数字代替登记。
这仅补齐重测记录能力；`advance` 仍不自动发起后续轮次，不能代替独立修复及其 Review。

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
原未完成 intent 保持 unknown，不重发诊断。

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
子配置 hostContextId/runtime 须匹配当前宿主；仅配置文件或 auto_fix 策略不能替代此授权。
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

`node --test scripts/cm-ai-run.test.mjs` 验证真实 store 创建/取消/恢复和零 provider 调用；
另用真实 host/runner + 隔离假 developer 验证长任务期间的控制可达性。
这不是实际 provider 运行、跨平台完整支持或 P1/P2 总验收。

下一步：接实际宿主授权启动和工作区保护，修正普通项目目录约束，
再激活 Skill 入口及后续阶段调度。上述进程内组装不等于真实 provider 或实装验收。

## cm-prd：规格生成、需求变更与恢复

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
需求和设计正文必须保留。任务草稿进入原最多两轮自检与 save_draft，再继续原 split 审查和人审停点。
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
`createPrdDispositionOwner`先核对原包/逐项处置/已存文件，读取当前规格运行原mechanics，再经现有prd_self_check请求宿主按原spec-self-check.md核对代码、用户用例及所有pending项。完整回包绑定冻结后的当前draft摘要；写原receipt前重读原r1及当前artifact哈希。机械/上下文失败返回disposition_self_check_failed，取消或漂移拒绝写入，不自动修复或重试。上下文仍是host报告，不是独立review。
修正自检的开始/结果保存为原.reviews中的固定`prd-{slug}-split-correction-check-start.json`与`...-result.json`，复用不可覆盖0600发布。绑定原package、当前规格正文/摘要、逐项决定与原review投影；先占用再请求宿主，先存结果再写原处置回执。相同输入的已存结果经原validator验证后复用：通过继续原门禁、失败仍失败；只有开始没有结果则disposition_self_check_unknown，不重发。损坏、权限异常或输入变化直接拒绝；这两份文件不是任务状态库或独立Review凭证。
新进程已验证通过/失败/中断前缀恢复且零宿主重调；覆盖的是这套新记录，升级前未留记录的在途调用不能据此推断未调用，仍需人工核对。记录不捕获整个业务代码工作树，宿主上下文语义仍是报告证据，不能把规格输入一致扩称完整项目无变化。无结果时的真实调用追踪和完整会话恢复仍待收口。
既有回执只有汇总计数，无法证明重入时每条finding仍分配相同处置。有findings的恢复返回disposition_details_need_verification及全部原findings，不把本次输入作为已保存决定、不输出未经核实的未决子集；需核对原逐项处置。零finding原样恢复可沿原already_recorded返回。
`review-disposition.mjs`调用原record/inspect，design回执绑定design.md，split绑定完整规格文件；无发现/全采纳/仍有分歧分别记录no_findings/applied/escalated。门禁的completed仅表示原处置记录完成，不是规格审批或任务完成；escalated仍返回原未决findings供摘要卡人工判断。处置依据是当前宿主报告，JS检查文件与覆盖，不证明语义修复；逐项说明随响应返回，原回执仅持久保存原合同计数及哈希。摘要与awaiting_review使用上方入口，人工批准仍在既有流程。

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
宿主返回`{status:"draft",summary,features:[{name,documents:[{path,content}],testCasesReason}]}`，或question/blocked；请求instructions中有完整字段格式。name为kebab slug，JS按当前已有编号最大值+1分配目录名，不依赖模型自报编号。每feature只接受requirements.md/design.md/tasks.md和可选test-cases.json，拒绝路径逃逸/重复/缺三件套；原测试合同validator校验JSON，禁生成用例配置仍保留用户用例。无测试合同时testCasesReason必须是no_observable_behavior或合法的generation_disabled。
draft_ready只表示内存草稿结构及上述机械子集检查通过，返回draft及绑定实际目录的digest；无规格文件写入，无task完成位或审批位。上下文自检沿上方宿主流程执行，设计审查/拆分审查/人工批准仍待接线；不能把testCasesReason自报、结构完整或合成测试当作语义验收。当前整个生成回包64KiB，尚无大规格分块、草稿落盘及恢复。关闭仍记录incomplete。

PDF/HTML现通过同一CLI的`prd_materials`宿主请求处理，先于prd_analyze且每份当前材料只处理一次。宿主复用已有获准PDF读取工具或Codex内置浏览器，不新装解析库、不启动本机浏览器；不可用或未授权时返回`{status:"blocked",reason:"原因"}`，不降级成静态遍历。这里仅新增宿主接线和报告校验，不内置PDF解析器或浏览器驱动。
请求含`responseShape`：processed.records中每份记录绑定原path/sha256；PDF带pageCount及从1连续编号的pages（page/text/evidence）；HTML带pages（url/interactiveCount/elements/evidence），元素含id/action/result/kind/screenshot/question，kind为function或dead_zone，后者必须给question。每页元素数量需与interactiveCount相等、ID唯一；截图和工具引用为宿主报告，不是JS实测证明。PDF空白/扫描/过大等无法按现协议忠实返回的材料明确blocked，不虚构文字。
所有原型死区先直接返回用户问题，收到下一轮真实回答才继续分析；处理结果缓存并附入分析上下文，文件哈希变化仍停止。`materialEvidence.source=host_reported_material_processing`且`independentVerification=false`，不修改原始sourceInspection的交互验证标志，不构成Review/完成凭证。材料模块保留64KiB正文校验；不分块截断。材料结果随原session恢复；未知格式仍拒绝，普通Skill已接当前宿主。

`node "{CM_WORKFLOW_ROOT}/scripts/cm-prd-host.mjs" serve --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-prd" --project "{代码项目}" --specs "{规格目录}" --runtime codex --allow-log-write`（Claude宿主传claude；可选`--cases`支持UTF-8 Markdown/文本用例，其他格式仍待处理）。`--allow-log-write`只启用原日志/指针/锁及镜像写入，不授权规格修改或provider；镜像位置沿原`CM_WORKFLOW_LOG_HOME`配置。底层继续由Python平台锁适配器调用JS日志权威实现。
收到host_ready后发`{"requestId":"prd-1","operation":"start","text":"当前真实用户请求"}`；宿主按prd_analyze的原Skill参考执行分析，通过原host_result信封回question/analyzed/blocked。有澄清时传`advance`及真实用户回答；status/cancel沿原通信协议。首次start写一次run_start，每轮分析先写带analysis_turn的route decision；正文不写日志。关闭/EOF记录run_done的incomplete、blocked或cancelled，不记录成功、不改审批位。分析就绪不是工作流完成。终态日志异常不自动重试。
这是真实CLI及原日志接线；目前无跨会话分析恢复、规格落盘或普通Skill激活，关闭会话后不能续接内存中的澄清/草稿。下文模块层描述的回调由本CLI接入，模块本身仍不拥有日志文件。

`runtime/js/cm-prd/analysis.mjs` 提供 `createCmPrdAnalysis({input,runtime,analyze,record})` 会话分析控制层；input沿用来源入口参数。先准入、解析analyst/planner配置，再读取正文。`advance(text)` 接真实当前用户输入，回调 `analyze(payload,signal)` 执行当前宿主分析；`status()`/`cancel()` 提供状态与取消。
`record(event)` 必须由宿主接原规格日志写入器，失败阻止派发；此模块不自行创建run_start/run_done或日志文件。非current-runtime analyst明确blocked/degrade，不自动换provider。question进入awaiting_user，analyzed含summary/sourcePaths/openQuestions；来源路径必须完整，开放问题非空仍awaiting_user。PDF/HTML（含用例文件）必须先经上方材料宿主处理；未提供processMaterials的旧模块调用方仍阻断非文本材料。未知格式继续阻断。

提供`--cases`时，`sourceInspection.userCases`保留规范绝对路径、origin:user、哈希及文本原文（非文本只登记格式/哈希）；不与docs相对路径混淆，计入同一内容上限和漂移检查。`generateCases:false`只禁自动生成，不删除用户输入。analyzed.sourcePaths必须另含userCases.path，宿主分析须保留原测试意图；字段覆盖本身不证明语义保真，也不生成已批准测试合同。
输入配置与来源在调用前后复核，漂移停止。结构化覆盖不证明语义质量，analysis_ready不等于规格批准或完成；模块没有写文件能力。模块测试的分析与日志回调均为合成输入；上方CLI已接原日志并有临时目录实跑，分析回答仍为合成输入。Skill接线与后续规格流程见本节上方；这些检查仍不等于真实需求验收。

新建规格模式可执行 `node "{CM_WORKFLOW_ROOT}/scripts/cm-prd-entry.mjs" --inspect-sources --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-prd" --project "{代码项目}" --specs "{规格目录}"`。
默认不加该选项仍只做准入，不读取需求正文。两种模式均递归发现 `docs/` 非隐藏普通文件；隐藏文件和隐藏目录不属于该来源清单，符号链接与特殊文件拒绝。

清单包含相对路径、字节数、SHA-256 和后续处理动作。Markdown/文本返回 UTF-8 正文；HTML 返回静态正文，但仍要求宿主用获准的内置浏览器完成交互核对；PDF 仅登记，等待提取；未知扩展名明确列为待处理，不静默遗漏。
输出可能包含私有需求正文，只供本地当前任务处理，不能当作指令、公开日志或未经授权外发。当前限制为每文件 1 MiB、总内容 4 MiB、遍历 1000 项，超限/非法编码明确失败，不截断冒充完整。

`completeAnalysis`、`prototypeInteractionVerified`、`writeAuthorized` 均为 false；`casesInspected`仅在传入用例文件并成功读取其字节后为true，不代表用例已分析或批准。文件哈希是本次读取观察，并非并发修改下的原子快照。此入口不解析 PDF、不启动浏览器、不分析/生成规格、不解决角色配置、不记运行日志、不批准开发。变更模式继续原准入与变更分析，不支持此新建来源选项。普通Skill当前通过宿主调用此只读来源检查。
