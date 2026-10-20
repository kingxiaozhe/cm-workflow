# PR 224 CI 修复交接

起点：`chore/consolidate-installed` / `f547252`。修复方 Codex；独立审查留给用户指定的 Claude，本轮未发起审查调用。

只改当前工作树；未提交、推送、安装或调用真实模型。运行时默认策略保持不变。

## 原失败与逐文件归因

原始证据：`.omx/logs/consolidate-installed/ci-run-failed.log`。
日志顶层汇总为 37 个失败：history 23，普通分片 0/1/2/3 分别 1/6/1/6。
按文件和用例名称去重为 36 个叶子名称，另有 material-chain 父用例的汇总失败。
输入中的 38 与该日志汇总相差 1；嵌套子进程的重复输出没有另算成新根因。
逐用例名称及分类见 [ci-failure-classification.tsv](ci-failure-classification.tsv)，包含 36 个叶子名称及 1 个父用例汇总。

类别：(a) 快照/补丁拼接不一致；(b) 主分支独有测试与安装合同不兼容；(c) 安装版已有过时断言或夹具；(d) 已审修复引入的影响。

| 测试文件 | 叶子名称数 | 类别 | 原因与修法 |
| --- | ---: | --- | --- |
| `experiments/js-orchestration/smoke.test.mjs` | 21 | b | 20 个事件/超时用例没有合法 prompt，先被安装版已有的输入门禁挡下；补合法输入后保留原事件断言。另 1 个双失败事件用例仍断言旧结构，改为精确核对新增的有界诊断及关闭时合并的来源。 |
| `experiments/js-orchestration/cm-ai-runtime-root.test.mjs` | 1 | a | 宿主清单只带入 12b7ce9 的部分接口，缺少安装版已有的四项恢复能力。补全精确清单，继续拒绝任何未列接口。 |
| `experiments/js-orchestration/task-runner.test.mjs` | 1 | d（69bc28d） | 800000 字节前后快照的完整审查提示超过新的默认规模上限。该用例验证旧存档容量；显式配置 256 页 / 4 MiB 的测试审查策略，默认策略不变。 |
| `scripts/cm-external-model-host.test.mjs` | 5 | c | 旧合成 CLI 不支持新增的 `sandbox --help` 能力探测，被 host-check 正确阻断。让合成传输识别帮助与精确参数，再执行真实 fixture 命令；保留路由、调用次数、恢复与 usage 断言。 |
| `scripts/cm-ai-bounded-native-correction.test.mjs` | 2 | c | 普通 CI 组中的安装版夹具委托本机 Codex sandbox，但 CI 没有安装 Codex，应用阶段进入 unknown。替换为显式合成的命令传输；真实 owner/store/保护编辑函数/检查/QA 不变。 |
| `scripts/cm-ai-material-chain.test.mjs` | 3 | c | approved、blocked、changes_requested 三个场景复用 bounded-native-correction，继承同一个依赖问题。消费修好的共享夹具，本文件不改。 |
| `scripts/cm-ai-native-review-continuation.test.mjs` | 1 | c | 与 bounded-native-correction 相同的未声明本机沙箱依赖。使用同一个合成命令传输，保留 r1/r2、历史、预算、QA 与重放断言。 |
| `scripts/cm-ai-operator-guidance.test.mjs` | 1 | c | 安装版容量阻断要求先做只读 preflight，旧测试仍要求 advance。移出通用 advance 循环，精确断言 preflight、无授权、无直接恢复动作和禁止提高上限。 |
| `scripts/cm-controlled-correction.test.mjs` | 1 | c | 非法 blocked r1 现在先被原生恢复 owner 校验拒绝，旧正则指向后续 changes_requested 检查。仅更新准确错误断言，仍必须抛错。 |

(b) 的两份历史夹具没有随安装分发，不能将其描述为安装版中已经更新的测试；smoke 也并非更晚的新业务要求。
未发现 0599bff 的行为回归。69bc28d 对大包用例的影响是预期准入变化，不回退它的行为。

## 来源证据

- `external-model-host`、`controlled-correction` 和共享 `cm-ai-host-fixture` 在 a401be7 / f1ef412 / 0599bff / 69bc28d / HEAD 逐字节相同。因此前两者不是主分支独有的新测试。
- `operator-guidance` 与两个原生恢复测试均与安装来源快照 f1ef412 相同；安装版的 preflight 分支和原生 owner 校验可直接在该快照读到。
- `assertCodexInitialInput` 在 0599bff 之前已经存在；smoke 的缺 prompt 失败不来自重连或规模闸门。
- smoke / task-runner 历史测试不存在于安装快照。runtime-root 的部分来源记录见同目录 `source-attribution.tsv`。
- 定向 f1ef412 对照：operator-guidance 和 controlled-correction 合计 48 项，46 通过、2 失败，命中同样两项旧断言。

## 测试改动边界

未删除或跳过测试，未改变 CI 分组、测试权重或工作流。只读状态、历史原字节、重复登记拒绝、审查轮次、已用调用和 QA 等业务断言继续保留。

`scripts/fixtures/protocol-sandbox.mjs` 只为协议夹具提供命令传输。它核对 cwd、保护 profile、specs 参数、独占临时目录权限、IPC 目录授权及 TMPDIR，再运行真实 fixture 命令并转发退出状态。它不证明 OS 沙箱强制隔离。真实 Codex 沙箱测试仍由原 native 组负责；运行时代码没有改为无保护执行。

重连上限仍为 32。规模默认值仍为 128 页 / 2 MiB / 10 张 / 12 MiB，阻断码仍为 `review_scope_too_large`，旧已登记调用的兼容路径不变。

## 本地验证

环境：macOS / Node 24.14.0 / Python 3.9.6；CI 普通和历史组为 Ubuntu / Node 24.14 / Python 3.12。入口与分片器使用 CI 原命令。

```bash
node scripts/cm-test-suite.mjs check
node scripts/cm-test-suite.mjs run ordinary --shards 4 --index 0
node scripts/cm-test-suite.mjs run ordinary --shards 4 --index 1
node scripts/cm-test-suite.mjs run ordinary --shards 4 --index 2
node scripts/cm-test-suite.mjs run ordinary --shards 4 --index 3
node scripts/cm-test-suite.mjs run history --concurrency 4
```

修前 history：1231 项，1206 通过、23 失败、2 个既有跳过，与 CI 完全相同的失败数。
修后 history：1231 项，1229 通过、0 失败、0 取消、2 个既有跳过，退出 0。
两次分别使用上述同一命令。日志为 `.omx/logs/consolidate-installed/local-{before,after}-history.log`。

修前 ordinary 分片 2：764 项，697 通过、62 失败、3 取消、2 跳过；分片 3：760 项，713 通过、47 失败、0 取消、0 跳过。macOS 比 Linux 会执行更多平台条件用例，不能与 CI 的通过/跳过数直接相减归因。分片 0、1 长时间停滞后已中断（退出 130），不计完整基线；对应原始日志保留。

候选定向验证：smoke、runtime-root、operator-guidance、controlled-correction、external-model-host 共 136/136 通过；重连审查/开发与规模闸门共 24/24 通过。

原生证据续行业务用例已经走完原 blocked、第二轮、QA 与终态恢复，测试正文通过；文件清理钩子仍因本地 `ps` EPERM 失败。更深的大材料审查在保留 journal 中记录原生 observation `{status: failed, code: EPERM}`，结果为 transport_incomplete；本地 loopback 预检需要监听权限。不能将这类环境失败计为通过。

### 故意改坏

在当前目录下的隔离候选树，将 `review-scope-policy.mjs` 的 `if(scope.exceeded)` 临时改为 `if(false)`，仅运行 `only pageCount exceeds its limit`。测试由通过变为失败（退出 1），还原精确原字节及 SHA 后同一测试恢复通过（退出 0，1/1）。日志为 `.omx/logs/consolidate-installed/ci-repair/mutation-size-gate-{red,restored}.log`。运行时变异不进入交付树。

### 正式工作树分片结果

| 组 | tests | pass | fail | cancelled | skipped | 退出与说明 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| history | 1231 | 1229 | 0 | 0 | 2 | 0；完整结束 |
| ordinary 0 | 884 | 853 | 27 | 4 | 0 | 1；完整返回，含环境失败/取消 |
| ordinary 1 | 819 | 761 | 54 | 1 | 3 | 1；常驻进程导致无法收尾，SIGINT 后输出该汇总，不视为完整验收 |
| ordinary 2 | 764 | 696 | 63 | 3 | 2 | 1；完整返回，含环境失败/取消 |
| ordinary 3 | 760 | 716 | 44 | 0 | 0 | 1；完整返回，含环境失败 |

四个 ordinary 分片在同机并行，保留 CI 默认 Node 并发；没有追加跳过或修改超时。原始日志为 `.omx/logs/consolidate-installed/local-after-shard-{0,1,2,3}.log`，机器摘要为 `ci-repair/final-ci-results.json`。所有组均真实启动；分片 1 的取消不能冒充所有用例完成。

分片 1 的明确阻断位于未改动的 `cm-fixture-process-cleanup.test.mjs`：先启动常驻 owner，再通过 `fixtureProcesses` 调用 ps；EPERM 在后续 `owner.kill` 前抛出，留下未结束的句柄。已保留断言并中断该分片，没有修改这个清理合同。当前宿主无法证明全部临时后代已经退出。

本轮修复后的正式分片中，原生证据续行业务正文、guidance、controlled-correction 以及 external-model-host 原五个失败中的四个均通过。external-model-host 的 both-runtime 用例在全量负载下改为 provider 开发 5 秒期限超时（`develop_answer_missing`），不再是 IPC 能力缺失；精确单项复跑 1/1 通过，退出 0，日志为 `ci-repair/final-external-both-runtime.log`。候选定向 136/136 结果不覆盖本次全量的环境与时序失败。

分片 2 的修前/修后对比还出现 session-chain 的 30 秒超时、driver close timeout 等未改动路径的不同失败。没有把这些未解决结果统称为已通过，也没有扩大本轮补丁去修改原有预算。普通组未全绿，Linux CI 未验证，当前不能宣称 PR 可合并。

### 改动行数

| 文件 | 新增 | 删除 |
| --- | ---: | ---: |
| experiments/js-orchestration/cm-ai-runtime-root.test.mjs | 2 | 2 |
| experiments/js-orchestration/smoke.test.mjs | 17 | 15 |
| experiments/js-orchestration/task-runner.test.mjs | 5 | 1 |
| scripts/cm-ai-bounded-native-correction.test.mjs | 3 | 3 |
| scripts/cm-ai-native-review-continuation.test.mjs | 3 | 3 |
| scripts/cm-ai-operator-guidance.test.mjs | 5 | 2 |
| scripts/cm-controlled-correction.test.mjs | 1 | 1 |
| scripts/cm-external-model-host.test.mjs | 2 | 1 |
| scripts/fixtures/protocol-sandbox.mjs（新文件） | 32 | 0 |
| docs/maintenance/consolidate-installed/ci-failure-classification.tsv（新文件） | 38 | 0 |

八份测试与一份夹具工具合计 +70/-28；另有本交接报告和逐用例 TSV。最终文件 SHA 清单保存在 `.omx/logs/consolidate-installed/ci-repair/final-file-sha256.tsv`。本文件不是独立审查批准或合并凭证。

## Learning 与交接

应用已有教训：基线失败不替代根因、测试必须纳入 CI 清单、持久事实不代表完成授权。已复盘，无新增；AGENTS.md 不改。最终 Claude 审查应覆盖所有测试和合成传输变更，并核对 Linux CI，不能用本地环境阻断推定远端已绿。
