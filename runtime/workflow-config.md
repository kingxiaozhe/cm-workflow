# CM Workflow 项目配置合同

CM 支持一个可选的项目根配置文件：`.cm-workflow.yml`、`.cm-workflow.yaml` 或
`.cm-workflow.json`。配置缺失时使用内置默认值，旧项目不需要修改即可继续执行。

## 配置边界

- 配置只选择有限的 Workflow Profile、角色、执行适配器、模型别名和测试/交付策略。
- 配置不是权限文件：不能绕过人工审批、N4 独立审查、测试合同、Git 安全边界或外部专家外发确认。
- 配置不得出现 API Key、Token、Cookie、密码、私钥、凭据、Prompt 或模型原始回答。
- `source` 表示订阅、API、本地或浏览器等执行来源；它不等于模型身份。
- `model` 是用户可读的模型别名。CM 不根据订阅名推断后端模型版本。
- 外部专家的项目级 `activation` 只能是 `explicit`；`AUTO` 仍是单次调用的显式选择，不能由仓库配置永久打开。
- 第一版只读取显式 `--config` 或项目根配置，不读取隐式用户级配置。

## 角色

| 角色 | 责任 | 默认执行方式 |
| --- | --- | --- |
| `analyst` | 理解需求、识别影响范围 | 当前 AI |
| `planner` | 形成技术方案和任务拆分 | 当前 AI |
| `coder` | 修改业务代码 | 当前 AI |
| `tester` | 执行逻辑/命令测试与测试合同 | 本地工具 |
| `reviewer` | 任务级独立审查 | 当前 AI/独立审查通道 |
| `browser_qa` | 按用例模拟用户 | Playwright/本地浏览器 |
| `external_expert` | 方案、研究、诊断、测试设计和批判 | 显式外部浏览器通道（`external-browser` + `browser`） |

角色配置只改变“谁负责、用哪个适配器和模型别名”，不改变 N1–N8 顺序。未配置角色继续使用当前 AI 和既有默认行为。

## 有限 Workflow Profile

| Profile | 适用项目 | 额外策略 |
| --- | --- | --- |
| `cm-default` | 通用项目 | 使用默认 N1–N8 与三类测试 |
| `java-backend` | Java/Spring 等后端 | 优先后端命令测试、API/数据库回归 |
| `web-frontend` | React/Vue 等前端 | 优先构建、交互和浏览器测试 |

第一版不支持任意 DAG、动态 Agent 集群或后台调度器。需要新流程时先增加一个有限 Profile，并为它补齐双运行时与真实项目走查。

## 模型与来源示例

```yaml
roles:
  coder:
    adapter: codex-cli
    model: gpt-5.6-sol
    source: subscription
  planner:
    adapter: claude-api
    model: claude-opus
    source: api
```

Codex 订阅、Codex API、Claude/Fable 等兼容 API 和浏览器账号由各自运行时管理；项目配置只保存非敏感别名。`model_policy` 使用 `pro-extra-high-high-skip`；为兼容既有合同，`strict-Pro` 会在有效配置中规范化为 `strict-pro`。

## 字段枚举与降级

- `adapter`：`current-ai`、`codex-cli`、`claude-cli`、`claude-api`、
  `openai-compatible`、`local`、`browser`、`external-browser`。`browser` 只允许给
  `browser_qa`，`external-browser` 只允许给 `external_expert`；v1 的外部专家固定使用
  `source: browser`。
- `source`：`local`、`subscription`、`api`、`browser`、`none`。它只描述执行来源，
  不授予访问权限；`browser` 来源只允许给 `external_expert`。
- `external_expert.enabled` 是布尔值；`activation` 在项目配置中只能是 `explicit`。
  单次调用是否使用 AUTO 仍由调用指令决定，不能从仓库配置自动开启。
- `external_expert.model_policy`：默认 `pro-extra-high-high-skip`，按
  `Pro → Extra High → High → SKIPPED` 选择；`strict-pro`（兼容输入 `strict-Pro`）
  在 Pro 不可用时记录 BLOCKED 且不发送。
- `policies.tests` 只能包含 `logic`、`commands`、`browser`；`auto_fix` 只能是
  `explicit`、`never`、`auto`；`delivery` 只能是 `diff`、`branch`、`draft-mr`。

配置只选择已有角色和策略，不增加 Agent 数量，不改变 N1–N8，也不改变外部专家的本地
执行、人工审批和 N4 独立审查边界。

## 校验

使用 Node.js 内置能力校验配置，不要求安装第三方依赖：

```bash
node {CM_WORKFLOW_ROOT}/scripts/cm-workflow-config.mjs --project {CODE_PROJECT}
node {CM_WORKFLOW_ROOT}/scripts/cm-workflow-config.mjs --project {CODE_PROJECT} --print-effective
```

`scripts/cm_workflow_config.py` 仅保留为旧调用方的兼容转发入口；配置解析、合并、校验与
角色路由的唯一实现位于 `scripts/cm-workflow-config.mjs`。

配置错误时，入口必须停止并报告字段路径；配置正确时，`--print-effective` 输出合并默认值后的脱敏 JSON。
`cm-check` 会在验证项目配置时使用该输出模式，便于确认实际生效的角色和默认值；它不把
这些值当作权限授权。

角色在实际节点中的投影和 `route_state` 定义见 `runtime/workflow-routing.md`。查看单个
角色的安全路由元数据：

```bash
node {CM_WORKFLOW_ROOT}/scripts/cm-workflow-config.mjs \
  --project {CODE_PROJECT} --role coder --runtime codex --print-role
```
