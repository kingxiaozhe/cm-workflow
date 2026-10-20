# cm-workflow

Codex-native、spec-driven 的双运行时工作流分发包：需求文档 → 开发规格 →
实现 → 独立审查 → QA → 文档同步，并支持存量功能只读测试与可选外部专家研究。Codex Skills 与
`runtime/` 是权威流程，
Claude Code 跨平台直接使用 `/cm-*` Skills；`compat/claude-commands/` 保存
macOS/Linux 的历史 `/cm:*` 别名包装。

## 技术栈

- 语言: Markdown（prompt 资产主体）+ Bash（安装与可视化脚本）+ PowerShell（Windows 安装器与自检入口）+ Python（标准库校验/夹具）+ JavaScript（Node.js 18+；Playwright 可选）
- 框架: Pi/BYZ 原生 package + Codex plugin + Agent Skills；Claude Code commands/agents 兼容层
- 包管理: 根 `package.json` 保存 Pi/BYZ manifest 和 npm 安装命令入口，无 npm 依赖或 lifecycle scripts；Codex npm 入口复用 `install-codex.sh`，Claude Code 用 `install.sh` / `install.ps1`
- 版本控制: remote
- 交付形态: Pi/BYZ package + Codex/Claude Code 本地开发者工具（无构建产物）
- 业务地图: 跳过（开发者工具分发仓库，不是 `src/` 风格业务应用）；本地扫描产物不提交，公开架构见 `docs/architecture.md`

## 常用命令

- 方案推敲：`$cm-challenge` / `/cm-challenge`，显式三轮或必要追问；复用 `runtime/steelman-review.md`，只输出讨论建议，不启动宿主、不替代正式审查。

- 兼容手工任务：N3 编辑前运行 `node scripts/cm-task-gate.mjs capture-baseline --project-root {CODE_PROJECT} --reviews-dir {SPECS_DIR}/.reviews --feature {FEATURE_SLUG} --task {T-xxx}`；仅命令行 N4/N5 与完成入口开启清单核对，库调用默认行为不变，JS 使用自己的审查包基线。仅单代码根，历史缺基线用现有 `--allow-legacy-unbound` 披露清单未核验；详见 `runtime/task-gates.md`。

- CM control v2：新 cm-ai run 用 `--control-config POLICY.json` 明确运行能力，禁止 `--allow-*`；旧 run 沿 legacy，不迁移记录。配置、operator/model 与 V3 grant 不证明真人身份，真实对话及外部动作授权保持；详见 [控制策略与恢复合同](../docs/cm-control-policy-v2.md)。
- v2 兼容 taskgate 人工补正限无 JS ownership 的任务。已有受保护 `nativeCorrection` 单根 Codex 当前会话运行收到有效 blocked 后，可由原 owner 通过 `resume status --native-correction FILE --expected-control FILE` 先登记 `evidenceContinuation`；另获一次新审查的明确授权后登记 `evidenceReview`。只补证据，不授开发权限；保留原完整差异、旧结论、历史和已用次数。普通 r1/r2、多根、批处理及 provider 模式不适用。详见 [有效 blocked 证据接续](../docs/cm-valid-blocked-evidence-continuation.md)。

- 安全扫描：`$cm-security` / `/cm-security`，分支差异加已跟踪未提交修改；`--all` 扫全部已跟踪文件。工具缺失保留缺口，不自动修复或安装；定点验证 `node --test scripts/cm-security.test.mjs`。
- 分支影响分析：直接 `$cm-test` / `/cm-test`；默认比较当前提交与主分支，输出业务影响和回归重点，再检查单测覆盖率；“补齐单测”连续补测、重跑、审查。显式目标保留原模式。

- cm-fix Claude 隔离验证：新运行可选 `reviewVerification`，`node scripts/cm-fix-review-preflight.mjs --config {运行定义.json} --model {Claude模型}` 生成诊断；限定 macOS 自包含命令，不迁移旧运行。详见 `skills/cm-fix/references/isolated-review.md`。

- cm-fix 原运行更正：命令配置发现使用 `scripts/cm-fix-command-correction.mjs` 只读预览，随后独立授权 `prepare_command_correction`；已编写测试的限定回调类型更正使用 `scripts/cm-fix-test-type-correction.mjs` 和 `prepare_test_type_correction`。两者只追加原 owner 历史，原配置、审查次数与失败证据不改；详见 `skills/cm-fix/references/command-correction.md`、`test-type-correction.md`。

- JS 修复入口: `node scripts/cm-fix-host.mjs --help`；同仓specs可显式配置`protectSpecs:true`，原权限/审查不变，宿主只回文本提案，由固定沙箱写入；QA子配置复用，详见`docs/js-workflow-control.md`

- cm-ai 进度：当前任务真实阶段更新 `.cm-status.json`；单／批驱动检查边界及阻塞说明写 stderr。可选 guidance 只解释原恢复前提，不授予重试权限；保护模式不转发原始命令输出，并行状态卡旧完成不能抢占，详见 `docs/js-workflow-control.md`。

- CM 收尾：有文档能力的新 run 默认在原 documentation_inspect 做只读资料核对；原 workflow-config 可用 knowledgeCloseout:false 关闭，旧 run 沿快照，报告不代替 Review/QA。见 `skills/cm-ai/references/knowledge-closeout.md`。

- 双运行时容灾: 断点交接 `node scripts/cm-failover.mjs status|handoff|probe --specs {SPECS_DIR}`（只读，不标记完成）；启动前选路 `cm-ai-host.mjs serve ... --failover`（显式 opt-in，只定起跑运行时，切换必播报）。运行时声明 `runtimes.available` 与四个预设见 `templates/cm-workflow.yml`、`runtime/workflow-config.md`（声明不等于派发）。主从与边界见 `docs/runtime-failover.md`；定点测试 `node --test scripts/cm-failover.test.mjs scripts/cm-runtime-failover.test.mjs`。

- 运行时声明：`$cm-runtime` 先查看并默认保留，主动修改才进入预设向导；高级模型入口只读说明。`show|preview <preset>|set <preset>|set --user <preset>|unset --user`；向导确认 `[y/N]`，`set --expect-preview <sha256>` 拒绝过期预览。项目 > `~/.cm-workflow/runtimes.yml` > 未声明；只影响新 run。安装器可跳过配置且默认保留，`--yes` / `-Yes` 或非 TTY 跳过。
- 提醒渠道：`$cm-notify` / `/cm:notify` 查看、`bark|pushplus` 切换（目标密钥可解析才生效，否则不改文件）、`test`、`off`；托管发送器复制到 `<CM_WORKFLOW_HOME>/notify/cm-notify-send.mjs`，自定义命令需 `--replace-custom`。密钥只由用户填文件，不读出、不显示。定点测试 `node --test scripts/cm-notify-command.test.mjs scripts/cm-notify.test.mjs`。
- 外部模型：`node scripts/cm-model-setup.mjs configure --provider codex|claude`，一组模型／可选强度；`--external-models` 显式启用，宿主不切模型，恢复只读原快照，未知调用不重派。范围及回滚见 `docs/external-models.md`。

- 安装依赖: 无 npm 安装步骤（`package.json` 无依赖；可视化工具按需使用外部 Playwright）
- 开发运行: 不适用（直接维护 Markdown 与脚本）
- 构建: 不适用（无构建产物）
- 测试: `bash scripts/test-shell-compat.sh && node --test scripts/cm-ai-admission.test.mjs scripts/cm-workflow-config.test.mjs scripts/cm-log-event.test.mjs scripts/cm-task-gate.test.mjs scripts/validate-test-cases.test.mjs && python3 scripts/test-task-gate.py`
- JS 分组测试：`node scripts/cm-test-suite.mjs check` 核对唯一清单；`run ordinary`、`run native --concurrency 1`、`run history --concurrency 4` 分别跑普通、原生沙箱和历史组，自动隔离 CM 配置与日志目录；安装兼容夹具只写各自临时目录，不改变用户安装。要求与 CI 分片命令见 `CONTRIBUTING.md`。
- Lint/安全: `python3 scripts/validate-public-repo.py && python3 scripts/scan-public-safety.py`
- Bash 语法: `find . -type f -name '*.sh' -print0 | xargs -0 -n1 /bin/bash -n`
- Pi/BYZ package: `pi install git:github.com/kingxiaozhe/cm-workflow`
- Codex 安装: `./install-codex.sh`（装完新开会话跑 `$cm-check`）
- Claude 安装: `./install.sh`（核心运行时原子更新/失败回滚；可选更新器 best-effort，装完跑 `/cm-check`）
- Windows 安装: `powershell -ExecutionPolicy Bypass -File install.ps1`（同样原子更新）
- 一致性自检: `./scripts/cm-check-runtime.sh`；完整当前会话机械/语义接线：`node scripts/cm-check-host.mjs --help`
- 完整 `cm-check` 默认先调用 `scripts/cm-check-update.mjs` 查询并升级已管理安装，再检查返回目录；低层检查仍只读。定点测试：`node --test scripts/cm-check-update.test.mjs scripts/cm-check-host.test.mjs`。
- 全局日志夹具: `./scripts/cm-check-runtime.sh --log-fixtures`
- API 用量报告: `python3 scripts/cm-usage-report.py --last 10`
- OpenAI 兼容调用夹具: `python3 scripts/test-cm-openai-compatible-call.py`
- 审批 manifest: `python3 scripts/cm-spec-manifest.py {specs}`
- PRD 单轮恢复夹具: `python3 scripts/test-cm-prd-review-gate.py`
- PRD JS 变更/会话恢复: `node scripts/cm-prd-host.mjs --help`；定点夹具 `node --test scripts/cm-prd-completion.test.mjs`
- 公开包检查: `python3 scripts/validate-public-repo.py`
- 安全扫描: `python3 scripts/scan-public-safety.py`
- JS runtime 兼容夹具: `node --test experiments/js-orchestration/*.test.mjs`（完整宿主验证要求支持原生沙箱的平台与 Node.js 24.14+；历史夹具通过不等于真实模型验收）
- JS 单任务入口: `node scripts/cm-ai-host.mjs --help`；默认当前会话，Codex 同仓 specs 可显式选 `--protected-config`；v2 用策略启用开发与常规审查，legacy 保留原按轮选项；原 workflow 配置接受保护 QA 与审前文档，安装与真实模型验收另验
- JS 多任务入口: `node scripts/cm-ai-batch-host.mjs --help`；复用原 batch/单任务宿主，Codex/Claude 可选 `--protected-conversation-config` 同仓文本提案/沙箱；v2 常规 Review 自动至两轮，legacy 保留按 feature/task/轮次授权
- JS 单任务二进制资产：新当前会话任务可显式声明 `binaryAssets`，精确字节进入原运行绑定的私有存档，原文本/journal预算及保护、Review、恢复门禁保留；合同见 `skills/cm-ai/references/js-host-binary-assets.md`，不能向旧运行静默补能力。
- 当前会话执行证据：四驾驶员可显式配置 `liveEvidence`，合同与不可用恢复见 `docs/live-evidence-drivers.md`；静态文件不能代替实际执行。
- 第二轮 blocked 后的人工补正：明确人审范围后使用一次性的 `cm-task-gate.mjs prepare-human-correction` / `publish-human-correction-review`；保留旧证据，补正独立 Review，详见 `docs/human-correction.md`。
- cm-fix 原根因拒绝恢复：standalone `rediagnose` 需 `--allow-rediagnosis`；原 run 一次新诊断/fresh r2，历史不覆盖，第二次拒绝停机；详见 `skills/cm-fix/references/js-host.md`。
- JS 重构: `node scripts/cm-refactor-host.mjs --help`；协议见 `skills/cm-refactor/references/js-host.md`，轻量/批量、判官准备、恢复、Learning/规则/备忘共用原门禁；真实双端使用与Git交付另验
- Claude JS 接线: 单/批任务 `--runtime claude` 已接原开发/Review/QA链，已安装CLI通过本机回环配置诊断；真实模型Review及Skill实装仍缺，不等于双端验收
- 只读任务提案: `scripts/cm-task-gate.mjs` 的 `prepare-mark-done` / `verify-mark-done-plan`；参数与私有输出契约见 `runtime/task-gates.md`，不是完成授权
- 插件验证: `python3 ~/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py .`
- 发版面冒烟: `./scripts/cm-release-smoke.sh`（本地 BYZ + Codex；Codex 装入一次性 HOME）
- 查看版本: `cat VERSION`
- 可视化预览: `templates/pixel/cm-pixel.sh --demo`、`templates/dashboard/serve.sh {specs路径}`

不使用第三方单元测试框架；Shell、Python 与 Node.js 行为由可执行夹具覆盖，prompt 流程另需相关路径 dogfood。安装命令会写用户级目录，只在明确安装或隔离冒烟时执行。

## 目录结构

```text
compat/claude-commands/ # macOS/Linux 历史 /cm:* 三行别名包装
skills/                # Codex 权威流程与工种能力
├── cm-{challenge,idea,init,prd,ai,test,fix,refactor,check,runtime}/
├── cm-*-engineer/     # frontend/ui/miniprogram/backend/database/contract/qa/devops
├── cm-product-manager/、cm-finance-expert/、cm-doc-syncer/
└── codebase-context/、external-expert/、darwin-skill/ # 独立工具；点子访谈引擎位于 cm-idea/references/
agents/                # 并行子 agent → ~/.claude/agents/ —— agent 管纪律
runtime/               # 双运行时共享合同；runtime/js/cm-ai 的 host/runner 是新 cm-ai 任务的默认执行与持久状态层
templates/             # workflow config / rules 骨架 / hooks / statusline / dashboard / pixel
docs/                  # 使用手册、安装架构、交付材料与示例 specs
assets/                # README 与使用手册的本地视觉资产
scripts/               # 双运行时机械检查、公开包校验与辅助脚本
experiments/js-orchestration/ # JS 兼容转发、历史实验与本地夹具；不保存第二份 cm-ai 实现
.codex-plugin/         # Codex 插件清单
VERSION                # 语义版本源，与 plugin manifest 基础版本一致
CHANGELOG.md           # 用户可感知的版本变化；未发布改动单独记录
```

## 核心架构原则

- **agent 管纪律，skill 管技术**：并行干活的做 agent（前端/UI/小程序/后端/数据库/合约），串行把关的做 skill（产品/金融/QA/运维/doc-syncer）。新增角色前先归到这两类之一。
- **引用即契约**：本仓库历史缺陷全属「引用断链」——改名残留、匹配表缺项、死角色、失效命令引用。任何跨文件引用都由 `/cm-check` 机器化校验。
- **一份流程真相**：Codex Skill 是权威实现，Claude 旧别名只转发，不复制业务规则。
- **业务地图回写**：需求与修复共用 `skills/codebase-context/references/writeback.md`，只增量更新、审前定稿；缺失建局部地图，项目指定文档优先，固定写入范围不自动扩大。
- **任务级 Learning loop**：开发/排错先重读根 `AGENTS.md`；每 task 收尾按 `runtime/project-learning.md` 提炼写回、随任务审查并回读，无新增明确记录。JS 源码接通不等于真实下一 task 复用已验收。
- **源码分发不等于激活**：正式 JS 源码、本地测试或独立审查不等于 host 已接入、真实 provider 执行、任务完成、跨平台验证或发布；真实项目写入仍需明确授权。
- **容灾只在边界切换**：角色主从（developer 主 codex / reviewer 主 claude）只决定起跑运行时；任务中途失效靠落盘断点在另一端续跑，状态机不做 in-flight 切换。探测到 CLI 可解析不等于配额可用。
- **模板层是团队定制入口**：公司规范沉淀进 `templates/rules/`，所有项目 `/cm-init` 出的 rules 自动带公司基因。
- **流程间隔离（维护者确立,2026-07-18）**：修改任一 `cm-*` 流程不得顺带修改其他流程；流程 A 需要流程 B 的内容时读取 B 的落盘物，不复制或改写 B 的规则。发版版本只同步 `VERSION` 与 plugin manifest。

## 规则

@rules/coding-style.md
@rules/testing.md
@rules/security.md
@rules/git-workflow.md

容量预判与 a2 已审范围接续：复用 v2 resume/status 和固定目标；只读 `cm-ai-drive preflight`、`--task-review-origin` 及双基线合同见 `docs/cm-control-policy-v2.md`。可选已提交规则接纳复用ORIGIN.ruleAcceptance，规则进入审查而不进入业务写scope；旧基线/r1/次数不变。不自动继任、安装或重置预算。

原 v3/control-v2 第二轮 Claude 无结论额度失败的受控 Codex 切换使用 `--reviewer-switch-config`，保留原指纹和旧 reviewer 声明，通过唯一追加记录派生有效审查端，详见 docs/cm-control-policy-v2.md「原运行第二轮审查端变更」。不得直接修改原 review.json 或将 --failover 当恢复入口。

受保护二进制新任务的 Codex 审查复用原字节读取/完整性工具与证据门禁，入口和明确的单运行选择见 `skills/cm-ai/references/js-host-binary-assets.md`；不修改旧运行审查端或默认路由。

当前原生受保护任务在双 blocked 后仅凭另行明确授权，可通过 `--native-correction FILE --expected-control FILE` 登记一次独立补正 epoch；原 run/attempt2/旧证据/六次计数保留，只追加一次开发及一次 Codex 独审，N5/完成复查/原 QA 不变。详见 `docs/cm-control-policy-v2.md`。

- 材料续审：原已消费材料失败只可显式登记一次新增机会，绑定原宿主/调用/完整包/配置和固定目标；同调用有效结果接回不派模型。参数、无授权停止和验收见 `skills/cm-ai/references/js-host-recovery.md`。

- 审查错误留存：退出 0 不覆盖原生失败；固定分类、消息摘要、双失败合并及未知历史边界见 `docs/provider-review-diagnostics.md`。诊断不授予重派或完成权限，技术恢复仍须绑定原失败并另获明确授权。
