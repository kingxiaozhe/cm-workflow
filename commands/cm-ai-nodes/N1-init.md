# N1: 初始化

1. 从 `$ARGUMENTS` 提取 **specs 文件夹路径** 和 **代码项目路径**（可多个）
2. 扫描 specs 下所有编号目录（`0.xxx/`、`1.xxx/`、`2.xxx/`），按编号排列
3. 每个 feature 目录须含 requirements.md、design.md、tasks.md
4. 加载：代码项目的 `.claude/CLAUDE.md` + `.claude/rules/`（0→1 项目此时可能尚不存在，跳过不报错）
5. 加载 `{SPECS_DIR}/LESSONS.md`（架构决策和踩坑记录，开发时必须参考）
6. 验证各代码项目路径存在（存在 `0.bootstrap` 时允许为空目录）

## Git 前置检查

验证代码项目路径时同时检测 git 仓库：

- 已有仓库 → 继续
- 无仓库但存在 `0.bootstrap/` 且其任务含脚手架/git init → **跳过询问**，git 初始化由 T-001 完成（实跑验证：此场景下询问是重复动作）
- 无仓库且非上述情形 → **只问一次**："是否执行 git init？（推荐——每任务提交、审计链、版本保护依赖它）"
  - 同意 → `git init` 后继续
  - 拒绝 → 全程进入 **NO_GIT 降级模式**：N5 跳过 git 提交（METRICS 备注 `no-git`）、N8 的 doc-syncer 用文件扫描替代 git diff。**此后不再就 git 事宜打扰用户**

## 0.bootstrap 优先规则

存在 `0.bootstrap/` 且其中有未完成任务 → **无条件最优先执行**，完成前不进入任何业务 feature。它落地项目骨架和 `.claude/` 规范；完成后进入下一个 feature 时，N7 的重载机制会自然带上新生成的 CLAUDE.md 和 rules。
