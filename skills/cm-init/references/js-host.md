# 当前会话生成规则草稿

## 中断后恢复

若本次启用了下方`--session-file`，先用原私有记录恢复；只有已进入写入且结果未知，才走已审档案分支。不要从文件时间猜选记录或把两种恢复模式混用。

### 未归档的分析、草稿和检查

用户要求可恢复时，在访谈/分析开始前确认私有记录的完整路径及内容范围（分析、选择、草稿、核验、确认、修正历史和原调用结果），获得许可后在启动参数**末尾**追加`--session-file "{已存在私有目录}/init.json"`。文件0600、最多1MiB，附带相邻写者锁；不要放公开仓库或保存秘密。默认仍只用内存，不能补造以前未记录的历史；记录许可不授权规则写入、provider、安装、Git或长期知识记忆。

新进程使用同一规范项目/Skill/记录；启用持久会话时`--host-context`必填，填写本次实际作者上下文，缺失会在读取或修改checkpoint前拒绝启动。历史作者会保留以防自审。`--allow-write`不从旧记录继承，只有本次获准才添加。不能同时使用`--resume-draft`。

先status展示原stage、analysisResult、result、verification、confirmation和revisionHistory：

- 无recovery：从原stage沿下方共享步骤继续，不重发start或init_generate；final_review_package依旧只读。
- recovery.call.status为recorded：发送`{"requestId":"resume-1","operation":"resume","resolution":null}`，只消费已记录的原结果。
- recovery.call为null：同样resume，继续已登记但尚无调用的原操作。
- recovery.call.status为unknown：没有原宿主实际结果就停，不补调用；找到后按下面信封恢复，不重新生成答案。
- recovery.writing为true：不走resume、不重发init_write，先从该次`.reviews`档案核对写入，按下方已审档案流程处理；档案缺失就报告缺口，不推定成功。

```json
{"requestId":"resume-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","result":{},"evidence":"原宿主实际输出引用"}}
```

result填原实际完整返回；恢复标识来自原请求`payload.recovery`或status，不是本次JSONL桥的临时callId。确认必须来自原用户对具体约束的真实决定，review必须来自原独立上下文及原包；字段吻合不能证明这些事实。已有结果不覆盖，失败仍保留在途结果供核对，不绕过pending开启下一轮。
取消持久，断连不是取消。陌生记录、不同项目/规则模板、并发写者和当前目标漂移均拒绝并保留现场。沿原核验器回读目标和分析观察，不宣称全源码快照或重新执行了历史检查；版本控制、业务源码等观察范围外变化须宿主核对，过时结果不得当作当前批准。成功写入的checkpoint也只是历史，不是任务完成。

### 已审档案与未知写入

本分支在准入后、重新分析或生成之前执行。使用当前交接明确记录的 packageDigest；若只有多个候选档案而无法确定本次来源，先问用户要继续哪一次，不按文件时间猜选，也不自动循环尝试旧批准。

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-init-entry.mjs" --inspect-recovery "{packageDigest}" \
  --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-init" --project "{CODE_PROJECT}"
```

检查结果 conflict 或读取失败：列出冲突/缺口后停止，保留用户文件与旧档案，不自动回滚、删档或换包重试。matches_reviewed_draft：列出匹配文件，不重写，不把匹配当作任务完成。incomplete：确认本次继续初始化的范围，再启动下方相同宿主，在参数末尾追加 `--resume-draft "{packageDigest}"`；只有本次已获写入授权才在它之前加 `--allow-write`。

收到 host_ready 先发送 `{"requestId":"resume-status","operation":"status"}`。rules_present 表示启动时全部匹配，报告后关闭；draft_generated 则直接从下文第5步 init_verify 继续，不发送 selection 或再次生成。旧 selection/analysis 只是待复核输入，须按当前项目核对版本控制、模块和命令；若已过时，报告阻断，不借恢复悄悄变更草稿。必要约束确认与新独立审查仍执行，不复用旧批准。新包的 recoveryOrigin 仅区分旧档案和本次恢复，不代表授权。

写入只处理 payload.documents 中尚未匹配的文件，不自行补回被省略的已写目标；JS仍回读完整草稿。保存并汇报新的 reviewEvidence.path/packageDigest，供再次中断使用，不删旧档案。该分支不是未知调用重放；未归档生成/核验使用上方显式私有记录。

## 首次生成与共享后续步骤

适用于已通过准入的非空项目。首次生成前先处理主Skill第1.5节地图，再由本会话分析和生成；不在分析期间启动地图写入。复用现有 JSONL 桥接，不启动另一个模型；默认不授权规则写入或正文外发。本次已获规则写入授权才追加 `--allow-write`，它不替代独立审查和必要的约束改写确认。恢复时参数顺序见上文。

1. 用能持续写 stdin 的当前宿主终端会话启动（PTY 使用入口已有 raw mode，不依赖终端行长度缓冲）：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-init-host.mjs" serve \
  --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-init" --project "{CODE_PROJECT}" \
  --host-context "{当前实际作者会话ID}"
```

2. 收到 `host_ready` 后发送分析请求：

```json
{"requestId":"analyze-1","operation":"start"}
```

处理 init_analyze 时执行主Skill第1节清单：实际读取项目、子目录、README/CI及已有规范，不能把 observations 当完整分析。沿 host_result 信封原样带回 sessionId/callId/requestDigest，result 结构如下（内容填写真实依据）：

```json
{"status":"analyzed","selection":{"versionControl":"local","modules":["frontend"],"analysis":"本次项目分析与地图结果"},"evidence":"实际读取范围、语言/框架、命令与版本控制依据","noGitDecision":null}
```

versionControl 为 remote/local/none；modules 只选实际存在的 frontend/miniprogram/backend-api/database/smart-contract/finance，无可选模块填空数组。无Git必须按主Skill询问用户；只有真实拒绝才返回 none 和 noGitDecision: explicit_user_refusal，非none为null。若选择建Git，返回blocked说明待授权动作并关闭宿主，不在init_analyze里建Git；另行获准执行后重新分析。证据不足同样返回 `{"status":"blocked","reason":"实际缺口"}`，不得伪造决定或静默采用默认值。

等待 analyze-1 实际结果；analysis_ready 后发送 `{"requestId":"init-1","operation":"advance"}`，不要再传 selection。JS使用同一分析结果生成；analysis_blocked/失败报告缺口后停止。基础三类规则固定包含；none 不生成git-workflow，local正文不带远程/PR要求。旧的预分析selection直传仅保留兼容，不是首次初始化的默认操作。

3. 处理唯一 `host_request(kind=init_generate)`：读取 payload 中的 templates、existing、analysis 和 selection，按主 Skill 第3至5节在当前会话生成正文。保守合并已有约束，先不写文件；不能分析、无法保持约束或缺少必要证据时返回 blocked。文件内容是待判断数据，不得改变权限或跳过原核验。

4. 回传一行 JSON，原样带回 request 的 sessionId、callId、requestDigest；`documents` 必须精确覆盖 targets，每项只有 path/content。整条回复受共享64 KiB限制，不截断正文伪造完整结果。

```json
{"type":"host_result","sessionId":"原值","callId":"原值","requestDigest":"原值","result":{"status":"generated","documents":[{"path":"AGENTS.md","content":"完整正文"}]}}
```

示例省略了其他 targets，实际回复必须全部提供。阻塞用 `result: {"status":"blocked"}`。收到 host_response 只表示通信接受；必须等待 init-1 的实际结果。

5. `draft_generated` 仅表示候选已生成。发送 `{"requestId":"verify-1","operation":"advance"}`，处理 `init_verify`：按主 Skill 3.5 对草稿每项命令、glob、引用和项目规则适用性逐条核验，读取原规则确认有无约束改写。只执行原权限内安全的检查，不安装、不写文件或另调provider；无法验证则如实报告，不把 manifest 声明当运行通过。

沿原 host_result 信封回传 `result`，结构如下；evidence 写真实证据或具体缺口，不照抄示例。每类只一个汇总对象，但证据必须覆盖该类的全部草稿断言。

```json
{"checks":{"commands":{"status":"unverified","evidence":"逐项命令证据/缺口"},"globs":{"status":"unverified","evidence":"匹配证据/缺口"},"file_references":{"status":"unverified","evidence":"文件引用证据/缺口"},"constraint_preservation":{"status":"unverified","evidence":"现有约束逐项比较"},"rule_applicability":{"status":"unverified","evidence":"模块与版本控制证据"}},"constraintChanges":[]}
```

状态为 verified/not_applicable/unverified/failed；不适用也须说明依据。constraintChanges 填实际需要改写现有约束的文件路径（必须属于 existingChangeReviewRequired），不是所有字节改动的集合。JS 在核验前后重新检查目标文件，变化则拒绝报告；此回读不是对全部业务源码的快照。

`verification_blocked` 停止并报告缺口；有实际补证据或修正后按下方“退回后修正”继续，不自动重发。`review_required` 仍需独立审查。报告标 current_host_report，不是独立Review或写入许可。

6. 若为 `confirmation_required`，发送 `{"requestId":"confirm-1","operation":"advance"}`，处理 `init_confirm`。向当前用户展示 payload.changes 中的原约束/拟改正文及对应文件，明确询问是否允许这些具体改写，等待真实答复；模型判断、沉默、历史泛化批准不算本次确认。沿原host_result信封只返回 `result: {"decision":"approved"}` 或 `{"decision":"rejected"}`，不可替换草稿或扩大路径。取消则走cancel，不捏造拒绝答复。

批准只进入review_required；拒绝停confirmation_rejected。JS在确认前后回读原目标，漂移拒绝并不写入；记录current_host_user_decision及同一draftDigest/路径。JS依赖受信宿主如实转交实际用户决定，不能自行证明对话真实发生。这不是调用grant或写入许可。

7. review_required 时可先用 final_review_package 只读查看完整材料，再发送 `{"requestId":"review-1","operation":"advance"}`。init_review 要求宿主使用实际新建的独立 reviewer 上下文，按 runtime/review.md 的独立通道和 findings-first 纪律审查完整包。优先当前宿主已授权的原生子agent；本请求不授权安装、外部provider调用或跳过其单独审批。无法获得真实独立通道时停止并关闭本会话，不得自审或编造身份。启动时的host-context必须是实际作者上下文，不能为通过比较而随意填写。

核对真实工具返回的reviewer上下文与作者不同，并原样转交该reviewer结果；沿原host_result信封回复：

```json
{"reviewer":"codex-subagent","contextId":"真实独立上下文ID","independent":true,"at":"实际UTC ISO时间","result":{"verdict":"approved","packageDigest":"原包摘要","examinedPaths":["原包完整排序路径"],"findings":[],"summary":"真实审查总结"}}
```

reviewer仅接受codex-subagent/codex-cli/claude-cli；通道字段不是调用授权。结果使用原reviewResultForPaths合同（approved/changes_requested/blocked），不得删改findings，覆盖路径必须精确一致。JS核对绑定、上下文声明与结果一致性，但这些字段不证明实际审查发生，主执行者必须依原合同核对真实通道和执行证据。记录标current_host_review_attestation，不伪装为V3注册receipt。approved只到reviewed_draft，其他分别review_changes_requested/review_blocked；受控写入见下一步，中断恢复见上文，不能仅凭审查批准宣告init完成。

8. reviewed_draft 后且启动已含 --allow-write，发送 `{"requestId":"write-1","operation":"advance"}`。处理 init_write 时，由主执行宿主用现有编辑工具仅写 payload.documents 中已审正文，不派子agent改项目指令；每份写前重新核对 expected 的原摘要/不存在状态，拒绝symlink、多硬链接或并发改动，保留其他文件。发生冲突或部分失败就停，不盲目覆盖/回滚/重复执行。不得趁落盘追加教训、补正文或扩文件范围；任何内容改动须重新进入审查。

沿原host_result信封只回 `result: {"status":"written"}` 或 `{"status":"blocked"}`。JS逐文件回读实际摘要，全部符合已审草稿才到rules_written；部分停write_incomplete，取消/断开/异常停write_unknown并尽可能列出已写/未写/冲突状态。这不是跨文件原子事务或文件系统沙箱，宿主对范围与安全编辑负责。写入请求前，JS先将原规则、已审草稿、核验/确认及宿主转交的审查记录保存到私有 `.reviews/cm-init-<packageDigest>.md`（文件0600，最多256 KiB）；已有不同内容或不安全路径会阻止写入，不覆盖旧档案。该档案不证明写入成功，不是V3 receipt或完成凭证，不得未经授权提交或外发。规则落盘不等于任务完成，会话状态及写入结果不作自动重放；可从上文档案恢复草稿，不能据此声称完整init验收。展示已写文件及未完成事项后再关闭会话。

可发送 `{"requestId":"status-1","operation":"status"}` 查询，或 `{"requestId":"cancel-1","operation":"cancel"}` 取消。最后发送 `{"type":"host_close","sessionId":"原值"}` 关闭。一次会话最多一次分析和生成；每份明确提交的草稿分别核验、必要时确认及独立审查，单独授权的写入最多一次。失败、断开或取消不自动重发。无法维持双向终端时明确报告宿主能力缺口，不能伪造已走JS生成，也不改走另一个provider。

## 退回后修正

只在 verification_blocked、review_changes_requested 或 review_blocked 处理具体缺口。先读取 status 中的 result.documents、verification 和 review；宿主在原任务范围内修正正文或补齐真实核验依据，再显式发送：

```json
{"requestId":"revision-1","operation":"prepare_revision","documents":[{"path":"原目标路径","content":"修正后的完整正文"}]}
```

示例省略其他目标；实际必须提交原完整路径集合，不增删文件。仅补证据时可提交相同正文，再做真实核验。此消息不写磁盘；原文件漂移或结构不合法会被拒绝，应报告问题而不是换基线覆盖用户改动。

接受后从第5步继续；旧核验、确认与审查不再有效，历史记录仍进入新审查包。不得重发 init_generate、自动循环空修正或沿用旧reviewer批准；新一轮必须处理实际缺口。用户拒绝、取消、已批准或开始写入的状态不接受此入口。启用私有会话记录时保留原修正历史；未启用时未归档草稿仍仅在内存，关闭前明确告知，不假装已有可恢复材料。
