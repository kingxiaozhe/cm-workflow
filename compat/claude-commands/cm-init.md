# /cm:init — Claude Code macOS/Linux 兼容入口

读取 `~/.claude/skills/cm-init/SKILL.md`，将 `$ARGUMENTS` 原样作为用户输入，严格执行该 Skill。Skill 是唯一规则源；本文件不定义业务流程。如 Skill 不存在，提示重新安装 CM Workflow。
