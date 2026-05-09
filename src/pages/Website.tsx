import {
  Apple,
  BadgeCheck,
  BookOpen,
  BookOpenCheck,
  ChartNoAxesCombined,
  CheckCircle2,
  Clock3,
  Command,
  DatabaseZap,
  Download,
  FileText,
  Gauge,
  KeyRound,
  Laptop,
  MonitorDown,
  Network,
  Newspaper,
  PackageCheck,
  PanelLeft,
  ScanLine,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  type LucideIcon,
} from "lucide-react"
import type { ReactNode } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

const SITE_URL = "https://wxmp.lovstudio.ai"
const LATEST_VERSION = "0.1.6"
const RELEASE_DATE = "2026-05-09"

type IconBlock = {
  icon: LucideIcon
  title: string
  body: string
}

type DownloadFile = {
  label: string
  href: string
  meta: string
  hint: string
  primary?: boolean
}

type DownloadPlatform = {
  value: string
  icon: LucideIcon
  title: string
  meta: string
  note: string
  files: DownloadFile[]
}

const featureBlocks: IconBlock[] = [
  {
    icon: ScanLine,
    title: "内嵌扫码登录",
    body: "在桌面端 WebviewWindow 内完成微信公众号平台扫码，自动保存凭证，不依赖外部 Chrome 会话。",
  },
  {
    icon: DatabaseZap,
    title: "直读本机缓存",
    body: "读取 wcx 的 sqlite cache.db，账号、文章、正文采集结果进入工作台后立即可见。",
  },
  {
    icon: ChartNoAxesCombined,
    title: "从资料到洞察",
    body: "三栏阅读、趋势概览、文风分析和账号工作区连在一起，适合持续研究公众号内容资产。",
  },
  {
    icon: Network,
    title: "配额与能力调度",
    body: "Lovstudio 授权、频率面板、节点健康和商业化支持能力集中管理。",
  },
]

const workflowSteps: IconBlock[] = [
  {
    icon: MonitorDown,
    title: "下载桌面端",
    body: "在官网下载区切换系统标签，直接获取 macOS、Windows 或 Linux 安装包。",
  },
  {
    icon: BadgeCheck,
    title: "登录 Lovstudio",
    body: "授权、试用、正式套餐和远程同步都会绑定到同一个 Lovstudio 账号。",
  },
  {
    icon: ScanLine,
    title: "扫码微信公众号",
    body: "用手机确认登录 mp.weixin.qq.com，微探会把必要 cookie 写回 wcx 配置。",
  },
  {
    icon: Newspaper,
    title: "采集并分析",
    body: "搜索公众号，选择采集数量和正文同步策略，再进入阅读与账号分析工作区。",
  },
]

const downloadPlatforms: DownloadPlatform[] = [
  {
    value: "macos",
    icon: Apple,
    title: "macOS",
    meta: "Apple Silicon / Intel",
    note: "推荐 Apple Silicon 机型下载 arm64 包；Intel Mac 下载 x64 包。",
    files: [
      {
        label: "Apple Silicon",
        href: downloadEndpoint("macos-arm64"),
        meta: "macOS arm64 · dmg",
        hint: "M1 / M2 / M3 / M4 芯片",
        primary: true,
      },
      {
        label: "Intel Mac",
        href: downloadEndpoint("macos-x64"),
        meta: "macOS x64 · dmg",
        hint: "Intel 芯片 Mac",
      },
    ],
  },
  {
    value: "windows",
    icon: Laptop,
    title: "Windows",
    meta: "x64 executable zip",
    note: "下载 zip 后解压运行，首次启动按系统提示确认。",
    files: [
      {
        label: "Windows x64",
        href: downloadEndpoint("windows-x64"),
        meta: "Windows x64 · zip",
        hint: "解压后运行 wxmp-cracker.exe",
        primary: true,
      },
    ],
  },
  {
    value: "linux",
    icon: TerminalSquare,
    title: "Linux",
    meta: "deb / AppImage",
    note: "适合桌面发行版，也可与已有 wcx 环境共用缓存。",
    files: [
      {
        label: "AppImage",
        href: downloadEndpoint("linux-appimage"),
        meta: "Linux x64 · AppImage",
        hint: "多数桌面发行版可直接运行",
        primary: true,
      },
      {
        label: "Debian / Ubuntu",
        href: downloadEndpoint("linux-deb"),
        meta: "Linux x64 · deb",
        hint: "适合 Debian、Ubuntu 及衍生发行版",
      },
      {
        label: "Fedora / RHEL",
        href: downloadEndpoint("linux-rpm"),
        meta: "Linux x64 · rpm",
        hint: "适合 Fedora、RHEL 及衍生发行版",
      },
    ],
  },
]

const docSections = [
  { id: "install", title: "安装" },
  { id: "login", title: "登录与授权" },
  { id: "collect", title: "采集" },
  { id: "data", title: "数据位置" },
  { id: "release", title: "版本" },
]

export function Website() {
  const isDocs = normalizedPathname() === "/docs"

  return (
    <div className="site-page">
      <SiteHeader active={isDocs ? "docs" : "home"} />
      {isDocs ? <DocsPage /> : <LandingPage />}
      <SiteFooter />
    </div>
  )
}

function LandingPage() {
  return (
    <>
      <section className="site-hero" id="top">
        <div className="site-hero-grid" aria-hidden="true" />
        <div className="site-container site-hero-content">
          <div className="site-kicker">
            <Sparkles className="site-icon" aria-hidden="true" />
            Lovstudio 出品 · 微信公众号内容采集与洞察工作台
          </div>
          <h1 className="site-hero-title">微探</h1>
          <p className="site-hero-copy">
            把分散在微信公众号后台、wcx 缓存和本地文章库里的内容，整理成一个可阅读、可续采、可分析的桌面研究台。
          </p>
          <div className="site-action-row" aria-label="主要操作">
            <a className="site-button site-button-primary" href="#download">
              <Download className="site-icon" aria-hidden="true" />
              下载最新版
            </a>
            <a className="site-button site-button-ghost" href="/docs">
              <BookOpen className="site-icon" aria-hidden="true" />
              阅读文档
            </a>
          </div>
          <div className="site-hero-facts" aria-label="版本信息">
            <span>v{LATEST_VERSION}</span>
            <span>{RELEASE_DATE}</span>
            <span>macOS · Windows · Linux</span>
          </div>
        </div>
        <ProductBackdrop />
      </section>

      <section className="site-proof-band" aria-label="产品预览">
        <div className="site-container site-proof-grid">
          <PreviewMetric value="36" label="最近进度事件保留" />
          <PreviewMetric value="3" label="阅读工作台分栏" />
          <PreviewMetric value="L0+" label="账号配额等级" />
          <PreviewMetric value="wcx" label="缓存与 CLI 互通" />
        </div>
      </section>

      <section className="site-section" id="product">
        <div className="site-container">
          <div className="site-section-heading">
            <p className="site-section-eyebrow">Product</p>
            <h2>为公众号资料库而生</h2>
            <p>
              微探不是通用笔记工具。它围绕公众号账号、文章列表、正文内容、授权配额和可复用采集能力设计。
            </p>
          </div>
          <div className="site-feature-grid">
            {featureBlocks.map((feature) => (
              <FeatureCell key={feature.title} {...feature} />
            ))}
          </div>
        </div>
      </section>

      <section className="site-section site-section-ruled">
        <div className="site-container site-workflow-layout">
          <div className="site-section-heading">
            <p className="site-section-eyebrow">Flow</p>
            <h2>从下载到第一份资料库</h2>
          </div>
          <div className="site-timeline">
            {workflowSteps.map((step, index) => (
              <article className="site-step" key={step.title}>
                <div className="site-step-number">{index + 1}</div>
                <step.icon className="site-step-icon" aria-hidden="true" />
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="site-section" id="docs">
        <div className="site-container site-doc-preview">
          <div className="site-section-heading">
            <p className="site-section-eyebrow">Docs</p>
            <h2>文档已经放在官网里</h2>
            <p>
              安装、登录、采集、本机缓存位置和版本说明都可以从这里进入，不需要翻 README。
            </p>
          </div>
          <div className="site-doc-strip">
            <DocShortcut
              icon={BookOpenCheck}
              title="新手安装"
              body="确认系统、下载包、启动桌面端。"
              href="/docs#install"
            />
            <DocShortcut
              icon={KeyRound}
              title="账号授权"
              body="Lovstudio 登录、激活码和云端授权同步。"
              href="/docs#login"
            />
            <DocShortcut
              icon={Gauge}
              title="配额面板"
              body="查看小时额度、队列、节点健康和告警。"
              href="/docs#collect"
            />
          </div>
        </div>
      </section>

      <section className="site-section site-download-section" id="download">
        <div className="site-container site-download-layout">
          <div className="site-section-heading">
            <p className="site-section-eyebrow">Download</p>
            <h2>选择你的桌面系统</h2>
            <p>
              切换平台标签后直接下载对应安装包。macOS 已接入 Developer ID
              签名和公证，Windows 与 Linux 包保持与桌面端版本同步。
            </p>
            <div className="site-download-version">
              <PackageCheck className="site-icon" aria-hidden="true" />
              v{LATEST_VERSION} · {RELEASE_DATE}
            </div>
          </div>
          <DownloadTabs />
        </div>
      </section>
    </>
  )
}

function DocsPage() {
  return (
    <main className="site-docs-page">
      <div className="site-container site-docs-layout">
        <aside className="site-docs-nav" aria-label="文档导航">
          <div className="site-docs-nav-title">微探文档</div>
          {docSections.map((section) => (
            <a href={`#${section.id}`} key={section.id}>
              {section.title}
            </a>
          ))}
          <a href="/#download">下载</a>
        </aside>

        <article className="site-docs-article">
          <header className="site-docs-hero">
            <p className="site-section-eyebrow">Documentation</p>
            <h1>安装、登录和采集指南</h1>
            <p>
              这份文档覆盖桌面端上手流程。当前官网域名为{" "}
              <a href={SITE_URL}>{SITE_URL.replace("https://", "")}</a>。
            </p>
          </header>

          <DocBlock id="install" icon={Download} title="安装">
            <p>
              在官网首页下载区切换平台标签，直接选择安装包。macOS 用户通常选择对应芯片的
              dmg，Windows 用户选择 x64 zip，Linux 用户选择 AppImage 或 deb。
            </p>
            <DownloadTabs compact />
            <ul>
              <li>macOS 发布包从 v0.1.1 起接入 Apple Developer ID 签名和公证。</li>
              <li>首次启动后，桌面端会读取本机 wcx 缓存；没有缓存也可以先扫码登录再采集。</li>
              <li>开发者本地运行使用 <code>bun run tauri dev</code>。</li>
            </ul>
          </DocBlock>

          <DocBlock id="login" icon={ShieldCheck} title="登录与授权">
            <p>
              微探有两类登录：Lovstudio 账号用于授权、试用和配额同步；微信公众号登录用于获取公众号后台采集能力。
            </p>
            <ol>
              <li>打开微探后先登录 Lovstudio 账号。</li>
              <li>点击扫码登录微信公众号，桌面端会打开内嵌登录窗口。</li>
              <li>手机扫码确认后，微探会捕获必要 cookie 并写入 wcx 配置。</li>
              <li>需要正式能力时，在激活窗口输入绑定当前 Lovstudio 账号的激活码。</li>
            </ol>
          </DocBlock>

          <DocBlock id="collect" icon={Command} title="采集">
            <p>
              登录完成后，在侧边栏添加公众号。搜索到目标账号后，选择采集数量和是否同步正文，进度会在弹窗内持续刷新。
            </p>
            <div className="site-doc-callout">
              <CheckCircle2 className="site-icon" aria-hidden="true" />
              已采集账号会进入三栏工作台：左侧账号库，中间文章列表，右侧正文阅读与内容分析。
            </div>
            <p>
              配额面板用于查看小时额度、执行池、队列、节点健康和告警。开启自用优先或商业化支持前，请确认账号边界和授权规则。
            </p>
          </DocBlock>

          <DocBlock id="data" icon={FileText} title="数据位置">
            <p>微探与 wcx 共用本机数据，方便 CLI、桌面端和自动化流程互通。</p>
            <dl className="site-doc-data">
              <div>
                <dt>文章缓存</dt>
                <dd>
                  <code>~/Library/Application Support/wcx/cache.db</code>
                </dd>
              </div>
              <div>
                <dt>登录凭证</dt>
                <dd>
                  <code>~/Library/Application Support/wcx/config.json</code>
                </dd>
              </div>
              <div>
                <dt>本机授权</dt>
                <dd>由桌面端写入应用数据目录，并与 Lovstudio 云端授权同步。</dd>
              </div>
            </dl>
          </DocBlock>

          <DocBlock id="release" icon={Clock3} title="版本">
            <p>
              当前官网展示版本为 v{LATEST_VERSION}，发布日期 {RELEASE_DATE}。
              v0.1.6 内置 wcx 运行环境并加入应用自动更新，用户无需手动安装
              Python 或 wcx。
            </p>
            <a className="site-button site-button-ghost" href="/#download">
              <Download className="site-icon" aria-hidden="true" />
              回到下载区
            </a>
          </DocBlock>
        </article>
      </div>
    </main>
  )
}

function SiteHeader({ active }: { active: "home" | "docs" }) {
  return (
    <header className="site-header">
      <nav className="site-container site-nav" aria-label="主导航">
        <a className="site-brand" href="/" aria-label="微探首页">
          <img src="/logo.png" alt="" />
          <span>微探</span>
        </a>
        <div className="site-nav-links">
          <a data-active={active === "home"} href="/#product">
            产品
          </a>
          <a data-active={active === "docs"} href="/docs">
            文档
          </a>
          <a href="/#download">下载</a>
          <a href="/docs#release">版本</a>
        </div>
      </nav>
    </header>
  )
}

function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-container site-footer-grid">
        <div>
          <div className="site-footer-brand">微探 · Lovstudio</div>
          <p>微信公众号内容采集、阅读与分析桌面工作台。</p>
        </div>
        <div className="site-footer-links">
          <a href="/docs">文档</a>
          <a href="/#download">下载</a>
          <a href="https://lovstudio.ai" target="_blank" rel="noreferrer">
            Lovstudio
          </a>
        </div>
      </div>
    </footer>
  )
}

function ProductBackdrop() {
  return (
    <div className="site-product-backdrop" aria-hidden="true">
      <div className="site-window">
        <div className="site-window-rail">
          <span />
          <span />
          <span />
        </div>
        <div className="site-window-body">
          <div className="site-window-sidebar">
            <div className="site-window-brand">
              <PanelLeft />
              账号库
            </div>
            {["深度内容实验室", "城市商业观察", "产业周报"].map((name) => (
              <div className="site-window-account" key={name}>
                <span />
                {name}
              </div>
            ))}
          </div>
          <div className="site-window-list">
            <div className="site-window-toolbar">
              <span>文章队列</span>
              <span>同步中</span>
            </div>
            {["模型供给的真实边界", "内容团队的周报系统", "从公开资料构建洞察"].map(
              (title) => (
                <div className="site-window-article" key={title}>
                  <Newspaper />
                  <span>{title}</span>
                </div>
              )
            )}
          </div>
          <div className="site-window-detail">
            <div className="site-window-doc-title">公众号资料库</div>
            <div className="site-window-line" />
            <div className="site-window-line short" />
            <div className="site-window-chart">
              <span style={{ height: "52%" }} />
              <span style={{ height: "78%" }} />
              <span style={{ height: "44%" }} />
              <span style={{ height: "88%" }} />
              <span style={{ height: "64%" }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function PreviewMetric({ value, label }: { value: string; label: string }) {
  return (
    <div className="site-preview-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function FeatureCell({ icon: Icon, title, body }: IconBlock) {
  return (
    <article className="site-feature-cell">
      <Icon className="site-feature-icon" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  )
}

function DownloadTabs({ compact = false }: { compact?: boolean }) {
  return (
    <Tabs
      defaultValue={downloadPlatforms[0].value}
      className={compact ? "site-download-tabs compact" : "site-download-tabs"}
    >
      <TabsList className="site-download-tab-list" aria-label="选择下载平台">
        {downloadPlatforms.map((platform) => (
          <TabsTrigger
            className="site-download-tab-trigger"
            key={platform.value}
            value={platform.value}
          >
            <platform.icon className="site-icon" aria-hidden="true" />
            {platform.title}
          </TabsTrigger>
        ))}
      </TabsList>

      {downloadPlatforms.map((platform) => (
        <TabsContent
          className="site-download-tab-content"
          key={platform.value}
          value={platform.value}
        >
          <article className="site-download-panel">
            <div className="site-download-panel-head">
              <platform.icon className="site-download-icon" aria-hidden="true" />
              <div>
                <h3>{platform.title}</h3>
                <p>{platform.meta}</p>
              </div>
            </div>
            <p className="site-download-panel-note">{platform.note}</p>
            <div className="site-download-file-grid">
              {platform.files.map((file) => (
                <a
                  className="site-download-file-button"
                  data-primary={file.primary ? "true" : undefined}
                  download
                  href={file.href}
                  key={file.href}
                  rel="noreferrer"
                  target="_blank"
                >
                  <Download className="site-icon" aria-hidden="true" />
                  <span className="site-download-button-copy">
                    <span className="site-download-button-label">
                      {file.label}
                    </span>
                    <span className="site-download-button-meta">
                      {file.meta}
                    </span>
                  </span>
                  <span className="site-download-button-hint">{file.hint}</span>
                </a>
              ))}
            </div>
          </article>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function DocShortcut({
  icon: Icon,
  title,
  body,
  href,
}: IconBlock & { href: string }) {
  return (
    <a className="site-doc-shortcut" href={href}>
      <Icon className="site-feature-icon" aria-hidden="true" />
      <span>{title}</span>
      <p>{body}</p>
    </a>
  )
}

function DocBlock({
  children,
  icon: Icon,
  id,
  title,
}: {
  children: ReactNode
  icon: LucideIcon
  id: string
  title: string
}) {
  return (
    <section className="site-doc-block" id={id}>
      <div className="site-doc-block-title">
        <Icon className="site-feature-icon" aria-hidden="true" />
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  )
}

function normalizedPathname() {
  const pathname = window.location.pathname.replace(/\/+$/, "")
  return pathname || "/"
}

function downloadEndpoint(target: string) {
  return `/api/download?target=${target}`
}
