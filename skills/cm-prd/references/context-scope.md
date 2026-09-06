# $cm-prd Step 4 — 渐进式上下文范围

本规则只优化 `cm-prd` 消费项目上下文的范围，不改变 `/codebase-context dev` 的全量
加载语义，也不减少规格、测试或审查产物。设置 `CONTEXT_SCOPE=targeted|full`。

## 1. 固定基础上下文

两种范围都先按 `runtime/project-context.md` 读取 AGENTS/CLAUDE 约束，以及存在的
`coding-style.md`、`testing.md`、`security.md` 和本需求已命中层的规则。需求源、项目
描述文件和两层目录概览已经由 Step 1–3 读取，不重复打开。

存在 `docs/codebase-context/` 时先读 `00-index.md`；再用需求中的页面名、路由、可见
文案、接口名、类型名和业务术语做代码搜索，定位候选模块、直接调用方与最近测试。
搜索只用于定位，不把命中源码或需求正文写入运行日志。

## 2. 范围判定

只有以下条件**全部满足**才设置 `CONTEXT_SCOPE=targeted`：

- 存量项目，且本次初步只对应一条已有业务线路和一个现有模块；
- 候选源文件、直接调用关系和可执行验证入口均已定位；
- 地图已覆盖该线路，或小项目的直接代码搜索足以证明波及面；
- 未命中主 `SKILL.md` Step 9.5 的任何方案对抗审查触发条件；
- 需求不存在会改变实现范围的开放问题。

任一条件不满足即设置 `CONTEXT_SCOPE=full`。Greenfield、目标未定位、地图盲区、跨
业务线路、范围不确定也直接走 full，不为了命中快线猜测边界。

## 3. 加载清单

`targeted` 且业务地图存在时读取：

- 固定：`00-index.md`、`01-overview.md`、`03-architecture.md`、
  `07-business-logic.md`、`08-conventions.md`；
- 涉及 API/service 或调用契约时追加 `04-api-routes.md`；
- 涉及类型、模型、存储或字段时追加 `05-data-models.md`；
- 涉及页面/UI、共享组件、Hook、Store 或复用判断时追加 `06-core-modules.md`；
- 不读取仅用于地图维护追溯的 `09-changelog.md`，也不为定位成功的任务重读
  `02-directory.md`。

随后只读候选源文件、直接调用方和最近测试。`full` 保持现有行为：地图存在时加载
00–09 全部 10 份；地图不存在或标记为小项目时直接读取完整相关代码范围。

## 4. 执行期升级

Step 5–10 任一阶段发现第二条业务线路、额外模块、地图盲区或上述风险信号时，必须在
继续生成最终 design/tasks 前执行 `targeted → full`：补齐 00–09 或完整相关代码范围，
重做波及面与任务边界检查。只允许升级，不允许 full 降回 targeted。

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
