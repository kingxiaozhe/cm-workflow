# 已审批规格被执行勾选误判为漂移

## 现象

真实需求按 CM PRD → CM AI 跑完后，功能测试已经通过，但再次进入流程时
`cm-spec-manifest.py` 报告：

```text
cm-spec-manifest: approved spec manifest does not match current spec files
```

对比后确认，规格内容没有变化；只有 N5 把 `tasks.md` 中完成的任务从 `[ ]`
写成 `[x]`，N6 把 `requirements.md` 中通过的 AC 从 `[ ]` 写成 `[x]`。

## 根因

审批 manifest 原先对规格文件做逐字节 SHA-256。任务和 AC 的完成勾选既是 CM
运行时的权威状态，又位于受审批保护的规格文件中，因此正常执行会让自身制造
manifest 漂移。

## 红灯证据

行为夹具先锁定两类失败：

1. 普通 `T-*` / `AC-*` 完成后，旧实现返回 mismatch；
2. 第一版简单正则会把 fenced code 和四空格缩进代码里的示例也归一化，导致
   示例内容变化错误地返回 matched。

真实项目复现使用：

```text
/Users/zero/MyCode/cm-workflow-e2e-real/specs
```

## 修法

manifest schema 保持为 v1，只调整计算摘要前的语义规范化：

- 仅在 `tasks.md` 正文中把标准 `T-*` 完成标记规范化为 `[ ]`；
- 仅在 `requirements.md` 正文中把标准 `[AC-*]` 完成标记规范化为 `[ ]`；
- fenced code、四空格或 Tab 缩进代码完全按原始字节参与哈希；
- 普通 checklist、ID、文案、设计与测试用例仍按原内容参与哈希。

初始规格本来就是 `[ ]`，因此已有 `.cm-specs-status` 中的 raw SHA-256 无需迁移。

没有引入 manifest v2、额外状态文件或每次勾选后重写审批凭证；这些做法会增加
双重状态和迁移成本，不符合本次最小修复边界。

## 波及面

- `scripts/cm-spec-manifest.py`：摘要规范化；
- `scripts/test-spec-manifest.py`：行为与回归夹具；
- N1、PRD、测试契约、架构和用户指南：同步 manifest 语义说明；
- 不改变 `.cm-specs-status` schema、任务状态权威来源或审批流程。

## 回归结果

- `python3 scripts/test-spec-manifest.py`：PASSED；
- 真实 dogfood manifest：`status: matched`；
- `./scripts/cm-check-runtime.sh`：PASSED；
- `bash scripts/test-shell-compat.sh`：PASSED；
- public repository validation：PASSED；
- public safety scan：PASSED；
- 官方 Codex plugin validator：PASSED；
- Python 3.9 compile 与 `git diff --check`：PASSED；
- 独立审查：第 1 轮 1 项已修正，第 2 轮 approved。

审查凭证：

- `.reviews/fix-manifest-runtime-checkbox-drift-r1.md`
- `.reviews/fix-manifest-runtime-checkbox-drift-r2.md`
