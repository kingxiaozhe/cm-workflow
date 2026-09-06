# OpenAI-compatible 深层 JSON fixture 跨版本修复

## 现象

`scripts/test-cm-openai-compatible-call.py` 在 Python 3.9 通过，但在 CI 的
Python 3.12 上失败。Linux 与 Windows 均停在深层请求 JSON 的错误文案断言；
修复第一处后，深层 provider 响应存在同样问题。

## 红灯证据

- `python3.12 scripts/test-cm-openai-compatible-call.py`：失败于原第 760 行，
  预期 `stdin is not valid strict UTF-8 JSON`；
- 同一份 2000 层请求在 Python 3.9 返回“无效严格 JSON”，在 Python 3.12
  返回 `stdin exceeds the maximum JSON nesting depth`；
- 请求侧修正后，Python 3.12 在 provider 响应侧的同类断言继续失败。

## 根因

fixture 用 2000 层 JSON 同时测试“Python 解析器递归上限”和“适配器 128 层
深度上限”，并把 Python 3.9 先抛出的 `RecursionError` 文案当成产品契约。
Python 3.12 能解析该输入，随后正确命中适配器自己的深度保护，因此测试结果
随解释器版本变化。

## 最小修复

- 请求与响应 fixture 都改为 256 层：足以稳定超过产品的 128 层限制，同时
  不依赖 Python 解析器先失败；
- 两侧都断言产品定义的 `exceeds the maximum JSON nesting depth` 错误；
- 不修改适配器运行时行为、协议、日志或错误码。

## 回归

- `python3 scripts/test-cm-openai-compatible-call.py`: PASS（Python 3.9.6）
- `python3.12 scripts/test-cm-openai-compatible-call.py`: PASS（Python 3.12）
- Python 3.12 `./scripts/cm-check-runtime.sh`: PASS
- public repository validation、public safety、Bash syntax、shell compatibility、
  workflow config、task gate 与 `git diff --check`: PASS

独立审查凭证位于 `docs/fixes/.reviews/`，并通过内容摘要绑定本次两个改动文件。
