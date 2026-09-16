# $cm-prd Step 4 — 渐进式上下文范围

本规则决定 `cm-prd` 消费项目上下文的范围，不减少规格、测试或审查产物。
地图缺失/陈旧先按 `../../codebase-context/references/writeback.md` 只读核实，再设置 `CONTEXT_SCOPE=targeted|full`。

## 1. 固定基础上下文

两种范围都先按 `runtime/project-context.md` 读取 AGENTS/CLAUDE 约束，以及存在的
`coding-style.md`、`testing.md`、`security.md` 和本需求已命中层的规则。需求源、项目
描述文件和两层目录概览已经由 Step 1–3 读取，不重复打开。

先读项目指定地图或存在的 `docs/codebase-context/00-index.md`；再用需求中的页面名、路由、可见
文案、接口名、类型名和业务术语做代码搜索，定位候选模块、直接调用方与最近测试。
搜索只用于定位，不把命中源码或需求正文写入运行日志。

## 2. 范围判定

只有以下条件**全部满足**才设置 `CONTEXT_SCOPE=targeted`：

- 存量项目，且本次初步只对应一条已有业务线路和一个现有模块；
- 候选源文件、直接调用关系和可执行验证入口均已定位；
- 地图已覆盖该线路，或定向代码核实已补齐该线路及直接调用关系；
- 未命中主 `SKILL.md` Step 9.5 的任何方案对抗审查触发条件；
- 需求不存在会改变实现范围的开放问题。

地图盲区先按任务术语定向查代码和调用方；补查后满足以上条件仍选 targeted，不因缺一段文档直接升级。
补查后仍无法确认边界，或命中跨业务线路/风险条件时才设 `CONTEXT_SCOPE=full`；Greenfield 仍走 full。

## 3. 加载清单

`targeted` 且业务地图存在时读取：

- 固定：`00-index.md` 与 `07-business-logic.md` 的当前业务链路；
- 按需：`01-overview.md` 的相关概况、`03-architecture.md` 的相关依赖、`08-conventions.md` 的适用约定；已在当前上下文且未变化的不重读；
- 涉及 API/service 或调用契约时追加 `04-api-routes.md`；
- 涉及类型、模型、存储或字段时追加 `05-data-models.md`；
- 涉及页面/UI、共享组件、Hook、Store 或复用判断时追加 `06-core-modules.md`；
- 不读取仅用于地图维护追溯的 `09-changelog.md`，也不为定位成功的任务重读
  `02-directory.md`。

清单只读实际存在的文档；局部地图缺少章节时以定向代码核实补证，项目自定地图读对应段落。
日期新旧不单独触发 full；仍按业务范围与风险判定，不能把陈旧描述当边界证据。

随后只读候选源文件、直接调用方和最近测试。`full` 扩展到本任务涉及的全部业务线路、共享依赖和风险边界，
仍按索引读取相关章节与代码，不机械加载 00–09 全部 10 份；范围扩展不等于读取整仓。

## 4. 执行期升级

Step 5–10 发现局部地图盲区，先定向补证；证实仍在原边界内就保留 targeted。
发现第二条业务线路、额外模块、上述风险信号，或补证后仍不确定时，才在最终 design/tasks 前
执行 `targeted → full`，补读受影响线路及共享依赖并重做波及面检查；关键证据仍缺失则暂停依赖它的设计。
只允许升级，不允许 full 降回 targeted；不能以节省 token 为由省略风险审查或截断关键依赖。

## 5. 日志与摘要

初次判定后按 `runtime/logging.md` 写 `decision` / `phase: context_scope`，数据只包含：

- `context_scope`: `targeted | full`；
- `reason_code`: `single_module_identified | greenfield | target_unresolved |
  map_blind_spot | cross_module | contract_or_data | security_sensitive |
  dependency_or_architecture | large_feature | scope_uncertain`；
- `context_docs`: 已加载地图的相对文件名数组；无地图时为空数组。

发生升级时再写一条 `decision` / `phase: context_scope`，增加
`transition: targeted_to_full`、`reason_code: scope_expanded` 和不含业务正文的原因分类。
摘要卡显示 `上下文范围: 定向 | 完整 | 定向→完整（{reason_code}）`。
