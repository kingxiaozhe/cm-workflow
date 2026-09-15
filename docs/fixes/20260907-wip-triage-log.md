# Fable JS workflow WIP 体检记录

本记录整理自 `fable5.1-js-workflow` 的 `34adedb`，其体检对象是 WIP 提交
`e9450efce760cf2d5996a45fe7bf00b59236beae`。它不是 main 的测试结果、修复完成证明或独立 Review 凭证。

## 原报告记录的结果

| 检查 | 原报告结果 |
| --- | --- |
| JavaScript 语法 | 69/69 |
| 五个核心 runtime 模块导入 | 5/5 |
| runtime 机械一致性 | PASSED |
| 实验目录测试 | 报告记录 828/1403 通过、575 失败 |

本次整理没有重跑上述检查，也未独立确认完整测试计数。原报告说明输出经过截断，
仅按 traceback 抽样分类，不能据此估算各类失败数量或产品功能失败比例。

## 可核查的问题线索

- WIP 测试通过 `runpy.run_path` 加载 Python harness，并读取 `write_handoff`、
  `write_review`。本次查看的原有日志包含 `KeyError: 'write_handoff'`，说明至少部分测试
  在准备 fixture 时就失败。应先核对测试与 harness 的接口，不能直接认定产品执行失败。
- 原报告还记录 `420 !== 1444` 等断言失败。其根因尚未核实；不能将数值差异直接解释为
  文件字节数变化，也不能把抽样中的字段差异认定为所有失败的共同原因。
- 语法、模块导入、关键字命中与机械一致性检查覆盖不同问题；其中一项通过不能代替行为测试。

## 与 main 的关系及处理结果

main `2de4775877537c4193a80dc470b8eb54fd63c6c7` 已包含另行整理的 JS 迁移及后续修复。
Fable WIP 尚缺少该 main 的 CI action SHA 修正、部分日志事件兼容和任务完成 projectRoot 接线。
这是分支内容差异；三方合并的具体结果仍取决于共同祖先与冲突处理。

本次仅将这份经校准的历史记录提取到 main 基线：

- runtime、scripts、Skills、安装器及项目规则继续使用 main 的版本。
- 宣传文章、封面图片、草稿接口结果保留在原分支，不作为 Workflow 功能变更引入。
- 原报告提出的三条候选教训未晋升为 AGENTS 指令；没有引入任意失败率阈值或扩大测试要求。
- 原分支与原报告保留，便于追溯。未声称上述实验测试失败已修复，也未据此关闭真实任务验收。

main 合并提交的既有 CI：
[run 34069120477](https://github.com/kingxiaozhe/cm-workflow/actions/runs/34069120477)。
该 CI 覆盖其配置的任务，不代表上述完整实验测试套件通过。

学习复盘：沿用“未验证猜测不成为项目指令”的现行 Learning 合同，无新增项目教训。
