# My_skill — cm 系列 Claude Code 自动化开发工作流

一套 spec-driven 的 Claude Code 工作流：**需求文档 → 开发规格 → 自动开发 → QA → 文档同步**。

## 目录结构

```text
commands/                    # 斜杠命令（安装到 ~/.claude/commands/）
├── cm:init.md               # 项目 .claude/ 初始化（CLAUDE.md + rules/）
├── cm:prd.md                # 需求文档 → specs 三件套（requirements/design/tasks），支持 --change 变更模式
├── cm:ai.md                 # 自动开发主循环（流程图状态机）
├── cm:fix.md                # 缺陷修复小闭环（复现→定位→防护网→最小修复→Codex审查→波及面回归→档案落盘）
│
│  # 独立工具 skill（不属于 N1-N8 流程,按需使用）
│  skills/idea-to-prd/       # 点子→PRD 产品访谈搭档:一次一题把模糊想法聊成 L1→L3 规格,
│                            # 含 trading/web3 领域包;产出的 PRD 交给 /cm:prd 拆 specs——
│                            # 新项目从零想法起步时的前置工具,与 /cm:prd 互不依赖
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
├── cm-frontend-engineer/    # Web 前端（业务逻辑/状态/API，消费 UI 工程师的组件契约）
├── cm-ui-engineer/          # UI 还原（design-baseline → token 先行 → 原子还原 → BackstopJS ≤1%）
├── cm-miniprogram-engineer/ # 微信小程序（原生/Taro/uni-app）
├── cm-backend-engineer/     # 后端 API（路由/鉴权/缓存/队列，契约三级协议）
├── cm-database-engineer/    # 数据库（migration、模型、查询优化）
├── cm-contract-engineer/    # 智能合约（EVM/Solana/Move 多链）
├── cm-qa-engineer/          # QA（测试补全、E2E、可视化回归、技术验收）
├── cm-product-manager/      # 产品（需求分析、歧义五问、变更影响、业务验收走查）
├── cm-finance-expert/       # 金融专家（Web3/证券领域把关、营销合规红线、只举旗不定性）
├── cm-devops-engineer/      # 发布/运维（staging 部署+冒烟、发布记录、生产发布人工确认）
└── cm-doc-syncer/           # 文档同步（README/CLAUDE.md/rules/CHANGELOG）

agents/                      # 并行工种的子 agent 定义（安装到 ~/.claude/agents/）—— agent 管纪律
├── cm-frontend-agent.md     # 只做指定任务、不碰界外文件、不自行标记、规范汇报
├── cm-ui-agent.md           # 只碰展示层白名单、基准只读、改既有 token 强制上报
├── cm-miniprogram-agent.md  # （每个 agent 内部加载同名工种 skill）
├── cm-backend-agent.md      # 范围外鉴权/权限改动强制上报
├── cm-database-agent.md     # 破坏性 migration 强制上报
└── cm-contract-agent.md     # 不碰私钥、不执行主网部署
```

**分工原则**：并行干活的做 agent（前端/UI/小程序/后端/数据库/合约），串行把关的做 skill（产品/金融/QA/运维/doc-syncer）。

**可选外部依赖**：`npx skills add alchaincyf/huashu-design`（MIT）——无设计稿时在 /cm:prd 阶段生成高保真原型作为设计基准，未安装则 UI 走前端自行实现。

**rules 模板层**（`templates/rules/`，install.sh 装到 `~/.claude/templates/cm-rules/`）：10 个规则骨架（coding-style / testing / security / git-workflow / frontend / miniprogram / backend-api / database / smart-contract / finance），/cm:init 以其为骨架 + 项目推断生成最终规则；模板头部统一四原则（可执行 / Bad-Good / 量化 / 现代实践）。**把公司规范沉淀进模板，所有项目 init 出的 rules 自动带公司基因**——这是团队定制的官方入口。

## 安装

```bash
./install.sh          # macOS/Linux 一键安装（含覆盖确认），装完自动提示运行 /cm:check
```

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1   # Windows 版
```

或手动：

```bash
cp -r commands/* ~/.claude/commands/
cp -r skills/*   ~/.claude/skills/
cp -r agents/*   ~/.claude/agents/
```

安装/修改框架后运行 `/cm:check` 做一致性自检（角色存在性、命名一致、引用有效、配套完整、外部依赖 + **安装版本号**——反馈问题时请带上它）。

**Windows 说明**：核心工作流（commands/skills/agents）是纯 Markdown，Windows 原生可用；状态条 / 终端像素版 / serve.sh 是 bash+python3 脚本，在 WSL 或 Git Bash 中使用（浏览器像素版页面双击加 `?demo` 即可预览，不依赖脚本）。

## 执行可视化（终端原生优先）

**① 终端状态条（推荐,Claude Code 底部常驻）**——官方 statusLine 机制,零外部依赖：

```json
// ~/.claude/settings.json
"statusLine": {"type": "command", "command": "~/.claude/templates/cm-statusline.sh"}
```

效果：`⚙ ○○○●○○○○ N4 1.token-dashboard/T-005 · Codex复审第1轮`——八点节点条实时点亮；等人时整条变黄 `⏸ 等待人工`；数据来自 .cm-status.json（N1 写入 ~/.claude/cm-current-specs 指针定位）。

**② 内置任务清单镜像**——N2 进 feature 时任务自动镜像到 Claude Code 原生任务清单,N3/N5 同步状态,终端直接看勾选进度（无需配置）。

**③ 浏览器看板（备选,适合投屏/远程盯进度）**

```bash
templates/dashboard/serve.sh {specs路径}   # 浏览器打开提示的地址,2 秒自动刷新
```

**纯只读、零侵入**——只消费 specs 落盘文件（tasks.md 勾选 / METRICS / LESSONS），执行引擎无感知。展示：四项汇总指标、每 feature 进度条与任务状态（▶ 当前任务高亮）、METRICS 全表、LESSONS 时间线。/cm:ai 跑长任务时开一个浏览器标签盯进度即可。

**④ 像素流水线（2D 像素游戏视角,演示/氛围屏首选）**——8 个像素工位对应 N1–N8,小人走到哪一步流水线就跑到哪一步：需求箱→规划牌→控制台→审查机械臂(Codex 机器人)→服务器机架→质检齿轮机→物料桶→发射台。天空与地面材质随流水线推进从清晨草地渐变到夜晚工业区(分关卡换色,色彩即进度)；暂停时场景变暗+黄色对话框说大白话,全部完成打出 STAGE CLEAR+烟花。数据源与状态条同一个 .cm-status.json,零侵入。浏览器版精灵采用 Kenney Pixel Platformer 系列开源素材(CC0,已内嵌,单文件零依赖)。

```bash
templates/pixel/cm-pixel.sh            # 终端版(ANSI 像素,分屏挂一个 pane)
templates/pixel/cm-pixel.sh --demo     # 终端版演示模式(不需要真实运行)
templates/pixel/serve.sh {specs路径}   # 浏览器版(16-bit 风格,给老板演示/办公室大屏)
# 浏览器版演示模式: 打开地址后加 ?demo
```

## 度量与双保险

- **METRICS.md**（specs 目录，N5 自动落盘）：每任务记录审查轮次、Codex 拦截、QA 结果、人工介入次数——试点/灰度门槛的唯一数据源
- **templates/hooks/pre-commit-cm-task-check**：任务标记双保险 git hook（灰度阶段在代码仓库启用，防 N5 漏标记），默认仅警告，`CM_TASK_CHECK_STRICT=1` 时阻断

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
