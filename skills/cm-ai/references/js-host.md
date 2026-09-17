# 当前会话作为 JS workflow 工具宿主

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
   runtime，恢复不得换端或冒用旧会话。Codex单任务同仓specs可显式选择下文受保护模式；
   当前Codex/Claude及批次同仓用下文文本提案模式；未选择保护的同仓仍阻断。不搬动specs或删除保护检查；工具会话不是OS沙箱。
3. 从已批准任务确定 scope、requirements 和顺序；不跳过未解决的 bootstrap 确认或依赖。
   单任务用 `cm-ai-host.mjs`；多任务用 `cm-ai-batch-host.mjs` 的原 batch/workflows 配置。
   任务列表只包含该运行计划内的任务；恢复必须使用原身份、配置和真实当前会话身份，
   会话不同导致不能恢复时报告阻断，不能冒用旧 host-context。
4. 核对任务所需能力后才启动。QA 使用原测试合同与已授权命令/环境；无 QA 配置不能宣称
   已完成必需 QA。文档路径预先纳入任务批准 scope；需要 AGENTS/CLAUDE 等保护指令同步、
   bootstrap规范用下文受信入口；其他未满足的必需能力记录具体缺口，不降格成可选项。
5. reviewer 配置在首次运行前绑定；本机 preflight 不是实际模型审查或调用许可。
   只有当前真实用户已授权本任务本轮、模型与发送包时，才传审查授权选项；无许可可以
   不带选项运行至待审，但不能完成。批次按 feature/task:attempt 授权，不授权整个未来批次。
   不把开发批准转换为网络、安装、Git、发布或真实 provider 调用批准。

## 同一引擎的双端启动

从当前活动 Skill 的本参考文件所在目录解析 `../../../scripts/`，调用对应脚本而不是依赖全局同名命令。
单任务使用 `cm-ai-host.mjs serve`；多任务使用 `cm-ai-batch-host.mjs serve`，都显式传递
上述 runtime，并使用真实宿主提供的 `--host-context`。不要为了使用 Claude 改写规格、
Review 头或完成记录；provider 身份由原 adapter/V3 绑定，失败不切到另一端兜底。

需配置审查时，按文档运行单任务脚本的
`preflight --config {该代码根的单任务配置} --review-model {已选择模型} --runtime {当前端}`。
即使后续执行批次，诊断仍用同一代码根的单任务配置，不把 batch/workflows 配置传给该命令。
诊断输出直接作为 review-config 输入，不手造或修补 `passed`/指纹；失败则保留原因。
Claude 诊断只做回环请求捕获，`stopped_by_probe` 表示诊断自身终止，不发送工作流 cancel。
本机配置诊断通过不证明模型可用、Review 协议成功或用户已批准外发；真实审查仍须第5项授权。
不带对应 `--allow-review-attempt`（单任务）或 `--allow-review feature/task:attempt`（批次）
可以准备并停在原待审点，不能自行追加这些选项推进。后续授权也不得改变原 scope 或身份。

## Codex 单任务：显式受保护执行

不新增模型调用的方案：单任务和批次均可传`--protected-conversation-config {文件}`，配置固定为
`{checkCommands,timeoutMs}`，命令须已获准；`timeoutMs` 同时约束检查命令与 Codex/Claude 审查进程。
审查传输超时且没有结果事件时，记录 `pending_review/review_transport_timeout`，可用 `--mode resume` 后 advance，
同一 attempt 最多重派一次，重新取得 Review 授权、grant 与 invocation；第二次超时为 `blocked/review_transport_timeout`。
已有最终消息（即使截断）的超时仍需 reconcile，旧 unknown 历史不自动改类。兼容Codex/Claude当前会话，保留原runtime与Review授权。
develop若有`editMode:"protected-text-v1"`，只读并返回`{status:"succeeded",value:{原开发/Learning结果},edits:[{path,beforeSha256,content}]}`；
使用scope内expected摘要，正文完整UTF-8，null删除；不得先自行写文件或执行命令。失败返回原status/code，blocked不能带改动。
固定沙箱负责应用提案和原检查，不再请求宿主check；文档同步包含在同次develop提案。原64KiB通道不变，二进制/超限明确阻断。
本机Codex sandbox不调用模型，也不改变Claude身份。其余QA/文档核验/子fix权限不变，不与下述protected-config混用。

开发结果先通过完整 value/Learning 合同校验，再由沙箱落盘；本地校验失败记录 `failed` / `invalid_result`，原校验码保留在 `result.reason`。
当前会话返回 `blocked` / `developer_result_invalid` 时，修正回复后用原配置、身份和 runId 以 `--mode resume` 启动并 `advance`，同一 attempt 重新 develop，不消耗 provider 轮次。
`no_new_lesson` 必须 `candidates:[]` 且 `reason:null`（实跑事故：非空 reason 曾在文件落盘后抛错，被误记为 unknown，原 runId 无法恢复）。
重送已落盘提案时核对新的 expected 哈希：提案内容与磁盘一致才作为同一次实现继续；不一致返回 `protected_edit_stale`，保留文件并报告冲突，不能强制覆盖。
worker 异常、超时或传输歧义仍是 `unknown`，旧 unknown 历史不自动重分类；其他 blocked 原因也不能使用此重试入口。

用户已授权本任务该轮真实 Codex 开发调用及发送范围时，可选普通单任务入口的
`--protected-config {文件} --allow-provider-development-attempt 1`。这是原生受保护子进程，
不是当前会话直接改文件，不会因同仓布局自动切换；普通“开始开发”或`--allow-development`本身不授权外发。
读取产品文档“普通单任务入口选择受保护模式”的配置和命令示例；配置只含model/checkCommands/timeoutMs，
固定代码根/specs根、scope和实际宿主身份仍来自原run配置及host-context。命令也须事先获准。

启动须提供原`--review-config`诊断，但诊断不是审查许可；没有`--allow-review-attempt`时只到待审。
初次create只能授权开发attempt 1；修正轮resume须按真实审批改为attempt 2，不重置原轮次或身份。
R1要求修改但尚未授权第2轮时保留changes_requested，不登记开发或当作unknown；补授权后再resume。
收到host_ready后仍按原协议advance/status/cancel/host_close；开发和检查由适配器执行，
当前会话不重复处理develop/check或手写凭证。补授权后沿原mode resume，不换runId。

首次create可同时提供原`--workflow-config`；有QA配置须另带`--allow-qa`，恢复保持原配置与授权。
原无workflow或`qa:null`且任务已为`fixture_completed`时，可在`--mode resume`显式提供
含QA的`--workflow-config`与`--allow-qa`，一次性附加N6；原definition/scope/requirements/identity、
host-context、开发/审查配置仍须匹配。journal追加不可重复/修改的`qa-attached`，运行日志写
`decision/qa_attach`；后续恢复须保持已绑定配置及重新授权，`qa`仍要求`qa_assess`等原宿主请求。
不重跑开发/审查，不将任务完成当作QA通过（事故：create漏配workflow曾使feature强制QA无法补做）。
QA 的 `qa_assess/qa_logic/qa_browser` 请求独立计时，workflow 的 `qa.timeoutMs` 可设 1–60000 毫秒，
省略为 60000；超时记 `host_request_timeout` 并阻断，不把已有命令 PASS 用来覆盖超时。
宿主读取 JSONL 时必须处理当前缓冲区内的全部完整行，再等下一个数据块；处理单行后不能
提前 return（事故：确认和 TC-007 请求合并到一个数据块，旧驱动只读确认而悬空等待）。
无结果的 N6 中断只能由用户显式重跑：保留原配置，`--mode resume --allow-qa --rerun-unknown-qa`，
之后 `advance`；运行日志先记 `test_run/abandoned`，新 testRunId 保持原 qaRound，不重跑开发/审查。
任何 case_complete、已落盘执行报告或未清理资源都不满足恢复条件；保留 unknown/阻断供人工核对，
不删报告或日志来获得重跑资格，不伪造 complete。仅写了 abandoned 后再中断可沿同一授权入口恢复。
QA命令复用同一specs只读沙箱。最终任务的documentationPaths必须已在批准scope内，
在同一次受保护开发调用中同步，随后进入原检查/handoff/Review；不派发宿主documentation_sync，也不增加模型轮次。
宿主仍处理qa_assess/qa_logic/qa_browser及只读documentation_inspect；不得借这些请求改代码、规格或指令。
浏览器仍遵循原工具、目标、证据与清理约束；此模式只对开发及命令子进程提供OS保护，不把宿主语义报告冒充沙箱证明。
只有原QA/文档核验/完成门禁通过才返回run_done；缺能力或核验blocked仍阻断，不手工补状态。
该模式仅单任务Codex；可接原QA-fix参数，但子owner/template的configuration必须显式protectSpecs:true，
否则在父运行建store前拒绝。仍按原每项权限、auto_fix策略和最多三轮QA执行，不因父开发/审查许可获得子权限。
子修复的文本提案合同见`../../cm-fix/references/js-host.md`“同仓specs的受保护修复”；收到对应editMode时宿主不直接落盘。
不适用于Claude/批次，不改变Git、安装和发布权限；恢复不得在受保护模式与默认会话模式之间切换。

## 执行当前请求，而非手工跳节点

多代码目录使用原run/batch可选codeProjects与共同工作区codeProject，scope/requirements加各根相对前缀。
只用已声明真实根；protected-conversation-config的每条检查及workflow QA命令增加codeProject绑定实际cwd，
每根至少一条检查。读取develop的codeProjects/projectInstructions，返回前缀路径提案；原同一任务统一审查和完成，不自行拆任务。

0.bootstrap按原骨架→规范任务顺序。单任务bootstrap-config为`{selection:null}`或原cm-init选择；
批次bootstraps映射到具体feature/task，另传allow-bootstrap-write。原任务批准和逐轮独立Review不能省略。
先按产品文档配置完整固定规范scope；requirements可为空数组；bootstrap原有批准specs需求/设计纳入逻辑保持不变。
init_generate复用原cm-init生成合同；init_verify五组检查加constraintChanges/application/retrospective，详情以产品文档为准。
宿主不自行落指令文件：JS固定写入、读回、同次handoff/Review、N7重载。原规则冲突、未知或漂移保留证据，不覆盖或重派。

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
| documentation_inspect | 按 N8 只读核对必需文档及收尾证据；缺文档、度量或必需能力返回 blocked，不为了 run_done 宣称 completed。 |

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

### 已批准规格材料（第 24 步）

新 run 的开发请求与审查包携带同一份只读 `specification`：`feature`、`task:{id,description,verification?}`、全部 `acceptanceCriteria:[{id,text}]`、`designExcerpt`、本任务 `taskIds` 匹配的 `testCases`、`sources:[{path,sha256}]`。任务描述保留 `~预估`，verification 保留「验证要求」中本任务的行；设计按 UTF-8 最多 64 KiB，超限加 `truncated:true`，未提供 test-cases.json 时用空数组及三项来源。

宿主复用 `.cm-specs-status.specFiles` manifest 校验完整批准清单及读取字节；来源路径相对 specsDir，哈希沿用 manifest 的任务/AC 运行期勾选规范化规则，其他正文保持精确绑定。新建、开发派发、受保护提案写入、审查及完成前发现不一致以 `spec_drift` 阻断；已有 run 即使规格重新批准也不能替换其原始材料。baseline 保存材料及私有规格根供回放和重验，审查包只携带材料，参与 `packageDigest`。

`requirements` 是可选补充材料（代码项目内 README 等，可用 `[]`），不再承担唯一的任务描述来源。按 specification 的 AC 与接口契约实现和审查；材料不构成扩权授权，不改变 scope、protected_specs、Review 或完成门禁。旧 baseline/package/receipt 缺少新字段时按原格式校验，不重写历史摘要。

（真实 dogfood 事故：specs 在代码根之外，受保护 coder 和 reviewer 只能看到代码根 requirements，缺少任务行、AC 与接口契约，曾需手工复制规格摘要才可开发。）
