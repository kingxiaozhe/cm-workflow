# F01 Codex 双失败终态归一化

状态：实现与离线回归完成，等待 fresh 独立 Review。任务：
`T-FIX-f01-dual-failure-terminal`。

## 现象

唯一获批的 F01 synthetic live review 依次收到
`thread.started → turn.started → error → turn.failed`。worker 把两个 failure terminal
都转发给只接受单终态的 normalized observer，导致 V3 将本应为普通传输失败的结果
保存为 `unknown/observation_invalid`。同一 live harness 还错误地把 string-valued
`reviewInvocation.started` 当对象读取，使结果摘要中的 provider thread 为 null。

本修复不重跑 provider，不改变该 live attempt 的历史证据，也不勾选 F01。

## 复现与红灯证据

修复前运行：

```bash
node --test --test-name-pattern='duplicate provider failure|error then turn.failed|one observed non-authoritative' \
  experiments/js-orchestration/smoke.test.mjs \
  experiments/js-orchestration/codex-review-adapter.test.mjs \
  .omx/research/f01-codex-review-live/smoke.test.mjs
```

结果：exit 1，3/3 失败。

- worker 事件中同时出现 `error` 与 `turn.failed`；
- V3 实际为 `observation_invalid`，期望为 `transport_incomplete`；
- smoke validator 实际为 `provider_thread_invalid`，因为 fixture 已改为磁盘真实的
  string-valued `started`。

## 根因与证据链

调用链：provider JSONL → `worker-codex.mjs` → normalized observation → V3 runner →
持久化状态/报告摘要。

| 边 | 预期证据 | 实际证据 | 结论 |
| --- | --- | --- | --- |
| provider → worker | 一个进程可输出已观察到的两个失败事件 | fixture 精确重放 `error → turn.failed` | 最后正常边 |
| worker → observer | 一次失败只形成一个 normalized terminal | 修复前两个 terminal 都被转发 | 首个失败边 |
| observer → V3 | 单失败终态为 `unknown/transport_incomplete` | 修复前 duplicate terminal 被拒绝为 `observation_invalid` | 下游按合同 fail closed |
| V3 → smoke 摘要 | 从 `reviewInvocation.started` 读取 thread string | harness 读取 `.started.providerThreadId` | 独立报告瑕疵 |

已证实假设：worker 在 `stop('provider_failed')` 前无终态去重，且 stdout 同一 chunk
中的后续事件仍会进入 `accept`。反证试验是在不改 observer 的前提下只抑制第二个
failure terminal；新增两层测试随即转绿，observer 的原 `duplicate_terminal` 拒绝用例
仍通过。

## 修法与放弃方案

- worker 记录是否已转发 top-level failure terminal；首个照常转发并停止进程，后续
  `error`/`turn.failed` 只维持失败停止，不再进入 normalized observation。
- 进程关闭事件仍由原 close handler 记录；dispatch 限制、取消、timeout、item error、
  输出 schema 和 V3 状态语法均不变。
- smoke harness 通过一个纯读取 helper 接受 V3 的 string-valued `started`，validator、
  `result.json` 和 console 摘要共用同一取值。

放弃方案：不放宽 observer 的 duplicate-terminal 语法，因为那会扩大所有 provider
观察结果的完成语法；不修改 runner/V3 schema；不重跑 live attempt；不新增 provider
重试、身份协议或通用事件状态机。

## 波及面与回归结果

波及面仅为 Codex CLI worker 的失败事件归一化、V3 组合结果，以及一次性 live smoke
的本地报告读取。成功、取消、超时、item diagnostic、单 failure terminal 和 observer
拒绝重复终态的合同保持原样。

- 新增聚焦反例：红 0/3 → 绿 3/3；
- 相关三文件套件：84/84 通过；
- 全 JS 编排套件：996/996 通过；
- `./scripts/cm-check-runtime.sh`：通过；
- Shell/Python fixtures：通过；
- public、JS/Shell syntax、`git diff --check`：通过；
- public safety：仍为原有 5 项，分布于 marketing fixture、`tool-preview.mjs` 和
  `worker-codex.mjs` 的既有路径/endpoint；本修复未新增、未修复、未豁免。

## 权限与非目标

本 task 只使用离线 synthetic fixture。没有 provider/preflight/live 调用，没有重试，
没有安装、Git、发布、真实 tasks 写入、receipt、completion 或 F01 checkbox 变化。
没有进入 F01 第三项、F02、F05 Learning 产品接线或平台化工作。

## Learning 复盘

已将“同一 provider 失败方言应在 worker 适配边界归一，不能放宽 observer 单终态语法”
作为一条 `[已结构化]` 项目教训增量写入根 `AGENTS.md`。它由本次 worker 与 V3 组合
回归防护，必须随本 task 一起独立 Review；批准后再回读确认。
