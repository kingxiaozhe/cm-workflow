# 更新日志

按版本记录用户可感知的新增、优化与修复；最新内容放在最前面。
尚未进入发版候选的改动放在「未发布」；版本条目记录该版本的交付内容，npm 发布状态以注册表为准。

## 未发布

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
