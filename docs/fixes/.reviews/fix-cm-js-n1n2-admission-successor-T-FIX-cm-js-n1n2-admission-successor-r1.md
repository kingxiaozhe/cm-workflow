---
at: 2026-09-03T19:52:53-07:00
reviewer: codex-subagent
independent: true
task: T-FIX-cm-js-n1n2-admission-successor
attempt: 1
round: 1
verdict: changes_requested
blocking_findings: 1
handoff: fix-cm-js-n1n2-admission-successor-T-FIX-cm-js-n1n2-admission-successor-a1-handoff.json
handoff_sha256: bd3b5ddb6dcd3947a7735ca37bd9f65a1fa220a980d09378105c370ceb83d25f
scope:
  - experiments/js-orchestration/cm-ai-admission.mjs
  - experiments/js-orchestration/cm-ai-admission.test.mjs
  - experiments/js-orchestration/README.md
  - AGENTS.md
  - docs/fixes/20260903-cm-js-n1n2-admission-successor.md
---

# Fresh successor implementation Review R1

Reviewer thread：`01a06b2b-ef9e-7d03-b150-5282e3c48308`

## Finding

**Medium — Review 身份唯一性只检查去前缀 slug，没有检查实际匹配的完整别名集合。**

`cm-ai-admission.mjs:66` 只比较去掉首个数字前缀后的 slug 是否重复，但
`missingReviewIds()` 同时接受完整 feature 名和去前缀 slug。对抗输入：

- `1.login/T-001` 已完成；
- `2.1.login/T-001` 已完成；
- 只有 `.reviews/1.login-T-001-r1.md`。

两个 slug 分别是 `login` 和 `1.login`，当前唯一性检查通过；同一个证据却既作为
`1.login` 的完整名匹配，又作为 `2.1.login` 的 slug 匹配。实际错误返回
`complete/all_tasks_terminal` 且 `warnings: []`，第二个 feature 的欠账被消音。

建议保证所有实际匹配键——完整目录名和去编号 slug——全局无碰撞，或收紧 feature
后缀语法。现有重复 slug 用例没有覆盖跨别名碰撞。

## 已确认闭环

- 前任 R2 五类输入全部通过 focused tests。
- recorded 合同指向 specs 外：`spec_status_invalid`。
- legacy 合同指向相邻 feature：`test_cases_invalid`。
- `.reviews` 内外部文件 symlink 不计为证据，欠账 warning 保留。
- 没有扩大 AC、hardlink、通用 TOCTOU 或更广泛信任模型范围。

## 验证

- handoff 和五个目标文件审查前后哈希精确匹配。
- N4 通过并绑定 handoff `bd3b5dd...d25f`。
- focused 18/18、full Node 982/982、syntax/runtime/public/diff 通过。
- safety 仍精确为五个已知界外命中，没有 scoped 新项。
- reviewer 未修改仓库、创建凭证、提交、完成任务、安装或委派。

**Verdict: changes_requested**
