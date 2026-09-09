# JS 批量、准备、写回与恢复

由可信当前会话准备配置，用户不必手写协议。本文是 js-host.md 的条件引用，不改变原业务规则。

## 配置增量

```json
{
  "testSetup": {"paths": ["test/all.mjs", "test/value-judge.mjs"]},
  "writebackPaths": ["AGENTS.md", "README.md", ".claude/rules/shape.md"],
  "batch": {
    "assemblyFiles": ["src/index.mjs"],
    "cheapCommands": [{"id": "syntax", "command": ["node", "--check", "{file}"]}],
    "maxPasses": 6
  }
}
```

三项都可省略。scope/testSetup/writeback 清单互不重叠；assemblyFiles 包含在 scope 内。
新增/跨模块/>3文件自动选批量；≤3文件的删除也须显式 batch。无 Git 基线禁止批量，不自动 init。
cheapCommands 的 `{file}` 只做 argv 替换、不经 shell；删除文件不跑语法检查。每批最多3–9次生成，默认6。
G0 展示业务、测试、规则/文档范围与命令；批量预算为文件数×单文件估耗，非实测 token。
testSetup 声明现有/待创建的判官资产；主流程准备文本后运行配置中的原基线与两次以上变异自验证。
漏检只修声明测试，最多三版；不能修生产行为使测试通过、换掉原变异或引入依赖。
writebackPaths 只允许项目 AGENTS、README、CLAUDE 和 `.claude/rules/*.md`，不授予 worker 写权限。

## 新增宿主回调

所有 files 项为 `{path,beforeDigest,content}`，digest 原样取请求，删除 content=null。回调只返回提案，不旁路写入/执行。

| kind / action | 实际宿主职责与 result |
| --- | --- |
| `refactor_prepare_tests` | `{files:[...]}`：只写声明的测试资产提案；保留现状（含缺陷）和既有环境解析。 |
| `refactor_batch / plan` | `{rulebook,units:[{id,files,dependsOn}],sample:[file],perFileEstimate,reason}`。只读检查文件及模块依赖，都编码到 dependsOn。JS 拒环并核对全清单；sample 按主 Skill 比例挑最难文件。 |
| `refactor_batch / bakeoff` | guided/blind 各用 fresh 隔离、无工具写权限作者，blind 不接手册或另一方历史。各回 `{files:[...],channelId}`。 |
| `refactor_batch / adjudicate` | 第三独立上下文回 `{channelId,rulebook,decisions:[{path,verdict:rule_correct或rule_missing或rule_wrong,reason}]}`，逐处判定差异，不自称作者也能独立。 |
| `refactor_batch / generate` | 单文件文本 worker 回 `{files:[...],needs:[{id,path,instruction}],summary}`。所有装配/加载登记/文档需求必须列出。非删除内容以语言合法注释携原 `// REFACTOR STATUS: confidence=high或medium或low todos=N`，JS 对账 TODO 数。 |
| `refactor_batch / assemble` | 主流程消费全部装配需求，回 `{files:[...],resolved:[needId]}`，不派单元 worker、不漏登记文件。 |
| `refactor_batch / diagnose` | 根据真实错误回 `{errorClass,reason}`。同类错误不靠文件名/行号另起类别，第三次修规则、人批准后重生成该批，不手补实例。 |
| `refactor_retrospective` | 主流程读取给定 doc-syncer Skill，回 `{learningApplication,learning:{status,candidates,reason},conventions:[{path,text,evidence}],documentation:[...],resolved:[needId],unfixedDefects:[],metricAfter}`；逐项核销结构文档 needs，不夹带 bug fix。 |

channelId 必须来自真实宿主。字符串不同不证明隔离；无法限制 worker 为文本/隔离上下文时不派发。
试点使用同一单元/廉价检查/装配/等价管线，失败修规则，成功丢弃产物；规则定稿人批准后串行生产。
每批廉价检查与批末基线/差分分开；差异回滚该批，保留输入和输出明细。规则修订保存版本/原因/裁决人，重生成再过判官。
规划只传清单/摘要，宿主按需读取；单元只传本文件，避免每次传整仓。

## Learning 与备忘

learning 沿用原格式：`{status:"no_new_lesson",candidates:[],reason:null}`，或
`{status:"lesson_candidate",candidates:[{classification:"structured"或"memory_only",trigger,action,evidence:[项目相对路径]}],reason:null}`。
最多3条、有真实证据，复用原合并器增量写 AGENTS 项目教训；无权限时阻断，不伪装无新增。
conventions 只追加已授权规则文件；项目没有规则目录时降级 LESSONS `[仅记忆]`，提示 cm-init 后迁移。
analysis.claimedMemos 使用原 LESSONS 的精确单行，主流程附已认领状态与档案路径；用户并发内容不覆盖。
AGENTS/规则/测试/结构文档均在最终 Review **之前**定稿，进入同一 changed_files/实现摘要。
外部 specs 的 LESSONS 原文和摘要进入审查包，收口再次核对；不另开完成通道。

## 恢复

新进程用同一配置/slug，发送 `{"requestId":"resume","operation":"resume"}`。读取原 execution.jsonl、RULEBOOK/批次，保留审查轮次。
已记录结果只复用、不再次问 G0/派发模型；到安全站点复查当前基线/差分。`status` 不写，漂移显示 correction_required 并保留历史阶段。
未知调用收到 `refactor_recover`：可信宿主查原调用/进程回执，不凭时间或文字 approved 推断。

- 已完成：`{decision:"completed",result:原形状,evidence:"实际核对依据"}`；host 结果为 `{value:原业务返回,durationMs:实测或null}`。
- 命令结果为 `{observed:原host-check结果,stdout,stderr}`，另需 `cleanupConfirmed:true` 证明原进程已清理。
- 确认未派发：`{decision:"not_started",evidence:"未派发证据"}` 才可执行原登记请求。
- 仍未知：`{decision:"unknown",evidence:"目前事实"}` 保持阻断；不得换 reviewer/新轮次绕过。

文件恢复只接受原值/本流程目标值；第三种内容保留。报告可从原记录重建，冲突不覆盖。
旧版缺 execution 记录的已有审查报 refactor_legacy_recovery_required，按旧证据人工处理，不自动导入/清除。
日志损坏、权限冲突、未知进程无法核对是合理阻断，不承诺任意中断都能无人恢复。

批量目录增加 RULEBOOK/修订史、batch-log、试点/差分/回滚明细与 dossier；execution 只辅助恢复，不替代原任务/日志/Review。
METRICS 保留八列，记录实测宿主调用/耗时；缺实际模型 token 遥测明确 unavailable。
本入口信封上限2MiB、业务返回1MiB；其他入口默认64KiB不变。大回复应减少无关文本或缩批，不截断后声称完整。
实际 provider、双端安装和 Git 交付分别需要授权；synthetic 本地夹具不证明真实模型判断与隔离。
