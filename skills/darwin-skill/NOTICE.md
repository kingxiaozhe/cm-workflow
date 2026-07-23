# 来源与许可

- 上游: https://github.com/alchaincyf/darwin-skill (master, 收编于 2026-07-15)
- 许可: MIT（上游 README 的“许可证”章节明确写 MIT，并保留
  “MIT License © 花叔 Huashu”署名；上游仓库收编时无独立 LICENSE 文件）
- 完整许可文本与仓库级归属: `../../LICENSE`、`../../THIRD_PARTY_NOTICES.md`
- 本地修改(仅 2 处,均为移植性修补,SKILL.md 未改一字):
  1. scripts/screenshot.mjs: playwright-core 改为标准解析(原版写死作者机器绝对路径)
  2. scripts/screenshot.mjs: open 命令加 macOS 平台判断(原版非跨平台)
- 定位: 独立工具 skill(同 idea-to-prd/codebase-context),不属于 N1-N8 流程;
  用途:对本仓库 skills/(含 cm-* 角色技能)做 9 维评分与受控优化,人类守关三层不可跳过

# 本仓库使用注意(v0.9.25-26 实跑沉淀,SKILL.md 原样未改,以下为运行时补丁规则)

1. **baseline 对照组必污染,勿用 A/B 对比**: 被测 skill 已装入会话的环境里,"不带 skill"
   的对照子 agent 会因任务措辞匹配 description 而通过 Skill 工具自行加载它(实测 3/3
   全污染;验证法: grep 子 agent transcript 中的 `"name":"Skill"` 调用)。dim8 改用两类
   证据: ① 执行者逐条报告"skill 没写清、不得不猜的地方",歧义清单收敛度=改进度;
   ② 夹具埋陷阱复测,看上轮违规行为是否被新规则挡住。
2. **9 维 rubric 需叠加本仓库四原则**: 通用 rubric 可能把"实跑教训括号注"判为冗余——
   它们在本仓库是防删护栏,评分时计入 dim5/dim7 加分项,优化时禁止删除。
3. **cm-* skill 是强耦合网络**: 每轮改动后必须跑引用护栏(/cm-check 相关子集:
   孤儿角色、rules 生成方、跨文件配对),PASSED 才算该轮有效——这是 darwin 棘轮
   之外的本仓库附加回滚条件。
4. **工程师类 skill 的 dim9 低分是架构使然**: 纪律按设计在 agents/*.md 层
   ("agent 管纪律,skill 管技术"),勿按 rubric 给其 SKILL.md 补黑名单。
