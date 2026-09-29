# 当前会话作为 JS workflow 工具宿主

规格待审批时先展示摘要卡并请用户回复“开始”。`approvalIntent` 仅把“开始”“开始吧”
“可以开始”“确认开始”“开始执行”“现在开始”（允许尾部中英文句末标点与空白）视为
明确开始；“继续”“可以”“好”“好的”“OK”“按最优解处理”“你看着办”“行”仍不审批。
`not_approval` 时提示明确回复“开始”；写审批位仍须原 `--approve` 门禁。

## 当前会话手动驱动：用驱动脚本，不要自己搭 FIFO

普通单任务和 bootstrap 骨架 T-001、规范任务（通常 T-002）用 `cm-ai-drive.mjs`，批次用 `cm-ai-batch-drive.mjs`；修复用 `cm-fix-drive.mjs`，规格编写用 `cm-prd-drive.mjs`。它们负责保持宿主 stdin、应答反问并按 callId 配对结果，无需后台保活 FIFO。规范任务按下文[用单步驾驶员](#bootstrap-规范任务用单步驾驶员)准备答案文件；批次驾驶员仍不支持规范任务，启动前退出 2。`cm-ai`、批次和 `cm-prd` 驱动的 `--help` 列出计划字段；普通单任务最小调用：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-drive.mjs" --plan "{PLAN.json}" advance
```

先按下节准备计划及真实答案文件。计划中的 `checks` 须为实际可执行的命令；驱动不接受静态检查结果代替执行。

## 单步驾驶员

仓库自带 `../../../scripts/cm-ai-drive.mjs`，按上例一次启动宿主、发送一个 operation、回答这一轮的反问并打印结果。

`PLAN.json` 与 cm-fix 驾驶员一样，以自身目录解析相对路径；填写 `config`（已批准的运行定义）、
`mode`、当前真实 `hostContext`、`runtime`、原样传给宿主的 `permissions`、`answers` 和
`checks: [{"id":"syntax","command":["node","--check","target.mjs"]}]`。同会话恢复可省略
`originalHostContext`；换会话恢复必须填创建运行的会话 ID，且运行存档必须已存在。第 1 轮开发结果放 `answers/develop.json`（也可用
`develop-a1.json`，两者不能同时存在）；第 2 轮只读 `answers/develop-a2.json`，绝不复用第 1 轮答案。
`edits` 把批准 scope 内路径映射到答案目录里的 UTF-8 内容文件。初次 `create` 或恢复到
`ready` 第 1 轮时，若 `advance` 同时带 `--allow-review-attempt 1`，审查后可能直接进入第 2 轮开发；
缺 `develop-a2.json` 会在启动前退出 2。尚未看到首轮 findings 时，从 `PLAN.permissions` 移除该审查授权，
先 `advance` 到 `awaiting_review`，再以运行返回的 `packageDigest` 执行 `decision`；读取
`.reviews/<feature>-<task>-r1.md`，如需修改则写好 `develop-a2.json` 再 `advance`。
若有意一次完成，也可预先写好 `develop-a2.json` 后带审查授权运行。
若第 1 轮已经待审且计划带
`--allow-review-attempt 1`，`advance` 可能在同一次调用中进入第 2 轮；缺 `develop-a2.json` 时会在
启动宿主前退出 2，并提示当前 `packageDigest`。此时先以该 digest 调用 `decision` 单独运行审查，
读取 `.reviews/<feature>-<task>-r1.md` 的 findings，针对 findings 写好 `develop-a2.json`，再调用
`advance`。其余人工文件为
`qa-assess.json`、`documentation-inspect.json`、`documentation-sync.json`；QA 修复子运行沿用
cm-fix 的 `learning.json`、`diagnosis.json`、`test-edits.json`、`repair-edits.json` 和
`retrospective.json`；修订轮的测试和修复分别读取 `test-edits-a2.json`、`repair-edits-a2.json`。
缺答案、结构错误、路径或存档无效会在启动宿主前退出 2。

当单次 `develop` 回答超过默认 64 KiB 时，在单任务或批次 `PLAN.permissions` 传
`["--input-limit","1048576"]`；上限为 4 MiB（4194304 字节）。这是宿主输入传输限额，
不改变运行定义或恢复指纹；恢复时可调整。

`check` 只运行计划里的真实命令；原始输出打印到驾驶员 stderr，宿主只保存实际退出码和精简证据；静态 `check.json` 不会被读取。单任务和批次 PLAN 可设 `checkTimeoutMs` 作为检查默认超时，每个 `checks` 条目可设 `timeoutMs` 覆盖；均为 1..3600000 的整数毫秒，省略时驱动默认 900000（15 分钟），启动前校验。宿主 `host-check` 对其他调用方的默认值仍是 60000。失败或不可用的检查会在开发阶段停 `blocked/develop_checks_not_passed`，`reason` 列出检查 id 与证据摘要；修复环境后在原 run `advance` 会重新开发和检查，不消耗独立审查轮次。旧运行在完成阶段的 `blocked/checks_not_passed` 保持终态，不能重新开发。
驾驶员收到 `state: "unknown"` 或 `pendingAction: "reconcile"` 的宿主结果时退出 1，并保留原输出供原 run 恢复；不能把有结果的 JSON 当成成功。
独立审查批准后，完成前会再次运行相同检查。`evidence` 摘要文字变化且检查 `id/command/outcome/exitCode` 不变时可完成；代码、handoff 或检查身份漂移为终态 `blocked/package_mismatch`，越界 scope/需求漂移保持 `blocked/out_of_scope`。仅 `outcome/exitCode` 变化时为可恢复的 `blocked/completion_checks_changed`：先修好检查环境，再用原 runId、原配置 `--mode resume` 执行 `advance`（或 `complete`）；新 complete effect id 重跑检查，原 Review 回执与 packageDigest 不变，不新开 run 或重审。旧 journal 按原格式回放，重试仍受 effect 上限约束。
`qa_logic`、`qa_browser`、`verification_precheck` 没有可信本地 runner。单步驾驶员对本任务完成后适用的 logic case 预检 `qa_logic`，包括已被 QA 命令 `caseIds` 覆盖的 case（当前 executor 仍会请求）；只对适用、`expected` 不含 `[需确认]` 的 browser case 预检 `qa_browser`。预测需要 runner 时仍在发送前拒绝，`verification_precheck` 规则不变。
本次适用的用例里有 logic 类（或无 `[需确认]` 的 browser 类）时，驾驶员完成不了这一步 QA：由当前 AI 会话以 `serve` 启动宿主，按 N6 与 cm-qa-engineer 应答 `qa_assess`，以及宿主实际问到的 `qa_logic` 或 `qa_browser`；拿不到浏览器证据时 `qa_browser` 如实回 BLOCKED，不能省略不答；环境恢复后可在原 run 用 `--rerun-blocked-qa` 重跑这一轮 QA（见下方“已 complete 的宿主证据或环境阻断”）。即使 logic case 已被 QA 命令覆盖也不能跳过这一问：静态判断为 `CONTRADICTED` 时，除非另有阻断条件（`[需确认]`、宿主请求超时或源码漂移会改判为 BLOCKED），该用例判失败，哪怕命令全部通过。
受保护执行由原宿主处理检查；驾驶员不把人工填写的结果冒充执行证据。一次 `advance` 可能走过多个阶段，
驾驶员会按该宿主的请求路径提前检查本次可能用到的全部答案；只读 `status` 不需要答案。

批次使用 `../../../scripts/cm-ai-batch-drive.mjs`，调用方式同为 `--plan PLAN.json advance|status|cancel`。
`config` 指向批次宿主的 `{batch,workflows}` 定义；`answers` 下按 `feature/taskId/` 放每个任务的
`develop.json`（第 1 轮可改用 `develop-a1.json`，不得并存）、`qa-assess.json`、
`documentation-sync.json`、`documentation-inspect.json`；第 2 轮开发必须另放 `develop-a2.json`，
`checks` 按 `feature/taskId` 映射真实命令数组。驾驶员在发批次指令前检查所有任务的答案、
scope、命令及恢复存档。批次宿主没有 `--original-host-context`，恢复必须沿用原 `hostContext`；
不能用它接管另一会话。批次的 `qa_logic`、`qa_browser`、`verification_precheck` 与 bootstrap
`init_verify` 需要驾驶员尚无的真实执行 runner，命中时启动前退出 2。受保护配置里的检查由宿主执行。

### bootstrap 规范任务用单步驾驶员

适用于纯规范 scope（恰为 `cmInitRuleTargets(selection)` 的全部目标）、单代码根、不带 `--protected-config` 的 T-002；含业务文件、`codeProjects` 多根或 provider 开发的规范任务启动前退出 2，改走下节当前会话宿主路径。完成 T-001 骨架及其独立审查后，为 T-002 生成独立运行定义（`requirements` 可为空数组），`bootstrap.json` 放已确认的 cm-init selection。最小 PLAN：

```json
{"config":"t002-run.json","mode":"create","hostContext":"{当前真实会话ID}","runtime":"claude",
 "permissions":["--bootstrap-config","bootstrap.json","--allow-bootstrap-write","--review-config","review.json"],
 "answers":"answers","checks":[{"id":"xcode-list","command":["xcodebuild","-list","-project","App.xcodeproj"]}]}
```

规范任务不反问 `develop`，不需要 `develop.json`。当前会话先按 cm-init 主 Skill 第3至5节写好全部规范正文（放在答案目录内），再写两份答案：

- `answers/init-generate.json`：`{"status":"generated","documents":[{"path":"AGENTS.md","contentFile":"t002/AGENTS.md"},…]}`，逐项覆盖全部 targets（缺一不可、不能多），`contentFile` 为答案目录内的 UTF-8 普通文件。无法生成时不要启动驾驶员，报告缺口；`blocked` 会被拒绝。
- `answers/init-verify.json`：会话实际核对草稿后填写。`commands` 列出草稿里可安全实跑的命令 `[{"id","command","timeoutMs"?}]`（1..32 条，至少一条），驾驶员在宿主接受启动（`host_ready`：宿主已用自己的读取器核对全部启动输入、admission、任务选择与运行存档）之后、发送操作之前，于代码根逐条真实运行（超时与输出规则同 `checks`；带 `--protected-conversation-config` 时与宿主的任务检查一样在 specs 沙箱内运行，specs 与 AGENTS.md/CLAUDE.md/.claude 只读），任何一条未通过即退出 2、不发送操作；宿主问到 `init_verify` 时回报这次实跑的退出码作为 commands 组的 status/evidence；可选单行 `commandsNotRun` 说明未实跑的命令（如需模拟器的测试）及其依据，它只是会话说明，不是执行证据。`checks` 只写 `globs`、`file_references`、`constraint_preservation`、`rule_applicability` 四组 `{status,evidence}`，status 只能是 `verified` 或 `not_applicable`；不得写 `commands` 组或任何命令结果。`constraintChanges` 必须是 `[]`，`application`/`retrospective` 沿原 Learning 字段，例如 `{"status":"no_relevant_lesson","note":null}` 与 `{"status":"no_new_lesson","candidates":[],"reason":null}`。

第 1 轮也可命名为 `*-a1.json`（不能与无后缀文件并存）；第 2 轮只读 `init-generate-a2.json` 与 `init-verify-a2.json`，绝不复用第 1 轮答案。修订轮 AGENTS.md 必须逐字保留第 1 轮已写入的正文（宿主只把既有 `## 项目教训` 段按原字节合入，其余只能追加），其他规范文件可按 findings 改写；首轮有 Learning 回写时，AGENTS.md 中「## 项目教训」之前的正文（含其前空行）要逐字保留，新增内容另起一段。修订答案必须在读到首轮 findings 之后编写，所以规范任务的 `advance` 不能带 `--allow-review-attempt 1` 跨进第 2 轮（启动前退出 2，预写的 `-a2` 文件也不行）：先 `advance` 到 `awaiting_review`，用返回的 `packageDigest` 执行带 `--allow-review-attempt 1` 的 `decision`，读取 `.reviews/<feature>-<task>-r1.md` 的 findings，写好第 2 轮两份答案后 `advance`；第 2 轮审查用带 `--allow-review-attempt 2` 的 `advance`（驾驶员的 `decision` 请求只携带运行定义的第 1 轮身份）。

启动前驾驶员会校验：targets 覆盖与内容文件安全、`inspectCmInitDraft` 结构检查（先查原稿，再按当前磁盘合入 AGENTS.md 后查）、单次回复不超过宿主 64 KiB、四组 status、`constraintChanges`、Learning 字段，以及目标文件的当前状态：本运行尚未写入规范时目标不能已存在（仅允许带 `## 项目教训` 段的 AGENTS.md）；本运行已写入过（第 2 轮修订，或同轮重试）时每个目标须与运行存档记录的上次写入逐字节一致（AGENTS.md 按 Learning 回写后的摘要），他人改动会被拒绝，先还原。启动宿主前，驾驶员还用宿主自己的函数提前拒绝：缺 `--allow-bootstrap-write`（宿主到开发步骤才查）、bootstrap 配置或受保护配置不能被宿主读取器接受（如符号链接、字段不符）、新建运行时 admission 不选中本任务、本任务不是 bootstrap 当前 nextTask（宿主在开发步骤内才查）。宿主启动时的其余核对（运行定义、嵌套 specs 保护、恢复的创建会话与 runtime 指纹等）都在 `host_ready` 之前由宿主本身完成，失败时命令不会运行。命令跑完后驾驶员重读预检时核对过的全部规范目标、运行定义、PLAN.permissions 中的文件及已批准的 bootstrap 规格（requirements/design/tasks 与 `.cm-specs-status`），任何一个变化都退出 2：命令须只读核验。静态校验失败在启动宿主前退出 2，运行存档不变。

恢复：`init-verify` 命令未通过或改动了绑定文件时，驾驶员不发送操作并关闭宿主。`mode:resume` 的运行存档不变，修正后原样重跑；`mode:create` 时宿主已建好运行（`ready`，只有 init 记录、未执行开发步骤），修正后把 PLAN.mode 改为 `resume` 重跑。规范写入后若 `PLAN.checks` 未通过，宿主停在可重试的 `blocked/develop_checks_not_passed`，规范文件保留在磁盘上：修好检查环境后在原运行 `advance`（`mode:resume`），同一轮以同一组答案重试，宿主把本运行已记录的写入当作起点，不另建运行。

### bootstrap 规范任务的当前会话宿主路径

驾驶员不支持的规范任务（见上节），或当前会话能直接持有交互进程时，按本节手动应答。

完成 T-001 骨架和其独立审查后，为 T-002 从已批准规格生成独立运行定义，`scope` 列出全部 `cmInitRuleTargets(selection)`，`requirements` 可为空数组。由当前真实 Claude 会话持有可交互进程句柄；下面是启动示意，路径和会话 ID 必须换成当前实际值：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-ai-host.mjs" serve --config "{T-002-run.json}" --mode create --host-context "{当前真实会话ID}" --runtime claude --allow-development --bootstrap-config "{bootstrap.json}" --allow-bootstrap-write
```

`bootstrap.json` 为 `{"selection":{"versionControl":"local","modules":[],"analysis":"当前项目分析"}}` 这类已确认选择。收到 `host_ready` 后发送带原运行定义 `identity` 的 `{"version":1,"requestId":"t002-advance","operation":"advance","identity":{...}}`；不要等控制响应才处理反问。`init_generate` 按实际请求的 targets、templates、existing 和项目材料生成 `{status:"generated",documents:[{path,content}]}`；`init_verify` 对宿主给出的最终 documents、selection、inspection 及当前项目逐项核验，返回 `{checks,constraintChanges,application,retrospective}`。五项 checks 各给真实 `status/evidence`；不能把预写 JSON 或 `inspectCmInitDraft` 的结构检查冒充语义证据。每条 `host_result` 必须带该次请求的 `sessionId`、`callId`、`requestDigest`。若缺当前会话的真实核验能力，停止并报告，不发送虚构通过结果；断联后按原 run 的 unknown 恢复表处理。

本参考只负责接入已有 runner，不复制 N1–N8 状态机。相对路径从本文件解析；
插件根是 `../../..`，不得硬编码安装缓存。先读
`../../../docs/js-workflow-control.md` 的当前支持、会话入口、QA/文档、审查授权与批次章节，
使用其中真实 CLI、配置和结果合同，不发明字段或动态加载执行模块。

普通 `cm-ai` 新任务默认进入本入口，无需用户指定 JS；恢复已有运行先遵守主 Skill 的路由优先级。
进入前检查下列环境、目录与权限条件，缺口明确阻断；不得因启动失败转回兼容流程或创建替代运行。

## 启动前

1. 读取代码项目根与目标路径适用的 AGENTS、`N1-init.md`、`N2-enter-feature.md`。
   保留原批准 manifest、完整 feature 清单、task/AC、依赖、Learning 和形态确认要求。
   只提取输入与业务约束；不要执行旧节点中的手工日志/状态、Git、安装或任务标记。
2. 当前执行 CLI 支持 Codex 或 Claude 当前会话，要求Node 24.14+；macOS有本地证据，Linux实现已接但尚缺目标环境验证，原生Windows未支持。支持单根或显式多根，与
   分离或显式受保护的同仓 specs 根。由当前真实宿主确定 runtime：Codex 用 `--runtime codex`（也是默认），
   Claude 必须显式传 `--runtime claude`；单任务和批次入口相同。模型输出不得选择或更改
   runtime，恢复不得换端或冒用旧会话。Codex单任务同仓specs可显式选择下文受保护模式；
   当前Codex/Claude及批次同仓用下文文本提案模式；未选择保护的同仓仍阻断。不搬动specs或删除保护检查；工具会话不是OS沙箱。
3. 从已批准任务确定 scope、requirements 和顺序；不跳过未解决的 bootstrap 确认或依赖。
   单代码根用 `cm-ai-admission.mjs --print-run-definition --scope ...` 生成运行定义，不要手写；`--scope` 必填（相对代码根、逗号分隔），`--requirements` 可选。需要跳过当前 `nextTask` 时可加 `--task T-xxx`，仅接受同 feature 的 `eligibleTasks`，选择会写入运行定义并绑定恢复指纹；完整命令见产品文档。
   单任务用 `cm-ai-host.mjs`；多任务用 `cm-ai-batch-host.mjs` 的原 batch/workflows 配置。
   任务列表只包含该运行计划内的任务；恢复必须使用原身份、配置和真实当前会话身份，
   单任务同会话恢复可只用 `--mode resume --host-context {当前真实会话ID}`；换会话恢复用 `--mode resume --host-context {当前真实会话ID} --original-host-context {创建运行的会话ID}`；
   两个 ID 相同等同未传新参数，create 传它报 `original_host_context_unavailable`。不能冒用旧 host-context。
   原配置指纹和 init 元数据仍绑定创建会话，旧记录不改；开发结果和审查授权使用当前真实会话。
   新会话首次签审查授权前追加 `host-joined`，仅打开或 status 不写；创建会话、已加入会话和当前会话
   都排除为审查员，当过审查员的线程不能回来当宿主。最多记录 16 个接手会话。
   支持 V3 会话父运行及其 QA-fix 子运行；旧 protected 兼容分支、batch 不支持此跨会话入口，原授权仍须逐项提供。
   QA-fix 新建子运行的配置 hostContextId 只能是当前会话或父运行的持久创建会话；已有子运行沿用原配置并校验指纹。
   子运行打开（含 fix_status）和审查授权使用当前真实会话；首次签授权前由 cm-fix 记录 fix-host-joined-N，
   只读打开不写接手记录，causeReview.contextId 不能是当前会话。子 runtime 仍须匹配宿主。
3.1 多任务批次可提议并行组，写进 batch 配置的可选 `parallel`（任务 key 的数组的数组）。
   只提议同时满足以下全部条件的任务，任一不满足就不进组；一个组都成立不了就**不写该字段**，正常串行：
   - **纯新建文件**：该任务 scope 的每个路径在 `HEAD` 上都不存在（`git cat-file -e HEAD:{path}`
     判定，不看工作区——成员工作树从 HEAD 创建，未跟踪文件不算数）。任务若需改动现有文件
     来注册新模块（路由表、index 导出等），那些文件会出现在 scope 里，本条自动将其排除。
   - **scope 两两不交集**：候选之间不得有重复路径。
   - **无依赖路径**：按 `tasks.md` 依赖图计算**传递闭包**，组内任意两任务之间不得存在依赖路径。
     runner 也按传递闭包校验并以 `parallel_dependency_conflict` 拒绝，此处自行判定是为了
     提出合法的组而不是被拒后返工。
   - **同一 feature**，且排除该 feature 最后一个未 DROPPED 的任务（它承担合并后的统一 QA）。
   - **每组 2–4 个**，不足 2 个不成组。
   能并行才并行，不为组而组；判定不确定时按串行处理。成员在各自 Git 工作树开发、串行合并回
   主分支，成员 QA 自动延后到末任务；当前会话模式下开发请求仍逐个应答，重叠的是审查与流程开销，
   不是写代码本身，不得据此承诺成倍提速。

4. 核对任务所需能力后才启动。QA 使用原测试合同与已授权命令/环境；无 QA 配置不能宣称
   已完成必需 QA。文档路径预先纳入任务批准 scope；需要 AGENTS/CLAUDE 等保护指令同步、
   bootstrap规范用下文单步驾驶员或受信入口；其他未满足的必需能力记录具体缺口，不降格成可选项。
5. reviewer 配置在首次运行前绑定；本机 preflight 不是实际模型审查或调用许可。
   只有当前真实用户已授权本任务本轮、模型与发送包时，才传审查授权选项；无许可可以
   不带选项运行至待审，但不能完成。批次按 feature/task:attempt 授权，不授权整个未来批次。
   不把开发批准转换为网络、安装、Git、发布或真实 provider 调用批准。

## 同一引擎的双端启动

从当前活动 Skill 的本参考文件所在目录解析 `../../../scripts/`，调用对应脚本而不是依赖全局同名命令。
单任务使用 `cm-ai-host.mjs serve`；多任务使用 `cm-ai-batch-host.mjs serve`，都显式传递
上述 runtime，并使用真实宿主提供的 `--host-context`。不要为了使用 Claude 改写规格、
Review 头或完成记录；provider 身份由原 adapter/V3 绑定，失败不切到另一端兜底。

需配置审查时，按文档运行单任务脚本的
`preflight --config {该代码根的单任务配置} --review-model {已选择模型} --runtime {当前端}`。
即使后续执行批次，诊断仍用同一代码根的单任务配置，不把 batch/workflows 配置传给该命令。
诊断输出直接作为 review-config 输入，不手造或修补 `passed`/指纹；失败则保留原因。
Claude CLI 报 `unrecognized_model` 时 preflight 会失败并在 stderr 指明被拒 id、可用的家族别名示例（如 CLI 2.1.x 的 `claude-opus-5`），可快速取得时也打印 CLI 版本；示例不是完整模型清单。
Claude 诊断只做回环请求捕获，`stopped_by_probe` 表示诊断自身终止，不发送工作流 cancel。
本机配置诊断通过不证明模型可用、Review 协议成功或用户已批准外发；真实审查仍须第5项授权。
不带对应 `--allow-review-attempt`（单任务）或 `--allow-review feature/task:attempt`（批次）
可以准备并停在原待审点，不能自行追加这些选项推进。后续授权也不得改变原 scope 或身份。

## Codex 单任务：显式受保护执行

不新增模型调用的方案：单任务和批次均可传`--protected-conversation-config {文件}`，配置固定为
`{checkCommands,timeoutMs}`，命令须已获准；检查命令用此预算，独立审查默认 900000 毫秒（15 分钟），可在 review-config 中单独覆盖，范围 1–3600000。preflight 输出有效 `timeoutMs`；此预算不进入授权配置摘要，旧运行可用原 runId 恢复。
需要模拟器、真机或系统服务的 iOS 项目（CoreSimulatorService、Xcode UI tests、Keychain 等），应将 specs 与代码分根，并选用有系统访问能力的当前会话宿主路径执行检查；实际检查进程必须在 Codex 原生沙箱外。仅改变目录或改用驱动脚本不会让沙箱内检查获得这些服务。同仓 specs 的受保护检查仍在 Codex 沙箱内，典型症状是模拟器不可用、UI tests 无法启动，SwiftPM 的 `swift build` 需要 `--disable-sandbox`；不要把这种失败记成产品测试通过。检查命令的构建产物放在代码根外，例如 `xcodebuild -derivedDataPath {代码根外的目录}`。检查自己新增的范围外未跟踪文件使原 run 进入 `blocked/check_output_out_of_scope`，状态原因和 stderr 列出最多 20 个相对路径；操作员清理产物后在原 run 重试。开发者造成的范围外改动仍是 `unknown/out_of_scope`，不得据此放宽 scope。
新运行的代码根快照固定忽略 `.DS_Store`、`._*`、`.AppleDouble/`、`Thumbs.db`、`xcuserdata/`、`*.xcuserstate`、`.build/`、`.swiftpm/`、`DerivedData/`，也跳过 Git 报告为 ignored 的目录及路径；任务 scope、AGENTS.md 与 specs 仍须验证。基线有界保存 Git 忽略路径与目录，后续将基线和当前忽略决定的并集应用到比较两侧；规则文件和无关 Git 配置变化本身不阻断审查。Git 不可用或忽略结果超限时基线标明仅用固定列表。这有意缩小代码根检查面，被忽略的产物不构成已审代码；旧 journal 沿旧规则回放。
审查期间代码根非忽略路径漂移时，`blocked/review_package_changed` 保留 verdict、回执与最多 20 个差异路径；清理或还原后在原 run 继续 `advance`，不会重派 reviewer。结果已入 journal 而检查点未写入时，恢复会从同一结果补写检查点；结果仍可用，不消耗新轮次。审查前的漂移拒绝 `decision`，完成前的漂移拒绝 `complete`，均列出路径；完成检查期间新增文件进入可重试的 `blocked/completion_package_changed`，清理后在原 run 重发 `complete`。未匹配时 `pendingAction` 不提示会被拒绝的动作。
审查传输超时且没有结果事件时，记录 `pending_review/review_transport_timeout`，可用 `--mode resume` 后 advance，
同一 attempt 最多重派一次，重新取得 Review 授权、grant 与 invocation；第二次超时为 `blocked/review_transport_timeout`。
已有最终消息（即使截断）的超时仍需 reconcile，旧 unknown 历史不自动改类。兼容Codex/Claude当前会话，保留原runtime与Review授权。
单任务 V3 的审查调用若已登记（可能已 started）但没有 result，操作员先确认旧 host 与 Review 进程都退出，
再用原 runId 恢复并显式放弃该调用：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume --host-context new-host-id --original-host-context old-host-id --allow-development --review-config review.json --allow-abandon-review --runtime claude
```

向宿主 JSONL 输入发送 `{"version":1,"requestId":"abandon-1","operation":"abandon_review","identity":{"repositoryId":"…","runId":"…","taskId":"…","attempt":1},"reason":"已确认旧进程退出"}`。
`reason` 为非空单行、≤500 UTF-8 字节。旗标一次性消费，不持久化、不影响配置指纹；宿主无法验证进程已退出。
成功后 journal 追加 `review-invocation-abandoned` 并写 `review_abandoned` 运行日志，状态为
`pending_review/review_abandoned`，`pendingAction: resume`。新宿主以原配置、原 runId 和新的
`--allow-review-attempt 1`（第二轮为 2）恢复并发送 `advance`，重新签发 grant、登记新 invocation。
同一 attempt 与无结果 transport timeout 共用最多一次重派；额度已用完则拒绝 abandon。
旧 invocation 的迟到结果不能再接收；若要终止，abandon 后普通 `cancel` 才能得到 durable cancelled。
批次路径不支持此操作。driver 可用 `node scripts/cm-ai-drive.mjs --plan abandon-review.json abandon_review`；
PLAN 需 `mode:"resume"`、原配置、`originalHostContext`、`permissions` 包含 `--allow-abandon-review`、`reason`。

单任务 V3 的当前会话 `develop` 或 `complete` 若留下 `effect-intent`，其后仅有 control 记录且没有 checkpoint，恢复后是 `unknown/reconciliation_required`，`pendingAction: abandon_effect`。`review` intent 尚无 `host-joined`／`review-invocation-registered`，且其后仅有 control 记录时也走此入口；已登记 review 仍走 `abandon_review`。操作员须先确认原 host 已退出，且相关子进程均已停止；随后用原 runId、原配置和原 runtime 执行：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume --host-context new-host-id --original-host-context old-host-id --allow-development --allow-abandon-effect --runtime claude
```

向宿主发送 `{"version":1,"requestId":"abandon-effect-1","operation":"abandon_effect","identity":{"repositoryId":"…","runId":"…","taskId":"…","attempt":1},"reason":"已确认旧 host 和检查进程退出"}`；driver 可用 `node scripts/cm-ai-drive.mjs --plan abandon-effect.json abandon_effect`，PLAN 需 `mode:"resume"`、`permissions:["--allow-abandon-effect"]` 和单行非空、最多 500 UTF-8 字节的 `reason`。旗标只消费一次，不进入原配置指纹。journal 仅在对应 intent 及其后连续 control 记录后追加绑定 effect id、kind、intent 摘要、前一条记录摘要与原因的 `effect-abandoned`，运行日志写 `effect_abandoned`；结果是终态 `cancelled/effect_abandoned`，不会改代码根或自动取消 `tasks.md` 勾选。

没有 pending effect 应拒绝；已加入 host 或登记调用的 pending review 用上方 `abandon_review` 或原运行恢复入口。provider-mode 开发可能有独立进程继续写入，不能走此出口。若已写 `task-commit-intent` 而无结果，`tasks.md` 可能已经被改名或勾选；须先核对该文件、提交回执和旧进程，不能猜测未提交而放弃。批次路径没有 `abandon_review`，也不接入 `abandon_effect`。退出后，未产生已审 handoff 的任务可按普通新 run 准入；已有已审证据时走下方显式 supersede，仍须通过旧 writer 和代码漂移检查。
develop若有`editMode:"protected-text-v1"`，只读并返回`{status:"succeeded",value:{原开发/Learning结果},edits:[{path,beforeSha256,content}]}`；
使用scope内expected摘要，正文完整UTF-8，null删除；不得先自行写文件或执行命令。失败返回原status/code，blocked不能带改动。
固定沙箱负责应用提案和原检查，不再请求宿主check；文档同步包含在同次develop提案。原64KiB通道不变，二进制/超限明确阻断。
本机Codex sandbox不调用模型，也不改变Claude身份。其余QA/文档核验/子fix权限不变，不与下述protected-config混用。

开发结果先通过完整 value/Learning 合同校验，再由沙箱落盘；本地校验失败记录 `failed` / `invalid_result`，原校验码保留在 `result.reason`。
当前会话返回 `blocked` / `developer_result_invalid` 时，修正回复后用原配置、身份和 runId 以 `--mode resume` 启动并 `advance`，同一 attempt 重新 develop，不消耗 provider 轮次。
`no_new_lesson` 必须 `candidates:[]` 且 `reason:null`（实跑事故：非空 reason 曾在文件落盘后抛错，被误记为 unknown，原 runId 无法恢复）。
重送已落盘提案时核对新的 expected 哈希：提案内容与磁盘一致才作为同一次实现继续；不一致返回 `protected_edit_stale`，保留文件并报告冲突，不能强制覆盖。
worker 异常、超时或传输歧义仍是 `unknown`，旧 unknown 历史不自动重分类；其他 blocked 原因也不能使用此重试入口。

用户已授权本任务该轮真实 Codex 开发调用及发送范围时，可选普通单任务入口的
`--protected-config {文件} --allow-provider-development-attempt 1`。这是原生受保护子进程，
不是当前会话直接改文件，不会因同仓布局自动切换；普通“开始开发”或`--allow-development`本身不授权外发。
读取产品文档“普通单任务入口选择受保护模式”的配置和命令示例；配置只含model/checkCommands/timeoutMs，
固定代码根/specs根、scope和实际宿主身份仍来自原run配置及host-context。命令也须事先获准。

启动须提供原`--review-config`诊断，但诊断不是审查许可；没有`--allow-review-attempt`时只到待审。
初次create只能授权开发attempt 1；修正轮resume须按真实审批改为attempt 2，不重置原轮次或身份。
R1要求修改但尚未授权第2轮时保留changes_requested，不登记开发或当作unknown；补授权后再resume。
收到host_ready后仍按原协议advance/status/cancel/host_close；开发和检查由适配器执行，
当前会话不重复处理develop/check或手写凭证。补授权后沿原mode resume，不换runId。

首次create可同时提供原`--workflow-config`；有QA配置须另带`--allow-qa`，恢复保持原配置与授权。
原无workflow或`qa:null`且任务已为`fixture_completed`时，可在`--mode resume`显式提供
含QA的`--workflow-config`与`--allow-qa`，一次性附加N6；原definition/scope/requirements/identity、
创建运行的 host-context（换会话时由 `--original-host-context` 声明）、开发/审查配置仍须匹配。journal追加不可重复/修改的`qa-attached`，运行日志写
`decision/qa_attach`；后续恢复须保持已绑定配置及重新授权，`qa`仍要求`qa_assess`等原宿主请求。
不重跑开发/审查，不将任务完成当作QA通过（事故：create漏配workflow曾使feature强制QA无法补做）。
QA 的 `qa_assess/qa_logic/qa_browser` 请求独立计时，workflow 的 `qa.timeoutMs` 可设 1–3600000 毫秒，
省略为 60000；`qa_assess` 的实际应答窗口另受决策通道约 60 秒上限约束。`qa_logic/qa_browser` 超时记
`host_request_timeout` 并判该用例 BLOCKED，不把已有命令 PASS 用来覆盖超时。`qa_assess` 超时不再写 N6 决定：
`advance` 返回 `rejected/qa_decision_timeout`，用原配置 `--mode resume` 再 `advance` 会重新询问。
旧版本已把这种超时记成 `阻塞:host_request_timeout` 决定的运行，默认仍按原记录返回 `qa_blocked`（结果带
`reason: host_request_timeout`）；用户同意后以 `--mode resume --allow-qa --rerun-blocked-qa` 再 `advance`，
只重新询问一次 `qa_assess`，新决定以 `previous_decision_id` 链接旧决定追加到运行日志，旧行保留；
旗标随即消费，不再用于同一次调用的 QA 重跑。若替代决定已写入、首轮 `test_run/start` 前中断，用同一条命令再 `advance`
即按普通首轮继续，不再询问 `qa_assess`，也不必去掉旗标。第二次替代、非超时阻断或其他决定一律拒绝。
（事故：AI潮 bootstrap-T-002-r2 的 N6 评估超时 60 秒后被永久阻塞，context_refresh/finish 无法通过。）
宿主读取 JSONL 时必须处理当前缓冲区内的全部完整行，再等下一个数据块；处理单行后不能
提前 return（事故：确认和 TC-007 请求合并到一个数据块，旧驱动只读确认而悬空等待）。
无 complete 的 N6 中断只能由用户显式重跑：保留原配置，`--mode resume --allow-qa --rerun-unknown-qa`，
之后 `advance`；运行日志先记 `test_run/abandoned`，新 testRunId 保持原 qaRound，不重跑开发/审查。
已记录 case_complete 必须全为 PASS（允许零条），且无 case_blocked；abandoned 的 partial_pass_cases 记录旧 PASS 用例。
所有用例仍全部重跑，旧 PASS 证据文件只作历史保留。任一 FAIL/BLOCKED、固定报告
`{testRunId}-execution.md` 或未清理资源都不满足恢复条件；保留 unknown/阻断供人工核对，
不删报告或日志来获得重跑资格，不伪造 complete。仅写了 abandoned 后再中断可沿同一授权入口恢复。
已 complete 的宿主证据或环境阻断可用单任务 `--mode resume --workflow-config {原配置} --allow-qa --rerun-blocked-qa`，
再 `advance`：仅最新结果为 BLOCKED、failed=0、qaRound<3，且每条 BLOCKED 都是 browser 的 evidenceProblem、
cleanup=failed、环境摘要不一致、hostRequestTimeout 或会话自己回答的 BLOCKED（报告行 `hostDeclaredBlocked`，
例如模拟器当时不可用），logic 的 INSUFFICIENT_EVIDENCE 或只因映射命令没有退出码而阻断（报告行 `commandUnavailable`），或 commands 行没有退出码
（`host check: timeout/signal_exit/spawn_failed/output_*/cleanup_failed`，例如 xcodebuild 超时或被杀）时允许。
没有声明命令（commands-unavailable）、延后用例（no-applicable-cases）、`[需确认]`（logic 报告行 `needsConfirmation`，
即使映射命令同时没有退出码）、缺浏览器能力、源码漂移和未 complete 不适用；
是否仍有 `[需确认]` 以该 feature 的 `test-cases.json` 为准，并与报告标记交叉核对（两者任一显示未确认即拒绝）；
“只因命令没有退出码”由已记录的命令行推出，报告的 `commandUnavailable` 必须一致，删改报告标记不能换来重跑资格。
旧版本报告里会话回答的 BLOCKED 没有标记，仍不适用。新写入的 superseded 行带 `recovery_rule: 2`；旧版本写入、
没有该字段的 superseded 行按旧版本原规则回放（例如 logic INSUFFICIENT_EVIDENCE 行照旧有效）。配置填错应使用下述“QA 配置修订”。
非零退出码是产品 FAIL，不会被重新归类；确认是环境造成（例如模拟器运行时缺失时 `xcodebuild test` 退出 65）时，
可在同一命令加 `--qa-environment-failure "原因"`（单行，最多 500 UTF-8 字节，必须与 `--rerun-blocked-qa` 同用，仅单任务宿主）：
只接受最新结果为 FAIL 且每条 FAIL 都是有退出码的命令行、或只因这类映射命令失败的 logic 用例；browser FAIL、
`CONTRADICTED`、已接受修复的 FAIL 均拒绝。superseded 行记 `reason=declared_environment_failure`、`environment_failure_reason`、
`failed_cases` 与 `blocked_cases`。这不是放行：新一轮在同一代码上全部重跑，真有缺陷仍会 FAIL。
先写 `test_run/superseded`（previous_test_run_id、reason=host_evidence_problem 或上述声明原因、blocked_cases），再以新 testRunId、
qaRound+1 写带 previous_test_run_id 的 start，全部用例重跑，占用同一个三轮 QA 预算；旧 PASS 仅保留历史，最多三轮，不重做 QA 决策、
开发或审查，不改 tasks。开关一次性消费且不持久化，不与 --rerun-unknown-qa 合用；仅写 superseded 后中断，
须重新显式授权恢复。complete 同步 N6 状态镜像为 qa_passed/qa_failed/qa_blocked，并显示本轮通过/失败/阻断数量。
（事故：宿主把非文件说明混入 browser evidence，导致已完成任务的收尾 QA 无法恢复。）

### QA 配置修订

最新 QA 已产生完整结果，或 QA 还没开跑（见下方首轮前修订），但命令、环境或 QA 预算填错时，先保留上一版 workflow JSON，再修改新文件。用户明确同意本次配置改动后，用单任务宿主恢复：

```bash
node scripts/cm-ai-host.mjs serve --config run.json --mode resume \
  --host-context {原宿主身份} --allow-development \
  --workflow-config workflow-new.json --allow-qa \
  --revise-qa-config workflow-old.json \
  --qa-config-revision-reason "补齐此前漏配的项目测试命令"
```

原运行需要的审查、保护配置和跨会话身份参数仍须照原值提供，然后发送 `advance`。旧运行只保存完整配置摘要，没有可逆的配置副本，所以必须提供上一版文件核对；不能凭一个新摘要接受任意漂移。旧文件仅用于验证，不执行其命令。

- 首轮 QA 前也可修订：只要这个 run 还没有任何 `test_run` 行（开发中、待审、已审批，或 N5 完成后 QA 决定已触发但未开跑），
  同一命令即可恢复，不必先用已知错误的命令跑一轮。journal 追加 `qaRound: 0`、`testRunId: null` 的 `qa-config-revised`
  （绑定当时的审查包，尚无审查包时为 null），运行日志写一次 `decision/qa_config_revise`；不写 superseded，首轮仍是 qaRound 1。
  首轮前可连续修订；已有 unknown effect、已取消或完成后代码漂移（correction_review_required）的运行拒绝 `qa_revision_not_completed`。
  QA 一旦开跑，后续修订照旧消耗一轮；首轮后出现的 round-0 修订或其日志镜像会在恢复时以 `qa_revision_invalid` 拒绝。
- 修订仅接受 `resume`、`--allow-qa`、非空原因和相符的上一版配置；不能与两个 QA 重跑开关合用。只允许 QA 命令、环境、QA 预算及其派生执行计划变化，任务身份、规格、开发、审查、项目策略、文档与能力配置均保持原绑定。reviewer 的纯传输超时本来就不参与授权摘要，无需本入口。
- 先追加 `qa-config-revised`，绑定前后指纹、QA 配置摘要、原因、原审查包及旧 QA 轮次；再追加 `test_run/superseded`，原因是 `qa_configuration_revision`。旧结果留在历史，不再作为当前通过或修复依据；原开发、审查、N5、任务勾选和历史字节不改写。
- 新 QA 使用新 testRunId，全部用例重跑，轮次加一且最多三轮；另行绑定实际完成的开发 attempt，第二次开发审查通过后也能恢复。未完成或结果未知的 QA 必须先核对原执行；本入口不证明资源已清理，不放宽源码漂移检查，不重置轮次，也不自动批准产品修复。
- 配置链验证成功后，后续恢复只需当前配置与原授权参数，不再需要旧文件。重复同一修订命令不会重复登记；若中断发生在 journal 写入之后，会补齐旧 QA 的作废日志，再运行下一轮。未使用此入口时，改配置仍报 `fingerprint_mismatch`。

本次仅支持单任务宿主；批量宿主未接入该选项。临时夹具覆盖漏命令死锁、正常续跑、连续修订与三轮上限、旧证据拒绝及中断回放；不代表真实模型或浏览器验收。

### 已审交接后的任务重跑

同名 handoff 已被审查回执消费时，新运行在创建 store 和开发前就拒绝 `handoff_exists`，错误的 `reason` 保留恢复提示。QA 配置错误用上述 `--revise-qa-config` 恢复原运行；宿主或环境证据不足用 `--rerun-blocked-qa` 恢复原运行。确需重新开发同一任务时，使用新的 runId 和下列显式授权：

```bash
node scripts/cm-ai-host.mjs serve --config run-new.json --mode create \
  --host-context {本次宿主身份} --allow-development \
  --supersede-reviewed-evidence --supersede-reason "说明为什么要重跑任务"
```

原因必须为单行、非空、最多 500 UTF-8 字节。N5 会在 N6 前把任务勾为 `[x]`：若 QA BLOCKED 后确需重新开发，先在 `tasks.md` 将该任务改回 `- [ ]`，再用新 runId 和上述两个旗标创建运行；仍可恢复原 QA 时优先走原运行。只接受同 feature、task 的新运行：`tasks.md` 未勾选该任务，且每个旧运行的 V3 journal 已是无在途操作的 blocked、cancelled、unknown，或 fixture_completed 且 QA 为 BLOCKED／尚未结束；旧 writer 仍被进程持有也拒绝。pending develop/complete 和未加入 host／登记调用的 pending review 须先在原 run 用 `abandon_effect` 退出，已登记 pending review 须用 `abandon_review`，之后再建新运行。已完成或仍可继续的旧运行、没有旧运行或可归档文件同样拒绝。旧运行的 journal 不改写、不以新运行身份重开。

创建新 journal 和捕获新基线前，只把当前代码树与尚未被其他旧运行替代的直接前驱运行的 V2 开工基线逐文件比对，包含未选中文件及新增、删除路径；所有旧运行仍进入 `previousRunIds` 和归档。差异返回 `supersede_code_drift`，`reason` 和 `[host]` stderr 最多列出 20 个路径及其余数量。操作员可手动还原这些文件后重建运行；或确认保留这些改动时，在上述两个旗标之外加 `--accept-superseded-code-drift` 重建（这些文件会被当成已有代码，不进新运行的审查改动）。接受时新运行的 `evidence-superseded` 记录存下每个漂移路径、当前 SHA-256（删除时为 `null`）及被比较的前驱 runId。该旗标仅限新建运行，不默认启用。检测只读代码根，不跟随越界软链接；无法安全读取时即使带旗标也拒绝。没有可用逐文件基线的旧 journal 跳过此检测，不改写历史记录。

使用 `cm-ai-drive.mjs` 时，将两个必需参数放入新运行 PLAN 的 `permissions`；接受代码漂移时再加入 `--accept-superseded-code-drift`。缺少必需参数、单独使用接受旗标或 `mode: "resume"` 时，驾驶员在启动宿主前拒绝。

新运行先在自己的 journal 追加 `evidence-superseded`，绑定原因、旧 runId、文件名和 SHA-256，然后用先硬链接再解除原链接的方式把该任务同名 handoff、review 及具名 correction／QA 文件移至 `.reviews/.superseded/{原文件名}.{摘要前16位}`，并写 `supersede` 运行日志。归档中断后以同一新 runId 执行 `resume` 会按记录补齐；未用此旗标的运行不增加记录或改动旧证据。历史 QA 的 UUID 报告仍由旧 runId 日志引用，保持原位。新 handoff 和 review 使用原文件名，旧证据只在归档中留史。

QA命令复用同一specs只读沙箱。最终任务的documentationPaths必须已在批准scope内，
在同一次受保护开发调用中同步，随后进入原检查/handoff/Review；不派发宿主documentation_sync，也不增加模型轮次。
宿主仍处理qa_assess/qa_logic/qa_browser及只读documentation_inspect；不得借这些请求改代码、规格或指令。
浏览器仍遵循原工具、目标、证据与清理约束；此模式只对开发及命令子进程提供OS保护，不把宿主语义报告冒充沙箱证明。
只有原QA/文档核验/完成门禁通过才返回run_done；缺能力或核验blocked仍阻断，不手工补状态。
该模式仅单任务Codex；可接原QA-fix参数，但子owner/template的configuration必须显式protectSpecs:true，
否则在父运行建store前拒绝。仍按原每项权限、auto_fix策略和最多三轮QA执行，不因父开发/审查许可获得子权限。
子修复的文本提案合同见`../../cm-fix/references/js-host.md`“同仓specs的受保护修复”；收到对应editMode时宿主不直接落盘。
不适用于Claude/批次，不改变Git、安装和发布权限；恢复不得在受保护模式与默认会话模式之间切换。

## 执行当前请求，而非手工跳节点

多代码目录使用原run/batch可选codeProjects与共同工作区codeProject，scope/requirements加各根相对前缀。
只用已声明真实根；protected-conversation-config的每条检查及workflow QA命令增加codeProject绑定实际cwd，
每根至少一条检查。读取develop的codeProjects/projectInstructions，返回前缀路径提案；原同一任务统一审查和完成，不自行拆任务。

已批准bootstrap feature优先用`0.bootstrap`；否则仅接受唯一一个数字前缀后slug恰为`bootstrap`的feature（如`1.bootstrap`）。
多个候选以`bootstrap_feature_ambiguous`拒绝。按原骨架→规范任务顺序。单任务bootstrap-config为`{selection:null}`或原cm-init选择；
批次bootstraps映射到具体feature/task，另传allow-bootstrap-write。原任务批准和逐轮独立Review不能省略。
先按产品文档配置完整固定规范scope；requirements可为空数组；bootstrap原有批准specs需求/设计纳入逻辑保持不变。
init_generate复用原cm-init生成合同；init_verify五组检查加constraintChanges/application/retrospective，详情以产品文档为准。
宿主不自行落指令文件：JS固定写入、读回、同次handoff/Review、N7重载。T-001 Learning先写入AGENTS.md时，规范草稿须保留其他既有约束原文；JS把已有`## 项目教训`段原字节合入最终草稿，再校验、写入和审查。草稿改写既有教训或丢弃其他既有内容则阻断。原规则冲突、未知或漂移保留证据，不覆盖或重派。

用当前会话可交互的进程工具启动 CLI 并保留会话句柄。收到 `host_ready` 后按文档发送
`advance`；批次控制消息不带子任务 identity，单任务按原合同携带 identity。
持续读取响应，按 requestId 关联控制结果。不要等待 `advance` 结束才处理途中 host_request。

每项 host_request 必须核对实际任务、路径、scope 与当前授权，再执行对应工作：

| 请求 | 当前会话实际执行 |
| --- | --- |
| develop | 读取 N3 的业务约束、适用项目指令与请求中的 Learning；按 N3 的技能匹配读取并使用真实工程 Skill，只修改固定业务 scope，返回原开发/Learning 结果。不要执行 N3 的手工交接/标记流程。 |
| check | 按原任务测试合同实际运行适量检查，返回实际退出码及证据；不把自审或静态推断写成测试通过。 |
| documentation_sync | 使用 cm-doc-syncer 的文档判断，只同步请求列明且获准的普通文档；这是 Review 前写入，不新增完成后写入。 |
| qa_assess / qa_logic / qa_browser | 使用 N6 与 cm-qa-engineer 的业务判断或获准工具；评分不替代 JS 的强制 QA 政策，静态判断不替代真实运行，不能改变载体或伪造浏览器证据。 |
| documentation_inspect | 按 N8 只读核对必需文档及收尾证据；缺文档、度量或必需能力返回 blocked，不为了 run_done 宣称 completed。 |

进入匹配角色前读取该 Skill 完整指令，但 JS 所有权不让渡给角色。实际模型路由、资源
及逐例日志由已有实现覆盖到哪里就报告到哪里；读取角色 Skill 不证明配置声明的模型已调用。
若角色要求 JS 尚未支持的控制动作，停止并报告，不在旁路手写日志/状态弥补。

回复沿用该次 sessionId/callId/requestDigest，result 严格符合该 kind 原合同；开发结果不是
check 数组，也不是 QA/文档结果。只回报已实际执行的事实，不能从项目文件自动接受回复。
工具失败返回原失败结构；超出权限不能执行。Learning 候选交由原 runner 写回与 Review，
会话不自行修改保护指令。不要制作自报 approved、grant、Review receipt 或完成凭证。

JS 返回阻断、待授权、失败、取消、unknown 或补正要求时，报告原因并保留磁盘证据；
不重试未知调用、换 runId 绕过历史、手工勾 tasks 或启动旧兼容流程。允许 status 查询；
只有用户明确取消才发送 cancel。结束用 host_close；断联不是用户取消。

## 汇报与能力边界

只以 JS 实际结果报告“已做、剩余、问题、下一步”。task 完成不等于 workflow 完成；
只有原 finalizer 的 run_done 且本次必需业务证据齐备，才报告该运行完成。
目前 CLI 有本地真实工具与合成 reviewer 组合证据，没有完整真实双宿主业务验收。
本参考已接单/批双端源入口，但不证明已安装 Skill 已加载、真实模型Review或完整双宿主验收。
普通布局权限、完整 N6 修复/重测、bootstrap、度量与其他入口的业务迁移仍按当前证据报告。

### 已批准规格材料（第 24 步）

新 run 的开发请求与审查包携带同一份只读 `specification`：`feature`、`task:{id,description,verification?}`、全部 `acceptanceCriteria:[{id,text}]`、`designExcerpt`、本任务 `taskIds` 匹配的 `testCases`、`sources:[{path,sha256}]`。任务描述保留 `~预估`，verification 保留「验证要求」中本任务的行；设计按 UTF-8 最多 64 KiB，超限加 `truncated:true`，未提供 test-cases.json 时用空数组及三项来源。

宿主复用 `.cm-specs-status.specFiles` manifest 校验完整批准清单及读取字节；来源路径相对 specsDir，哈希沿用 manifest 的任务/AC 运行期勾选规范化规则，其他正文保持精确绑定。新建、开发派发、受保护提案写入、审查及完成前发现不一致以 `spec_drift` 阻断；已有 run 即使规格重新批准也不能替换其原始材料。baseline 保存材料及私有规格根供回放和重验，审查包只携带材料，参与 `packageDigest`。

`requirements` 是可选补充材料（代码项目内 README 等，可用 `[]`），不再承担唯一的任务描述来源。按 specification 的 AC 与接口契约实现和审查；材料不构成扩权授权，不改变 scope、protected_specs、Review 或完成门禁。旧 baseline/package/receipt 缺少新字段时按原格式校验，不重写历史摘要。

（真实 dogfood 事故：specs 在代码根之外，受保护 coder 和 reviewer 只能看到代码根 requirements，缺少任务行、AC 与接口契约，曾需手工复制规格摘要才可开发。）
