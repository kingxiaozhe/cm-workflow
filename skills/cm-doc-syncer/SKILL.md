---
name: cm-doc-syncer
description: 文档同步 Skill，开发完成后自动更新 README、.claude/ 配置、specs CHANGELOG，保持文档与代码一致
---

# cm-doc-syncer — 文档同步器

在所有开发任务完成后，自动同步更新项目文档。确保文档和代码保持一致。

## 触发条件

由 `/cm-ai` 在所有 feature 开发完成后自动调用。

## 输入

- specs 文件夹路径
- 代码项目路径（可多个）
- LESSONS.md 中积累的架构决策

## 执行步骤

### 1. 扫描变更

对每个代码项目，先读其 CLAUDE.md「版本控制」字段，按值选变更识别方式（显式分支，不得自行发明）：

- `remote` / `local` → `git diff {基线}..HEAD` 获取变更文件。基线按序尝试：① 上一份 CHANGELOG 头部记录的 `base-commit`（见步骤 5）→ ② 无则取首个 scaffold/初始 commit → ③ 仍无法确定则按全量文件清单处理，并在输出中注明「基线不明，按全量」
- `none` 或项目无 `.git` → **降级为文件扫描**：遍历源码目录，结合 specs 各 feature 的 tasks.md 勾选项反推本次变更集（与 cm:init 的 none 降级约定对齐）
- 字段缺失但有 `.git` → 按 `local` 处理

随后（与版本控制方式无关）：

- 识别新增的目录、模块、API、数据模型
- 从 specs 的 requirements.md 获取功能描述；requirements.md 缺失 → 该 feature 跳过描述提取并在最终输出中上报「specs 不完整」，不得凭 tasks.md 猜功能描述
- 从 LESSONS.md 获取架构决策和踩坑记录；文件不存在 → 按 0 条处理，不报错不中断

### 2. 更新 README.md

对每个代码项目的 README 进行精炼更新：

**必须覆盖：**

- **项目简介** — 一句话说清楚是什么
- **架构概览** — 技术栈、目录结构、核心模块关系
- **快速开始** — 安装、配置环境变量、运行的最少步骤
- **功能模块** — 各模块简述，本次新增的功能标注
- **API/接口** — 关键接口说明（如有后端）
- **合约地址** — 部署的合约信息（如有合约）
- **部署** — 构建命令、部署方式、环境要求

**原则：**

- 精炼，开发者能在 2 分钟内理解项目全貌
- 已有的 README 合理内容保留，只更新/补充变更涉及的部分
- 如项目没有 README → 新建完整版
- 不写废话，不放过时信息

### 3. 更新 .claude/CLAUDE.md

检查变更是否影响项目结构，保持 ≤150 行：

- 新增了目录 → 更新「目录结构」
- 新增了常用命令 → 更新「常用命令」
- 引入了新技术栈 → 更新「技术栈」
- 新增了 rules 文件 → 更新引用列表

### 4. 更新 .claude/rules/

检查变更中是否出现了新的模式或约定，按下表判据决定（满足才建，不满足不建，无中间态）：

| 变更特征 | 动作 |
| ---- | ---- |
| 新增 ≥2 个路由/接口文件（如 `src/api/**`） | 创建 `rules/backend-api.md` |
| 新增 migration 目录或 ORM 配置 | 创建 `rules/database.md` |
| 新增 `contracts/**` 或合约框架配置 | 创建 `rules/smart-contract.md` |
| 仅模型/工具文件、无 ORM | 约定并入最近的既有 rules，不另建 |
| 已有 rules 的 globs 与实际目录不符 | 更新 globs 路径 |

新建 rules 一律从当前 Skill 向上解析 workflow root，使用 `{CM_WORKFLOW_ROOT}/templates/rules/{名称}.md` 骨架（frontmatter 含 description + globs），模板不存在则参照项目内既有 rules 的格式。

本步完成后**回到步骤 3 回填** CLAUDE.md 的 rules 引用列表（步骤 3 执行时 rules 尚未定稿，引用列表以本步结果为准）。

### 4.5 LESSONS.md 归档（防膨胀深井）

LESSONS.md 超过 50 条时执行归档：

- 归档判据（按序适用）：① 条目带 feature 标签且标签不属于当前活跃 feature → 归档；② **横切/全局决策**（不属于任何单一 feature 的约定，如"统一用 pnpm"）→ 豁免，留在主文件；③ 无标签且无法判断归属 → 留在主文件（宁留勿丢）
- 归档条目移入 `{SPECS_DIR}/LESSONS-archive.md`（全文保留）
- 主文件索引**按 feature 聚合为一行**（`- {feature名} {N} 条 → archive`），不逐条留行——逐条索引会让主文件列表项总数不降，归档失去防膨胀意义
- N1/N7 只加载主文件——上下文轮换的成本因此有上界；archive 仍在审计链内随时可查

### 5. 生成 specs CHANGELOG

在 specs 文件夹下创建 CHANGELOG 文件，文件名日期取**执行同步的当日**（不是 feature 提交日），如 `CHANGELOG-2026-04-12.md`；同日重复执行则覆盖更新同名文件：

```markdown
# 变更日志 — 2026-04-12

> base-commit: {本次同步时的 HEAD hash；版本控制 none 的项目写 none}   # 下次同步的 diff 基线，步骤 1 读取

## Feature 1: {feature名}

### 新增
- {功能描述}

### 关键文件
- `{path}` — {说明}

### 架构决策
- {从 LESSONS.md 中提取的相关决策}

## Feature 2: {feature名}

...
```

多次开发产生多个日期文件，形成完整的变更历史。

### 6. 验证文档一致性

最后检查：

- CLAUDE.md 中引用的 rules 文件都存在
- rules 中的 globs 与实际目录匹配
- README 中的命令与 package.json / Makefile 一致
- 环境变量文档与 `.env.example` 一致

发现不一致时按两态处理（修复方向一律**以代码/配置为准改文档**，不得反向改代码）：

- **只改文档就能一致**（如 README 写错命令、CLAUDE.md 引用了不存在的 rules）→ 修复并计数
- **需要改代码/配置/新建非文档文件才能一致**（如 `.env.example` 缺失、脚本指向不存在的文件）→ **不修**，在输出「一致性」行报「发现 N 处待人工」——doc-syncer 无权创建或修改文档之外的任何文件

## 禁止（红线，违反任何一条即任务失败）

- **不得虚构**：接口、命令、合约地址、环境变量只写代码或 specs 中实际存在的；桩实现/空函数按 specs 口径描述时必须注明「以 specs 为准，实现未完成」
- **不得删除用户手写内容**：README 中无法从代码/specs 再生的段落（徽章、致谢、许可、手写背景说明）一律原样保留，更新只增改与变更相关的部分
- **不得触碰文档之外的文件**：代码、配置、`.env*`、CI 一律只读；发现问题只上报「待人工」，不代修
- **归档不得丢条目**：归档前后条目总数必须守恒（主文件活跃条数 + archive 条数 = 原总数），执行后自查一次
- **代码与 specs 不符时不得按 specs 想象功能**：以代码实际行为为准描述，差异作为「待人工」写入 CHANGELOG 上报

## 输出

```text
📝 文档同步完成

README: {更新/新建} {N} 个项目
CLAUDE.md: {更新/无变化}
Rules: {新增 N 个 / 更新 N 个 / 无变化}
CHANGELOG: {N} 个 feature
一致性: {PASSED / 有 N 处已修复 / 发现 N 处待人工}   # 三态可并存，如「2 处已修复,1 处待人工」
```
