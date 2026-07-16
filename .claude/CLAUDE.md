# cm-workflow

spec-driven 的 Claude Code 自动化开发工作流分发包：需求文档 → 开发规格 → 自动开发 → QA → 文档同步。本仓库的「源码」是 prompt 资产（Markdown），产物安装到 `~/.claude/`。

## 技术栈

- 语言: Markdown（prompt 资产，占 60/68 源文件）+ Bash（安装与可视化脚本）+ PowerShell（Windows 安装器）
- 框架: 无。Claude Code 原生扩展机制——commands / skills / agents / templates
- 包管理: 无。分发靠 `install.sh` / `install.ps1` 拷贝到 `~/.claude/`
- 版本控制: remote
- 交付形态: 开发者工具（Claude Code 插件包，纯 Markdown + bash，无构建产物）
- 业务地图: 跳过（prompt 资产库，codebase-context 不适用——其七轮抓取目标 src/api/types/components/store 本项目均无；README 的带注释目录树即业务地图）

## 常用命令

- 安装到本机: `./install.sh`（含覆盖确认，装完提示跑 /cm:check）
- Windows 安装: `powershell -ExecutionPolicy Bypass -File install.ps1`
- 一致性自检: `/cm:check`（**本仓库唯一的自动化测试，改任何框架文件后必跑**）
- 查看版本: `cat VERSION`
- 可视化预览: `templates/pixel/cm-pixel.sh --demo`、`templates/dashboard/serve.sh {specs路径}`

无 build / lint / 单元测试——不存在构建产物，质量门是 `/cm:check` + dogfood 实跑。

## 目录结构

```text
commands/              # 斜杠命令 → ~/.claude/commands/
├── cm:{init,prd,ai,fix,idea,check}.md
├── cm-ai-nodes/       # cm:ai 的 N1–N8 节点，按需加载
└── cm-prd-modes/      # cm:prd 的 greenfield/brownfield/change-mode
skills/                # 工种能力 → ~/.claude/skills/{name}/SKILL.md —— skill 管技术
├── cm-*-engineer/     # frontend/ui/miniprogram/backend/database/contract/qa/devops
├── cm-product-manager/、cm-finance-expert/、cm-doc-syncer/
└── codebase-context/、idea-to-prd/、darwin-skill/   # 独立工具，不进 N1–N8
agents/                # 并行子 agent → ~/.claude/agents/ —— agent 管纪律
templates/             # rules 骨架 / hooks / statusline / dashboard / pixel
docs/                  # 交付材料、示例 PRD 与 specs
VERSION                # 单一版本源，与 cm:check 基线号双写
```

## 核心架构原则

- **agent 管纪律，skill 管技术**：并行干活的做 agent（前端/UI/小程序/后端/数据库/合约），串行把关的做 skill（产品/金融/QA/运维/doc-syncer）。新增角色前先归到这两类之一。
- **引用即契约**：本仓库历史缺陷全属「引用断链」——改名残留、匹配表缺项、死角色、失效命令引用。任何跨文件引用都由 `/cm:check` 机器化校验。
- **模板层是团队定制入口**：公司规范沉淀进 `templates/rules/`，所有项目 `/cm:init` 出的 rules 自动带公司基因。

## 规则

@rules/coding-style.md
@rules/testing.md
@rules/security.md
@rules/git-workflow.md
