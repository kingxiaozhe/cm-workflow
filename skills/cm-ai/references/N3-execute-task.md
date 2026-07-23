# N3: 执行 Task

## 开始标记

改文件前先记录每个目标仓库的 `git status --short`、本任务预期文件集与已存 dirty 文件的 diff 指纹。这份快照供 N4 排除用户改动、N5 精确 stage；未记录就不得使用自动提交。

```text
🔨 Task {T-编号}: {任务描述} ~{预估时间}
   Feature {F}/{总F} | 任务 {N}/{总数}
```

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

## 开发

- 参考 design.md 技术设计和 `runtime/project-context.md` 解析出的项目规范
- 技术选型自行选最优解，不暂停
- 业务逻辑歧义按需求最合理解释执行并显式记录假设；**仅灾难级**（不可逆破坏/资金密钥合规/形态级错向）暂停——见 $cm-ai 全局规则
- **依赖与工具链纪律**：新引入的依赖/构建工具必须**钉版本写进 manifest**（dependencies/devDependencies），禁止在脚本里临时 `npx` 拉 latest（不可复现，锁网 CI 直接挂）；工具链改动在提交信息中单独说明，不静默混入功能变更（实跑教训：防护网脚本裸 npx esbuild 被复审抓出）
- **二开范围纪律：只改任务范围内的代码，禁止顺手重构**——顺手"优化"老代码是存量项目的事故之源；想重构的记入 LESSONS 待触发备忘，事后走 `$cm-refactor` 单独立项、单独审查，不许夹带。改老文件跟老文件风格走，新文件才按新规范写
- **平台专属 API 首次引入必查社区已知问题**：用当前运行时的网络搜索能力查「{API 名} 已知问题/踩坑」。微信小程序、Taro、RN/Expo 这类平台 API 的不可靠组合官方文档未必覆盖；查证结论一行留在任务汇报里
