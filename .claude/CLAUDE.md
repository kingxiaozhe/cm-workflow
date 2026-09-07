# cm-workflow

Codex-native、spec-driven 的双运行时工作流分发包：需求文档 → 开发规格 →
实现 → 独立审查 → QA → 文档同步，并支持存量功能只读测试与可选外部专家研究。Codex Skills 与
`runtime/` 是权威流程，
Claude Code 跨平台直接使用 `/cm-*` Skills；`compat/claude-commands/` 保存
macOS/Linux 的历史 `/cm:*` 别名包装。

## 技术栈

- 语言: Markdown（prompt 资产主体）+ Bash（安装与可视化脚本）+ PowerShell（Windows 安装器与自检入口）+ Python（标准库校验/夹具）+ JavaScript（Node.js 18+；Playwright 可选）
- 框架: Codex plugin + Agent Skills；Claude Code commands/agents 兼容层
- 包管理: 无。Codex 用 `install-codex.sh`；Claude Code 用 `install.sh` / `install.ps1`
- 版本控制: remote
- 交付形态: 开发者工具（Markdown + 本地脚本，无构建产物）
- 业务地图: 跳过(形态不适用,无项目描述文件)；公开架构见 `docs/architecture.md`

## 常用命令

- 安装依赖: 无统一安装步骤（仓库无包管理器；可视化工具按需使用外部 Playwright）
- 开发运行: 不适用（直接维护 Markdown 与脚本）
- 构建: 不适用（无构建产物）
- 测试: `bash scripts/test-shell-compat.sh && node --test scripts/cm-ai-admission.test.mjs scripts/cm-workflow-config.test.mjs scripts/cm-log-event.test.mjs scripts/cm-task-gate.test.mjs scripts/validate-test-cases.test.mjs && python3 scripts/test-task-gate.py`
- Lint/安全: `python3 scripts/validate-public-repo.py && python3 scripts/scan-public-safety.py`
- Bash 语法: `find . -type f -name '*.sh' -print0 | xargs -0 -n1 /bin/bash -n`
- Codex 安装: `./install-codex.sh`（装完新开会话跑 `$cm-check`）
- Claude 安装: `./install.sh`（含覆盖确认，装完跑 `/cm-check`）
- Windows 安装: `powershell -ExecutionPolicy Bypass -File install.ps1`
- 一致性自检: `./scripts/cm-check-runtime.sh`
- 全局日志夹具: `./scripts/cm-check-runtime.sh --log-fixtures`
- JS runtime 兼容夹具: `node --test experiments/js-orchestration/*.test.mjs`（当前完整套件要求 macOS + Node.js 24.14+，含原生 SQLite；源码随 runtime 分发不等于 host 已激活）
- 只读任务提案: `scripts/cm-task-gate.mjs` 的 `prepare-mark-done` / `verify-mark-done-plan`；参数与私有输出契约见 `runtime/task-gates.md`，不是完成授权
- 插件验证: `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`
- 查看版本: `cat VERSION`
- 可视化预览: `templates/pixel/cm-pixel.sh --demo`、`templates/dashboard/serve.sh {specs路径}`

不使用第三方单元测试框架；Shell/Python 行为由可执行夹具覆盖，prompt 流程另需相关路径 dogfood。安装命令会写用户级目录，只在明确安装或隔离冒烟时执行。

## 目录结构

```text
compat/claude-commands/ # macOS/Linux 历史 /cm:* 三行别名包装
skills/                # Codex 权威流程与工种能力
├── cm-{idea,init,prd,ai,test,fix,refactor,check}/
├── cm-*-engineer/     # frontend/ui/miniprogram/backend/database/contract/qa/devops
├── cm-product-manager/、cm-finance-expert/、cm-doc-syncer/
└── codebase-context/、external-expert/、darwin-skill/ # 独立工具；点子访谈引擎位于 cm-idea/references/
agents/                # 并行子 agent → ~/.claude/agents/ —— agent 管纪律
runtime/               # 双运行时共享合同；runtime/js/cm-ai 保存唯一 JS 源码与未激活 host API
templates/             # workflow config / rules 骨架 / hooks / statusline / dashboard / pixel
docs/                  # 使用手册、安装架构、交付材料与示例 specs
assets/                # README 与使用手册的本地视觉资产
scripts/               # 双运行时机械检查、公开包校验与辅助脚本
experiments/js-orchestration/ # JS 兼容转发、历史实验与本地夹具；不保存第二份 cm-ai 实现
.codex-plugin/         # Codex 插件清单
VERSION                # 语义版本源，与 plugin manifest 基础版本一致
```

## 核心架构原则

- **agent 管纪律，skill 管技术**：并行干活的做 agent（前端/UI/小程序/后端/数据库/合约），串行把关的做 skill（产品/金融/QA/运维/doc-syncer）。新增角色前先归到这两类之一。
- **引用即契约**：本仓库历史缺陷全属「引用断链」——改名残留、匹配表缺项、死角色、失效命令引用。任何跨文件引用都由 `/cm-check` 机器化校验。
- **一份流程真相**：Codex Skill 是权威实现，Claude 旧别名只转发，不复制业务规则。
- **任务级 Learning loop**：开发/排错先重读根 `AGENTS.md`；每 task 收尾按 `runtime/project-learning.md` 提炼写回、随任务审查并回读，无新增明确记录。JS 源码接通不等于真实下一 task 复用已验收。
- **源码分发不等于激活**：正式 JS 源码、本地测试或独立审查不等于 host 已接入、真实 provider 执行、任务完成、跨平台验证或发布；真实项目写入仍需明确授权。
- **模板层是团队定制入口**：公司规范沉淀进 `templates/rules/`，所有项目 `/cm-init` 出的 rules 自动带公司基因。
- **流程间隔离（维护者确立,2026-07-18）**：修改任一 `cm-*` 流程不得顺带修改其他流程；流程 A 需要流程 B 的内容时读取 B 的落盘物，不复制或改写 B 的规则。发版版本只同步 `VERSION` 与 plugin manifest。

## 规则

@rules/coding-style.md
@rules/testing.md
@rules/security.md
@rules/git-workflow.md
