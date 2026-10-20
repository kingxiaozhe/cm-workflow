# cm-ai control policy v2

control policy v2 把运行能力集中到一个严格的策略文件。原配置继续定义模型、命令、路径与预算。
加载配置不自动开启能力；策略也不能补齐缺失的配置。新建运行显式选择策略，旧运行继续原协议。

## 策略文件与能力

`POLICY.json` 必须完整包含以下五个字段，不接受额外字段、缺失字段、布尔值或旧权限数组：

```json
{
  "version": 2,
  "development": "conversation",
  "bootstrap": "disabled",
  "qa": "disabled",
  "qaFix": "disabled"
}
```

| 字段 | 允许值 | 含义与前提 |
| --- | --- | --- |
| `version` | `2` | 固定为新版协议 |
| `development` | `conversation`、`provider` | 由当前会话应答开发请求，或使用原 provider 开发配置与保护边界 |
| `bootstrap` | `disabled`、`write` | 禁用或启用已批准 bootstrap 目标的规范写入；启用仍需原 bootstrap 配置与固定目标 |
| `qa` | `disabled`、`run` | 禁用或运行原测试合同与 QA 配置；必需 QA 不能靠 disabled 跳过 |
| `qaFix` | `disabled`、`manual`、`auto` | 禁用 QA 修复、显式选择原修复入口，或使用原已配置的自动修复；不改变修复子运行的门禁 |

`qaFix` 选择 `manual` 或 `auto` 时，`qa` 必须为 `run`；不满足时返回 `invalid_input`。
批次目前不支持 QA 修复，`qaFix` 必须为 `disabled`。其他值返回 `invalid_arguments`。
模式与配置冲突用 `invalid_arguments`；缺少必需配置仍沿原具体阻断，例如 `qa_fix_source_required`、`qa_fix_auto_authorization_required`。不得自动补开能力或改用另一入口。
`qa:"disabled"` 默认不创建实际 QA executor，仍执行 `qa_assess` 清单来源确认和固定检查点判定；驾驶员只需合法的 `{"confirmed":true}` 答案。已完成任务补齐必需 QA 的唯一窄例外见下方“附加首轮 QA 执行器”，不改变原策略。
单任务即使没有 `--workflow-config` 也保留该决策；只接入固定 60 秒确认窗口及现有固定规则，不生成默认 workflow、不启用 executor 或文档能力、不改已有配置指纹。已有合法 N6 决定直接复用。并行成员与 legacy 的原合同不变。
驾驶员的 v2 `advance` / `qa` 会在启动前核对 `answers/qa-assess.json`（即使当前任务尚在前序阶段）；`start`、`decision`、`complete` 不新增该答案要求。
关键路径登记使用现有工作流配置的 `qa.criticalPaths`，详见 [JS workflow control](js-workflow-control.md)。未登记关键路径的项目，N6 不做任何风险识别，只有这两个固定点。两点为 feature 完成及连续五项未 QA。`policies.tests` 只控制执行类型，不取消必跑；blocking cases 与环境 BLOCKED 合同不变。
触发必需 QA 却没有 executor 时，真实停点为 `qa_triggered`、`pendingAction:"qa_execution"`；不得报告 QA PASS 或 `run_done`。
`qaFix:"auto"` 只启用原自动修复能力，不替代其故障分型、范围、诊断、测试、fresh Review 和完成门禁。

审查不另加策略开关。当前已选任务在已确认范围内自动走最多两轮常规独立审查。
第 1 轮要求修改时，修订后使用 fresh Review；第 2 轮仍有阻断就停止，不创建第 3 轮。
审查配置仍在 create 时冻结。`--review-config` 缺失、模型或保护配置不可用时保留原具体阻断。

## 配置、来源声明与门禁的分工

| 材料 | 提供什么 | 不能证明什么 |
| --- | --- | --- |
| 已批准规格与当前用户对话 | 已确认任务范围与动作要求 | push、发布、部署或资金动作仍须单独确认 |
| `POLICY.json` | 已确认范围内明确启用的运行能力 | 不扩大 scope，不提供缺失模型或命令 |
| 原 review、workflow、protected、bootstrap、QA 修复配置 | 模型、命令、路径、保护方式与预算 | 加载配置不自动启用对应能力 |
| `reviewer`、`independent`、`decision_source` | 审查或决定的来源声明 | 不验证审查者身份或实际人工交互 |
| `expectedControl` | 显式恢复操作绑定的已展示状态目标 | 不授权新能力，不替代独立审查或完成凭证 |

CM 门禁检查来源声明的格式、任务与轮次、材料摘要、当前文件和执行记录的一致性，用于防手滑与过期证据。来源声明不验证审查者身份或实际人工交互；门禁不承诺抵抗拥有完整文件写权限和 shell 能力的会话造假。fresh 上下文、审查结果、检查通过和完成复查仍是正常工作流路径的完成条件。发布、部署、资金及其他范围外动作继续遵守其单独确认要求。

cm-ai 新旧入口均直接推进常规审查，不使用按轮 grant、TTL 或拒绝确认预算。策略、模型输出、operator 名称和返回 `approved` 不扩大本次任务范围；安装、push、发布、部署、资金和主网动作按其单独确认要求执行。

## 单任务启动

以下示例中的 `run.json` 是原准入工具生成且已核对的运行定义，`review.json` 是原 reviewer 配置。
当前会话 ID 来自真实宿主。脚本路径从活动 Skill 的插件根解析，不硬编码安装缓存。

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve \
  --config run.json --mode create --host-context "{当前真实会话ID}" \
  --control-config POLICY.json --review-config review.json --runtime codex
```

`--control-config` 位于原 config/mode/context 参数后，替代旧 `--allow-development`。
v2 **禁止任何 `--allow-*`**。`--workflow-config`、`--bootstrap-config`、`--protected-config` 等原配置参数按实际能力提供。
transport、模型选择与保护配置仍沿原合同；策略不是任意命令、动态模块或新 adapter。

收到 `host_ready` 后，发送请求 `version:2`；identity 沿运行定义和当前状态，不手改 attempt：

```json
{
  "version": 2,
  "requestId": "advance-1",
  "operation": "advance",
  "identity": {
    "repositoryId": "{原仓库ID}",
    "runId": "{原运行ID}",
    "taskId": "{当前任务ID}",
    "attempt": 1
  }
}
```

`advance` 沿原阶段推进。宿主过程中发出的 `host_request` 必须实时应答，不能等 advance 结束才读取。
当前会话只按固定任务与 scope 执行工具请求；开发、检查、QA 与文档结果沿原合同。
完成仍以原 runner、fresh 独立 Review、完成前复查及 finalizer 的真实结果为准。

## 驾驶员 PLAN

新 PLAN 必须显式包含相对 PLAN 文件的 `controlConfig` 路径。`permissions` 保留配置与运行参数，不含 `--allow-*`：

```json
{
  "config": "run.json",
  "controlConfig": "POLICY.json",
  "mode": "create",
  "hostContext": "{当前真实会话ID}",
  "runtime": "codex",
  "permissions": ["--review-config", "review.json"],
  "answers": "answers",
  "checks": [{"id": "syntax", "command": ["node", "--check", "target.mjs"]}]
}
```

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-drive.mjs" --plan PLAN.json advance
```

`checks` 必须是真实命令，结果由驾驶员实跑，不读取静态 `check.json`。
答案文件沿原合同：首轮 `develop.json` 或 `develop-a1.json`，第二轮只读 `develop-a2.json`。
自动审查可能要求第 2 轮开发。尚无 a2 答案时驾驶员 hold，在 `changes_requested/revision_answer_required` 停住，不写第二轮开发 intent。
读取原 r1 的真实 findings 后准备修订答案，再沿同一 run resume；不复用首轮答案。
纯 bootstrap 规范任务首轮始终 hold，先读真实 r1，再准备第 2 轮规范答案。
`develop-a2.json` 与首轮被要求修改的实现逐字节相同时仍由原门禁拒绝，不靠再次推进耗掉审查轮次。

普通 resume 的 `advance` 不需要 `expectedControl`。create 禁止 `expectedControl`。
换会话 resume 仍提供当前 `hostContext` 与创建时的 `originalHostContext`，不冒用旧会话、不换 runtime。
驾驶员不从 journal 或临时 status 自动生成、刷新恢复目标。

## 显式恢复：先展示目标，再固定它

`abandon_review`、`abandon_effect`、`develop_redo`、`bootstrap_review_recover`、`completion_rework`、`reconcile_review`
及原 QA 修复 `fix_action` 的显式恢复子操作，
必须绑定操作者实际看到并选择的原状态。普通 `advance` 的自动推进不需要这个绑定。

1. 以原策略与配置 `mode:"resume"` 只读 `status`，核对当前 state、code、identity 和原调用是否已停止。QA 修复子操作先读 `fix_status`，使用它返回的含 child 目标。
2. 展示待恢复操作及它会改变的原记录，取得当前真实对话中对此动作的决定。
3. 把该次返回的 `controlTarget` 完整复制到 PLAN 的 `expectedControl`；保留固定副本，不再刷新。
4. 使用相同策略、配置和身份发送显式恢复。需要 reason 的操作仍提供原合同的单行、最多 500 UTF-8 字节原因。
5. 返回 `snapshot_changed` 时停止。先核对变化与原决定是否仍适用，再形成新的具体决定；不自动读新 target 重发。

单任务 `controlTarget` 的严格字段集为：

```text
{version:2, identity, state, code, packageDigest, effectId, invocationId, revision}
```

这些值取自 status，包括原 null 值和完整 identity。`revision` 为状态记录摘要绑定；不根据名称猜值、不自己计算替代值。
目标同时绑定当前身份、状态、审查包、操作 effect 或 invocation 以及记录摘要。
不同任务、attempt、包、调用或记录发生变化时，旧目标不能消费。

QA 修复子运行的显式恢复使用 `fix_status.controlTarget`，包含同一父目标及额外的
`child:{runId,revision,stage}`。调用 `fix_status` 仍携带原父 identity、失败 QA 的 packageDigest 与 testRunId。
把这份含 child 的完整目标作为 `fix_action.expectedControl` 或 PLAN.expectedControl。
普通父 `status` 不提供 child，不能代替 `fix_status`。父目标先核对，子目标在子运行实际 owner lock 内核对；
子记录或阶段变化时拒绝，不根据模型描述或父记录重建 child，不自动刷新旧目标。

例如 `develop_redo` 的恢复 PLAN 沿上述新 PLAN 改为 `mode:"resume"`，另添加真实单行 `reason` 与刚才展示的原 `expectedControl`：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-drive.mjs" --plan recovery.json develop_redo
```

直接宿主请求添加 `version:2`、同一 identity、`operation:"develop_redo"`、`reason` 与完整 `expectedControl`。
`abandon_review`、`abandon_effect`、`bootstrap_review_recover` 等保留各自原业务前提和预算；expectedControl 不绕过它们。
缺目标返回 `invalid_input`；目标陈旧或错配返回 `snapshot_changed`。

批次 target 的严格字段集为：

```text
{version:2, batchId, taskKey, member:{单任务controlTarget完整字段}, batchDigest}
```

批次 status 默认返回当前成员的目标，不新增 `status.taskKey`。成员恢复用原 `taskKey`，绑定原批次、具体成员、成员状态与批次摘要。
不能把一个成员目标用于另一成员。
批次 PLAN 继续使用原任务 key、配置、答案布局与 checks 映射；不通过 v2 开放原本不支持的子运行能力。
批次宿主接受驾驶员传入的 `--mode create|resume` 布局，也保留原不含 `--mode` 的布局：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-batch-host.mjs" serve \
  --config bundle.json --host-context "{当前真实会话ID}" \
  --control-config POLICY.json --review-config review.json --runtime codex
```

含 mode 的布局是在 `--config bundle.json` 后加入 `--mode create|resume`。
顶层 mode 是入口兼容参数，各成员仍按自己的原运行是否存在选择 create 或 resume；它不强制整个批次使用同一种成员模式。

## 单任务启动型恢复：launchControlTarget

QA 重跑、QA 配置修订、附加首轮 QA 执行器、规格换绑、范围追加和一次开发续次在创建 host 前改变恢复输入，使用单独的启动快照。
先按原配置只读 status，展示操作和前提，把原 `status.launchControlTarget` 完整保存到普通 UTF-8 JSON 文件，
再在原 `serve --mode resume` 启动中提供 `--expected-control FILE`。不能用 `status.controlTarget` 代替启动快照。
目标文件严格校验，拒绝重复键、软链接或硬链接；不自动计算或刷新目标。
真实 writer lock 内先核对 durable snapshot 与回放状态，缺失或陈旧时不执行修订、不追加恢复 journal。

| 原恢复动作 | v2 启动参数，另带原配置与 `--expected-control FILE` |
| --- | --- |
| 重跑未知 QA | `--rerun-unknown-qa`；环境故障还可提供原 `--qa-environment-failure REASON` |
| 重跑已阻断 QA | `--rerun-blocked-qa`；仍满足原可重跑条件与预算 |
| QA 配置修订 | `--revise-qa-config OLD_WORKFLOW.json --qa-config-revision-reason REASON`；当前 `--workflow-config` 提供已核对的新配置 |
| 原运行范围追加 | `--revise-scope SCOPE.json --scope-revision-reason REASON`；SCOPE.json 是包含全部原路径的完整 JSON 数组 |
| 一次 a2 开发续次 | `--development-rework --development-rework-reason REASON`；不改变 scope |
| 附加首轮 QA 执行器 | `--qa-executor-config FILE --attach-qa-executor-reason REASON`；仅限下节全部前提满足的原单任务 |
| 已批准规格材料换绑 | `--rebind-spec-material --spec-rebind-reason REASON`；保留原重新批准与漂移门禁 |

例如重跑符合原条件的已阻断 QA：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve \
  --config run.json --mode resume --host-context "{当前真实会话ID}" \
  --control-config POLICY.json --review-config review.json --workflow-config workflow.json \
  --expected-control launch-target.json --rerun-blocked-qa --runtime codex
```

`launch-target.json` 保存此前展示的完整 launchControlTarget，不能从本次启动的新状态替换它。
这些入口仍保留各自原恢复条件。范围追加与一次开发续次必须由人工在启动时显式开启，不能由会话 wire 请求自行开启；批准原因与实际追加时间写入原 journal。它们互斥，也不能与其他启动恢复合用。启动参数不是人工身份认证机制，执行者仍须遵守当前对话的人工批准边界。
普通 wire 操作的 `expectedControl` 与启动参数 `--expected-control` 是两种用途，不可互换。
### 卡死任务重开：v2 create supersede

旧运行已终止（blocked、cancelled、unknown 或符合原条件的 fixture_completed），且原运行没有剩余的合法恢复入口时，可用新 runId 重开同一任务：

1. 用旧运行的原配置只读查看：`node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-run.mjs" inspect-history --config 旧run.json`，把返回的 `supersedeTarget` 原样保存为普通 UTF-8 JSON 文件，并向用户展示旧运行状态与重开原因。
2. 用户批准后，新运行定义（同 feature、同 task、新 runId）启动：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve \
  --config 新run.json --mode create --host-context "{当前真实会话ID}" \
  --control-config POLICY.json --review-config review.json --runtime codex \
  --supersede-reviewed-evidence --supersede-reason "单行原因" --supersede-target target.json
```

宿主在建新 journal 前沿用旧版重开的全部前提（tasks.md 未勾选、旧 writer 已关闭、无未结 effect、代码漂移规则不变），并额外要求：只有一条未被取代的直接前驱运行，且它当前的启动投影与 `target.json` 完全一致；宿主先锁住旧运行的 writer，再比较目标并**在锁内重新发现同任务运行**（必须仍只有这一条未被取代的直接前驱，且 `.execution` 下的运行目录集合与本次调用首次发现时完全相同（新增或消失的目录，包括尚无 journal 记录的失败残留目录，都算变化；首次发现之前就存在、无法归属任务的历史空目录不在此保证内）——否则 `snapshot_changed`；错开时间的第二次重开因此也被拒），并一直持有到新运行写完替代记录、归档完成（或失败）才释放；本次调用自己持有的这把锁不会被「旧运行 writer 是否被占用」的检查（含执行优化的 prior-writer guard）误判为外部占用，其他进程同时打开该文件时仍判占用：预览后旧运行已变化返回 `snapshot_changed`；旧运行正被恢复或另一次重开占用时返回 `supersede_unavailable`。两种情况都不自动刷新目标、不归档证据、不建新运行。缺少目标返回 `invalid_input`；legacy 入口带 `--supersede-target` 返回 `invalid_arguments`。新运行从第 1 轮开始，旧运行 journal 原样保留，旧 handoff／回执按旧版规则归档到 `.reviews/.superseded/`，最后一次审查结论作为参考带入。驾驶脚本 PLAN 把三项放进 `permissions`（`--supersede-target` 路径相对 PLAN）。

### 附加首轮 QA 执行器

此入口只补齐原已完成任务的必需 QA。必须同时满足：原运行是 v2 单任务、由创建时的同一真实 host 续接；冻结策略为 `development:"conversation"`、`bootstrap:"disabled"`、`qa:"disabled"`、`qaFix:"disabled"`；没有 workflow、旧 QA 附件或 QA 配置修订。原任务必须已 `fixture_completed`，当前代码和审查材料仍有效，已有绑定同一任务与包的合法 `triggered` 决定，而且原 run 尚无任何 QA 轮次。

先核对原作者与 writer 已空闲。以原配置执行 `status`，将该次 `result.launchControlTarget` 完整保存到 `launch-target.json`。保留原 POLICY、workflow 缺席状态、全部冻结 inputs、审查和任务完成记录，不重新 develop、check、review、complete 或修改任务勾选。

另存 `qa-executor.json`，严格只含 `commands`、`environment` 和可选 `timeoutMs`；命令与环境沿现有 QA schema，不能添加 `criticalPaths`、文档路径或其他能力。例如以下占位内容须换成已核对的真实项目命令与目标：

```json
{
  "commands": [{"id": "project-tests", "caseIds": [], "command": ["{项目测试程序}", "{已核对参数}"]}],
  "environment": {"kind": "web", "carrier": "browser", "target": "{已确认测试目标}", "scope": "local"}
}
```

沿原 PLAN 保留 review、protection 等全部参数，以 `mode:"resume"` 增加下列 permissions；原因必须为非空单行，最多 500 UTF-8 字节。目标来自文件，不使用 `PLAN.expectedControl`，也不放进 `status` 的 wire 请求：

```json
["--review-config", "review.json",
 "--qa-executor-config", "qa-executor.json",
 "--attach-qa-executor-reason", "为原已完成任务执行已触发的必需 QA",
 "--expected-control", "launch-target.json"]
```

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-drive.mjs" --plan PLAN-attach.json status
```

此 `status` 启动只登记唯一的 `qa-executor-attached`，不执行 QA、不重判原决定，也不改变旧 fingerprints 或 records 前缀。适用交互式用例仍须原浏览器能力声明与真实 runner；配置存在不证明能力可用。缺少或陈旧的目标、源文件漂移、未触发或已开跑 QA 均拒绝；不能与 legacy `qa-attached`、配置修订、QA 重跑或规格换绑混用。

登记后，普通 resume 保留 `--qa-executor-config qa-executor.json` 和原 review/protection 参数，删除 `--attach-qa-executor-reason`、`--expected-control`。`qa` 保持原有的只判定语义。以原已完成任务执行 `advance`，复用原包和决定，由现有执行器运行 QA；只有真实 PASS 后，`advance` 才自动进入 `context_refresh`，失败时不会进入 N7 或派发下一任务。FAIL、BLOCKED 或 unknown 保留原结果并阻止后续门禁，本入口不提供结果替代或自动修复。

附加后不带配置，或改变配置，都拒绝恢复。重复登记只在尚无 QA、源码仍有效且原 target、reason、config 全部相同时幂等，不追加第二条记录；QA 已开跑后应去掉 reason/expected，使用已绑定配置普通恢复。不能暗改原策略为 `qa:"run"` 或用 legacy 权限解阻。

新任务应在 create 前准备真实 QA 配置，并选择 `qa:"run"`；不要把可预见的执行能力缺口再次冻结到新运行。此恢复例外仅适用于原任务，不给后续任务默认开启执行器。

## 旧运行与迁移拒绝

| 输入或情形 | 结果 |
| --- | --- |
| PLAN 不含 `controlConfig` | 沿原请求 version 1 与能力开关，常规审查直接派发 |
| cm-ai journal 含旧 grant 通道的审查登记 | `runner_invocation` 在指纹检查前拒绝；保留原记录，`cm-ai-run.mjs inspect-history --config 原run.json` 只读查看 |
| v2 入口带任意 `--allow-*` | `invalid_arguments` 或驾驶员启动前迁移拒绝 |
| 旧运行通过 v2 执行，或 v2 运行通过 legacy 执行 | `fingerprint_mismatch`，不转换历史后继续 |
| 策略启用的能力缺配置 | 沿原具体配置阻断；模式冲突用 `invalid_arguments`，不自动开启 |
| disabled QA 仍由原判定触发必需 QA | `qa_triggered`、`pendingAction:"qa_execution"`，没有 PASS 或 run_done |
| 无 workflow 的已完成 v2 单任务缺首轮 QA 执行器 | 仅在上节全部前提满足时显式附加；原策略、指纹与历史保留，不自动启用 |
| 批次 `qaFix` 不是 disabled | `invalid_arguments` |
| 显式恢复缺固定目标 | `invalid_input` 或驾驶员启动前拒绝 |
| 固定目标已陈旧或不匹配当前状态 | `snapshot_changed`，不自动刷新 |
| 恢复时策略改变 | `fingerprint_mismatch`，不替换原策略 |
| 恢复时原配置发生变化 | 沿原指纹与配置漂移门禁拒绝 |
| v2 create supersede 缺 `--supersede-target` | `supersede_unavailable` 或 `invalid_input`，不走旧入口作废运行 |
| v2 create supersede 目标与旧运行当前状态不符 | `snapshot_changed`，不归档、不建新运行 |

v2 策略随新运行持久化并纳入新版执行指纹。旧 metadata 中该字段缺省时，原格式与字节保持原样。
不重写旧 journal、旧指纹或旧控制记录，不把能回放旧记录扩称允许跨入口执行。
只读 status 可用于核对历史；执行入口仍必须匹配原协议。迁移需要独立的新运行决定，不能就地换入口规避旧证据。
单任务 QA 重跑、QA 配置修订、规格换绑、范围追加和一次开发续次使用上节 launchControlTarget；批次出口以实际支持为准（单任务 supersede 见上节），不把单任务恢复合同理解成全部旧出口已开放。

## 兼容 taskgate 的一次受控补正

**仅支持没有 JS ownership 的兼容 taskgate 任务。** cm-ai 新单任务和批次的第二轮仍正式 blocked，
本轮没有 runner-owned correction 入口。它们不能通过这里的 prepare/publish/mark-done 完成原 run。
存在保留的 JS journal、JS run 或 unknown ownership 证据时，兼容 writer 正式拒绝；不得删证据、手改 journal/batch 或改走兼容 writer 绕过 owner。
准备前先核对该任务没有 JS ownership，准备入口也必须在发现这种证据时拒绝，不能先生成无法完成的半套补正材料。
兼容 writer 自己会拒绝的残留（空数据库、缺少或不匹配的 `writer-ready.json`、孤立证书）同样在准备前拒绝，不自动修复或重新初始化。

下面的 version 2 `cm-controlled-correction` 是独立 taskgate 证据协议，不表示 cm-ai v2 已支持阻断恢复。
兼容 taskgate 的常规两轮仍有阻断时，保留原 blocked r2 与 P2 等 findings。
确需在原批准范围内修订时最多使用一次；不新建第三轮，不覆盖 r1/r2 或旧人审协议。
先实际修改批准 scope、完成相关检查与最终 Learning/handoff，再准备完整修订包。
兼容 mark-done 只更新权威任务 checkbox，不推进 N6/N7/N8 或产生 `run_done`。

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs" prepare-controlled-correction \
  --handoff "{最终修订handoff}" --reviews-dir "{原reviews目录}" \
  --feature "{原feature}" --task "{原task}" --project-root "{原代码根}" \
  --decision-source operator --reason "{真实补正原因}"
```

`--decision-source` 只允许 `operator` 或 `model`，记录为 provenance-only 的来源声明，非身份认证或人工批准。
该新命令和旧人工补正命令都不接受 `--human-authorized`，不自动调用模型，也不允许自报批准完成。
返回固定的新 `correction`、`handoff`、`review` 路径及 `correction_sha256`。
在 Review 发布前，用新返回的 handoff 与 correction 通过原 N4 门禁：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs" check-n4 \
  --handoff "{prepare返回的handoff}" --reviews-dir "{原reviews目录}" \
  --feature "{原feature}" --task "{原task}" --project-root "{原代码根}" \
  --correction "{prepare返回的correction}"
```

使用最终修订包执行 fresh 独立 Review，结果写入 prepare 返回的 review 路径。
不得复制旧批准或把自审写成独立审查。

新 Review 沿原头部字段，包含 `independent:true`、`attempt:2`、`round:2`、`handoff_sha256` 与完整 scope，
另绑定 `correction_sha256`。`at` 不得早于补正记录时间，reviewer 必须独立。
新版补正 Review 的正文必须是原始 JSON，精确包含 `conclusion`、`findings`、`resolved_findings` 三个键。
每条 finding 精确包含非空 `id`、`priority`、非空 `evidence`，priority 只接受 `P0`、`P1`、`P2`、`P3`；两个数组的 ID 合起来必须唯一。
`findings` 表示本次仍存在的问题，长度必须等于头部 `blocking_findings`。
`approved` 必须使用 `conclusion:"Zero findings."` 且 `findings:[]`；非 approved 使用 `conclusion:"Blocking findings."`。
已修复的历史 P2 只写在 `resolved_findings`，保留具体修复证据，不能混入当前 findings 后靠一句“零问题”宣布通过。
正文不加 Markdown 围栏，不夹带额外文字、字段或第二个 JSON 值；旧 human Review 正文保持原合同。

以下是新版补正 Review 文件的完整格式示例。占位摘要与证据必须替换成独立 reviewer 对最终包的真实结果，不可当作实际批准：

```text
---
at: {独立审查实际ISO时间，且不早于补正记录}
reviewer: codex-subagent
independent: true
task: T-001
attempt: 2
round: 2
verdict: approved
blocking_findings: 0
handoff: example-T-001-controlled-correction-handoff.json
handoff_sha256: {最终handoff的SHA-256}
correction_sha256: {prepare返回的correction_sha256}
scope:
  - src/target.mjs
---
{
  "conclusion": "Zero findings.",
  "findings": [],
  "resolved_findings": [
    {
      "id": "r2-P2-1",
      "priority": "P2",
      "evidence": "{已核对的修订路径、实际行为与回归检查证据}"
    }
  ]
}
```

若仍有 P2，把它放在 `findings` 并使用 `Blocking findings.`，同时将头部 verdict 与计数改成真实阻断结果。
合法的阻断 Review 可被封存，但不能完成任务。只有 `approved`、计数零、无当前 finding、完整 scope 与修订后实现/handoff/Learning 全部绑定有效才能通过完成门禁。
发布调用仍为：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-task-gate.mjs" publish-controlled-correction-review \
  --handoff "{prepare返回的handoff}" --reviews-dir "{原reviews目录}" \
  --feature "{原feature}" --task "{原task}" --project-root "{原代码根}" \
  --correction "{prepare返回的correction}"
```

发布仍不等于完成。仅满足无 JS ownership 前提的兼容任务继续 `check-n5` 和原 mark-done 门禁，传相同 selectors 与 correction；
mark-done 另绑定权威 `tasks.md`。内容漂移、旧 r1/r2 不匹配、未定稿 Learning、重复续次或新阻断均拒绝。
旧 `prepare-human-correction` 的授权与证据合同保持原样，两种 continuation 互斥，不能交叉消费证据。
两种 prepare 共用固定的 `{feature}-{task}-correction-prepare.lock`，记录 owner PID 与时间；全段互斥，锁冲突立即拒绝，不轮询等待。
另一协议只留下未封存的孤立 handoff 时，按原准备恢复核对保留它；已有 record、review 或 receipt 时禁止新增另一续次。
进程中断遗留的锁不自动清理。先核对 owner 确已退出，再核对准备与封存证据，通过明确人工协调处置；
owner 仍活跃或无法核实是否退出时保留锁与证据，不删锁重试，不宣称自动崩溃恢复。

## 交付证据范围

这里说明源入口的控制合同。源文件更新不表示已安装插件、当前会话已加载新版 Skill 或真实模型可用。
本地合成/临时目录检查、实际 provider 调用、独立 Review、安装与生产发布分别报告。
定向夹具和源码审查结果见本轮交接记录；本文示例不等于真实 provider 或业务运行验收。
cm-ai 新单任务/批次的 r2 blocked correction completion 未支持；上方独立 taskgate 补正不提供原 runner 或 batch 的完成路径。
本次本地方案不包含安装、提交、push、发布、部署或资金动作。


## 完成检查失败后原运行返工

`completion_rework` 只在 v2 单任务、未受保护的原配置 resume 且 `development:conversation` 使用，提交真实单行 `reason`（最多 500 UTF-8 字节）及先前 status 返回的固定 `expectedControl`。它不执行开发；成功后发送 `advance`，实际 develop 请求到达后才能修改代码。

仅未完成任务的第 1 轮、有效 approved 回执、最后 complete 检查失败 `completion_checks_changed`、代码/handoff/规格仍精确等于旧包且还有 develop+review 预算时允许。已有 a2 handoff 或 r2 文件拒绝。已完成、取消、pending、提交开始、其他漂移、重复及第 2 轮都拒绝。

宿主追加 `completion-rework-requested`，绑定原失败 checkpoint、effect、包、receipt、artifact/handoff 摘要及原因，保留旧 r1、a1 handoff、journal 与失败记录；把原运行推进 a2，清当前完成凭证，不改旧批准 verdict。a2 须改变已审代码并产出 fresh r2；旧批准不能完成新交付。第 2 轮未通过仍按既有上限停止，不开启第 3 轮。

该操作不提供 legacy、batch、bootstrap、跨运行 supersede 或已完成任务重开的入口。原 `complete` 仍支持仅修环境后对同一包复查。

当前入口仅支持原会话开发；provider 模式缺少绑定失败上下文的开发请求合同，因此明确拒绝，不将原 approved 当作修改指令。该能力须另行设计，不随本次原运行恢复扩大。

## 开发检查失败后追加原运行范围

`revise_scope` 用于 v2 单任务的 `development:conversation` 原配置 resume。未受保护入口保持原合同；受保护入口还必须满足下文的显式检查补充合同。
第 1 轮必须停在 `blocked/develop_checks_not_passed`，没有在途 effect、Review、提交或取消。
`bootstrap`、`qaFix` 必须 disabled；`qa:run` 保留原 QA 配置、执行及完成门禁。
每个运行只追加一次，不缩减原范围，不变更 run、attempt、规格或冻结配置，也不替代当前对话对具体新增路径的批准。

先展示 status 的真实 `launchControlTarget` 与具体新增路径，由人工批准后保存原启动快照。
`SCOPE.json` 为包含全部原路径的完整 JSON 数组，原因是非空单行文本（最多 500 UTF-8 字节）。
在原 `serve --mode resume` 增加 `--expected-control launch-target.json --revise-scope SCOPE.json --scope-revision-reason REASON`。
驾驶脚本 PLAN 的 `permissions` 同样包含这些启动参数；文件路径相对 PLAN 解析。运行 `status` 检查追加结果，再用原配置 `advance`。
不再使用 PLAN.scope、PLAN.reason 或 PLAN.expectedControl 发 `revise_scope`；wire 请求即使带正确 controlTarget 也拒绝。
陈旧目标、重复或缩减路径、保护路径、越界、链接、缺来源、漂移、已送审或名额不足均拒绝。

宿主追加 `scope-revised`，绑定原失败 checkpoint、原范围、创建基线、前一记录及原因。
新增既有路径必须与创建时全代码根 inventory 的 SHA、大小和文件模式一致；仅为这些路径有界补齐原字节。
新增文件路径必须在原 inventory 和当前磁盘均不存在，父目录不得由链接改写。
扩展必须使用创建时 version 2 的完整 inventory；version 1 基线或缺少冻结忽略路径清单的旧 version 1 ignore 证据返回 `scope_revision_unsupported_baseline`，普通旧运行读取和恢复保持兼容。
忽略、依赖和保护路径不通过该操作开放。原范围中的已改业务文件不重新取基线。
固定依赖、杂项及原 ignore 的路径限制由同一纯函数供执行和回放核对。该恢复入口也拒绝父目录名 Pods；它不改通用快照的 CocoaPods 判定。父目录、链接、当前存在性和文件读取仍在执行时核对。

成功后 status.effectiveScope 展示追加后的真实范围。关闭并按原 run.json、POLICY resume 后，
驾驶员预检、真实开发与检查请求、handoff、Review 和完成复查使用回放派生的完整范围。
业务旧 diff 保留，新增文件在 Review 中仍为创建 diff；新增既有文件若暂未修改，
其完整原字节、SHA 和模式仍进入 unchangedScope，并在送审和完成前验证。
成功追加不代表开发、检查、Review 或完成已通过；继续 advance，实际 develop 请求到达后才写入。
该入口不开放 legacy、provider、bootstrap、batch、二进制资产模式、QA 修复或已完成任务重开。受保护开发仅按下文窄合同开放。

### 受保护会话的范围与检查补充

原运行是受保护的单代码根 current-conversation 时，在上述同一次启动再提供 `--scope-check-supplement CHECK-SUPPLEMENT.json`。该文件只包含 `{"version":1,"definitionFile":"原 run.json 的规范绝对路径","checkIds":["原检查 ID"]}`。保留原 run、POLICY、保护配置、workflow、Review 配置、PLAN 及所有失败证据；恢复材料和恢复 PLAN 另存新文件。注册只用 `resume/status`，接受后移除全部已消费的范围恢复参数，用原配置继续。

宿主在原 writer 锁内核对固定启动快照及原失败，再追加唯一 `scope-revised` 记录。记录新增 `protectedSupplement`，绑定完整原配置材料和原 config 指纹、原定义文件的字节 SHA/大小/模式、原检查 ID。它不改原初始化记录、指纹、attempt、预算或完成状态。没有显式补充材料的受保护范围追加仍拒绝；普通 resume 从已接受的记录回放派生，不需重新提交补充文件。

无需改变检查输入时，显式提供 `checkIds:[]`：仍绑定原配置和定义文件、追加原范围记录，但开发检查、完成复查及 QA 的全部原命令逐字节执行，不省略检查、不修改断言。它也不会解除原检查中的范围保护；若原检查读取冻结 scope 并因此拒绝新增路径，仍须按下段登记对应检查 ID。空数组不是自动判断检查覆盖充分，也不是检查通过证据。

选定非空检查 ID 的补充仅支持原 `node -e` 检查中唯一、真实顶层的 `const scope=new Set(JSON.parse(fs.readFileSync('原定义路径','utf8')).scope);`；也接受等价双引号及有限空白。执行时只把该 `Set` 的输入投影为回放得出的有效范围，其余脚本字节、检查清单、caseIds、业务断言、环境和超时保持原值。开发检查、完成复查与原 QA 共用这一投影；没有补充记录时仍执行原命令。原文件和配置字符串未改，不代表实际执行的 argv 字符串完全相同。

定义文件必须在代码根和规格根之外，路径及父目录不得为链接，文件不得有其他硬链接；每次实际检查重核原字节、大小和模式。仅接受原完整命令清单，不能新增、删除或重写命令。检查 ID 不存在，引用不匹配、重复或在字符串/注释/函数中，模板或正则等不能确定解析的脚本，均拒绝。错误分别保留为 `scope_check_supplement_invalid`、`scope_check_supplement_drift`、`scope_check_reference_unsupported`，不能改成跳过或通过。

该投影只允许明确获准的新增业务路径退出“原范围之外文件不得改变”的范围判断；其余受保护文件仍逐项核 SHA。新增路径仍经过原创建 inventory、忽略、规格/指令保护、大小和链接门禁。规格、AGENTS、依赖目录不能由此取得写权限。原有业务成果继续以原创建基线送审，新增测试也须真实执行、接受 fresh 独立 Review，再走原完成/QA 门禁。CLI 只登记授权决定，不替代当前人对具体路径的批准。

### 已补范围的大审查包检查点

原 v3 满足共享大包表示资格时，完整开发检查点若装得进原单条记录、但放不下后续审查/完成的原预留，可使用原 journal 内的包材料表示。首次成功开发检查点在同一条原子记录中保存完整原包与状态，并以 `packageMaterial:true` 标记；后续同包检查点将包字段置空，以 `packageRef` 绑定该前序记录 ID、记录摘要和原 packageDigest。没有归档和状态之间的第二次写入窗口。

恢复先核对同 run、包自身轮次的前序材料、记录链及包摘要，还原完整包，再执行原包、检查、独立审查回执和完成校验。首轮审查要求修改后，当前 frame/result 可合法进入下一轮并保留旧包；引用按包自身身份核对，跨轮状态仍由原检查点转换校验，不能要求 frame 轮次永远等于包轮次。模型和 owner 消费的包字节及摘要保持。旧 inline 检查点仍沿原合同读取；新表示不回写旧记录或改冻结指纹。缺材料、前向引用、错误身份、篡改、替换包及同时提交两种标记均拒绝。

单条 1 MiB、总 state 16 MiB、物理空间 32 MiB、1024 条记录及原审查/完成预留均保持。原完整首次检查点仍须有界装入一条记录；材料或后续引用检查点超限继续阻断，不删材料或减少断言。驾驶员和 owner 使用同一容量函数，只有这个已接受范围补充的路径启用新表示，无需新增产品权限或修改原配置。

### 一次受控的 a2 开发续次

`development_rework` 仅用于原 v2 单任务、未受保护的 `development:conversation` resume。
由人工核对并保存原 `status.launchControlTarget` 为 `launch-target.json`，在 `serve --mode resume` 增加
`--expected-control launch-target.json --development-rework --development-rework-reason REASON`。
原因用于审计，须为非空单行文本（最多 500 UTF-8 字节）；不根据新 status 自动刷新旧目标。

只有 attempt2 已持久化 `develop_retry_limit`，紧前记录是有成功开发调用、完整 Learning 和真实 failed check
的 `develop_checks_not_passed` checkpoint，且已有 a1 `changes_requested` 原包/凭证时允许。
固定计数必须是 4 calls / 5 effects；没有 pending、r2 登记或凭证、提交、取消、workflow error 或 QA。
任务已完成、r2/handoff 占位文件、provider、protected、parallel batch 及规格漂移均拒绝。

操作只追加 `development-rework-authorized`，绑定原失败、limit、r1、配置、有效 scope、原基线和当前源摘要。
不重拍原基线，不改变 attempt 或 scope，不减免旧成功重查，不重写历史。
默认 6 calls / 6 effects 保留；事件只给绑定的下一 developer 和 fresh `review-2` 配对一个额外 effect。
开发 intent 即消费单次开发许可；失败、超时、中断和重启不会恢复第二次开发权限。
新开发开始前仍核对源和规格；若在许可后漂移则拒绝，不能自动更新绑定。
当前源摘要只说明新增许可时的源，并不声称旧失败时的代码已经被历史快照证明。

驾驶脚本使用 `cm-ai-drive.mjs --plan PLAN.json status`，PLAN 示例（原 review、workflow 等配置保持不变）：

```json
{
  "config": "run.json",
  "controlConfig": "control.json",
  "mode": "resume",
  "hostContext": "{当前真实会话ID}",
  "permissions": [
    "--review-config", "review.json",
    "--workflow-config", "workflow.json",
    "--expected-control", "launch-target.json",
    "--development-rework", "--development-rework-reason", "{人工批准本次续次的实际原因}"
  ]
}
```

范围追加用 `--revise-scope SCOPE.json --scope-revision-reason REASON` 替换上述两项开发续次参数。
两个动作都不新增 `--allow-*`，不发送 `development_rework` / `revise_scope` wire 操作。
启动追加一次记录后，从后续 PLAN.permissions 移除专用恢复参数及 `--expected-control`，再按原配置 `advance`；不能重复消费旧启动目标。
成功返回原 attempt2 的 `blocked/develop_checks_not_passed`，随后 `advance` 才会发真实 develop 请求。
等待请求后修改代码，重新检查、生成交付包并派发独立 r2；r1 不替代 r2。
开发许可消费后，合法 `blocked/check_answer_*` 的只重跑检查仍沿原两次重查上限执行，不派第二次开发。
返工轮审查保留现有无结论重派策略：`review-2-retry-N` / `review-2-resume-N` 及组合 ID 可使用绑定 review 的额外 effect 名额，
但仍须通过原 transport/abandon、fresh invocation、调用计数和重派上限校验；不因该名额接受旧 verdict、第三轮或任意 review ID。
没有 Review 批准就不能 complete；完成前复查、任务门禁及原 QA 合同继续执行。
回放按记录顺序验证原默认上限，然后从已验证的新增事件派生许可；checkpoint/config/模型自报额度无效。
已知限制：已消费一次性返工许可的运行，若之后最后任务的文档同步失败，文档同步重发不可用（返工预算已用满，名额门与总预算预检都会拒绝），只能用 supersede 重开。
旧 runtime 不认识新增事件时应拒绝读取，不能忽略事件降级执行。


## a2 既有审查后的任务范围接续

复用 `revise_scope` 启动入口，另带 `--task-review-origin ORIGIN.json`。只允许原 v3 / v2 单代码根未受保护 conversation，a2 停在 `blocked/develop_package_too_large`，已有正式接受的 r1 `changes_requested`，r2 尚未登记，无 pending effect、任务完成写入、取消或其他范围追加，且原开发预算未用完。原 a1 `scope-check-supplement` 条件不变；本入口不静默迁移其他旧格式。

`ORIGIN.json` 是 `{"version":1,"commit":"40位固定Git提交","additions":[{"path":"精确新增路径","source":"本次具体授权的来源和用途","sha256":"当前字节摘要","size":123,"mode":420}]}`。新增清单须精确等于 scope 差集；既有修改文件和已存在的未跟踪文件均可登记，但路径、模式、大小与当前 SHA 必须匹配。新增 scope 必须包含原全部路径，不开放规格、指令、依赖、ignored、链接或范围外权限。commit 必须由本次明确授权给定，不能自动取 HEAD。Git 工具只读原始 blob，不执行项目 filter、hooks、replace 或联网抓取。

先运行 `node scripts/cm-ai-drive.mjs --plan PLAN.json preflight`。此命令不启动宿主、不取 writer、不运行检查或模型、不写项目状态。输出分别列出已验证、估算和未知；外部模型、设备/环境、未来状态空间不能承诺通过。只有具体目标、材料、范围和预算核对通过时才给出恢复动作；状态变化后不能自动刷新目标。

在另存的恢复 PLAN.permissions 中加入 `--revise-scope SCOPE.json --scope-revision-reason REASON --expected-control LAUNCH.json --task-review-origin ORIGIN.json`，保留原配置与 controlConfig。仅 `resume/status` 登记；LAUNCH.json 保存此前 status 的固定 launchControlTarget。宿主在原 writer 锁中重核，原子追加一条 `scope-continued`；成功后移除全部注册参数，使用原配置继续 `advance`。重复、陈旧、并发 writer、未知 effect、材料缺失或内容漂移都拒绝，原前缀不变；中断后重读原历史判断是否已接受，不能无条件重发。

新记录分别绑定创建基线摘要、原失败 effect/checkpoint、r1 包和回执、固定 Git before 正文、当前 execution SHA/大小/模式及授权来源。r1 仍按原创建基线验证，r2 使用 Git before 到最终全部 scope 的任务差异；接续时的当前代码不会吞掉任务改动。Git 中尚不存在且当前作为需求材料的 scope 文件，派生 a2 基线明确记录 missingRequirements；交付后 requirements 仍须真实存在。旧基线和旧审查字节、run/config/fingerprints、attempt 和所有已消耗预算不改；本地批准不转换成正式 r2 回执。仍须 fresh r2、完成前复查与原 QA，失败保持原失败。


### 已提交的规则变化接纳

仅在上述 a2 资格成立且负责人明确批准时，可在同一 ORIGIN 中增加 `ruleAcceptance`，不另建 run 或修改原配置：

```json
{"version":1,"commit":"原任务Git审查起点40位SHA","additions":[],"ruleAcceptance":{"version":1,"sourceBaselineDigest":"原init基线64位摘要","candidateCommit":"包含已批准规则的当前HEAD40位SHA","source":"精确的人类授权来源和用途","files":[{"path":".claude/rules/example.md","creationSha256":"原init规则64位摘要","sha256":"当前规则64位摘要","size":1234,"mode":420}]}}
```

示例的 additions 仍须填入本次实际业务差集。files 按路径排序，最多8个，只收已存在且发生变化的根 AGENTS.md 和 `.claude/rules/` 单层 Markdown。绑定原创建 SHA、当前完整 SHA/大小/模式及当前 HEAD 中的字节；不接受未提交规则、符号链接、未知旧规则、其他保护路径或错误基线。提交中已有业务改动可以保留；候选业务文件仍按原 Git 审查起点到最终候选完整送审。

此记录只接受已批准的执行约束。正式开发 scope 仍只有业务路径，开发者不能写规则；派生 review baseline 的规则可见性不授予写权限。规则授权清单进入最终包，规则差异使用 Git before→最终 after，原创建基线及其中已有正文在原 init 中保留；旧基线只有摘要时不补造旧正文。登记后每次 resume、effect 和交付均核对规则 SHA；未经再次正式处理的规则变化，包括 Learning 新写回，仍拒绝，不静默接受。

只对携带该新字段的接续派生材料复用既有 contentGzipBase64 无损格式，正文至少1 KiB且压缩更小时采用；原始 size/SHA、1 MiB单文件、2 MiB材料、完整 before/after、需求和handoff不变。旧记录不重编码，旧入口默认仍从64 KiB压缩。审查适配器在模型可见材料中还原完整正文，不能把压缩编码当作已读内容。首次存档、引用和未来记录仍执行原限制；不可压缩或真正超限仍阻断。

登记命令仍为 `node scripts/cm-ai-drive.mjs --plan PLAN.json status`，登记前先用同一 PLAN 的 `preflight`。成功只追加一条 scope-continued，attempt、失败、r1、已用次数不变，也不表示批准或完成。中断先检查原记录是否已追加；成功后移除登记参数，准备当前真实开发/QA/文档答案，再 `advance`。答案目录为空时不能推进。

审查端沿原冻结配置。若原 CM 的 a2 调用实际报告 reviewer_rate_limited，按下节现有 switch 合同使用已批准的独立 Codex 后备；本地失败不能冒充原运行失败。预检的未来检查/额度/空间只是估算，正式 fresh r2、完成复查和QA都必须真实通过；qaFix disabled 时产品失败不会自动修复。

## 容量预判与异常恢复矩阵

大包表示资格由持久 v3 / v2 conversation、单代码根、非 bootstrap/provider/batch 共同决定，不再要求先追加受保护 scope。完整包首次仍在原子 develop checkpoint 中保存，后续审查、完成及 `review-invocation-reconciled` 可用精确 packageRef 引用。首材料和引用都经过原单条 1 MiB、状态 16 MiB、物理 32 MiB、记录 1024 门禁；原审查/完成预留不变。不能装入一条材料记录的包仍拒绝，不删除 before/after、需求、handoff 或证据。旧 inline 记录仍原字节读取回放。

预检复用包构造器、共享存储资格与 reserve 计算。已知交付按实际包编码计算，尚未发生的检查/模型/后续 frame 明确标估算。实际交付由同一 storage planner 精算 payload，再由原 store 核对 envelope、状态与物理限额。容量报告区分基线正文/清单、changes、requirements、handoff、Learning、已有 frame、检查证据及审查完成预留，不能把历史错误数字当当前候选估计。

| 阶段/阻断 | 支持的动作与限制 | 计数 |
| --- | --- | --- |
| 开发/检查失败 | 原 `advance` 按真实可重试状态重做；a1 追加或本节 a2 追加须各自满足完整条件 | 原 attempt 与开发/effect 名额不重置 |
| 有材料超限 | 先只读 preflight；合法 material/ref 可继续，真正超限保留失败等待有授权的材料方案 | 技术表示不产生审查结论 |
| 宿主中断/未知 effect | 先核对 writer 与落盘事实；仅既有 `abandon_effect`/commit recovery 满足条件才用，不推断未执行 | 沿既有技术中断上限，不当成新 verdict |
| 审查结果已产生未收尾 | 原 `reconcile_review` 消费绑定 receipt，恢复完整 package；无可信材料保留 unknown | 原 invocation/round，不重复模型调用 |
| 完成复查/commit 中断 | 原 `complete` 复查或按已登记 commit 计划收尾，不重开开发 | 原 completion 名额 |
| 继任 | v2 create supersede 已实现，但必须真实终态、无可用原恢复、固定前驱目标、无 writer/未知 effect；接受 drift 不是完整任务审查 | 新运行显式关联前驱，不继承批准或伪称清零 |

`runtime/js/cm-ai/recovery-capabilities.mjs` 为 CLI 帮助与恢复阶段清单的共同依据；`cm-ai-recovery-preflight.test.mjs` 核对帮助与正文的一致性。这里的框架夹具通过不代表任何真实项目任务通过。

登记后首个新 effect-intent 之前，普通 resume 和首次 develop 仍逐项核对已登记的 execution 快照，漂移拒绝且不追加历史；不重新依赖 Git 对象库。新 intent 已存在后的部分写入按原 effect 中断恢复合同处理，不把已发生的开发误当成启动前漂移。


## 原运行第二轮审查端变更

显式 `--reviewer-switch-config FILE --reviewer-switch-reason TEXT --expected-control FILE` 仅登记当前原 owner 的第二轮无结论审查从 Claude 改为 Codex。只能在原 v3 / control-v2、单代码根 current-conversation 的已落盘 `pending_review|blocked / review_provider_failed` 使用；原调用必须明确 `reviewer_rate_limited`、无有效本轮回执、无未结 effect/提交/取消，且既有无结论重派预算仍有余额。provider development、bootstrap、batch/parallel、externalModels/executionPolicy、多代码根和 binaryAssets 均不在此入口内。不自动推广到其他任务或全局配置。

保留原 run.json、POLICY、review.json、项目路由与全部指纹。新配置是项目根和规格根外独立文件，不覆盖旧配置：

```json
{"version":1,"provider":"codex","review":{"model":"经过正式预检的具体模型","preflight":{},"disabledSkills":[],"timeoutMs":900000}}
```

上面的 preflight 空对象只是字段说明，不能执行；须使用实际 `cm-ai-host.mjs preflight --config 原run.json --runtime codex --review-model MODEL` 返回的完整 Codex 隔离预检配置，不手填 passed/model/fingerprint。源修复本身的批准不替代业务审查。新配置的精确规范化内容摘要登记后冻结，恢复不得遗漏或改字节。

在另存的 resume PLAN 中保留原 runtime、--review-runtime claude、--review-config 原review.json 及全部原保护/workflow/checks/answers，首次追加以上三个参数对。先用原 status 保存实际 launchControlTarget；driver 仅允许 `resume status` 登记，不运行开发、检查或模型。owner 在原 writer 内再次核对固定目标、当前包及 handoff，原子追加唯一 reviewer-switched 记录；记录绑定原失败 effect/invocation/request/package、原 reviewer 摘要、真实宿主、原 snapshot revision、新 Codex descriptor/configurationDigest 和理由。旧 Claude r1/r2 的身份和失败不改标。

登记后移除 reason/expected-control，后续每次 resume 保留精确 `--reviewer-switch-config FILE`。普通 `advance` 只继续原第二轮当前包的 fresh Codex Review，不重派 develop、不刷新原测试事实或任务基线。登记逻辑沿用原 logical contexts 保留计数，新真实 invocation/thread 必须通过既有作者/宿主/历史审查线程排除，Codex 回执按实际 provider 记录并经原 owner 接受。完成前复查和原 QA/N7 仍必须通过。

仅一次变更，计入原本轮无结论重派名额；技术恢复不是新业务 verdict，不增加第三轮或清零调用/开发/effect/容量预算。重复登记仅在原目标前缀、原理由和精确配置完全相同时幂等；错 run/attempt/revision/包、未知结果、有效回执、活跃 writer、配置/源码漂移、缺材料、超限均拒绝。登记响应未知时先只读历史对账，不盲重发。缺配置不得静默退回 Claude；换配置不得静默换模型。跨会话接手登记及受保护二进制审查端切换仍未开放。


## 新建受保护二进制任务的 Codex 审查

单代码根 current-conversation 的新任务可显式以 `--review-runtime codex` 选择 Codex 二进制审查，并冻结在新 run 配置；项目原 coder 声明须仍匹配当前 Codex，项目和个人路由不改。沿用 `binaryAssets`、独立 sourceRoot、不可变字节存档和 scope/before SHA/size 门禁。每次审查都用固定隔离 `cm_review` MCP 工具重新预检，真实 before/after `read_binary` 和固定 `asset-integrity` 检查证据缺一拒绝；旧文本 no-tools 参数/指纹、Claude 通道、cm-fix 变异门禁和原 owner 回执/完成/QA 不变。该新运行选择不开放在途二进制 reviewer switch，不扩大 provider/bootstrap/batch/多 root 能力。

## 新受保护文本任务的运行内审查端选择

新建单代码根 current-conversation 的受保护文本任务可显式使用 `--review-runtime codex`，把 fresh Codex 审查冻结到本 run；已声明 coder 必须匹配当前 Codex，项目 reviewer 为 Claude 时也不改项目或个人默认。后续 resume 保留同一参数与 review 配置，参数变化仍由原配置指纹拒绝；此入口不能更改旧运行、切换在途审查或扩大 provider/bootstrap/batch/多 root 能力。原模型预检、独立上下文、回执绑定、完成前复查和适用 QA/N7 均保留，不要求伪造 binaryAssets。

## 首轮 blocked 后的显式原生证据接续

只有用户明确授权当前任务补证及原 scope 内修复时使用。适用原 v3/control-v2、单代码根、受保护 current-conversation、Codex coder 和 Codex reviewer。仅接受 attempt1 的正式 `blocked/review_blocked` 和对应有效回执；没有在途 effect、提交或取消，r2 材料尚未占用，原任务仍未完成，原调用/effect预算足够容纳一次 develop 和一次 r2。provider、bootstrap、batch、多根、binaryAssets、externalModels/executionPolicy 不在本入口范围内。其他 blocked 不因此可恢复。

保存原 `status.launchControlTarget`，另存恢复文件，不改原配置：

```json
{"version":1,"reason":"用户明确授权当前任务补证及范围内修复；保留旧 blocked","nativeEvidence":{"version":1,"sourceRoot":"/canonical/external/evidence","manifest":"manifest.json"}}
```

在原 resume PLAN 的副本中，仅为 `status` 加入 `--recover-blocked-review RECOVERY.json --expected-control SAVED-TARGET.json`。目标变化拒绝，先核对原操作，不能自动刷新目标。原 writer占用仍拒绝。登记追加唯一 `review-evidence-recovered`，绑定旧 checkpoint/package/receipt、配置、计数及来源根。重复登记拒绝且不覆写；原 blocked 结论保持 blocked。接续状态进入 attempt2，不增加审查轮次、不重置或抵扣预算。登记成功后移除已消费参数，正常沿原 PLAN resume。

外部 `sourceRoot` 必须为代码根和 specs 外的规范目录。manifest 采用以下严格格式：

```json
{"version":1,"report":"采集方式、原生载体、字号、滚动状态、对照结果、差异及未验证项","sourceFiles":[{"path":"scope/file.tsx","sha256":"64位最终源码摘要"}],"images":[{"path":"screen.png","sha256":"64位图片摘要","size":12345,"description":"图片所覆盖的具体状态与载体"}]}
```

`sourceFiles` 按路径排序，必须精确覆盖有效业务 scope 并匹配最终源码。manifest最多64KiB，内联报告最多16KiB，PNG最多10张，每张16MiB，总计32MiB。拒绝链接、越界、不稳定字节、缺失/漂移及摘要不匹配；原检查仍逐字节执行，缺材料停在检查阻断。图片复用既有不可变二进制归档，报告/源码/图片摘要进入正式审查包；Codex仅接收包绑定归档图片作为初始图像输入，不开放新增 shell/工具权限。

**完整性只证明材料绑定，不证明原生视觉通过。** 原 reviewer须直接审阅图片和报告，真实未验证载体仍应保留；模拟器不得冒称真机，原 AC 不降低。第二轮保留原任务基线和原 blocked findings，仍需 fresh 独审接受、完成前复查及原 QA/N7。r2再次 blocked 后无本入口，原失败与历史继续保留。登记后中断可直接原配置 resume；完成后的历史回放不依赖外部采集目录继续存在，正式包仍要求归档完整。


### 原生任务一次有界补正（显式新增授权）

两次正式 `blocked`、原六次调用/effect 均已消耗时，普通 resume 仍拒绝返工。当前实现仅支持已通过上述首次原生接续的单 root、受保护 current-conversation Codex、control-v2 原 run。用户须另行明确批准最多一次开发和一次 Codex 独立审查；不能把先前剩余 r2 授权当成本次授权。bootstrap、binary、batch、多 root、provider 开发均不支持。

复制原 resume PLAN，仅为 `status` 添加 `--native-correction CORRECTION.json --expected-control SAVED-TARGET.json`。CORRECTION 与首次恢复文件同形：`{"version":1,"reason":"具体新增授权与修复目标","nativeEvidence":{"version":1,"sourceRoot":"/absolute/external/root","manifest":"manifest.json"}}`。保存原 status 的固定目标；陈旧目标、占用 writer、代码漂移或历史文件漂移均停止，不能自动刷新目标。先在项目外准备完整最终候选及绑定源码 SHA 的原生材料，再登记并消费唯一开发。

如果同一次具体新增授权还包含必要的既有文本路径，可在 CORRECTION 中同时给出完整 `scope` 和 `checkSupplement`。`scope` 必须包含原全部有效路径；`checkSupplement` 沿用 `scope-check-supplement` 的 `{version:1,definitionFile:"原冻结 run.json 的外置绝对路径",checkIds:[]}` 合同，空数组表示所有原检查命令不变。追加路径的稳定当前字节、SHA、大小和模式由 owner 捕获并写入同一补正记录，不能用调用方自报摘要代替；原五份冻结配置及其指纹不改。不是重放已消费的 `scope-revised`，也不产生第二个补正周期。恢复须从该已回放的补正记录投影完整有效范围，原全部任务改动和精确新增路径共同进入审查、完成前复查及原 QA。本入口要求每个追加路径已存在于原任务清单且仍匹配原 SHA；此前未跟踪的新文件不在此窄入口内。没有新增范围时维持原文件形状与限制。不能缩减范围、追加规格/规则权限、任意改检查、自动刷新陈旧目标或迁移旧记录。

新增范围中大型、有效且字节可精确还原的 UTF-8 文本在正式材料中可使用无损 gzip 编码。编码仍绑定原始大小与 SHA，读取前按原文件限额解压并核对完整字节；原始单文件/总材料限额、journal 和审查预算不变。审查显示完整解码内容，压缩表示不是摘要，也不能删除锁文件内容来适配预算。旧内联记录保持原格式可读；无法压缩到实际预算的材料仍明确拒绝。

登记追加唯一 `native-correction-authorized`，绑定原 r2 包/回执、四份原 handoff/review 的 SHA、配置/基线/有效范围与六次预算事实。原 attempt 保持 2，单独标明 correction epoch 1；历史不重置、不减记。仅该记录准入额外一次 develop 和一次 review，实际累计调用保留为 8。开发失败或新审查不批准不会自动再授予补正。纯结果对账沿原 intent；不能用新的重派绕过一次限制。

新证据固定命名 `<feature>-<task>-native-correction-1` 的 JSON 授权投影、handoff、Markdown review、receipt。原 a1/a2、r1/r2 原字节不覆盖。补正审查包含原任务基线到最终候选的全部差异及原 blocked 意见。N5 要求严格回放的新真实 Codex approved 回执，固定全部旧/新证据；完成前复查、原 QA 与 N7 不变。登记后移除已消费恢复参数，按原配置 resume。材料完整性不是视觉验收。

该补正的 Codex 审查若已留下 `provider/reviewer_exited` 失败结果和失败检查点，且原八次调用均保留，可以在用户另行明确批准后只新增一次技术重审。仍复用原 resume/status 的 `--native-correction FILE --expected-control FILE`；此时 FILE 必须精确为 `{"version":1,"reason":"本次具体技术重审授权原因","technicalReviewRetry":true}`，不能同时传入 `nativeEvidence`、`scope` 或 `checkSupplement`。原 run、attempt2、代码、AC、配置、有效范围和已保存审查包全部保持，既有原生证据继续绑定原补正记录；没有新开发调用。

owner 在原 writer 锁内核对固定目标、失败调用与检查点、原包、原补正记录及配置/基线/范围摘要，追加唯一 `native-review-retry-authorized` 记录。原补正审查许可继续标记为已消费，新增的独立许可在唯一后续 review intent 写入时消费；原八次计数与失败历史不减记，只允许这一次新 Codex invocation。登记后移除恢复参数再按原 PLAN 继续；预检只读资格和原包，不登记许可或发布材料。新审查仍须 fresh context、完整原包和正式 approved 回执，再走原 N5、完成前复查、QA 与 N7。重复、陈旧或漂移授权均拒绝；这次重审失败后不会自动再授予名额。


修复审查输入传输后，若上述独立技术重审也已产生原第九次 `provider/reviewer_exited` 失败与检查点，且用户再次明确只批准一次审查，原 owner 可沿同一 resume/status 入口使用精确 `{version:1,reason,transportReviewRetry:true}`。与首次 `technicalReviewRetry` 互斥，禁止夹带原生材料、范围或检查变更。唯一 `native-review-transport-retry-authorized` 追加记录绑定原第九调用/结果/检查点、已消费首次技术重审登记摘要、原包/补正/配置/基线/范围与唯一后续 review effect；旧九次与旧许可原样保留。独立名额只在第十次 review intent 消费，不准开发，不准第十一次调用或再次授权；失败仍阻断。只读预检与 live/replay 共用资格，完整审查输入准入仍在 intent 前执行。该入口只恢复审查，不能把框架检查当业务通过，也不绕过后续原完成门禁或原 QA。

### 复用只读预检的提前核对

`node scripts/cm-ai-drive.mjs --plan PLAN.json preflight` 按当前 journal 阶段报告有效范围、原基线、预算事实及固定恢复目标。新建/实际开发前使用已有交付预检；已声明原生材料时，共用正式捕获的 manifest/PNG/报告/最终 scope SHA 校验，但只读检查不写归档或状态。待审/完成阶段读取已保存包，不读取过期开发答案。具体有界补正可投影原授权范围，原 owner 仍须按同一正式合同登记，预检不能新授额度。

只读报告区分已验证、估算和未知。尚未归档的图片材料、未来检查与外部模型结果不能标为完整可完成；未知本身不新增人工确认或一律停止。真实已知错误提前拒绝，完成前仍使用原包/回执/复查/QA 门禁。

### 一次新增材料续审机会

原单次材料审查已消费且以review_material_incomplete停在unknown时，受控新增机会合同见
[JS恢复：材料续审](../skills/cm-ai/references/js-host-recovery.md)。复用原 `--native-correction FILE --expected-control FILE`
启动边界、原writer锁与固定目标；只接受原宿主、当前完整源快照及操作员终止确认。
新 `material-review-continuation-authorized` 单独计账，最多新增一次审查机会，不返还第11次、不给开发权限、不提高全局上限。
结果已完整保存的同调用恢复使用固定wire target的 `reconcile_review`，不新增调用；元数据文件不是owner receipt。

第12次材料续审在原时限内超时且无有效终态时，另行明确授权可使用同启动边界的
`materialTimeoutContinuation:true`，绑定status的原失败source与transportProfileDigest。
`material-review-timeout-continuation-authorized`仅给该原run一次新的批读审查机会，不返还旧账，此技术恢复合同本身不提供进一步名额或开发；有效 blocked 的新补证接续另依[独立合同](cm-valid-blocked-evidence-continuation.md)及明确授权；
见同一JS恢复文档的“第12次材料审查超时后的批读绑定机会”。

已有 nativeCorrection 的受保护任务在最新有效 blocked 后，可使用 [证据补充与一次续审](cm-valid-blocked-evidence-continuation.md)。证据登记与一次新审查授权分开，保留完整原始差异和旧、新材料；源码漂移拒绝，没有隐式开发权限。
