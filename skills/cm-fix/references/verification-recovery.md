# 隔离验证失败的一次有界续审

此入口处理已持久化的 `review_verification_evidence` 失败，默认保留原 run、原包、原配置与失败历史。下述显式源码修订分支保留旧包，并追加绑定旧包的新根因包。它不把失败回执改成成功，也不增加默认 `abandon_review` 次数。每个 run 最多准备一次额外调用；该调用登记后，无论成功或失败，都不能再次使用本入口。该额外机会不重置、也不删除原有阶段预算：根因续审成功后，未来正常最终审查仍可按原 F24 合同恢复，后续修订审查仍按原 abandon 合同处理。

## 资格与边界

- 原运行已冻结 Claude `reviewVerification`，最新审查是 `unknown`，原始结果明确为 `failed / review_verification_evidence`。根因首轮、重新诊断后的根因、首轮最终审查和第二轮最终审查均可检查资格。
- 原观察须含 `process_closed`、`exit_code:0`、`signal:null`、`timed_out:false`，并由操作方明确确认旧调用已停止。旧记录没有 PID；上述组合只证明已记录的主进程关闭及停止声明，不是所有后代进程已退出的 OS 证明。不能用布尔声明替代关闭事件。
- 有效 `approved`、`changes_requested` 或阻断结论不能使用此入口。缺失结果、一般 `transport_incomplete`、外部模型／执行优化 reconciliation 路径以及带 `correction` 的旧观测根因补审包也不能使用。后者有特殊历史绑定，不能准备一条后续无法保持原包的续审。
- 原包内源码、模式位和包内容必须一致。配置指纹、模型、角色、任务 attempt 和业务审查轮次保持不变。
- 旧失败若没有辅助文件快照，资格检查会明确建立当前辅助快照，只约束准备后的调用。它不证明这些辅助文件在原调用时是什么内容，也不覆盖原指纹。
- 资格和准备都先在隔离副本运行全部冻结 baseline 检查，不调用 Claude。任一检查失败则拒绝，输出安全阶段诊断，原运行不新增准备记录。不得修改冻结命令。源码调整只可使用下述另行授权的受控入口；不能手动改源码后沿用原包许可。

## 正式步骤

1. 用当前源码的只读检查入口检查原 run：

   ```bash
   node scripts/cm-fix-verification-recovery.mjs --config /absolute/path/fix-config.json
   ```

   配置文件只用于定位原 identity 与存档；检查采用存档冻结配置。该入口不打开 writer、不更新原 state 或运行日志、不调用审查者。成功返回 `eligible:true` 和 `expected`；失败返回 `eligible:false`、明确代码及可用的安全诊断。它仍会执行隔离的固定本地检查。

2. 取得明确恢复授权后，在原驾驶员 PLAN 中设置 `mode:"resume"`、原 runtime/reviewRuntime/reviewConfig，并将 `hostContext` 填为当前真实会话 ID。若换过会话，另用 `originalHostContext` 填创建运行时的旧会话 ID；不得冒用旧会话身份。以及：

   ```json
   {
     "permissions": ["--allow-verification-recovery"],
     "expected": {"说明": "逐字使用只读检查返回的完整 expected 对象"},
     "previousInvocationStopped": true,
     "reason": "说明修复了什么以及为何申请这唯一一次续审"
   }
   ```

   `expected` 上面的说明仅占位，不能作为真实值。运行：

   ```bash
   node scripts/cm-fix-drive.mjs --plan /absolute/path/PLAN.json prepare_verification_recovery
   ```

   准备重新检查 baseline、旧失败与最新历史、原包及当前快照，然后追加 `fix-verification-recovery-prepared`。同一请求重复执行返回同一准备记录，不再写入；不同目标拒绝。成功结果包含 `authorizationDigest`，此摘要是绑定值，不是身份凭证。

3. 派发需要单独的明确授权。新启动的原 PLAN 设置 `verificationRecoveryAuthorization` 为刚返回的摘要，并保留原 `--allow-cause-review` 或 `--allow-final-review`。随后单独运行 `cause_review` 或 `final_review`。原生宿主对应参数是 `--verification-recovery-authorization DIGEST`。若原最终审查已经使用过旧 `recover_final_review`，仍须保留 `--allow-final-review-recovery` 及原 invocation 绑定；PLAN 的 `finalReviewRecoveryInvocation` 对应 `--final-review-recovery-invocation`，不能用本次摘要代替旧绑定。不带该摘要、旧摘要、配置或源码漂移均拒绝。派发使用新的 invocation，并排除所有原审查线程与作者上下文。

4. 取得有效审查结论后，沿原发布、N5、审后回归和完成门禁继续。恢复本身不批准审查、不勾任务、不登记问题已修复。续审仍失败时保留追加结果并停止，不自动重试。

父 `cm-ai-host` 的 `fix_action` **不转发这组新恢复启动参数**。QA 子修复若需此入口，使用独立的正式 `cm-fix-host`／`cm-fix-drive` 入口，保留原 `qaSource` 与 `--allow-qa-fix` 约束；不能从父入口直接复制一条新操作并假定可用。

## 诊断

| 代码 | 处理 |
| --- | --- |
| `fix_verification_recovery_unavailable` | 当前失败不符合限定合同；保留原结果。 |
| `fix_verification_recovery_process_unconfirmed` | 缺失规定的主进程关闭记录；不能补写旧事件。 |
| `review_verification_check_failed` | 冻结 baseline 在隔离环境失败；检查安全诊断，先解决实际阻断，不重派。 |
| `fix_verification_recovery_stale` / `fix_verification_recovery_binding` | 历史、目标或准备绑定不匹配；重新只读核对，不沿用旧许可。 |
| `fix_verification_recovery_drift` / `review_verification_package_binding` | 原包或当前文件快照变化；拒绝恢复，不修改旧包。 |
| `fix_verification_recovery_confirmation` | 缺失停止声明或合法原因。 |
| `fix_verification_recovery_authorization_required` | 缺少准备权限或本次派发绑定；准备不等于派发授权。 |
| `fix_verification_recovery_context` | 续审复用了历史线程；保留失败，不认为是 fresh。 |
| `fix_verification_recovery_used` | 唯一额外调用已登记；不能再次准备或通过旧放弃／恢复入口重试该调用。 |

旧运行未使用本入口时，journal 格式、配置指纹、原恢复上限与路径均不变；不增加协议版本，不静默迁移在途记录。

## 受控类型导入修订

当原冻结检查被 TypeScript 类型的按值导入阻断时，可以在明确授权后使用同一恢复操作的 `sourceCorrection` 分支。该分支不修改配置、不增加审查预算、不自动派发 Claude。当前只支持 `type-import-split`：把指定既有文件中的明确类型名拆成 `import type`，保留其余导入和源码。

资格比原包恢复更窄：仅 attempt 1 的 unknown 根因审查，且尚未编写测试或修复业务源码；不接受 QA 子运行、external/execution-policy、visual、重新诊断或旧观测 correction 包。原有效审查结论仍不能恢复。修订文件必须已在原冻结 `repair.scope` 内，不扩大范围。原根因包中的文件须与修订前源一致；当前辅助文件快照只证明本次预览时的内容。

1. 准备声明文件，不传任意替换代码：

   ```json
   {
     "kind": "type-import-split",
     "path": "src/theme.ts",
     "beforeSha256": "原文件精确 SHA-256",
     "typeNames": ["AccentKey"]
   }
   ```

   `path` 是代码根内相对路径；摘要必须来自当前真实文件。仅能处理实现明确支持的类型导入形状，不能用此入口改命令、业务逻辑、规格或规则文件。

2. 只读预览：

   ```bash
   node scripts/cm-fix-verification-recovery.mjs --config /absolute/path/fix-config.json --source-correction /absolute/path/source-correction.json
   ```

   预览在隔离副本应用修订并运行原冻结 baseline，不写原源码或原存档、不调用审查者。成功返回的完整 `expected` 绑定修订前后内容、原失败与包、配置、历史和当前文件快照。预览通过只是资格证据，不是代码审查通过。

3. 原 PLAN 使用 `mode:"resume"`，保留原运行和真实会话信息，填入完整 `expected` 和相同 `sourceCorrection` 声明，同时设置：

   ```json
   {
     "permissions": ["--allow-verification-recovery", "--allow-source-correction"],
     "sourceCorrection": {
       "kind": "type-import-split",
       "path": "src/theme.ts",
       "beforeSha256": "与预览一致的原摘要",
       "typeNames": ["AccentKey"]
     },
     "previousInvocationStopped": true,
     "reason": "说明类型导入阻断及本次明确授权的修订"
   }
   ```

   执行同一个 `prepare_verification_recovery`。宿主先追加 intent，占用原 run 唯一恢复预算，再精确原子替换。随后重跑原复现命令，原缺陷失败签名仍须匹配，并通过冻结检查，才追加 prepared。失败保留已写的源码及失败证据，不派发审查、不自动回滚、不把失败登记为已修复。

4. crash 后仅允许以同一声明、同一预览目标和明确停止声明收尾。文件必须精确等于已登记 before 或 after；第三种内容拒绝。检查合计最多执行两次（初次执行，加一次中断后的重验），不重置审查调用计数。新声明、该额外预算已经占用或有效拒绝都不能换入口重试同一次续审。该限制不封死随后正常阶段的原 F24／修订 abandon 路径；各自原资格、明确权限、fresh 线程和上限仍须满足。

5. 准备成功后，从派发 PLAN 中移除 `sourceCorrection`，保留返回的 `verificationRecoveryAuthorization` 和原 `--allow-cause-review`，单独执行 `cause_review`。新包带 `sourceRevision` 链，绑定旧包摘要、修订摘要和 before/after；使用新线程重新审查。旧失败记录、旧包和配置指纹保留。类型导入修改也必须出现在最终实现审查 diff 中；审查可见范围不扩大业务 repair 的写入权限。之后继续原红测、修复、回归、最终审查和完成门禁。

本入口可先用隔离项目验证；预览成功或合成测试通过均不证明任何真实项目已应用修订，也不证明 Claude 已独立审查。
