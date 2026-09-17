# 运行时声明来源

先执行共享解析器，不靠 CLI 可解析性猜用户可用配额：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-workflow-config.mjs" --project "{CODE_PROJECT}" --print-effective
```

任何配置错误（包括生效的用户级文件非法）都阻断生成；报告字段路径，不静默回退。
按返回的 `runtimes_source` 分支：

| 来源 | 动作 |
| --- | --- |
| `project` | 项目已有声明；selection 不带 runtimes，目标清单不含配置，不问不写，只记录 |
| `user` | 不再询问；读 `~/.cm-workflow/runtimes.yml`（`CM_WORKFLOW_HOME` 可覆盖目录），使用其中 available/preset 作为 `selection.runtimes`；报告 `来源: 用户级默认` |
| `none` | 问一次“你手上有哪个工具？Codex / Claude / 两个都有”；都有再问“谁写代码？Codex（推荐，另一家审）/ Claude” |

只有 Codex → `codex-only`；只有 Claude → `claude-only`；都有且 Codex 写 → `codex-codes`；
都有且 Claude 写 → `claude-codes`。预设映射以 `scripts/cm-workflow-config.mjs` 和
`templates/cm-workflow.yml` 为准。传入 `selection.runtimes: {available: "codex|claude|both", preset: "对应预设"}`。

用户默认只提供默认值，已有项目的显式角色字段优先；若其 adapter/source 与所选预设不同，
按已有宿主规则核验草稿，只填声明及 coder/reviewer adapter/source，保留其他原文。
无配置时从模板生成 `.cm-workflow.yml`；已有配置沿用 `.yml/.yaml/.json` 原文件名。
答案/默认值经宿主生成、共享解析器核验、必要确认和独立审查后写入，不在会话直接写配置。
声明同步到 AGENTS.md/CLAUDE.md，并注明来源。只决定自动派发偏好，不拦交互式使用；声明不等于派发。
