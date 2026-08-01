# 微探

Powered by Lovstudio。

Latest release: https://github.com/lovstudio/wxmp-cracker-app/releases/latest

微探是一款跨端桌面 App：用三栏工作台采集、浏览并分析 [wcx](https://github.com/lovstudio/wcx) 抓回来的微信公众号文章。登录扫码在 app 内嵌的 WebviewWindow 里完成，不依赖外部 Chrome。

- 侧边栏：所有缓存的公众号（来自 `~/Library/Application Support/wcx/cache.db`）
- 中间列：选中公众号的文章列表
- 主区：文章正文（HTML 渲染或 markdown）
- 顶部：登录态徽章 + "扫码登录 / 更新凭证" 按钮

## Release Highlights

### v0.1.1

- macOS Release 走 Apple Developer ID 签名和公证。
- 新增 Lovstudio 账号登录、云端授权同步和管理员授权面板。
- 新增 Supabase `wxmp_licenses`、频率参数和公众号能力表结构。

### v0.1.0

- 首个 Tauri 桌面版本，支持读取本机 `wcx` 缓存并查看公众号文章。
- 新增公众号搜索、采集、续采和抓取进度展示。
- 新增账号工作区，包含采集管理、基本信息、趋势分析和文风分析。
- 新增账号绑定的试用/正式激活码流程。

## 前置

- 需要本机已通过 [wcx](https://github.com/lovstudio/wcx) 抓过至少一个公众号（cache.db 才有数据）
- macOS / Windows / Linux

## 开发

```bash
bun install
bun run tauri dev
```

## 登录流程（区别于命令行 skill）

1. 点 "扫码登录" → app 内嵌一个 WebviewWindow 打开 `https://mp.weixin.qq.com/`
2. 用户用手机扫码完成微信登录
3. 跳转后 URL 自带 `?token=XXX`，app 自动捕获
4. 通过 Tauri v2 的 `WebviewWindow::cookies()` 拉取所有 cookie（含 HttpOnly 的 `slave_sid` / `data_ticket`）
5. 写入 `~/Library/Application Support/wcx/config.json`，与 wcx CLI / lovstudio:wxmp-cracker skill 完全互通

## 数据来源

直接读 wcx 的 sqlite cache.db（`accounts` + `articles` 两张表），不再走 markdown export 一遍。这样新抓的内容立刻在 app 里可见。

## 架构

```
src-tauri/src/
  lib.rs        Tauri builder + invoke handlers + external-nav 守卫
  db.rs         rusqlite 读 cache.db
  auth.rs       内嵌 WebviewWindow 登录 + cookie 捕获
  commands.rs   暴露给前端的 #[tauri::command]

src/
  App.tsx                       三栏布局 + 状态
  components/account-sidebar.tsx
  components/article-list.tsx
  components/article-detail.tsx
  components/top-bar.tsx
  lib/api.ts                    invoke 封装 + 事件 listener
```
