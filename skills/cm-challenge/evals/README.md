# 入口验证

`trigger-cases.json` 包含正例、反例与相邻流程；`trigger-config.json` 供可选的 Yao
`trigger_eval.py` 使用。这是关键词/概念规则的启发式检查，不是客户端真实 Skill
选择器，也不证明模型理解或输出质量；Yao 不属于 CM 的运行依赖。

维护时用 Yao 的 Python 3.10+ 执行器读取本 Skill 的 description、上述两个 JSON；
报告留在本地证据目录，不回写安装副本。没有 Yao 时仍可按样例人工核对触发。

仓库机械回归：`node --test scripts/cm-challenge.test.mjs`，覆盖分发登记、别名、
包搬移后的相对引用和入口计数。测试不启动 CM 宿主，也不调用模型。

行为验证另用新上下文加载 `SKILL.md` 及共享方法，执行 `references/examples.md`
中的场景；保留原始回答并检查是否给具体依据、必要问题、条件式建议，是否越权。
补充追问后的收敛用例：用户已明确“客户全部 Windows、四周交付、只做网页”时，
应区分 Windows 浏览器支持与原生客户端，不重复询问已知信息。

源码检查、模型样例、独立审查与安装后自动发现是不同证据，分别报告。
