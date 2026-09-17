---
name: cm-runtime
description: 用户要查看或切换 CM 自动派发偏好、单/双 AI 声明、谁写谁审，或修改用户级运行时默认时使用。只管理运行时声明，不安装工具、不测试配额、不接管正在运行的任务。
---

# cm-runtime — 运行时声明

执行前读取 `../../runtime/project-context.md`、`../../runtime/workflow-config.md` 与
`../../runtime/logging.md`。Codex 入口 `$cm-runtime`；Claude Code 入口 `/cm-runtime`，
macOS/Linux 兼容别名 `/cm:runtime`。这是独立配置工具，不进入 N1–N8，不创建业务任务。

从当前 Skill 目录解析 `{CM_WORKFLOW_ROOT}`，按用户参数执行：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-runtime.mjs" show --project "{代码项目路径}"
node "{CM_WORKFLOW_ROOT}/scripts/cm-runtime.mjs" set codex-codes --project "{代码项目路径}"
node "{CM_WORKFLOW_ROOT}/scripts/cm-runtime.mjs" set --user claude-codes
node "{CM_WORKFLOW_ROOT}/scripts/cm-runtime.mjs" unset --user
```

- 无子命令的自然语言“看看配置”映射为 `show`；修改必须有明确预设/谁写谁审，缺失时仅询问这项。
- 四个预设为 `codex-only`、`claude-only`、`codex-codes`、`claude-codes`；映射以共享配置合同为准。
- `show` 只读，打印有效声明、预设、coder/reviewer adapter、source 与 `runtimes_source`；CLI 缺失只 WARN，可解析不证明配额可用。
- `set` 默认项目级；只修改 `runtimes.available` 与 coder/reviewer 的 adapter/source，其他原文保留；新文件从模板生成。校验失败不写。
- `set --user` 写 `~/.cm-workflow/runtimes.yml`（测试可用 `CM_WORKFLOW_HOME` 指定目录）；`unset --user` 删除该文件，不删除项目声明。
- 解析顺序：项目 > 用户级默认 > 未声明；项目显式角色字段保留，冲突阻断。用户默认仅在项目没有 `runtimes.available` 时读取。
- 成功 `set` 复用统一日志 writer 写 `decision/route`；日志使用独立 run id，不绑定 specs、不改已有 run 指针。`show` 不记日志。

报告命令原始结果、写入路径、预设与来源；失败报告原因。若提示“preference saved, decision log failed”，明确配置已写、日志未成功，不伪称完全成功。

只改变新 run 的自动派发偏好；已创建 run 绑定其原配置，本命令不修改它们。
不执行安装、不改 settings、CLAUDE.md、任务状态或审查证据，不联网、不调用模型、不探测配额。
