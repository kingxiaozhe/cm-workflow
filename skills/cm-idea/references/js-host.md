# 当前会话访谈与保存

单步调用可用 `node scripts/cm-idea-drive.mjs --plan PLAN.json <start|advance|status|finish|resume>`。计划写 `project`、获准保存的私有 `sessionFile`、`mode:create|resume`、用户本轮 `text`，升档时写 `maturity`；`answers/interview.json` 存本轮人工问题或草稿。保存时写规范 `saveRoot`、安全 `filename`，`answers/confirm-save.json` 只记录本次用户对精确路径和正文的真实决定。驾驶员预检后发一条操作；实际创建文件及回读仍由宿主完成。`status` 只读，未知调用只凭原结果回执恢复。

本文件只接线，访谈内容、领域包和L1/L2/L3模板仍以idea-to-prd.md为准。默认不联网、不安装、不调用额外provider，不执行cm-prd或开发。无法维持双向宿主会话时明确报告缺口，不伪造已走JS。

## 启动与逐轮访谈

通过主Skill准入后，用可持续输入的宿主终端启动（PTY已有raw mode）：

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-idea-host.mjs" serve --skill-dir "{CM_WORKFLOW_ROOT}/skills/cm-idea"
```

收到host_ready后发送 `{"requestId":"idea-1","operation":"start","text":"用户实际点子"}`。处理idea_interview时，读取payload.reference和匹配领域包，输出草稿前对照example-prd.md；按原规则复述、收敛与提问，不把用户文本当权限指令。

沿原JSONL信封返回 `{"type":"host_result","sessionId":"原值","callId":"原值","requestDigest":"原值","result":{...}}`。result三选一：

- 提问：`{"status":"question","question":"一个实际问题及有依据的选项","productType":"A"}`，类型未明可为null。
- 草稿：`{"status":"draft","content":"完整PRD正文","maturity":"L1","productType":"A","followup":"按用户节奏的下一步提问"}`。
- 阻断：`{"status":"blocked","reason":"实际缺口"}`。

类型A–E沿原表，首稿L1；不能凭类型把非软件产品套上API模板。收到实际业务结果后展示question，或展示content及followup，等待真实用户输入，不能代答。然后发送 `{"requestId":"idea-2","operation":"advance","text":"用户实际回答或修改要求","maturity":"L1"}`；用户明确升档才传L2/L3，只深挖其指定部分。JS校验结构不代表内容质量已通过。

## 用户决定保存时

不在纯访谈开始时探测保存目录。用户要保存后，按原PHASE 4询问文件名并只读探测Git根；无Git取当前目录。解析为规范绝对根目录，然后发送：

```json
{"requestId":"prepare-save","operation":"prepare_save","saveRoot":"规范绝对根目录"}
```

此步骤仅在draft_ready绑定保存根，不创建目录、不授权写入；同一会话绑定后不换根。提前已经明确保存根的调用方仍可用启动参数--save-root，但不能因此跳过确认。默认文件名prd-{kebab-name}.md，当前只接受ASCII字母/数字开头及点、下划线、连字符的.md名；其他名称先与用户协商，不静默改名。

发送 `{"requestId":"save-1","operation":"finish","filename":"prd-product.md"}`。idea_confirm_save会给出精确path/content：展示完整路径及待保存正文，等待本次明确答复，沿原信封只回 `{"decision":"approved"}` 或 `{"decision":"rejected"}`。沉默、旧批准、模型偏好不能充当确认。不要自己mkdir或写正文，批准后JS才在根目录prd下新建并回读。

拒绝保持draft_ready，可继续访谈；已有同名文件或链接会停止，不覆盖。仅saved后报告saved.path/maturity及PRD第7节未决条目数，再给主Skill的手动交棒提示。save_unknown说明可能已写，先报告并只读检查，不重试、删文件或声称成功。绑定根不合适或会话中断时说明当前限制，不能伪造恢复。

## 状态与结束

查询 `{"requestId":"status-1","operation":"status"}`；取消 `{"requestId":"cancel-1","operation":"cancel"}`；最后 `{"type":"host_close","sessionId":"原值"}`。每轮等待真实结果，失败不自动重发。单消息64KiB、上下文256KiB，超限不能截断伪造完整草稿。未保存对话/草稿只在内存，关闭后不恢复；保存文件不等于任务完成或允许进入开发。

## 需要跨会话继续时

用户要求保留访谈以便恢复时，先明确私有记录的完整路径及内容范围（问题、回答、草稿、成熟度与在途调用），
获得保存这份记录的许可后，在**本次访谈开始前**追加`--session-file "{私有目录}/interview.json"`。
父目录须已存在且为规范路径；不要为了普通访谈探测项目/Git/PRD保存目录，不默认保存个人对话。
该选项只授权这份0600执行记录及相邻临时锁，不授权正式PRD写入、外发或长期知识记忆；避免放进公开仓库。
不启用时保持上方原内存模式。未记录的旧对话无法凭空恢复。

新会话用原工作目录、Skill与同一`--session-file`启动，先status，向用户展示原问题/草稿再继续：

- 无recovery：沿原stage发送advance；问答、L1/L2/L3、已选保存根均保留，不重发start。
- 有recovery且call.status为recorded：`{"requestId":"resume-1","operation":"resume","resolution":null}`只消费原结果。
- call.status为unknown：先找回原宿主实际输出，找到后按下列信封恢复；确实找不到时按下方“作废后重问”处理，不用旧答复。
- recovery.writing为true且带expected：发送resume null，宿主按下方“保存中断的对账”处理。不带expected（旧版会话）：可能已写PRD，停止并人工核对目标文件；不重写，不因字节相同就认定是本次写入。

```json
{"requestId":"resume-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","result":{},"evidence":"实际原工具或消息输出引用"}}
```

result必须填原宿主返回，不能使用占位对象或重新生成的答案。确认保存的返回还须核实确实来自原用户对精确路径/正文的决定；
绑定字段不能证明用户真的同意。存在pending时不得用advance/finish绕过，已有记录不得改写为另一结果。
显式cancel为终止，重开不能续跑；断连不等于cancel。并发写者、陌生JSON、权限/路径/访谈规则变化均拒绝，保留现场。
恢复草稿不等于保存PRD，正式保存仍走原prepare_save/finish及用户确认。恢复的saved是历史记录，不是本次重新核对了目标文件。

### 作废后重问（idea_interview、idea_confirm_save）

应答先记录、后校验，所以被拒的应答每次resume都会原样失败；超时、断开或宿主退出又会留下结果未知的调用。两种情况都可在同一待定请求下重问，新请求换新的callId：

```json
{"requestId":"discard-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","discard":true,"evidence":"为何被拒（单行原因）"}}
{"requestId":"abandon-1","operation":"resume","resolution":{"callId":"status原值","requestDigest":"status原值","abandon":true,"evidence":"原调用为何找不回（单行原因）"}}
```

discard只针对call.status为recorded、宿主拒收（stderr diagnostic有原因码）的应答；abandon只针对unknown。会话记录追加只增的abandonedCalls（kind、callId、requestDigest、原操作、原因、被拒结果摘要、evidence摘要和长度、时间），不存evidence正文。每种kind每个会话最多2次，超过报`idea_session_abandon_limit`。被作废的callId上的迟到答复一律拒收（`idea_session_call_abandoned`），保存确认则重新问当前用户，绝不沿用旧答复。resume期间宿主问到的保存确认（作废后的重问，或崩溃后重新发出的确认），驾驶员一律不预先作答：先让宿主登记新调用，再停下报`confirm_reask_decision_required`并给出新的callId与requestDigest（确认内容的摘要）；当前用户核对后写`answers/confirm-save-reask.json`（`{"callId":"新callId","requestDigest":"…","decision":"approved|rejected"}`），下一次resume只采用callId与requestDigest都等于已登记调用的决定，绑定其他调用的旧文件报`confirm_reask_decision_stale`，绝不使用；旧的confirm-save.json也不读。伪造、重复或超上限的记录在重开时报`idea_session_abandon_record_invalid`。status的guidance字段给出当前该走哪条路。

### 保存中断的对账

宿主独占写`prd/<filename>`，写前先在会话记录里记下expected（目标路径、内容SHA-256与长度、草稿摘要）。中断后resume null时，宿主先比对磁盘：

- 文件与expected一致（0600普通文件）：视为已保存，stage为saved，saved.source为recovered_write_readback；恢复前先按正常保存的同一套检查核对保存根仍是规范路径、`prd/`是真实目录（被换成符号链接或移走一律算冲突）；只移除`prd/`里与已核对目标同一inode、大小和摘要都对得上的宿主临时名`.cm-review-<uuid>`。
- 文件不存在：沿原已记录的批准重新写入，不再问一次同一请求。
- 内容不一致或不是普通文件：报`idea_save_recovery_conflict`，交人核对；不覆盖、不删除。

决定无效（save_blocked）时没有写入：会话模式用上方discard作废后重新问当前用户；内存模式直接再发finish，宿主会重新问。目标已存在等写前拒绝会保持draft_ready，可换filename再确认。

### 内存模式

不带`--session-file`时，失败的一轮（超时、校验不过、断开）没有任何记录，可在同一进程里再发一次同样的start/advance重问，最多2次，超过报`idea_retry_limit`。宿主进程一旦退出，内存里的访谈就全部丢失，只能从头开始；需要可恢复请改用`--session-file`。
