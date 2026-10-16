# 原运行已编写测试的限定类型更正

此入口只修复原 owner 已编写测试中的回调参数类型遗漏。它不增加业务修改范围、不改测试断言、不替换测试命令，也不把旧失败改成通过。用于已取得真实红灯、业务修复后红测已通过，但原冻结 TypeScript 检查仍被测试本身的隐式参数类型错误阻断的运行。

## 资格和证明边界

- 原运行处于 `regression_blocked`，已有 owner 编写测试记录与 `red_confirmed`。当前修后红测已通过，baseline 的阻断符合实现限定的原冻结 `tsc --noEmit` 退出 2 形状；普通业务回归或未知结果不适用。
- 尚未登记最终独立审查。保留原 repositoryId/runId/taskId/attempt、配置、指纹、检查命令、修复 scope、红灯和 baseline 原结果。
- 只更正原已编写的 `.spec.ts/.spec.tsx/.test.ts/.test.tsx` 测试文件，声明种类为 `callback-type-annotation`。只能在指定回调参数处插入明确的结构类型或已有类型别名，不能使用 `any` 或 `unknown`，不能改表达式、断言、mock 行为、业务实现或文件后半部分。
- 更正证明对含目标完整行的 JSX 前代码前缀运行 Node `stripTypeScriptTypes` 的 `transform` 模式，更正前后运行时代码必须逐字节一致；剩余后缀保持原字节。该证明支持“仅类型修改”，不能代替真实回归和最终独立审查。
- 每个 run 仅有一次类型更正预算。它独立于 `rerun_blocked_step`，不增加该步骤的重跑上限，也不增加审查调用次数。

## 正式步骤

1. 保留原现场，确认旧宿主及检查调用已经停止。此证明需要 Node 24+ 的 `stripTypeScriptTypes`；不可用时保持阻断，不安装依赖或换一套证明。按当前实际模块合同准备声明 JSON 文件：

   ```json
   {
     "kind": "callback-type-annotation",
     "path": "src/feedback.spec.tsx",
     "beforeSha256": "{当前文件精确SHA256}",
     "line": 3,
     "parameter": "c",
     "annotation": "{ props: { style?: object } }"
   }
   ```

   这是声明形状示例，路径、摘要、行号、参数名与类型均须来自当前真实目标；摘要占位符不是可执行值。`line` 从 1 开始，指定行必须恰有一个未标注、未加括号的目标箭头参数，例如 `rows.map(c => c.props.style)`；证明包括该完整行及之前前缀，不能截断语句或跨入 JSX。`parameter` 是 ASCII 标识符；`annotation` 非空、单行、最多 256 UTF-8 字节，并受实现的类型安全约束。声明不接受额外字段、任意替换代码、注释或类型断言。

2. 只读资格预览：

   ```bash
   node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-test-type-correction.mjs" \
     --config "{FIX_CONFIG}" --declaration "{TYPE_DECLARATION}"
   ```

   沿用原配置文件。成功返回完整 `expected`；资格预览不写原文件、state 或 journal，不运行 provider，也不授权后续更正。预览建立的绑定不证明旧后代进程已自动核实停止。

3. 取得本次限定类型更正授权后，原 PLAN 使用 `mode:"resume"`，保留原运行、runtime、reviewRuntime、reviewConfig 和真实会话身份。换会话时使用既有 `originalHostContext` 合同。设置：

   - `permissions` 含 `--allow-test-type-correction`，只开启本次阶段所需权限。
   - `expected` 为最新预览返回的完整对象，不能挑字段、手造摘要或复用旧目标。
   - `testTypeCorrection` 为声明文件解析后的完整对象。
   - `previousInvocationStopped:true`，必须是实际核对后的停止声明。
   - `reason` 说明错误、类型插入范围及本次授权原因。

   执行：

   ```bash
   node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-drive.mjs" \
     --plan "{PLAN}" prepare_test_type_correction
   ```

   原生宿主同名 operation 接收 `expected`、`testTypeCorrection`、`previousInvocationStopped` 和 `reason`；启动必须是 resume 并带 `--allow-test-type-correction`。原宿主的基础权限和身份要求仍然生效。

4. owner 核对最新绑定，先追加 intent，再原子应用类型插入，最后追加 result。原红灯输出、baseline 结果、原配置与历史不重写。更正完成仍处于 `regression_blocked`，不会自动重跑、写入通过结果或派发审查。

   若准备在中途崩溃，只能以原完整 `expected`、同一声明和停止确认恢复。目标文件必须精确等于已登记的 before 或 after，第三种内容拒绝；不能换声明再消费一次预算，不在 owner 外手动回退或补写证明。

5. 移除本次准备字段和专用权限，按原合同单独授权 `rerun_blocked_step`：PLAN 使用 `--allow-rerun-blocked-step` 和解释已处理原因的 `reason`。此操作保留失败结果，仅回到原回归待执行阶段；随后另以 `--allow-regression` 执行 `regression`。

   TypeScript 旧结果为退出 2，而当前真实检查退出 0，可按既有 baseline 合同记录 `now_passed`；不能改旧退出码、改命令或把类型证明直接作为检查通过。

6. 新文件摘要仅能通过 owner 验证的类型证明进入红测文件核验；修复范围外的差异仅限该证明所绑定的测试类型修改。最终 handoff 须披露原红灯及限定更正证明，保留运行时语义不变的证据。

7. 继续原复盘、Learning、handoff、最终 fresh Claude 独立审查、N5、审后回归及 finish。类型更正和回归通过都不等于最终批准，不授权提交、推送、发布或安装依赖。

## 必须停止的情况

无原 owner 测试或真实红灯、修后红测未通过、baseline 不是限定类型检查失败、最终审查已经登记、更正机会已使用，均不能使用本入口。预览后配置、原历史、源码、文件模式或目标字节漂移时停止并保留证据。类型消除前后不一致、后缀变化、插入包含宽泛类型或改动断言时拒绝；不得通过改摘要、重新开 run、删历史或放宽比较解除阻断。

先读取实际拒绝代码与当前 stage，再按适用合同处理。未知结果不自动重派。本文是正式入口说明，不证明特定项目已执行更正、回归或 Claude 审查。
