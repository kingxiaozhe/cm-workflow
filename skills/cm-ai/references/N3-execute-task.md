# N3: 执行 Task

## 开始标记

改文件前先记录每个目标仓库的 `git status --short`、本任务预期文件集与已存 dirty 文件的 diff 指纹。这份快照供 N4 排除用户改动、N5 精确 stage；未记录就不得使用自动提交。

```text
🔨 Task {T-编号}: {任务描述} ~{预估时间}
   Feature {F}/{总F} | 任务 {N}/{总数}
```

本节点解析 `coder` 角色的有效路由，并把 `adapter`、`model`、`source`、`route_state`
写入任务摘要和 `decision`/`phase: route` 事件。`route_state: declared-adapter` 只表示
请求了当前运行时未观察到的适配器；不得虚构该模型已运行，必要时写
`warning`/`degrade`，仍由本地执行者保持代码修改和验收边界。

## Skill 匹配

根据任务涉及的工种，查看可用的 `cm-*` skills：

- 前端 → `cm-frontend-engineer`
- UI 还原（有 design-baseline） → `cm-ui-engineer`
- 微信小程序 → `cm-miniprogram-engineer`
- 后端 API → `cm-backend-engineer`
- 数据库 → `cm-database-engineer`
- 合约 → `cm-contract-engineer`
- QA/测试 → `cm-qa-engineer`
- 部署/发布 → `cm-devops-engineer`
- 没有匹配 → AI 直接执行

有匹配的 skill → 调用该 skill 执行。

**串行 / 并行的执行方式**：串行任务由主执行者直接按 skill 执行；并行任务按 `runtime/orchestration.md` 为子代理注入对应工种 skill 的角色约束。两种产出都必须由主执行者回收验证，再进入 N4。

并行只读任务无需 worktree；两个及以上任务并行写代码前，主执行者必须按
`runtime/orchestration.md` 执行 `cm-task-gate.py check-parallel-write`。非零结果立即
降级串行，不得让多个执行者共享 checkout、分支或 detached worktree。

## 开发

- 参考 design.md 技术设计和 `runtime/project-context.md` 解析出的项目规范
- 技术选型自行选最优解，不暂停
- 业务逻辑歧义按需求最合理解释执行并显式记录假设；**仅灾难级**（不可逆破坏/资金密钥合规/形态级错向）暂停——见 $cm-ai 全局规则
- **依赖与工具链纪律**：新引入的依赖/构建工具必须**钉版本写进 manifest**（dependencies/devDependencies），禁止在脚本里临时 `npx` 拉 latest（不可复现，锁网 CI 直接挂）；工具链改动在提交信息中单独说明，不静默混入功能变更（实跑教训：防护网脚本裸 npx esbuild 被复审抓出）
- **二开范围纪律：只改任务范围内的代码，禁止顺手重构**——顺手"优化"老代码是存量项目的事故之源；想重构的记入 LESSONS 待触发备忘，事后走 `$cm-refactor` 单独立项、单独审查，不许夹带。改老文件跟老文件风格走，新文件才按新规范写
- **平台专属 API 首次引入必查社区已知问题**：用当前运行时的网络搜索能力查「{API 名} 已知问题/踩坑」。微信小程序、Taro、RN/Expo 这类平台 API 的不可靠组合官方文档未必覆盖；查证结论一行留在任务汇报里

## 长步骤与临时资源留痕

- 启动可能长时间占用的外部命令、桌面应用、浏览器用例或模型回合前，按
  `../../../runtime/logging.md` 写 `progress/start`；只在真实观察到的启动完成、
  Runtime Ready、页面到达或用例阶段变化时写 `progress/checkpoint`，结束写
  `progress/complete`。**不启动后台定时心跳**。
- 每个 blocking browser case 写 `test_run/case_start`，随后只允许一个
  `case_complete` 或 `case_blocked`；同一步同步更新 `.cm-status.json` 的大白话
  detail，避免进程仍运行但日志和状态长时间停住。
- 临时 profile、进程、模型别名、worktree 或 fixture 在使用前写
  `resource/acquired`，清理后用同一 `resource_id` 写 `resource/released`。
  每次新获取使用新的 `resource_id`，释放后的 ID 不复用；`cleanup_failed`
  立即把任务标为 BLOCKED，不得进入 N4。
- 模型发生别名或路由时同时记录 `requested_model`、`effective_model`、`provider`、
  `purpose` 与 `model_equivalent`；不得用别名冒充实际模型。

## 结构化交接门禁

实现和任务内验证结束后，主执行者依据真实 diff、命令输出和子代理汇报，写入：

`{SPECS_DIR}/.reviews/{feature}-{任务号}-a{attempt}-handoff.json`

格式严格遵守 `../../../runtime/task-handoff.schema.json` 与
`../../../runtime/task-gates.md`。子代理只能返回候选字段；由主执行者核对并落盘，
不得让子代理写 `.reviews/`。`ready_for_review` 必须所有 verification 都是 `passed`，
且 blockers/scope_deviation 为空；`changed_files` 使用正斜杠分隔的项目相对路径。
否则写 `blocked` 并停止，不进入 N4。写 handoff 前，必须以完全相同的
`changed_files` 计算实现内容摘要：

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py hash-implementation \
  --project-root {CODE_PROJECT} \
  --file path/to/changed-file \
  --file path/to/another-file
```

把 JSON 返回的 `implementation_sha256` 原样写入 handoff；不得用 handoff 文件自身的
SHA 替代它。后续若任一已审文件内容变化，必须生成下一 attempt 并重新审查。

进入 N4 前必须真跑：

```bash
python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py check-n4 \
  --handoff {HANDOFF_PATH} \
  --reviews-dir {SPECS_DIR}/.reviews \
  --feature {FEATURE_SLUG} \
  --task {T-xxx} \
  --project-root {CODE_PROJECT}
```

attempt 2 只有在第 1 轮凭证为 `changes_requested` 时才会通过。不得创建 attempt 3。
保留命令 JSON 返回的 `handoff_sha256`，N4 写 Review 凭证时必须原样使用。
