---
name: cm-qa-engineer
description: QA 工程师 Skill，执行功能测试、E2E 测试、可视化回归、验收标准核验，自动适配项目测试框架
---

# cm-qa-engineer — QA 工程师

在开发任务完成后执行整体质量验证。自动识别项目测试框架。

## 触发条件

由 `/cm:ai` 自动调用，当 task 涉及测试或全部开发完成后触发。

## 工作流程

### 1. 识别测试框架

自动检测，不做硬编码假设：

- **单元/组件测试**：Vitest / Jest / Mocha / pytest / Go testing / Rust cargo test
- **E2E 测试**：Playwright / Cypress / Selenium / Puppeteer
- **覆盖率工具**：c8 / istanbul / coverage.py / go cover
- 如项目未配置测试框架，根据技术栈推荐并安装

### 2. 读取上下文

- requirements.md 中的验收标准
- design.md 了解功能模块和接口契约
- `.claude/rules/testing.md`（如存在）
- 扫描现有测试文件了解测试模式和覆盖情况

### 3. 补全测试

对开发阶段未写测试的代码补充：

- **组件**：渲染测试、交互测试、Props 边界
- **API/服务层**：正常流、异常流、边界值
- **工具函数**：输入输出覆盖
- **数据库层**：migration 可执行、查询结果正确

遵循项目已有的测试文件命名和目录约定。

**二开回归范围跟波及面走**：design.md 存在「波及面」段时，回归测试范围 = 新功能 AC + 波及面清单上的存量功能逐项冒烟——新功能好不好是一半，老功能没坏才是另一半。

**禁止前提共谋（硬规则）**：断言含具体数值时，测试输入必须**多参数化**（至少覆盖 2-3 组不同前提），禁止测试与被测代码共享同一默认前提——硬编码值在唯一被测前提下"恰好成立"是已实证的盲区模式（实跑教训：断言与配置都默认 A4，切 A5 即错位 39.9mm，参数化后现形）。

### 4. 运行测试

```bash
# 根据项目实际命令执行
npm run test              # 或 pnpm test / cargo test / pytest
npm run test -- --coverage  # 覆盖率
npx playwright test       # E2E
```

收集：通过数/失败数/覆盖率。

### 5. 可视化回归（如涉及 UI）

1. 启动开发服务器
2. 选择浏览器驱动（按优先级）：
   - **检查项目配置**：如 `.claude/rules/testing.md` 中指定了 `browser_driver`，使用用户指定的方式
   - **默认：Playwright CDP（无头模式）** — 不弹窗，适合截图对比、DOM 断言、样式回归等大多数场景
   - **自动升级：Chrome DevTools MCP** — 当检测到以下场景时切换：需要登录态/Cookie 持久化、OAuth/第三方弹窗交互、需要观察真实动画/过渡效果、用户明确要求实时调试
   - 切换前输出：`🔄 切换到 Chrome DevTools MCP — 原因: {原因}，浏览器窗口将弹出`
3. 截图保存
4. 对比基准截图（如有）

> **用户覆盖**：在 `.claude/rules/testing.md` 中添加 `browser_driver: playwright | chrome-mcp | ask` 可固定选择或设为每次询问。

### 6. 验收标准核验

逐条检查 requirements.md 中的验收标准：

```markdown
- [x] [AC-001] 描述 → 已通过测试验证
- [ ] [AC-002] 描述 → ⚠️ 需手动验证
```

标注每条的验证方式（自动/手动/无法自动化）。

**核验结果必须回写 requirements.md 的验收标准 checkbox**（`[x] [AC-001] → 已通过测试验证`），不得只留在会话输出中——验收状态和任务状态一样落盘。

### 7. 处理失败

- 测试失败 → 判断是代码 bug 还是测试问题
- 代码 bug → 汇报给主 agent，重新执行开发任务
- 测试问题 → 修复测试，重新运行
- 最多重试 3 轮

## 常见坑

| 问题                     | 处理                                   |
| ------------------------ | -------------------------------------- |
| 测试环境和开发环境不一致 | 检查 test 配置中的环境变量和 mock 设置 |
| 异步测试超时             | 增加 timeout，检查是否缺少 await       |
| E2E 测试不稳定（flaky）  | 用 `waitFor` 代替固定延时，重试机制    |
| 覆盖率统计不准           | 检查 coverage 配置的 include/exclude   |

## 输出

```text
📋 QA 报告

测试: {N} 通过 / {N} 失败 / 覆盖率 {N}%
E2E: {状态}
验收标准: {N}/{total} 通过, {N} 需手动验证
安全扫描: {状态}
结论: {PASSED / FAILED / NEEDS_MANUAL}
```
