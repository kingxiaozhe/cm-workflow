# 有效 blocked 后的证据补充与一次续审

此入口适用于已有 `nativeCorrection` 的原生受保护单根任务。运行使用 control policy v2、Codex 当前会话开发和一个 Codex 独立审查者。最近一次审查必须是已登记回执的有效 `blocked`，并存在 P0、P1 或 P2 findings。资格不依赖某个固定调用次数或特定重试链。普通 r1/r2、bootstrap、多根、批处理、provider 开发及其他执行模式不在本合同范围内。

本合同只追加证据。它不改变源码、规格、原 baseline、scope、配置、已有回执、已消费调用或旧授权。任何源码、检查、handoff 或规格漂移都会拒绝登记；确需改代码时，应另行建立满足原权限及审批要求的正式修复合同。本入口没有隐式开发名额。

## 第一步：只登记材料

保留原运行与原配置，以原 owner 恢复并读取 `status`。`status.evidenceContinuation.source` 为可登记来源，包含原任务身份、host、revision、旧回执、旧包、配置、baseline、当前候选和指纹。来源为 null 表示当前状态不符合登记合同。

将 `status.launchControlTarget` 的完整原值保存到 `EXPECTED.json`。建立独立请求文件：

```json
{
  "version": 1,
  "reason": "登记本次补充证据，暂不授权新审查",
  "evidenceContinuation": true,
  "source": "替换为 status.evidenceContinuation.source 的完整对象",
  "manifestDigest": "新 manifest 文件精确字节的 SHA-256",
  "nativeEvidence": {
    "version": 1,
    "sourceRoot": "/absolute/external/evidence",
    "manifest": "manifest.json"
  },
  "findings": [
    {
      "id": "原有效 blocked 的 finding ID",
      "disposition": "作者对这项发现的补证说明，供新审查独立判断",
      "evidenceIds": ["新文字附件 ID", "新图片相对路径.png"]
    }
  ]
}
```

`source` 在实际文件中必须是完整对象。`findings` 必须逐项覆盖旧回执全部 P0–P2 findings，并引用新材料中真实存在的文字文件 ID 或图片路径。作者的 disposition 不代表发现已解决，也不是视觉 PASS。

继续使用现有正式入口与原配置：

```text
--mode resume --native-correction REGISTER.json --expected-control EXPECTED.json
```

仅发送 `status`。driver 的 PLAN 将这两个参数加入 `permissions`，保持 `mode:"resume"`，然后执行 `status`。此步追加 `review-evidence-registered`；状态仍为原 `blocked`，模型调用数不变，审查和开发名额均为零。

新材料采用现有 native-evidence 清单合同。PNG 保留完整字节；文字保留完整内容及来源哈希，JSON Pointer 可声明必需字段。`text/html` 仅按 `.html` 纯文本传递，不执行。来源目录必须在项目和 specs 外。既有单文件、总字节、图片、journal 和审查传输上限保持原值，超限明确拒绝，不能删减必要证据或假称已可续审。

## 第二步：单独授权一次新审查

登记成功不授权此步。取得针对本次新审查的第二个明确授权后，重新只读 `status`，保存新的完整 `launchControlTarget`，并使用 `status.evidenceContinuation.reviewSource`：

```json
{
  "version": 1,
  "reason": "单独明确授权本次一次 fresh 独立审查",
  "evidenceReview": true,
  "source": "替换为 status.evidenceContinuation.reviewSource 的完整对象"
}
```

仍通过原入口 `resume status --native-correction AUTHORIZE.json --expected-control EXPECTED-AUTH.json` 登记。这一步追加独立的 `review-evidence-authorized`。成功后去掉登记参数，再按正常 `decision` / `advance` 合同派发唯一新审查。

唯一机会在 `effect-intent` 消费。它不是旧名额返还，不会提高全局上限、重置计数或创建新 run。相同请求的重复登记和授权会识别固定 request digest，不会重复追加或生成第二个 intent。不同请求、旧 source 或错误 owner 会拒绝。登记和授权均在原 writer 锁下核对，来源材料、旧证据及当前代码漂移也会拒绝。

## 完整审查、保存与停止边界

新包保留原 baseline 到当前候选的完整差异、规格、测试、handoff、旧 native check 和旧回执，并追加 `evidenceContinuation` 数据。实际 reviewer input 同时提供旧、新全部图片和完整文字材料。新审查不能只看附件或截图，须重新判断原发现与全部验收要求。fresh reviewer 身份排除及原调用结果恢复沿用既有合同。

新有效结论投影为独立的 `native-correction-1-evidence-1.md` 和 `native-correction-1-evidence-1-receipt.json`。原 `native-correction-1-material-1` 文件和先前结论继续保留。N5、完成复查、任务标记和原 QA 只接受新的真实 registered approved receipt。

已保存的同调用有效结果可在固定 wire target 下通过既有 `reconcile_review` 接回，不调用模型。取消、未确定结果和在途 writer 继续受原合同约束。

新结论为 `blocked` 或 `changes_requested` 时，运行保持阻断。本合同没有第二次证据补充、新审查或代码修改出口。状态说明已消费机会和实际结论，不能用放弃、重置或新建运行绕过。`approved` 仍须通过原完成和 QA 门禁才能宣称任务完成。

只读 `cm-ai-drive preflight` 的 `evidenceReviewInput` 精确投影未来包摘要、完整提示字节、页数及旧新图片/文字数量。它共享实际捕获的元数据组装函数，校验当前来源但不创建存档，明确返回 `notDispatchable:true`、`archivesVerified:false`、`authorizationGranted:false`。正式 owner 仍须在锁内重新捕获并检查存档与 journal 容量，预检通过不代表授权或业务验收。

单个 JSON 原件超过文字物理单文件上限时，可明确使用 `application/x-cm-lossless-json-evidence` 的 `.json` 派生载体。载体包含原相对来源、精确 SHA/字节数、完整原件 gzip，以及保留全部 JSON token 的 `data`。宿主在有界解压后逐 token 核对，不读取其 provenance 路径。载体本身仍受原 1 MiB 物理单文件上限限制；readiness、捕获、累计存档和已存档验证均按原件字节数计入原 4 MiB 总预算。原件和原格式保留，不用压缩绕过总量限制。

审查展示可使用可逆 JSON 子片段表，重复子树只展示一次完整 token 正文，各引用仍保留顺序和全部值。宿主验证展开后的全部 token 与原件字节；reviewer 必须阅读完整字典内容。此展示不改变 canonical package 或回执摘要，也不提高输入字节或页数限制。

隔离验收入口为 `node --test scripts/cm-ai-valid-evidence-continuation.test.mjs`，已纳入 native test inventory。它先生成一个真实原生受保护 blocked 种子，再因共享 owner 和不可变输出路径而顺序验证 blocked、changes_requested、approved 三个分支。每个分支仍调用正式 host/driver 和 fresh 合成 provider；只在临时夹具中恢复种子，并先保存该分支 journal/回执/输入/结果。此结果不代表三份独立旧链全部通过，也不证明真实模型会批准或真实设备视觉验收通过。

## 补证续审遇到原生 provider 无结果

已消费的补证审查若留下已验证的原生 `error` 或 `turn.failed`，且 `failed/provider_failed`、thread/turn 起始、进程关闭和清理均已确认，同时没有最终业务消息，原 owner 可显示 `providerReviewRecovery.source`。无效事件、答复格式错误、缺失初始化、材料不全、超时、取消、未知清理或有效业务结论均不符合资格。资格不依赖某个项目名或固定调用次数。

来源包含原身份、host、原 journal revision、失败调用/记录、原补证授权、完整包、配置、baseline、scope 和候选摘要。需要针对这次新增审查的单独明确授权：

```json
{
  "version": 1,
  "reason": "单独授权本次一次技术恢复审查",
  "providerReviewRecovery": true,
  "source": "替换为 status.providerReviewRecovery.source 的完整对象",
  "oldInvocationStopped": true
}
```

保存完整 `launchControlTarget` 后，沿原配置使用 `resume status --native-correction FILE --expected-control EXPECTED.json`。`oldInvocationStopped` 是人工确认，不能替代机器记录或 writer 锁。登记只追加 `review-provider-recovery-authorized`，不派发模型。随后去掉授权参数，按正常 decision 派发固定 `review-provider-recovery-1`；机会在 intent 消费。每个原运行仅一次，重复相同授权幂等，不同请求或陈旧快照拒绝。

原配置、完整审查包、旧失败、调用与已消费许可保持原值。新增真实调用另行计数。没有新开发名额，不增加 attempt，不提高全局预算；provider 再失败或中断不返还机会，也不产生第二次技术恢复。旧 unknown/pending_review 的同调用完整有效 saved result 继续优先走既有 `reconcile_review`。若完整 provider 失败终态与同次成功 sidecar 冲突，显示 `provider_recovery_result_conflict`：保留双方证据待核对，不能新增调用，现有 reconcile 不适用。本轮不提供失败终态改写成功结果的合同。

新审查同时覆盖原 baseline 到最终候选的完整变化、原 findings、旧新图片和完整文字。新结论另存 `native-correction-1-provider-recovery-1.md` 和 receipt。有效 `blocked` 或 `changes_requested` 保持阻断；`approved` 仍须通过原完成检查和 QA。旧文件、所有历史和计数不覆盖。

参见[原生审查诊断](provider-review-diagnostics.md)。原生失败事件可附带严格脱敏的诊断元数据：固定分类/代码、HTTP 状态及原消息字节数/哈希。它仅帮助定位故障，不授予恢复资格。缺失诊断的旧合法记录仍按原字节验证；无法从旧记录确定的根因继续标为未知。维护补丁与隔离测试均不构成对真实运行新增审查的授权。

恢复准入同时按原 `RECORD_LIMIT` 和 `STATE_LIMIT` 预留授权、完整审查及原完成提交所需记录与字节。新 reviewer 排除所有先前调用的 provider thread，排除集合仍受原上限约束；容量不足时不给出可用 source，不提高上限。
