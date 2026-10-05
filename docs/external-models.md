# 外部模型配置（第一阶段，显式启用）

当前宿主会话继续使用客户端当前模型；CM 不切换该会话。独立外部 CLI 调用按 provider
保存一组模型及可选推理强度。同一个 provider 的外部开发、独立审查共用这组参数，
审查仍使用新上下文和原逐轮授权。项目的 coder／reviewer runtime 路由保持原规则。

## 配置一次

在源码或已安装插件根目录运行：

```bash
node scripts/cm-model-setup.mjs configure --provider codex
node scripts/cm-model-setup.mjs configure --provider claude
node scripts/cm-model-setup.mjs show
```

向导只问模型 ID、可选强度及保存确认。只配置实际会调用的 provider。
没有固定默认模型、六用途菜单、模型排名或后台发现。模型留空会拒绝保存。
非交互配置用 `configure --provider codex --model {明确模型ID} --effort high --yes`。
取消不写文件，确认期间配置被其他进程修改也拒绝覆盖。
安全保存要求 POSIX 平台及 `/usr/bin/python3`；原生 Windows 明确返回
`model_secure_write_unavailable`，本阶段未做 Windows／Linux 实机验收。

配置位于 `~/.cm-workflow/external-models-v1.json`；`CM_WORKFLOW_HOME` 可指定隔离目录：

```json
{
  "schemaVersion": 1,
  "providers": {
    "codex": {"model": "YOUR_EXPLICIT_MODEL_ID", "effort": "high"},
    "claude": {"model": "YOUR_EXPLICIT_MODEL_ID", "effort": null}
  }
}
```

Codex 强度支持 `none/minimal/low/medium/high/xhigh`，省略时沿用适配器 `high`。
Claude 支持 `low/medium/high/xhigh/max`，省略或 `null` 时不发送强度参数。
这些是本版本适配器的参数合同，不能证明账号实际可用的模型／强度；不支持的参数明确报错。
实际生效模型保持 `unknown`，不会把配置、参数或预检冒充 provider 确认。

## 在运行中启用

本阶段接入 `cm-ai-host.mjs`／`cm-ai-drive.mjs`、batch host／driver 与 cm-fix host／driver。
在已有合法 PLAN 的 `permissions` 增加 `--external-models`；可同时增加
`--external-models-config {配置路径}` 为本次新 run 明确选择整组 provider 参数。
批次在首个成员启动前冻结整组参数，后续尚未创建的成员也读取同一批次快照。cm-fix
在原生运行配置中冻结审查 pair，根因和最终审查共用参数、各自使用新上下文。QA 修复
子运行从父运行冻结参数继承，不能替换已有 legacy 子运行配置。cm-prd 仍使用原合同。
新模式 cm-fix 创建时必须提供与 pair 匹配的 `--review-config`，实际调用仍需原逐步授权。

独立审查仍需原 preflight 和 `--review-config`；预检本身会调用外部 CLI，因此在真实账号上
可能收费，须遵守本次调用预算和授权。先生成与这组参数匹配的审查配置：

```bash
node scripts/cm-ai-host.mjs preflight --config {RUN.json} --external-provider codex > {REVIEW.json}
```

自定义配置时同时传 `--external-models-config {配置路径}`。审查和 provider 开发配置中的
显式 model／effort 必须与选中 pair 一致；冲突拒绝启动。受保护开发仍需
`--protected-config` 和 `--allow-provider-development-attempt`，检查配置可省略 model／effort，
原检查命令与权限不变。当前会话开发使用原工具桥，不产生一次额外模型调用。

新 run 冻结实际需要的 provider pair，外部开发和审查的参数、预检指纹及运行指纹一致。
`resume` 自动读取原快照，不读取新的用户默认值，禁止传入新配置文件或把旧 run 改成新模式。
以下命令只读展示运行状态、快照和逐次审查记录：

```bash
node scripts/cm-model-setup.mjs inspect-run --input {RUN.json}
```

## 中断与兼容边界

新模式按代码根持有现有 SQLite lease，并首次把代码根绑定到唯一规格根。
并行 batch 成员各自绑定隔离工作树，未完成的阻断成员保持原工作树及 run，不走第二代 fallback。
同一候选执行器不能用换 runId、关闭新旗标、supersede 或换规格根绕过未知调用；
尚无可信终态的外部开发取消也不能作为重派依据。只读核对原调用，不改旧记录。
旧二进制不理解这些保护，因此不要混用旧执行器在同一代码根创建新运行。

未成功观测的外部审查先停为 `unknown`。worker 只在核对原 provider 线程、实际终态、
独立审查包及拥有的 POSIX 子进程组已关闭后提供收据。宿主把收据绑定到原 run 的
registered／started／result 记录，再由显式 `reconcile_review` 接纳；调用方只传原 invocationId，
不能上传收据。仅 process close、错误线程／包、缺终态或清理不确定均不能对账，零重派。

驾驶员原 PLAN 改 `mode` 为 `resume`，增加原 `invocationId`，运行：

```bash
node scripts/cm-ai-drive.mjs --plan {PLAN.json} reconcile_review
node scripts/cm-ai-batch-drive.mjs --plan {BATCH_PLAN.json} reconcile_review
node scripts/cm-fix-drive.mjs --plan {FIX_PLAN.json} reconcile_review
```

batch PLAN 还需原 `taskKey`。QA 子运行沿原 `fix_action`，`fixOperation: reconcile_review`
及原 `invocationId`，仍核对父子关联。对账不签新 review grant、不启动模型或预检。
可信迟到合法结果恢复原审查状态；cm-ai 可信 provider failure 对账后允许原一次预算内、
新授权与新上下文重试。cm-fix 对账失败只进入 `review_provider_failed` 明确阻断，未提供
重试出口。无可信证据时禁止人工 abandon／recover 与自动重派。合法 `changes_requested`
保留原第二轮预算。旧无新快照的 run 保留原恢复合同，未迁移旧 run。

旧六用途设置及 task／project／global 文件只读预览，比较有效开发与审查选择，包括旧部分配置
继承的历史默认。它们不会参与新 run 自动选型：

```bash
node scripts/cm-model-setup.mjs legacy-preview --input {旧设置.json} --project {旧项目覆盖.json}
node scripts/cm-model-setup.mjs legacy-run-preview --input {旧模型运行快照.json}
```

选择相同且仅有同目录旧设置来源时，可以显式 `adopt-legacy --provider codex --input {旧设置.json}`
确认后写新文件。冲突或多来源必须用 `configure` 明确选一个 pair，不自动合并或覆写旧文件。
历史 experimental-model-v1／model-policy-v2 快照只检查快照及选择摘要，不验证执行归属；
恢复它们须使用原冻结执行器。没有迁移任何现有 run。

动态推荐已从当前范围移除；没有在线目录、付费评测、自动能力发现或后台监控。配置更改仅影响未来显式启用的
新 run。回滚时移除新 run 计划的旗标并使用原安装；已创建的新 run 继续用创建它的执行器及快照，
保留绑定和 lease 文件供核对，不删除它们来规避未结调用。
