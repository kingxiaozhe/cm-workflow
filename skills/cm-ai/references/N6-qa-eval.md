# N6: QA 评估

JS 按固定检查点和项目登记路径决定是否触发 `cm-qa-engineer`。会话不判断风险类别。

QA 开始前解析 `tester` 角色并记录 `decision`/`phase: route`；浏览器走查另外解析
`browser_qa`。路由元数据只说明请求的工具/模型别名，正式命令、逻辑核验和浏览器
证据仍必须由本地 QA 合同实际产生。

同时读取有效配置的 workflow profile 与 `policies.tests`：`java-backend` 优先
commands/logic 及 API、数据库回归；`web-frontend` 优先 commands/browser；
`cm-default` 按 logic→commands→browser。`policies.tests` 只关闭未被规格要求的可选
类型；`test-cases.json` 中 blocking case 即使类型未列出也必须执行，环境不可用则
`BLOCKED`，不得把配置当作跳过已审批验收的许可。

taskIds 全部是 `[DROPPED]` 任务的用例（blocking 与否）不适用：不执行、不派发宿主请求、不计数，记入 `dropped_task_cases` 与报告 `not_applicable`（`NOT_APPLICABLE`）。feature 未完成时，只执行 taskIds 全部已完成且未 dropped 的用例，其余记入 `deferred_cases`，延后到 feature 收尾；延后用例不计入执行数量，也不派发宿主请求。feature 中途无可执行项时产生一条显式 `BLOCKED` 行，id 为 `no-applicable-cases`，不得以零测试宣称通过。

最新已 complete 的 QA 若为纯宿主/环境证据 BLOCKED、failed=0 且 qaRound<3，可按 [JS 宿主 QA 恢复](js-host-qa-recovery.md#已-complete-的宿主证据或环境阻断) 显式 `--rerun-blocked-qa --allow-qa` 恢复，以 superseded 关联下一轮全量重跑；产品 FAIL、commands 阻断与未 complete 不适用，完成后同步 N6 状态镜像。

## 固定必跑点

命中任一规则即 `triggered`，`score: null`。reason 按下表顺序用逗号连接所有命中的规则名。

| 规则名 | 机械判定 |
| --- | --- |
| `feature_complete` | 本 feature 最后一个任务完成；沿用原任务清单计算 |
| `migration` | 实际改动文件命中登记的 migration 路径 |
| `authentication` | 实际改动文件命中登记的 authentication 路径 |
| `authorization` | 实际改动文件命中登记的 authorization 路径 |
| `payment` | 实际改动文件命中登记的 payment 路径 |
| `five_tasks_without_qa` | 沿用原任务与 QA 日志计算连续五项未 QA；缺少历史行只计尚未完成 feature 的已完成任务，既有 skipped 计数语义不变 |
| `api` | 实际改动文件命中登记的 api 路径；本 feature 恰剩一个任务且 `mergeEligible` 为 true 时豁免此项，其他必跑点仍生效 |

未登记关键路径的项目，N6 不做任何风险识别，只有这两个固定点。
这两个固定点是 `feature_complete` 和 `five_tasks_without_qa`。路径登记只说明需要检查的范围，不证明文件具有某种业务含义。

## 项目登记与清单来源

使用现有 `--workflow-config` JSON 的 `qa.criticalPaths`。批次使用原 `workflows["feature/task"].qa.criticalPaths`；同一项目的任务应使用同一份登记。不新建配置文件。

```json
{
  "migration": ["db/migrations/**"],
  "authentication": ["src/login.mjs"],
  "authorization": ["src/access/*.mjs"],
  "payment": ["src/payments/**"],
  "api": ["src/api/**"]
}
```

上例是 `qa.criticalPaths` 的值。类别可省略，各类别是最多 256 个无重复模式的数组；空对象或缺字段表示未登记。
模式相对代码根，使用 `/`。精确路径匹配整个文件名；`*` 匹配一个路径段内任意字符，`?` 匹配一个字符，完整路径段 `**` 匹配零个或多个段。
不接受绝对路径、`.`/`..`、反斜线、空段、字符组、花括号或扩展 glob。多代码根使用宿主的共同 `codeProject` 根作为路径基准，登记应带对应子目录。
登记随现有工作流配置纳入指纹；恢复沿用原登记，配置修订沿用原 QA 恢复合同。已记录的 QA 决策不因登记变化重算。

正式 runner 从编辑前基线与实际内容产生的审查包 `changes` 读取清单，包含新增、删除和文件模式变化；不用作者自报的 handoff `changed_files` 代替它。
日志的 `changed_files_source` 单独标注来源：`review_package` 为上述清单，`handoff_only` 为可信适配器仅有 handoff 的兼容输入，`unavailable` 为旧适配器未提供清单。
有登记但清单 unavailable 时保留 `qa_policy_unavailable`，不能把缺失清单当作无命中。本轮不重建兼容路径的编辑前基线。
宿主 `qa_assess` 请求列出清单、来源、登记及机械计数，会话只回 `{"confirmed":true}` 确认已看到这些输入，不能提交类别、跳过理由或修改清单。

## 跳过与留痕

| 条件 | status / score / reason |
| --- | --- |
| 无任何必跑点命中 | `skipped` / `null` / `no_fixed_trigger` |
| 仅 api 命中，且满足收尾合并豁免 | `skipped` / `null` / `merged_to_feature_qa`；沿用 `decision/qa_merge` 和 QA 行 |

本版本不输出 `docs_only` 或类型定义专属理由；会话自报不能证明这类条件。
每个任务均写 `qa` 事件，detail 为 `触发:{reason}` / `跳过:{reason}` / `阻塞:{reason}`，不可静默跳过。
并行成员（2 人及以上同组开发）沿用原 `parallel_member_deferred` 延后合同，新行同样为 `score: null`；合并后末任务触发 feature QA。
单独在 worktree 开发的 1 人组成员不适用该延后，按上表固定必跑点判定，触发时在其 worktree 执行，通过后才合并。
旧整数行继续按原 4–20 范围与状态约束读取；旧日志和旧 METRICS 不改写，已绑定决策不重新裁决。三种 status 的新行均可使用 null，不新增运行协议号。

## 触发格式

```text
🧪 触发 QA — 原因: {命中的规则名}
   累积变更: {N} 个 task
```

QA 通过 → 继续。发现问题时，**不得在 N6 直接修改**已由 N4 绑定并在 N5 提交的
代码或测试；先保存失败报告，再按有效配置的 `policies.auto_fix` 走唯一分支：

- auto_fix: `never` → 写 `BLOCKED` 并报告，不修改。
- auto_fix: `explicit` → 展示缺陷摘要，取得本次修复授权后调用 `$cm-fix`。
- auto_fix: `auto` → 直接调用 `$cm-fix`，不额外停车。

`$cm-fix` 必须生成自己的结构化 handoff、通过独立审查门禁并按 delivery 策略落盘；
QA 新增或修正测试也属于该 fix diff，不能在旁路写入。修复闭环后重新 QA，总计最多
3 轮；仍失败则 `BLOCKED`。这样原 task 的审批 SHA 不被事后覆盖，QA 修复拥有独立
审查、提交与日志证据。

实际触发 QA 时按 `../../../runtime/logging.md` 写 `test_run/start` 与
`test_run/complete`，记录模式、用例/通过/失败/阻塞数量、结论和报告路径；start 与固定执行报告另列 `deferred_cases`（id 与未完成 taskIds）；
测试输出、截图和浏览器日志仍留在 `.reviews/`。

feature 存在 `test-cases.json` 时按 `runtime/test-contract.md` 消费：中途 QA 的命令按
选中 logic 用例映射，无用例映射的独立命令沿用配置策略；browser cases 由
`cm-qa-engineer` 逐条模拟并保存截图/日志；
N4 中的 `INSUFFICIENT_EVIDENCE` 必须在本节点补运行时证据或保持 `BLOCKED`。
任一 blocking case 为 `FAIL`/`BLOCKED` 时不得宣称 QA 通过。

交付形态为微信小程序时读取
`../../cm-miniprogram-engineer/references/release-checklist.md`，按 feature 实际能力补
开发者工具模拟器与真机专项。Web/H5 截图不计小程序证据；授权、设备差异或平台 API
缺真机证据时保持 `BLOCKED`/待人工，不能用静态核验或模拟器推断通过。

**QA 新补的测试须变异自证**(机械,非审查轮):种 1-2 处行为变异必须变红,不红的测试修到红再入库——QA 测试是未来所有回归的安全网,安慰剂 QA 测试 = 永久性假安心(实跑先例:dogfood 中 QA agent 自发做过「5 个变异全被抓」,本条把自觉变成规则)。

触发 QA 后，回填 METRICS.md 中对应任务行的 QA 列：`通过(覆盖率{x}%)` / `{N}轮通过(覆盖率{x}%)` / `失败上报`——覆盖率随列落盘，不留在会话里。

## 形态确认卡点（仅 0.bootstrap 完成时，一次性）

`0.bootstrap` 完成触发的 QA 中，**必须**执行形态确认：启动 dev server / 模拟器 / 开发者工具，截取首屏发给用户——

```text
📸 形态确认：这是项目当前的形态（{Web 页面 / App 模拟器 / 小程序}），与你要的交付形态一致吗？
```

**截图来源按 CLAUDE.md 交付形态写死**（防"替代形态截图糊弄卡点"）：

- Web → 浏览器访问 dev server
- **App → iOS/Android 模拟器或 Expo Go 真机截图；react-native-web / `expo start --web` 的浏览器截图不作数**——浏览器里渲染出"长得像 App 的网页"恰恰是本卡点要拦的形态错配
- 小程序 → 微信开发者工具模拟器

模拟器环境不可用 → 如实上报，请用户在本机/真机启动确认；**不得用替代形态的截图过卡点**。

**用户确认后才进入业务 feature**。成本是一张截图 + 3 秒确认；收益是架构错配的发现时点从"任务过半"提前到"零行业务代码"（历史事故：要 App 画成了 HTML，跑到一半才发现）。

## 业务验收走查（feature 完成时）

触发原因为「当前 feature 所有 task 完成」且 QA 通过后，调用 `cm-product-manager` skill 做**业务验收走查**（用户视角流程闭环 + AC 逐条对照，非技术测试）：

- 小偏差 → 记录进走查报告，继续
- 涉及需求本意的偏差 → 暂停问人，不自行认定"也可以"

金融/营销类 feature 的走查协同 `cm-finance-expert` 追加金融视角（数字口径抽查 + 营销红线扫描）；**涉合规的偏差一律上报，不适用"小偏差放行"**。
