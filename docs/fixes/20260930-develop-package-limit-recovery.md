# 超大开发交付的可重试恢复

## 现象与现场

`bootstrap-T-008` 通过当前 Claude 会话直连 `cm-ai-host.mjs serve --mode create`，未经过
`cm-ai-drive.mjs` 的启动前大小预检。开发调用交付 70 个文件后，5 项检查全部通过；生成
审查包时，scope、requirements 与 `AGENTS.md` 材料累计超过 2 MiB。旧实现把异常写成
`unknown/limit_exceeded`、`pendingAction: reconcile`，与 `js-host.md` 承诺的
`blocked/develop_package_too_large` 不一致，原 run 没有恢复入口。

保留现场位于 `<specs-root>/.reviews/.execution/bootstrap-T-008/state.json`。
修复前只读核对确认最后一个 develop checkpoint 的调用成功、检查全过、审查包为空，错误为
`limit_exceeded`；代码项目中的第一次交付保持未提交。

## 红灯与根因

新增真实单宿主用例，直接调用 host 并写入三个各 750 KiB 的文件，绕过驾驶员预检。修复前
两项回归均失败：新交付仍以 exit 1 的 `unknown/limit_exceeded` 结束；旧 journal 无法
`resume`。

`task-runner.mjs` 在 `createReviewPackage` 抛出大小异常后进入最外层通用 catch；通用分支把
除少数已列明门禁外的异常全部归为 `unknown`。后续用于处理 1 MiB 存档预算的检查只在
`awaiting_review` 后执行，因此无法接住审查包构建阶段的 2 MiB 材料上限。即使修正新状态，
旧 journal 回放仍会保留历史 `unknown`，所以只改 live 分支不足以恢复现场。

## 修法与边界

- 在审查材料构建的本地门禁处把 `limit_exceeded` 归一为可重试的
  `blocked/develop_package_too_large`，保留有界的原始路径和字节上限说明。
- 回放旧 `unknown/limit_exceeded` 时，只迁移第 1 轮 develop 调用成功、全部检查通过、没有审查包、
  没有 review receipt，且 reason 符合审查快照构建器诊断的确定性形状。verification gate 等
  通用 JSON 上限不满足该来源条件；第 2 轮旧记录无法证明检查来自当前 effect，也不迁移。原
  journal 字节不改写；恢复后的下一条 checkpoint 才携带新投影。
- instruction bootstrap 保留专用的禁止重派边界，不从该通用状态取得新的 developer effect。
- 其他 provider、写盘、漂移或检查前的 `limit_exceeded` 继续走原未知语义，不扩大重试权限。
- 1 MiB checkpoint 预算仍沿用原来的精确预留计算；本修复补齐的是更早发生的 2 MiB 审查
  材料异常和旧运行恢复。

## 验证

- 红灯回归修复后 2/2 通过：直连 host 返回 retryable block；旧 journal 可 `status` 后在原
  attempt 以新 effect id 重做并到达 `awaiting_review`。
- `node --test scripts/cm-ai-develop-driver-gaps.test.mjs`：60/60 passed，覆盖 2 MiB 材料上限、
  1 MiB 存档预算、驾驶员预检与直连宿主恢复。
- `node --test scripts/cm-bootstrap-review-recovery.test.mjs`：2/2 passed，覆盖规则通道不因通用
  package limit 获得 developer redispatch。
- `node --test experiments/js-orchestration/task-runner.test.mjs`：344/344 passed。
- `./scripts/cm-check-runtime.sh`：PASSED。
- `python3 scripts/validate-public-repo.py`、`python3 scripts/scan-public-safety.py`、
  `git diff --check`：PASSED。
- 用修复后的源码只读打开保留的 `bootstrap-T-008`，得到
  `blocked/develop_package_too_large/pendingAction: resume`；现场 state 文件前后 SHA-256 均为
  `9d87bb9c8239b6080157186d403c9177967c3f42ac63c5a47a7285e2ee6a2702`。

## Learning

新增项目教训：开发调用已成功且检查全过之后，可由宿主本地判定的材料门禁必须在通用异常
出口前归一；新增可重试终态时同时验证旧 journal 的唯一恢复路径。该教训与代码、测试和文档
一起进入独立 Review。

独立 Review 第 1 轮提出两项 P2：instruction bootstrap 被通用 retry 路径扩大开发权限；旧迁移
没有区分 verification gate 的通用 JSON 上限。第 2 轮进一步发现旧 instruction bootstrap 与
第 2 轮 develop 的证据形状不够严格，以及带括号路径的历史诊断无法识别；修复后加入专用拒绝、
仅第 1 轮迁移和括号路径用例。第 3 轮确认 62/62 针对性用例通过，但指出事故说明含个人绝对路径，
公开安全扫描失败；说明已改为相对证据路径。最终 disposition 以修正后的复审记录为准。
