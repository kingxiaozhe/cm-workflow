# 已安装 CM 工作流整合候选

本记录以本轮实际读取的 `origin/main=a401be7`（VERSION 0.17.1）和安装文件哈希为准。
**工作树候选已形成；Git 元数据写入受环境限制，尚无本轮提交；独立 Claude 审查待用户后续安排。**
本轮没有 push、PR、main 合并、真实模型调用或实际运行时安装。没有改动其他工作副本或安装内容。
仓库安装器的自动测试若在临时 HOME 中执行，单独记为隔离夹具，不视为安装验收。

## 盘点与采用来源

- 安装树：892 个文件；`runtime/js/cm-ai` 内 133 个文件（128 个 `.mjs` 及 5 个 JSON）。
- origin/main：853 个已跟踪文件；对应模块目录 106 个文件。
- 安装独有 101 个；共有但内容不同 79 个；主分支独有 62 个。逐文件路径及 Git blob 见 [初始差异](initial-differences.tsv)。
- 两份 runtime 共有文件逐字节一致；Claude runtime 只多 `source-safety.md`。该文件不在插件分发源，未从用户级目录收编。
- 比较时排除 `worker-codex.mjs`、`worker-codex-developer.mjs`、`codex-reconnect-notice.mjs` 三个手工部署的重连修复文件。
- 在全部 461 个可达提交中，`f1ef412` 与其直接后继 `dec5ef4` 并列最近；采用不带后续额外夹具的 `f1ef412`：排除三文件后，873 个安装文件相同，16 个内容不同，没有安装文件缺失；快照另带 8 个安装树没有的文件。详见 [分支比较](branch-comparison.tsv)。
- `fix/aihot-cm-continuation` 实际 tip 已是 `8a8235d`，不再是用户提示的 `975fe9e`。其新增批次续行/本地重跑内容不属于当前安装目标，未带入。

采用顺序及理由：

| 顺序 | 原始历史 | 本轮处理 |
| --- | --- | --- |
| 1 | `bc090bf` | T-OBS 观测归档身份兼容 |
| 2 | `5ac6a57` | v2 卡死任务正式重开 |
| 3–5 | `b740f82` → `4a657b3` → `bed96d7` | 运行前只读体检及两轮已存在修补 |
| 6–9 | `16be2e8` → `88fba16` → `fef9e35` → `12b7ce9` | 范围追加、开发返工、检查重查取消及对应修补；保留已知限制与宿主操作清单测试 |
| 10 | `f1ef412` 的必要部分 + 安装差额 | 补齐其余安装功能；保留 origin/main 未分发的源码资产，不采用快照删除 |
| 11 | `0599bff` | 两 worker 重连修复及 15 项假进程回归 |
| 12 | `69bc28d` | 审查规模闸门、配置透传和相关测试；只解入本补丁增量 |

这些是来源链，**不是本轮已创建的提交链**。首次 `git cherry-pick -x` 在创建 sequencer 前被 `Operation not permitted` 拒绝，没有任何提交产生。后续只在允许写入的普通工作树应用历史 patch 和必要快照/安装差额，没有改写 Git 元数据。逐文件恢复来源与候选摘要见 [来源清单](source-attribution.tsv)。逐提交原 patch 与应用日志保存在本工作副本 `.omx/logs/consolidate-installed/`，供后续在具备 Git 写权限时保留真实历史。

### 为什么必须使用部分快照

`git log --all --` 显示 `review-material.mjs`、`codex-review-input.mjs`、`native-review-evidence.mjs`、`task-review-origin.mjs`、`protected-scope-supplement.mjs` 等安装功能，在现有可达历史中第一次出现于 `f1ef412`。现有功能分支的真实链只能恢复其中一部分，不能替代这些快照独有内容。

历史链应用后，剩余恢复中 149 个文件可直接取自 `f1ef412`。其余差额包括三份已经手工部署的 `0599bff` 文件，以及 12 个没有可达历史精确 blob 的安装文件：

```text
AGENTS.md
docs/cm-control-policy-v2.md
runtime/js/cm-ai/cm-ai-conversation-entry.mjs
runtime/js/cm-ai/continuation-preflight.mjs
runtime/js/cm-ai/durable-runner-state.mjs
runtime/js/cm-ai/host.mjs
runtime/js/cm-ai/operator-guidance.mjs
runtime/js/cm-ai/recovery-capabilities.mjs
runtime/js/cm-ai/task-runner.mjs
scripts/cm-ai-drive.mjs
scripts/cm-ai-host.mjs
scripts/cm-ai-run.mjs
```

安装 manifest 的缓存后缀也是第 13 个未见于可达历史的精确 blob，但应保留源码 `0.17.1`，不将安装时间戳后缀写回源码。所有安装文件的 SHA-256 见 [安装清单](installed-manifest.tsv)。没有把安装目录整体复制成一个无来源的大提交。

### 保留主分支与排除快照额外功能

`a401be7`、`9fceacb` 和此前提交始终是候选的基线。62 个主分支独有文件全部保留，包括 `.github/workflows/ci.yml`、`.claude/rules/`、忽略及安全基线和 `experiments/js-orchestration/`。其中宿主清单历史测试按 `12b7ce9` 扩充；`.claude/CLAUDE.md` 同步实际引入能力，保留主分支已有约束。

`a401be7` 的 77 个改动路径中，66 个候选文件与该提交精确一致；其余 11 个是在此基础上的安装功能或规模闸门增量。`9fceacb` 新增的 cm-challenge 入口、Skill、eval 与测试保留。安装副本没有的快照专属 `unreviewed-batch.mjs`、`learning-deferral.mjs`、未审续行文档/夹具和后续 `ac265bc`、`8a8235d` 均未纳入。

## 冲突与解决

前九个真实历史 patch 及 `0599bff` 均无冲突。`69bc28d` 相对父提交 `0599bff` 三方合并时有四处冲突：

| 文件 | 解决 |
| --- | --- |
| `continuation-preflight.mjs` | 增加规模策略 import；不带 `unreviewed-batch` import |
| `task-runner.mjs` | 增加规模策略 import；不带批次续行/本地重跑 import |
| `host-conversation-execution.mjs` | 增加 `reviewScopeLimits`；不带父版本的 `localValidationSandbox` |
| `scripts/cm-ai-run.mjs` | whitelist 增加 `reviewScopeLimits`；不带父版本的 `localValidationCheck/localValidationSandbox` |

其他 hunk 三方合并成功。规模闸门四项指标和已有审查恢复豁免沿用 `69bc28d`。

## 验证范围与环境

Node.js 24.14.0，Python 3.9.6，macOS 当前受限宿主。JavaScript 每文件单独 `node --test --test-reporter=tap`，并发 4，每文件最多 300 秒。每个文件使用独立临时 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、CM_WORKFLOW_HOME 和日志目录。PATH 防护拒绝真实模型调用；只允许原生 Codex sandbox/版本/帮助命令。测试自行提供的假 provider 不受此防护影响。

按 `scripts/ci-test-weights.json` 预先排除超过 300 秒的四个文件：

| 文件 | 仓库记录秒数 |
| --- | ---: |
| `cm-ai-batch-drive.test.mjs` | 441 |
| `cm-ai-batch-run-member-stops.test.mjs` | 377 |
| `cm-ai-batch-run-parallel.test.mjs` | 338 |
| `cm-ai-batch-run-reschedule.test.mjs` | 436 |

实际到达 300 秒的文件也记录为超时排除，不冒充通过。逐文件清单及历史组范围见 [排除清单](excluded-tests.tsv)。没有运行真实模型 dogfood、release-smoke 或安装验收；历史兼容 experiments 不作为本次快速测试集。

四个指定文件：35/35 通过、0 失败、0 跳过：重连审查 6、重连开发 9、规模闸门 9、输入准入 11。

已定位的安装版既有失败还包括：`cm-ai-operator-guidance` 的 `develop_package_too_large` 提示不匹配；`cm-controlled-correction` 仍正确拒绝 blocked r1，但新增原生 owner 校验的拒绝文案不匹配旧断言（主分支 32/32，候选/安装均 31/32）。`cm-claude-install-layout` 候选命中上述两项机械检查误报，布局断言尚未执行；主分支/安装基线该夹具单次通过，保留不稳定对照，不称为布局功能已通过。

当前快速集已结束：307 文件中 258 通过、41 失败、8 个文件到达 300 秒而排除；另有指定四文件全过。完结测试文件的 TAP 汇总为 2839 通过、215 失败、7 跳过（不含超时文件未完结的局部结果）。基线对照共 82 条记录：39 个失败文件可匹配到主分支或安装版同名失败；1 个安装夹具命中既有 SIGPIPE 波动；1 个批次宿主的两份基线都超时，无法完整归因。没有证据足够的新回归结论，也不能宣称全部无回归。

其余最终结果与失败对照见 [测试记录](test-results.tsv)（本轮结束时生成）。基线取 `git archive origin/main`，没有创建或修改另一个工作副本/分支。比较失败用例名时，仅将候选/归档基线的已知源码根目录映射为同一个 `<SOURCE_ROOT>`；不改断言、返回码、失败数或原始日志。原始日志位于本工作副本 `.omx/logs/consolidate-installed/`。

仓库命令逐项结果见 [检查清单](repository-checks.tsv)。最终机械一致性、公开包与安全检查均退出 0。此前机械检查两项 PRD 报错在 origin/main 同样复现，失败证据保留。规则正文实际都在；单独检查 Bash 管道状态为 `141 0`，`grep -q` 提前退出导致 `printf` SIGPIPE。保留失败，不修改检查或降低标准。loopback HTTP 夹具的监听被环境拒绝时，记录原始 PermissionError，不把环境限制当成通过。

复合 `test-shell-compat.sh` 已启动，但未取得完整退出状态；它没有计入通过结果。原工具会话仍未结束，非 TTY 的 Ctrl-C 输入没有终止该调用。其他 Python 夹具各自日志已经保存，其成功行不等于整批 Shell 检查完成。

## 与安装副本的剩余差异

完整逐文件原因和双方 SHA-256 见 [剩余差异](remaining-differences.tsv)。相同文件不列出。安装树的 892 个文件全部保留，881 个与安装副本逐字节相同；其余 11 个是源码 manifest 和规模闸门的 10 个既有文件修改。运行时只留下规模闸门修改及新增策略模块；三份手工部署重连文件与 `0599bff` 精确一致。源码 manifest 保留 `0.17.1`；源码独有规则/CI/兼容夹具和本次报告不要求安装树存在。

实际 `diff -rq` 输出保存在 `.omx/logs/consolidate-installed/final-diff-rq.txt`；仅排除 Git 元数据和本次本地证据 `.omx`。最终文件校验亦核对安装树相对首次清单没有变化。

## 交接

候选源码的逐文件模式与摘要见 [候选清单](candidate-manifest.tsv)，内容绑定摘要见 [源码摘要](source-content-sha256.txt)。该摘要只排除本目录的报告文件，不能代替 Git 提交。

待完成：在允许当前工作副本写 Git 元数据的环境中，按上述来源链建立提交；然后由用户安排 Claude 审查。完整候选源码（不含本报告目录）另保存在 `.omx/logs/consolidate-installed/candidate-source.tar.gz`，共 959 文件；归档 SHA-256 与源码摘要见同目录 `candidate-archive.json`。

当前 HEAD 仍为 `a401be7`，不应将该哈希称为已包含整合内容的提交。测试通过不代替独立 Review，任何环境受阻项均保留证据缺口。

已复盘，无新增项目教训：本轮为既有行为整合；安装目录并非完整源码树，快照也不等于当前安装版本。这些来源差异记录在本交接，未额外修改项目规则来扩大权限或跳过审查。
