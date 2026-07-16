# 来源与许可

- 上游: https://github.com/alchaincyf/darwin-skill (master, 收编于 2026-07-15)
- 许可: MIT(依据上游 README 徽章声明;上游仓库暂缺 LICENSE 文件,如上游补充以其为准)
- 本地修改(仅 2 处,均为移植性修补,SKILL.md 未改一字):
  1. scripts/screenshot.mjs: playwright-core 改为标准解析(原版写死作者机器绝对路径)
  2. scripts/screenshot.mjs: open 命令加 macOS 平台判断(原版非跨平台)
- 定位: 独立工具 skill(同 idea-to-prd/codebase-context),不属于 N1-N8 流程;
  用途:对本仓库 skills/(含 cm-* 角色技能)做 9 维评分与受控优化,人类守关三层不可跳过
