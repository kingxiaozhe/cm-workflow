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

## 已审整稿受控升级

原未审整稿仍用promote_design；不要切变更模式规避它所需的设计/拆分审查。
同会话已有**保存且split处置完成**的整批规格，需要需求/设计/任务或清单变化时，先解释变化与影响，
再`prepare_revision {reason}`，进入上述C模式；每项旧design/split尝试须已经处置，unknown不准绕过。
整批完整清单成为修改边界；新增/删除须在最终proposal明确展示并经用户确认。
它是需要重新人审的需求变更，不是旧批准续期。旧r1、处置、风险选择、自检轮次不删除、不改写；
旧证据只作历史，新的C模式自检单独记录，不冒充原新建模式剩余额度，不再派发同一stage的r2。

## 跨进程恢复

`status`返回runId与recovery。未保存的问答、材料结果、草稿、风险选择、自检轮次也保存在
`{SPECS}/.reviews/prd-sessions/{runId}/state.json`（0600）；它是私有执行记录，不是任务真相库，
不进入全局镜像正文。`--allow-log-write`包含该必要本地执行记录，规格/审查写仍分别授权。

以原项目/specs/mode/runtime/--cases参数和`--session {runId}`重连。无pending时按原stage继续advance；
有pending时只允许`resume {resolution:null}`消费已经记录的返回，禁止再次发送advance跳过去。
未知调用先从原宿主找回**实际原输出**，再传：

```json
{"requestId":"recover-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","result":{},"evidence":"实际原调用输出的工具/消息引用"}}
```

result必须是原返回，不可填空占位。信封只做绑定，宿主必须核实引用与实际执行，不得由模型自报批准。
找不到原返回就保持unknown/人工恢复，不补调、不推断未执行。审查恢复仍由原claim/r1发布器验原包与独立身份；
修正自检复用原start与result，保存中断只补归档提案缺失部分，第三种文件内容不覆盖。
显式cancel不可恢复为继续执行；断连不等于取消。旧版本没有checkpoint的会话无法还原未记录对话，明确报告。
状态/原材料或配置漂移不得解释为新成功；历史完成与当前执行资格分开。
