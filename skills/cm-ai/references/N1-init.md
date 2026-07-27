# N1: 初始化

1. 从 `用户本轮输入` 提取 **specs 文件夹路径** 和 **代码项目路径**（可多个）
2. 扫描 specs 下所有编号目录（`0.xxx/`、`1.xxx/`、`2.xxx/`），按编号排列
3. 每个 feature 目录须含 requirements.md、design.md、tasks.md
   - `test-cases.json` 为可选 AI 测试合同；存在时读取
     `../../../runtime/test-contract.md`，运行 `scripts/validate-test-cases.py`，
     并核对 `acIds`/`taskIds` 引用在本 feature 三件套中真实存在
4. 按 `runtime/project-context.md` 加载项目上下文：Codex 的 `AGENTS.md` 指令链优先，再读兼容的 `.claude/CLAUDE.md` 与相关 `.claude/rules/`（0→1 项目可能都不存在，跳过不报错）
5. 加载 `{SPECS_DIR}/LESSONS.md`（架构决策和踩坑记录，开发时必须参考）；**文件不存在（全新 specs 首次运行的常态）→ 按 0 条处理，不报错不中断**，首个任务的 N5 会创建它
6. 验证各代码项目路径存在，**空目录按信号处理**：
   - 空目录 + specs 含 `0.bootstrap` → 0→1 已在规格期人工确认，直接执行
   - **空目录 + specs 无 `0.bootstrap` → 矛盾信号，必须暂停询问**：specs 是按存量项目生成的，但目录是空的——"需要先 clone 项目？（clone 完成后回复继续）还是这就是新项目？（specs 上下文有毒，需重跑 $cm-prd 走 0→1 分支）"两种回答都不得跳过：clone 场景等用户，重跑场景中止
   - **非空目录 + `0.bootstrap` 存在且其脚手架任务（T-001）未完成 → 矛盾信号，必须暂停询问**：规格期确认的是 0→1，但目录里已有项目（用户事后 clone 了？）——"继续 0→1 会在现有项目上覆盖生成脚手架。是改用现有项目？（需重跑 $cm-prd 按存量项目生成规格）还是目录内容可弃、继续 0→1？"不确认不得执行 T-001

## 规格审批入口闸（先于一切预检）

读取 `{SPECS_DIR}/.cm-specs-status`：

- `approved` → 直接继续（断点续跑不重复问）
- `awaiting_review` 或文件缺失（旧版 specs）→ 把规格摘要卡打给用户（specs 里没有摘要卡就现场汇总：feature 数/任务数/交付形态/风险点），**等用户明确回复"开始"**；回复后把状态更新为 `approved` 并刷新 `at`，保留已有 `features`/`testCases` 字段；旧文件缺少 `testCases` 但 feature 已有测试合同时，现场计算并补入，再继续。**泛化授权语不构成审批**（"按最优解处理""继续""你看着办"这类话授权的是执行方式，不是规格内容）——收到时必须回问一次："规格摘要卡确认开始吗？"（实跑失守：diff-lens 把"按照你分析的最优解去处理"直接视为审批通过）
- 启动参数含 `--yes` → 跳过此问直接更新为 approved，同样保留或补齐测试合同哈希（适合刚人审完立刻开跑的场景）

批准前后还要核对 `.cm-specs-status.testCases` 中记录的 SHA-256。任一
`test-cases.json` 哈希与审批位不一致 → 测试目标在审批后发生变化，将状态恢复为
`awaiting_review` 并要求用 `$cm-prd --change` 说明变更；旧 specs 没有
`testCases` 字段时保持兼容，只做 JSON 与引用校验。

> 这是**入口授权门**（人把关方案端），不属于"暂停仅灾难级"约束的中途暂停，也不计入 METRICS 人工介入。实跑教训：没有这道闸，prd 生成完会被一句"继续"顺势带进开发，人审形同虚设。

## 独立审查通道预检

开工前按 `runtime/review.md` 探测能否建立**与实现者不同上下文**的审查通道，而不是检查当前进程是否叫 Codex：

- 可创建 fresh Codex 子代理/独立线程 → 作为主通道
- 子代理不可用，但可以安全启动隔离的 `codex` CLI 审查会话 → 作为备用通道
- 两者都不可用 → 进入 `self-degraded`，在 N4 凭证与 METRICS 如实标注；只有安全/资金/数据正确性等高风险任务才需要暂停要求用户补齐独立审查通道

## Git 前置检查（字段优先，询问兜底）

**先按项目上下文合同读「版本控制」字段**（优先 `AGENTS.md`，兼容 `.claude/CLAUDE.md`；$cm-init 或 bootstrap 已确认并落盘）：

- `remote` / `local` → 按常规执行每任务提交，不询问；**顺手装双保险 hook**：`{CM_WORKFLOW_ROOT}/templates/hooks/pre-commit-cm-task-check` 存在且代码仓库 `.git/hooks/pre-commit` 未装 → 复制安装（默认警告模式，不阻断），输出一行 `🪝 任务标记双保险已装(警告模式)`
- `none` → 直接进入 **NO_GIT 降级模式**，不询问：N5 跳过 git 提交（METRICS 备注 `no-git`）、doc-syncer 用文件扫描替代 git diff、hook 不适用、审计链降级为 METRICS + tasks 勾选

**字段不存在时**（项目未经 init 的兜底路径）：

- 有 git 仓库 → 继续，并建议补跑 $cm-init
- 无仓库但存在 `0.bootstrap/` 且任务含脚手架/git init → 跳过询问，交给 T-001
- 无仓库且非上述 → 问一次"git init？（推荐）/ 不使用版本控制"，**答案由主流程回写 CLAUDE.md 版本控制字段**（决策落盘，任何后续运行不再询问）

## 可视化入口提示（N1 输出末尾，一次性）

N1 完成、进入 N2 之前，在输出末尾打印一行可视化入口（存在 `{CM_WORKFLOW_ROOT}/templates/pixel/` 时才打印）：

```text
🎮 想看像素流水线？另开终端: {CM_WORKFLOW_ROOT}/templates/pixel/cm-pixel.sh
   浏览器版: {CM_WORKFLOW_ROOT}/templates/pixel/serve.sh {SPECS_DIR} （地址加 ?demo 可先看演示）
```

只在 N1 打印一次，不重复——入口可发现性问题的修复（实测反馈：用户不知道要手动启动）。

## 0.bootstrap 优先规则

存在 `0.bootstrap/` 且其中有未完成任务 → **无条件最优先执行**，完成前不进入任何业务 feature。它落地项目骨架、`AGENTS.md` 与 `.claude/` 兼容规范；完成后 N7 从磁盘重载新上下文。
