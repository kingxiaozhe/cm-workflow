# 没有测试走过的分支

一轮真实实跑修掉的四个缺陷是**同一个形状**：文档承诺了某个选项，代码里也确实有那条
分支，但从来没有测试走过它。

| 文档承诺 | 实际覆盖 | 后果 |
| --- | --- | --- |
| 交付方式 `diff` / `branch` / `draft-mr` 三选一 | 每个夹具都写 `diff` | 另外两种的项目永远收不了尾 |
| METRICS 列名「语义升级，保持原列顺序」 | 只有新列名 | 所有改名前的表被硬拒 |
| `--mode resume` 换会话恢复 | 一条都没有 | 从来没有人成功恢复过 |
| iOS 项目照常支持 | 没有带软链接的夹具 | 基线快照拍不出来 |

它们不是被写坏的，是**没人走过**。所以值得把同一形状的其余候选一次列出来，而不是等下
一次实跑再撞。

`scripts/audit-untested-enums.mjs` 扫 `runtime/js` 里 `['a','b'].includes(x)` 形式的枚举，
逐个看 `scripts/*.test.mjs` 里有没有出现过。2026-09-30 重新运行脚本，当前为
**21 个取值，分布在 17 处**；这是文字扫描候选，不是语义覆盖统计。

脚本输出的是**候选，不是待办**——内部记录类型和 `typeof` 判断也会被匹配到。下面是人工
分好的类。改完代码后重跑脚本对照。

---

## A 类：用户能配的选项、或文档明确承诺的行为

这一类和上表四个缺陷完全同形，优先补。

| 取值 | 位置 | 承诺在哪 | 补测试前要先弄清 |
| --- | --- | --- | --- |
| ~~`auto_fix: never`~~ | `cm-ai/host-qa-fix.mjs:21` | 同上 | **已补**：`cm-ai-qa-fix-policy.test.mjs` 钉死三取值各自的去向，并覆盖「轮次耗尽压过策略」这条优先级 |
| ~~视觉证据 `kind: video`~~ | `cm-ai/review-package.mjs:371` | 同上 | **已补**：`cm-fix-visual-carrier.test.mjs` 验录屏容器格式、声明与字节必须双向一致、哈希绑定 |
| ~~诊断 `design_change`~~ | `cm-fix/cause-package.mjs` | cm-fix SKILL 第 4 步「升级出口」：停止硬修、转 `$cm-prd --change` 立项 | **已补**：`scripts/cm-fix-escalation.test.mjs` 覆盖保留真实红测、升级档案、终态、崩溃恢复与冲突、普通记录兼容及 QA 父子退出，并做变异验证 |
| ~~cm-check `configured`~~ | `cm-check/host.mjs:105` | 三态之一（`configured\|degraded\|unknown`） | **已补**：`scripts/cm-check-host.test.mjs` 钉死三态及混合报告原样回传、不改变核心判定，以及非法报告的精确阻断原因 |
| ~~cm-test `snapshot` / `evaluation`~~ | `cm-test/session.mjs:47` | 中断后允许重做的两种纯读步骤，不是用户模式 | **已补**：`scripts/cm-test-session.test.mjs` 覆盖纯读步骤重做、其它步骤不重做、command/host 原结果回执的身份校验与来源记录，以及全部七种已完成步骤的回放，并做变异验证 |
| ~~cm-refactor 规则三态~~ | `cm-refactor/workflow.mjs` | `rule_correct\|rule_missing\|rule_wrong` | **已补**：`scripts/cm-refactor-gaps.test.mjs` 覆盖三态、混合裁决、逐文件覆盖、拒绝原因码、隔离通道、报告及裁决后规则传递；规则缺失或错误必须伴随手册修订，仅改行尾空白、换行符及首尾空行也会在报告和试点前拒绝，修订效果仍待独立审查 |
| ~~cm-refactor 四个失败码~~ | `cm-refactor/workflow.mjs:322` | 冲突或结果不明时停机，不能覆盖别人改动 | **已补**：`scripts/cm-refactor-gaps.test.mjs` 用真实恢复、磁盘改动和原子写入冲突验证四码停机，普通失败则恢复并重试；变异验证限制见下文 |

**建议按模块分批**，不要一次全开。cm-prd、cm-refactor、cm-test、cm-check 这四块各自
独立，给一条从没走过的分支补测试，得先读懂那条分支本来该是什么行为——读浅了会写出
「形状对但没验到点上」的测试，那比没有更糟：它让人以为测过了。

A 类七条清单已完成，都做了**变异验证**——故意把被测代码改坏，确认测试会红。
cm-refactor 的 `refactor_unknown_effect` 列表成员是冗余防线：`unknown()` 已覆盖所有公开触发路径。
单独移除该成员不改变停机行为，这个变异存活，不宣称被测试捕获；真实恢复用例仍验证结果不明时停机。
新写的测试本来就该过，过了不代表验到了点上。

## B 类：内部协议分支，值得测但不紧急

清单已清空。六项都在 CI 执行的 `scripts/*.test.mjs` 里有了测试，每条都做过变异验证：

| 分支 | 测试文件 |
| --- | --- |
| `cm-ai/durable-runner-state.mjs` 的 `grant_expired` / `clock_invalid` | `scripts/cm-ai-review-timeout.test.mjs` |
| `cm-ai/cm-ai-conversation-entry.mjs` 的 `context_refresh` / `run_finalize` | `scripts/cm-ai-conversation-entry-ops.test.mjs` |
| `cm-ai/contracts.mjs` 的 `waiting_user` / `deny` / `revoked` / `active` | `scripts/cm-ai-contracts.test.mjs` |
| `cm-ai/tool-preview.mjs` 的 `argument` | `scripts/cm-claude-probe.test.mjs` |
| `cm-ai/claude-tool-preview.mjs` 的 `gzip` / `zstd` 与未声明编码 | `scripts/cm-claude-probe.test.mjs`（真实回环监听器；专门 macOS CI job 执行；本机实际运行，Linux job 仍跳过） |
| `cm-prd/correction-check.mjs` 的 `mechanical_failed` / `context_result` | `scripts/correction-check.test.mjs` |

## C 类：噪声，不必单独补

脚本会匹配到，但不构成缺口，**不要**为它们单独写测试：

- `typeof` 判断里的 `'string'` / `'boolean'` / `'function'`——语言层面，不是业务分支
- 内部记录类型 `append-intent` / `append-result` / `task-commit-intent`——已被上层用例
  整条链路间接覆盖，单独断言只会重复
- 只做透传的错误码 `catch` 列表，例如 `cm-fix/execution.mjs` 里
  `['context_invalid','context_too_large',...].includes(error?.code)`——这些码由抛出方
  的用例负责，这里只是把它们原样传出去

## 这份清单的局限

- 只扫 `['a','b'].includes(x)` 这一种写法。`switch`、对象查表、`Set.has` 都漏掉了，
  所以当前的 21 只是候选，不能当作全部缺口或实际测试覆盖的下限。
- 「测试里出现过这个字符串」只能说明它被提到过，不等于那条分支被真正走到并断言了。
  A 类里每一条仍要人去确认。
- 最重要的一点：上表那四个缺陷是**跑真实项目**跑出来的，不是读代码读出来的。这份清单
  补的是读得出来的那部分；拿工作流去跑真实项目，仍然是发现问题最有效的办法。


## 当前会话执行与恢复仍需实跑的边界

四驾驶员的 liveEvidence 请求绑定、验证阻断和材料/设备不可用路径已有实际 host 集成夹具，
见 `scripts/cm-live-evidence.test.mjs` 及四驾驶员夹具；真实 PDF 每页内容、HTML 逐元素操作和
真实浏览器/设备成功断言仍需逐产品实跑。Mac 夹具证明本地合成 CLI 的沙箱/回环行为，
不证明已登录 Claude 账号或真实模型可用。

cm-fix 根因审查拒绝后的恢复入口：standalone `rediagnose` 一次，
绑定原审查、历史和源包，不重复复现、不覆盖旧证据；新根因必须走 fresh r2 审查，
第二次拒绝明确停机。`scripts/cm-fix-rediagnosis.test.mjs` 已实际覆盖原运行恢复/replay、
中断不重派、源漂移/证据冲突前拒绝、第二次拒绝上限和旧 reviewer thread 拒绝。
真实 Wue 原 run 尚未执行这项恢复；不能把夹具通过当作真实恢复。
步骤与保守中断边界见 `skills/cm-fix/references/js-host.md`。

## 本轮全库回归发现的失败与修复

规则写入后任务检查失败、环境修好再 advance 的同 attempt 基线核对已修复：审查包比较运行原始基线，bootstrap 写入证据比较本次实际起点，两者不强制相等；最终内容仍须精确匹配。真实 driver/host 夹具验证重试到审查及完成，也保留外部文件改动和非 nextTask 的派发前拒绝。

取消向导测试的 SIGINT 路径现显式传入语言，并分别验证中英文取消与无写入，不再依赖宿主 locale。原两项失败的 red 记录和修复回归保留在本地审查包。

人工补正：新增 `scripts/cm-task-gate-correction.test.mjs`，覆盖真实 JS CLI 与 Python 锁适配器完成、旧历史保留、必须明确授权与 Learning、漂移、旧/降级报告拒绝、一次 blocked 封存以及 symlink/hardlink 拒绝。合成报告只证明门禁合同，真实独立批准另留审查证据。
