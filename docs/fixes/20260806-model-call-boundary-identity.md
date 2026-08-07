# Model call boundary and identity closure

## 现象

1. 2000 层 JSON 角色包触发 `RecursionError`，进程以 exit 1 输出 traceback，
   而不是在 HTTP/claim 前以 exit 2 拒绝。非标准 JSON 数字、孤立 Unicode
   surrogate、控制字符 URL 和 Unicode 主机名存在同类边界。
2. `model_call` 和 `model_usage` 只按 `run_id + call_id` 关联。不同
   workflow/stage/role/adapter 的 usage 可错误解除 claim；已有 usage 时，
   同 call id 仍可创建 claim 并发出 HTTP。

## 复现与红灯证据

- 修复前两个存量夹具均 PASS，说明原防护网未覆盖该边界。
- 深层角色包实跑：`exit 1`，stderr 包含
  `RecursionError: maximum recursion depth exceeded while decoding a JSON array`。
- 身份冲突实跑：writer 接受 reviewer claim 后又接受 planner usage；
  report 输出 `observed_calls: 1` 且 `unresolved_claims: 0`。
- 新夹具首次运行分别因为非法 URL 返回 exit 1、已完成 call id 仍可
  claim 而失败，与上述缺陷一致。

## 根因

- 适配器仅捕获常见 JSON/HTTP 异常，没有把严格 JSON、Unicode、嵌套深度与
  URL 安全字符统一收口，provider 边界也缺少最终失败 outcome 保障。
- writer 没有强制 claim/completion 的完整安全路由身份，reporter 又以
  `run_id + call_id` 作为“已完成”的充分条件。

## 修法

- 在 claim/HTTP 前使用严格 UTF-8 JSON 解析，拒绝非有限数字、无效
  Unicode、过深结构和非可见 ASCII endpoint；provider 回包复用同一解析器。
- provider 边界的未预期异常统一写 error usage；写入失败返回 exit 4。
- writer 强制 `workflow/runtime/stage/role/adapter/requested_model/source/purpose`
  完整且匹配，已完成 call id 禁止再 claim。
- reporter 先收集 claim 再处理 usage，身份冲突、冲突 claim 和
  usage-before-claim 都不计用量，claim 保持 unresolved。

放弃方案：不引入模型网关、数据库或新的长期服务；继续使用现有
JSONL + 标准库边界。

## 波及面

- `scripts/cm-openai-compatible-call.py`
- `scripts/cm-log-event.py`
- `scripts/cm-usage-report.py`
- 两个对应 fixture
- 模型调用/日志合同、README 安全描述和 OMX 当前状态

## 回归结果

- `python3 scripts/test-cm-openai-compatible-call.py`: PASS（含 exit 3/4）
- `python3 scripts/test-cm-usage-report.py`: PASS
- `./scripts/cm-check-runtime.sh`: PASS
- `python3 scripts/validate-public-repo.py`: PASS
- `python3 scripts/scan-public-safety.py`: PASS
- `/bin/bash scripts/test-shell-compat.sh`: PASS
- plugin validator: PASS
- `git diff --check`: PASS

## 测试路径

- `scripts/test-cm-openai-compatible-call.py`
- `scripts/test-cm-usage-report.py`

## 审查

审查生命周期而非单个历史文件才是最终状态：

- round 1 的
  `docs/fixes/.reviews/fix-model-call-boundary-identity-T-FIX-model-call-boundary-identity-r1.md`
  是历史 `changes_requested`，记录四个被后续修复的 finding；
- round 2 的
  `docs/fixes/.reviews/fix-model-call-boundary-identity-T-FIX-model-call-boundary-identity-r2.md`
  是该任务最终 disposition：四个功能问题已收口，但因证据 scope 文案不准确而
  `blocked`；
- 证据文案的人工处置与独立收口记录在后续小修复任务
  `fix-review-evidence-scope-honesty-T-FIX-review-evidence-scope-honesty-*` 中。

不得把 r1 当成最终批准，也不得把任何 `self-degraded` 结果描述为独立审查。
