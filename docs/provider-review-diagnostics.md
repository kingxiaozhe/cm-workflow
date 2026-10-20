# 独立审查的失败原因记录

Codex 的 `error` 或 `turn.failed` 事件表示调用失败。进程随后退出 0 不能覆盖该事实，不能生成通过凭证。

`worker-codex.mjs` 在规范失败事件和 `process_closed` 上附加可选的版本 1 `diagnostic`。原始 observation 的摘要绑定诊断，既有 journal、回放及同调用结果接回流程保留该证据。完整材料传输另把同次最终诊断保存在 `material-failure-*.json` 的 `nativeDiagnostic.diagnostic`；该文件有独立摘要，但不签发 owner 接受凭证。

| 字段 | 内容 |
| --- | --- |
| `version` | 固定为 `1` |
| `source` | `stdout_error`、`stdout_turn_failed` 或 `stderr` |
| `category` | 固定分类；未识别为 `unknown`，不一致为 `conflict` |
| `code` | 允许清单中的原生错误码，或 `null` |
| `httpStatus` | 允许清单中的 HTTP 状态，或 `null` |
| `messageBytes` | 原错误文字的 UTF-8 字节数，缺失时为 0 |
| `messageSha256` | 原错误文字的 SHA-256，缺失时为 `null` |

分类只接受固定错误码或完整匹配的固定错误文字，包括上下文、输入、图片、schema、参数、认证、额度、限流、模型及服务端问题。任意文字中碰巧含某个词不作分类。错误码不是通过结论，也不决定恢复资格或授权。

任意错误原文、完整事件、stderr、提示词、请求头和凭据均不写入诊断。未知原因只保留字节数和摘要，明确标为未知；不能凭分类或摘要还原原文。stderr 在内存中至多保留 4096 字节，超长或混合未知文本不据此推断原因。

一次调用至多采集两个 stdout 失败诊断，兼容先 `error` 后 `turn.failed` 的方言，仍只向 observer 转发一个失败终态。先未知后已知时采用已知；先已知后未知时保留已知；两个已知但错误码或状态不同时标为 `conflict`，不挑选一个声称根因。最终诊断附在关闭事件上，回调失败不改变调用结果。清理未能确认时仍为 `process_cleanup_unknown`，即使已知错误码也不能开放技术恢复。

旧合法 observation 没有诊断字段时保持原始字节、摘要和恢复规则，不补写默认诊断。升级不能找回历史上已经丢弃的错误；没有证据时必须保持原因未知。调用使用的 CLI 版本也须以该次实际留存证据为准，不能用当前机器版本倒推历史版本。

本改动修复“失败原因没有留下”的问题，不保证 provider 不再失败。技术无结果的受控恢复需要独立的明确授权；没有授权时只查看证据，不重复发起审查。
