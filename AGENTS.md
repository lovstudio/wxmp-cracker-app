## Design System

This project uses **Lovstudio Warm Academic Style (暖学术风格)**.

Reference complete design guide: file:///Users/mark/lovstudio/design/design-guide.md

### Quick Rules

1. **禁止硬编码颜色**：必须使用 semantic 类名，如 `bg-primary`、`text-muted-foreground`
2. **字体配对**：标题用 `font-serif`，正文用默认 `font-sans`
3. **圆角风格**：使用 `rounded-lg`、`rounded-xl`、`rounded-2xl`
4. **主色调**：陶土色按钮/高亮，暖米色背景，炭灰文字
5. **组件优先**：优先使用 shadcn/ui 组件

### Color Palette

- **Primary**: #E66F4C (陶土色 Terracotta)
- **Background**: #F9F9F7 (暖米色 Warm Beige)
- **Foreground**: #181818 (炭灰色 Charcoal)
- **Border**: #D5D3CB

### Common Patterns

- 主按钮: `bg-primary text-primary-foreground hover:bg-primary/90`
- 卡片: `bg-card border border-border rounded-xl`
- 标题: `font-serif text-foreground`

## 跨会话约定

- 用户可见文案不得出现接口名、内部 ID、错误码、配额公式与调度术语；tests/article-fetch-flow.test.ts 以反向断言守护该文案，改文案时同步测试而非放松断言（2026-09-03, 66e2a02）
- zsh 下 `for f in $(rg -l ...)` 不做分词，批量改多文件必须用 `rg -l | while read -r f` 管道（2026-09-03, 66e2a02）
- 创建 webview 或读取 cookie 的 Tauri 命令必须是 async：同步命令在 Windows 上跑在 WebView2 回调里，建窗口会永久死锁，macOS 复现不了；`auth::open_login_window` 写成 async，让同步命令调用不了它（2026-11-06, f549049）
- 应用和 wcx 是两个程序：`db::wcx_dir` 必须和 wcx 的 platformdirs 一致（Windows 是 `%LOCALAPPDATA%\wcx\wcx`）；Windows 版 wcx 同时靠打包时的 `X utf8` 和 manifest 的 `activeCodePage` 处理中文，只开前者会让中文临时目录下的 curl 证书路径报错 77。这些只在 Windows 上出错，改动后看 windows-login-smoke 工作流（2026-11-06, 068d302）
