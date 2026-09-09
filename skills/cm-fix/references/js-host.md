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
3. 配置是数据文件，不是脚本模块。读取 `../../../scripts/cm-fix-host.mjs` 的配置解析与
   `--help`，按已批准范围填写 `specsRoot`、`identity`、`defect`、`reproduction`；后者为
   `{cwd, command, expectedFailure:{exitCode,outputIncludes}, timeoutMs}`，命令使用 argv 数组。
   可选 `redTest`、`baseline`、`testAuthor`、`repair`、`walkthrough`、`applicableAgentFiles`
   必须先按 `../../../runtime/js/cm-fix/` 中对应模块的实际合同配置，不能临场发明字段。
   首次启动前固定所需配置；持久运行不支持通过改配置文件解除阻断。
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
按当前授权选择 `--review-config` 及 CLI 列明的 `--allow-*`，不要一次性全开。

### 同仓 specs 的受保护修复

在原fix启动配置显式设置`"protectSpecs":true`，QA子运行则设在原owner/template的configuration内。
这不增加权限：原复现、编写测试、修复、回归、Review、Learning写回和finish仍分别授权。
复现/红测/存量基线/修后及审后回归/命令走查使用同一原生specs只读沙箱；日志、证据和Learning仍由原owner负责。
固定命令执行器使用本机Codex sandbox，不调用模型；Claude宿主的推理和Review仍属Claude，不借用Codex身份或诊断。

`fix_test_author`/`fix_repair`请求若有`editMode:"protected-text-v1"`，当前会话只读取和生成提案，**不直接修改文件**。
按请求scope和expected返回`{outcome,edits:[{path,beforeSha256,content}]}`，content为完整UTF-8正文，null删除已有文件，
beforeSha256严格复制expected中该路径的摘要（原不存在则null）；不能改路径范围或先自行落盘。blocked须edits为空数组。
原64KiB通道上限不变，不能用外部脚本/命令/binary替代超限正文；无法表达则如实阻断，不切回无保护写入。
固定子进程校验整组路径/原摘要后在沙箱内写入；符号链接、硬链接或漂移拒绝。保留原diff检查、Review和门禁。
这是同一次原已登记操作，不新增provider调用或作者身份；中途失败可能留下部分改动，原owner保留unknown，不能自动重试或回滚。
恢复必须保持原配置，旧运行不能临时开启/关闭保护。宿主本身仍是受信执行者，语义/浏览器请求不授权修改项目文件。

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
首轮 changes_requested 或已批准后的明确回归/走查失败走 `prepare_revision`，保留历史，
第二次修复仍需 fresh 独立 Review；不得重置 ≤2 轮上限。unknown 不重派。

修复完成仅认原 `finish` 的当前结果与证据；待授权、失败、漂移、缺证据如实报告，
不手工补成功。当前 finish 仅支持 delivery:diff；Git/发布/安装不在这些开关的权限内。
退出通道用 `host_close` 或 EOF；只有用户明确取消才发 `cancel`。

本接线是源 Skill 指令，不证明安装副本已加载或真实双宿主验收。保持原输出格式，
同时报告已做、剩余、阻断和下一步；完整 JS workflow 的其余缺口不降为可选项。
