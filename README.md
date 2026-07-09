# My_skill — cm 系列 Claude Code 自动化开发工作流

一套 spec-driven 的 Claude Code 工作流：**需求文档 → 开发规格 → 自动开发 → QA → 文档同步**。

## 目录结构

```text
commands/                    # 斜杠命令（安装到 ~/.claude/commands/）
├── cm:init.md               # 项目 .claude/ 初始化（CLAUDE.md + rules/）
├── cm:prd.md                # 需求文档 → specs 三件套（requirements/design/tasks），支持 --change 变更模式
├── cm:ai.md                 # 自动开发主循环（流程图状态机）
└── cm-ai-nodes/             # cm:ai 的 8 个流程节点，按需加载
    ├── N1-init.md           # 初始化：解析路径、扫描 features、加载上下文
    ├── N2-enter-feature.md  # 进入 feature：断点恢复、依赖分析、串/并行计划（跨项目并行可选 Agent Teams）
    ├── N3-execute-task.md   # 执行 task：按工种匹配 skill
    ├── N4-review.md         # AI 自审 + Codex 复审（环境不可用时降级）
    ├── N5-mark-done.md      # 标记 [x]、写 LESSONS.md
    ├── N6-qa-eval.md        # QA 评分决定是否触发 cm-qa-engineer
    ├── N7-context.md        # 每个 task 后 /clear 重载 specs
    └── N8-finish.md         # 调用 cm-doc-syncer、输出总结

skills/                      # 工种 Skills（安装到 ~/.claude/skills/）—— skill 管技术
├── cm-frontend-engineer/    # Web 前端（React/Vue/Svelte/Next 等自适配，设计稿还原 + BackstopJS 像素对比）
├── cm-miniprogram-engineer/ # 微信小程序（原生/Taro/uni-app）
├── cm-backend-engineer/     # 后端 API（路由/鉴权/缓存/队列，契约三级协议）
├── cm-database-engineer/    # 数据库（migration、模型、查询优化）
├── cm-contract-engineer/    # 智能合约（EVM/Solana/Move 多链）
├── cm-qa-engineer/          # QA（测试补全、E2E、可视化回归、验收核验）
└── cm-doc-syncer/           # 文档同步（README/CLAUDE.md/rules/CHANGELOG）

agents/                      # 并行工种的子 agent 定义（安装到 ~/.claude/agents/）—— agent 管纪律
├── cm-frontend-agent.md     # 只做指定任务、不碰界外文件、不自行标记、规范汇报
├── cm-miniprogram-agent.md  # （每个 agent 内部加载同名工种 skill）
├── cm-backend-agent.md      # 范围外鉴权/权限改动强制上报
├── cm-database-agent.md     # 破坏性 migration 强制上报
└── cm-contract-agent.md     # 不碰私钥、不执行主网部署
```

**分工原则**：并行干活的做 agent（前端/小程序/后端/数据库/合约），串行把关的做 skill（QA/doc-syncer）。

## 安装

```bash
cp -r commands/* ~/.claude/commands/
cp -r skills/*   ~/.claude/skills/
cp -r agents/*   ~/.claude/agents/
```

## 使用流程

**存量项目：**

1. 在代码项目中运行 `/cm:init`，生成 `.claude/CLAUDE.md` 和 `rules/` 规范
2. 建一个 specs 文件夹，把需求文档放进 `docs/`，运行 `/cm:prd {specs路径}` 生成规格三件套
3. 审查 specs 后运行 `/cm:ai {specs路径} {代码项目路径}` 开始自动开发
4. 需求变更时用 `/cm:prd --change {N}.{feature} 变更描述`，已完成任务不受影响

**0 到 1 新项目（无需先手动搭脚手架）：**

1. 建 specs 文件夹放入需求文档，直接运行 `/cm:prd {specs路径}`——检测到空项目后自动进入 0→1 分支：先给出 2-3 套技术选型方案供人拍板，再生成 `0.bootstrap` feature（design.md 即架构决策记录 ADR，任务含脚手架 / 规范生成 / CI / 公共底座）
2. 人审规格（审 `0.bootstrap` 就是审架构）后运行 `/cm:ai`——bootstrap 最优先执行，完成后业务 feature 在真实规范下照常开发
3. 日后架构调整走 `/cm:prd --change 0.bootstrap 变更描述`，选型演进全程留痕
4. 跳过 `/cm:init`——空项目没有可分析的对象，规范生成是 bootstrap 的任务之一
