<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="CM means Create More：把需求变成有规格、测试和审查记录的代码交付">
</p>

# CM Workflow

**安装在 Codex 或 Claude Code 中的规格驱动开发工作流。** 从明确需求、人工确认，到实现、独立审查与测试，让每项交付都有可检查的依据。

<p>
  <a href="https://github.com/kingxiaozhe/cm-workflow/actions/workflows/ci.yml"><img src="https://github.com/kingxiaozhe/cm-workflow/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-151515" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Codex-native-2E6655" alt="Codex native">
  <img src="https://img.shields.io/badge/Claude%20Code-compatible-C44B32" alt="Claude Code compatible">
</p>

[快速开始](#快速开始codex) · [升级旧版本](#升级旧版本) · [选择命令](#选择命令) · [支持范围](#支持范围) · [使用手册](docs/user-guide.md)

## 从需求到交付

AI 写完代码以后，你还需要知道：需求是否对齐、测试是否真正执行、修改是否经过独立审查，以及中断后该从哪里继续。CM Workflow 把这些要求放进同一条开发流程。

```text
需求 → 可开发规格 → 人工确认 → 实现 → 独立审查 → 测试与 QA → 交付
```

在 Codex 中，一次典型使用是：

```text
$cm-prd ~/projects/my-app-specs
```

审阅生成的需求、设计和任务，明确确认后：

```text
规格已确认，开始实现。
$cm-ai ~/projects/my-app-specs ~/code/my-app
```

**新任务默认进入 JS workflow，无需再指定“使用改造后的 JS workflow”。** Skills 提供业务规则与工种能力，JS 运行器管理执行阶段和证据门禁，当前 Codex 或 Claude Code 会话执行实际工具请求。

> `tasks.md` 是任务状态的权威来源。聊天里的“完成了”、静态分析和界面进度，不能替代真实测试、独立审查与完成凭证。

## 快速开始：Codex

准备好 **Git、Python 3.9+、Node.js 24.14+**，以及带有内置插件创建辅助工具的当前 Codex。安装器和部分共享工具的最低要求是 Node 18；默认 JS 开发流程需要 Node 24.14+。

以下主路径以 macOS 为准；其他环境先看[支持范围](#支持范围)。将源码克隆到独立目录，**不要放在 `~/plugins/cm-workflow`**，该目录由安装器管理。

```bash
git clone https://github.com/kingxiaozhe/cm-workflow.git
cd cm-workflow
./install-codex.sh
```

安装后新开一个 Codex 任务，运行：

```text
$cm-check
```

自检用于检查安装和工作流合同。具体项目的功能测试与真实模型审查，在后续开发流程中分别执行。

仓库直接分发 Skills 和脚本，无需在仓库根目录运行 `npm install` 或构建。完整安装行为、覆盖范围和卸载说明见[安装指南](docs/installation.md)。

## 升级旧版本

升级仍然使用同一个安装器。在原来的**源码 checkout** 中先检查本地修改：

```bash
git status --short
```

有未提交修改时先保存或处理；工作区干净后执行：

```bash
git switch main
git pull --ff-only origin main
./install-codex.sh
```

安装器会列出覆盖内容并要求确认。明确接受无人值守覆盖时，可以使用 `./install-codex.sh --yes`。升级 Node 到 24.14+ 后，安装与运行都应使用该版本。

完成后新开 Codex 任务，运行 `$cm-check`，再使用 `$cm-ai`。只更新 Git 源码不会更新已安装插件；已打开的任务也可能仍加载旧版 Skill。

升级后的执行规则：

- **新任务**默认走 JS；不支持的宿主、环境或配置会明确阻断，不会静默切回旧流程。
- **已有 JS 运行**按原身份、配置和恢复约束续接；不能通过更换运行标识绕过阻断。
- **已确认的旧兼容任务**继续沿原流程恢复，不会因升级自动迁移。记录缺失或归属冲突时先只读核对；新任务只有在用户明确选择时才使用旧兼容流程。

## 选择命令

以下是八个核心入口。Codex 使用 `$cm-*`，Claude Code 使用 `/cm-*`。

| 你想做什么 | Codex 入口 | 产出或下一步 |
| --- | --- | --- |
| 把模糊点子变成需求 | `$cm-idea` | 形成 PRD，进入规格阶段 |
| 第一次接管已有仓库 | `$cm-init` | 建立项目上下文与规范 |
| 把需求拆成可开发任务 | `$cm-prd {specs路径}` | 需求、设计、任务和审批材料 |
| 执行已经确认的规格 | `$cm-ai {specs路径} {项目路径}` | 实现、审查、QA 与交付记录 |
| 测试已有功能 | `$cm-test {项目路径}` | 分层测试结果与证据 |
| 修复可复现缺陷 | `$cm-fix {specs路径} {项目路径} {问题}` | 红灯测试、最小修复、回归验证 |
| 整理结构并保持行为 | `$cm-refactor` | 按行为等价约束分批重构 |
| 检查安装与工作流 | `$cm-check` | 环境、引用和合同检查结果 |

需要单独讨论方案或研究复杂问题时，可显式使用可选工具 `$external-expert`。外部建议由本地核验，不能代替独立代码审查或测试证据。详见[使用手册](docs/user-guide.md)与[外部专家合同](runtime/external-expert.md)。

## 跑通第一个项目

### 1. 准备代码与需求

假设代码在 `~/code/my-app`，规格放在独立的 `~/projects/my-app-specs`。将 PRD、需求说明或原型材料放入 specs 的 `docs/`。

已有代码仓库可先在代码目录中运行 `$cm-init`；全新项目直接从 `$cm-prd` 开始，由规格确定项目形态与初始化任务。

### 2. 生成并确认规格

```text
$cm-prd ~/projects/my-app-specs
```

每个 Feature 会形成：

```text
requirements.md   # 用户故事与验收条件
design.md         # 技术方案与修改边界
tasks.md          # 可执行任务与权威任务状态
test-cases.json   # 可选的结构化测试合同
```

检查需求、方案、任务和验收条件后，明确确认规格。审批绑定完整规格清单；需求、设计或测试目标变化后需要重新确认，正常勾选任务不会被当成需求变更。

### 3. 执行与检查交付

```text
规格已确认，开始实现。
$cm-ai ~/projects/my-app-specs ~/code/my-app
```

<p align="center">
  <img src="./assets/readme/delivery-flow.svg" width="100%" alt="需求登记、规格成档、人工确认、逐任务实现、独立审查与 QA 归档">
</p>

JS 运行器按 N1–N8 管理初始化、Feature、开发、审查、任务完成、QA、上下文重载和收尾。任务完成与整轮运行完成分别检查；必需 QA 或文档核验未通过时，不能宣布整轮交付完成。

交付策略可以是本地 `diff`、本地 `branch` 或 `draft-mr`。实际 Git 操作仍受宿主能力和当前授权约束；配置 `draft-mr` 本身不会授予 push 或创建 PR/MR 的权限。生产发布保留人工确认。

## 测试已有功能

没有测试合同时，先从已有代码生成用例草稿：

```text
$cm-test ~/code/my-app 用户登录 --generate-cases
```

生成草稿后流程停止，并返回 `test-cases.generated.json` 的实际路径；这一步不会执行用例。审阅预期行为，把已确认用例的 `origin` 改为 `user`，并删除对应的 `[需确认]` 标记，再运行：

```text
$cm-test ~/code/my-app --cases {生成结果返回的用例文件路径} --all
```

将占位符替换为那份已确认草稿的实际路径。已有 specs 测试合同时，也可以用 `--specs {specs路径} --feature {Feature完整名称}` 选择相应用例。

| 证据层 | 能说明什么 |
| --- | --- |
| `logic` | 代码入口、分支与状态逻辑是否支持预期；属于静态检查 |
| `commands` | 项目声明的测试、类型检查或构建命令是否真实运行并通过 |
| `browser` | 在可用且获准的浏览器环境中，用户操作是否产生预期结果 |

`cm-test` 默认不修改业务源码，但会写测试报告与证据。缺少环境或工具时会报告缺口，不把静态检查算作浏览器通过；需要修复时明确进入 `cm-fix`。

## 中断后如何继续

CM 从磁盘记录恢复上下文，而不是只依赖聊天历史。

| 记录 | 用途 |
| --- | --- |
| `requirements.md`、`design.md`、`tasks.md` | 规格与任务状态 |
| `.cm-specs-status` | 人工审批与规格清单 |
| `.cm-status.json`、`.cm-run.json` | 当前状态与恢复指针 |
| `.reviews/` | 交接、独立审查和相关凭证 |
| `运行日志.jsonl` | specs 内的权威事件日志 |
| `METRICS.md`、`LESSONS.md` | 执行度量与复盘经验 |

再次调用 `cm-ai` 时，先核对已有运行的归属和恢复条件。恢复受原配置、内容和会话身份约束；不满足时明确阻断。已登记但结果未知的审查不会自动重发，必须先核对并按规定处理。

跨项目日志位于本机 `~/.cm-workflow/logs/`，是可重建的私有镜像，不是遥测。它只保存规范化运行元数据，不收集源码、Prompt、模型回答或凭证。详见[日志合同](runtime/logging.md)。

## 支持范围

安装成功、共享工具通过 CI 和完整 JS 开发实测是不同的验证范围。

| 环境 | 安装 / 入口 | JS 开发流程的当前边界 |
| --- | --- | --- |
| Codex · macOS | `./install-codex.sh`；`$cm-*` | 默认 JS 入口已接入，有本地安装与工具执行证据；不等于所有业务场景、真实模型审查都已验收 |
| Claude Code · macOS | `./install.sh`；`/cm-*` | 使用同一 JS 核心，当前会话入口已接入；完整真实双宿主业务验收仍待补齐 |
| Linux / WSL2 | 对应 Bash 安装器 | runner 已有平台准入；尚缺目标环境端到端实测，Claude 隔离配置诊断目前限 macOS |
| Claude Code · 原生 Windows | `install.ps1`；`/cm-*` | PowerShell 安装和共享工具有 CI 覆盖；原生 Windows JS runner 尚不支持 |
| Pi / BYZ | Pi package | 分发同一组 Skills 与 Prompts；包加载不代表已具备 Codex/Claude 的 JS 工具宿主 |

所有 JS 开发入口要求 Node 24.14+。同仓 specs、多代码根、批次、受保护写入与审查授权的具体条件见 [JS workflow 控制与当前会话入口](docs/js-workflow-control.md)及 [cm-ai 宿主接入](skills/cm-ai/references/js-host.md)。

<details>
<summary>其他安装方式：Claude Code 与 Pi / BYZ</summary>

先按快速开始克隆仓库。Claude Code 在 macOS / Linux 中运行：

```bash
./install.sh
```

Windows 需要 PowerShell 5.1+ 和 Git for Windows（Git Bash）：

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

安装后新开 Claude Code 会话，运行 `/cm-check`。macOS / Linux 还保留历史 `/cm:*` 别名；Windows 使用 `/cm-*`。

Pi package 安装：

```bash
pi install git:github.com/kingxiaozhe/cm-workflow
```

Pi 资源加载器直接发现 Skills 与 Prompts，不运行上述安装器，也不会把文件复制到 Codex 或 Claude Code 的全局目录。详细行为见[安装指南](docs/installation.md)。

</details>

## 配置与深入阅读

项目配置放在代码根目录的 `.cm-workflow.yml`，可从[配置模板](templates/cm-workflow.yml)开始。角色路由和执行策略必须落在实际宿主已支持的能力内；声明模型或适配器不等于已实际调用。

| 文档 | 内容 |
| --- | --- |
| [使用手册](docs/user-guide.md) | 命令参数、场景和完整流程 |
| [安装指南](docs/installation.md) | 覆盖安装、可选更新器与卸载 |
| [JS workflow 控制](docs/js-workflow-control.md) | 当前宿主、恢复、QA 与能力限制 |
| [Workflow 配置](runtime/workflow-config.md) | 角色与策略字段 |
| [任务门禁](runtime/task-gates.md) | 交接、Review 与完成校验 |
| [公开示例规格](docs/sample-specs/) | 规格文件的组织方式 |

## 维护与贡献

`skills/` 保存工作流与角色规则，`runtime/js/cm-ai/` 保存共享 JS 实现，`scripts/` 提供入口与验证工具。`compat/claude-commands/` 只做历史命令转发；根 `package.json` 是 Pi/BYZ 包元数据，无 npm 依赖或构建脚本。

基础检查：

```bash
./scripts/cm-check-runtime.sh
python3 scripts/validate-public-repo.py
python3 scripts/scan-public-safety.py
```

按改动范围补充对应夹具与实跑，详见 [CONTRIBUTING.md](CONTRIBUTING.md)。版本以 `VERSION` 与插件 manifest 的基础版本为准；安装副本的 `+codex.*` 后缀用于刷新缓存。

安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## License

[MIT License](LICENSE)。Darwin Skill 与 Kenney CC0 素材的来源和许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
