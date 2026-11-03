# 必验合同与分层完成摘要

适用于新增必验合同的源码；旧运行按创建时保存的格式恢复，安装或发布状态不能由本文推导。

## 必验合同的来源

只有本任务或明确关联的 AC/必验用例写了 `必验:`、`必验合同:`、`必验条款:`、`必跑测试:`、`必跑检查:` 或 `mandatory acceptance:` 等明确标记，新运行才把 `specification.acceptanceContract` 与原规格材料一起冻结到 baseline、journal 和独立审查包。
普通任务、AC、`测试文件:`、基线说明、设备元数据单独出现不启用新合同。未启用时预览标为 `legacy_unprotected`，不因缺少 AC 映射或宿主 verificationGate 新增阻断，原有检查、独立审查和完成门禁照旧执行。
合同是批准规格的只读投影，不是第二套规格库，也不授予执行权限。

合同包含 `version:1`、`taskId`、`obligations`、`requiredTests`、`requiredCommands` 和 `unresolved`。
每条义务有稳定 `id`、原文 `requirement`、`evidenceType`、`environment`、`run` 与 `result`。
启用后的来源包括本任务声明及缩进续条、专用验证要求段中精确以任务编号为键的条款、显式关联的 AC 及续条、本任务的阻断用例和被引用用例；间接引用也须展开。
需求标题、版本表、普通共享说明和其他任务中提到本任务的文字不进入合同。仅显式 `Shared:` 等验收说明保留为共享义务。
AC 以既有声明语法解析；任务正文或关联用例的 `acIds` 建立映射。
已明确启用合同且存在 AC 却没有明确任务映射时，合同保留 `unresolved`，要求修改并批准规格。
缩进子标题不能截断本任务或 AC 的验收条件。

## 批准前预览

`cm-prd` 的人审摘要附带 `acceptancePreview`，逐任务列出将冻结的义务、关联 AC/用例、必跑检查、环境和人工判断项。
规格变更的 `change_confirmation` 也附带同源预览，并绑定当前 `proposalDigest`；展示不改变提案或批准条件。
它与正式运行调用同一个合同构造函数；`contractDigest` 绑定合同，`sourceFiles` 与 `sourceDigest` 绑定本次读取的原文。
`featureInventory` 记录完整功能清单，与本次展示的功能范围分开；新增或删除功能也会使已保存预览失效。
义务附带 Markdown 行号或测试用例的 JSON pointer；多处相同原文保留多个位置，不能精确归属的问题标为相关位置。

保存后的规格可单独只读预览，无需创建运行或请求模型：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-acceptance-preview.mjs" --specs "{SPECS_DIR}"
node "{CM_WORKFLOW_ROOT}/scripts/cm-acceptance-preview.mjs" --specs "{SPECS_DIR}" --feature "1.example" --task "T-001" --json
```

退出码 0 表示要求映射可预览，1 表示需要澄清，2 表示输入或读取失败；三者均不是审批或测试结果。
有批准记录时沿记录中的任务语法；未记录状态的草稿使用当前语法，可显式选择 `--task-grammar 1|2|3`。
旧语法的待批准规格还会复用原批准入口的迁移检查；任务集合变化显示需澄清和原行号，已批准旧规格保持原语义。
已批准文件发生未获批准的变化时拒绝预览，不把当前草稿冒充批准版本。
旧人审摘要没有预览字段时保留原样。当前状态查询发现已保存预览的来源改变时显示 `stale` 或 `unavailable`，不改写旧摘要或审批位。
预览发现的问题须按现有规格修订与批准流程处理；预览不执行检查、不授予开发权限，也不增加旧会话的审批门槛。

## 开发报告与门禁

开发报告 `requirements` 对合同逐 ID 返回：

```json
{
  "id": "从请求中的义务复制",
  "requirement": "从请求中的义务复制原文",
  "evidenceType": "review",
  "environment": "local",
  "run": null,
  "result": null,
  "satisfied": true,
  "evidence": "具体文件、测试名或可供审查的证据位置"
}
```

`id`、原文、证据类型、环境和 run 不能由开发者自行改写。
缺项、重复、额外 ID、类型或环境不符、未解决映射均阻断。
自动模式与人工预检共用这些规则；`verification:disabled` 不取消已明确启用的新运行冻结合同。没有合同的旧规格继续使用原验证协议。
检查命令真实通过后，仍须独立 Review；报告的 `satisfied:true` 不代表人工验收。
实时完成入口从已审 handoff 核对合同摘要、运行/任务/轮次身份与证据，并比较已审命令的必验覆盖。历史 journal 回放仍核对原登记回执、真实检查结果与冻结合同证据，但不再用今天的 Node 绝对路径重新解释过去已接受的选择；此历史路径不会授予新的完成或执行权限。

## 可机械核验的范围

识别到 RED/先失败/先红时，必须有宿主 test-only replay 的失败事实；基线条款必须有宿主实际运行结果。
基线原文明确要求通过或失败时，该结果也被固定，删掉报告的 result 不能规避。否定词不能反向变为正向要求；不要求某结果与明确要求相反结果分开，不能可靠解析的否定保留 unresolved。
真机/物理设备/`设备: 需要` 与 browser 用例保留对应环境和证据类型。
同一句出现多种证据要求、不能可靠区分时记 unresolved，先拆为明确条款并批准，不能静默选择一种。
其他文字原样进入独立审查义务；程序不证明任意自然语言、截图或断言真实有效。

在任务、关联 AC 或必验用例中声明 ``必跑测试: `tests/a.test.mjs` ``，会进入冻结的命令覆盖集合。
合同已由明确标记启用时，`测试文件:` 声明使用同样规则；它单独出现仍保留旧规格路径。文件或测试标识用反引号明确列出。
强覆盖证明支持直接 Node 脚本和 `node --test` 的明确文件列表。Xcode argv 不能证明 scheme 默认 test plan、隐藏 skippedTests 以及实际存在的测试清单；即使显式 only-testing，正向覆盖也保持 unverifiable。明确排除仍可判定缺失。旧开工 advisory 提示保持原行为，不充当强门禁证据。
Node 适配器还识别 `--test-concurrency`、`--test-timeout`、内建 `tap/spec/dot` reporter、`stdout/stderr` reporter destination 和 `--` 分隔符。选项支持独立值和 `=` 形式；重复、缺值和未知选项保持 unverifiable。
这些参数不改变原命令；旧 Node 不支持某参数时，真实检查仍失败。首批实跑环境为 Node 24，未宣称在全部 Node 18 小版本验证。
`npm test`、`npm run test` 和自定义 reporter 尚未适配；不会绕过 npm 生命周期后冒充原命令已执行。
强门禁的实际 Node 检查须使用当前 `process.execPath`；Xcode 使用 `/usr/bin/xcodebuild` 或 `/usr/bin/xcrun xcodebuild`。
裸 PATH 名称及项目同名程序不能证明解释器身份，报告 unverifiable；旧 advisory 提示保留原行为。
缩小 only-testing、增加 skip-testing、Node 名称过滤或分片均不能冒充完整覆盖。
Xcode 的未建模配置筛选、未知选项和未知 build-setting 同样不能证明覆盖。
包装脚本、自动发现、glob 和未建模的 runner 无法仅凭 argv 证明覆盖，报告 unverifiable；需将已批准检查改成支持的明确形式。
独立命令行或 ``执行 `node --test a.test.mjs b.test.mjs` `` 等明确声明同时冻结原 argv。
实际已通过的检查必须执行同一 argv，不能以其他较小的 green 检查代替。
禁止、条件、示例等不明确上下文，以及未支持的 shell 语法，记 unresolved；不得反向要求执行禁止命令。
命令覆盖仅证明调用选择范围；退出状态由宿主检查，断言质量仍由独立审查负责。
长度、项目数或证据预算超限时明确阻断，不能截掉剩余要求获得通过。

开工体检 CLI 从已批准规格读取合同；恢复检查从原运行的冻结 baseline 读取。
PLAN 自报的必验集合不能覆盖或削减该来源。未覆盖时退出码为 1，规格未批准或读取失败时为 2。
开工体检只比较计划命令的选择范围，不产生执行通过证据；实际执行仍由宿主、runner 和完成门禁核验。

## 规格变更与旧运行

长期授权保护任意来源的阻断用例和批准文档明确引用的用例，不以 user/generated/inferred 区分义务强度。
删除要求、改变环境/步骤/预期、缩小必跑范围，或无法证明未减弱的 tasks/design 改写，转入既有具体提案确认。
用户确认绑定当前 proposal digest；泛泛的“继续”和旧摘要不能放行。
可以结构化证明安全的新增任务、对应小标题/依赖、普通设计追加和非验收设计修改仍按原长期授权路径处理。修改或借新增文本弱化旧验收仍需确认；非阻断用例只要提供真实 AC→任务映射，该映射也受保护。
必验用例的 taskIds 必须集合等价；新增未完成关联可能使 QA 延期，不能按超集自动批准。

旧 baseline 没有 acceptanceContract 时，恢复和基线重捕获沿原能力执行，不新增追认的保护或通过结论。已冻结合同恢复时复用原合同及来源摘要，不用升级后的解析器重新编译；来源或本任务范围变化仍走既有漂移/换绑门禁。
摘要标记 `legacy_unprotected`。旧失败、审查、调用次数和完成记录保留。
规格真的改变时，仍走既有变更/恢复规则；新保护不提供清历史、改 runId 或重置预算的捷径。

## 分层完成摘要

`completion` 是只读投影，不替代 tasks、journal、正式 review 回执、QA 或 N8 门禁。

| 层 | 能说明什么 |
| --- | --- |
| task | 当前任务的独立审查、历史完成与当前资格 |
| feature | 当前功能任务数与其最新有效 QA |
| project | 全部已批准功能、剩余任务和项目收尾资格 |
| run | 本运行是否实际收尾，以及当次覆盖范围 |
| productAcceptance | 当前候选及各环境的人工验收声明；明确展示 accepted/rejected/revoked 和来源 |
| deployment | 当前候选及各环境的部署声明；执行结果与部署后验证结果分开 |

缺证据、失败、阻断、跳过分别显示；空待处理清单不代表 PASS。
最新 QA 轮次必须按原 owner 严格核验，旧 PASS 不覆盖新失败或在途执行。
“具备收尾条件”与“已经收尾”分开；`fixture_completed` 或 `run_done` 不等于产品验收和上线。
同一摘要用于状态查询、会话收尾、驾驶员提示、进度文字和交接摘要；读取失败或快照变化不拼接成成功。

## 阻断说明与恢复指引

现有 `guidance` 追加只读 `blockage` 明细，说明当前阶段、门禁记录的原因、可核对的有效证据、原恢复动作，以及检查/审查调用的可能开销。
恢复动作继续取原状态机的合法出口；文本说明不会新增重试权限、重置预算或自动派发操作。
单任务、批次及 v2 目标绑定沿各自原入口；人类可读说明由既有 driver 输出到 stderr，stdout 保持 JSON 协议。

验收失败的具体义务 ID 与原文随既有 checkpoint `reason` 保存，恢复后仍可查询；失败检查沿原检查编号与证据说明。
这些明细是本次门禁记录，不是独立审查或对失败根因的额外证明。旧运行未记录细项时显示 UNKNOWN，不猜测缺哪条。
“仍有效”只取与当前任务身份和快照一致的完成证据；过期、漂移或缺失的证据不会被显示为当前通过。
查询不调用模型、不执行检查、不增加审查次数或写运行状态；显示层失败不改变原业务结论。
共享驱动从轻量显示模块读取格式化函数，不为打印结果加载任务回放或交付账本；`cm-check` 的局部运行时保持可独立运行。原摘要模块仍导出相同显示接口。

## 人工验收与部署声明

`cm-delivery-evidence.mjs` 提供 `preview`、`record`、`status`、`history`。使用 `--help` 查看完整参数。
前三项绑定 `--specs`、`--repository`、`--run`、`--feature` 和 `--artifact` 指向的实际构建文件。
候选必须能从原持久运行回放为已完成任务，并通过当前代码与已审 package 比较；它不要求或代替整个 feature/project 的通过。
构建及报告宜保存在已审源码目录外，避免新增证据文件本身改变已审候选。

```bash
node scripts/cm-delivery-evidence.mjs preview --specs "{规格目录}" \
  --repository "{仓库ID}" --run "{运行ID}" --feature "{功能目录}" \
  --artifact "{构建文件}" --kind acceptance --actor "{验收人}" \
  --environment staging --outcome accepted --note "{实际验收范围}" \
  --report "{人工验收报告}" --json
```

人工验收结果为 `accepted`、`rejected` 或 `revoked`。部署声明用 `--kind deployment`，
以 `--execution succeeded|failed` 记录执行结果，以 `--verification passed|failed|unknown` 记录部署后验证结果。
已知验证结果还须传独立的 `--verification-report`；执行失败不能同时宣称验证通过。
报告和构建按实际字节计算 SHA-256，文件必须为非空、无符号链接的普通单链接文件；每份上限 1 GiB。

确认预览后，由验收或部署负责人亲自在交互终端运行同参数的 `record`（移除 `--json`），核对完整预览并输入显示的确认串。
CLI 不接受 `--yes`、管道中的确认文本或自报 JSON 批准。模型不得替负责人输入确认串。
确认等待期间会重读候选、构建、报告和原记录头；任一改变即拒绝，需重新预览。

记录追加至规格目录 `.reviews/.delivery/`，不改 tasks、原执行 journal 或正式 review 回执。
并发写入使用原子不可覆盖发布；失败及旧声明保留。查询按环境取最新声明，不以旧 accepted 覆盖新 rejected/revoked。
`status` 按规范化环境名（trim 后转小写）选最新声明，构建与指定候选不匹配时显示 STALE，不回退到较旧的 accepted；completion 同时展示环境、构建摘要和声明结果。历史声明原文保持不变。
候选、批准规格、报告或构建变化时为 STALE；缺失/损坏时 UNKNOWN，不回退为旧成功。
`history` 用于查看保留的原声明，不能当作当前资格。账本根目录仅忽略 `.DS_Store` 等已明确允许的 Finder 元数据，不忽略未知序号或损坏记录。
宿主完成摘要最多读 32 MiB 运行日志，交付证据本次投影的哈希预算为 8 MiB，同一路径只读一次；超限显示 UNKNOWN，不采用未核验的旧缓存。显式交付 CLI 保留完整文件核验。该限额不宣称已消除所有同步查询开销。

状态 `recorded` 只表示当前绑定的本地声明已记录。声明者姓名和报告内容没有外部身份认证，工具也没有查询部署平台。
本地文件所有者可以修改本地数据，摘要不是数字签名。实际人工验收、远端部署与部署后检查仍需负责人执行并提供真实报告。
这些声明不自动完成 task/feature/project，不执行部署，不构成部署授权。没有真实声明的旧运行保持 UNKNOWN。

## 耗时、用量与重复执行分析

```bash
node scripts/cm-run-analysis.mjs --specs "{规格目录}" --run-id "{运行ID}" --json
```

省略 run-id 汇总该日志内可识别运行；省略 json 输出人类摘要。输入仅为规格本地 `运行日志.jsonl` 的一次稳定快照，上限 32 MiB / 100000 行。
Token 复用既有 usage 身份及计数合同，标明 observed/partial/unavailable；Python 3 不可用时只降级 usage。
阶段时间按实际 CM AI/PRD 日志配对，保留返回、失败、中断等事实；returned 不等于业务通过。
活动区间并集避免重复相加，未记录的等待时长保持未知。不同运行的时间分别计算，再汇总可观测工作量。
重复信息表示相同路由的多次模型调用声明或同任务多个 QA 启动；不能证明命令相同、执行多余或可跳过。
日志损坏、身份冲突和读取漂移拒绝；查询不写状态、不调用模型、不降低检查、验收或重试门槛。

## 尚未提供的能力

接近 1 MiB 的人审摘要与内嵌预览合并预算尚未重新设计；超限仍明确拒绝。Swift 源路径到 XCTest 标识的映射、多代码根宿主实跑事实，以及超出 64 条/报告预算的大型必验合同尚未扩展。明确启用的合同遇到这些条件会保留无法验证或预算阻断，不能伪造覆盖。
