# N8: 完成

所有 feature 的所有任务完成后：

## 1. 调用 cm-doc-syncer

调用 `cm-doc-syncer` skill 完成文档同步：

- README 精炼更新（架构 + 业务 + 快速开始）
- `AGENTS.md` 与 `.claude/CLAUDE.md` / rules 兼容文档同步
- specs CHANGELOG 按日期生成
- 文档一致性验证

## 1.5 代码库参考文档回写（存在时强制）

`{项目根}/docs/codebase-context/` 存在时（skill 未安装但文档在 → 按 skill 文内的回写映射表手动执行，映射表就在文档同目录项目里；两者都无 → 跳过本步），按 `codebase-context` skill dev 模式步骤 3 的「变更类型 → 需更新文档」映射表，把本次全部 feature 的变更回写进参考文档（09-changelog 类型标 `dev回写`）——**地图必须跟着代码走，否则下次二开按过期地图改**。

## 1.7 最终工作树与交付策略

对每个代码项目分别回读有效 `DELIVERY_MODE`，执行 `git diff --check` 并核对 N8 新变更：doc-syncer 只能
产生文档/specs 元数据；若出现源码、配置或依赖变更，说明有修改绕过任务审查，立即
`BLOCKED`。然后按唯一分支收口：

- `diff`：不 commit、不 push、不创建 MR；输出基线 SHA、`git diff --stat` 和完整
  diff 位置。工作树 dirty 是预期交付，但不得含开工前用户改动之外的范围外文件。
- `branch`：显式 stage N8 生成的文档/specs 文件，`git diff --cached --check` 后补一条
  `docs: sync CM workflow artifacts` 提交；确认工作树只剩开工前用户改动。停在本地分支。
- `draft-mr`：先完成 branch 收口，再逐仓库展示 remote、branch、目标分支和将执行的 push/MR
  命令，**取得本次明确授权**后才执行。GitHub 使用 `gh pr create --draft`，GitLab 使用
  `glab mr create --draft`；CLI/remote/权限缺失则 `BLOCKED` 并保留本地分支。push 与
  MR 各自成功后才写 `delivery/push`、`delivery/pull_request`，不得以配置代替授权或
  伪造远端结果。

branch/draft-mr 在写 `run_done` 前必须确认每个代码仓库的 CM 变更已全部进入可回溯
commit；diff 模式则逐仓库确认没有新 commit。specs 位于代码仓库外时单独报告其落盘
路径，不尝试从代码仓库 stage 跨仓库文件。该门禁防止 doc-syncer 在“全部完成”之后
留下未交付变更。

## 2. 生产发布待决清单

**前置**：项目存在部署或平台发布形态才执行本步。信号包括 Dockerfile / CI 配置 /
部署脚本、`{SPECS_DIR}/RELEASES.md`，以及已确认的 App/微信小程序交付形态（小程序可
由 `project.config.json` + `app.json` 或跨端微信构建目标识别）。**纯本地工具、库等
无发布形态的项目 → 跳过**，总结中输出一行 `🚀 发布清单: 跳过(无发布形态)`。

调用 `cm-devops-engineer` skill **编制**（只编制，不执行生产发布）。**staging 验证状态的数据源是 `{SPECS_DIR}/RELEASES.md`**，不凭记忆：

- 已通过 staging 验证的 feature 清单及版本（读 RELEASES.md）
- 生产迁移清单与执行顺序（含备份点）
- 新增环境变量清单（值由人在生产环境配置）
- 回滚预案位置

微信小程序另外读取 `../../cm-miniprogram-engineer/references/release-checklist.md`：
即使尚未上传体验版，也要编制主体/类目、隐私权限、域名环境、L1–L3 证据和提审材料
待决项；`RELEASES.md` 不存在时明确写“体验版未上传”，不得把 N6 模拟器结果伪装成
staging/体验版验证。

**生产发布由人决策触发**，不属于本流程的自动动作。

## 3. 度量汇总

读取 `{SPECS_DIR}/METRICS.md`，**只统计本次执行涉及的 feature 的行**（按 Feature 列过滤——防止历史批次数据混入本次门槛对照），全量历史另起一行标注"累计"。输出：

```text
📊 度量汇总
任务: {N} 个 | 人工介入均值: {x} 次/任务 | 一次通过率(复审仅1轮): {x}%
独立审查拦截: 共 {N} 条 | QA: 触发 {N} 次/通过 {N} | 总耗时: {x}
💰 成本: 从当前运行时的 usage/成本面板取得；不可用则记「未采集」
```

**审查凭证对账**：tasks.md 全部 `[x]` 任务 ↔ `{SPECS_DIR}/.reviews/` 凭证一一对账，缺失项列入度量汇总（`⚠ 审查凭证缺失: T-xxx,...`，全齐则 `审查凭证: {N}/{N} 齐`）——中途漏网的审查，收尾必须暴露，不许无声混过。

**临时资源对账**：读取当前 run 的项目权威日志，按 `resource_id` 对账
`resource/acquired`、`resource/released` 与 `resource/cleanup_failed`。只有同一
资源最后状态为 `released` 才算闭环；存在未释放或清理失败资源时输出清单、将状态
改为 BLOCKED，并且**不得写 `run_done`**。没有 resource 事件的历史运行保持兼容。

**运行日志收口**：按 `../../../runtime/logging.md` 写 `run_done` 终态事件，使项目日志与
全局索引同时收口；然后报告 `运行日志.jsonl`、全局 run 文件路径与项目日志行数。
提醒用户反馈问题时连同 METRICS.md 一起带回，只报告，不清理不截断。

**成本落盘（灰度门槛「单任务成本 < 人工工时」的数据源）**：如果当前 Codex/Claude 界面提供 usage 或会话费用，将总费用与总耗时写入 `{SPECS_DIR}/度量汇总.md`（`成本: ${x} / {N} 任务 ≈ ${x/N} 每任务`）；无法获得就标注 `成本: 未采集`，不许编造。

## 4. 输出总结

```text
🎉 全部完成

📂 Features: {完成数}/{总数}
📋 总任务: {完成数}/{总数}
📝 文档同步: 已完成
🚀 生产发布待决清单: 已编制，等待人工决策

各 Feature 摘要:
- 1.{name}: {N} 个任务 ✅ (发布验证: {staging/体验版已验证 | 未执行/待人工 | 不适用})
- 2.{name}: {N} 个任务 ✅ (发布验证: {staging/体验版已验证 | 未执行/待人工 | 不适用})
```
