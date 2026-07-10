# /cm:check — 框架一致性自检

校验 cm 工作流安装的完整性和引用一致性。**每次修改框架文件后运行一次**——历史上的缺陷（改名残留、匹配表缺项、死角色、失效命令引用）全属"引用断链"类，本命令将其机器化检查。

## 检查项

### 1. 角色文件存在性

- `~/.claude/commands/cm-ai-nodes/N3-execute-task.md` 匹配表中引用的每个 `cm-*-engineer` / `cm-*-expert` / `cm-*-manager` → `~/.claude/skills/{名称}/SKILL.md` 必须存在
- `N2-enter-feature.md` 预定义角色列表中的每个 `cm-*-agent` → `~/.claude/agents/{名称}.md` 必须存在
- 反向检查：skills/ 与 agents/ 下存在、但 N2/N3 均未引用的角色 → 报告为"孤儿角色"（建了没接线）

### 2. 命名一致性

- 每个 `skills/*/SKILL.md` 的 frontmatter `name` 必须等于其目录名
- 每个 `agents/*.md` 的 frontmatter `name` 必须等于其文件名（去 .md）
- 全部文件中不得残留旧前缀（如 `yd-`、`yd:`）

### 3. 命令间引用有效性

- 所有文件中出现的 `/cm:{命令}` 引用 → `commands/cm:{命令}.md` 必须存在
- 所有文件中出现的节点引用（N1–N8）→ `commands/cm-ai-nodes/` 下对应文件必须存在
- skill 之间的互相引用（如"→ cm-database-engineer"）→ 目标必须存在

### 4. 配套机制完整性

- agent 与同工种 skill 成对：每个 `cm-X-agent` 必须有其加载的 skill
- README 中的角色计数、目录树条目与实际文件一致
- cm:prd 任务模板引用的产物（design-baseline、METRICS.md、RELEASES.md）在对应节点/skill 中有生成方
- **rules 引用有生成方**：任何 skill/命令中引用的 `rules/{名称}.md`，必须在 cm:init 的「规则内容指引」（或 bootstrap 模板）中有对应生成条目——skill 读一个永远不会被生成的规则文件即为断链
- **规则指引与模板配对**：cm:init「规则内容指引」中的每个条目 ↔ `~/.claude/templates/cm-rules/{名称}.md` 模板文件一一对应；缺模板报告为降级项（可运行但生成质量不稳定），多出的孤儿模板报告为未接线

### 5. 外部依赖可用性

- **Codex（审查主通道）**：`codex --version` 探测。不可用报告为降级项并给出后果说明——N4 将落到对抗式子代理（次优），N1 开跑前还会再拦一次
- 状态条已配置（settings.json 的 statusLine 指向 cm-statusline.sh）：未配置报告为提示项（不影响运行，仅少可视化）

## 输出格式

```text
🔍 cm:check 一致性自检

角色存在性:   {N} 项检查 · {通过/断链清单}
命名一致性:   {N} 项检查 · {通过/不一致清单}
命令引用:     {N} 项检查 · {通过/失效清单}
配套完整性:   {N} 项检查 · {通过/缺失清单}
外部依赖:     {N} 项检查 · {Codex 可用/降级 · 状态条 已配/未配}

结论: PASSED / {N} 处断链（逐条列出：文件:位置 → 期望 → 实际）
```

发现断链只报告不自动修——修复由人确认后执行。
