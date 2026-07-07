# N7: 上下文管理

## task 完成后

执行 `/clear`，然后重新读取：

- 当前 feature 的 specs（requirements.md、design.md、tasks.md）
- `{SPECS_DIR}/LESSONS.md`
- 代码项目的 `.claude/CLAUDE.md` + `.claude/rules/`

继续下一个 task。

## task 执行中

上下文达 80% → 执行 `/compact` 后继续当前 task。

## feature 完成后

执行 `/clear`，进入下一个 feature。

全程自动继续，无需等待用户指令。
