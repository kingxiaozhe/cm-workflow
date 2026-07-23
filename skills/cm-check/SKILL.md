---
name: cm-check
description: 检查 CM Workflow 的 Codex 插件、核心 Skills、Claude 兼容包装、版本与模板引用；只报告，不自动修复。
---

# cm-check — 双运行时一致性自检

执行前读取 `../../runtime/project-context.md`。Codex 入口为 `$cm-check`；Claude Code 跨平台入口为 `/cm-check`，macOS/Linux 另有历史别名 `/cm:check`。

从当前 Skill 路径解析 `{CM_WORKFLOW_ROOT}`，先运行：

```bash
{CM_WORKFLOW_ROOT}/scripts/cm-check-runtime.sh
```

机械检查失败时，原样报告失败项并停止；通过后再做以下语义检查。

## 语义检查

1. **Codex 入口**：`.codex-plugin/plugin.json` 的 `skills` 指向 `./skills/`；`cm-idea/cm-init/cm-prd/cm-ai/cm-fix/cm-refactor/cm-check` 七个 Skill 均有合法 frontmatter。
2. **共享真相**：七个核心 Skill 引用 `runtime/` 合同；`compat/claude-commands/cm-*.md` 只是 macOS/Linux 旧入口薄包装，不再复制业务规则。
3. **流程链路**：`cm-ai` 的 N1–N8 引用全部存在；`cm-prd` 的 greenfield/brownfield/change-mode 全部存在；`cm-idea` 引用 `idea-to-prd`。
4. **角色链路**：N3 引用的 `cm-*-engineer/manager/expert` Skill 存在；Claude `agents/` 中每个兼容角色能找到对应工种 Skill。Codex 不依赖这些 `.md` agent 文件。
5. **状态与审查**：`.cm-specs-status`、`.cm-status.json`、`tasks.md`、`METRICS.md`、`LESSONS.md`、`运行日志.jsonl` 及 `.reviews/` 的生成方与消费方配对；N4 凭证头包含 reviewer/independent/task/round/at/scope。
6. **模板路径**：所有 `{CM_WORKFLOW_ROOT}/templates/...` 引用都对应真实文件，重点核对 `templates/rules/`、`templates/ui-lens/`、`templates/hooks/`、`templates/refactor/`。
7. **版本**：根 `VERSION` 与 plugin manifest 一致；README 不得宣称不存在的入口或安装路径。
8. **私有调用清零**：Codex 核心 Skill 不得残留 `TaskCreate`、`TodoWrite`、`codex:review`、`~/.claude/commands`；兼容包装中出现 `/cm:*` 是合法的 macOS/Linux 旧入口。

外部能力只做降级提示，不应导致插件自检失败：状态条、自动更新器、子代理或隔离 CLI 审查通道都是可选增强。

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
