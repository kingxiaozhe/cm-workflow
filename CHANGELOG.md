# 更新日志

按版本记录用户可感知的新增、优化与修复；最新内容放在最前面。
尚未进入发版候选的改动放在「未发布」；版本条目记录该版本的交付内容，npm 发布状态以注册表为准。

## 未发布

- 执行存储锁改为运行级，不同 runId 可独立持锁；创建新运行时先探测旧布局锁，成功释放后继续，失败返回 `store_busy`，旧文件不迁移、不改写。
  恢复已有运行时，缺少本运行 `writer.sqlite` 返回 `store_layout_legacy`，须用旧版本收尾或退休该 runId；已有运行级锁则正常恢复。

## 0.14.0 — 2026-09-18

- 第 32 步：`cm-fix` 按描述未复现后先做最多 3 个场景或 15 分钟的单维度复现探索；档案新增复现尝试，JS 结果兼容旧记录并校验尝试结论，观测闭环要求至少一条尝试。
- 第 33 步：`cm-ai` 准入新增只读 `--print-run-definition` 直接生成运行定义（`--scope` 必填），`invalid_config` 点名多余/缺失字段、版本与文件类型，usage 与文档说明键集精确且参与摘要绑定。
- 第 34 步：受保护检查证据仅追加白名单测试计数摘要，同标签保留首次、最多 8 条、总长不超过 200 字符；不记录原始输出、凭证、路径或耗时，无计数及 unavailable 行为保持不变。

## 0.13.4 — 2026-09-18

- 第 29 步：`cm-init` 机械核验配置草稿的运行时五字段与所选预设一致，不符时阻断；从模板新建配置时按版本控制与 UI 模块事实裁剪 delivery/tests，并对不适用的默认策略给出非阻塞 warning，已有配置仍保留无关字段。
- 第 30 步：修复 `cm-ai` N6 中途 QA 提前执行未完成任务用例；延后用例写入日志与报告，命令按选中逻辑用例映射，显式恢复可用新 testRunId 绑定更新后的计划。`five_tasks_without_qa` 不再把已收尾 feature 缺失的 N6 历史行计为当前积压。第 30b 步：中途用例全部延后且无可调度命令时，以单条 `no-applicable-cases` BLOCKED 行显式报告空计划。
- 第 31 步：`cm-ai` 单任务 resume 新增 `--rerun-blocked-qa`，显式授权后仅将最新已完成的纯宿主/环境证据 BLOCKED 记为 superseded，并在最多三轮内全量重跑；保留原 QA 决策、开发/审查和任务状态，QA complete 同步 N6 状态镜像。

## 0.13.3 — 2026-09-17

- 第 28 步：`cm-runtime` 无参数在 TTY 中进入范围、工具/写码方、确认三问向导，复用安装器提问与既有 set/decision 日志，完成后显示有效配置；非 TTY 退出 2。安装器、向导与诊断共用系统语言中英文文案，机器字段不变；会话无参数按对话语言提问，文档与帮助同步。
- 测试隔离：7 个宿主测试文件把 `CM_WORKFLOW_HOME` / `CM_WORKFLOW_LOG_HOME` 指向进程专属临时目录，本机存在用户级 `runtimes.yml` 时不再有 6 个夹具误判为 declared-adapter。

## 0.13.2 — 2026-09-17

- 第 27 步：三种安装器交互声明单/双 AI 与谁写代码，原子保存用户级 `~/.cm-workflow/runtimes.yml`；非交互/yes 不写。配置按项目 > 用户 > 未声明解析并输出来源，cm-init 优先继承。新增独立 `cm-runtime show/set/set --user/unset --user` 与兼容别名，保留项目其他原文、复用诊断与决策日志，只影响新 run；同步检查、分发清单与文档。

## 0.13.1 — 2026-09-17

真项目 dogfood（`cm-init → cm-prd → cm-ai`，Codex 写码、Claude CLI 独立审查，首次跑到 `run_done`）暴露并修复的 11 处运行时缺陷，全部由真实事故触发：

- 修复 `cm-ai` N6 宿主请求可无限等待的问题：QA 请求按 workflow QA `timeoutMs`（默认 60 秒）独立超时并记 BLOCKED，迟到应答与旧发送失败不能污染下一请求；resume 可显式以 `--rerun-unknown-qa --allow-qa` 将无结果调用记为 abandoned，以新 testRunId 在原 qaRound 重跑，部分结果及清理欠账仍阻断。合成宿主确认同步应答本身正常；事故驱动的 JSONL 循环提前 return 会漏读同一数据块中的下一请求，宿主必须排空完整行。
- 第 26b 步放宽 `--rerun-unknown-qa`：无 complete、已记录结果全为 PASS 且无固定执行报告时可显式重跑，abandoned 新增 `partial_pass_cases`；全部用例仍重新执行，旧 PASS 仅作历史，FAIL/BLOCKED 与清理欠账继续阻断。

- 修复 `cm-ai` 已完成且原无 QA 的 run 无法补做强制 N6：resume 显式提供含 QA 的 `--workflow-config` 与 `--allow-qa` 后一次性追加不可变 `qa-attached` 和 `decision/qa_attach` 日志；保留原指纹及任务完成证据，绑定完整恢复配置，重复恢复去重，换配置或未完成附加拒绝。QA 仍走原宿主请求、执行、结果及收尾门禁，不重跑开发/审查。

- 修复 `cm-ai` 双根布局下开发进程与审查者看不到已批准任务及接口契约：开发请求和审查包新增绑定摘要的只读 `specification`（任务/验证要求、AC、设计摘录、相关用例、来源哈希）；复用审批 manifest，规格漂移以 `spec_drift` 阻断，设计超 64 KiB 标记截断。代码根 `requirements` 可选，旧包、journal 与 receipt 按原规则兼容，规格不进入可写 scope。补齐全量夹具的真实批准清单、运行时声明及模块复制依赖；旧 baseline 已记录的依赖文件保留完整内容与漂移检查，batch 开发/审查均验证规格传递。

- 修复 Claude 长审查被第 65 条 `thinking_tokens` 心跳误杀：审查上限放宽为 4096 条，保留 worker 总输出 1,000,000 字节及独立的 32 条通知限制；审查包新增绑定摘要的 `unchangedScope` 路径/哈希清单，允许其进入 examinedPaths 和 finding 路径但不要求改动，旧包与历史 receipt 按原规则验证。

- 修复 Claude 审查流将 `system/api_retry`、`hook_started`、`hook_response`、`commands_changed` 通知误判为失败：与 `rate_limit_event` 共用 32 条上限，经 `onNotice` 仅上报白名单摘要，不转发 hook/commands 正文或生成 observation；未知 system 子类型仍拒绝，重试后的失败结果仍按 `provider_failed` 处理。

- 修复 `cm-ai` 受保护当前会话审查误用 60 秒默认超时：Codex/Claude reviewer 共用配置的 `timeoutMs`；没有结果事件的审查传输超时可在同一 attempt 经新授权重派一次，第二次超时阻断。保留 observation/inspection，含结果的超时及旧 unknown 历史仍须 reconcile。

- 修复 `cm-ai` 受保护当前会话开发结果先落盘后校验的问题：本地 value/Learning 校验失败记录 `failed/invalid_result`，保留原原因并以 `developer_result_invalid` 阻断；修正后可沿同一 runId、同一 attempt resume。已应用提案仅在磁盘哈希一致时继续，冲突返回 `protected_edit_stale`；worker 异常与超时仍保留 unknown，不重置旧历史。

- 修复 `cm-ai` 准入被历史依赖行尾随句末标点阻断：依赖 ID 容忍末尾的 `。．.；;、` 与空白，内部非法字符仍拒绝；任务或依赖解析失败返回 feature、行号及最多 120 字符原文，并保留已解析 feature 状态，任务选择顺序不变。

- 修复 `cm-prd` 会话恢复错误码被宿主脱敏隐藏及 cancel 留下 active 导致的死锁：会话状态错误返回明确 blocked 原因，cancel 同时落盘终态并清空 active；resume 支持带证据的 abandon，回到操作前 checkpoint 后可重新发起，含 `prd_review` 的操作仍只能按原审查合同恢复。

- 修复 `cm-prd` 新增 feature 时，历史 specs 的任务/AC 运行期完成标记导致摘要回执门禁误报篡改：复用规格清单规范化规则并透传只读标记，其他内容、JSON、当前草稿处置与发布快照仍严格比对。摘要只裁决当前会话 feature，历史 feature 的旧版归档、缺失回执与已完成任务只登记为说明，完整规格哈希仍全部发布；无草稿从当前会话恢复范围，无法确定时明确阻断。

- 修复 `cm-ai` Codex 开发与审查子进程仍加载用户全部个人 skills 的问题：`--ignore-user-config`、`skills.config=[]`、`--disable plugins` 都拦不住 `<skills_instructions>` 目录注入，现在两条路径统一追加 `-c skills.include_instructions=false`。2026-09-16 空目录空操作提示词实测：input_tokens 18249 → 11706（−36%），“Skill descriptions were shortened to fit the skills context budget” 提示消失，模型不再看到 skill 工具；sandbox、审批与登录不受影响。实测无效的候选：`skills.config` 按根目录禁用、`skills.bundled.enabled=false`、`--enable skip_host_skill_discovery`（开发中特性，只多一条警告）、`--ignore-rules`、`--disable skill_search`；`skills.max_context_tokens=1` 虽降到 11813 但仍报预算超限提示，`=0` 直接拒绝启动。审查参数指纹已改变，旧凭证须重跑 preflight。已知剩余缺口：`~/.codex/AGENTS.md` 用户全局指令（本机 11.7KB）仍被注入，`project_doc_max_bytes=0`、`instructions`、`developer_instructions` 均不能移除（后者还会顶掉权限说明），唯一手段是隔离 `CODEX_HOME`，但登录态同样从该目录读取，复制或软链 auth.json 属凭据外放，本次不实施。

## 0.13.0 — 2026-09-17

- 修复 Claude 开发提案依赖自由文本 JSON 的问题：传入专用结构化输出 schema，配对内部 `StructuredOutput` 并优先读取 `structured_output`；无结构化结果时保留 JSON 回退，解析失败明确返回 `invalid_output_json`，严格校验成功/失败字面值与提案形状，原只读工具权限不变。

- 修复审查 finding 指向交接文件时被拒绝的问题：Codex 与 Claude 共享提示词明确允许包内 handoff 路径，保留 examinedPaths 精确匹配；非法 finding 路径、标识、严重度及形状分别返回具名错误码，便于诊断。

- 修复 Claude 回环预检将新版 CLI 的两次合规请求误判为失败：允许 1–2 次且逐条验证模型、传输与工具列表（空列表或唯一的 `StructuredOutput`），第三次请求或任一违规仍拒绝；结果新增 `message_requests_expected:'1-2'`，保留首次合规即停止、不转发模型与进程清理检查。

- 修复 Claude CLI 思考事件与审查结构化输出兼容：开发与审查流各容忍最多 64 条 `thinking_tokens`，思考块不推进状态；审查传入去除 `$schema`/`$id` 的结果 schema，配对 CLI 内部 `StructuredOutput`，最多容忍 16 次明确被拒的其他工具尝试，任何其他工具执行成功立即失败并终止进程组。开发流保留原只读工具与提案校验；审查参数指纹已改变，旧凭证须重跑 preflight。

- 修复 Claude CLI 回答前的 `rate_limit_event` 导致 `cm-ai` 开发与审查流失败的问题：同一会话终态前最多容忍 8 条，通过可选 `onNotice({kind:'rate_limit',info})` 仅上报标量字段；保持状态、观察事件及返回值形状不变，会话不匹配、超限和未知事件仍拒绝。

- 修复 Codex CLI 0.153.4 起 `cm-ai` 开发子进程禁用 `code_mode_host` 导致工具执行失败的问题：开发路径保留该工具通道，不启用 `code_mode` 特性；workspace-write、网络关闭和 specs 只读沙箱边界不变，审查路径仍禁用 `code_mode_host`，参数保持不变。

- 修复 `cm-ai` 开发与审查 worker 将 Codex CLI 0.153.4 启动提示误判为失败的问题：终态前最多容忍 8 条 `item.completed/error`，两类 worker 均通过独立 `onNotice` 回调上报 message 前 200 字符，回调异常不影响流程，保持事件流与返回值形状不变；超限或终态后提示仍拒绝，顶层 `error`、`turn.failed`、非零退出、缺结果与未知条目的失败判定保持不变。

- `cm-ai` protected host 按项目声明派发 coder/reviewer CLI，支持 Claude 只读文本提案经宿主校验后落盘；保留逐轮授权和跨家独立审查，实际启动进程后记录 `cli-dispatch`，审查凭证如实标注 `claude-cli`。2026-09-17 已完成真实模型双向验收各一次：Claude 宿主→Codex 写→Claude 审（`reviewer: claude-cli / independent: true / approved`）；Codex 宿主→Claude 只读提案→宿主沙箱落盘→Codex 审（`reviewer: codex-cli / independent: true / approved`）。均为单文件小任务，停在 N6 QA 待决；QA/N8 不在验收范围、仍未验收。

- 修复 `cm-init` 运行时声明无法进入宿主草稿的问题：可选 `selection.runtimes` 按预设追加配置目标，沿用已有文件名，核验声明并保护无关配置，接续原确认、审查与写入流程；直接导入 `scripts/cm-workflow-config.mjs` 复用唯一解析器（现有规则未禁止该方向，避免为下沉实现越过本次 cm-init 修改边界）。
- 新增运行时声明：`.cm-workflow.yml` 增加 `runtimes.available`（codex/claude/both），`cm-init` 首次初始化询问一次并按四个预设写入 coder/reviewer；配置校验拦截「单家声明却指向另一家」与「两家都有却写审同家」；`cm-check --project` 输出声明与本机 CLI 的对照及 coder/reviewer 的 `route_state`；`--failover` 改为声明优先、探测校验。声明不等于跨运行时派发。
- 新增双运行时容灾两层能力。`scripts/cm-failover.mjs` 只读推导 CM 断点（N3/N4/N5/N6）并生成另一端的续跑简报，不写 `tasks.md`、不标记完成、不授权发布；`cm-ai-host.mjs serve --failover` 在构造 execution 前按角色主从（developer 主 codex、reviewer 主 claude）探测选路，只决定起跑运行时，切换必播报，两端都不可解析时以 `no_runtime_available` 阻塞而非回退到不可用一端。不传 `--failover` 行为完全不变；与 `--protected-config` 互斥。边界与限制见 `docs/runtime-failover.md`。
- 修复自动更新器 `cm-update.sh` 硬编码 PATH 覆盖 launchd 环境变量的问题：改为保留继承的 PATH 再追加兜底目录，非 Homebrew 安装的 Node.js 不再导致定时更新一直报「Node.js 18+ 未找到」。

## 0.12.0 — 2026-09-16

- 新增 `cm-security`：默认扫描主分支差异与已跟踪未提交修改，支持 `--all`；结合业务地图复核安全问题，保留工具缺失与未覆盖范围；不自动修复、安装或上传。

- `cm-check` 默认查询 npm 稳定版，有新版就升级已管理的 CM 安装，再从升级后的目录检查；无需另加升级参数。
- 离线明确提示无法确认最新版；源码仓库和其他包管理器的安装保留原管理方式；底层机械检查保持只读，避免 CI 和安装流程递归升级。

## 0.11.0 — 2026-09-16

### 新增

- 直接运行 `cm-test`，自动分析当前分支相对 `main` / `master` 的已提交差异，列出受影响业务与重点回归场景。
- 影响分析后接续增量单测覆盖率检查，复用项目已有命令，支持 LCOV 和 Istanbul 报告；未配置工具时明确标记「未测得」。
- 支持 `cm-test，并补齐单测`，或看完报告后回复「补齐单测」，继续补测试、重跑并独立审查。
- 新增本更新日志，统一查看版本变化。

### 优化

- 开发需求和修复 bug 时，先核对业务地图与影响范围；地图缺失或失真时补充相关上下文，按需扩大分析范围。
- 需求与修复完成后增量更新相关业务地图，并在最终独立审查前定稿；文档同步覆盖同批次已完成任务。
- `cm-ai` / `cm-fix` 在最终独立审查前检查单测缺口，并在已授权范围内补测。

### 修复

- 检查已提交代码的覆盖率时，阻止未授权的未提交源码或测试混入执行。
- 缺失分支覆盖数据时保留缺口，不再把已测部分的百分比当作完整分支覆盖率。
- Codex 安装器同步分发更新日志，并检查安装后的内容一致性。
- 修复独立审查输出格式包含接口不支持字段而导致请求被拒绝的问题，本地审查路径校验保持严格。

> 覆盖率不代表业务验收通过；补单测不自动授权修改产品代码或安装测试框架。
> JS 修复流程的补测须在测试冻结前完成；当前 owner 无法合法写入覆盖率报告时，会明确报告接线受阻。

## 0.10.6

### 新增

- 增加工作流重复失败信号的只读分析工具，输出供人工判断的改进建议。
- 补齐 Pi/BYZ 与 Codex 发版面冒烟检查。

### 修复

- 修复安全扫描对已跟踪状态目录及部分私钥格式的漏检。
- 收紧重复失败分析工具的输入边界与证据校验。

## 维护方式

- 开发或修复完成后，将用户可感知的变化补到「未发布」，不逐条复制内部提交记录。
- 准备发版时，将对应条目移到目标版本标题下并标注计划日期；发布后核对实际日期，npm 状态以注册表为准。
- 本文件先补录 0.10.6 及之后的变化；更早版本和实现细节查阅 Git 提交历史。
