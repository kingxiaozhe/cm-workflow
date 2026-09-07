# N5: 标记完成

**强制，不可跳过。** 遗漏会导致断点恢复时重复执行任务。

## 步骤

先按 `../../../runtime/project-learning.md` 核对本 task 已复盘：有新增时须确认
AGENTS.md 已写入、被本次独立审查覆盖且磁盘摘要未变化；无新增须有明确记录。
缺记录、写入失败或批准后变化均不得执行下面的标记命令；回到 N3/N4，保留轮次。

0. **审查结论与标记原子卡点（必须真跑命令不许目测或手改）**：执行下列命令并保留 JSON 输出：

   ```bash
   python3 {CM_WORKFLOW_ROOT}/scripts/cm-task-gate.py mark-done \
     --handoff {SPECS_DIR}/.reviews/{feature}-{任务号}-a{attempt}-handoff.json \
     --reviews-dir {SPECS_DIR}/.reviews \
     --feature {FEATURE_SLUG} \
     --task {T-xxx} \
     --tasks {SPECS_DIR}/{FEATURE_DIR}/tasks.md
   ```

   `{FEATURE_DIR}` 是实际 feature 目录（例如 `2.bulk-clear-completed`），`{FEATURE_SLUG}`
   是审查文件使用的不带序号 slug。门禁同时兼容旧的 `{SPECS_DIR}/tasks.md` 布局，但拒绝
   其他 specs 目录的任务文件。

   非零退出、当前 Review 不是 `verdict: approved` 或不是 `independent: true` = **不许标记**；成功 JSON 必须是
   当前 attempt 且 `outcome` 为 `marked_done` 或幂等恢复时的 `already_done`。
   `changes_requested` 回 N3；第 2 轮 `blocked` 停止等人工。门禁在同一进程重新校验
   证据并原子替换 feature 的 `tasks.md`，只改精确匹配的任务 checkbox。不得先跑 `check-n5`
   再手工勾选，也不得只执行 `ls`。
1. **立即验证**：命令成功后重新读取 tasks.md，确认该任务确实已标记为 `[x]`

```diff
- - [ ] T-007: 安装依赖 ~5min
+ - [x] T-007: 安装依赖 ~5min
```

## 关键约束

- 每完成一个 task **立即标记**，不批量、不延后
- 文件编辑失败则重试，不得在未落盘时继续
- 进入 N7 从磁盘重载上下文前，必须确认标记已写入
- 自审凭证只用于历史审计/诊断，不能授权新完成；无独立通道保持待审，不绕过门禁
- 任意阶段变更被审代码、测试或执行指令，旧批准不覆盖新内容；已完成后的补正保留旧记录，按 `runtime/review.md` 暂停等明确授权，不自动另建任务重置轮次

## Git 提交（每任务一次）

标记验证通过后，提交本任务全部变更（代码 + tasks.md 标记）：

```bash
git add -- {本任务新增/修改且在开工前干净的文件列表}
git diff --cached --check
git commit -m "T-{编号} {feature名}: {任务标题}

审查: 自审通过 | 独立审查({channel}) {N}轮 采纳{N}条 忽略{N}条({一句话理由})"
```

- **禁止 `git add -A` / `git add .`**：必须使用 N3 开工前记录的 dirty 清单与本任务文件集显式 stage，并用 `git diff --cached --name-only` 回读。不得把用户的先存改动带入任务提交
- 本任务必须修改一个开工前已 dirty 的文件时，不得按整文件 stage。只有能构造并回读「本任务新增 hunks」时才提交；否则跳过自动提交，METRICS 备注 `dirty-overlap`，保留用户工作区
- **commit message 必须含任务编号**——"任何一行代码回溯到任务"靠这一步实现（`git log --grep "T-003"` 即可验证）
- **一次实现天然覆盖多个任务时**（拆分过细的兜底）：message 必须列出全部编号（如 `T-005/T-006 ...`），各任务分别标记、METRICS 各记一行并备注"并入 T-xxx"——禁止只写其一导致审计链断点
- 审查摘要来自 N4 的度量记录
- **任务产物已在既有提交中**（典型：T-001 的产物就是脚手架自带的 initial commit）→ 用 `git commit --allow-empty` 打一条核验提交，message 照常规格式并指认产物所在的 commit sha——审计链"每任务一提交"不留空洞
- **项目上下文的版本控制字段 = `none`**（或 N1 兜底设定 NO_GIT）→ 跳过本步，METRICS 行备注 `no-git`，进度输出的 🔁 回读行中提交项写 `跳过(none)`

提交成功并回读 SHA 后，按 `../../../runtime/logging.md` 写
`delivery/commit`，只记录 task、branch、commit SHA 和证据路径；提交失败或跳过时
不得伪造 delivery 事件。

## 度量落盘（METRICS.md）

标记完成后，向 `{SPECS_DIR}/METRICS.md` 追加本任务一行（文件不存在则先创建表头）：

```markdown
| 任务 | Feature | 开始 | 结束 | 审查轮次 | 独立审查拦截 | QA | 人工介入(次:原因) |
| T-003 | 1.user-auth | 10:02 | 10:41 | 2 | 1 | — | 1:业务歧义 |
```

- 审查轮次 / 独立审查拦截数来自 N4；QA 列先写 `—`，N6 触发时回填
- 人工介入：本任务执行期间每次暂停问人计 1 次并注明原因（技术选型自主决策不计）
- 这张表是试点/灰度门槛（人工介入 ≤2 次/任务、一次通过率等）的**唯一数据源，不可跳过**

## LESSONS.md

如有值得记录的内容追加到 `{SPECS_DIR}/LESSONS.md`：

- 架构决策及理由、踩坑记录、跨 feature 影响、环境/依赖特殊处理

不记录常规开发、显而易见的事情。格式：`## {日期} — {Feature名} / {Task标题}`

**条目分级（实跑教训：Infinity 防线进了 LESSONS 仍复发——纪律靠记忆不可靠）**：

- 每条教训标注 `[已结构化]`（已落为测试用例/校验代码/lint 规则，防线不靠记忆）或 `[仅记忆]`（只有文字）
- **`[仅记忆]` 是欠账**：此处只记录结构化建议，供后续获准的任务处理；不得在标记完成后顺手新增测试、校验代码或执行指令。`[已结构化]` 仅描述已有且已验证的防线，不能把建议当成已实现
- **备忘/已知限制类**（"V1.x 需要……""等真实反馈再定"）不混入正文，写入文件顶部的 **`## 待触发备忘`** 段，格式：`- [挂起] {触发条件} → {事项}（来源 T-xxx）`——否则埋进只写不读的正文里，到期无人认领（实跑教训：warnings 无 UI 出口备忘无回流出口）

## 输出进度

```text
✅ Feature {F}/{总F} | 任务 {N}/{总数} — {标题}
🔍 主执行者自审: {结果} | 🤖 独立审查({channel}): {结果}
🔁 回读: tasks.md T-{编号}[x]已确认 | commit {短sha}含T-{编号} | METRICS 行已写 | 门禁 {mark-done JSON 输出中的 review} | 学习 {AGENTS.md已写回并回读/已复盘，无新增}
📊 Feature {done}/{total} | 总体 {done_f}/{total_f}
```

**🔁 回读行是强制字段**——五项分别重新读取文件/执行命令确认后才能输出；本行缺失即视为 N5 未完成，不得进入 N6。学习项回读 N3 的复盘记录与相应 AGENTS.md，不在此时追加新指令。不可见的纪律等于没有纪律（实跑事故教训：静默失败只有回读能发现）。
