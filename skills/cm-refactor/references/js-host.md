# cm-refactor 当前会话 JS 宿主

本入口统一实现原轻量/批量道，不改变意图分流、人签核、行为保持和独立审查要求。
轻量适用 1–3 个现有文件、不跨模块；批量、判官准备、写回及恢复见 [扩展协议](js-batch.md)。裸项目与 specs 项目均可。
宿主只能提出替换文本，JS 控制器执行本地文件写入、真实命令、归档与原 N4/N5 门禁。
这不是模型调用器；`runtime: codex|claude` 选择原角色配置，不证明真实模型已经调用。

## 准备与启动

单步调用可用 `node scripts/cm-refactor-drive.mjs --plan PLAN.json <start|resume|finish|status|cancel|prepare_judge_revision>`。
PLAN 写 `{ "config":"config.json", "answers":"answers" }`，路径相对 PLAN；答案按驾驶员 `--help` 与文件头准备。
驾驶员发送前核对配置、scope、内容文件、人工分析/审查/确认和恢复记录；缺项退出 2，不启动宿主。
基线、判官、变异及批量语法命令仍由宿主实际执行；结果不从答案文件读取。未知执行结果需原回执，驾驶员拒绝静态补写。

先完成主 Skill 的只读意图分流和路径准入。可信当前会话读取适用 AGENTS/调用方，核对原有
测试命令覆盖所有存量测试、判官覆盖目标入口及边界输入。只传启动前核实的 argv，不能执行模型
回复里临时出现的命令。需要新建测试资产时，由宿主在配置中声明 testSetup.paths 和执行命令，G0 批准后准备。

准备私有绝对路径 JSON 配置；以下示例的命令、替换和路径必须改为实际项目内容：

```json
{
  "skillDir": "/workflow/skills/cm-refactor",
  "project": "/project",
  "specs": null,
  "runtime": "codex",
  "target": "减少目标函数的重复分支，保持输入输出不变",
  "slug": "simplify-branch",
  "scope": ["src/value.mjs"],
  "crossModule": false,
  "baselineCommands": [{"id": "baseline", "command": ["node", "test/all.mjs"]}],
  "judgeCommand": ["node", "test/value-judge.mjs"],
  "mutations": [
    {"path": "src/value.mjs", "find": "x + 1", "replace": "x + 2"},
    {"path": "src/value.mjs", "find": "x < 0", "replace": "x < -5"}
  ],
  "logHome": "/private/cm-logs"
}
```

`logHome` 须在项目和 specs 外，是私有可重建镜像；有 specs 时其日志仍为权威。
业务 scope 不得含项目指令、凭证、specs 或归档；批量允许新增/删除普通文件。命令为可信本地执行，
不是沙箱：宿主须排除部署、网络、安装、Git 和不可恢复副作用，除非另有动作专项授权。
每个替换必须唯一命中且是可恢复的行为变异；判官自验证属于原 G0.5，不增加测试轮数。

```bash
node "{CM_WORKFLOW_ROOT}/scripts/cm-refactor-host.mjs" serve --config "{私有绝对配置路径}"
```

差分命令须以退出码 0 输出唯一 JSON：`{"cases":[{"id":"unique","input":0,"output":1}]}`。
输入与顺序在各次运行保持一致，判官不写源码；原输出为绿，两次变异须得到可比较且不同的输出。
JS 每次变异后恢复自己写入的精确内容；检测到并发修改时保留现场并阻断，不用 Git 重置。

## 当前会话接线

保持同一个 JSONL 进程。收到 `host_ready` 后发 `{"requestId":"start","operation":"start"}`。
`host_request` 的回复沿用原桥协议：`type:host_result`，原样回传 `sessionId/callId/requestDigest`，
业务返回值置于 `result`。不要把结果写到 stdout 之外的伪协议文件。

| kind | 当前宿主实际动作与 result |
| --- | --- |
| `refactor_analyze` | 只读分析调用方、量化收益及相关 LESSONS 备忘。返回 `{decision:proceed或no_refactor,metric:{name,before,unit},impact:[],claimedMemos:[],reason}`；不得隐藏已认领备忘。 |
| `refactor_confirm` | 向当前用户展示 payload 的范围、命令/变异或收口证据，取得本次明确决定，返回 `{decision:approved或rejected}`；不得因以前“继续”而伪造批准。 |
| `refactor_apply` | 返回 `{files:[{path,beforeDigest,content}],summary,metricAfter,unfixedDefects:[],conventions:[],learningApplication,learningRetrospective}`。digest 取请求值；只提供文本，不写文件、不运行命令。无新教训时 retrospective 为 `no_new_lesson`，新增则使用扩展协议的 learning 结构。 |
| `refactor_review` | 依 `runtime/review.md` 使用真正独立通道，传当前完整 handoff、差分/自验证报告、范围前后内容及命令。返回 `{markdown}`，保留原头部、精确 handoff SHA、attempt=round 和 scope。无法取得独立审查则停止；不得自写 approved、复用旧批准或发起未授权 provider。 |
| `refactor_revise_tests` | 仅第一轮审查明确要求补测试时调用。读取 `findings` 和 `assets`，返回 `{files:[{path,beforeDigest,content}]}`；只改本次列出的测试文件，摘要沿用请求值。不得直接写盘、运行命令或改业务文件。 |

审查 round 1 的 changes_requested 会在同一配置内修订一次；round 2 仍有阻塞则停止。
模型质量、行为覆盖充分性、角色执行来源与审查独立性由真实宿主保证，结构化 header 本身不能证明。
返回 `awaiting_finish` 后发送 `{"requestId":"finish","operation":"finish"}`，控制器再次核对原 N5、
询问当前用户收口决定并归档。收口拒绝只停在原位置，不重做修改或审查。
`status` 只读状态；`resume` 同配置接回原记录；`cancel` 中止在途工作；退出用 `{type:host_close,sessionId}`。

## 第二轮判官修订

启动前把允许维护的现有或待建测试文件逐个列入 `testSetup.paths`，并在 G0 展示；它与业务
`scope` 必须分离。第一轮审查若要求改这些文件，返回如下结果，正文也须说明对应发现：

```json
{"markdown":"带完整头部的 changes_requested 审查正文","judgeRevision":{"paths":["test/value-judge.mjs"],"reason":"补齐遗漏的边界输入"}}
```

`paths` 必须非空、不重复且全部属于原配置的 `testSetup.paths`，`reason` 必须非空。
未声明的文件不能临时加入；不能修改配置、命令、变异清单，或换 slug 重置轮次。
没有此字段的审查默认沿用原业务修订路径；可信宿主可在交回第一轮结果前整理该声明，
已经归档的纯文字发现则走下方追加登记。批准结果及第二轮审查均不能启动测试修订。

控制器只接受一次有实际变化的文本提案，沿用文件摘要、路径保护、原子写入与并发检查。
提案和原审查绑定另存 `a2-judge-revision.md`；每次写入追加日志，旧报告、回执不覆盖。
随后临时恢复**启动时记录的业务原稿**（包括启动前已有改动），用新版测试跑基线、采集答案，
并重新执行原变异清单自验证，另存 `a2-judge-1-report.md`。不能只对重构稿生成预期答案。

自验证通过后恢复待修的重构稿，再执行第二轮业务修改和行为比较；轻量、批量均走此顺序。
测试差分、新旧报告一并进入第二轮交接与独立审查。新判官暴露的行为变化必须在原业务范围
内纠正，比较不等则阻断。原稿基线失败或判官漏检变异也阻断，不增加测试提案或审查轮次。

中断后保持原配置执行 `resume`；控制器按记录接续测试写入、原稿切换、自验证和候选稿恢复。
未知宿主或命令结果须按原恢复协议核对并确认资源清理，不能自动重跑或把当前盘面当新原稿。
不要手工恢复临时原稿或覆盖测试文件；外部写入、路径或权限变化仍按原守卫阻断。

### 旧审查的追加登记

旧运行已归档的第一轮审查要求补测试，却没有 `judgeRevision` 字段时，可信宿主核对原发现后发送：

```json
{"requestId":"prepare-judge","operation":"prepare_judge_revision","judgeRevision":{"paths":["test/value-judge.mjs"],"reason":"处置第一轮已记录的边界测试缺口"}}
```

仅接受原第一轮合法 `changes_requested`，且第二轮尚未受控写入、执行验证或派发审查。
已缓存但被范围检查拒绝的 `a2/apply` 文本提案可以保留；在途未知调用须先核对，不能借此重跑。
登记绑定原审查文件、宿主结果以及被取代提案的摘要，返回 `judge_revision_prepared`，随后用原配置 `resume`。

原审查、旧提案和日志字节不变；新业务提案使用 `a2-after-judge-revision/apply`，attempt 仍为 2。
登记仅一次，相同请求幂等，不能更换范围或原因；已声明新版修订或已消费第二轮的运行拒绝登记。
这不是任意阶段回退、换配置或增加审查轮次的入口。

## 结果与验收边界

规格项目的判官报告在 `specs/refactors/<slug>/`，原审查在 `specs/.reviews/`，档案为
`specs/refactors/YYYYMMDD-<slug>.md`，追加原八列 METRICS，日志与 `.cm-status.json` 使用 REFACTOR。
裸项目归档于 `docs/refactors/`，不创建 METRICS/specs 状态。交付方式仅 diff，不自动提交。
行为回归阻断审查并尝试恢复本流程精确写入；并发冲突或未知副作用保留现场，需人工处理。
`done` 只说明本次 refactor/diff 流程完成，`completionAuthorized:false` 不授予其他 tasks 的完成权。

批量、跨进程恢复、判官准备、备忘和规则/Learning 已接同一控制器，不能删证据/换 slug 重置轮次。
源码/本地 synthetic 夹具不等于真实宿主隔离、模型判断、安装或业务验收；这些须单列实际证据。
branch/draft-MR 的 Git/远程动作沿仓库原交付流程另行授权，本入口不假称已提交。
