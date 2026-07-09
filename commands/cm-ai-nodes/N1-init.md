# N1: 初始化

1. 从 `$ARGUMENTS` 提取 **specs 文件夹路径** 和 **代码项目路径**（可多个）
2. 扫描 specs 下所有编号目录（`0.xxx/`、`1.xxx/`、`2.xxx/`），按编号排列
3. 每个 feature 目录须含 requirements.md、design.md、tasks.md
4. 加载：代码项目的 `.claude/CLAUDE.md` + `.claude/rules/`（0→1 项目此时可能尚不存在，跳过不报错）
5. 加载 `{SPECS_DIR}/LESSONS.md`（架构决策和踩坑记录，开发时必须参考）
6. 验证各代码项目路径存在，**空目录按信号处理**：
   - 空目录 + specs 含 `0.bootstrap` → 0→1 已在规格期人工确认，直接执行
   - **空目录 + specs 无 `0.bootstrap` → 矛盾信号，必须暂停询问**：specs 是按存量项目生成的，但目录是空的——"需要先 clone 项目？（clone 完成后回复继续）还是这就是新项目？（specs 上下文有毒，需重跑 /cm:prd 走 0→1 分支）"两种回答都不得跳过：clone 场景等用户，重跑场景中止
   - **非空目录 + `0.bootstrap` 存在且其脚手架任务（T-001）未完成 → 矛盾信号，必须暂停询问**：规格期确认的是 0→1，但目录里已有项目（用户事后 clone 了？）——"继续 0→1 会在现有项目上覆盖生成脚手架。是改用现有项目？（需重跑 /cm:prd 按存量项目生成规格）还是目录内容可弃、继续 0→1？"不确认不得执行 T-001

## Git 前置检查（字段优先，询问兜底）

**先读 CLAUDE.md 的「版本控制」字段**（/cm:init 或 bootstrap 已确认并落盘）：

- `remote` / `local` → 按常规执行每任务提交，不询问
- `none` → 直接进入 **NO_GIT 降级模式**，不询问：N5 跳过 git 提交（METRICS 备注 `no-git`）、doc-syncer 用文件扫描替代 git diff、hook 不适用、审计链降级为 METRICS + tasks 勾选

**字段不存在时**（项目未经 init 的兜底路径）：

- 有 git 仓库 → 继续，并建议补跑 /cm:init
- 无仓库但存在 `0.bootstrap/` 且任务含脚手架/git init → 跳过询问，交给 T-001
- 无仓库且非上述 → 问一次"git init？（推荐）/ 不使用版本控制"，**答案由主流程回写 CLAUDE.md 版本控制字段**（决策落盘，任何后续运行不再询问）

## 0.bootstrap 优先规则

存在 `0.bootstrap/` 且其中有未完成任务 → **无条件最优先执行**，完成前不进入任何业务 feature。它落地项目骨架和 `.claude/` 规范；完成后进入下一个 feature 时，N7 的重载机制会自然带上新生成的 CLAUDE.md 和 rules。
