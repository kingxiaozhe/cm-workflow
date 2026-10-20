# 新审查的规模准入

任务交付太大时，在接受新的 review effect intent 之前返回 `review_scope_too_large`，提示“请把任务拆成多个更小的 task 再审查”。返回的 `scope.measured`、`scope.limits`、`scope.exceededDimensions` 分别给出实测值、上限和超限项。拒绝不追加 journal，不创建 invocation，不消耗审查次数或恢复名额。Codex 与 Claude 使用同一规模政策，Codex 原有的传输硬限制另行保留。

四项默认上限集中在 `runtime/js/cm-ai/review-scope-policy.mjs`：

| 字段 | 默认上限 | 计算范围 |
| --- | ---: | --- |
| `pageCount` | 128 | 完整最终呈现，按材料读取器相同的 16384 字节 UTF-8 页边界计算；inline 输入也计页 |
| `materialBytes` | 2097152 | 完整最终呈现的 UTF-8 字节，分页后的短 manifest 不替代原材料 |
| `imageCount` | 10 | 原生材料实际附图数量；证据接续的旧图与新图一并计算 |
| `imageBytes` | 12582912 | 上述全部附图的字节和；重复附图仍按发送次数计算 |

材料包读取已通过 `nativeEvidenceImagePaths` 校验图片归档的真实字节、大小和摘要。计量复用这些已验证记录，不改图、不缩图、不丢材料。仓库的 231 页成功样例是合成读取器测试，不能用来校准真实模型在限时内完成的能力，因此采用需求指定的保守默认值。

现有 `--review-config REVIEW.json` 可增加 `scopeLimits`，可只覆盖部分字段。字段必须是正安全整数；未知字段拒绝。例如保留现有 model、preflight 等配置后加入：

```json
{"scopeLimits":{"pageCount":96,"materialBytes":1572864,"imageCount":8,"imageBytes":10485760}}
```

这段是增补片段，不是完整 review-config。该策略与 reviewer timeout 一样属于调用前的临时准入，不加入旧运行的授权配置指纹。调高策略不提高原材料传输、归档、journal 或调用次数的硬限制，也不授予审查许可。

`inspectContinuationPlan` 的 `currentReviewInput` 总是给出四项数字及 `scope`；待发起的新审查超限时标记 `blocked_new_review`。已接受 intent 或登记/开始的旧调用通过原有 cached/pending/reconciliation 路径恢复，不重新准入。其预检只标记 `warning_existing_review`，使用已登记请求的原 invocation/context 身份；原有 `pending_effect` 或 writer 占用等阻断仍保留。旧运行若显式发起另一个新的审查调用，仍执行新闸门。

开发前的可用交付投影标记 `projected:true`，只估计当时已供应材料；未来模型输出和未发布的原生归档保持 unknown。真正发起审查时重新按最终材料检查。没有足够材料/审查配置时不冒称完整规模已知。

验证使用合成包与假进程，不调用模型。测试为 `scripts/cm-review-size-gate.test.mjs` 与 `scripts/cm-ai-review-input-admission.test.mjs`，覆盖逐维超限零 spawn、包含边界、默认值、配置、零新增记录/次数、只读预检与旧调用恢复。

应用项目教训：最终输入准入与存档容量分开验限；新准入在 effect intent 前执行，旧调用不重新取得许可。已复盘，无新增项目教训。本候选等待 Claude 独立审查，作者没有生成审查批准。

## 本次本地验证

| 检查 | 结果 | 退出码 |
| --- | --- | ---: |
| 修正夹具后，原分支基线运行新增规模测试 | 6 项失败；四项逐维用例均能发现缺少阻断 | 1 |
| 规模测试、owner 准入、四个指定回归文件、review timeout 配置测试，同一批并行执行 | 72/72 通过 | 0 |
| 原生预防核对、材料审查 host、Claude 合成协议的受影响回归 | 32/32 通过 | 0 |
| 定向改坏：跳过 pageCount 比较；只跑对应逐维用例 | 失败；还原后通过 | 1 → 0 |
| 定向改坏：跳过 imageBytes 比较；只跑对应逐维用例 | 失败；还原后通过 | 1 → 0 |
| 公开仓库校验、公开安全扫描、git diff --check | 通过 | 0 |

详细输出保留在本机临时目录：`/tmp/cm-review-size-baseline-red.log`、`/tmp/cm-review-size-final-tests.log`、`/tmp/cm-review-size-affected.log`，以及 `cm-review-size-mutation-{pageCount,imageBytes}.log` / `cm-review-size-restored-{pageCount,imageBytes}.log`。未安装、未提交、未推送，未调用真实 Codex、Claude 或其他审查模型，未操作其他工作树或产品运行。

## 2026-10-19 退回复核：尚未完成修复

本轮没有永久修改生产代码或测试，也没有调高夹具或默认规模上限。上一节是上一轮验证，本节是本轮实测，不能将前者解释为本轮长链路通过。审查仍由 Claude 负责；作者未调用审查模型或生成批准凭证。

适用教训：基线失败不能代替根因；恢复沿用原证据，不能重新取得调用许可；保持默认闸门和业务断言。已复盘，无新增项目教训。业务地图无需更新，本轮未改变运行行为。

### 已确认的定位证据

- 读取原并行失败日志 `/tmp/sg-cand.log`。材料链路 approved 子项实际失败在 `cm-ai-bounded-native-correction.test.mjs:470`：最后一次 `drive('advance')` 的 `spawnSync.status` 为 `null`，其外层期限为 40000 ms。日志已有 syntax passed 和 documentation_inspect 应答，没有 `review_scope_too_large`。原测试未打印 error/signal，不能据此确认子进程究竟停在计算、传输还是退出清理。
- 只读重放该日志指向的保留夹具 `cm-native-host-Iyjngm`。每个已形成审查包的 checkpoint 都低于默认规模上限；最终包是 97 页、1587118 字节、1 张图、68 图片字节。12 次调用保留，原 journal 为 fixture_completed，日志有一次 N6 PASS 和 N8 run_done。这里证明持久事实已保存，不证明驾驶员正常退出。
- provider recovery 与 valid evidence 的原并行日志也在 approved 分支的 QA/文档检查后出现 `null !== 0`，分别位于 `provider-review-recovery-fixture.mjs:102` 和 `valid-evidence-continuation-fixture.mjs:92`。直接失败是外层子进程未正常返回；是否为新回归及更深原因尚未确定。
- 当前受限执行环境无法复现到上述位置。基线和本分支都在第一轮开发原生沙箱/清理路径遇到权限问题；清理记录明确为 `fixture_process_listing_failed`、`ps`、`EPERM`。未修改权限检查、吞错、跳过清理或切换执行方式。
- review-failure 的 20 个失败测试名称在两边完全一致，均有相同的进程枚举清理错误；25 个用例通过。这批结果不能验证原日志中被权限错误遮住的具体断言。
- deadline 的 scalar 失败符合预期，但 batch 在两边都超过原 3500 ms 期限。长测试结束后，只并行运行这对 deadline 文件再次核对，两边仍为 0/1、退出码 1。没有改动期限、读页数或断言。

### 基线与本分支本轮对照

Node v24.14.0；每个命令均为 `node --test --test-concurrency=1 scripts/<file>.test.mjs`。两个根、各文件独立并行；只读基线为用户指定的 0599bff 副本，未写入该副本。表中计数为顶层测试报告，material-chain 包含父测试及三个子项。

| 文件 | 基线通过数 | 本分支复核通过数 | 基线/本分支退出码 | 限制 |
| --- | ---: | ---: | --- | --- |
| cm-ai-material-chain | 0/4 | 0/4 | 1 / 1 | 原生检查/进程枚举权限阻断，未到原 approved 失败点 |
| cm-ai-provider-review-recovery | 0/1 | 0/1 | 1 / 1 | 同上 |
| cm-ai-review-failure | 25/45 | 25/45 | 1 / 1 | 两边同名 20 项失败，带 EPERM 清理错误 |
| cm-ai-valid-evidence-continuation | 0/1 | 0/1 | 1 / 1 | 原生检查/进程枚举权限阻断 |
| cm-review-material-deadline | 0/1 | 0/1 | 1 / 1 | 两边批量读取超时；低负载复核也相同 |

这不是“修后通过”表：本轮尚未识别并修复一个可证明由规模闸门引入的失败。用户提供的旧环境基线 4/4 与本分支 2/4 保留为待解释证据，不能被本轮权限受限的结果覆盖。

### 不依赖受阻原生检查的验证

| 文件 | 通过数 | 退出码 |
| --- | ---: | ---: |
| cm-review-size-gate（含上一轮六项规模行为及其他三项） | 9/9 | 0 |
| cm-ai-review-input-admission | 11/11 | 0 |
| cm-codex-reconnect-notice | 6/6 | 0 |
| cm-codex-developer-reconnect-notice | 9/9 | 0 |
| cm-codex-review-progress | 25/25 | 0 |
| cm-review-material-worker | 3/3 | 0 |
| cm-ai-review-timeout-config | 9/9 | 0 |

合计 72/72。原六项规模行为均重跑；四个上一轮回归文件均重跑。没有把这些局部通过作为长链路或整个框架通过。

定向变异：临时在 `executeEffect` 的缓存命中之前增加审查规模准入，故意使旧调用受到新上限约束；仅运行 `old registered/cached review resumes`，得到 0/1、退出码 1。随后恢复文件原字节，重跑同项得到 1/1、退出码 0。恢复后 task-runner SHA-256 为 `90d58b85df0350c4feee9d69ff223fe3c05e65374c47ade66690e0080aab3488`。这证明旧调用保护的测试有效，不证明尚未定位的 QA 后退出问题已修复。

本轮日志和退出码 JSON 位于 `/tmp/cm-size-regression-20261019/`；`base-*.log`、`before-*.log` 为对照，`verify-*.log` 为 72 项验证，`quiet-*-cm-review-material-deadline.log` 为低负载复核。`assert-retained-chain.mjs` 与 `retained-chain-diagnosis.log` 保留只读定位断言，`mutation*.log`、`restored-old-cached-review.log` 与 `mutation.json` 保留变异红绿证据。

剩余工作：取得原串行 2/4 失败断言，在具备原生检查及进程枚举能力的环境复现 QA 后子进程不返回，区分 final response、管道排空和退出清理。当前环境不能提升该权限。未取得这项证据前，不修改无关退出流程、不放松默认闸门，也不宣称退回问题已解决。
