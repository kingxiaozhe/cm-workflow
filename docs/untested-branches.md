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
逐个看 `scripts/*.test.mjs` 里有没有出现过。写这份文档时的结果：**51 个取值缺覆盖，
分布在 49 处**。

脚本输出的是**候选，不是待办**——内部记录类型和 `typeof` 判断也会被匹配到。下面是人工
分好的类。改完代码后重跑脚本对照。

---

## A 类：用户能配的选项、或文档明确承诺的行为

这一类和上表四个缺陷完全同形，优先补。

| 取值 | 位置 | 承诺在哪 | 补测试前要先弄清 |
| --- | --- | --- | --- |
| `auto_fix: never` | `cm-ai/host-qa-fix.mjs:21` | `templates/cm-workflow.yml` 写着 `explicit \| never \| auto`；`runtime/workflow-config.md` 说它决定「N6 失败后的三分支」 | `never` 下 QA 失败到底该停在哪、和 `explicit` 的差别是什么 |
| 视觉证据 `kind: video` | `cm-ai/review-package.mjs:371` | `cm-fix-host.mjs --help` 明写 `before:{path,sha256,kind:screenshot\|video,...}` | 录屏载体的校验和取证跟截图有没有实质差别 |
| 诊断 `design_change` | `cm-fix/cause-package.mjs` | cm-fix SKILL 第 4 步「升级出口」：停止硬修、转 `$cm-prd --change` 立项 | 这条出口下红灯测试要保留、档案要记「升级立项」，这些有没有真发生 |
| cm-check `configured` | `cm-check/host.mjs:105` | 三态之一（`configured\|degraded\|unknown`） | 什么条件算 configured，和 degraded 的边界 |
| cm-test `snapshot` / `evaluation` | `cm-test/session.mjs:47` | 两种模式**都**没被测过 | 两种模式各自的输入和产物 |
| cm-refactor 规则三态 | `cm-refactor/workflow.mjs:244` | `rule_correct\|rule_missing\|rule_wrong` 全没测过 | 规则判定的输入从哪来、三态各自怎么触发 |
| cm-refactor 四个失败码 | `cm-refactor/workflow.mjs:322` | 全没测过 | 每个码对应的真实冲突场景 |

**建议按模块分批**，不要一次全开。cm-prd、cm-refactor、cm-test、cm-check 这四块各自
独立，给一条从没走过的分支补测试，得先读懂那条分支本来该是什么行为——读浅了会写出
「形状对但没验到点上」的测试，那比没有更糟：它让人以为测过了。

## B 类：内部协议分支，值得测但不紧急

- `cm-ai/claude-tool-preview.mjs:51` —— `gzip` / `zstd` 传输编码，只测过 `identity`
- `cm-ai/tool-preview.mjs` —— `argument` 提示词传输方式，全部现有用例走 `stdin`
- `cm-ai/contracts.mjs` —— 状态机取值 `waiting_user` / `deny` / `revoked` / `active`
- `cm-ai/durable-runner-state.mjs:215,336` —— `grant_expired` / `clock_invalid`
- `cm-ai/cm-ai-conversation-entry.mjs:48-56` —— `context_refresh` / `run_finalize`
- `cm-prd/correction-check.mjs:28,45` —— `mechanical_failed` / `context_result`

这些不在用户配置面上，踩中的路径更窄。但 `grant_expired` 和 `clock_invalid` 关系到授权
凭据的过期判定，真出问题代价不小，排在 B 类的前面。

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
  所以 51 是**下限**不是全部。
- 「测试里出现过这个字符串」只能说明它被提到过，不等于那条分支被真正走到并断言了。
  A 类里每一条仍要人去确认。
- 最重要的一点：上表那四个缺陷是**跑真实项目**跑出来的，不是读代码读出来的。这份清单
  补的是读得出来的那部分；拿工作流去跑真实项目，仍然是发现问题最有效的办法。
