# 审查要求补测试时的第二轮接续

原始红灯输出、测试摘要、存量基线和第一轮审查保持原样。当前测试集可以通过已登记的第二轮
测试编写扩充；修复回调仍只能改原业务范围，不得修改测试。

## 适用范围与证据规则

- 仅第一轮最终审查 `changes_requested` 可登记补测计划，必须引用其中真实的 finding ID，并说明遗漏场景及覆盖补充理由。
- 计划可选原 `redTest.testFiles`、`baseline.testFiles`，或原快照中不存在的新文件；不得把已有业务文件重新声明成测试，不得与 `repair.scope` 重叠。
- 此路径统一记录为**覆盖补充**，不声称新增测试在原修复前代码上变红。原始红灯仍是缺陷复现证据；计划和实跑结果交第二轮独立审查核对。
- 编写后、第二轮修复前，执行计划命令并持久记录真实结果。成功或失败都如实保留；命令不可用、超时或结果未知不能继续。
- 第二轮修后回归和审后回归都执行原命令及补测命令，全部通过才可继续。只需补测试时，修复可记录业务代码无新增变化，不要求制造无意义改动。

命令须实际覆盖所列新增或扩展的测试；声明不能代替执行。补测理由、选定发现、编写摘要、修订前结果、
修后结果都进入第二轮交接、审查和收尾档案。审查者核对断言是否补足发现，不能把无关命令成功当覆盖证明。

## 调用顺序

在原运行发送 `prepare_revision`，附以下 `tests`；需要原 `--allow-repair`。已到 `revision_prepared`
且尚未修复的旧运行也可追加这份计划，原准备记录不改写。计划一旦登记，不能换计划或重置轮次。

```json
{
  "requestId": "prepare-tests",
  "operation": "prepare_revision",
  "tests": {
    "testFiles": ["tests/boundary.test.mjs"],
    "command": ["node", "--test", "tests/boundary.test.mjs"],
    "reason": "覆盖补充：第一轮遗漏空输入，新增断言核对该边界；不把此次运行声明为原始红灯。",
    "findingIds": ["F1"]
  }
}
```

使用 `cm-fix-drive.mjs` 时，将同一对象放在驾驭员计划的 `revisionTests` 字段；它只在
`prepare_revision` 时转交 `tests`，不会修改已绑定的运行配置。

| 返回阶段 | 下一操作 | 所需原启动权限 |
| --- | --- | --- |
| `revision_test_author_required` | `author_tests` | `--allow-test-author` |
| `revision_test_check_required` | `revision_test_check` | `--allow-regression` |
| `revision_prepared` | `repair` | `--allow-repair` |
| `revision_regression_required` | `regression`，之后沿原复盘、交接、第二轮审查、审后回归和收尾 | 各操作原权限 |

同仓保护模式继续使用 `protected-text-v1`：测试编写只返回限定路径的编辑提案；宿主按原摘要写入。
只有已登记补测的第二轮 `fix_repair` 请求含 `allowUnchanged:true` 时，才允许 `repaired` 搭配空 `edits`。
补测本身仍须产生实际测试变化，不能用空提案冒充补测完成。

## 根因审查与恢复边界

根因审查仍绑定全部 `affectedPaths` 的原始文件字节，包括参与诊断的测试。若后续 test-author
合法修改其中的测试，宿主核对“受审原字节 → 编写前快照 → 已登记编写结果 → 当前文件”的关系；
仅认可该次编写的精确变化。业务源码变化、未登记修改或原审查凭证变化仍阻断，不把测试整体排除出根因包。

测试编写、执行或修复登记后丢失结果，保持 `unknown`，不自动重派、回滚、换 taskId 或重置审查轮次。
未登记的手改保持漂移阻断；同 taskId 的已审证据仍受 `fix_evidence_name_taken` 保护。此路径不支持
纯视觉测试、不增加第三轮、不解除已有命令失败或证据损坏，也不允许修改运行配置来绕过检查。
