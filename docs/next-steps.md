# 接下来要做的事

2026-09-30 按 0.16.5 源码及本地修复重新核对；下列状态不等同 npm 发布或远端 CI 结果。

## 现状

- 全库本地回归发现旧 bootstrap 同 attempt 检查失败重试用例失败：恢复后报 `blocked/bootstrap_review_mismatch`，应到 `awaiting_review`。在本轮改动前的 `9bb45fc` 独立源码副本同样复现；属于现存缺陷，不能报全库全绿。
- 当前源码版本是 **0.16.5**；本地保留 bootstrap 规则刷新、未改文件审查核对和超大交付恢复修复。本次没有发布、推送或更新 tag。
- 只读查询 origin 的 tags 未找到 `0.16.5` 标签。是否补标签与发布须单独处理；本文件不以旧版 npm 快照声明当前 registry 状态。
- Linux CI 按 `scripts/*.test.mjs` 自动收集，9 份原生 Codex 沙箱夹具由 release smoke 补跑；新增 macOS job 运行 Darwin-only Claude 回环和 sandbox 夹具，本机已实际运行，远端尚未运行本地变更。
- 盘点脚本当前报告 **21 个取值，17 处**。这只是源码文字枚举候选，不能证明全部状态路径已有覆盖。
- cm-fix standalone 提供原 run `rediagnose` 恢复；夹具验证原历史保留、fresh r2、第二次拒绝上限。真实 Wue 原运行尚未执行恢复，不能以夹具替代其现场证据。
- 第二轮 blocked 后提供明确人审范围的一次性人工补正门禁，保留原四份证据和两轮上限；新审查封存后不能覆盖，详见 `docs/human-correction.md`。
- 本轮同 attempt bootstrap 重试误报和取消向导 locale 测试失败已修复；Learning application 选择精确事件，排除 writeback 结果。
- cm-security 最终私有报告增加实际尝试、未运行及需要补做事项；扫描输入、覆盖状态和裁决保持原合同。
- 四驾驶员新增显式当前会话执行证据通道，见 [使用与恢复边界](live-evidence-drivers.md)。它需要当前会话实际阅读/操作；没有无人值守浏览器服务，也不将合成夹具冒充真实产品验收。

---

## 第一档：补测试（清单里的 A 类，剩 0 条，已完成）

详细清单在 `docs/untested-branches.md`。cm-refactor 最后两条已补，A 类清单全部完成；这不代表 B 类或脚本未识别的分支已有覆盖。

| 顺序 | 模块 | 要补的 | 为什么排这里 |
| --- | --- | --- | --- |
| 已完成 | cm-check | ~~`configured` 状态~~ | **已补**：`scripts/cm-check-host.test.mjs`，含三态、核心判定、非法报告及变异验证 |
| 已完成 | cm-fix | ~~诊断结论 `design_change`~~ | **已补**：`scripts/cm-fix-escalation.test.mjs`，含真实红测、升级归档、恢复幂等、QA 父子退出及变异验证 |
| 已完成 | cm-test | ~~中断后允许重做的 `snapshot` / `evaluation` 两种纯读步骤~~ | **已补**：`scripts/cm-test-session.test.mjs`，含重做与禁止重做、原结果回执校验、已完成步骤回放及变异验证；这两种是步骤种类，不是用户模式 |
| 已完成 | cm-refactor | ~~规则判定三态~~ | **已补**：`scripts/cm-refactor-gaps.test.mjs`，含三态及混合裁决、拒绝码、报告和规则传递、变异验证；规则缺失或错误却不修订手册（含仅改行尾空白、换行符及首尾空行）时，在报告发布及试点前拒绝，修订效果仍待独立审查 |
| 已完成 | cm-refactor | ~~四个失败码~~ | **已补**：`scripts/cm-refactor-gaps.test.mjs`，含真实冲突与恢复、保留外来字节、不重试，及普通失败恢复对照；unknown-effect 列表成员的变异由源码合同检查捕获，详见缺口清单 |

**每一条都要做到的**：

1. **先读懂再动手**。弄清那条分支本来该是什么行为，列成一张表（输入 → 结果）。读浅了会写出「形状对但没验到点上」的测试，比没有更糟。
2. **变异验证**。测试写完后，故意把被测代码改坏几种，确认测试会红；改完还原，`git diff` 必须为空。新写的测试本来就该过，过了不代表验到了点上。
3. **重跑盘点脚本**，确认那条确实离开了缺口列表，数字下降。
4. **更新清单**，把做完的划掉。

---

## 第二档：已拍板的设计问题

### 1. cm-fix 本地 unknown 步骤的显式放弃与重做（已发布于 0.16.3）

**决定**：保留所有 `unknown` 的默认不重派。仅对复现、诊断、测试编写与运行、修复、回归、复盘、走查及对应第二轮本地步骤，
在原运行中增加带原因和独立启动旗标的 `abandon_step`；每次保留旧 intent，追加绑定摘要的记录和日志，再用新的 retry ID 重做。
最多 8 次，红灯输出另存。确切允许清单见 [JS 控制文档](js-workflow-control.md#cm-fix-本地-unknown-步骤的人工放弃)。

独立根因/最终审查、Learning 写回、交接文件不适用：前者可能已有外部调用，后两者可能已写项目或规格文件。
最终审查仍走既有人工续审。驾驶员继续预检答案；普通 `advance`/`run` 不自动放弃。

---

## 第三档：已知缺口，值得做但不急

### 2. QA 修复子运行换会话恢复（已发布于 0.16.3）

cm-ai 的 V3 会话父运行用 `--original-host-context` 恢复后，QA 修复子运行也使用当前真实会话打开和签审查授权；已有子配置保持不变。新建子运行只接受当前会话或父运行的持久创建会话，runtime 仍须匹配。父子运行继续串行交接同一把锁，原逐项授权不变。

验证见 `scripts/cm-ai-qa-fix-cross-session.test.mjs`：真实父子存储、模拟审查程序覆盖 A 创建、B 签授权、C 恢复及非法创建、审查员独立性、运行时边界。旧 protected 兼容入口和 batch 不在此次范围。

### 3. 驾驶员推广到其它工作流

**现状**：九个 JSONL 宿主（cm-fix、cm-ai、cm-ai-batch、cm-check、cm-idea、cm-init、cm-prd、cm-refactor、cm-test）都已有单步驾驶员，共用 JSONL 传输核心。cm-prd 的 PDF/HTML 材料与 cm-test 的浏览器执行可显式接入 liveEvidence 当前会话通道；未配置仍在发送前拒绝，真实阅读/交互和工具可用性仍需逐项目验证；cm-check 宿主无持久会话，驾驶员只能重新开始或只读 status，不能跨进程 resume。

**下一步**：补齐上述执行证据类 runner（PDF/HTML 读取、浏览器执行），证据必须来自实际运行；驾驶员的预检表仍须从各宿主的操作路由推导，不能照搬。

### 4. /cm:notify 的 Windows 支持

**现状**：Windows 上 `/cm:notify` 的切换、`test`（含演练）与托管发送器（含 `--check`）一律以退出码 2 拒绝，查看只显示文件是否存在、不读密钥内容。原因是密钥文件的所有者与访问规则核对还没有可靠做法：按路径读 ACL 再读句柄，中间可被换掉又换回，也没有实机验证。

**下一步**：做绑定到已打开句柄的所有者与 ACL 核对（不能只按路径），区分 NULL 与空 DACL，再在 Windows 实机上测试通过后，才解除 `runtime/js/notify-send.mjs` 的 `WINDOWS_UNSUPPORTED` 拒绝。

## 第四档：内部协议分支（清单里的 B 类）

**已完成**：B 类六项都已在 CI 执行的 `scripts/*.test.mjs` 补测试并完成变异验证。`gzip` / `zstd` / 未声明编码的回环测试由审查方在沙箱外运行通过，并做了 gzip 解码故意改坏的变异验证（注意 `cm-claude-probe` 整份测试只在 macOS 运行，Linux CI 上跳过）。明细见 `docs/untested-branches.md` 的已覆盖表。

---

## 已知限制（不打算修，但要知道）

- **受保护模式跑不了 `tsx` / `vitest` 这类命令**。它们要开本地 socket，而沙箱把这个和「联网」放在同一个开关下。放开就等于给测试命令开整个外网，不划算。替代写法见 `skills/cm-fix/references/js-host.md`。驾驶员在建运行前会预警。
- **有 9 份测试只在发版时跑**（原来 7 份；`cm-ai-host.test.mjs` 为了分进程并行拆成了 3 份，用例不变）。它们要启动 Codex 沙箱，GitHub 的机器不给这个权限。已接进 `cm-release-smoke.sh`，发版必过；CI 里有一句断言钉死这 9 份的名单，不会悄悄变多。
- **盘点脚本只认一种写法**（`['a','b'].includes(x)`），`switch`、对象查表、`Set.has` 都漏掉了。当前 21 项只是文字扫描候选，不能当作完整缺口数。
- **读代码找不到所有问题**。0.16.1 修的四个缺陷全是跑真实项目跑出来的。拿工作流去跑真实项目，仍然是发现问题最有效的办法。

---

## 做这些事的规矩

这一轮踩过的坑，照这几条就能避开：

1. **先写会失败的测试，再修**。确认它红的原因就是要修的那个问题，不是测试自己写错了。
2. **补测试必须做变异验证**，见第一档。
3. **改了存档相关的逻辑，要拿真实的存量运行验一遍**。测试套件里没有「带着历史跑过头」的夹具，有一次改动就是靠打开真实存量运行才发现会让它打不开。
4. **提交前重新 diff 自己改过的每个文件**。别人（或别的会话）可能同时改过，有一次就是这样把没读过的代码合进去了。
5. **全套检查都跑**：`node --test scripts/*.test.mjs`、`./scripts/cm-check-runtime.sh`、`python3 scripts/validate-public-repo.py`、`python3 scripts/scan-public-safety.py`。
6. **合并且获得本地安装授权后，两端都重装**：`./install.sh --yes`（Claude）和 `./install-codex.sh --yes`（Codex），然后在安装目录里确认改动真的在。Codex 要开新会话才会加载新版本。
7. **先核对源码目录、分支与 HEAD**；历史目录名不能证明当前内容。当前本地候选在独立工作树，尚未合并或安装。

---

## 发版

0.16.3 已于 2026-09-26 发布。下一版是否发、什么时候发，由维护者决定。

**流程**（0.16.1～0.16.3 都这样走）：改六处版本号（`package.json`、`VERSION`、`.codex-plugin/plugin.json`、README 两处、`docs/installation.md`）→ 把 CHANGELOG「未发布」切成新版本 → 跑全套检查和 `cm-release-smoke.sh` → 开 PR 合并 → 在 `cm-workflow-dev` 目录的终端 `npm publish` 并过两步验证（这一步必须本人做）→ 下载包核对 → 在发版提交上打标记 → 两端重新安装。

**README 的「最近更新」要重写正文，不能只换版本号**。0.16.0～0.16.2 发版时只替换了版本号，结果那段一直挂着 0.15.5 的内容，直到 #150 才改回来。

**注意**：npm 登录会过期。`npm whoami` 报 401 时，先 `npm login`，确认打印出 `aibyzero` 再发。过期时 npm 报的是 404「找不到包」，很容易误判成包出了问题。浏览器登录那一步超时时，可以改用 `npm login --auth-type=legacy`，在终端里依次输入用户名、密码和两步验证码。`npm publish` 过程中还会再弹一次网页确认，链接出来就尽快打开，别让它过期。
