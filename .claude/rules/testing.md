---
description: 本仓库的验证方式——/cm-check 一致性自检 + dogfood 实跑，无单元测试框架
---

# 测试规范

**本仓库没有单元测试框架，也不需要引入**——prompt 资产没有可断言的函数返回值。质量门是机械检查、安装冒烟和相关路径 dogfood。

## 框架与命令

| 层 | 手段 | 命令 |
| ---- | ---- | ---- |
| 一致性检查（机器） | `./scripts/cm-check-runtime.sh` | 双运行时引用与版本 |
| 公开包检查（机器） | `python3 scripts/validate-public-repo.py` | 文档、manifest、frontmatter |
| 安全检查（机器） | `python3 scripts/scan-public-safety.py` | 当前树；CI 另跑 Gitleaks |
| Shell 兼容夹具 | `bash scripts/test-shell-compat.sh` | Python 命令回退与提交 Hook |
| Workflow 配置夹具 | `python3 scripts/test-workflow-config.py` | 默认值、角色来源与脱敏 |
| 任务门禁夹具 | `python3 scripts/test-task-gate.py` | handoff、Review 状态转换与 Worktree 隔离 |
| 角色路由夹具 | `./scripts/cm-check-runtime.sh --routing-fixtures` | 外部专家路由与降级顺序 |
| 插件验证（机器） | Codex plugin creator validator | 本机 Codex |
| 端到端验证（人） | dogfood 实跑 | `/cm-prd` → `/cm-ai` 跑真实项目 |
| 安装冒烟 | 装完看输出无报错 | `./install.sh` |
| 覆盖率 | **不适用** | — |

## /cm-check —— 改完必跑

**修改 `compat/`、`skills/`、`agents/` 下任何文件后，提交前必须跑
`./scripts/cm-check-runtime.sh`；在已安装运行时再执行 `$cm-check` 或 `/cm-check`。**

它覆盖五组，全是历史上真实出过的断链：

1. **角色存在性**——N2/N3 匹配表引用的角色文件存在；反向查孤儿角色（建了没接线）
2. **命名一致性**——frontmatter `name` == 目录名/文件名；无旧前缀残留
3. **命令引用有效性**——`/cm-*`、兼容别名、N1–N8、模式文件、Skill 互引全部可达
4. **配套完整性**——agent↔skill 成对、README 计数与实际一致、rules 引用有生成方、凭证/审批位路径两两配对
5. **外部依赖 + 版本一致性**——Codex 探测、statusLine 配置、`cm:check` 基线号 == `cm-VERSION`

## 改动类型 → 必做验证（映射表）

| 改了什么 | 必做 |
| ---- | ---- |
| 新增/重命名 skill 或 agent | `/cm-check`；同步 N2/N3 匹配表 + README 目录树与计数 |
| 改 N1–N8 节点 | `/cm-check`；跑一遍受影响节点的 dogfood |
| 改 `templates/rules/` 骨架 | 在一个真实项目跑 `/cm-init`，确认生成的 rules 无残留 `{占位符}` 和模板注释 |
| 改 `install.sh` / `install.ps1` | 真装一次；确认覆盖确认提示、`cm-VERSION` 落盘正确 |
| 发版（升 VERSION） | 同步 `.codex-plugin/plugin.json` 基础版本；cachebuster 不算语义版本 |
| 改 bash 脚本 | `bash scripts/test-shell-compat.sh`；并在 macOS 自带 bash 3.2 下实跑：`/bin/bash script.sh` |
| 改可视化模板 | `cm-pixel.sh --demo` / 浏览器加 `?demo` 预览 |

## dogfood 实跑

新增或改动流程节点后，拿真实项目跑通 `/cm-prd` → `/cm-ai`。历史上 v0.9.1、v0.9.7、v0.9.8 等多个版本的修复全部来自 dogfood——**改流程不实跑，等于没测**。

实跑发现的问题落两处：修进对应 prompt 文件，**并在该规则旁用括号注明事故**，防止后人当成冗余删掉。

## 禁止

- 禁止为 prompt 资产引入 Jest/Vitest/pytest 等测试框架——没有被测对象，只会增加维护面。
- 禁止「改完看着没问题就提交」——引用断链靠肉眼看不出来，这正是 `/cm-check` 存在的原因。
- 禁止跳过 dogfood 直接发版。
