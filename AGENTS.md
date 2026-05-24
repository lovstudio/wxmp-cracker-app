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
