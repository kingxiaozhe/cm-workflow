---
description: {一句话：本项目的测试约定与覆盖率要求}
---

<!-- 模板骨架 · 生成时遵守四原则（可执行/Bad-Good/量化/现代实践），{占位符} 结合项目填充 -->

# 测试规范

## 框架与命令

- 单元/组件测试：{Vitest/Jest/pytest…，附运行命令}
- E2E：{Playwright/Cypress…，附运行命令}
- 覆盖率：`{coverage 命令}`

## 覆盖率要求（QA 与 skill 默认值以本节为准）

- 整体行覆盖 ≥ {N}%
- 核心模块（{列出目录}）≥ {N}%
- 纯类型/配置文件排除：{coverage 配置的 exclude 清单}

## 文件与命名约定

- 测试文件位置：{同目录 __tests__ / 独立 tests/ 目录}
- 命名：{*.test.ts / test_*.py}

## 分类要求

- 工具函数：输入输出全覆盖含边界值
- API/服务层：正常流 + 异常流 + 边界
- 组件：渲染 + 交互 + props 边界
- 禁止：测试内固定延时（用 waitFor）、测试间共享可变状态

## 可视化回归（如有 UI）

- browser_driver: {playwright | chrome-mcp | ask}（cm-qa-engineer 读取本字段）
- 基准截图位置：{路径}
