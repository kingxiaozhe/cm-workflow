---
description: 分支、commit 与发版约定（remote: git@github.com:kingxiaozhe/cm-workflow.git）
---

# Git 工作流

## 分支

- 保护分支：`main`（唯一长期分支，remote `origin`）
- 特性分支：`feature/{简述}`、`fix/{简述}`；历史多为直接在 main 上迭代，**新协作者走分支 + PR**
- 合并方式：squash（保持一版一 commit 的线性历史）

## Commit

两种主题格式，按性质二选一：

| 性质 | 格式 | 真实示例 |
| ---- | ---- | ---- |
| 发版（框架能力变动） | `v{X.Y.Z}: {中文描述}` | `v0.9.22: 新增 /cm:idea 命令(点子→PRD 访谈入口)` |
| 非发版（文档/修复） | `{docs\|fix}: {中文描述}` | `fix: install.sh 变量名紧贴全角字符导致 bash 3.2 解析失败` |

- 主题内**用半角标点**（`(` `,` `/`），正文可用全角
- 一次 commit 一个逻辑变更；禁止 `wip`、`fix` 这类无信息量消息
- 描述要能独立看懂——写「改了什么能力」，不写「改了几个文件」

正文用要点列出实质变动，保留 trailer：

```text
v0.9.23: 收编 darwin-skill 技能优化器(MIT,alchaincyf/darwin-skill)

- 9 维评分 rubric + 受控进化循环(棘轮:升分保留/退分回滚) + 人类守关三层,
  用途:给本仓库 skills/ 做质量体检与迭代优化
- 独立工具 skill 定位,不进 N1-N8,不被任何命令依赖
- 移植性修补 2 处(见 NOTICE.md)
- 约定沿用:每收编一个 skill 升一版

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```

## 发版（升 VERSION 时的强制清单）

版本号是**双写**的，两处基础版本必须同步递增：

1. `VERSION` 文件
2. `.codex-plugin/plugin.json` 的 `version`（安装时可附加 `+codex.*` cachebuster）

配套：

- 收编一个新 skill → 升一个 patch 版（既有约定）
- README 的目录树、角色计数、版本相关说明同步更新
- 提交前跑 `./scripts/cm-check-runtime.sh` 与 `python3 scripts/validate-public-repo.py`
- 从干净 checkout 升版或修改 `package.json`、`.codex-plugin/`、`install-codex.sh` 时，运行 `./scripts/cm-release-smoke.sh`；它校验 Pi manifest、用 BYZ 检查本地 workflow root，并在一次性 HOME 中真实安装 Codex plugin

## 提交前

- [ ] 动过 `compat/` `skills/` `agents/` → `cm-check-runtime.sh` PASSED
- [ ] 动过流程节点 → dogfood 实跑过
- [ ] 动过 `install.sh` → 真装过一次
- [ ] 动过 Pi/BYZ 或 Codex 分发面，或升了 VERSION → `cm-release-smoke.sh` PASSED；缺 BYZ/Codex 时记为 BLOCKED，不得拿源码检查冒充安装证据
- [ ] 升了 VERSION → plugin manifest 基础版本已同步
- [ ] 新增了跨文件配对(模板/凭证/落盘物的生成方↔消费方)→ cm:check 配套完整性已补检查项(检查者不自动进化,靠这一条)
- [ ] 无真实密钥、无未脱敏的内部项目名

## PR

- 描述写清：改了哪个环节、为什么改（若来自 dogfood，附事故现象）、影响哪些角色文件
- 合入前置：`/cm-check` PASSED + 至少一次相关路径的实跑记录
