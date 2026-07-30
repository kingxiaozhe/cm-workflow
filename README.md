<p align="center">
  <img src="./assets/readme/hero.svg" width="100%" alt="CM means Create More：CM Workflow 让更多想法成为可审查、可测试、可恢复的交付">
</p>

<p align="center">
  <a href="https://github.com/kingxiaozhe/cm-workflow/actions/workflows/ci.yml"><img src="https://github.com/kingxiaozhe/cm-workflow/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-151515" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Codex-native-2E6655" alt="Codex native">
  <img src="https://img.shields.io/badge/Claude%20Code-compatible-C44B32" alt="Claude Code compatible">
</p>

<p align="center">
  <strong>CM means Create More.</strong><br>
  一套本地、规格驱动的 AI 开发工作流：把点子和需求变成人工确认、任务审查并带有真实测试证据的代码交付。
</p>

<p align="center">
  <a href="#五分钟开始">立即安装</a> ·
  <a href="#一条完整开发路线">完整流程</a> ·
  <a href="#按目标选择入口">命令选择</a> ·
  <a href="docs/user-guide.md">使用手册</a> ·
  <a href="docs/architecture.md">架构说明</a>
</p>

## CM Workflow 是什么

CM Workflow 不是另一个会“声称已经完成”的编码 Prompt。它为 Codex 和 Claude Code
提供同一套可安装工作流，把研发过程固定为：

```text
需求 → 规格 → 人工确认 → 实现 → 任务审查 → 测试与 QA → 文档与恢复记录
```

它适合希望继续使用现有代码仓库、模型和开发工具，同时又想让 AI 开发过程可控、
可复查、可中断恢复的独立开发者与研发团队。

| 你想完成的事 | CM 提供的路径 | 最终留下什么 |
| --- | --- | --- |
| 从点子开发新功能 | `$cm-idea` → `$cm-prd` → `$cm-ai` | 规格、代码、测试与交付记录 |
| 验证已经存在的功能 | `$cm-test --generate-cases` → `$cm-test` | AI 可读测试合同与只读测试证据 |
| 修复或整理存量代码 | `$cm-fix` / `$cm-refactor` | 红灯测试或行为等价约束下的修改 |
| 研究方案或复杂问题 | `$external-expert` | 外部回答、本地核验与待验证结论 |

> **No evidence → no completion.** `tasks.md` 是任务状态的唯一权威来源；聊天记录、
> 子代理状态和界面进度都只是可重建的工作视图。

## 五分钟开始

安装前需要 Git、Python 3.9+，并准备好 Codex 或 Claude Code。源码目录不要放在
`~/plugins/cm-workflow`，该路径由 Codex 安装器管理。

### Codex

```bash
git clone https://github.com/kingxiaozhe/cm-workflow.git
cd cm-workflow
./install-codex.sh
```

安装后新开一个 Codex 对话并运行：

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

安装后新开 Claude Code 会话并运行 `/cm-check`。Windows 还需要 Git for Windows
（Git Bash）；也可以在 WSL 中使用 Bash 安装入口。覆盖策略、无人值守安装与可选
自动更新见 [安装指南](docs/installation.md)。

> 不知道下一步该运行什么？打开 [CM Workflow 使用手册](docs/user-guide.md)，从
> “我现在该用哪个命令？”开始。

## 一条完整开发路线

<p align="center">
  <img src="./assets/readme/delivery-flow.svg" width="100%" alt="一份任务从需求登记、规格成档、人工确认、逐任务实现、任务审查到 QA 归档的交付记录">
</p>

以接管一个已有项目为例：先把 PRD、需求说明或原型放入 specs 的 `docs/`，然后离开
CM Workflow 的安装目录，进入真正的代码仓库：

```bash
cd ~/code/my-app
```

再执行：

```text
$cm-init
$cm-prd ~/projects/my-app-specs
# 人工检查规格摘要、技术方案、任务与验收条件
$cm-ai ~/projects/my-app-specs ~/code/my-app
```

全新空项目不要运行 `$cm-init`；直接在代码目标目录旁准备 specs 的 `docs/`，运行
`$cm-prd {specs路径}`，并在询问时确认走 0→1 分支。

`$cm-ai` 按 N1–N8 执行，每个节点都有清晰职责：

| 节点 | 做什么 | 关键约束或凭证 |
| --- | --- | --- |
| N1 初始化 | 读取 specs、项目规则、审批状态与恢复指针 | 未明确批准的规格不能开工 |
| N2 进入 Feature | 加载任务、测试合同、依赖与历史教训 | 先确定串并行边界 |
| N3 执行 Task | 按前端、后端、数据库等工种规则修改代码 | 只改当前任务范围 |
| N4 Review | 自审后优先由新上下文独立审查 | 原始结果写入 `.reviews/` |
| N5 标记完成 | 回读任务状态并记录度量 | 启用 Git 时精确提交；NO_GIT 时显式降级 |
| N6 QA | 执行正式命令，按需运行浏览器用户路径 | 静态判断不能冒充测试通过 |
| N7 重载上下文 | 从磁盘重读 specs、规则与经验 | 自动继续，不依赖聊天记忆 |
| N8 收尾 | 同步文档、对账凭证、汇总度量与日志 | 生产发布仍由人决定 |

执行默认串行。只有任务无依赖、文件边界不重叠、契约稳定且当前运行时确实支持时，
才允许并行；主执行者始终保留 specs、任务状态、审查、度量与 Git 的单写权。

## 按目标选择入口

| Skill | 什么时候使用 | 会修改业务源码吗？ |
| --- | --- | --- |
| `$cm-idea` | 只有一个模糊点子，需要通过访谈形成 PRD | 否 |
| `$cm-init` | 第一次接管已有项目，生成 Agent 项目规则与上下文 | 否 |
| `$cm-prd` | 把需求整理成 requirements、design、tasks 与可选测试合同 | 否 |
| `$cm-ai` | 执行已经人工审批的 specs，并支持断点恢复 | **会** |
| `$cm-test` | 为存量功能生成测试草稿，或做逻辑、命令与浏览器测试 | 默认不会 |
| `$cm-fix` | 对可复现缺陷执行红灯测试、根因定位、最小修复与回归 | **会** |
| `$cm-refactor` | 在行为等价约束下调整代码结构 | **会** |
| `$cm-check` | 检查入口、角色、引用、模板、版本与双运行时一致性 | 否 |
| `$external-expert` | 讨论方案、研究问题、核验事实或做对抗分析 | 否 |

常见用法：

```text
$cm-prd ~/projects/my-app-specs
$cm-ai ~/projects/my-app-specs ~/code/my-app
$cm-test ~/code/my-app 用户登录 --generate-cases
$cm-test ~/code/my-app --specs ~/projects/my-app-specs --feature 2.user-login --all
$cm-fix ~/projects/my-app-specs ~/code/my-app 登录失败后仍跳转首页
$external-expert 比较这两个技术方案，并给出可验证的取舍依据
```

完整参数、六条常见任务路线和故障排查见 [使用手册](docs/user-guide.md)。

## 测试与审查不是一回事

<p align="center">
  <img src="./assets/readme/test-evidence.svg" width="100%" alt="CM Workflow 分别记录代码逻辑、正式命令和浏览器用户路径三类测试证据">
</p>

`$cm-test` 把证据分成三类，避免“看起来支持”被误报成“已经测试通过”：

- **logic**：追踪入口、分支、状态变化与输出，只能给出静态代码结论；
- **commands**：运行项目自己声明的测试、类型检查和构建命令，保存真实退出结果；
- **browser**：按测试用例模拟用户操作，记录 URL、动作、可观察结果、截图与日志。

测试默认只读：不改源码、不安装依赖、不降低断言，也不自动调用 `$cm-fix`。已有功能
没有测试用例时，可以先从代码逻辑生成 `test-cases.json` 草稿；它只保存测试意图，
不保存或伪造执行结果。

每个实现任务都必须经过审查，并优先建立与实现者不同的新上下文：

1. fresh Codex 子代理或独立任务；
2. 隔离、只读的 Codex CLI 审查；
3. 前两者不可用时才允许 `self-degraded`，并在凭证中写明
   `independent: false`；高风险任务可能因此暂停。

## 外部专家只负责思考

`$external-expert` 用于产品讨论、技术方案、问题研究、学术研究、测试设计和对抗核验。
它是可选的外部高能力模型通道，不是编码执行器。

- 默认 `EXPLICIT`；只有明确调用或为本次任务使用 `--auto` 才进入外部路由；
- AUTO 只会选择 `LOCAL / CONSULT / VERIFY`，不会自动 HANDOFF；
- 编码、命令、测试执行、浏览器 QA、Git 与 N4 审查始终留在本地；
- 本地文件需要逐文件展示规范绝对路径，并在当前调用中重新确认后才能外发；
- `.env`、密钥、Token、Cookie、数据库、客户数据和归档文件禁止外发；
- 浏览器模式默认按 `Pro → Extra High → High` 降级，全部不可用就返回本地流程；
  用户明确要求 strict-Pro 时，Pro 不可用即阻塞且不发送。

外部回答会作为待核验材料落盘；它不能直接修改代码、扩大权限、冒充测试结果或满足
N4 独立审查。完整边界见 [External Expert 合同](runtime/external-expert.md)。

## 磁盘是最终记录

<p align="center">
  <img src="./assets/readme/recovery-record.svg" width="100%" alt="新会话读取任务、测试意图、审查、状态与运行日志后从未完成处继续">
</p>

一个 specs 项目会保留这些核心记录：

| 文件 | 作用 |
| --- | --- |
| `requirements.md` / `design.md` / `tasks.md` | 需求、方案与唯一权威任务状态 |
| `test-cases.json` | 可选的 AI 可读测试意图 |
| `.cm-specs-status` | specs 人工审批状态 |
| `.cm-status.json` / `.cm-run.json` | 当前节点与运行恢复指针 |
| `.reviews/` | 每轮任务审查与测试凭证；头部标明是否独立 |
| `运行日志.jsonl` | 项目内权威事件记录 |
| `METRICS.md` / `LESSONS.md` | 度量与可复用经验 |

新会话从这些文件重建上下文，不要求上一段聊天仍然存在。

从 v0.10.3 开始，标准化事件还会镜像到本机用户级目录，方便跨会话、跨项目查看：

```text
~/.cm-workflow/logs/
├── index.jsonl
└── runs/YYYY-MM/{run_id}.jsonl
```

项目内的 `运行日志.jsonl` 始终是权威来源；全局目录只是本机私有、可重建的分析镜像，
不是遥测服务，也不保存 Prompt、模型回答、凭证或源码正文。可通过
`CM_WORKFLOW_LOG_HOME` 修改位置。

从 v0.10.4 开始，长时间桌面与浏览器测试会在真实阶段变化时记录进度检查点；临时
Profile、进程、模型别名和 fixture 必须成对记录获取与释放，未清理资源会阻止流程
写入完成状态。该机制不使用后台心跳或常驻日志服务。

## 一份核心，两种入口

Codex Skills 和 `runtime/` 是权威实现。Claude Code 直接使用同一组 Skills；历史
`/cm:*` 只是在 macOS/Linux 上保留的轻量兼容别名。

| 环境 | 入口 | 安装与差异 |
| --- | --- | --- |
| Codex | `$cm-*` | `install-codex.sh`；Codex-native 主运行时 |
| Claude Code macOS/Linux | `/cm-*`，兼容 `/cm:*` | `install.sh`；Bash 辅助工具原生可用 |
| Claude Code Windows | `/cm-*` | `install.ps1`；自检与 Bash 辅助工具需要 Git Bash |

角色按责任拆分，而不是为增加 Agent 数量而拆分：

- 执行工种：前端、UI、小程序、后端、数据库、智能合约；
- 串行把关：产品、金融、QA、DevOps、文档同步；
- 独立工具：项目上下文、外部专家、Skill 优化；点子转 PRD 是 `cm-idea` 的内置引擎。

没有匹配角色时由当前 AI 直接执行；角色不会取代项目自身的 `AGENTS.md`、测试命令或
人工审批。

## 人工边界

以下动作始终保留人工确认：

- 规格进入编码前的最终批准；
- 生产发布与真实资金操作；
- 密钥、凭证和权限变更；
- 破坏性 migration；
- 超出已审批任务范围的修改。

安装器覆盖既有文件前会列出冲突；可选 Claude 自动更新器只复制，不自动启用。

## 可选可视化

```bash
templates/dashboard/serve.sh {specs路径}
templates/pixel/cm-pixel.sh --demo
templates/pixel/serve.sh {specs路径}
```

这些工具只读 specs 中的状态与度量，不参与执行。

## 维护与验证

修改工作流后运行：

```bash
./scripts/cm-check-runtime.sh
./scripts/cm-check-runtime.sh --log-fixtures
python3 scripts/validate-public-repo.py
python3 scripts/scan-public-safety.py
python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .
```

基础版本同时保存在 `VERSION` 与 `.codex-plugin/plugin.json`；安装副本可追加
`+codex.*` cachebuster。贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 安全与许可

仓库没有常驻服务，不收集遥测，也不需要用户凭证。当前树会检查常见密钥形态、个人
绝对路径和私有端点；CI 对完整 Git 历史运行 Gitleaks。发现安全问题请按
[SECURITY.md](SECURITY.md) 私下报告。

项目采用 [MIT License](LICENSE)。Darwin Skill 与 Kenney CC0 素材的来源和许可见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
