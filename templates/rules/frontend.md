---
description: {一句话：Web 前端开发约定}
globs: {如 "src/web/**"，按实际目录}
---

<!-- 模板骨架 · 生成时遵守四原则，{占位符} 结合项目填充 -->

# 前端规范

## 组件

- 公共 UI 组件目录：{components/ui/ 等实际路径}——新通用组件必须入此目录
- 组件模式：{函数组件 + hooks / 组合式 API——从现有代码推断}
- UI 组件纯 props 驱动不含业务逻辑；业务组件组合 UI 组件
- 第三方组件库：{shadcn/Antd/Element…}——库内有的不自造轮子

## 样式与 Design Token

- 方案：{Tailwind vN / CSS Modules…}
- 颜色/间距/字号/圆角一律引用 token（{tailwind.config / CSS 变量位置}），**禁止裸写 hex/px 魔法值**
- 修改既有 token 值 = 契约变更，走上报流程（波及已验收页面）

## 状态与数据

- 状态管理：{Zustand/Pinia…}；简单局部状态用框架原生
- 请求层：{统一封装位置}，错误处理与 loading 状态必须处理
- 接口未就绪：mock + `// TODO: replace mock when API ready`

## 路由与性能

- 路由约定：{file-based / config-based，附目录}
- {懒加载/分包要求、图片处理约定}
