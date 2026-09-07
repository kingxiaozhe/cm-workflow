# CM JS N1–N2 admission R2 path/identity successor

日期：2026-09-03  
状态：fixed and locally verified；`ready_for_review`，最终裁决以对应 Review 证据为准。

## 现象与来源

Fresh R2（thread `01a06b0d-5372-70e0-8398-e79ac2b9fdaa`）在原 13 项测试全绿后，
用临时对抗夹具复现三个残留边界：

1. specs 外的 `.cm-specs-status` 可决定批准状态；
2. `test-cases.json` 可链接到 specs 外或相邻 feature；
3. 重复 feature slug 或外链 `.reviews` 可错误消除历史 Review 欠账 warning。

R2 按两轮上限裁决原 attempt 2 `blocked`。用户随后只授权一个新的极窄 successor，
不是 attempt 3，也不授权其他产品能力。

## 基线与红灯

- 修改前 focused：13/13 passed。
- 新增五个直接复现用例后：13 passed、5 failed、exit 1。
- 错误实际值：前三项返回 `ready` 而非 `blocked`；后两项返回 `complete` 而非
  `blocked`。

五个失败分别覆盖：批准文件外链、旧合同外链、记录合同跨 feature、重复 slug、
`.reviews` 目录外链。测试文件：
`experiments/js-orchestration/cm-ai-admission.test.mjs`。

## 根因

N1–N2 admission 已验证 feature 三件套与普通 feature/task 名称，但没有把批准状态、
可选测试合同、Review 目录和去编号后的 slug 纳入同一个物理/逻辑身份边界。

## 最小修法

- `.cm-specs-status` 的 realpath 必须留在 specs root；否则 `spec_status_invalid`。
- recorded 与 legacy 测试合同的 realpath 必须留在对应 feature root；否则分别按
  `spec_status_invalid` / `test_cases_invalid` 阻断。
- feature discovery 拒绝重复的无编号 slug。
- `.reviews` 必须是直接目录，不能是 symlink；否则 `review_evidence_invalid`。
- 只改 admission 根因层和对应文档，没有进入 N3–N5 或增加通用安全抽象。

## 绿灯与回归

- focused：18/18 passed。
- syntax：passed。
- full Node：982/982 passed，exit 0。
- runtime：passed，plugin v0.10.4。
- public repository validation：passed，8 core skills。
- `git diff --check`：passed；候选新文件另以完整哈希和 Node 解析绑定。
- safety：exit 1，仍精确为原有五项：
  - `docs/marketing/wechat-draft-dry-run.json:5,8`
  - `experiments/js-orchestration/tool-preview.mjs:40,98`
  - `experiments/js-orchestration/worker-codex.mjs:26`
  本 successor 未修改或豁免这些位置。

## Learning

将已有“身份边界不能靠字符串碰巧命中”教训增量扩充：固定路径还必须验证真实来源，
feature slug 必须唯一，证据目录不得通过 symlink 改变权威根。该改写与代码一起等待
successor 独立 Review，不在 Review 后追加。

## Successor Review R1 与 attempt 2

Fresh successor R1（thread `01a06b2b-ef9e-7d03-b150-5282e3c48308`）确认原五类
R2 输入与 982 项全量回归通过，但复现一个同范围 Medium：`1.login` 完整名会与
`2.1.login` 的无编号 slug 碰撞，一份 `1.login-T-001-r1.md` 会消除两项欠账。

- R1 verdict：`changes_requested`，N5 正确拒绝。
- 新增一个直接回归后红灯：18 passed、1 failed，实际 `complete`、预期 `blocked`。
- 最小修复：对所有完整 feature 名和无编号 slug 构成的实际 Review 匹配键做全局唯一检查。
- focused 修复后：19/19 passed。
- attempt 2 full Node：983/983 passed，exit 0。
- attempt 2 runtime/public/syntax/diff：passed；safety 仍精确为原有五项。
- attempt 2 fresh R2：待执行。

## 未做

- 不处理 R2 标注为非阻断的 `- AC-999:` 解释风险。
- 不扩展 hardlink、通用 TOCTOU、provider 身份或安全平台。
- 不处理历史 safety 五项，不写真实 specs/tasks，不安装、不提交、不推送、不发布。
- 安装版 `$cm-fix` 引用的 `runtime/model-efficiency.md` 与 `hash-implementation` 子命令
  在当前源码仓库不存在；沿用源码 v1 handoff、逐文件 SHA 与 manifest SHA，不补造接口。
