# 更新日志

按版本记录用户可感知的新增、优化与修复；最新内容放在最前面。
尚未进入发版候选的改动放在「未发布」；版本条目记录该版本的交付内容，npm 发布状态以注册表为准。

## 未发布

**走查配置和诊断对不上，要等独立审查做完才发现**

- 走查声明的模块必须和诊断结论一一对上，这条规矩一直有，但只在走查那一步才查——而走查在独立审查之后。配错了的一轮，要先把复现、编写测试、修复、回归、外部审查全跑完，才在最后一步被拦下，整轮白跑。实测踩过一次。
- 判定抽成独立函数，诊断一落盘就问一次，对不上当场停在 `walkthrough_configuration_mismatch`。
- 只在「刚诊断完、还没往下走」时改阶段：已经跑过头的存量记录保持原样。这个判断放在记录回放**之后**——回放循环会拿当前阶段去校验下一条记录，插在循环里会让存量记录直接打不开（实现过程中真踩了一次，靠存量运行验出来的）。

**任务编号重名要等跑到红灯测试才炸，而且那一轮直接报废**

- 证据文件名由任务 slug 和轮次拼出来，跟 runId 无关，所以两次运行用同一个 taskId 就会写同一批文件。这个冲突原本要等红灯测试去发布输出时才撞上 `review_file_conflict`——那时 intent 已经登记，运行留在 `unknown` 且不可重派，等于前面复现、诊断、编写测试全部白跑。实测踩过一次。
- 名字在建运行时就全都算得出来。现在 `--mode create` 会先检查这批名字有没有被占，占了就报 `fix_evidence_name_taken`，发生在任何记录落盘之前。只列这次配置真的会写的文件，不拦根本不会发生的冲突；只在 create 时检查，恢复已有运行不受影响。

**出了错查不出是哪一步拦的**

- runtime 里有 1032 种不同的失败码（光 cm-fix 就 204 种），但同一个码常常在好几处抛出——`fix_closeout_unavailable` 就有四处——而对端只看得到一句笼统的 `host_request_failed`。真实的码虽然写到了 stderr，却不说位置。实测代价：为了定位一次收尾失败，只能把整个宿主脚本复制一份、自己包一层打印调用栈才找到，普通使用者做不到这个。
- 现在 `need()` 在造错误时就把现场记成一个普通字段，诊断行多出 `origin`，例如 `{"diagnostic":"host_request_failed","operation":"finish","code":"fix_finish_authorization_required","origin":"cm-fix/execution.mjs:1003"}`。
- 两条边界没动：位置按 runtime 根取相对路径，不会带出绝对路径和用户名；只报这套 runtime 里的帧，不报调用方文件，更不会输出 `error.message`。读取方式也仍然是「只看自有数据属性」——`stack` 是访问器属性，只在 `need` 内部对刚造出来的原生 Error 上读，绝不去碰外来对象的访问器。
- 协议回复、日志、运行状态、任何摘要都逐字节不变：`origin` 只走 stderr。

**CI 只跑了 118 份自动检查里的 15 份**

- 其余 103 份从来没在 CI 跑过，包括 cm-fix 的整个持久化核心。本轮修的四个缺陷，本地跑全套都能暴露，CI 一个都发现不了。根因是那份逐个点名的清单：新写的检查不会自动进去，攒着攒着就成了这样。
- 改成通配符跑全部，清单不会再漂。Node 从 22 提到 24.14——JS 流程本来就要求 24.14+，跑 22 属于测一个没人声明支持的配置，核心那批还会被平台闸门当场挡掉。
- 有 7 份进不了 CI：它们要启动 Codex 沙箱，而沙箱在 Linux 上靠 bubblewrap 建网络隔离，GitHub 托管机器不给这个权限（`bwrap: loopback: Failed RTM_NEWADDR`），跟登录无关、装上 codex 也没用。这 7 份改由 `cm-release-smoke.sh` 在发版时覆盖——那个脚本本来就要求本机装了 codex 和 byz。于是**每个 PR 覆盖 111 份，每次发版覆盖满 118 份**，没有看不见的缺口。
- CI 里加了一句断言：排除名单必须正好是这 7 份。想往里加东西就得改那句，改动会出现在评审里。
- 上线前用一条一次性流水线在 Linux + Node 24.14 上实跑了 4 次，111 份每次全绿、耗时稳定在 4 分上下，确认不是把随机红灯搬进 CI。

**改过 METRICS 列名之后，所有存量表都被硬拒且没有迁移路径**

- `N4-review.md` 把这次改名写成「保持原列顺序，将原『Codex拦截』语义升级为『独立审查拦截』」——同一列换个名字。但代码是整行精确匹配表头，于是任何改名前就存在的 `METRICS.md` 都过不去：cm-fix 收尾报 `metrics_table_invalid`，cm-refactor 报 `refactor_metrics_format`，两条收尾路径一起停，且没有任何升级办法。
- 现在两处共用同一份表头定义，认得出这张表用过的所有列名。新文件仍写当前列名，**绝不改写用户文件里已有的表头**；真正不是这张表的文件照旧拒绝。
- 真实项目上验证：一张 `Codex拦截` 的旧表，收尾成功追加新行、表头原样保留、运行走到 completed。

## 0.16.1 — 2026-09-21

**cm-fix 收尾只认 delivery:diff，把 cm-init 自己生成的默认配置锁在门外**

- `finish` 原本硬要求 `policies.delivery === 'diff'`，否则 `fix_delivery_authorization_required`。而 `cm-init` 给任何带 remote 的仓库生成的就是 `draft-mr`，于是这类项目的 JS 运行**永远走不到收尾**，档案、METRICS、`task_done` 一样都写不成。这条限制原本写在 `js-host.md` 里，但它和同一套体系的其它约定互相矛盾：`runtime/logging.md` 把 Git 交付定义成独立的 `delivery` 事件（`commit`/`push`/`pull_request`），cm-ai 在任何交付模式下都照常完成任务，cm-fix 自己的 SKILL 第 7 步也明写 branch/draft-mr 怎么提交。
- 更要命的是它无法绕开：`findConfig` 只读项目根，而项目根在业务快照范围内，所以临时把 delivery 改成 `diff` 这个动作本身就改了快照，阶段立刻从 `closeout_required` 掉成 `learning_writeback_evidence_required`，收尾照样过不去；改回来又变回 `draft-mr`。两头堵，唯一出路是重跑整轮。
- 现在 finish 接受任一合法取值，只要求它在写完成记录期间**不变**（`fix_delivery_changed`）。写的还是档案/METRICS/`task_done`，**依然不执行 Git**：branch/draft-mr 的提交、推送、开 MR 仍由执行者单独完成并记 `delivery` 事件。

**受保护模式跑不了任何需要本地 IPC 的测试命令（无代码修复，只补文档）**

- 受保护模式的沙箱 `network={enabled=false}`，而这个开关同时管着 unix domain socket 的 `listen`。于是 `tsx` CLI（启动时在 TMPDIR 建 `<pid>.pipe`）、`vitest` 之类一律 `Error: listen EPERM`；写 TMPDIR 文件本身不受影响。实测确认过两者的差别。
- **没有安全的代码修法**：放开它就等于给所有受保护测试命令放开整个外网，那是比问题本身更大的倒退。`js-host.md` 改为写清这条约束、症状、以及可用的替代写法（把 `npm test` 串联的 `tsx xxx.test.ts` 换成逐文件 `node --import .../tsx/dist/loader.mjs <file>`，覆盖面不变），并说明沙箱内失败为什么只留 `host check exited N`（原始输出有意不进证据）以及怎么手工重放看真实原因。

**cm-fix 两处让修复跑不下去的阻断**

- **换一个会话就再也打不开自己的运行**。`--mode resume` 一直存在，但 durable 配置里存着创建这次运行的会话 ID，指纹又是整份配置的摘要，于是新会话换上自己的 `--host-context` 必然 `fingerprint_mismatch`，而沿用旧 ID 又正是文档禁止的冒用旧会话——两条路都堵死，跨会话恢复实际上从来没能用过。现在把「这次运行绑定的宿主」和「此刻在跑的会话」分开：durable 配置与旧记录一字不改，恢复时用 `--original-host-context` 报上原会话，`--host-context` 仍是当前真实会话。两个身份都算宿主，授权凭据两者皆可、重放旧凭据不受影响，reviewer 必须同时独立于两者；改动 durable 宿主仍然 `fingerprint_mismatch` 关闭。
- **iOS 项目连基线快照都拍不成**。CocoaPods 装出来的 `ios/Pods/` 是几千个头文件软链接，而快照对软链接一律 `unsupported_file` 失败关闭，于是任何做过 `pod install` 的仓库在编写测试这一步直接阻断（实测 6179 个软链接）。现在把它按 `node_modules` 那样当依赖目录跳过，但**光看名字不算**：目录名要是 `pods`，里面要有 `Manifest.lock` 和 `Pods.xcodeproj`，旁边还要有 `Podfile.lock`，四样齐全才认。业务代码里自己写的 `pods/` 目录照常入快照、其中的软链接照常拒绝。软链接保护一行未放宽，Pods 内的文件也不能选进 scope 或 requirements。

  判定本身就是安全边界——被它认下的目录会**无声**离开评审视野，所以遍历侧和 scope 守卫必须问同一个函数。初版这两处口径不一致：遍历侧不看名字、只探测生成物，于是在任意目录（例如 `src/`）放一个空 `Manifest.lock` 加一个空 `Pods.xcodeproj/`，整棵目录连同**已声明进 scope 的文件**一起被静默跳过，且不报任何错。现已统一为同一个判定，并补了三条回归测试钉住「两处必须一致」。

## 0.16.0 — 2026-09-20

一次真实实跑把 cm-ai 从「跑不完」推到「跑得完」，本版是那趟跑出来的修复与新增。

**不修就跑不下去的三处**

- **交接文件撞名不再让任务永久卡死**。交接文件 `{feature}-{任务}-a{轮次}-handoff.json` 以不覆盖方式发布，于是一个在审查前就死掉的运行留下的文件，会让同一任务此后**每一次**重跑都崩在 `linkSync` 上，且异常被塌缩成 `execution_error`，既不知道原因也没有恢复路径。实跑中同一任务连续 5 个批次全挂于此，换批次号无效。现按「这份旧交接有没有被审查用过」分流：字节相同视为已发布；无回执指名则归档到 `.reviews/.superseded/` 让路；有回执指名则绝不覆盖，返回 `handoff_exists`。判据只认回执 front matter 内的 `handoff:` 行，按 front matter 边界解析而非固定行数，读取侧不依赖写入侧字段顺序；读不懂一律按「已消费」失败关闭，绝不因解析不了就去动审查证据。
- **独立审查超时可单独配置**。审查进程超时此前写死 60 秒，唯一能调大它的入口是受保护模式，而那个模式又禁止开发者跑命令——两者互斥，等于没有出路。实测三次真实审查耗时 69 / 104 / 174 秒，在此前的实现下全都会被掐断、重试一次仍超时、任务直接判死。`--review-config` 新增可选 `timeoutMs`（1–3600000 毫秒，默认仍 60000），与受保护模式解耦，且不进入已授权配置的摘要，所以 `review_transport_timeout` 之后可以在恢复时调大再续跑。
- **QA 单用例应答窗口可调，批次也能只重跑被阻断的 QA**。`qa.timeoutMs` 上限此前写死 60000，而一轮真实浏览器走查按分钟计，必然超时判 BLOCKED 拖垮整轮；上限提到 3600000，默认不变。批次宿主补上 `--rerun-unknown-qa` / `--rerun-blocked-qa`，此前批次里一条用例超时之后唯一补救是重做整个任务、连已 approved 的审查也要重跑，而任务已被勾完成又过不了准入，等于没有补救路径。

**新增：交付前验证闸门（可选 `--verification-precheck`）**

- 实测一个 feature 的耗时里末任务占 79%、返工率 80%（其他任务 4%），而打回理由**全部**是「证据没满足任务书里早就写明的验证要求」，没有一条是代码缺陷。启用后，宿主在收齐任务自身检查之后、**构建审查包与派发独立审查之前**，把该任务的验证要求原文与检查结果交给对端逐条核对；任一条不满足即停在 `blocked / verification_precheck_failed`，`pendingAction` 为 `resume`，走与 `developer_result_invalid` 相同的重做通道，**不消耗审查轮次**。
- **只能拦，不能放**：通过闸门不产生审查回执、不授予批准、不替代后续的完整独立审查，定位与 `prd_self_check` 一致。任务没写验证要求时自动让路。不启用该开关时流程逐字节不变。
- 一条如实说明的限制：验证要求在 `tasks.md` 里是自由文本，**JS 无法机械证明对端把每一条都枚举到了**。机械强制的只有回答形状、每条必须给出非空证据落点、全部满足才放行。形状合规不等于语义覆盖。

**故障可诊断**

- 失败码不在白名单内时会塌缩成 `execution_error`，此前原始错误既不进日志也不进 stderr 也不进状态。上面那个 EEXIST 当初是临时加打印才看到的，普通使用者做不到。现在塌缩的同时往宿主 stderr 输出一行结构化诊断，只含 `code`/`syscall`/`path`/`dest` 具名字段，**绝不输出 `error.message`**。宿主请求被遮蔽成 `host_request_failed` 时同样如此，并带上是哪个 `operation`。现有脱敏边界一行未动：协议回复逐字节不变，诊断只走 stderr，不进日志镜像、不进运行状态、不进任何摘要或 digest。

**规则与文档**

- cm-ai N3 要求交付前把任务的 `verification` 当清单逐条核对，写清每一项的证据落点，对不上就报阻塞而不是交付。
- 文档补齐：批次启动与推进的四项前置条件；cm-prd 宿主的调用契约与 split 章节标题要求（五处坑连同「字段集严格、多给字段同样被拒」这一共同根源）；`pendingAction: reconcile` 出现时该做什么（含两个来源、各自的恢复路径，以及三种不管用的做法）。

## 0.15.5 — 2026-09-20

- **安装时按实际状态询问是否开启更新播报**。安装器结尾此前无条件打印「自动更新器未自动启用」：对已启用的人这句是错的（实测 hook 已配、后台更新器也在跑，仍这么说），对未启用的人它读着像普通说明而不像少配了一步——两边都没起作用，这才是装了包的人收不到新版提示的真实原因，不是缺功能。现改为检测后再说话：已配好则确认一句；未配好且交互安装则询问一次，答 y 才写入；`--yes` 与非交互安装不写任何东西，改为打印确切的 hook 条目；此前拒绝过则不再打扰（记在 `~/.cm-workflow/announce-hook-declined`，删掉该文件并重装即可重新被问）。
- 只添加播报 hook，**绝不添加后台升级器**——告知有新版与让工具自我替换是两个决定。`settings.json` 属于用户：无法解析时原文件逐字节不动、写入走临时文件加原子改名、已存在则不重复添加。安装器此前从不碰该文件，本次开的口子范围写死，只加这一条 hook 且只在明确同意时。
- 注意：只开播报而不开后台升级器时没有东西会产生播报内容（`cm-announce.sh` 只消费 `cm-update.sh` 留下的文件），两者需一起开启才有效果，详见 `docs/installation.md`。

## 0.15.4 — 2026-09-20

- **`cm-check --quick`：约 12 秒收口的快速检查**。完整检查耗时拆分为查更新 0.7 秒、机械检查 12.4 秒，其余几乎全在八组语义检查上——那不是程序在跑，而是执行者逐个文件读取并取证行号，且控制器强制八组齐全、passed 必须附真实行号，慢是设计换来的。日常「装没装对、版本对不对」这类问题机械检查已能回答，`--quick` 让更新与机械检查照常跑、机械通过后直接收口，不进语义检查。结论为 `MECHANICAL_ONLY` 而**不是 PASSED**：八组一组没读，不得据此宣称安装完整无断链；结果带 `semanticChecked:false` 与 `reason:quick_mode_semantic_not_run`。机械失败仍照常报 FAILED/BLOCKED，快速模式不跳过任何失败。默认不带该参数时行为不变。

## 0.15.3 — 2026-09-20

- **cm-check 在 Claude 安装上可以拿到 PASSED**：第 1 组查 `.codex-plugin/plugin.json`、第 7 组查根 `VERSION` 与根 `README.md`，三者都是 Codex 插件模式的产物，claude-compat 安装本就不该有（`install.sh` 只写 `templates/cm-VERSION`）。此前这两组只能判 blocked，健康的 Claude 安装永远停在 BLOCKED。现按安装模式分流：控制器推出 `installMode` 并下发给语义检查，语义结果新增 `not_applicable` 状态，仅第 1、7 组可用且必须写明缺的是哪个产物、为何本模式不该有；汇总时它既不算失败也不算阻塞。本模式确实拥有的产物证据不足仍记 blocked，不得借它放行。
- **修复 cm-check 报告的版本号在 Claude 安装上恒为 null**：结果中的 `version` 此前固定读根 `VERSION`，而 claude-compat 安装没有该文件。现按模式读取，claude-compat 读 `templates/cm-VERSION`。报告另附 `installMode`。

## 0.15.2 — 2026-09-19

- **同 feature 并行开发现在可用**：`parallel` 字段此前只存在于代码，没有任何文档或 Skill 提过它，而执行规则要求「不发明字段」，功能因此从入口够不着。现补齐 `docs/js-workflow-control.md` 的「并行组」一节（字段形状、五条约束与失败码、工作树与分支命名、串行合并、QA 延后、review 前置），并在 `cm-ai` N1 增加提议规则：只对 scope 全为新建文件、互不重叠、无依赖路径的同 feature 任务成组，组不起来就串行，不为组而组。
- **并行提速的真实范围**：当前会话模式下成员的开发请求逐个应答，重叠的是 runner 推进与各自的独立审查进程，不是写代码本身。文档与规则均写明这一点，避免按成倍提速预期使用。
- **修复链式依赖被并发执行**：并行组的依赖校验此前只看直接边，`A → B → C` 时 `{A, C}` 会被放行并发开发。两者在各自工作树基于 `HEAD` 创建、看不到彼此产物，而组内 scope 本就不重叠，Git 也不会报冲突，错误不会暴露。改为按依赖图的传递闭包判定。
- **修复保留的 WIP 分支挡住后续批次**（**升级注意**）：成员被阻断时会有意保留分支作为证据，但分支名不含 `batchId`，那个名字被永久占住，同一任务的任何后续批次都在 `git worktree add -b` 处报 `batch_worktree_failed`，换 `batchId` 也绕不开，只能手工删分支。分支名改为 `cm/{batchId 前 8 字符}/{feature}/{taskId}`。**升级前创建、尚未收口的并行批次恢复时会报 `batch_worktree_mismatch`，请用旧版本收尾该批次**；`parallel` 此前无文档，预期不存在这类在途批次。
- **QA 环境补齐桌面与后端/CLI/库形态**：`kind`/`carrier` 此前只有 web/app/miniprogram，而 cm-prd 与用户确认的交付形态包含桌面与多端，并另行承认「纯本地工具、库等无部署形态的项目」。这些项目要开 QA 只能谎报 `web`+`browser`，而该字段会进 QA 执行配置并随每个用例请求下发。新增 `desktop`→`app-window`、`service`→`cli`/`http-api`、`library`→`none`。同一张取值表原本在四个模块里逐字重复，现抽为 `runtime/js/cm-ai/qa-environment.mjs` 单一来源，并修掉四份拷贝共有的隐患：`kind` 传 `__proto__` 时解析到 `Object.prototype` 而抛 TypeError，现用 `Object.hasOwn` 判否。
- **METRICS 增加「执行方式」列**：记录该任务是串行执行还是并行组成员（`并行:组内{N}个`），否则无法区分耗时变化来自并行还是任务本身。看板模板同步适配列位。
- **文档补两处契约坑**：`preflight --review-model` 必须是 CLI 实际写进请求体的完整模型 id，别名会以 `model_matches:false` 判失败而回执不给期望值；`check` 回复的 `result` 就是检查数组本身，不套 `{status,value}`，用错会以 `invalid_input` 停在 `reconcile` 且重试无效。

## 0.15.1 — 2026-09-19

- **cm-security 接入统一运行日志合同**：`cm-security` 此前从未引用 `runtime/logging.md`，cm-check 第 3 组「共用运行日志与统一 writer」因此判 failed。该断链自 0.12.0 引入安全扫描时就存在——同一个 commit 把 `cm-security` 写进了检查清单，却没给新建的 Skill 加上引用。现补齐引用，并明确落盘时机：范围与安全边界确认后写 `run_start`，`--finalize` 返回终态后写 `run_done`，只记录扫描范围、结论词、发现数量、覆盖率与报告路径；工具原始输出、密钥原文、源码片段与 findings 正文不进日志，`BLOCKED` 同样收尾。这是文本约定补齐，扫描逻辑与报告门禁未变，只读边界不变。无 specs 目录时仍按既有设计只写全局镜像。
- **版本标志按安装模式解析**：`cm-check-update.mjs` 此前只看根目录有没有 `VERSION` 文件就判定「这是源码仓库」。Claude 兼容安装的根目录就是 `~/.claude`，那里任何与 CM 无关的 `VERSION` 都会顶替 `templates/cm-VERSION` 成为当前版本；若其版本号更高，降级守卫会抛错并让整个 cm-check 返回 `blocked`。现改为优先读当前 runtime 自己的标志，仅在该标志缺失时（源码仓库与 tarball 没有 `templates/cm-VERSION`）才回退到根 `VERSION`，Codex 路径行为不变。同时对齐 `runtime/project-context.md` 的工作流根校验——`install.sh` 只写 `templates/cm-VERSION`，从不往安装目录写根 `VERSION`，原先要求根 `VERSION` 的规则在所有 claude-compat 安装上都无法满足。

## 0.15.0 — 2026-09-19

- 浏览器验收能力改为启动时断言：开启 QA，且规格含阻塞 browser 用例或被 `policies.tests` 选中的 browser 用例时，`cm-ai-host` 与 `cm-ai-batch-host` 必须显式给 `--browser-qa available|unavailable`；因任务未完成而延后的适用用例也计入。`unavailable` 以 `browser_capability_unavailable` 拒绝启动，错误 JSON 仍只输出 code；使用者需换到具备浏览器能力的会话，或调整验收范围并重新审批规格。不命中时给该参数报 `invalid_arguments`。这是**声明不是探测**，声明不持久化，创建与恢复均须重新声明。
- **配置兼容性变更**：共享配置加载器现在要求 `policies.tests` 含 `browser` 时，`roles.browser_qa.adapter` 必须为 `browser`。此前可用的显式 `browser_qa: {adapter: local, model: none, source: local}` 配合默认测试策略（包含 browser），升级后会被拒绝，影响所有使用共享配置加载器的入口。需要浏览器 QA 的使用者应将适配器改为 `browser`（保留 `model: none, source: local`），或删除该角色覆盖以继承默认 browser 角色；不需要浏览器 QA 时，应将 `policies.tests` 显式设为如 `[logic, commands]`。省略整个 browser_qa 角色仍可继承默认值；移除策略中的 browser 不会排除阻塞 browser 用例，相关验收范围仍需明确处理。
- 统一 `.cm-specs-status` 读写：cm-prd 使用共享原子 writer；cm-ai 新增 `--approve --approval-response`，只放行指定准入原因，禁止 `--yes` 写审批位，写后重跑准入。审批沿用原 `summaryDigest`（缺失为 null），兼容读取旧文件并在下次写入去掉 `via` 等自由字段；cm-idea 明确保持在 specs 上游。

- `cm-security` 新增报告门禁 `--finalize --scan ... --review ...`：严格校验逐路径复核输入，机械补齐漏报、重验复核窗口漂移并保留扫描窗口证据，统一在项目外生成报告并给出四种结论之一。无发现且覆盖为 FULL 仍是 `REVIEWED_PARTIAL`，不存在「干净」的结论词；模型不能传入 `result`、`coverage` 或 `aiReview`。报告原样保留通过校验的分析结论与修复建议，stdout 只含摘要字段。
- 批次首次推进要求 Git 主工作区干净（含未跟踪文件）；否则以 `batch_main_dirty` 列出脏文件，在任务启动及创建工作树之前阻断。串行任务在 `start_next_task` 交接前自动提交，`batch_handoff.task_commit` 记录 SHA（无改动为 null）。并行组先合并 ready 成员，再保存终态成员 WIP、移除工作树并保留分支；通过 `batch_member_blocked` 日志恢复一次性的 generation 2 串行降级。
- 开发者结构化输出模式（Codex 两个 schema 与 Claude 提案 schema）新增可空 `reason`，`validateClaudeProposal` 同步放行该键：此前模式为 `additionalProperties:false` 且不含该键，CLI 派发下模型无法给出 blocked 原因，落盘功能在真实路径上等同未生效。`validateDeveloperValue` 将任意 outcome 下的 `reason: null` 归一为缺省，`implemented` 带非空 reason 仍按 `invalid_result` 拒绝。
- 开发结果 `blocked` 的可选 `reason` 以 `blockedReason` 持久化到开发调用记录：字符串 trim 后非空、至多 1000 UTF-8 字节，禁止 NUL 及除换行、制表符外的 C0 控制字符。终态仍为 `failed/result:null`，入口仍为 `blocked/failed`，重试与结果摘要语义不变；并行成员日志及 WIP 提交正文保留原因。旧日志无该字段照常回放；含新字段的日志会被旧运行时按未知键拒绝，不做版本协商。契约拆分明确告知调用方与实现方：抛错占位体是预期状态，不应等待或据此 blocked。
- 批次入口支持 `bundle.batch.parallel`：通过 `eligibleTasks` / 受信 `parallelSelection` 绑定并行准入与恢复，`parallelMember` 将成员 QA 延后到主分支串行末任务；成员工作树逐个执行审查预检并缓存，恢复时仅复用匹配凭证，预检失败则整组在 start 前阻断。新增 `--protected-config` 与逐任务 `--allow-provider-development` 授权，按成员工作树的项目声明派发 CLI 写码，并复用配置执行合并后检查。
- 执行存储锁改为运行级，不同 runId 可独立持锁；创建新运行时先探测旧布局锁，成功释放后继续，失败返回 `store_busy`，旧文件不迁移、不改写。
  恢复已有运行时，缺少本运行 `writer.sqlite` 返回 `store_layout_legacy`，须用旧版本收尾或退休该 runId；已有运行级锁则正常恢复。

## 0.14.0 — 2026-09-18

- 第 32 步：`cm-fix` 按描述未复现后先做最多 3 个场景或 15 分钟的单维度复现探索；档案新增复现尝试，JS 结果兼容旧记录并校验尝试结论，观测闭环要求至少一条尝试。
- 第 33 步：`cm-ai` 准入新增只读 `--print-run-definition` 直接生成运行定义（`--scope` 必填），`invalid_config` 点名多余/缺失字段、版本与文件类型，usage 与文档说明键集精确且参与摘要绑定。
- 第 34 步：受保护检查证据仅追加白名单测试计数摘要，同标签保留首次、最多 8 条、总长不超过 200 字符；不记录原始输出、凭证、路径或耗时，无计数及 unavailable 行为保持不变。

## 0.13.4 — 2026-09-18

- 第 29 步：`cm-init` 机械核验配置草稿的运行时五字段与所选预设一致，不符时阻断；从模板新建配置时按版本控制与 UI 模块事实裁剪 delivery/tests，并对不适用的默认策略给出非阻塞 warning，已有配置仍保留无关字段。
- 第 30 步：修复 `cm-ai` N6 中途 QA 提前执行未完成任务用例；延后用例写入日志与报告，命令按选中逻辑用例映射，显式恢复可用新 testRunId 绑定更新后的计划。`five_tasks_without_qa` 不再把已收尾 feature 缺失的 N6 历史行计为当前积压。第 30b 步：中途用例全部延后且无可调度命令时，以单条 `no-applicable-cases` BLOCKED 行显式报告空计划。
- 第 31 步：`cm-ai` 单任务 resume 新增 `--rerun-blocked-qa`，显式授权后仅将最新已完成的纯宿主/环境证据 BLOCKED 记为 superseded，并在最多三轮内全量重跑；保留原 QA 决策、开发/审查和任务状态，QA complete 同步 N6 状态镜像。

## 0.13.3 — 2026-09-17

- 第 28 步：`cm-runtime` 无参数在 TTY 中进入范围、工具/写码方、确认三问向导，复用安装器提问与既有 set/decision 日志，完成后显示有效配置；非 TTY 退出 2。安装器、向导与诊断共用系统语言中英文文案，机器字段不变；会话无参数按对话语言提问，文档与帮助同步。
- 测试隔离：7 个宿主测试文件把 `CM_WORKFLOW_HOME` / `CM_WORKFLOW_LOG_HOME` 指向进程专属临时目录，本机存在用户级 `runtimes.yml` 时不再有 6 个夹具误判为 declared-adapter。

## 0.13.2 — 2026-09-17

- 第 27 步：三种安装器交互声明单/双 AI 与谁写代码，原子保存用户级 `~/.cm-workflow/runtimes.yml`；非交互/yes 不写。配置按项目 > 用户 > 未声明解析并输出来源，cm-init 优先继承。新增独立 `cm-runtime show/set/set --user/unset --user` 与兼容别名，保留项目其他原文、复用诊断与决策日志，只影响新 run；同步检查、分发清单与文档。

## 0.13.1 — 2026-09-17

真项目 dogfood（`cm-init → cm-prd → cm-ai`，Codex 写码、Claude CLI 独立审查，首次跑到 `run_done`）暴露并修复的 11 处运行时缺陷，全部由真实事故触发：

- 修复 `cm-ai` N6 宿主请求可无限等待的问题：QA 请求按 workflow QA `timeoutMs`（默认 60 秒）独立超时并记 BLOCKED，迟到应答与旧发送失败不能污染下一请求；resume 可显式以 `--rerun-unknown-qa --allow-qa` 将无结果调用记为 abandoned，以新 testRunId 在原 qaRound 重跑，部分结果及清理欠账仍阻断。合成宿主确认同步应答本身正常；事故驱动的 JSONL 循环提前 return 会漏读同一数据块中的下一请求，宿主必须排空完整行。
- 第 26b 步放宽 `--rerun-unknown-qa`：无 complete、已记录结果全为 PASS 且无固定执行报告时可显式重跑，abandoned 新增 `partial_pass_cases`；全部用例仍重新执行，旧 PASS 仅作历史，FAIL/BLOCKED 与清理欠账继续阻断。

- 修复 `cm-ai` 已完成且原无 QA 的 run 无法补做强制 N6：resume 显式提供含 QA 的 `--workflow-config` 与 `--allow-qa` 后一次性追加不可变 `qa-attached` 和 `decision/qa_attach` 日志；保留原指纹及任务完成证据，绑定完整恢复配置，重复恢复去重，换配置或未完成附加拒绝。QA 仍走原宿主请求、执行、结果及收尾门禁，不重跑开发/审查。

- 修复 `cm-ai` 双根布局下开发进程与审查者看不到已批准任务及接口契约：开发请求和审查包新增绑定摘要的只读 `specification`（任务/验证要求、AC、设计摘录、相关用例、来源哈希）；复用审批 manifest，规格漂移以 `spec_drift` 阻断，设计超 64 KiB 标记截断。代码根 `requirements` 可选，旧包、journal 与 receipt 按原规则兼容，规格不进入可写 scope。补齐全量夹具的真实批准清单、运行时声明及模块复制依赖；旧 baseline 已记录的依赖文件保留完整内容与漂移检查，batch 开发/审查均验证规格传递。

- 修复 Claude 长审查被第 65 条 `thinking_tokens` 心跳误杀：审查上限放宽为 4096 条，保留 worker 总输出 1,000,000 字节及独立的 32 条通知限制；审查包新增绑定摘要的 `unchangedScope` 路径/哈希清单，允许其进入 examinedPaths 和 finding 路径但不要求改动，旧包与历史 receipt 按原规则验证。

- 修复 Claude 审查流将 `system/api_retry`、`hook_started`、`hook_response`、`commands_changed` 通知误判为失败：与 `rate_limit_event` 共用 32 条上限，经 `onNotice` 仅上报白名单摘要，不转发 hook/commands 正文或生成 observation；未知 system 子类型仍拒绝，重试后的失败结果仍按 `provider_failed` 处理。

- 修复 `cm-ai` 受保护当前会话审查误用 60 秒默认超时：Codex/Claude reviewer 共用配置的 `timeoutMs`；没有结果事件的审查传输超时可在同一 attempt 经新授权重派一次，第二次超时阻断。保留 observation/inspection，含结果的超时及旧 unknown 历史仍须 reconcile。

- 修复 `cm-ai` 受保护当前会话开发结果先落盘后校验的问题：本地 value/Learning 校验失败记录 `failed/invalid_result`，保留原原因并以 `developer_result_invalid` 阻断；修正后可沿同一 runId、同一 attempt resume。已应用提案仅在磁盘哈希一致时继续，冲突返回 `protected_edit_stale`；worker 异常与超时仍保留 unknown，不重置旧历史。

- 修复 `cm-ai` 准入被历史依赖行尾随句末标点阻断：依赖 ID 容忍末尾的 `。．.；;、` 与空白，内部非法字符仍拒绝；任务或依赖解析失败返回 feature、行号及最多 120 字符原文，并保留已解析 feature 状态，任务选择顺序不变。

- 修复 `cm-prd` 会话恢复错误码被宿主脱敏隐藏及 cancel 留下 active 导致的死锁：会话状态错误返回明确 blocked 原因，cancel 同时落盘终态并清空 active；resume 支持带证据的 abandon，回到操作前 checkpoint 后可重新发起，含 `prd_review` 的操作仍只能按原审查合同恢复。

- 修复 `cm-prd` 新增 feature 时，历史 specs 的任务/AC 运行期完成标记导致摘要回执门禁误报篡改：复用规格清单规范化规则并透传只读标记，其他内容、JSON、当前草稿处置与发布快照仍严格比对。摘要只裁决当前会话 feature，历史 feature 的旧版归档、缺失回执与已完成任务只登记为说明，完整规格哈希仍全部发布；无草稿从当前会话恢复范围，无法确定时明确阻断。

- 修复 `cm-ai` Codex 开发与审查子进程仍加载用户全部个人 skills 的问题：`--ignore-user-config`、`skills.config=[]`、`--disable plugins` 都拦不住 `<skills_instructions>` 目录注入，现在两条路径统一追加 `-c skills.include_instructions=false`。2026-09-16 空目录空操作提示词实测：input_tokens 18249 → 11706（−36%），“Skill descriptions were shortened to fit the skills context budget” 提示消失，模型不再看到 skill 工具；sandbox、审批与登录不受影响。实测无效的候选：`skills.config` 按根目录禁用、`skills.bundled.enabled=false`、`--enable skip_host_skill_discovery`（开发中特性，只多一条警告）、`--ignore-rules`、`--disable skill_search`；`skills.max_context_tokens=1` 虽降到 11813 但仍报预算超限提示，`=0` 直接拒绝启动。审查参数指纹已改变，旧凭证须重跑 preflight。已知剩余缺口：`~/.codex/AGENTS.md` 用户全局指令（本机 11.7KB）仍被注入，`project_doc_max_bytes=0`、`instructions`、`developer_instructions` 均不能移除（后者还会顶掉权限说明），唯一手段是隔离 `CODEX_HOME`，但登录态同样从该目录读取，复制或软链 auth.json 属凭据外放，本次不实施。

## 0.13.0 — 2026-09-17

- 修复 Claude 开发提案依赖自由文本 JSON 的问题：传入专用结构化输出 schema，配对内部 `StructuredOutput` 并优先读取 `structured_output`；无结构化结果时保留 JSON 回退，解析失败明确返回 `invalid_output_json`，严格校验成功/失败字面值与提案形状，原只读工具权限不变。

- 修复审查 finding 指向交接文件时被拒绝的问题：Codex 与 Claude 共享提示词明确允许包内 handoff 路径，保留 examinedPaths 精确匹配；非法 finding 路径、标识、严重度及形状分别返回具名错误码，便于诊断。

- 修复 Claude 回环预检将新版 CLI 的两次合规请求误判为失败：允许 1–2 次且逐条验证模型、传输与工具列表（空列表或唯一的 `StructuredOutput`），第三次请求或任一违规仍拒绝；结果新增 `message_requests_expected:'1-2'`，保留首次合规即停止、不转发模型与进程清理检查。

- 修复 Claude CLI 思考事件与审查结构化输出兼容：开发与审查流各容忍最多 64 条 `thinking_tokens`，思考块不推进状态；审查传入去除 `$schema`/`$id` 的结果 schema，配对 CLI 内部 `StructuredOutput`，最多容忍 16 次明确被拒的其他工具尝试，任何其他工具执行成功立即失败并终止进程组。开发流保留原只读工具与提案校验；审查参数指纹已改变，旧凭证须重跑 preflight。

- 修复 Claude CLI 回答前的 `rate_limit_event` 导致 `cm-ai` 开发与审查流失败的问题：同一会话终态前最多容忍 8 条，通过可选 `onNotice({kind:'rate_limit',info})` 仅上报标量字段；保持状态、观察事件及返回值形状不变，会话不匹配、超限和未知事件仍拒绝。

- 修复 Codex CLI 0.153.4 起 `cm-ai` 开发子进程禁用 `code_mode_host` 导致工具执行失败的问题：开发路径保留该工具通道，不启用 `code_mode` 特性；workspace-write、网络关闭和 specs 只读沙箱边界不变，审查路径仍禁用 `code_mode_host`，参数保持不变。

- 修复 `cm-ai` 开发与审查 worker 将 Codex CLI 0.153.4 启动提示误判为失败的问题：终态前最多容忍 8 条 `item.completed/error`，两类 worker 均通过独立 `onNotice` 回调上报 message 前 200 字符，回调异常不影响流程，保持事件流与返回值形状不变；超限或终态后提示仍拒绝，顶层 `error`、`turn.failed`、非零退出、缺结果与未知条目的失败判定保持不变。

- `cm-ai` protected host 按项目声明派发 coder/reviewer CLI，支持 Claude 只读文本提案经宿主校验后落盘；保留逐轮授权和跨家独立审查，实际启动进程后记录 `cli-dispatch`，审查凭证如实标注 `claude-cli`。2026-09-17 已完成真实模型双向验收各一次：Claude 宿主→Codex 写→Claude 审（`reviewer: claude-cli / independent: true / approved`）；Codex 宿主→Claude 只读提案→宿主沙箱落盘→Codex 审（`reviewer: codex-cli / independent: true / approved`）。均为单文件小任务，停在 N6 QA 待决；QA/N8 不在验收范围、仍未验收。

- 修复 `cm-init` 运行时声明无法进入宿主草稿的问题：可选 `selection.runtimes` 按预设追加配置目标，沿用已有文件名，核验声明并保护无关配置，接续原确认、审查与写入流程；直接导入 `scripts/cm-workflow-config.mjs` 复用唯一解析器（现有规则未禁止该方向，避免为下沉实现越过本次 cm-init 修改边界）。
- 新增运行时声明：`.cm-workflow.yml` 增加 `runtimes.available`（codex/claude/both），`cm-init` 首次初始化询问一次并按四个预设写入 coder/reviewer；配置校验拦截「单家声明却指向另一家」与「两家都有却写审同家」；`cm-check --project` 输出声明与本机 CLI 的对照及 coder/reviewer 的 `route_state`；`--failover` 改为声明优先、探测校验。声明不等于跨运行时派发。
- 新增双运行时容灾两层能力。`scripts/cm-failover.mjs` 只读推导 CM 断点（N3/N4/N5/N6）并生成另一端的续跑简报，不写 `tasks.md`、不标记完成、不授权发布；`cm-ai-host.mjs serve --failover` 在构造 execution 前按角色主从（developer 主 codex、reviewer 主 claude）探测选路，只决定起跑运行时，切换必播报，两端都不可解析时以 `no_runtime_available` 阻塞而非回退到不可用一端。不传 `--failover` 行为完全不变；与 `--protected-config` 互斥。边界与限制见 `docs/runtime-failover.md`。
- 修复自动更新器 `cm-update.sh` 硬编码 PATH 覆盖 launchd 环境变量的问题：改为保留继承的 PATH 再追加兜底目录，非 Homebrew 安装的 Node.js 不再导致定时更新一直报「Node.js 18+ 未找到」。

## 0.12.0 — 2026-09-16

- 新增 `cm-security`：默认扫描主分支差异与已跟踪未提交修改，支持 `--all`；结合业务地图复核安全问题，保留工具缺失与未覆盖范围；不自动修复、安装或上传。

- `cm-check` 默认查询 npm 稳定版，有新版就升级已管理的 CM 安装，再从升级后的目录检查；无需另加升级参数。
- 离线明确提示无法确认最新版；源码仓库和其他包管理器的安装保留原管理方式；底层机械检查保持只读，避免 CI 和安装流程递归升级。

## 0.11.0 — 2026-09-16

### 新增

- 直接运行 `cm-test`，自动分析当前分支相对 `main` / `master` 的已提交差异，列出受影响业务与重点回归场景。
- 影响分析后接续增量单测覆盖率检查，复用项目已有命令，支持 LCOV 和 Istanbul 报告；未配置工具时明确标记「未测得」。
- 支持 `cm-test，并补齐单测`，或看完报告后回复「补齐单测」，继续补测试、重跑并独立审查。
- 新增本更新日志，统一查看版本变化。

### 优化

- 开发需求和修复 bug 时，先核对业务地图与影响范围；地图缺失或失真时补充相关上下文，按需扩大分析范围。
- 需求与修复完成后增量更新相关业务地图，并在最终独立审查前定稿；文档同步覆盖同批次已完成任务。
- `cm-ai` / `cm-fix` 在最终独立审查前检查单测缺口，并在已授权范围内补测。

### 修复

- 检查已提交代码的覆盖率时，阻止未授权的未提交源码或测试混入执行。
- 缺失分支覆盖数据时保留缺口，不再把已测部分的百分比当作完整分支覆盖率。
- Codex 安装器同步分发更新日志，并检查安装后的内容一致性。
- 修复独立审查输出格式包含接口不支持字段而导致请求被拒绝的问题，本地审查路径校验保持严格。

> 覆盖率不代表业务验收通过；补单测不自动授权修改产品代码或安装测试框架。
> JS 修复流程的补测须在测试冻结前完成；当前 owner 无法合法写入覆盖率报告时，会明确报告接线受阻。

## 0.10.6

### 新增

- 增加工作流重复失败信号的只读分析工具，输出供人工判断的改进建议。
- 补齐 Pi/BYZ 与 Codex 发版面冒烟检查。

### 修复

- 修复安全扫描对已跟踪状态目录及部分私钥格式的漏检。
- 收紧重复失败分析工具的输入边界与证据校验。

## 维护方式

- 开发或修复完成后，将用户可感知的变化补到「未发布」，不逐条复制内部提交记录。
- 准备发版时，将对应条目移到目标版本标题下并标注计划日期；发布后核对实际日期，npm 状态以注册表为准。
- 本文件先补录 0.10.6 及之后的变化；更早版本和实现细节查阅 Git 提交历史。
