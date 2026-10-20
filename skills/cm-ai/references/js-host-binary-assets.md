# 受保护二进制资产

当前会话、单代码根、非 bootstrap 的新任务可以显式声明二进制资产。它仍使用原批准 scope、受保护沙箱、独立 Review、完成检查及原运行恢复；没有直接写产品代码的替代入口。旧文本配置和旧运行保持原字段与摘要，不为在途任务静默附加能力。

## 启动输入

在原 `--protected-conversation-config` 文件的 `{checkCommands,timeoutMs}` 中增加：

```json
{"binaryAssets":{"version":1,"paths":["assets/fonts/rounded.ttf"],"sourceRoot":"/private/tmp/task-answers"}}
```

`paths` 必须是本任务已批准 scope 内的明确路径，不可与 requirements 重叠。只接受字体、图像、音视频资产后缀；项目指令、脚本、隐藏路径不允许通过资产通道写入。二进制写入为0644；不得设为可执行。

`sourceRoot` 必须是代码根与 specs 根以外、互不包含的规范绝对目录，所有路径层级不得经过符号链接。driver 使用时它必须等于 `PLAN.answers` 的 realpath。源文件可以在原作者的临时提案目录准备；维护方不能借此替产品 owner 写代码。

`develop.json.edits` 沿用原路径到答案文件的映射。例如 `{"assets/fonts/rounded.ttf":"files/rounded.ttf"}`。driver 读取文件原字节，提交有界引用；不是把字节当 UTF-8 字符串或把大 Base64 塞进宿主输入。

当前会话宿主的结构化响应中，声明的资产使用：

```json
{"path":"assets/fonts/rounded.ttf","beforeSha256":null,"asset":{"path":"files/rounded.ttf","sha256":"{64位小写SHA256}","size":12345}}
```

`asset.path` 相对于冻结 sourceRoot；不得提交任意绝对路径、URL 或链接。`beforeSha256` 使用宿主刚给出的 expected 值；删除仍用原 `{path,beforeSha256,content:null}`。文本文件保持原 content 合同。资产路径不能用文本 content 绕过资产校验。

## 字节与记录

每文件最多128MiB，每原运行的资产存档共256MiB，最多32个声明路径。原版本、新版本和审查后修改轮的不同内容都计入同一个存档预算，不通过新轮次清空额度。最多128个不同 blob。文本单文件、文本审查材料、宿主输入及 journal 控制记录预算保持原值。

owner 把精确字节存入 specs 下 `.reviews/.binary-assets/{repositoryId}/{runId}/{sha256}`，目录私有0700、文件0600；审查包和 journal 仅携带绑定路径、大小、权限、SHA 与 `contentBlob`。这些引用不能替代真实字节校验。恢复、Review、完成门禁会读取并核对实际存档；缺失、篡改、硬链接、符号链接或来源漂移均阻断。

应用仍由原固定沙箱执行。全部提案预检先于写入；进程中断或部分应用失败仍保留原 ambiguous/unknown 恢复规则，不宣称整个多文件操作是事务或自动回滚。不可手工改 state、补 PASS、清锁或重建运行。

## 审查与续行

新建单任务可明确选择 Claude 或 Codex 审查端；Codex 当前会话用已有 `--review-runtime codex` 和通过预检的具体 Codex review 配置，在本 run 冻结该选择。显式二进制任务可覆盖项目的 Claude reviewer 选择，但保留已声明的 Codex coder，不修改项目或个人默认；不适用于在途 binary run 切换、provider/bootstrap/batch/多 root。缺少对应工具时阻断，不自动切换。每次 Review 在同一具体模型上重新预检隔离工具，只允许登记文件读取、资产字节读取及固定资产完整性检查。每个原版本/新版本的真实读取和检查通过均由工具记录，文本 approved 不能放行。仅资产审查无需人为添加无关文本变异；cm-fix 的既有变异门禁保持不变。

工具每次最多返回16KiB字节区间，并绑定整文件摘要；实际字节留在私有副本。原检查、fresh reviewer 身份和完成门禁继续生效。工具证据保存到 `.reviews/.binary-review/{repositoryId}/{runId}`，绑定原调用和实际 reviewer thread；恢复、审查发布及完成时重新核验，不把这份证据当作另一个批准入口。

固定完整性检查只验证精确字节、大小与基本格式头。字体的来源许可、轴、字形覆盖、包体及应用加载还须通过产品任务原验收，单纯 SHA 相同或格式头正确不等于这些业务验收通过。

恢复重用原配置、sourceRoot、声明路径、runId 和历史。禁止为旧运行更换保护模式或篡改原配置；若旧任务未获此能力，保持阻断，由正式入口处理。正式安装及隔离验证通过后，才通知原业务 owner 使用新能力。

Codex 原生验证使用只读隔离副本和固定 `cm_review` 三工具。Responses Lite 的 `input.additional_tools` 与普通工具目录都必须核对。当前 CLI 的 CodeModeOnly 仍声明 `exec/wait/request_user_input_async`：前两项由禁用的 session provider 在 JavaScript 执行前拒绝，异步消息只作用于审查会话，worker 对任何非固定 MCP 调用仍拒绝本次审查。不得开放 shell、通用执行宿主、其他 MCP 或子 agent 来绕过。二进制工具的只读 annotations 仅用于已固定的字节读取和宿主完整性检查，`mutate_check` 不暴露；不影响原 cm-fix 变异合同。审查进度文字不作结果，只在 turn 完成时读取最后的 JSON，之后仍核对包、实际读取、检查与回执。

新建二进制任务的 `preflight` 只读核对显式 sourceRoot、scope、源文件稳定字节、SHA、大小和文本材料。它不提前发布资产或创建运行。报告中的文本容量投影不是完整二进制审查包：`capacity.fits:null`、`binaryArchiveVerified:false` 表示存档累计容量和完整包仍未知；不能据此宣称检查、审查或完成可通过。正式驾驶员和 owner 沿原二进制归档、完整精算、审查及恢复门禁重新核验，任一失败仍停止，不改配置上限或绕过保护。
