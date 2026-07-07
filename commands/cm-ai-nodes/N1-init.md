# N1: 初始化

1. 从 `$ARGUMENTS` 提取 **specs 文件夹路径** 和 **代码项目路径**（可多个）
2. 扫描 specs 下所有编号目录（`1.xxx/`、`2.xxx/`），按编号排列
3. 每个 feature 目录须含 requirements.md、design.md、tasks.md
4. 加载：代码项目的 `.claude/CLAUDE.md` + `.claude/rules/`
5. 加载 `{SPECS_DIR}/LESSONS.md`（架构决策和踩坑记录，开发时必须参考）
6. 验证各代码项目路径存在
