# N5: 标记完成

**强制，不可跳过。** 遗漏会导致断点恢复时重复执行任务。

## 步骤

1. 用 Edit 工具打开 tasks.md，找到当前任务对应的行
2. 将 `- [ ]` 改为 `- [x]`，**仅改 checkbox，不改其他内容**
3. **立即验证**：改完后重新读取 tasks.md，确认该任务确实已标记为 `[x]`

```diff
- - [ ] T-007: 安装依赖 ~5min
+ - [x] T-007: 安装依赖 ~5min
```

## 关键约束

- 每完成一个 task **立即标记**，不批量、不延后
- Edit 失败则重试直到成功
- `/clear` 之前必须确认标记已写入

## LESSONS.md

如有值得记录的内容追加到 `{SPECS_DIR}/LESSONS.md`：

- 架构决策及理由、踩坑记录、跨 feature 影响、环境/依赖特殊处理

不记录常规开发、显而易见的事情。格式：`## {日期} — {Feature名} / {Task标题}`

## 输出进度

```text
✅ Feature {F}/{总F} | 任务 {N}/{总数} — {标题}
🔍 AI review: {结果} | 🤖 Codex review: {结果}
📊 Feature {done}/{total} | 总体 {done_f}/{total_f}
```
