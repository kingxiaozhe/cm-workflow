# 已完成运行的受控集成

此入口处理文档合并、同一 Git worktree 集合内的交付集成、已审 package name 变更造成的 repositoryId 分流，以及固定证据快照的新增。接纳固定证据不修改产品文件，不执行开发、原任务 Review、QA 或 run_done。

## 证据合同

- 父运行须是原生 V3 completed + committed，没有 pending effect 或已接纳 QA fix。只追加一次 `reviewed-integration-accepted`，保留原 identity、baseline、review package、记录前缀、attempt 和预算。
- plan 固定父记录数量、最后一条摘要和原包；每个额外来源固定原 identity、canonical root、journal revision 和 package digest。普通 discovery 保持同根、同 repositoryId 校验。
- 跨根来源须属于同一真实 Git common directory。新 repositoryId 仅允许同目标根，且须找到旧身份下更早完成、唯一匹配的已审 package.json name 变更。逐 run 授权不构成全局别名。
- 来源必须通过自身 V3 journal 回放为 completed + committed。未完成、错轮次、错包、来源消失或 revision 变化均拒绝；旧失败和 successor 历史保留。
- 文档转换仅限父 scope 中普通 `docs/*.md` 的固定 0644 before/after。AGENTS.md、CLAUDE.md、SKILL.md 和范围外文件不得接纳。新独立审查包必须包含准确文档差异，旧审阅文字和 Git 提交说明不能代替回执。
- 当前入口限定 Codex 维护作者与 fresh Claude 审查，绑定 plan.author.contextId、真实 V3 registration/result 和隔离检查、变异证据。历史父 developer 的 provider 不决定本轮维护作者。
- 审查包的 `integration/plan.json` 绑定 plan 精确 `JSON.stringify(plan) + "\n"` 字节；文档在 `integration/documents/{原相对路径}` 中形成 before/after changes。
- 可选 `snapshots` 只接受 `reports/**/AGENTS.md` 的新增副本：最多 64 项，按路径排序且唯一，固定普通文件类型、原 0644/0664 mode、字节数及 SHA，合计不超过 2 MiB。已有基线文件、父及来源已审范围/需求/变更、覆盖这些路径的适用祖先指令均拒绝。不能用快照覆盖旧交付链，不能以此修改全局忽略规则。
- `snapshots.provenanceSha256` 绑定审查 requirements 中的 `integration/snapshot-provenance.json`；各组完整字节放在 `integration/snapshots/{sha256}.txt` 数据文件。相同字节可共用数据载体，每个产品路径及原权限仍单独绑定。来源说明的真实性由新独立审查核实，摘要只证明所审材料未换。批准仅解释这些副本的存在，不将提案提升为产品根指令。
- 按登记顺序组合全部既有交付及所有显式来源，最终当前树须精确相等。额外字节、指令文件和来源链缺口继续阻断。已接纳集成的父运行暂不支持再接纳 QA fix，返回 `integration_fix_unsupported`。

## 只读预检

保留原 run definition、配置和审查资料。plan/evidence 使用 canonical JSON、真实绝对路径和单链接普通文件。

```bash
node scripts/cm-ai-integration-preview.mjs --run-definition "{原run.json}" --plan "{integration-plan.json}"
node scripts/cm-ai-integration-preview.mjs --run-definition "{原run.json}" --evidence "{integration-evidence.json}"
```

evidence 形状为 `{plan, review: {configuration, registration, started, result}}`。预检不构造宿主或打开 writer。退出 0 表示该时刻可接纳；退出 2 表示阻断或缺审查；退出 1 表示输入/读取错误。返回的 launchControlTarget 是固定恢复目标，不可在拒绝后自动刷新。

## 原 owner 显式接纳

仅当预检 `eligibleForAdoption: true`，且原会话已获准真实恢复时，使用原 resume plan、配置和当前候选 runtime。把预检 launchControlTarget 原样保存为文件；在 driver permissions 追加以下参数，仅执行 `--operation status`：

```text
--integration-evidence {完整证据文件}
--accept-integration-digest {预检planDigest}
--expected-control {固定launchControlTarget文件}
```

两个 integration 参数必须成对，摘要是 plan 的 canonical digest，不是 evidence 文件 SHA。原 writer 锁下重验目标及全部证据，记录固定整个 evidence 文件 SHA。禁止与其他恢复合用，连接只允许 status。同一证据可幂等读取，换证据不得覆盖原记录。拒绝后不得自动换目标或重派。

成功只证明当前代码由固定已审来源解释；QA 和产品收尾仍受原门禁控制。外部证据改变或丢失时，保留历史完成事实，当前状态重新投影为 correction_review_required。

## 大型维护审查材料

新的维护审查可显式选择 `EXECUTION_POLICY_V2` 的 `utf8-delta-v2` 呈现。同一文件的 before/after 只对精确相等片段作可逆引用，完整插入字节仍在输入内；传输前还原并核对整个原始数据及摘要。没有删减文件、审查内容或检查要求。过度碎片化时保留完整条目，不提高原输入或输出上限。

该选择仅绑定新维护调用。原 V1/null 默认行为和持久 journal 编码不变，不给在途产品运行迁移策略。工具进度只能绑定已登记、尚未完成的允许工具；不能代替工具结果、审查结论或完成凭证。

