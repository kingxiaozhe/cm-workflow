# 重构流程总体设计

综合 cm 小闭环纪律与 Anthropic 迁移方法论(claude.com/blog/ai-code-migration +
anthropics/code-migration-kit)的重构流程设计图。**已实现为 `commands/cm:refactor.md`**
(v0.9.31 落地,v0.9.32 补齐完整融合)——图与命令互为对照,任何一侧修改必须同步另一侧,
图与实现不得漂移。

- `refactor-flow.png` — 静态图
- `refactor-flow.mp4` — 动画版(演示用)
- `refactor-flow.excalidraw` — 可编辑源(拖进 excalidraw.com 修改)
- `refactor-flow.spec.json` — archscribe 图纸源,可重新渲染全部格式:
  `python3 ~/.claude/skills/archscribe/scripts/render_animated_diagram.py --spec refactor-flow.spec.json --outdir out --formats png,gif,mp4,svg,html,excalidraw`

核心设计决策:分流门先于一切(缺陷→fix/行为变→prd/结构→本流程)、G0 可行性
("不重构"合法)、判官自验证(原码必绿坏码必红,无判官不开工)、规模双轨
(单文件轻量道/跨模块批量道)、三条"修上游"回环(修订排队/三次重复=规则bug/
行为差异=回滚)、人只在三处签核(门在阶段之间,阶段内零停车)。
