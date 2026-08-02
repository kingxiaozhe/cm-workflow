---
name: cm-check
description: 用户说“检查工作流是否安装正确”“为什么找不到 cm 命令”时使用。检查 CM 的 Codex 插件、核心 Skills、Claude 兼容包装、版本与模板引用；不测试业务功能、不自动修复。
---

# cm-check — 双运行时一致性自检

执行前读取 `../../runtime/project-context.md` 与 `../../runtime/logging.md`。Codex 入口为 `$cm-check`；Claude Code 跨平台入口为 `/cm-check`，macOS/Linux 另有历史别名 `/cm:check`。

从当前 Skill 路径解析 `{CM_WORKFLOW_ROOT}`。macOS、Linux、WSL 或 Git Bash
先运行：

```bash
{CM_WORKFLOW_ROOT}/scripts/cm-check-runtime.sh --project "$PWD" --print-effective
```

Windows PowerShell 先运行：

```powershell
& "{CM_WORKFLOW_ROOT}\scripts\cm-check-runtime.ps1" --project (Get-Location).Path --print-effective
```

如果配置文件不在项目根目录，可额外传 `--config {CONFIG_PATH}`；不传时会读取项目根
目录的 `.cm-workflow.yml` / `.yaml` / `.json`。

PowerShell 入口会优先使用 `CLAUDE_CODE_GIT_BASH_PATH` 或 Git for Windows 的
Bash 执行同一份检查；未找到时必须报告安装 Git for Windows 或改在 WSL
运行，不能跳过机械检查。

机械检查失败时，原样报告失败项并停止；通过后再做以下语义检查。

## 语义检查

1. **Codex 入口**：`.codex-plugin/plugin.json` 的 `skills` 指向 `./skills/`；`cm-idea/cm-init/cm-prd/cm-ai/cm-test/cm-fix/cm-refactor/cm-check` 八个核心 Skill 与独立 `external-expert` Skill 均有合法 frontmatter。
2. **共享真相**：八个核心 Skill 引用 `runtime/` 合同；`external-expert` 引用共享外部专家合同；`compat/claude-commands/cm-*.md` 只是 macOS/Linux 旧入口薄包装，不再复制业务规则。
3. **流程链路**：`cm-ai` 的 N1–N8 引用全部存在；`cm-prd` 的 greenfield/brownfield/change-mode 全部存在；`cm-idea` 引用 `idea-to-prd`；`cm-prd/cm-ai/cm-test/cm-qa-engineer` 共用 `runtime/test-contract.md`；`cm-prd/cm-ai/cm-test/cm-fix/cm-refactor/external-expert` 共用 `runtime/logging.md` 与统一 writer；`cm-test --generate-cases` 生成校验后的 inferred 草稿并硬停止。
4. **角色链路**：N3 引用的 `cm-*-engineer/manager/expert` Skill 存在；Claude `agents/` 中每个兼容角色能找到对应工种 Skill。Codex 不依赖这些 `.md` agent 文件。
5. **状态与审查**：`.cm-specs-status`、`.cm-status.json`、`.cm-run.json`、`tasks.md`、可选 `test-cases.json`、`METRICS.md`、`LESSONS.md`、`运行日志.jsonl` 及 `.reviews/` 的生成方与消费方配对；项目日志保持权威，全局日志只是私有可重建镜像；N4 凭证头包含 reviewer/independent/task/round/at/scope；`cm-fix` 收口前机械检查修后审查凭证；`.external/` 不得冒充 N4/N5 凭证。
6. **模板路径**：所有 `{CM_WORKFLOW_ROOT}/templates/...` 引用都对应真实文件，重点核对 `templates/rules/`、`templates/ui-lens/`、`templates/hooks/`、`templates/refactor/`。
7. **版本**：根 `VERSION` 与 plugin manifest 一致；README 不得宣称不存在的入口或安装路径。
8. **私有调用清零**：Codex 核心 Skill 不得残留 `TaskCreate`、`TodoWrite`、`codex:review`、`~/.claude/commands`；兼容包装中出现 `/cm:*` 是合法的 macOS/Linux 旧入口。

外部能力只做降级提示，不应导致插件自检失败：状态条、自动更新器、子代理、隔离 CLI
审查通道与 external-expert 浏览器 transport 都是可选增强。浏览器不可用时必须能输出
手工 handoff packet，不能把可选通道缺失报成核心运行时失败。

## 输出

```text
🔍 cm-check  (plugin v{X.Y.Z})
Codex 入口: {通过/失败}
Claude 兼容: {通过/失败}
流程与角色: {通过/断链清单}
状态与审查: {通过/断链清单}
模板与版本: {通过/不一致清单}
可选增强: {已配置/降级项}
结论: PASSED / FAILED ({N} 处)
```

只报告可复现的断链，不自动改文件。
