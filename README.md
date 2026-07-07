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
    ├── N2-enter-feature.md  # 进入 feature：断点恢复、依赖分析、串/并行计划
    ├── N3-execute-task.md   # 执行 task：按工种匹配 skill
    ├── N4-review.md         # AI 自审 + Codex 复审（环境不可用时降级）
    ├── N5-mark-done.md      # 标记 [x]、写 LESSONS.md
    ├── N6-qa-eval.md        # QA 评分决定是否触发 cm-qa-engineer
    ├── N7-context.md        # 每个 task 后 /clear 重载 specs
    └── N8-finish.md         # 调用 cm-doc-syncer、输出总结

skills/                      # 工种 Skills（安装到 ~/.claude/skills/）
├── cm-frontend-engineer/    # Web 前端（React/Vue/Svelte/Next 等自适配，Figma/Stitch 还原）
├── cm-miniprogram-engineer/ # 微信小程序（原生/Taro/uni-app）
├── cm-database-engineer/    # 数据库（migration、模型、查询优化）
├── cm-contract-engineer/    # 智能合约（EVM/Solana/Move 多链）
├── cm-qa-engineer/          # QA（测试补全、E2E、可视化回归、验收核验）
└── cm-doc-syncer/           # 文档同步（README/CLAUDE.md/rules/CHANGELOG）
```

## 安装

```bash
cp -r commands/* ~/.claude/commands/
cp -r skills/*   ~/.claude/skills/
```

## 使用流程

1. 在代码项目中运行 `/cm:init`，生成 `.claude/CLAUDE.md` 和 `rules/` 规范
2. 建一个 specs 文件夹，把需求文档放进 `docs/`，运行 `/cm:prd {specs路径}` 生成规格三件套
3. 审查 specs 后运行 `/cm:ai {specs路径} {代码项目路径}` 开始自动开发
4. 需求变更时用 `/cm:prd --change {N}.{feature} 变更描述`，已完成任务不受影响
