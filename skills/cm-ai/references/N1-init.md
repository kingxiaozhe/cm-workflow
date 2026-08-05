# N1: 初始化

1. 从 `用户本轮输入` 提取 **specs 文件夹路径** 和 **代码项目路径**（可多个）
2. 扫描 specs 下所有编号目录（`0.xxx/`、`1.xxx/`、`2.xxx/`），按编号排列；进入
   每个 feature 时保存完整目录名为 `FEATURE_DIR`（如 `1.login`），仅把去掉编号的
   名称保存为 `FEATURE_SLUG`（如 `login`）。前者只用于规格文件路径，后者用于
   handoff/review 证据名，二者不得混用
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

路径验证通过后立即按 `../../../runtime/logging.md` 写 `run_start`；断点恢复会复用
`{SPECS_DIR}/.cm-run.json` 中仍为 running 的 run id，不另开重复运行记录。

随后从代码项目根读取 `{CM_WORKFLOW_ROOT}/scripts/cm_workflow_config.py` 的有效配置，
至少解析本轮会用到的角色、`route_state`、workflow profile 与 `policies`。配置缺失
使用内置默认值；配置错误阻断本次运行并报告字段路径。这里只记录请求路由，不把模型
别名当成已观测的后端模型。Profile 只决定测试优先级，不改变 N1–N8：
`java-backend` 优先命令/API/数据库回归，`web-frontend` 优先构建/交互/browser，
`cm-default` 按通用顺序。

## 规格审批入口闸（先于一切预检）

读取 `{SPECS_DIR}/.cm-specs-status`：

- `approved` → 直接继续（断点续跑不重复问）
- `awaiting_review` 或文件缺失（旧版 specs）→ 把规格摘要卡打给用户（specs 里没有摘要卡就现场汇总：feature 数/任务数/交付形态/风险点），**等用户明确回复"开始"**；回复后运行 `cm-spec-manifest.py`，把当前 `specFiles` 写入状态并更新为 `approved`。**泛化授权语不构成审批**（"按最优解处理""继续""你看着办"这类话授权的是执行方式，不是规格内容）——收到时必须回问一次："规格摘要卡确认开始吗？"（实跑失守：diff-lens 把"按照你分析的最优解去处理"直接视为审批通过）
- 已是 `approved` 但缺少 `specFiles`（旧版审批位）→ 无法证明批准的是当前三件套；展示一次摘要卡并重新取得明确“开始”，随后补全 manifest。不得静默背书。
- 启动参数含 `--yes` → 跳过此问直接基于当前文件生成 manifest 并更新为 approved（只适合刚人审完立刻开跑的场景）

只有实际把状态从非 approved 改为 approved 时才写
`spec_lifecycle/approved`；已有 approved 状态不重复伪造审批事件。

批准后真跑
`python3 {CM_WORKFLOW_ROOT}/scripts/cm-spec-manifest.py {SPECS_DIR} --status-file {SPECS_DIR}/.cm-specs-status`。
任一 requirements/design/tasks/test-cases 新增、删除或**规格语义哈希**变化 → 将状态
恢复为 `awaiting_review`，写 `spec_lifecycle/changed` 并要求用 `$cm-prd --change`
说明变更。N5/N6 将明确的任务与 AC checkbox 从 `[ ]` 改为 `[x]` 属于运行状态，
`cm-spec-manifest.py` 会规范化后比较，不得把正常进度误判成规格漂移；文案、ID、
`[DROPPED]`/`[CHANGED]`、普通 checklist、设计和测试合同仍须完整保护。

> 这是**入口授权门**（人把关方案端），不属于"暂停仅灾难级"约束的中途暂停，也不计入 METRICS 人工介入。实跑教训：没有这道闸，prd 生成完会被一句"继续"顺势带进开发，人审形同虚设。

## 独立审查通道预检

开工前按 `runtime/review.md` 探测能否建立**与实现者不同上下文**的审查通道，而不是检查当前进程是否叫 Codex：

- 可创建 fresh Codex 子代理/独立线程 → 作为主通道
- 子代理不可用，但可以安全启动隔离的 `codex` CLI 审查会话 → 作为备用通道
- 两者都不可用 → 进入 `self-degraded`，在 N4 凭证与 METRICS 如实标注；只有安全/资金/数据正确性等高风险任务才需要暂停要求用户补齐独立审查通道

## Git 前置检查（字段优先，询问兜底）

从有效配置保存 `DELIVERY_MODE=diff|branch|draft-mr`，其分支优先于历史默认行为：

- `diff` → 串行执行，不安装提交 hook，不自动 commit/push/MR；N8 交付最终 diff。
- `branch` / `draft-mr` → 使用任务级 commit。当前在 `main`/`master` 等保护分支时，
  基于当前 HEAD 创建 `cm/{首个feature}-{run短id}` 本地分支；已在非保护分支则沿用，
  不覆盖或切走用户已有改动。`draft-mr` 的远端动作留到 N8 再取得明确授权。

**先按项目上下文合同读「版本控制」字段**（优先 `AGENTS.md`，兼容 `.claude/CLAUDE.md`；$cm-init 或 bootstrap 已确认并落盘）：

- `remote` / `local` → 按 `DELIVERY_MODE` 执行；仅 branch/draft-mr **顺手装双保险 hook**：`{CM_WORKFLOW_ROOT}/templates/hooks/pre-commit-cm-task-check` 存在且代码仓库 `.git/hooks/pre-commit` 未装 → 复制安装（默认警告模式，不阻断），输出一行 `🪝 任务标记双保险已装(警告模式)`
- `none` → `delivery: diff` 时进入 **NO_GIT 降级模式**：N5 跳过 git、doc-syncer 用文件扫描、审计链降级为 METRICS + tasks 勾选；配置为 branch/draft-mr 时直接 `BLOCKED`，不得声称能交付分支或 MR

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
