# Claude 隔离检查与变异验证

这是新建 cm-fix 运行的可选能力。执行宿主仍由 `--runtime` 如实标记；审查工具仍由 `--review-runtime` 与项目角色确定。只支持 Claude reviewer，保留原根因审查、最终审查、凭证登记、发布和完成门禁。

## 创建与预检

在运行定义 JSON 中增加 `reviewVerification`，不是在 review.json 或驾驶计划里再加一份配置：

```json
{
  "reviewVerification": {
    "files": ["src/value.mjs", "tests/value.test.mjs", "package.json", "AGENTS.md"],
    "checks": [{"id": "value", "command": ["node", "--test", "tests/value.test.mjs"]}],
    "mutationPaths": ["src/value.mjs"],
    "timeoutMs": 60000
  }
}
```

- `files` 是明确登记的相对路径，最多 256 个、每文件 2 MiB、总计 16 MiB。包含运行测试所需的全部源码、测试和配置，以及审查包中对应的 requirements/instructions。后续将创建的文件可以先登记，缺失状态也进入快照；每次审查取当时真实内容，不伪造空文件。
- `checks` 最多 8 项，使用固定 argv；无 shell 插值。每项必须退出 0 才通过。不要把原缺陷复现的预期失败命令直接当成成功基线。
- `mutationPaths` 只列可改坏的实现文件，不包含测试、指令或配置秘密。精确替换必须唯一命中，不能修改测试让变异通过。
- `timeoutMs` 是每次命令预算，最大 300000ms。审查整体仍受 review.json 的原预算约束；不会自动加时。

从当前已加载插件根 `{CM_ROOT}` 运行真实本地合成预检：

```bash
node "{CM_ROOT}/scripts/cm-fix-review-preflight.mjs" \
  --config "{运行定义.json}" --model "{Claude模型}" > "{review.json}"
```

外部模型配置使用原来冻结的 Claude model/effort，并把同一个 effort 传给本命令的 `--effort`。预检只把合成请求发到本地回环端点，检查实际 CLI 暴露的三个 MCP 工具和 StructuredOutput；不调用审查、不证明账号已登录。旧无工具诊断不能用于此模式。

之后沿用 `cm-fix-host.mjs serve` 或 `cm-fix-drive` 的原启动命令和动作授权。无需新增驾驶参数。QA 子运行同样从它自身的 configuration.reviewVerification 与 reviewer 配置读取，不继承另一运行的证据。

## 实际行为与证据

Claude 原生 Bash、Edit 等工具仍关闭。仅允许 `cm_review.read_file`、`run_check`、`mutate_check`。CLI 使用 restricted、空设置来源、禁 hooks/plugins/auto-memory 与固定 MCP 配置；safe-mode 会禁用显式 MCP，因此仅新模式换用这组参数。工具不接受任意命令或任意路径。

`read_file` 只读登记副本，每页最多 16 KiB UTF-8 内容；省略 `offset` 从 0 开始，小文件仍一次返回完整 `content`。`offset` 与返回的 `nextOffset` 均为 UTF-8 字节偏移，必须落在字符边界；继续传入 `nextOffset`，直到返回 `null`。`totalBytes` 是完整文件字节数，`sha256` 始终是完整文件摘要；分页不更换副本，每次仍核对完整清单的路径、模式和摘要漂移。单次审查最多 32 次工具调用的预算不变，按相关代码选择页，不承诺读遍全部最大文件；不得把未读页当作已审查。

派发并登记审查前先核对路径、大小、包 SHA 和 mode；可预判的材料错误不消耗审查轮次。宿主再将登记文件复制到一次性目录。项目检查使用独立进程和 macOS OS 沙箱：临时 HOME/TMPDIR、传给命令的环境里没有认证变量、禁止网络、禁止读副本外个人文件、禁止写原源码/规格/证据。只开放必要系统运行库，并禁止 Mach 服务查找，避免系统服务代为访问副本外数据。同时禁止进程信息查询和 `kern.proc` 开头的系统参数读取，已实测：副本里的原生程序无法再经 `KERN_PROCARGS2` 读到宿主或其他同用户进程的启动参数与环境变量（宿主环境里可能有凭据）；libproc、task port 等其他接口没有逐一验证；整类禁止系统参数读取会让 Node 启动即崩溃，所以只禁这一组。宿主改写副本文件（变异写入与精确恢复）也在同一沙箱里执行，并且不跟随最后一级的符号链接，所以副本里的路径即使被换成指向外部的链接，也写不到副本外。命令结果有输出及时间上限。每条命令前后清除未登记产物，登记文件发生变化仍拒绝，防止缓存或残留影响下一次检查。

变异按「原版通过 → 定点改坏 → 同一检查失败 → 精确恢复 → 恢复后通过」执行。超时、信号中止、沙箱失败不算变异被检测到。后续检查失败会使对应旧成功证据失效。宿主在结束时再次核对原文件和副本，才将机械证据作为 `verification` 写入原审查 result，绑定请求、包、配置、真实 reviewer thread、文件清单、命令、退出码、有限输出摘要与恢复摘要。模型审查 JSON schema 不变，也不能用文字自报替代这些记录。

## 兼容、失败和边界

- 没有 `reviewVerification` 的旧运行继续原无工具 worker、预检和回放。不能在已有运行上补、删或改此字段；原指纹拒绝该变更，不迁移 journal，不重置轮次。
- 新模式缺少有效证据时不得接受成功审查；原 V3 失败/unknown 恢复规则仍适用。不把旧无工具 reconciliation 回执用于补齐新模式执行证据，不重新解释历史 approved。
- `review_verification_provider`：所选 reviewer 不是 Claude。`tool_preflight_missing`：配置与诊断不匹配。`review_verification_isolation_unavailable`：当前平台无受支持隔离。先修正新运行输入或环境，不改历史来绕过。
- `review_verification_package_binding`、`*_source_drift`、`*_copy_drift`：包与材料不一致。`*_baseline_failed`、`*_evidence`：实际检查或恢复没有满足合同。保留原结果，按原审查恢复入口处理，不能人工填成功。
- 当前只验证了 macOS 上的自包含命令。Linux/Windows 不降为直接执行。副本禁止 node_modules 和凭证目录；依赖下载、Xcode/模拟器服务、数据库或外部网络测试不在已验证支持范围。所需工具链/依赖不可访问会真实失败，不能据此声称 Wue 真机或 iOS 验收通过。
- 有界清理覆盖所拥有的进程组与登记中的命令组；不声称能找回任意敌对代码自行创建新 session、关闭全部管道的后代。**已知限制**：这样的后代在命令返回后可能仍然存活，命令结果照常返回，不会因此报失败。它仍受同一沙箱约束：不能读取未获允许的副本外文件，不能经上述接口读其他进程的环境，也写不到副本外；但它可以继续改动副本，登记文件被改会在下一次检查前后以副本漂移拒绝，未登记产物每条命令前后清除。命令组清理未知时拒绝本会话后续工具调用与成功证据，保留原进程登记，不允许新命令覆盖。清理未知不会记作成功；保留私有副本并输出 `review_verification_cleanup_unknown` 与保留路径，使用日志仍记录失败收尾。一个派发只允许一个 MCP 服务实例；重启或并行实例明确拒绝，不能清空或混用证据。
- 门禁防手滑与过期证据，不承诺抵抗拥有同等完整文件系统权限的会话伪造。隔离测试通过也不等于批准业务需求、安装或发布。
