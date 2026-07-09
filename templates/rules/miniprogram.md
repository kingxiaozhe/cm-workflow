---
description: {一句话：微信小程序开发约定}
globs: {如 "miniprogram/**"，按实际目录}
---

<!-- 模板骨架 · 生成时遵守四原则，{占位符} 结合项目填充 -->

# 小程序规范

## 页面与组件

- 四件套（.wxml/.wxss/.js/.json）命名与目录：{从现有页面推断}
- 自定义组件用 Component 构造器，入 {components/ 实际路径}，usingComponents 按需引入
- 第三方库：{Vant Weapp / TDesign…}——库内有的不自造轮子

## 样式

- 尺寸一律 rpx（750rpx = 屏宽），禁止写死 px
- 颜色/间距走公共样式变量（{位置}），禁止硬编码
- 组件样式隔离：{styleIsolation 约定}

## 数据与性能

- setData 只更新变化字段，禁止循环/滚动中高频调用；长列表用虚拟列表
- 请求统一走 {封装位置}（baseURL/token/loading/错误 toast）
- 主包 ≤ 2MB：{分包配置约定}，图片走 {CDN/压缩策略}

## 登录与授权

- 登录链路：wx.login → {后端换取 session 的接口}
- getUserProfile 必须由用户点击触发；敏感授权拒绝时的兜底：{约定}
