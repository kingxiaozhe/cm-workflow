# 原运行的 Jest 配置发现更正

本入口只处理固定的 Jest 启动错误：从仓库根执行 `jest/bin/jest.js`，已有 `--rootDir` 指向子项目，但未显式指定子项目的 Jest 配置。它在原 run 追加一条有界更正记录，使同一组检查使用追加的 `--config`；不修改原配置文件、指纹、旧 journal 记录、源码或测试断言，不放宽失败签名、修复 scope 或独立审查门禁。

## 资格和范围

- 原运行处于 `red_test_not_confirmed`，正式红测结果为 `not_red`，退出码为 1、业务失败签名未匹配；保存的 stderr 必须是实现所识别的 `Could not find a config file based on provided values`，且绑定原命令 cwd。输出须完整、实际结果为 failed，且 stdout/stderr 均不含 Jest 的 `Test Suites:` / `Tests:` 汇总；普通业务失败、无关加载错误、超时或截断结果不适用。
- 最新记录必须是原 `fix-red-test-result`，此前没有 `fix-command-correction`。每个 run 仅有一次更正机会；不能撤销记录后重用，也不增加审查调用预算。
- 当前不接受 QA 子运行、externalModels 或 executionPolicy 配置。保留原 repositoryId/runId/taskId/attempt、宿主和 reviewer、模型及历史。
- 声明仅接受 `{"kind":"jest-config-path","path":"mobile/package.json"}`。路径相对于代码根，文件须为安全普通文件，内含对象形式的 `jest` 配置；符号链接和越界路径拒绝。配置文件不能同时是修复 scope、红测或 baseline 声明的测试文件，避免后续合法修改与固定配置绑定冲突。
- 只选择原红测、baseline 和命令式 walkthrough 中尚未带 `--config` 的 Jest argv。每条命令必须从原复现 cwd 执行，且已有 `--rootDir` 精确指向该 package.json 所在目录。更正仅在 argv 末尾追加 `--config` 与该相对路径；非 Jest 命令和已有配置的命令保持原样，不接受调用方提供替换 argv。原参数含 `--` 分隔符或 `-c` 配置别名时拒绝准备，避免追加无效或重复配置。
- `expected` 绑定原配置、完整历史、红测结果及输出摘要、配置文件元数据、派生命令、`reviewVerification.files`、`repair.scope/requirements`、红测测试文件与配置文件的快照及模式位。预览之后任一绑定变化均停止；原包没有记录的旧源码内容不能据此补称已验证。

## 正式步骤

1. 关闭旧宿主及检查进程，核对原现场。先执行只读资格预览：

   ```bash
   node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-command-correction.mjs" \
     --config "{FIX_CONFIG}" --jest-config mobile/package.json
   ```

   `FIX_CONFIG` 沿用原文件。成功返回 `eligible:true` 和完整 `expected`；失败返回 `eligible:false` 与代码。此入口不打开 writer、不执行检查、不写原状态或日志、不调用 Claude。预览和摘要不是授权，也不自动证明所有旧后代进程已停止。

2. 取得本次更正授权后，原驾驶员 PLAN 使用 `mode:"resume"`、当前真实 `hostContext`，换会话时保留正确的 `originalHostContext`。保留原 config、runtime、reviewRuntime、reviewConfig，增加以下本次操作字段：

   ```json
   {
     "permissions": ["--allow-command-correction"],
     "expected": {"说明": "逐字使用最新预览返回的完整 expected 对象"},
     "commandCorrection": {"kind":"jest-config-path","path":"mobile/package.json"},
     "previousInvocationStopped": true,
     "reason": "说明原 Jest 配置发现错误、停止核对及本次更正授权"
   }
   ```

   `expected` 中的说明仅占位，不是可执行值。`reason` 为非空单行，最多 1000 UTF-8 字节；`previousInvocationStopped:true` 是真实停止核对后的声明，不能盲填。准备无需答案文件，不会反问或调用 provider。执行：

   ```bash
   node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-drive.mjs" \
     --plan "{PLAN}" prepare_command_correction
   ```

   直接宿主同名 operation 接收 `expected`、`commandCorrection`、`previousInvocationStopped` 和 `reason`；启动必须使用 `--mode resume --allow-command-correction`，原 `--allow-reproduction` 等宿主基础要求仍保留。不得通过修改旧配置文件、手写 state/journal 或另开 run 应用更正。

3. owner 重查当前资格并比较完整 `expected`，只追加 `fix-command-correction`，保留原失败结果，阶段返回 `red_test_required`。准备本身不运行红测、不修改业务代码、不产生红灯成功或审查结果。重复准备返回 `fix_command_correction_used`，不能将已用预算当成幂等成功。

4. 移除本次准备字段和 `--allow-command-correction`，按当前阶段单独授权 `red_test`。运行使用更正后的 argv 和原失败签名，新的红测证据另存，不覆盖原启动错误输出。更正占用红测 retry-1；后续红测最多到 retry-8。到达上限后拒绝继续放弃或追加更高序号，旧记录不重写。只有真实业务红灯匹配后才能进入 baseline、最小修复及回归。

5. 后续 baseline、regression、post-review regression 和命令式 walkthrough 均使用同一正式命令覆盖层；原始配置仍保留。handoff 与最终独立 Review 须看见更正后实际执行的命令和证据。更正不免除最终 Claude 审查、N5、走查或 finish，也不授权 Git、发布或依赖安装。

## 停止条件

| 代码 | 含义与处理 |
| --- | --- |
| `fix_command_correction_unavailable` | 阶段、失败证据或运行类型不适用；保留原现场。 |
| `fix_command_correction_config` | 配置文件内容、路径或原 argv 不满足限定形状；不改命令迁就入口。 |
| `fix_command_correction_used` | 唯一更正记录已存在；沿已记录路径推进，不能再准备。 |
| `fix_command_correction_stale` / `fix_command_correction_binding` | 预览目标或历史绑定不一致；停止并只读核对，不手改摘要。 |
| `fix_command_correction_drift` | 配置文件或相关源码快照漂移；不能复用旧预览或跳过原审查。 |
| `fix_command_correction_confirmation` / `fix_command_correction_authorization_required` | 缺停止声明、合法原因或启动授权；不把 expected 当权限。 |
| `fix_abandon_limit` | 红测重试序号或原放弃额度已用尽；保留原运行，不生成 retry-9。 |
| `fix_jest_config_path_required` | 新运行创建前无法发现 Jest 配置；在冻结前明确配置真实命令，不创建一个已知无法启动的 run。 |

此次更正后的红测仍无法匹配原业务失败时，保留真实结果并停止。不得把诊断重跑当作 owner 的正式红灯凭证，不删除历史、不改断言或无限重试。

保证边界：本入口核对来源声明和摘要，不证明人或模型的身份，也不抵抗同权限 shell 有意伪造。旧版运行时不认识新追加的记录；应用更正后须继续使用支持本入口的版本，不支持降级恢复。
