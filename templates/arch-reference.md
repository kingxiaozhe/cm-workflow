# 架构基准参考表（快照日期: 2026-07 · G1 使用时必须联网校验刷新）

> 本表是**离线兜底基准**,不是权威答案。G1 推荐架构前应 WebSearch 对应交付形态的当年最佳实践;
> 网络不可用时才直接使用本表,且必须向用户标注"基于 2026-07 快照,建议联网复核"。

## 移动 App

| 场景 | 推荐 | 脚手架 | 依据 |
| ---- | ---- | ---- | ---- |
| 大多数创业/中小团队 App | **React Native(新架构) + Expo** | `npx create-expo-app` | JS/TS 团队复用、生态最大、EAS 省 60-70% 移动 DevOps、AI 代码生成友好 |
| UI 密集/像素一致性苛刻 | Flutter(Impeller) | `flutter create` | 渲染性能上限、跨端像素一致 |
| 纯单平台且性能极致 | 原生 Swift/Kotlin | Xcode / Android Studio | 无跨端需求时最直接 |

## Web

| 场景 | 推荐 | 脚手架 |
| ---- | ---- | ---- |
| 对外站点/要 SEO/营销页 | **Next.js**（无独立后端时 server actions 可免 API 层） | `npx create-next-app` |
| 登录后应用/后台/内部工具 | **Vite + React**(+React Router)——SPA 更简单便宜 | `npm create vite@latest` |
| 内容为主(博客/文档) | Astro | `npm create astro@latest` |
| Vue 团队 | Nuxt / Vite+Vue | `npx nuxi init` |

UI 层惯配: Tailwind CSS + shadcn/ui（React 系）。

## 后端 API

| 场景 | 推荐 | 依据 |
| ---- | ---- | ---- |
| TS 团队/边缘部署 | **Hono / Fastify** | 2026 新项目主流,轻量高性能,edge 友好 |
| Python 团队 | **FastAPI** | 类型安全+自动文档,Python 后端默认解 |
| 大型企业级 TS | NestJS | 结构化约束 |
| Go 团队 | Gin / Fiber | 高并发 |
| 快速起量/免运维 | Supabase / Firebase(BaaS) | 换开发速度,注意锁定成本 |

## 微信小程序

| 场景 | 推荐 | 脚手架 |
| ---- | ---- | ---- |
| 仅微信端 | 原生小程序 | 微信开发者工具 |
| React 团队/多端 | Taro | `taro init` |
| Vue 团队/多端 | uni-app | HBuilderX / CLI |

## 桌面

| 场景 | 推荐 |
| ---- | ---- |
| Web 团队做桌面 | Tauri（轻）/ Electron（生态大） |

## 维护规则

- 本表由 G1 联网校验结果**顺手更新**（发现快照过时 → 更新表格与快照日期,是 doc-syncer 职责的延伸）
- 表中"推荐"永远让位于 G1 的两条一票否决：团队约束、部署条件
