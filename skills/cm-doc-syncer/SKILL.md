---
name: cm-doc-syncer
description: 文档同步 Skill，开发完成后自动更新 README、.claude/ 配置、specs CHANGELOG，保持文档与代码一致
---

# cm-doc-syncer — 文档同步器

在所有开发任务完成后，自动同步更新项目文档。确保文档和代码保持一致。

## 触发条件

由 `/cm:ai` 在所有 feature 开发完成后自动调用。

## 输入

- specs 文件夹路径
- 代码项目路径（可多个）
- LESSONS.md 中积累的架构决策

## 执行步骤

### 1. 扫描变更

对每个代码项目，分析本次开发引入的变更：

- `git diff` 获取所有变更文件
- 识别新增的目录、模块、API、数据模型
- 从 specs 的 requirements.md 获取功能描述
- 从 LESSONS.md 获取架构决策和踩坑记录

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

检查变更中是否出现了新的模式或约定：

- 新建了 API 层 → 考虑创建 `rules/backend-api.md`
- 新建了数据库层 → 考虑创建 `rules/database.md`
- 新建了合约 → 考虑创建 `rules/smart-contract.md`
- 已有的 rules 中 globs 过时 → 更新路径

只在确实有新模块时才新增，不过度生成。

### 4.5 LESSONS.md 归档（防膨胀深井）

LESSONS.md 超过 {50} 条时执行归档：

- 与当前活跃 feature 无关的旧条目移入 `{SPECS_DIR}/LESSONS-archive.md`
- 主文件为每条归档条目保留一行摘要索引（`- {日期} {标题} → archive`）
- N1/N7 只加载主文件——上下文轮换的成本因此有上界；archive 仍在审计链内随时可查

### 5. 生成 specs CHANGELOG

在 specs 文件夹下按日期命名创建 CHANGELOG 文件，如 `CHANGELOG-2026-04-12.md`：

```markdown
# 变更日志 — 2026-04-12

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

## 输出

```text
📝 文档同步完成

README: {更新/新建} {N} 个项目
CLAUDE.md: {更新/无变化}
Rules: {新增 N 个 / 更新 N 个 / 无变化}
CHANGELOG: {N} 个 feature
一致性: {PASSED / 有 N 处已修复}
```
