# N4: Review

每个 task 完成后必须执行，按**单个 task 粒度**审查。完整通道与凭证格式见 `../../../runtime/review.md`，入口 handoff 与状态转换见 `../../../runtime/task-gates.md`。N3 的 `check-n4` 未通过时不得开始审查。

进入审查前解析 `reviewer` 角色并记录 `decision`/`phase: route`；角色配置只能描述请求
的审查适配器和模型别名，不能替代本节要求的独立上下文。若 `route_state` 是
`declared-adapter`，如实记录未观察到适配器，仍不得把作者模型或外部专家当作独立审查。

## 1. 主执行者自审

检查本 task 变更的：

- 代码质量：命名、结构、可读性、是否符合项目上下文约束
- 逻辑正确性：边界条件、错误处理、并发安全
- 安全性：密钥、环境文件、注入与权限绕过
- 性能：N+1 查询、重复计算、资源泄漏
- 测试质量：断言是否验证行为，是否存在怎么改都会通过的安慰剂测试

发现问题先形成自审 finding；不要在 N4 修改实现文件。有效问题按本节第 3 步返回
N3 生成下一次 handoff，避免已校验的证据与实际代码失配。

## 2. 独立审查（强制）

自审通过后，按以下顺序选择一个**新上下文**的审查者：

1. `codex-subagent`：用当前运行时的 no-history/fresh-context 选项（如 `fork_turns: none`）新建独立 Codex 子代理/线程，只接收任务范围、验收标准、diff 和验证结果
2. `codex-cli`：子代理不可用时，启动隔离的非交互 Codex CLI 审查会话；禁止它修改文件
3. `self-degraded`：两者都不可用时，主执行者做第二遍对抗式审查并显式标记降级

审查输入只包含**本 task 的 diff**，不得将整个未分类 working tree 当作任务 diff。审查者必须：

- 假设这个 diff 有害，优先寻找可复现的失败场景
- 对照 requirements/design/task 验收，检查超范围变更
- 按严重度排序；每条必须说明「输入/状态 → 错误结果」
- 找不到真实问题时明确写「零发现」，不凑数

该 feature 存在 `test-cases.json` 时，把 `taskIds` 命中当前 task 的 logic cases
加入 review package。逐例按 `runtime/test-contract.md` 输出
`SUPPORTED | CONTRADICTED | INSUFFICIENT_EVIDENCE`；`SUPPORTED` 只是静态代码
证据，**不得冒充单测或运行时 PASS**。`CONTRADICTED` 作为有效 finding 处置，
`INSUFFICIENT_EVIDENCE` 转交 N6 的正式命令或运行时验证。

核验类任务（脚手架、依赖、模板配置）也要过独立审查；输入改为关键产物、预期模板与构建/类型检查结果。

## 3. 处置与轮次上限

- 无阻塞发现 → 本轮写 `verdict: approved`，交给 N5 机械校验
- 有效发现且当前为第 1 轮 → 写 `verdict: changes_requested`，返回 N3 生成 attempt 2 handoff，再用同一级别的新鲜上下文复审
- 第 2 轮仍有阻塞发现 → 写 `verdict: blocked`，停止并进入人工处置，不得创建 attempt 3
- 误报 → 记录理由后忽略
- 最多 2 轮；偏好分歧若不阻塞，必须明确写 `approved` 并将双方理由写入 LESSONS.md
- 分歧涉及安全、资金或数据正确性 → 暂停等人裁决；只涉及风格/偏好 → 保留当前实现并记录放行

## 4. 审查凭证（强制）

每轮原始结果立即写入：

`{SPECS_DIR}/.reviews/{feature}-{task}-r{轮次}.md`

文件顶部必须包含：

```yaml
---
reviewer: codex-subagent | codex-cli | self-degraded
independent: true | false
task: T-xxx
attempt: 1
round: 1
verdict: approved | changes_requested | blocked
blocking_findings: 0
handoff: {feature}-T-xxx-a1-handoff.json
handoff_sha256: <check-n4 JSON 返回值>
at: 2026-07-22T10:00:00+08:00
scope:
  - path/to/reviewed-file
---
```

`attempt` 必须等于 `round`，`handoff` 必须指向本轮 N3 的执行证据，
`handoff_sha256` 必须逐字使用 `check-n4` 的输出。`scope` 必须逐项覆盖 handoff
里的全部 `changed_files`；正文必须写实际 findings 或明确的「零发现」。
`approved` 必须写 `blocking_findings: 0`；其他 verdict 至少为 1。
`self-degraded` 必须写 `independent: false`，并用非空 `degraded_reason` 记录前两个
通道为何不可用。
**无凭证文件或 verdict 不是 approved = 不得完成**，N5 必须执行 `mark-done`，
不能只检查文件存在或先校验再手工勾选。

## 5. 度量

供 N5 使用的结果：审查通道、轮次、被采纳的拦截数、忽略数及一句话理由。METRICS 保持原列顺序，将原「Codex拦截」语义升级为「独立审查拦截」。
