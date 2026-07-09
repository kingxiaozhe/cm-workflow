---
description: {一句话：本项目的分支与提交约定}
---

<!-- 模板骨架 · 生成时从 git 历史推断实际风格，{占位符} 结合项目填充。
     按 CLAUDE.md 版本控制字段裁剪：none → 不生成本文件；local → 删除 PR/合入 与 保护分支 相关内容，只留 commit 规范 -->

# Git 工作流

## 分支

- 命名：{feature/xxx、fix/xxx——从现有分支推断}
- 保护分支：{main/master}，禁止直接 push
- 合并方式：{squash / merge commit / rebase——从历史推断}

## Commit

- 风格：{conventional commits（feat/fix/chore…）或项目实际风格，附 3 个历史真实示例}
- 一次 commit 一个逻辑变更；禁止 "wip"、"fix" 这类无信息量消息
- {是否要求关联 issue/任务编号，如 "feat: xxx (T-003)"}

## PR / 合入

- PR 描述：{模板位置或最低要求}
- 合入前置：{CI 通过 / review 通过 / 覆盖率不降}
