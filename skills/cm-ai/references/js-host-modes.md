# JS 宿主条件路径：外部模型、bootstrap 规范任务、多代码根与受保护执行

N6 新决定按固定检查点和 `qa.criticalPaths` 登记匹配；`qa_assess` 只确认清单来源，回 `{"confirmed":true}`。恢复已记录决定时沿用原行，不重新裁决；登记和配置修订见 [N6 固定检查点](N6-qa-eval.md)。

本文是 [js-host.md](js-host.md) 的条件引用：启用外部模型配置、运行 bootstrap 规范任务、多代码根，或同仓 specs 选择受保护执行／文本提案模式时，启动前读取。阻断与恢复见 js-host.md 的停机路由表。

## 先选择原协议与实际执行模式

v2 新运行使用 `--control-config POLICY.json`，恢复保持同一策略；请求 version 2，PLAN 带相对路径 `controlConfig`，禁止任何 `--allow-*`。
配置仍提供模型、命令、路径与保护方式，不自动启用能力。cm-ai 新旧入口的常规独立审查最多两轮直接推进；旧运行保留原请求版本和能力开关，不换协议规避记录。
正文分别标出 v2 和 legacy；后者的旧命令/请求只用于旧运行。完整合同见 [control policy v2](../../../docs/cm-control-policy-v2.md)，异常恢复按 [R](js-host-recovery.md) 或 [Q](js-host-qa-recovery.md) 的对应 v2 分支。
模式冲突/混入旧参数按 `invalid_arguments` 拒绝，缺配置沿原具体阻断；策略/原运行不匹配按 `fingerprint_mismatch`，不改配置重开或转 legacy。

## 按 provider 的外部模型配置

单任务、批次和修复的外部 CLI 可显式启用[按 provider 的单组模型配置](../../../docs/external-models.md)：
宿主会话保持当前模型，外部调用共用 provider pair，独立审查仍需新上下文。cm-ai 在本次已确认的发送范围内常规两轮直接推进；cm-fix 保留原审查参数合同。
外部模型/执行策略的未知调用禁止直接 abandon／重派，恢复只读原快照。v2 只在有真实可对账回执时按 R 携带固定 wire target 执行 reconcile_review；没有可核对结果则保留 unknown，不换 provider、切 legacy 或走未开放的 supersede。R/Q 的一般重试不能覆盖这个限制。

## bootstrap 规范任务用单步驾驶员

适用于纯规范 scope（恰为 `cmInitRuleTargets(selection)` 的全部目标）、单代码根、不带 `--protected-config` 的 T-002；含业务文件、`codeProjects` 多根或 provider 开发的规范任务启动前退出 2，改走下节当前会话宿主路径。完成 T-001 骨架及其独立审查后，为 T-002 生成独立运行定义（`requirements` 可为空数组），`bootstrap.json` 放已确认的 cm-init selection。最小 PLAN：

```json
{"config":"t002-run.json","controlConfig":"POLICY.json","mode":"create","hostContext":"{当前真实会话ID}","runtime":"claude",
 "permissions":["--bootstrap-config","bootstrap.json","--review-config","review.json"],
 "answers":"answers","checks":[{"id":"xcode-list","command":["xcodebuild","-list","-project","App.xcodeproj"]}]}
```

v2 的 POLICY.json 完整填写 `{"version":2,"development":"conversation","bootstrap":"write","qa":"disabled","qaFix":"disabled"}`；如本任务需要 QA，启动前明确选择 qa:run 并提供原 workflow 配置。legacy PLAN 不含 controlConfig，原 permissions 另带 --allow-bootstrap-write。

规范任务不反问 `develop`，不需要 `develop.json`。当前会话先按 cm-init 主 Skill 第3至5节写好全部规范正文（放在答案目录内），再写两份答案：

- `answers/init-generate.json`：`{"status":"generated","documents":[{"path":"AGENTS.md","contentFile":"t002/AGENTS.md"},…]}`，逐项覆盖全部 targets（缺一不可、不能多），`contentFile` 为答案目录内的 UTF-8 普通文件。无法生成时不要启动驾驶员，报告缺口；`blocked` 会被拒绝。
- `answers/init-verify.json`：会话实际核对草稿后填写。`commands` 列出草稿里可安全实跑的命令 `[{"id","command","timeoutMs"?}]`（1..32 条，至少一条），驾驶员在宿主接受启动（`host_ready`：宿主已用自己的读取器核对全部启动输入、admission、任务选择与运行存档）之后、发送操作之前，于代码根逐条真实运行（超时与输出规则同 `checks`；带 `--protected-conversation-config` 时与宿主的任务检查一样在 specs 沙箱内运行，specs 与 AGENTS.md/CLAUDE.md/.claude 只读），任何一条未通过即退出 2、不发送操作；宿主问到 `init_verify` 时回报这次实跑的退出码作为 commands 组的 status/evidence；可选单行 `commandsNotRun` 说明未实跑的命令（如需模拟器的测试）及其依据，它只是会话说明，不是执行证据。`checks` 只写 `globs`、`file_references`、`constraint_preservation`、`rule_applicability` 四组 `{status,evidence}`，status 只能是 `verified` 或 `not_applicable`；不得写 `commands` 组或任何命令结果。`constraintChanges` 必须是 `[]`，`application`/`retrospective` 沿原 Learning 字段，例如 `{"status":"no_relevant_lesson","note":null}` 与 `{"status":"no_new_lesson","candidates":[],"reason":null}`。

第 1 轮也可命名为 `*-a1.json`（不能与无后缀文件并存）；第 2 轮只读 `init-generate-a2.json` 与 `init-verify-a2.json`，绝不复用第 1 轮答案。首次规则任务的修订轮 AGENTS.md 须保留既有非教训正文；同一 bootstrap feature 后续已批准的规则刷新任务可改写规则正文，但每轮都须逐字保留当前 `## 项目教训` 段，且经 `init_verify` 与独立 Review 核对。修订答案必须在读到首轮 findings 之后编写。v2 规范任务首轮始终 hold：advance 自动审查后若要求修改，停在 changes_requested/revision_answer_required，不发第 2 轮开发 intent；读取真实 r1，编写两份 a2 答案后以同一 controlConfig、mode:resume 再 advance，自动走 fresh 第 2 轮独立 Review。预写 a2 不免除先读真实 findings。旧入口也直接审查；同样先读真实首轮 findings，再准备 a2 并沿原运行 advance。

启动前驾驶员会校验：targets 覆盖与内容文件安全、`inspectCmInitDraft` 结构检查（先查原稿，再按当前磁盘合入 AGENTS.md 后查）、单次回复不超过宿主 64 KiB、四组 status、`constraintChanges`、Learning 字段，以及目标文件的当前状态：首次规则任务尚未写入时目标不能已存在（仅允许带 `## 项目教训` 段的 AGENTS.md）；后续规则任务须匹配已绑定的提交基准；本运行已写入过（第 2 轮修订，或同轮重试）时每个目标须与运行存档记录的上次写入逐字节一致（AGENTS.md 按 Learning 回写后的摘要）。他人改动会被拒绝，先还原。启动宿主前，驾驶员还用宿主自己的函数提前拒绝：v2 的 bootstrap 未选择 write 或缺原配置；legacy 缺 `--allow-bootstrap-write`（宿主到开发步骤才查）、bootstrap 配置或受保护配置不能被宿主读取器接受（如符号链接、字段不符）、新建运行时 admission 不选中本任务、本任务不是 bootstrap 当前 nextTask（宿主在开发步骤内才查）。宿主启动时的其余核对（运行定义、嵌套 specs 保护、恢复的创建会话与 runtime 指纹等）都在 `host_ready` 之前由宿主本身完成，失败时命令不会运行。命令跑完后驾驶员重读预检时核对过的全部规范目标、运行定义、PLAN.permissions 中的文件及已批准的 bootstrap 规格（requirements/design/tasks 与 `.cm-specs-status`），任何一个变化都退出 2：命令须只读核验。静态校验失败在启动宿主前退出 2，运行存档不变。


## bootstrap 规范任务的当前会话宿主路径

驾驶员不支持的规范任务（见上节），或当前会话能直接持有交互进程时，按本节手动应答。

完成 T-001 骨架和其独立审查后，为 T-002 从已批准规格生成独立运行定义，`scope` 列出全部 `cmInitRuleTargets(selection)`，`requirements` 可为空数组。由当前真实 Claude 会话持有可交互进程句柄；下面是启动示意，路径和会话 ID 必须换成当前实际值：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve --config "{T-002-run.json}" --mode create --host-context "{当前真实会话ID}" --control-config "{POLICY.json}" --runtime claude --review-config "{review.json}" --bootstrap-config "{bootstrap.json}"
```

`bootstrap.json` 为 `{"selection":{"versionControl":"local","modules":[],"analysis":"当前项目分析"}}` 这类已确认选择。v2 POLICY 明确 bootstrap:write。收到 `host_ready` 后发送带原运行定义 `identity` 的 `{"version":2,"requestId":"t002-advance","operation":"advance","identity":{...}}`；不要等控制响应才处理反问。`init_generate` 按实际请求的 targets、templates、existing 和项目材料生成 `{status:"generated",documents:[{path,content}]}`；`init_verify` 对宿主给出的最终 documents、selection、inspection 及当前项目逐项核验，返回 `{checks,constraintChanges,application,retrospective}`。五项 checks 各给真实 `status/evidence`；不能把预写 JSON 或 `inspectCmInitDraft` 的结构检查冒充语义证据。每条 `host_result` 必须带该次请求的 `sessionId`、`callId`、`requestDigest`。若缺当前会话的真实核验能力，停止并报告，不发送虚构通过结果；断联后按原 run 的 unknown 恢复表处理。

legacy 启动保留原 --allow-development 和 --allow-bootstrap-write，不含 --control-config，控制请求 version 1；原生成/核验结果合同与身份校验不变。

## bootstrap feature 与规则写入

已批准bootstrap feature优先用`0.bootstrap`；否则仅接受唯一一个数字前缀后slug恰为`bootstrap`的feature（如`1.bootstrap`）。
多个候选以`bootstrap_feature_ambiguous`拒绝。按原骨架→规范任务顺序。单任务bootstrap-config为`{selection:null}`或原cm-init选择；
批次 bootstraps 映射到具体 feature/task。v2 策略明确 bootstrap:write，单/批配置按原固定目标准备；legacy 另传原 --allow-bootstrap-write。原任务批准和独立 fresh Review 不能省略。
先按产品文档配置完整固定规范scope；requirements可为空数组；bootstrap原有批准specs需求/设计纳入逻辑保持不变。
init_generate复用原cm-init生成合同；init_verify五组检查加constraintChanges/application/retrospective，详情以产品文档为准。
宿主不自行落指令文件：JS固定写入、读回、同次handoff/Review、N7重载。首次规则任务只允许空目标或已有 Learning 段的 AGENTS.md，须保留其余既有正文。同一 bootstrap feature 中，前序规则任务已完成且固定目标的 HEAD、暂存区与工作文件一致时，后续规则任务可基于该提交刷新正文；当前 `## 项目教训` 段仍原字节合入并接受 `init_verify` 和独立 Review。

## 多代码目录

**v2：** development:conversation 配原 protected-conversation-config；QA 实跑需 qa:run 与原 workflow。恢复保持同一根、保护方式与策略。多根不产生额外授权，bootstrap/保护模式的驾驶员缺口仍如实拒绝，不改用旧权限绕过。

多代码目录使用原run/batch可选codeProjects与共同工作区codeProject，scope/requirements加各根相对前缀。
只用已声明真实根；protected-conversation-config的每条检查及workflow QA命令增加codeProject绑定实际cwd，
每根至少一条检查。读取develop的codeProjects/projectInstructions，返回前缀路径提案；原同一任务统一审查和完成，不自行拆任务。

## Codex 单任务：显式受保护执行

**v2：** 原当前会话文本提案模式选择 development:conversation，并提供 --protected-conversation-config；需要真实 provider 开发则选择 development:provider 并提供 --protected-config，模型/命令/预算仍来自原配置。
受保护 provider 模式常规第 1/2 轮开发与 fresh Review 由策略选择，不通过旧按轮参数补授权；真实对话仍须已覆盖本任务与实际发送范围，普通开始不自动授权未确认的外发。
resume 不能切 provider、保护方式、根或 scope。reviewer 诊断不是批准，工具/QA/文档缺能力仍停住，不能手补凭证。
QA 实跑需 qa:run 与原 workflow；QA 修复单任务另选 qaFix:manual/auto 与原子配置，protectSpecs:true 和子独立 Review 不省略。批次 qaFix 必须 disabled。
常规 advance 无 token；异常操作使用 R/Q 指定的 wire、launch 或 fix_status 含 child 的固定目标。设备/沙箱不可用时保留环境阻断，不能静默换模式。

不新增模型调用的方案：单任务和批次均可传`--protected-conversation-config {文件}`，配置固定为
`{checkCommands,timeoutMs}`，命令须已获准；检查命令用此预算，独立审查默认 900000 毫秒（15 分钟），可在 review-config 中单独覆盖，范围 1–3600000。preflight 输出有效 `timeoutMs`；此预算不进入授权配置摘要，旧运行可用原 runId 恢复。
需要模拟器、真机或系统服务的 iOS 项目（CoreSimulatorService、Xcode UI tests、Keychain 等），应将 specs 与代码分根，并选用有系统访问能力的当前会话宿主路径执行检查；实际检查进程必须在 Codex 原生沙箱外。仅改变目录或改用驱动脚本不会让沙箱内检查获得这些服务。同仓 specs 的受保护检查仍在 Codex 沙箱内，典型症状是模拟器不可用、UI tests 无法启动，SwiftPM 的 `swift build` 需要 `--disable-sandbox`；不要把这种失败记成产品测试通过。检查命令的构建产物放在代码根外，例如 `xcodebuild -derivedDataPath {代码根外的目录}`。检查自己新增的范围外未跟踪文件使原 run 进入 `blocked/check_output_out_of_scope`，状态原因和 stderr 列出最多 20 个相对路径；操作员清理产物后在原 run 重试。开发者造成的范围外改动仍是 `unknown/out_of_scope`，不得据此放宽 scope。

develop若有`editMode:"protected-text-v1"`，只读并返回`{status:"succeeded",value:{原开发/Learning结果},edits:[{path,beforeSha256,content[,mode]}]}`；
使用scope内expected摘要，正文完整UTF-8，null删除；可选`mode`为"0755"或"0644"，只用于写入的文件。新文件为0644。不得先自行写文件或执行命令。失败返回原status/code，blocked不能带改动。
驾驶员在受保护模式只接受严格UTF-8内容（保留BOM与CRLF），二进制文件启动前拒绝，不会被替换字符悄悄改坏。cm-fix的受保护提案仍只接受`{path,beforeSha256,content}`。
固定沙箱负责应用提案和原检查，不再请求宿主check；文档同步包含在同次develop提案。通道默认64KiB，可用`--input-limit`调到4MiB；二进制/超限明确阻断。
本机Codex sandbox不调用模型，也不改变Claude身份。其余QA/文档核验/子fix权限不变，不与下述protected-config混用。

legacy 按轮参数：用户已授权本任务该轮真实 Codex 开发调用及发送范围时，可选普通单任务入口的
`--protected-config {文件} --allow-provider-development-attempt 1`。这是原生受保护子进程，
不是当前会话直接改文件，不会因同仓布局自动切换；普通“开始开发”或`--allow-development`本身不授权外发。
读取产品文档“普通单任务入口选择受保护模式”的配置和命令示例；配置只含model/checkCommands/timeoutMs，
固定代码根/specs根、scope和实际宿主身份仍来自原run配置及host-context。命令也须事先获准。

旧入口的审查配置：启动须提供原 `--review-config` 诊断，普通 advance 直接派发 fresh 审查，不需要按轮审查参数。
初次create只能授权开发attempt 1；修正轮resume须按真实审批改为attempt 2，不重置原轮次或身份。
R1要求修改但尚未授权第2轮时保留changes_requested，不登记开发或当作unknown；补授权后再resume。
收到host_ready后仍按原协议advance/status/cancel/host_close；开发和检查由适配器执行，
当前会话不重复处理develop/check或手写凭证。补授权后沿原mode resume，不换runId。

QA命令复用同一specs只读沙箱。最终任务的documentationPaths必须已在批准scope内，
在同一次受保护开发调用中同步，随后进入原检查/handoff/Review；不派发宿主documentation_sync，也不增加模型轮次。
宿主仍处理qa_assess/qa_logic/qa_browser及只读documentation_inspect；不得借这些请求改代码、规格或指令。
浏览器仍遵循原工具、目标、证据与清理约束；此模式只对开发及命令子进程提供OS保护，不把宿主语义报告冒充沙箱证明。
只有原QA/文档核验/完成门禁通过才返回run_done；缺能力或核验blocked仍阻断，不手工补状态。
当前受保护父运行可接原 QA-fix 参数，但子owner/template的configuration必须显式protectSpecs:true，
否则在父运行建store前拒绝。v2 使用冻结 qaFix 模式与原子配置，legacy 保留原每项权限；auto_fix 策略和最多三轮 QA 不变，不因父开发/审查选择取得范围外子权限。
子修复的文本提案合同见`../../cm-fix/references/js-host.md`“同仓specs的受保护修复”；收到对应editMode时宿主不直接落盘。
旧 protected factory 的 CLI 组装恢复入口已停用；旧 grant 登记在指纹检查前以 runner_invocation 拒绝。无 grant 的历史不由指纹猜测身份，指纹不匹配时保留现场并用 `cm-ai-run.mjs inspect-history --config 原run.json` 只读查看。v2 的 provider 模式共用当前会话执行合同，单任务/批次仍按原 provider 路由配置选择实际运行端，批次 QA-fix 不支持。两协议不改变 Git、安装和发布权限；恢复不得在受保护模式与默认会话模式之间切换。
