# 微信公众号归档站点

这个目录是 [wxmp-cracker](https://github.com/markshawn2020/wxmp-cracker-app) 自动同步的内容仓库,
附带一个开箱即用的 Astro 静态站点 + Pagefind 全文检索 + RSS。

## 启用步骤

1. **设置 Pages**:仓库 Settings → Pages → Source 选 "GitHub Actions"。
2. **修改 `astro.config.mjs`**:把 `site` 改成你的 Pages 域名(例如 `https://<your-name>.github.io/<repo>`)。
3. **首次推送即触发构建**:Actions 跑完后访问 Pages 链接即可。
4. **本地预览**:`npm install && npm run dev`。

## 目录结构

```
.
├── README.md          # ← 自动生成的内容索引,每次同步会刷新
├── index.json         # 全量元数据(供站点 & 第三方工具消费)
├── accounts/<公众号>/
│   ├── profile.json
│   └── articles/      # 文章 markdown
├── assets/<公众号>/<aid>/  # 文章引用的图片(防止微信 CDN 链接失效)
├── astro.config.mjs   # 站点配置
├── src/               # 站点模板
└── scripts/build-rss.mjs
```

## 关键约定

- `accounts/<昵称>/articles/<日期>-<标题>-<hash>.md` 是文章主体,顶部带 YAML frontmatter。
- `index.json` 由 wxmp-cracker 维护,**不要手动改**,会被下次同步覆盖。
- 图片仅在配置 `sync_images=true` 时下载;否则保留原始 mmbiz.qpic.cn URL(可能失效)。
