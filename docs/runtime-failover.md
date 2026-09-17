# 双运行时容灾

Codex 与 Claude 订阅的配额特性不同，任何一端都可能在工作中途变得不可用。本文
描述仓库提供的两层容灾，以及它们各自**做不到**什么。

## 能力边界（先读这节）

| 场景 | 能否自动切换 | 依靠什么 |
| ---- | ---- | ---- |
| 交互式会话跑到一半撞配额 | **不能** | 会话随进程结束；靠 L1 断点交接在另一端续跑 |
| 新任务启动时某端已不可用 | 能 | L2 启动前探测选路（`--failover`） |
| JS host 任务执行中途某端失效 | **不能** | 状态机按单 provider 建模；落盘状态由 L1 交接 |

`probe` 只检测 CLI 是否可解析。**可解析不等于配额可用**：二进制在、鉴权过期或
额度耗尽的情况，探测一样返回可用。真实可用性只有在实际调用时才暴露。

## 角色主从

主从按角色分，定义在 `runtime/js/cm-ai/runtime-failover.mjs`，是唯一真相：

| 角色 | 主 | 备 | 理由 |
| ---- | ---- | ---- | ---- |
| `developer` | codex | claude | 开发最耗配额，放在大额度一端 |
| `reviewer` | claude | codex | N4 与实现跨模型，避免同源盲区 |

## L1 断点交接（只读）

`scripts/cm-failover.mjs` 读取落盘物推导断点，生成可粘贴到另一端的续跑简报。它
只读 `tasks.md` 与 `.reviews/`，**不写任何文件、不标记完成、不授权发布**。

```bash
node scripts/cm-failover.mjs status  --specs {SPECS_DIR}
node scripts/cm-failover.mjs handoff --specs {SPECS_DIR} --to codex
node scripts/cm-failover.mjs probe
```

`--specs` 既接受 specs 根目录（遍历各 feature），也接受单个 feature 目录。

断点按证据穷举分类，每条都指向确定的 CM 节点：

| 落盘证据 | 断点 | 续跑动作 |
| ---- | ---- | ---- |
| 无 handoff | N3 | 从任务执行开始 |
| handoff `blocked` | N3 | 先处理 blockers/范围偏离 |
| handoff `ready_for_review`，无 review | N4 | 做独立审查 |
| review `changes_requested`（第 1 次） | N3 | 进入第 2 次尝试 |
| review `changes_requested`（第 2 次） | N4 | 重试用尽，人工介入 |
| review `approved`，tasks.md 未打勾 | N5 | 标记完成 |
| review `blocked` | N4 | 人工介入 |
| 全部任务已打勾 | N6 | QA 评估 |

简报本身不是完成授权：续跑方必须自行复跑该任务声明的验证命令。交接证据的
`implementation_sha256` 与文件字节绑定，任何改动都会让旧审查失效。

## L2 启动前探测选路（显式 opt-in）

`scripts/cm-ai-host.mjs serve` 新增 `--failover`。**不传时行为完全不变。**

```bash
node scripts/cm-ai-host.mjs serve --config {CONFIG} --mode create \
  --host-context {ID} --allow-development --failover
```

传入后，host 在构造 execution **之前**按 `developer` 角色选路。**声明为主、探测为校验**：

- 候选范围来自项目 `.cm-workflow.yml` 的 `runtimes.available`（`codex`/`claude` 只允许那一家；
  `both` 或未声明允许两家）；
- 起跑请求端优先取 `--runtime`，未传时取 `roles.coder.adapter` 对应的运行时，再回落到角色主端；
- 探测只回答 CLI 是否可解析，不能把声明之外的一家选进来。

选路结果：

- 请求端（`--runtime`，默认按角色主端）可解析 → 使用它，播报「未切换」
- 请求端不可解析、另一端可解析 → 切换，播报起点、终点与原因
- 两端都不可解析 → 以 `no_runtime_available` 阻塞，**绝不回退到不可用的一端**

切换始终打印到 stderr，不静默：

```text
cm-ai-host failover: developer: codex → claude（原因: codex unreachable）
cm-ai-host failover: CLI 可解析不等于配额可用；本次切换只决定起跑运行时。
```

### 限制

- **只决定起跑运行时**，任务开始后不再切换；中途失效由 L1 交接接手。
- 与 `--protected-config` 互斥（protected 模式只支持 Codex，无备端可选），组合报
  `failover_unsupported_in_protected_mode`。
- 当前会话 host 下 developer 与 reviewer 共用同一 runtime 参数，选路按
  `developer` 角色进行。要让 N4 跨模型，用 `--review-config` 指定审查通道，或走
  `codex-review` skill。

## 定点测试

```bash
node --test scripts/cm-failover.test.mjs scripts/cm-runtime-failover.test.mjs
```
