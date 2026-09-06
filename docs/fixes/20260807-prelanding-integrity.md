# Pre-landing integrity closure

## 现象

模型用量与调用边界的第一轮修复通过了聚焦测试，但落地前复审发现四个完整性问题：

1. 审查只绑定 handoff 文件，没有绑定被审实现内容，且当前工作树仍有文件不在 scope；
2. 内置 `openai-compatible` usage 没有 claim 也能被写入并计为真实用量；
3. provider 成功后 stdout 写入失败会留下 success usage 与失败进程相互矛盾；
4. `reviewer` 可配置成 managed API，但该输出不能满足 N4，造成无效 Token 消耗。

## 红灯证据

- `python3 scripts/test-task-gate.py`：`hash-implementation` 子命令不存在，内容变化不会让门禁失败；
- `python3 scripts/test-cm-usage-report.py`：无 claim 的 managed usage 被计为 1 次调用、999 input tokens；
- `python3 scripts/test-cm-openai-compatible-call.py`：stdout 关闭后抛出 `BrokenPipeError`，日志仍为 success；
- `python3 scripts/test-workflow-config.py`：`reviewer.adapter: openai-compatible` 被错误接受。

## 根因

- N4/N5 只校验 handoff 与 review 文件之间的 SHA，没有重算 `changed_files` 的内容摘要；
- writer 把“允许无 claim 的通用 usage”错误地同样应用到内置 managed adapter；
- adapter 在记录 success 后才把结果交给 stdout，输出通道不在成功边界内；
- 角色配置只校验适配器字段组合，没有校验 managed reviewer 与 N4 凭证合同不兼容。

## 最小修复

- 新 handoff 可写 `implementation_sha256`；`check-n4`、`check-n5` 和 `mark-done`
  使用 `--project-root` 重算。历史无摘要凭证只能显式 `--allow-legacy-unbound` 恢复；
- 内置 `openai-compatible` usage 必须先有完整身份一致的 claim，writer 与 reporter 双层拒绝；
- provider 结果先成功写入并 flush stdout，再记录 success；输出失败记录 error 且无 traceback；
- 配置解析阶段拒绝 `reviewer.adapter: openai-compatible`，不发起无效 API 调用；
- 更新 CM AI、Fix、Refactor 与用户文档，使新凭证路径真正消费内容绑定。

放弃方案：不引入数据库、模型网关或新的审查通道；沿用现有 JSONL、文件凭证与本地 N4。

## 回归

- `python3 scripts/test-cm-usage-report.py`: PASS
- `python3 scripts/test-cm-openai-compatible-call.py`: PASS
- `python3 scripts/test-workflow-config.py`: PASS
- `python3 scripts/test-task-gate.py`: PASS
- Python compilation and `git diff --check`: PASS

## 审核状态与摘要边界

attempt-2 的 `implementation_sha256` 绑定的是 **a2 handoff 生成前的 40 个实现与落地
路径**，并不声称覆盖生成后才出现的 a2 handoff 和 r2 review 两份证据文件。后两者若
参与自己的摘要会形成无法稳定计算的自引用，因此由 handoff SHA、review header 与任务
状态转换单独绑定。

完整仓库门禁均通过，四个功能问题本身已经收口；但独立 round 2 发现旧文案把这 40 个
路径误写成“所有当前 modified/untracked landing paths”，因此该任务最终 disposition
是 `blocked`，见
`docs/fixes/.reviews/fix-model-call-boundary-identity-T-FIX-model-call-boundary-identity-r2.md`。
本段与上一份档案的状态修正由独立小修复任务
`fix-review-evidence-scope-honesty-T-FIX-review-evidence-scope-honesty-*` 重新绑定和审查，
不会改写或伪装原任务的两轮历史。
