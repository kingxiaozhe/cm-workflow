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
`qa:"disabled"` 只关闭实际 QA executor，仍执行原 `qa_assess` 和必需 QA 的机械判定，驾驶员仍需合法 assessment 答案。
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

`abandon_review`、`abandon_effect`、`develop_redo`、`bootstrap_review_recover`、`reconcile_review`
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

QA 重跑、QA 配置修订与规格换绑在创建 host 前改变恢复输入，使用单独的启动快照。
先按原配置只读 status，展示操作和前提，把原 `status.launchControlTarget` 完整保存到普通 UTF-8 JSON 文件，
再在原 `serve --mode resume` 启动中提供 `--expected-control FILE`。不能用 `status.controlTarget` 代替启动快照。
目标文件严格校验，拒绝重复键、软链接或硬链接；不自动计算或刷新目标。
真实 writer lock 内先核对 durable snapshot 与回放状态，缺失或陈旧时不执行修订、不追加恢复 journal。

| 原恢复动作 | v2 启动参数，另带原配置与 `--expected-control FILE` |
| --- | --- |
| 重跑未知 QA | `--rerun-unknown-qa`；环境故障还可提供原 `--qa-environment-failure REASON` |
| 重跑已阻断 QA | `--rerun-blocked-qa`；仍满足原可重跑条件与预算 |
| QA 配置修订 | `--revise-qa-config OLD_WORKFLOW.json --qa-config-revision-reason REASON`；当前 `--workflow-config` 提供已核对的新配置 |
| 已批准规格材料换绑 | `--rebind-spec-material --spec-rebind-reason REASON`；保留原重新批准与漂移门禁 |

例如重跑符合原条件的已阻断 QA：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve \
  --config run.json --mode resume --host-context "{当前真实会话ID}" \
  --control-config POLICY.json --review-config review.json --workflow-config workflow.json \
  --expected-control launch-target.json --rerun-blocked-qa --runtime codex
```

`launch-target.json` 保存此前展示的完整 launchControlTarget，不能从本次启动的新状态替换它。
这些入口仍保留原 QA/规格恢复条件；新快照绑定不扩大可恢复状态、预算或范围。
普通 wire 操作的 `expectedControl` 与启动参数 `--expected-control` 是两种用途，不可互换。
v2 create supersede 尚未开放，返回 `supersede_unavailable`；保留原证据，不通过 legacy 作废旧运行。

## 旧运行与迁移拒绝

| 输入或情形 | 结果 |
| --- | --- |
| PLAN 不含 `controlConfig` | 沿原请求 version 1 与能力开关，常规审查直接派发 |
| cm-ai journal 含旧 grant 通道的审查登记 | `runner_invocation`，保留原记录，仅由原版本只读工具查看历史 |
| v2 入口带任意 `--allow-*` | `invalid_arguments` 或驾驶员启动前迁移拒绝 |
| 旧运行通过 v2 执行，或 v2 运行通过 legacy 执行 | `fingerprint_mismatch`，不转换历史后继续 |
| 策略启用的能力缺配置 | 沿原具体配置阻断；模式冲突用 `invalid_arguments`，不自动开启 |
| disabled QA 仍由原判定触发必需 QA | `qa_triggered`、`pendingAction:"qa_execution"`，没有 PASS 或 run_done |
| 批次 `qaFix` 不是 disabled | `invalid_arguments` |
| 显式恢复缺固定目标 | `invalid_input` 或驾驶员启动前拒绝 |
| 固定目标已陈旧或不匹配当前状态 | `snapshot_changed`，不自动刷新 |
| 恢复时策略改变 | `fingerprint_mismatch`，不替换原策略 |
| 恢复时原配置发生变化 | 沿原指纹与配置漂移门禁拒绝 |
| v2 create supersede | `supersede_unavailable`，不走旧入口作废运行 |

v2 策略随新运行持久化并纳入新版执行指纹。旧 metadata 中该字段缺省时，原格式与字节保持原样。
不重写旧 journal、旧指纹或旧控制记录，不把能回放旧记录扩称允许跨入口执行。
只读 status 可用于核对历史；执行入口仍必须匹配原协议。迁移需要独立的新运行决定，不能就地换入口规避旧证据。
单任务 QA 重跑、QA 配置修订与规格换绑使用上节 launchControlTarget；批次和 supersede 等出口以实际支持为准，不把单任务恢复合同理解成全部旧出口已开放。

## 交付证据范围

这里说明源入口的控制合同。源文件更新不表示已安装插件、当前会话已加载新版 Skill 或真实模型可用。
本地合成/临时目录检查、实际 provider 调用、独立 Review、安装与生产发布分别报告。
定向夹具和源码审查结果见本轮交接记录；本文示例不等于真实 provider 或业务运行验收。
cm-ai 新单任务/批次的 r2 blocked correction completion 未支持；本轮不新增补正协议。
本次本地方案不包含安装、提交、push、发布、部署或资金动作。
