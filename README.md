<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="CM means Create More：CM Workflow 让想法成为可审查、可测试、可恢复的代码交付">
</p>

<p align="center">
  <a href="https://github.com/kingxiaozhe/cm-workflow/actions/workflows/ci.yml"><img src="https://github.com/kingxiaozhe/cm-workflow/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-151515" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Codex-native-2E6655" alt="Codex native">
  <img src="https://img.shields.io/badge/Claude%20Code-compatible-C44B32" alt="Claude Code compatible">
</p>

<p align="center">
  <strong>CM means Create More.</strong><br>
  从一句需求开始，留下规格、代码、测试、审查与可恢复的交付记录。
</p>

<p align="center">
  <a href="#安装">安装</a> ·
  <a href="#我现在该用哪个命令">选择命令</a> ·
  <a href="#跑通第一条开发流程">完整流程</a> ·
  <a href="docs/user-guide.md">使用手册</a> ·
  <a href="docs/architecture.md">架构说明</a>
</p>

## 它解决什么问题

AI 可以很快写代码，但“写完”不等于“可以交付”。需求有没有理解错、修改是否越界、
测试是否真的执行、换一个会话能不能继续，这些问题仍然需要一套明确流程。

CM Workflow 是一套安装在 **Codex** 或 **Claude Code** 中的本地、规格驱动开发工作流：

```text
需求 → 规格 → 人工确认 → 实现 → 独立审查 → 测试与 QA → 分支 / Draft MR
```

它不替你决定产品方向，也不自动获得远端权限。它做的是把 AI 开发从一次聊天，变成
有边界、有证据、可以暂停和恢复的工程过程。

> **No evidence → no completion.** `tasks.md` 是任务状态的唯一权威来源；聊天进度、
> Agent 状态和界面提示都不能替代磁盘中的任务、审查与测试凭证。

## 我现在该用哪个命令

第一次使用，只需要记住下面这张表：

| 你现在想做什么 | 从这里开始 | 接下来 |
| --- | --- | --- |
| 只有一个模糊点子 | `$cm-idea` | 形成 PRD 后进入 `$cm-prd` |
| 开发一个明确的新需求 | `$cm-prd {specs路径}` | 人工确认后运行 `$cm-ai` |
| 第一次接管已有仓库 | `$cm-init` | 再运行 `$cm-prd` |
| 测试已经存在的功能 | `$cm-test {项目路径} {功能} --generate-cases` | 检查用例后运行 `$cm-test --all` |
| 修复可复现 Bug | `$cm-fix {specs路径} {项目路径} {问题}` | 红灯测试 → 最小修复 → 回归 |
| 只整理代码结构 | `$cm-refactor` | 在行为等价约束下分批重构 |
| 不确定是否安装正确 | `$cm-check` | 按检查结果修复环境 |
| 讨论方案或研究复杂问题 | `$external-expert` | 外部研究，本地核验，不负责编码 |

完整参数和更多场景见 [使用手册：我现在该用哪个命令？](docs/user-guide.md#我现在该用哪个命令)。

## 安装

需要 Git、Python 3.9+，以及 Codex 或 Claude Code。源码不要克隆到
`~/plugins/cm-workflow`，该路径由 Codex 安装器管理。

### Pi / BYZ package

仓库包含原生 Pi package manifest。直接作为 Pi package 使用时，不会运行
`install.sh`、hook 或自动更新脚本：

```bash
pi install git:github.com/kingxiaozhe/cm-workflow
```

BYZ 可以把同一包固定到指定版本后随发行物提供，开发时仍可使用本地 package
路径覆盖。包内 Skills 与 Prompts 由 Pi 资源加载器直接发现，不会复制到用户的
Codex 或 Claude Code 全局目录。

### Codex

```bash
git clone https://github.com/kingxiaozhe/cm-workflow.git
cd cm-workflow
./install-codex.sh
```

新开一个 Codex 任务，验证安装：

```text
$cm-check
```

### Claude Code

macOS / Linux：

```bash
./install.sh
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

新开 Claude Code 会话并运行 `/cm-check`。macOS/Linux 同时保留历史 `/cm:*` 别名；
Windows 需要 Git for Windows（Git Bash），也可以在 WSL 中使用 Bash 入口。

覆盖安装、无人值守模式和可选更新器见 [安装指南](docs/installation.md)。

## 跑通第一条开发流程

<p align="center">
  <img src="./assets/readme/delivery-flow.svg" width="100%" alt="CM Workflow 从需求登记、规格成档、人工确认、逐任务实现、独立审查到 QA 归档的交付流程">
</p>

假设代码位于 `~/code/my-app`，规格准备放在 `~/projects/my-app-specs`。

### 1. 接管已有项目

```bash
cd ~/code/my-app
```

```text
$cm-init
```

全新空项目跳过 `$cm-init`，直接从下一步开始。

### 2. 生成可开发规格

把 PRD、需求说明、原型或测试意图放入 specs 的 `docs/`，然后运行：

```text
$cm-prd ~/projects/my-app-specs
```

它会生成每个 Feature 的：

```text
requirements.md   # 用户故事与验收条件
design.md         # 技术方案与边界
tasks.md          # 可执行任务，也是唯一权威任务状态
test-cases.json   # 可选的 AI 可读测试合同
```

CM PRD 的方案审查与任务拆分审查各自最多调用一次独立 reviewer。中断后会复用已生成的
审查凭证和处置回执，不会因为恢复流程而重复发起同一轮对抗审查。

### 3. 人工确认后开始实现

先检查规格摘要、技术方案、任务和验收条件。确认无误后运行：

```text
$cm-ai ~/projects/my-app-specs ~/code/my-app
```

规格批准会绑定 requirements、design、tasks 与测试合同的语义 manifest。N5/N6 正常
勾选任务和 AC 不会被误判为规格变化；文案、ID、方案或测试目标变化仍会要求重新审批。

### 4. 获得可审查交付

根据项目 `.cm-workflow.yml` 中的 `delivery`，流程可以交付：

- `diff`：只留下本地修改和验证结果；
- `branch`：提交到本地任务分支；
- `draft-mr`：在你明确授权 push 和创建 MR/PR 后，提交 GitHub 或 GitLab Draft MR。

配置不会自动授予远端权限，生产发布也始终保留人工确认。

## 测试已有功能

已有功能没有测试用例时，可以先让 CM 读取代码路径和分支逻辑，生成 AI 可读用例草稿：

```text
$cm-test ~/code/my-app 用户登录 --generate-cases
```

确认用例后，按需执行全部测试层：

```text
$cm-test ~/code/my-app --specs ~/projects/my-app-specs --feature 2.user-login --all
```

<p align="center">
  <img src="./assets/readme/test-evidence.svg" width="100%" alt="CM Workflow 分别记录逻辑检查、正式命令和浏览器用户路径三类测试证据">
</p>

三类证据不会互相冒充：

- **logic**：读取代码入口、分支、状态变化与输出，只能说明逻辑是否支持；
- **commands**：真实运行项目声明的测试、类型检查和构建命令，保存退出结果；
- **browser**：按照测试用例模拟用户操作，记录动作、URL、可观察结果、截图与日志。

`$cm-test` 默认只读：不改源码、不自动安装依赖、不降低断言，也不会把静态分析写成
“测试已通过”。需要修复时，再明确进入 `$cm-fix`。

## 一条核心，八个节点

`$cm-ai` 始终按 N1–N8 执行。角色和模型可以配置，流程责任不随模型变化。

| 节点 | 责任 | 完成证据 |
| --- | --- | --- |
| N1 初始化 | 读取规格、审批状态、项目配置和恢复指针 | 规格已明确批准 |
| N2 Feature | 加载任务、测试合同、依赖与历史经验 | 当前范围清晰 |
| N3 Task | 由匹配工种修改当前任务范围内的代码 | 结构化 handoff |
| N4 Review | 新上下文独立审查修改与测试覆盖 | `.reviews/` verdict |
| N5 完成 | 回读证据、勾选任务并按策略提交 | `tasks.md` 与提交记录 |
| N6 QA | 运行逻辑、正式命令和可选浏览器路径 | 真实 QA 结果 |
| N7 重载 | 从磁盘重新建立上下文 | 不依赖旧聊天记忆 |
| N8 收尾 | 同步文档、对账凭证、汇总日志并交付 | diff / branch / Draft MR |

默认串行执行。只有依赖、文件边界、契约和 Worktree 隔离都满足时才允许并行写入；
specs、任务状态、审查、度量与 Git 始终保持单写权。

## 角色与模型可以配置

复制模板到代码项目根目录：

```bash
cp /path/to/cm-workflow/templates/cm-workflow.yml .cm-workflow.yml
```

项目可以配置这些流程角色：

```text
analyst · planner · coder · tester · reviewer · browser_qa · external_expert
```

以及有限的执行策略：

```yaml
policies:
  generate_cases: true
  tests: [logic, commands, browser]
  auto_fix: explicit
  delivery: draft-mr
```

角色可以声明本地、订阅或 API 模型适配器；配置只记录请求路由，不保存 API Key、
Token、Cookie 或 Prompt，也不会改变 N1–N8 的顺序。当前运行时没有接入某个适配器时，
只记录 `declared-adapter`，不会声称对应模型已经执行；没有匹配角色时，由当前 AI 在
相同合同下直接执行。内置 `openai-compatible` 可用于分析、规划和编码辅助，但版本 1
不允许配置为 `reviewer`；N4 仍需新上下文的本地独立审查凭证。

配置字段与运行时投影见 [Workflow 配置合同](runtime/workflow-config.md) 和
[角色路由合同](runtime/workflow-routing.md)。

## 外部专家负责思考，不接管代码

`$external-expert` 适合产品讨论、技术方案、问题研究、学术研究、测试设计和对抗核验。
它可以使用外部高能力模型，但始终是可选的研究通道：

- 编码、命令、浏览器 QA、Git 和 N4 审查仍由本地流程负责；
- `.env`、密钥、Token、Cookie、客户数据和数据库禁止外发；
- 外部回答是待核验材料，不能直接成为测试或完成证据；
- Pro 路由不可用时按既定策略降级，所有等级不可用就回到本地流程。

完整边界见 [External Expert 合同](runtime/external-expert.md)。

## 换一个会话，也能继续

<p align="center">
  <img src="./assets/readme/recovery-record.svg" width="100%" alt="新会话从任务、测试意图、审查证据、状态和运行日志恢复 CM Workflow">
</p>

CM 不把聊天记录当数据库。每个 specs 项目都会留下可恢复记录：

| 文件 | 作用 |
| --- | --- |
| `requirements.md` / `design.md` / `tasks.md` | 需求、方案和唯一权威任务状态 |
| `test-cases.json` | 可选的 AI 可读测试意图 |
| `.cm-specs-status` | 人工审批状态与完整规格语义 manifest |
| `.cm-status.json` / `.cm-run.json` | 当前节点和运行恢复指针 |
| `.reviews/` | task handoff、独立 verdict、PRD 处置回执与测试凭证 |
| `运行日志.jsonl` | 项目内权威事件日志 |
| `METRICS.md` / `LESSONS.md` | 执行度量与可复用经验 |

跨项目查看日志时，可以读取本机私有镜像：

```text
~/.cm-workflow/logs/
├── index.jsonl
└── runs/YYYY-MM/{run_id}.jsonl
```

它只是可重建的本机分析镜像，不是遥测服务，也不保存源码、Prompt、模型回答或凭证。

## Codex 与 Claude 共用同一核心

| 环境 | 入口 | 安装方式 |
| --- | --- | --- |
| Codex | `$cm-*` | `./install-codex.sh` |
| Claude Code macOS/Linux | `/cm-*`，兼容 `/cm:*` | `./install.sh` |
| Claude Code Windows | `/cm-*` | `install.ps1` |

Codex Skills 与 `runtime/` 是权威实现；Claude Code 使用同一组 Skills 和合同，兼容命令
只负责入口映射，不维护第二套流程。

## 人工与安全边界

以下动作不会因为流程自动化而被默认授权：

- 规格进入编码前的最终批准；
- push、创建 MR/PR 和生产发布；
- 密钥、凭证或权限变更；
- 破坏性 migration 与真实资金操作；
- 超出已审批任务范围的修改。

仓库不运行常驻服务、不收集遥测，也不保存你的模型凭证。仅在你主动启用可选
OpenAI-compatible 适配器时，本地进程会从环境变量读取 API Key。CI 会验证运行时合同、安装器、
公开包内容、Shell/PowerShell 兼容性与 Git 历史密钥扫描。安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。

## 维护与贡献

修改工作流后运行：

```bash
./scripts/cm-check-runtime.sh
bash scripts/test-shell-compat.sh
python3 scripts/validate-public-repo.py
python3 scripts/scan-public-safety.py
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

基础版本同时保存在 `VERSION` 与 `.codex-plugin/plugin.json`；Codex 安装副本会追加
`+codex.*` cachebuster。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT License](LICENSE)。Darwin Skill 与 Kenney CC0 素材来源见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
