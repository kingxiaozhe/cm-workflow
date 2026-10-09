# cm-fix 当前会话 JS 入口

这是现有七步流程的执行接线，不是另一套修复或完成规则。路径从本参考解析，
插件根为 `../../..`；不使用固定缓存路径、不安装或更新用户级 Skill。

## 启动与权限

1. 完成 Skill 的只读准入，重读目标根及适用 AGENTS；核对真实缺陷、代码根、specs 根、
   命令式失败签名与测试范围。同仓specs使用下文protectSpecs模式。先确认当前环境支持原命令执行器；Windows
   进程树暂不支持。没有旧测试但能写新回归测试时，按下文显式声明无存量测试；
   纯视觉替代、裸项目走下文原owner分支，不能伪造命令或specs跨过。
2. 从当前真实宿主确定 `--runtime codex|claude`，不能让模型选择另一端规避失败。
   用真实会话身份作为 `--host-context`；恢复必须保留原身份、配置与 runtime，不冒用旧会话。
   换会话恢复时，`--host-context` 填当前真实会话，另加 `--original-host-context` 填创建这次运行的旧会话 ID
   （取自 `specs/.reviews/.execution/<runId>/state.json` 首条 `fix-configuration` 记录的
   `configuration.hostContextId`）。durable 配置与指纹保持原样、旧记录一字不改；填错只会 `fingerprint_mismatch`
   失败退出。同会话重开不带此参数。换过几次会话都只填最初那个：新会话第一次签审查授权前，会先在存档里追加一条
   `fix-host-joined-N` 记下自己，所以之后任何会话都认得它签过的授权。只打开看状态不会写这一条。
   创建会话、记下的接手会话、当前会话都算宿主，reviewer 必须独立于其中每一个；接手会话最多记 16 个。
   0.16.1、0.16.2 期间换会话签过授权的旧运行没有这条记录，只能由当时签授权的那个会话继续。
3. 配置是数据文件，不是脚本模块。读取 `../../../scripts/cm-fix-host.mjs` 的配置解析与
   `--help`，按已批准范围填写 `specsRoot`、`identity`、`defect`、`reproduction`；后者为
   `{cwd, command, expectedFailure:{exitCode,outputIncludes}, timeoutMs}`，命令使用 argv 数组。
   可选 `redTest`、`baseline`、`testAuthor`、`repair`、`walkthrough`、`applicableAgentFiles`
   必须先按 `../../../runtime/js/cm-fix/` 中对应模块的实际合同配置，不能临场发明字段。
   首次启动前固定所需配置；持久运行不支持通过改配置文件解除阻断。
   地图同步按 `../../codebase-context/references/writeback.md` 在启动前确定文档路径并纳入
   已批准的 `repair.scope`；`fix_repair` 内完成回写，缺范围不在宿主外补写。
   本次参考且保留路径的现有地图加入 `repair.requirements` 作为只读审核材料；新建或已批准删除/改名
   的地图只进写 scope，由真实 diff 的 after/before 携带；不能为审核把只读材料变成写权限。
4. 根因/最终 reviewer 配置及诊断沿用 `../../../scripts/cm-ai-host.mjs` 的
   `readConversationReviewConfiguration` 和对应 runtime preflight 合同；诊断输入是该脚本
   所要求的 cm-ai 配置，不把 fix 配置直接当作诊断配置。诊断不等于真实模型可用或外发批准。
   Claude 不能复用 Codex receipt 或非空 disabledSkills；不手造诊断、grant 或 Review 结果。
5. 启动参数只包含当前已获授权的操作。`--allow-reproduction` 授权实际复现，不是只读开关。
   根因/最终 Review 的真实调用须另有本轮包与模型授权，分别使用 `--allow-cause-review`、
   `--allow-final-review`；测试编写/修复也要求原 reviewer 诊断与各自权限，不能以诊断代授权。

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-host.mjs" serve \
  --config "{FIX_CONFIG}" --mode create --host-context "{真实当前会话ID}" \
  --allow-reproduction --runtime codex
```

这是已授权复现的最小启动示意，不是完整修复配置。Claude 改为 `--runtime claude`；
重开使用 `--mode resume`，它与下文观测恢复消息 `resume` 不是同一操作。

### 用驾驭员，不要手搓中间人

宿主靠标准输入一行一行喂 JSON，而当前会话每次只能执行一条命令、抱不住长活进程。**不要临场
写一个中间人脚本**——一次真实实跑里两次配错（走查模块对不上、任务编号重名）根源都在这儿。
仓库自带 `scripts/cm-fix-drive.mjs`，一次只做一步：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-drive.mjs" --plan "{PLAN}" advance
```

`PLAN` 是一份小 JSON：宿主配置路径、代码根、`create|resume`、当前真实会话 ID、换会话时的
原会话 ID、`--allow-*` 开关数组（原样传给宿主，不另造一套词）、答案目录。宿主中途的反问
（学习记录、诊断、测试内容、修复内容、复盘）从答案目录里按种类读文件——**你的工作是把内容
写进文件，再调一次驾驭员**；它绝不替你编任何一份。普通恢复时按历史顺序复用当前生效的 Learning，包含重新诊断记录中的新应用；显式 `rediagnose` 必须重新读取当前适用教训。

它最要紧的一条护栏：按「这一步会反问什么」**先查齐答案文件，再发指令**。宿主默认不重派
结果不明的步骤；只有下文列出的本地步骤可经显式授权、说明原因后放弃并重做。缺答案硬发仍会让
整轮停在 `unknown`，不能靠普通 `advance` 解除。建运行前它还会预告：任务编号是否已被
审查结论占住、配置引用的文件是否存在、受保护模式下有没有沙箱跑不了的 tsx/vitest 类命令。

写测试与修复的应答随模式不同：受保护模式回 `{outcome,edits}` 提案，由沙箱写入；非受保护模式由驾驶员代会话把答案文件写进宿主给的 scope，只回 `{outcome}`。
答案里有 scope 外的路径时两种模式都回合法的 `blocked`，不写任何文件。

它只是方便，不是放权：能做什么仍由宿主的开关说了算。
按当前授权选择 `--review-config` 及 CLI 列明的 `--allow-*`，不要一次性全开。

### 已完成根因审查拒绝后的原运行重新诊断

当 `status.stage` 是 `rediagnosis_required`，有效 `changes_requested` 已保存，
`advance`、`abandon_step` 和 `abandon_review` 都不能改写这项审查结论。
standalone cm-fix 可在原配置、原 run、原 task attempt 下显式 `rediagnose` 一次：

1. 对照原 finding 重新读取源文件和适用教训，准备新的诊断；不要修改复现输入或已审源文件。
2. 驾驶员 PLAN 使用 `mode:"resume"`、原 `config`，保留当前真实 `hostContext`、runtime；
   换会话时按上文填写 `originalHostContext`。PLAN.permissions 添加 `--allow-rediagnosis`，
   单行 `reason` 不超过 1000 UTF-8 字节。驾驶员已传宿主启动要求的 `--allow-reproduction`，
   不在 permissions 数组重复它；手动启动宿主仍须带此旗标，重新诊断不执行复现。
   答案目录须有新的 `learning.json` 和单独的 `diagnosis-rediagnosis.json`（沿用原诊断 schema）；
   不会复用 `diagnosis.json` 或自动执行原复现命令。
3. 执行 `node "{CM_WORKFLOW_ROOT}/scripts/cm-fix-drive.mjs" --plan "{PLAN}" rediagnose`。
   手动宿主相同操作为
   `{"requestId":"redo-cause-1","operation":"rediagnose","reason":"按原 finding 重新核对根因"}`，
   启动必须带 `--allow-rediagnosis`。
4. 成功进入 `cause_review_required`，即使新诊断认为只有一层也必须重新独立审查。
   取 `cause_review_package`，按原诊断/模型/授权合同再调用 `cause_review`；使用 fresh reviewer thread，
   旧 reviewer thread 不可复用；后续最终 diff 审查也排除两轮根因 reviewer thread。新包绑定旧历史、旧审查和恢复原因，新证据写 `cause-r2.md`；
   `cause-r1.md` 和所有旧记录保留。批准才回到原测试/修复流程，最终 diff Review 和完成门禁不变。

新的诊断仍需补证据时进入 `rediagnosis_blocked`；第二次审查拒绝停在
`rediagnosis_review_limit_reached`。源文件漂移、r2 证据占用、无效 reason 在追加前拒绝；异步准备返回后再次核对源包与 r2 占位，拒绝不消耗唯一续次；
不能清档、覆盖旧结论或换 run 重置上限。不合格的诊断答案（如 `investigation.discardedAlternatives` 超过 3 项）返回 `invalid_diagnosis` 并写明字段与上限，驾驶员开宿主前即用同一校验器拦下；
`pending=rediagnosis`（已登记 `fix-rediagnosis-intent`、尚无结论，含旧版本因此卡住的运行）时改好答案再执行同一 `rediagnose`，在已登记的这一次续次下重新作答，不另占次数、不改旧记录，之后照常进入 `cause-r2`。
新审查中断或没有结论时停 `unknown`，不自动重派、不提供第三次审查；可按下文「原因审查与第二轮最终审查无结果时的一次性放弃」用 `abandon_review` 在同一第二轮重审一次。当前仅 standalone 接线，不宣称 QA-fix 子宿主支持。
这项恢复需要实际新诊断和独立审查；合成夹具成功不表示真实产品已恢复或已修复。

### 同仓 specs 的受保护修复

在原fix启动配置显式设置`"protectSpecs":true`，QA子运行则设在原owner/template的configuration内。
这不增加权限：原复现、编写测试、修复、回归、Review、Learning写回和finish仍分别授权。
复现/红测/存量基线/修后及审后回归/命令走查使用同一原生specs只读沙箱；日志、证据和Learning仍由原owner负责。
固定命令执行器使用本机Codex sandbox，不调用模型；Claude宿主的推理和Review仍属Claude，不借用Codex身份或诊断。

沙箱里 `network={enabled=false}`，而这个开关同时管着 unix domain socket 的 listen。于是**凡是要开本地
IPC socket 的命令都会失败**，典型的是 `tsx` CLI（启动时在 TMPDIR 建 `<pid>.pipe`，报
`Error: listen EPERM`），`vitest` 等同理；写 TMPDIR 文件本身不受影响。这不是配置能绕开的：放开它就等于
给测试命令放开整个外网。配 `baseline.commands` / `redTest` / `walkthrough` 时请避开这类命令，例如把
`npm test`（内部串联 12 个 `tsx xxx.test.ts`）换成逐文件的
`node --import ./node_modules/tsx/dist/loader.mjs <file>`，覆盖面不变而沙箱能跑。

沙箱内失败只会留下 `outcome:"failed"` 和 `host check exited N`——原始输出**有意**不进证据（可能含密钥、
且不稳定）。要看真实原因，手工重放 `specsPermissionArgs` 拼出的那条 `codex sandbox ... -- <命令>`。
配置里留了跑不了的命令，代价是修复前后都失败、回归判 `unresolved_failure`，整轮卡在 `regression_blocked`。

`fix_test_author`/`fix_repair`请求若有`editMode:"protected-text-v1"`，当前会话只读取和生成提案，**不直接修改文件**。
按请求scope和expected返回`{outcome,edits:[{path,beforeSha256,content}]}`，content为完整UTF-8正文，null删除已有文件，
beforeSha256严格复制expected中该路径的摘要（原不存在则null）；不能改路径范围或先自行落盘。blocked须edits为空数组。
默认通道仍为64KiB。锁文件等大文本可显式配置驾驭员inputLimit/宿主--input-limit（至多4MiB），使用同一完整UTF-8正文提案；单文件及提案数据校验仍限1MiB（含JSON编码开销），传输上限不扩大内层数据限制，原范围、摘要、沙箱和Review保护不变。不能用外部脚本/命令/binary代替正文；超出上限如实阻断，不切回无保护写入。
固定子进程校验整组路径/原摘要后在沙箱内写入；符号链接、硬链接或漂移拒绝。保留原diff检查、Review和门禁。
这是同一次原已登记操作，不新增provider调用或作者身份；中途失败可能留下部分改动，原owner保留unknown，不能自动重试或回滚。
恢复必须保持原配置，旧运行不能临时开启/关闭保护。宿主本身仍是受信执行者，语义/浏览器请求不授权修改项目文件。

### 本地 unknown 步骤的显式放弃与重做

先核对旧进程已停止、检查可能留下的本地改动和测试输出。仅在原运行 `stage=unknown` 且决定重做该本地步骤时，
以 `--allow-abandon` 启动 cm-fix 宿主，再发送 `{"requestId":"abandon-1","operation":"abandon_step","reason":"本次放弃的具体原因"}`。
原因须为非空单行、至多 1000 UTF-8 字节；每个运行最多 8 次。QA-fix 子宿主使用 `--allow-qa-fix-abandon`，
其 `fix_action` 请求带 `fixOperation:"abandon_step"` 和 `reason`。驾驶员从 PLAN 的 `reason` 读取原因，
`permissions` 须含 `--allow-abandon`，此操作不需要答案文件。

允许的 `pending`：`reproduce`、`diagnose`、`observation_reproduce`、`observation_diagnose`、
`test_author`、`red_test`、`baseline`、`repair`、`regression`、`retrospective`、`walkthrough`、
`post_review_regression`，以及 `revision_test_author`、`revision_test_check`、`revision_repair`、
`revision_regression`、`revision_retrospective`、`revision_walkthrough`、`revision_post_review_regression`。
拒绝 `cause_review`、`final_review`、`revision_final_review`、`learning_writeback`、
`revision_learning_writeback`、`handoff`、`revision_handoff`；第一轮最终审查仍只走既有人工续审，
原因审查与第二轮最终审查改用下节的 `abandon_review`。

成功放弃只追加 `fix-abandoned-N` 和 `abandon` 日志，`status.abandoned` 列出步骤、原因、时间；
旧 intent 和部分结果保留。下一次单独执行原步骤，新 intent/result 使用 `-retry-N-` ID，
红灯原始输出另存 `-retry-N.md`，不覆盖旧输出。`advance`/`run` 遇到 `unknown` 仍停下，
且放弃本身不证明旧操作没有产生部分本地改动。未经显式授权或不在上表的步骤返回 `fix_abandon_unavailable`。

写测试与修复（`test_author`、`repair` 及其 `revision_` 形式）放弃后，`fix-abandoned-N` 带 `baselinePinned`：重做的 intent 必须登记第一次 intent 拍下的审查基线（不在重做时按当前盘重拍），
被放弃那次写下的残留因此算进本步骤改动、经回归与独立审查，不会变成「修复前原样」。范围外文件与固定基线不同时拒绝为 `fix_pinned_residue`（列出路径）；
受保护模式（宿主应用提案）连范围内也必须先还原到固定基线，否则拒绝为 `fix_protected_residue`，半成品不会当成新交付送审。
经过根因审查的运行，放弃修复后本轮残留不再判为 `cause_review_drift`；修订轮重做沿用固定基线，不再因残留报 `fix_revision_source_mismatch`。旧运行没有 `baselinePinned` 的记录按原样回放。

### 合法阻断结论的带理由重跑

`test_author_blocked`、`repair_blocked`（会话答 blocked）、`regression_blocked`（回归结论 inconclusive，含视觉 BLOCKED）、`post_review_regression_blocked`、`walkthrough_blocked`
（证据缺、环境不符、清理失败）以及它们的 `revision_` 形式不是应答失败，但处理好原因后可在原运行重跑这一步：以 `--allow-rerun-blocked-step` 启动 cm-fix 宿主，
发送 `{"requestId":"rerun-1","operation":"rerun_blocked_step","reason":"已处理的阻断原因"}`（驾驶员：PLAN `reason` + `permissions` 含该旗标）。
宿主追加 `fix-blocked-rerun-N`（绑定该步骤 intent 与阻断结果的摘要），阶段回到该步骤的 `*_required`，下次执行用 `-retry-N-` ID；阻断结果保留为历史，
写测试/修复同样固定基线。每个步骤最多重跑 2 次（`status.blockedRerun` 显示已用次数），用满报 `fix_blocked_rerun_limit`。`defect_remaining`/`regressed` 仍走 `prepare_revision`。
QA 修复子流程的 `fix_action` 暂不接受此操作（与 `rediagnose`、`recover_final_review` 同属第 3 批）。

### 原因审查与第二轮最终审查无结果时的一次性放弃

原因审查（`pending:"cause_review"`，含重新诊断后的第二轮原因审查）或第二轮最终审查（`pending:"revision_final_review"`）已登记，却没有审查结论时——
宿主中途被杀、审查超时、断连或被取消，或审查进程正常结束但答案不合审查结论格式——`status` 为 `unknown` 并带 `reviewAbandonable`。
答案不合格式（如 `invalid_finding_path`、`missing_material`、`contradictory_verdict`）现在记为一条失败观察
（`observation.result` 为 `{status:"failed",code:<该代码>}`），不再整条丢掉、只留无记录的 unknown。
先确认旧审查进程已退出，再以专用的 `--allow-abandon-review` 启动（`--allow-abandon` 只管本地步骤，不授权放弃审查调用），发送
`{"requestId":"abandon-review-1","operation":"abandon_review","reason":"旧审查进程已确认退出"}`；
QA-fix 子宿主用 `--allow-qa-fix-abandon-review`，`fix_action` 带 `fixOperation:"abandon_review"` 和 `reason`；驾驶员 PLAN 的
`permissions` 相应填这两个旗标。原因规则同 `abandon_step`。每一轮原因审查各可放弃一次（第一轮与重新诊断后的第二轮分开计），第二轮最终审查可放弃一次；
放弃只作废那次无结论的调用，不产生审查结论、不增加审查轮数，第二轮原因审查拒绝后仍是 `rediagnosis_review_limit_reached`。
同一轮审查重审仍无结论时返回 `fix_review_abandon_budget_exhausted`，
`status.reviewAbandonBudgetExhausted` 为 true，只能按原阻断处理，不能继续重派。

放弃追加 `fix-cause-abandoned`（第二轮为 `fix-cause-rediagnosis-abandoned`）或 `fix-revision-final-abandoned`，绑定原调用 ID、登记摘要、已知线程和无结论结果的摘要，
写 `abandon` 日志，并回到 `cause_review_required`（或原迟到纠正阶段）/`revision_final_review_required`。
重审仍需原 `--allow-cause-review` / `--allow-final-review` 和一次新的授权，记录改用 `fix-cause-retry-*`（第二轮为 `fix-cause-rediagnosis-retry-*`）/
`fix-revision-final-retry-*`；新调用的审查线程不能是被放弃的那条。
第二轮原因审查包（首次派发与放弃后重审都是现场重建）另带 `contextFiles`：第一轮审查 `examinedPaths` 与各条问题引用、
却不在新 `affectedPaths` 里的代码文件（存在于代码根的普通文件），作为只读上下文并计入 `examinedPaths`，审查者可以引用；
重审的新包有新摘要，绑定在 `fix-cause-rediagnosis-retry-registered` 里，被放弃那次的记录不改。旧的第二轮登记没有该字段，照原样回放。旧记录一字不改，没有放弃记录的运行照原样回放。

审查等待使用审查配置 `--review-config` 的 `timeoutMs`（1–3600000 毫秒，省略为 900000），同时交给审查 worker；
不再使用 `reproduction.timeoutMs`。原因审查到时会记下超时结果（`transport_timeout`），不再停在无记录的 unknown。
自行嵌入 owner 而不提供审查预算的调用方仍沿用复现超时。

### 无specs普通项目

无specs普通项目可省略specsRoot或传null；代码根仍来自reproduction.cwd。原owner将档案存于docs/fixes，
审查/控制证据存于docs/fixes/.reviews，使用原无specs日志模式并跳过METRICS。不创建规格或假任务，原Review/Learning/finish不变。

### 无法写自动红测的纯视觉缺陷

先用获准内置浏览器取得真实修前截图/录屏，并固定本地路径及SHA256。reproduction配置为
`{kind:"visual",cwd,timeoutMs,before:{path,sha256,kind:"screenshot"或"video",description},reason,environment,steps,expected}`；
reason说明无法写自动红测的原因；environment沿原local/test载体映射：web/browser，app/模拟器或设备，小程序/开发者工具或设备；步骤与预期必须明确。
redTest使用相同视觉配置并加testFiles:[]，不配testAuthor或假命令；baseline仍保留实际存量测试，确无存量才用下节显式声明。
修复/回归等原权限不变。视觉回归qa_browser带before/evidenceRoot，实际比较并将新的修后载体保存到该证据目录，
返回`{verdict:"PASS"或"FAIL"或"BLOCKED",after:{path,sha256,kind,description}或null,environment,cleanup,explanation}`。
cleanup为completed/not_needed/failed，缺载体或清理失败必须BLOCKED且after:null；不要用静态推断、旧图或合成图作为真实PASS。
JS核对路径/媒体签名/摘要与独立修前修后载体，视觉判断仍由当前工具宿主负责，不声称像素自动断言。
修前/修后证据以visual检查进入同一原handoff/独立Review/finish，不伪造shell command或exitCode。
原最终walkthrough仍按其已有qa_browser合同返回；两种请求看具体payload，不混用结果格式。

### 无存量测试声明格式

先检查项目测试文件和声明的测试命令；确实没有旧测试时，启动配置的 `baseline` 可用：

```json
{"cwd":"{CODE_PROJECT}","testFiles":[],"commands":[],"timeoutMs":60000,
 "noExistingTests":"已检查哪些目录和命令；为什么没有存量测试（不超过1000 UTF-8字节）"}
```

这只是当前宿主的明确声明，JS 不从空数组证明项目没有测试。它进入原配置指纹、基线记录、
缺陷交接和最终独立 Review；缺失声明或同时列出旧测试/命令均拒绝，不自动跳过失败旧测试。
仍配置真实 `redTest`（需要编写时使用原 `testAuthor`），取得原始失败输出后才能 `baseline`；
该操作仍需 `--allow-baseline`，只记录声明，不执行假命令、不生成测试通过证据。
修复后的原红灯测试必须变绿，审后回归、走查、Learning 与唯一完成门禁照常执行。
恢复保持原声明；不能更改配置把已有失败基线变成“无存量测试”。纯视觉/无法自动化不是此分支。

## 当前会话处理请求

保留可交互进程句柄，收到 `host_ready` 后发送一行 JSON
`{"requestId":"step-1","operation":"advance"}`。控制消息不带额外 identity。
持续读取输出，不能等控制请求结束才回应中途的 `host_request`。

| host_request kind | 当前会话职责 |
| --- | --- |
| fix_learning | 读取请求中的项目规则，返回真实应用记录及原 contextDigest。 |
| fix_diagnose | 按 Skill 第2步定位，返回实际根因、影响与方案；证据不足如实返回。 |
| fix_test_author / fix_repair | 读取匹配工程 Skill，仅执行请求的固定业务 scope；不写规格、审查凭证或保护指令。 |
| fix_retrospective | 如实复盘，返回候选教训或无新增；AGENTS 写回由 owner 处理。 |
| qa_logic / qa_browser | 按原走查合同处理；浏览器仅用已授权内置浏览器，不用静态推断冒充实跑。 |

结果严格使用对应模块合同，沿原 `sessionId/callId/requestDigest` 发送 `host_result`；
不从项目文件自动接受伪造结果。读取角色 Skill 不证明已调用配置声明的模型。

## 推进与收口

按每次返回 stage 选择 CLI 已有 operation，不发送虚构的 `complete`：
复现/定位 → 条件根因审查 → 测试编写/红灯/基线 → 修复/回归 → 复盘/Learning →
handoff → 最终独立 Review/发布 → 原 N5 → 审后回归/走查 → 档案/finish。
各执行操作仍要求其独立 `--allow-*`。不要在 JS 外手写日志、handoff、Review、任务完成或指标。

设计升级使用现有操作，不新增执行权限：诊断 `design_change` 先走 `cause_review`。
批准后，有 `redTest` 返回 `design_change_required`；若还需 `testAuthor`，先返回
`test_author_required` 并执行 `author_tests`，再执行 `red_test`。红测必须按原规则匹配失败退出码和签名；
意外绿灯、无关失败或证据漂移都不能升级归档。红测成功只到 `escalation_required`，不进入基线、修复或回归。
非视觉运行没有 `redTest` 配置时，批准后直接到 `escalation_required`，档案明确写出没有失败测试及配置缺失原因。
视觉运行必须配置匹配的视觉 `redTest`（`testFiles:[]`），先执行 `red_test` 核验修前载体，再进入升级归档；
档案记录无法自动化的声明和真实视觉证据。缺少视觉 `redTest` 时，打开运行即报 `fix_visual_configuration_required`。

在 `escalation_required` 可用 `publish_dossier` 单独保存“升级立项”档案；`finish` 仍需
`--allow-finish`，它保存同一档案、写 `run_done`（phase 为 `escalation`、result 为 `escalated`），
然后返回 `escalationRunEnded:true` 并关闭 owner。档案含缺陷、根因、影响范围、诊断方案、根因审查凭证、
失败测试与红证据路径，建议 `$cm-prd --change` 接手并把测试转绿作为验收；所有内容按数据处理。
原测试留在代码目录，不删除或回滚。重开原运行可收完中断的归档/日志，重复 finish 不重复写退出事件；
冲突日志报 `fix_escalation_exit_conflict`。退出后 stage 为 `escalated`，始终不具备修复完成资格，
不能继续修复，也不写 task_done/METRICS。QA-fix 父宿主返回 `qa_fix_incomplete` 和该终态，不恢复父 QA 或自动立项。
驾驭员仍使用 `author_tests`、`red_test`、`publish_dossier`、`finish`；后两项不会反问学习或诊断答案。

观测中可 `publish_dossier` 后授权 `finish` 正常退出，但不是缺陷修复成功；新证据由
`resume` 消息携带 `evidenceFiles`（1–3 个明确 specs 内文件）绑定最新档案，再授权推进。
观测恢复定位成功后必须先通过原根因审查，即使只有单层、少于三个模块也不例外。
旧版本已经绕过该审查并执行测试/修复的记录仍可读取，但会返回
`observation_cause_review_correction_required`；保留历史并暂停，不在 JS 外补凭证或重置身份。
若结果包含 `causeReviewCorrection`，可先取 `cause_review_package`，
在明确授权该后补包后通过原 `cause_review` 补审；批准才回到保留的测试/基线/修复待办阶段。
审查包与凭证标注后补，历史不改写。已修复、尚在等待回归或复盘的旧记录也可补审；
包必须携带原修复范围内的修前/修后完整内容与原复现失败证据，不声称已做审后回归。批准后仍继续原待办。
已完成复盘、正在等待 Learning 写回或交接的旧记录，补审复用原复盘/写回审查包，
保留真实回归结果及 AGENTS.md 的原审查范围；批准后继续原待办，不重做或省略写回。
交接已生成但最终审查尚未登记时，也可补审；补审绑定原 handoff SHA，交接文件不得改写，
批准后仍须发起原最终独立审查。原最终审查已完成且 approved、任务尚无完成记录时，
等待 N5、审后回归或收口的旧记录也可补审：绑定原最终登记/观察摘要，排除原最终审查线程，
保留原批准与交接字节，补审批准后继续原门禁。进行中、unknown、未批准或已开始完成写入的
旧记录不在此恢复范围，不自动重试或重开。
第一轮最终审查要求增加或完善测试时，先读 [第二轮补测接续](test-extension.md)：`prepare_revision` 可附 `tests`，
再走 `author_tests` → `revision_test_check` → 原修复和审查链；已准备但未修复的旧第二轮也能追加计划。

首轮 changes_requested 或已批准后的明确回归/走查失败走 `prepare_revision`，保留历史，
第二次修复仍需 fresh 独立 Review；不得重置 ≤2 轮上限。unknown 不自动重派；上表中的本地步骤只在显式放弃后重做。

修复完成仅认原 `finish` 的当前结果与证据；待授权、失败、漂移、缺证据如实报告，
不手工补成功。finish 接受 `policies.delivery` 的任一取值，只要求它在收尾写记录期间不变；
它写档案/METRICS/task_done，**不执行 Git**——branch/draft-mr 的提交、推送、开 MR 仍由执行者按
SKILL 第 7 步单独完成并记 `delivery` 事件。Git/发布/安装都不在这些开关的权限内。
退出通道用 `host_close` 或 EOF；只有用户明确取消才发 `cancel`。

本接线是源 Skill 指令，不证明安装副本已加载或真实双宿主验收。保持原输出格式，
同时报告已做、剩余、阻断和下一步；完整 JS workflow 的其余缺口不降为可选项。

### 复现尝试记录

复现结果可带 `attempts: [{scenario, dimension, outcome}]`，`outcome` 仅为
`reproduced|not_reproduced|unsupported`；非空时末条必须分别与总体
`reproduced|not_reproduced|blocked` 一致，不能代替命令退出码与失败签名证据。
旧结果缺省此字段仍可读取并沿原流程恢复，旧档案保持原字节，不伪造补齐历史。
新结果由原 producer 记录至少一条；观测档案发布（含恢复后继续观测）对显式空数组
报 `fix_reproduction_attempts_required`，缺省仅保留旧记录兼容。
当前 JS owner 仍只执行配置中已授权的固定复现命令，并据真实结果记录一次尝试；
本次未新增多场景调度、配置入口或执行权限，不把这一条记录当作已完成探索的证据。
Skill 第 1 步的单维度探索与 3 个场景/15 分钟上限仍适用；需要改变命令/环境而当前
owner 配置不能表达时，报告接线缺口，保持原运行身份与权限边界，不在 owner 外补跑或改 journal。
