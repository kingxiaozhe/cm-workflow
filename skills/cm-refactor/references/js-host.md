# cm-refactor 当前会话 JS 宿主

本入口统一实现原轻量/批量道，不改变意图分流、人签核、行为保持和独立审查要求。
轻量适用 1–3 个现有文件、不跨模块；批量、判官准备、写回及恢复见 [扩展协议](js-batch.md)。裸项目与 specs 项目均可。
宿主只能提出替换文本，JS 控制器执行本地文件写入、真实命令、归档与原 N4/N5 门禁。
这不是模型调用器；`runtime: codex|claude` 选择原角色配置，不证明真实模型已经调用。

## 准备与启动

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

审查 round 1 的 changes_requested 会在同一配置内修订一次；round 2 仍有阻塞则停止。
模型质量、行为覆盖充分性、角色执行来源与审查独立性由真实宿主保证，结构化 header 本身不能证明。
返回 `awaiting_finish` 后发送 `{"requestId":"finish","operation":"finish"}`，控制器再次核对原 N5、
询问当前用户收口决定并归档。收口拒绝只停在原位置，不重做修改或审查。
`status` 只读状态；`resume` 同配置接回原记录；`cancel` 中止在途工作；退出用 `{type:host_close,sessionId}`。

## 结果与验收边界

规格项目的判官报告在 `specs/refactors/<slug>/`，原审查在 `specs/.reviews/`，档案为
`specs/refactors/YYYYMMDD-<slug>.md`，追加原八列 METRICS，日志与 `.cm-status.json` 使用 REFACTOR。
裸项目归档于 `docs/refactors/`，不创建 METRICS/specs 状态。交付方式仅 diff，不自动提交。
行为回归阻断审查并尝试恢复本流程精确写入；并发冲突或未知副作用保留现场，需人工处理。
`done` 只说明本次 refactor/diff 流程完成，`completionAuthorized:false` 不授予其他 tasks 的完成权。

批量、跨进程恢复、判官准备、备忘和规则/Learning 已接同一控制器，不能删证据/换 slug 重置轮次。
源码/本地 synthetic 夹具不等于真实宿主隔离、模型判断、安装或业务验收；这些须单列实际证据。
branch/draft-MR 的 Git/远程动作沿仓库原交付流程另行授权，本入口不假称已提交。
