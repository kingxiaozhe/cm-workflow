# JS 需求变更、已审修订与恢复

原业务规则仍为`change-mode.md` C1–C8、主Skill与`phase-timing.md`。本文件只说明同一宿主如何执行。

## 需求变更

启动原`cm-prd-host.mjs serve`命令并追加`--change "1.feature"`（只传编号亦可；多匹配先选）。
保留代码根/specs根、runtime、用例参数与原写权限。不会发起provider或开发，也不增加C模式没有的审查轮次。

1. `start {text}`提交真实变更。`prd_analyze`执行C1–C4，读取原三件套、测试合同与相关代码，
   分析已完成任务和AC的影响。文件/URL须实际读取，没工具就提问；不得推断已读取或外发权限。
2. 用户疑问以`advance {text}`真实回答。`change_requirements`、`change_design`、`change_tasks`
   各用一次advance推进。`prd_generate`执行C5、C6、C7/C7.5：前阶段产物与清单必须原样带入下一阶段。
   问题未解决仍停当前阶段；不要把提示的问题当答案。生成器只返回当前请求列明的正文，不写文件。
3. `change_check`用advance执行原自检。仅失败可修正，最多两次任务稿；不是独立审查或自动批准。
   `change_confirmation`向用户展示proposal的summary、增改删文件/feature、completed保留数、
   `changedUserCases`逐条内容与未决项。确认前不覆盖规格。
4. 取得真实明确决定后发送`decision {proposalDigest,approved,allowUserCaseChanges}`；三个字段
   分别绑定展示的提案、是否执行、是否明确允许列出的用户用例删除/弱化。模型的建议不算用户决定。
   普通变更不额外要求同意用例变更；仅changedUserCases非空时必须特别确认。拒绝不保存。
5. `save_draft`保存已确认版本：先归档完整原稿/提案，使审批失效，再按原字节检查写入，最后重算
   **全部**feature的specFiles/testCases，写原`.cm-specs-status=awaiting_review`。不自动approved，
   不勾任务、不运行cm-ai。输出C8摘要与路径，请人审后另行运行cm-ai。

已完成任务行逐字保留；待办改变标CHANGED、作废标DROPPED、新任务标NEW。变更文档保留旧版本行并追加版本。
不受影响的feature保持原样。允许提案列明并确认的新feature、删除feature及可选测试合同变化；
带已完成任务的feature不能删除。删除feature整体移动到该提案的私有removed归档（连同资产），
删除测试合同原字节也保留在提案归档。名称/编号碰撞、复用旧审查slug、符号链接、第三方改动均停止。

## 拆分审查中的需求与设计补正

原 split 发现需要改 requirements.md 或 design.md 时，不必先 prepare_revision：按原处置计划保存补正，
执行一次 split 自检，再记录包含需求与设计新 SHA 的回执；该 feature 随后以回执中的版本为准，低风险项也适用。
已经编辑但还没写回执的旧会话也走这条路，具体请求见 `js-host.md`「拆分审查要求补正需求或设计」。
它不增加审查轮次、不重写旧设计回执；尚无完整计划或文件 SHA 不符时，其他操作仍拒绝漂移。

## 已审整稿受控升级

原未审整稿仍用promote_design；不要切变更模式规避它所需的设计/拆分审查。
同会话已有**保存且split处置完成**的整批规格，需要需求/设计/任务或清单变化时，先解释变化与影响，
再`prepare_revision {reason}`，进入上述C模式；每项旧design/split尝试须已经处置，unknown不准绕过。
`self_check_failed` 属于已处置但待人裁决，允许修订；原失败检查与处置决定继续绑定在修订历史中，不算自检通过。
整批完整清单成为修改边界；新增/删除须在最终proposal明确展示并经用户确认。
它是需要重新人审的需求变更，不是旧批准续期。旧r1、处置、风险选择、自检轮次不删除、不改写；
旧证据只作历史，新的C模式自检单独记录，不冒充原新建模式剩余额度，不再派发同一stage的r2。

## 原材料改变：终止旧批次并关联新批次

同批已有审查后，原材料、用户用例或有效配置真正改变，剩余审查报 `prd_inputs_changed`，
整批修订又要求原拆分审查完成时，不必恢复错误的旧材料。先向用户说明旧批次、已审与未审范围、
替换原因及新目录，取得明确同意；模型判断、普通写入开关、时间流逝均不算终止授权。

1. 准备同一代码项目下独立的新 specs 目录，放入当前正确的 docs；沿用原用例路径和运行环境。
   新旧 specs 不得相同或互相包含，新目录不得有功能目录、审查记录或审批状态。不要复制旧规格与回执。
2. 用原参数和 `--session {旧批次}` 打开旧宿主。输入摘要漂移后仍可 `status`，普通推进继续拒绝。
   确认新 docs 与当前旧目录中已修正的 docs 一致，再发送：

```json
{"requestId":"replace-1","operation":"replace_inputs","approved":true,"reason":"用户明确授权的真实替换原因","successorSpecs":"新 specs 的规范绝对路径","successorSessionId":"prd-new-batch"}
```

3. 成功返回 `stage: inputs_replaced`。不可覆盖的记录位于旧目录
   `.reviews/prd-sessions/{旧批次}/inputs-replaced.json`，保存原会话检查点与待定调用、审查文件原字节、
   未完成审查的功能及阶段、旧输入摘要、修正后摘要、新批次输入摘要与原因；旧文件不重写。
   同样请求可重复读取；换原因、目录或新批次标识会拒绝。记录写成即终止，进程中断不撤销它。
4. 新宿主使用新 specs、指定的新 `--session`，首次追加 `--predecessor {旧终止记录的绝对路径}`。
   JS 核验项目、运行环境、会话标识与新输入摘要，把关联写入新目录 `.reviews/prd-predecessor.json`。
   恢复新会话时保留这份关联；随后从分析开始，风险选择、自检和规定的审查重新执行；高风险功能重审设计，全部功能重审拆分。
   旧批次的批准、处置、已用轮次不进入新批次；新摘要会明确列出前序批次、原因和全部重审的边界。

终止后只提供 `status` 与 `read_batch` 历史读取；审查、补正、修订、摘要、发布、取消和恢复调用均拒绝。
即使旧 docs 被移走，原参数仍能打开终止会话读取记录。旧 specs 含已终止产物，不能汇总发布或另开会话复用。
未知审查调用如实归档为未知，不补造成功或重新派发；`read_batch` 包含私有原文，不得外发。

限制：仅适用于未发布的新建批次；已经进入 C 模式、取消或发布的批次不能用此操作撤销历史。
此入口绑定现有参数下的文件内容和有效配置变更，不支持更换代码根、用例路径或运行环境。
当前输入及新目录须可读取、配置须有效；终止记录受原会话 16 MiB 上限约束，超限停止而不截断历史。
这是正式结束旧批次的例外，不是带未审项的 revision，也不授权规格批准、开发、安装或发布。

## 跨进程恢复

`status`返回runId与recovery。未保存的问答、材料结果、草稿、风险选择、自检轮次也保存在
`{SPECS}/.reviews/prd-sessions/{runId}/state.json`（0600）；它是私有执行记录，不是任务真相库，
不进入全局镜像正文。`--allow-log-write`包含该必要本地执行记录，规格/审查写仍分别授权。

以原项目/specs/mode/runtime/--cases参数和`--session {runId}`重连。无pending时按原stage继续advance；
有pending时先走resume：`resume {resolution:null}`消费已经记录的返回，禁止直接发送advance跳过去。
未知调用先从原宿主找回**实际原输出**，再传：

```json
{"requestId":"recover-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","result":{},"evidence":"实际原调用输出的工具/消息引用"}}
```

result必须是原返回，不可填空占位。信封只做绑定，宿主必须核实引用与实际执行，不得由模型自报批准。
找不到原返回时保持unknown，或对**不含任何prd_review调用**的操作显式放弃；不自动补调、不推断未执行。
审查恢复仍由原claim/r1发布器验原包与独立身份；
修正自检复用原start与result，保存中断只补归档提案缺失部分，第三种文件内容不覆盖。
显式cancel同时写cancelled checkpoint并清空active，是不可恢复为继续执行的终态；断连不等于取消。
旧版cancelled checkpoint残留active时，重连清空残留并保持终态（2026-09-17事故：cancel只写checkpoint，active拦住新操作而cancelled又拦住resume，形成死锁）。
旧版本没有checkpoint的会话无法还原未记录对话，明确报告。
状态/原材料或配置漂移不得解释为新成功；历史完成与当前执行资格分开。

### 放弃未知调用

非审查操作无法取得原输出时，可显式发送以下形态；`result`必须缺省，不能和`abandon`共存。

```json
{"requestId":"abandon-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","abandon":true,"evidence":"放弃原调用的工具/消息引用与原因"}}
```

callId/requestDigest必须绑定active中的未知调用，evidence不能为空；整个active只要含prd_review，就以`prd_review_recovery_required`阻断，不能借放弃规避claim-first单轮审查。
成功后丢弃整个active、不写result，checkpoint还原为active.before；decision/recovery日志只含operation、kind、callId与evidence的哈希/长度摘要，不含payload或证据正文。
随后可重新发起同一操作并收到新host_request；这只回退会话状态，不撤销已经发生的文件写入，原保存/修正冲突检查仍生效（2026-09-17事故：prepare_summary断连后缺少放弃未知调用的入口）。

### 可见的会话阻断

宿主返回`{status:'blocked',reason:<code>,recovery:<当前recovery>,completionAuthorized:false}`，调用方先读reason与recovery，再选择原输出恢复、显式放弃或取消。
可见code为`prd_operation_recovery_required`、`prd_host_result_unknown`、`prd_nothing_to_resume`、`prd_recovery_binding`、`prd_recovery_evidence_required`、`prd_replay_inputs_changed`、`cancelled`、`prd_turn_not_ready`及上述审查放弃阻断。
其他异常沿用共享transport脱敏；blocked不是完成授权（2026-09-17事故：真实恢复原因被统一host_request_failed隐藏，导致多轮误排查）。
