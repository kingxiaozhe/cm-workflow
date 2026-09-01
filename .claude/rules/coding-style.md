---
description: Markdown prompt 与 Bash、Python、PowerShell、Node.js 工具的写作和命名约定
---

# 编码风格

本仓库的「代码」是给 AI 执行的 prompt。判断标准不是"读着优美"，而是**AI 照做不会产生歧义**。

## 量化标准

| 项 | 约束 |
| ---- | ---- |
| 新建或当前未超限的 `SKILL.md` | ≤400 行；接近上限时拆到 `references/` 按需加载 |
| 已超过 400 行的存量/收编 Skill | 不继续净增长；修改时优先下沉条件细节，第三方原貌文件除外 |
| `compat/claude-commands/*.md` | ≤8 行，只保留历史别名转发 |
| `.claude/CLAUDE.md` | ≤150 行 |
| 单条规则 | 3 行以内说清「做什么 + 为什么」 |
| 标题层级 | 4 层（`####`） |
| frontmatter description | 1 行 |

## 命名（强制，`/cm-check` 第 2 组机器校验）

| 对象 | 规则 | 示例 |
| ---- | ---- | ---- |
| 历史斜杠别名源 | `compat/claude-commands/cm-{动词}.md` | `cm-prd.md` |
| 流程节点 | `skills/cm-ai/references/N{1-8}-{kebab}.md` | `N3-execute-task.md` |
| 工种 skill | `skills/cm-{域}-{engineer\|expert\|manager}/SKILL.md` | `cm-backend-engineer/SKILL.md` |
| 子 agent | `agents/cm-{域}-agent.md` | `cm-backend-agent.md` |
| 独立工具 skill | 不带 `cm-` 前缀（不参与角色配对检查） | `codebase-context/` |

- **skill 的 frontmatter `name` 必须等于目录名；agent 的 `name` 必须等于文件名去 `.md`**。改名要同时改 frontmatter、目录/文件、以及 N2/N3 匹配表——漏一处即断链。
- 禁止残留旧前缀（`yd-`、`yd:`）。

## frontmatter

- `skills/*/SKILL.md` 与 `agents/*.md`：**必须**有 `name` + `description`。
- `compat/claude-commands/*.md`：**不写** frontmatter，保持 ≤8 行薄包装。

```markdown
<!-- Bad：description 写成用途分类，AI 无法据此判断该不该加载 -->
description: 后端相关

<!-- Good：说清「谁在什么时候派发、边界在哪」 -->
description: 后端 API 开发子 agent。由 /cm-ai 在并行执行后端任务时派发，负责流程纪律（任务边界、上下文、汇报、退出），具体开发规范由 cm-backend-engineer skill 提供。
```

## prompt 写作

- **可执行**：写具体指令，禁止「使用恰当的 XX」「合理处理」这类无法照做的话。
- **量化**：用数字不用形容词——「≤200 个源文件按七轮执行，>200 个改 Grep 收签名」而不是「项目较大时简化」。
- **分支穷举**：每个判断点把条件和结果显式列全，包括降级路径。
  ```markdown
  <!-- Bad：AI 得自己猜边界 -->
  文档目录存在时做增量扫描。

  <!-- Good：条件互斥且穷尽，含缺失元数据的兜底 -->
  - DOC_DIR 不存在 → 全量扫描
  - 带 --full 参数 → 全量扫描
  - DOC_DIR 存在 且 有 .scan-meta.json 且 无 --full → 增量扫描
  - DOC_DIR 存在 但 缺 .scan-meta.json → 全量扫描（元数据缺失视同首扫）
  ```
- **带实跑教训**：从 dogfood 得来的规则，用括号注明事故，别人才不会改掉它。例：「脏地图比没地图更危险（实跑教训：4 项目混装仓库靠人肉 cd 才扫对）」。
- **占位符**统一 `{中文描述}`；模板骨架用 HTML 注释写生成指引，注释在生成时删除。

## 排版

- 中文正文用全角标点；**commit 主题与代码/路径周围用半角**。
- 强调用 `**粗体**` 标关键约束，一节不超过 3 处——满篇加粗等于没加粗。
- 表格优先于长列表：匹配关系、映射表、检查项一律用表。
- 代码块必须标语言（`text` / `bash` / `markdown` / `json`）。

## Bash 脚本

- `#!/usr/bin/env bash` + `set -euo pipefail`。
- **目标是 macOS 自带的 bash 3.2**：禁用 4.0+ 特性（关联数组 `declare -A`、`${var^^}`、`readarray`）。
- **变量引用紧贴全角字符时必须加花括号**——这是真实事故（`fix: install.sh 变量名紧贴全角字符导致 bash 3.2 解析失败`）：
  ```bash
  # Bad：bash 3.2 把全角字符吃进变量名
  echo "已安装版本: v$VERSION，请运行自检"

  # Good
  echo "已安装版本: v${VERSION}，请运行自检"
  ```
- 路径变量一律加引号：`cp -R "$SRC_DIR/." "$DEST/"`。

## Python

- 保持 Python 3.9+ 与标准库可运行；安装器、自检和夹具不得为便利引入 PyPI 依赖。
- 使用 4 空格、`snake_case` 函数/变量、`PascalCase` 类、`UPPER_SNAKE_CASE` 常量；import 置于文件顶部。
- 路径使用 `pathlib.Path`；测试脚本用临时目录隔离文件系统副作用。

## PowerShell

- 保留 `$ErrorActionPreference = "Stop"`；函数用 `Verb-Noun`，变量沿用现有 `PascalCase`。
- Windows 路径通过 `Join-Path` 组合；调用外部命令后检查 `$LASTEXITCODE`。

## Node.js 工具

- 新工具使用 `.mjs` ESM 和 `node:` 内置模块前缀；根 `package.json` 是 Pi/BYZ package manifest，未经明确打包需求不得向其中增加 npm 依赖或 scripts。
- Playwright 不可用时明确报错或走 Skill 声明的降级路径，禁止静默伪造截图或验收结果。
