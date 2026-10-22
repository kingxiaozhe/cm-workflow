# Preparing a review-only task split

This is a candidate maintenance protocol. It does not dispatch development or
review, allocate calls, approve specifications, or mark tasks complete. Its
registration receipt is provenance, not an independent review receipt.

Use a single inspected source tree. Record that tree's version and exact source
hashes separately from any installed plugin. A validated execution envelope can
preserve an older history without making its historical grants executable by a
new runner. Do not resume an unsupported historical runner to perform a split.

## Preparation

1. Inspect the original identity, complete journal prefix, revision, fingerprints,
   original before-to-final review package, call ledger, frozen run configuration
   and live writer ownership. Missing original inputs block registration; do not
   reconstruct them from a checkpoint or substitute a newer installation.
2. Continue the existing PRD change session. Preserve completed entries and their
   continuations, acceptance criteria and user test semantics. A historical
   `DROPPED` declaration remains in the document but does not consume one of the
   15 executable task slots. New proposals reject historical dependencies.
3. Prepare the exact proposal for a separate decision. `taskIds` changes on user
   cases require that decision's `allowUserCaseChanges` binding. Preparation is
   not confirmation, specification review, or final specification approval.
4. Map every original changed path, shared test group, historical finding and
   evidence source to its responsible child. Keep findings open. Keep separate
   source manifests separate; a derived package cannot relabel two manifests as
   one manifest that met the original single-manifest limit.
5. Build and measure the self-contained candidate request. Text pages hold at most
   16,384 UTF-8 bytes and never split a code point. Count inline common material,
   supplementary evidence and all image bytes. The text target remains 128 pages
   and image target remains 10. Report serialized request bytes separately from
   text plus raw image bytes; provider/RPC overhead remains unknown until that
   transport is implemented. Never report compressed data size as readable text.

The offline material entry is:

```sh
node scripts/cm-review-split-material.mjs prepare \
  --package ORIGINAL-PACKAGE.json --inventory PACKET-INVENTORY.json \
  --out NEW_DERIVED_DIRECTORY
node scripts/cm-review-split-material.mjs verify --file CHILD.material.json
```

The material report explicitly distinguishes integrity, capacity and formal
provider acceptance. A valid local file can still fail capacity and admission.
Original artifacts are preserved. Inline repeated JSON may share a readable
in-request definition; every reference must expand exactly. A verified lockfile
delta includes every changed node and coverage of unchanged subtrees.

## Registration boundary

The explicit preparation owner exposes:

```sh
node scripts/cm-ai-review-split.mjs prepare --plan SPLIT_PLAN.json
node scripts/cm-ai-review-split.mjs inspect --plan SPLIT_PLAN.json
node scripts/cm-ai-review-split.mjs register --plan SPLIT_PLAN.json
```

`prepare` reports structured acceptance separately from process success.
`register` requires all original bindings, exact proposal confirmation saved by
the PRD owner in `awaiting_review`, complete coverage and capacity checks.
`confirmed` without a completed owner save is not a stable registration input.
The saved session, immutable change archive, revision digest, current four
documents, approval manifest, nonselected features and auxiliary assets must
still match the exact saved proposal. It uses the existing execution-store writer locks.
It appends a parent intent, three child provenance records and a parent commit.
A partial intent stays visibly incomplete and cannot run. Repeating the same plan
continues its exact stage without duplicating children or consuming calls.
Conflicting inputs, unrelated suffix records and active writers block it.

Ordinary CM run creation, resume, task selection and failover must refuse these
review-only records. An existing parent is never rebaselined or marked approved.
The original prefix and paid calls stay immutable. Child records have no new call
allocation and no development authority.

There is currently **no send-review adapter in this candidate protocol**. Do not
use ordinary `advance`, supersede, code-drift acceptance or a zero-diff run as a
substitute. A future adapter must separately bind human call authorization,
remaining budget, reviewer model/effort, complete final request and independent
receipt/completion gates. Preparing or registering provenance does not satisfy
that work or authorize an invocation.

## Exact split proposal authority

The old parent remains pending and `DROPPED`; only the appended `DROPPED` marker
may change its original complete entry. Keep every original task and all its
indented continuation bytes. Each child must be new and pending. In each child's
existing tasks.md entry, declare these three explicit continuation lines:

```text
- [ ] T-004a: [NEW v3] Review the existing implementation
  - review-only
  - scope: `mobile/src/ui/GlassSurface.tsx` `mobile/src/__tests__/warm-frost-shell.spec.tsx`
  - test-groups: `mobile/src/__tests__/warm-frost-shell.spec.tsx:49-60`
```

List the complete paths and test groups assigned to that child in the split plan;
the example is illustrative, not the full Wue scope. A short filename is accepted
only if it uniquely resolves to one original changed path. Missing labels,
extra ownership, duplicate paths or an ambiguous short name block registration.
The marker grants no development or review invocation authority.

The confirmed full proposal must include the retained parent and exactly the
three child tasks. Its task responsibility lists must equal the plan. TC-001 and
TC-010 may replace the parent's taskIds with the three children while preserving
all other case fields and references. Every other test case remains unchanged.
Acceptance declarations retain their original text. Confirming an unrelated
proposal for the same feature cannot authorize the split.

The local fixture uses real `createPrdChange.confirm`, `save(true)` and
`openPrdSession.commit` with a provider sentinel. This exercises the saved owner
lifecycle in a synthetic project; it is not a confirmation or save of Wue.

## Focused validation

Run the affected fixtures in `scripts/`, including task grammar and reference
validation, executable task counts, PRD change preparation, review-only staged
recovery and material integrity/accounting. Use isolated fixture projects and
worker sentinels; do not invoke a product model or rerun product development to
validate this protocol. Local fixtures do not prove a real project was restored.

### 按验收场景承接（6/8/4 候选）

计划可显式指定 `sceneCoverage: {version: 1, coverageDigest}`。未指定的旧计划继续使用原组件责任合同；场景材料和旧合同不得混用。场景材料仍是离线候选，完整验证和精确提案确认不等于登记、派发、审查或开发授权。

场景子任务保留原 `review-only`、`scope`、`test-groups` 三行。`scope` 绑定原包全部 11 个路径；可沿用既有合同中唯一 basename 到完整路径的归一机制，歧义即拒绝。测试组同样可使用唯一 basename，并保留原始 `:start-end`；完整路径映射须在精确提案证据和原材料中保留。测试组与新场景责任映射绑定，所有原测试正文继续可见。每个子任务再追加以下六行；行顺序、原始场景名称、摘要及证据清单必须精确匹配已验证材料，缺失或含糊即阻断：

```text
  - review-scene: 原材料中的精确 scene 字符串
  - scene-contract: `coverageDigest`
  - scene-material: `材料文件SHA256` `请求SHA256`
  - scene-images: `origin:path` `origin:path`
  - scene-sources: `origin:fileId` `origin:fileId`
  - scene-closure: all-required-scenes
```

图片保持请求中的原图顺序；文字来源保持映射中的顺序，并筛选当前场景承担的来源。原生与续证同名来源按 `origin` 分别绑定。一个场景不能代替另一个场景关闭跨场景发现或验收项；全部指定场景结论与原阻断检查须合取。准备阶段不关闭历史发现。

原任务完整条目、缩进续行和完成标记逐字保留；原父任务只追加 `DROPPED` 历史标记。独立的“依赖关系”表保留原父前置行，新增三个场景各继承原父前置；原来依赖父项的后续任务精确改为同时依赖三子项。门禁不允许借此改变其他依赖或旧任务文本。TC-001/TC-010 仅把父项责任替换为三子项，其他字段及其他用例保持不变。

真实提案必须先经原 PRD owner 精确确认、保存并稳定停在 `awaiting_review`，同时绑定存档、状态、完整规格清单和资产。离线提案仅计算摘要；不能把手写批准或旧组件方案的确认用于新场景方案。
