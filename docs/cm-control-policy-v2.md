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
`qa:"disabled"` 只关闭实际 QA executor，仍执行 `qa_assess` 清单来源确认和固定检查点判定；驾驶员只需合法的 `{"confirmed":true}` 答案。
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

QA 重跑、QA 配置修订、规格换绑、范围追加和一次开发续次在创建 host 前改变恢复输入，使用单独的启动快照。
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

## 旧运行与迁移拒绝

| 输入或情形 | 结果 |
| --- | --- |
| PLAN 不含 `controlConfig` | 沿原请求 version 1 与能力开关，常规审查直接派发 |
| cm-ai journal 含旧 grant 通道的审查登记 | `runner_invocation` 在指纹检查前拒绝；保留原记录，`cm-ai-run.mjs inspect-history --config 原run.json` 只读查看 |
| v2 入口带任意 `--allow-*` | `invalid_arguments` 或驾驶员启动前迁移拒绝 |
| 旧运行通过 v2 执行，或 v2 运行通过 legacy 执行 | `fingerprint_mismatch`，不转换历史后继续 |
| 策略启用的能力缺配置 | 沿原具体配置阻断；模式冲突用 `invalid_arguments`，不自动开启 |
| disabled QA 仍由原判定触发必需 QA | `qa_triggered`、`pendingAction:"qa_execution"`，没有 PASS 或 run_done |
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

`revise_scope` 只用于 v2 单任务、未受保护的 `development:conversation` 原配置 resume。
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
该入口不开放 legacy、provider、受保护开发、bootstrap、batch、QA 修复或已完成任务重开。

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
