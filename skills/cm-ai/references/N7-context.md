# N7: 上下文管理

## task 完成后

**重读落盘文件即是"重载",不需要清上下文,更不需要停车**:

- 当前 feature 的 specs(requirements.md、design.md、tasks.md)
- `{SPECS_DIR}/LESSONS.md`
- `runtime/project-context.md` 解析出的 `AGENTS.md` 指令链与 `.claude/` 兼容规则

重读完成后**直接继续下一个 task,不停车、不等用户、不以问句收尾**。

> 以磁盘为准重读 specs 才是防漂移的有效动作；不依赖 Claude 的 `/clear` 或 Codex 的会话压缩细节。压缩摘要可能丢数字，落盘文件不会。

## task 执行中

察觉上下文被自动压缩过(前文变成摘要)→ 继续当前 task 前,重读本 feature 的 specs 与当前任务相关的 design 章节,以落盘文件校准记忆,不信摘要里的细节数字。

## feature 完成后

同上重读,直接进入下一个 feature。

全程自动继续。**唯一合法停车点**：$cm-ai 全局规则的灾难级清单 + 各节点显式卡点（入口闸/高风险审查降级/形态确认/涉合规走查）。
