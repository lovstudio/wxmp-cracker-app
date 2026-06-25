import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeftIcon,
  BookOpenTextIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FileX2Icon,
  FolderOpenIcon,
  LinkIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  PenLineIcon,
} from "lucide-react"
import { createPortal } from "react-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener"
import {
  api,
  type ArticleDetail as Detail,
  type ArticleLocalFile,
} from "@/lib/api"
import { runWithProviderExecutionReport } from "@/lib/gateway"
import { isWechatRemoteImageUrl, normalizeWechatImageUrl } from "@/lib/media"
import { copyText, copyableToast as toast } from "@/lib/toast"

interface Props {
  aid: string | null
  refreshKey?: number
  onBackToList?: () => void
  onContentFetched?: (aid: string) => void
}

interface ArticleDetailMenuState {
  x: number
  y: number
}

const resolvedWechatImageCache = new Map<string, Promise<string>>()
const TRANSPARENT_IMAGE_DATA_URL =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="
const CSS_URL_PATTERN = /url\(\s*(['"]?)(.*?)\1\s*\)/gi
const createCssUrlPattern = () => new RegExp(CSS_URL_PATTERN)

export function ArticleDetail({
  aid,
  refreshKey = 0,
  onBackToList,
  onContentFetched,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [localFile, setLocalFile] = useState<ArticleLocalFile | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchingContent, setFetchingContent] = useState(false)
  const [contextMenu, setContextMenu] = useState<ArticleDetailMenuState | null>(
    null
  )

  useEffect(() => {
    setFetchingContent(false)
    if (!aid) {
      setDetail(null)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .getArticle(aid)
      .then((r) => !cancelled && setDetail(r))
      .catch(() => !cancelled && setDetail(null))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [aid, refreshKey])

  useEffect(() => {
    setLocalFile(null)
    setContextMenu(null)
    if (!aid) return

    let cancelled = false
    api
      .articleLocalFile(aid)
      .then((file) => !cancelled && setLocalFile(file))
      .catch(() => !cancelled && setLocalFile(null))

    return () => {
      cancelled = true
    }
  }, [aid, refreshKey])

  useEffect(() => {
    if (!contextMenu) return

    const close = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }

    window.addEventListener("click", close)
    window.addEventListener("resize", close)
    window.addEventListener("keydown", closeOnEscape)
    return () => {
      window.removeEventListener("click", close)
      window.removeEventListener("resize", close)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [contextMenu])

  const fetchContent = async () => {
    if (!detail || fetchingContent) return

    setFetchingContent(true)
    toast.info("正在抓取正文，可能需要一点时间")
    try {
      const updated = await runWithProviderExecutionReport(
        {
          endpoint: "fetch_article_content",
          observedValue: {
            aid: detail.aid,
            fakeid: detail.fakeid,
            force: false,
          },
          targetFakeid: detail.fakeid,
        },
        () => api.fetchArticleContent(detail.aid)
      )
      setDetail(updated)
      onContentFetched?.(updated.aid)
      toast.success("正文已抓取并写入本地缓存")
    } catch (e) {
      toast.wxmpError(errorMessage(e), api.openLogin)
    } finally {
      setFetchingContent(false)
    }
  }

  if (!aid) {
    return (
      <div className="article-detail-reader reader-surface flex min-h-0 flex-1 items-center justify-center p-8">
        <div className="empty-state-panel max-w-md rounded-lg px-8 py-10 text-center">
          <div className="mx-auto mb-5 flex size-12 items-center justify-center rounded-md border border-border/70 bg-muted/70 text-primary">
            <BookOpenTextIcon className="size-5" />
          </div>
          <div className="font-heading text-3xl leading-tight font-semibold">
            阅读纸面
          </div>
          <div className="mt-2 text-sm text-muted-foreground">
            选择文章后会在这里展开正文。
          </div>
        </div>
      </div>
    )
  }

  if (loading || !detail) {
    return (
      <div className="article-detail-reader reader-surface relative flex min-h-0 flex-1 items-center justify-center p-8">
        {onBackToList && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="reader-mobile-back-button"
            onClick={onBackToList}
          >
            <ArrowLeftIcon className="size-3.5" />
            返回列表
          </Button>
        )}
        <div className="empty-state-panel flex min-w-72 items-center gap-3 rounded-lg px-5 py-4 text-sm text-muted-foreground">
          {loading ? (
            <LoaderCircleIcon className="size-4 animate-spin text-primary" />
          ) : (
            <FileX2Icon className="size-4" />
          )}
          <span>{loading ? "正在读取正文" : "未找到该文章"}</span>
        </div>
      </div>
    )
  }

  const cover = normalizeWechatImageUrl(detail.cover)
  const localFilePath = localFile?.path ?? null
  const localFileExists = Boolean(localFile?.exists)

  const runArticleAction = (
    action: () => Promise<void> | void,
    fallbackMessage: string
  ) => {
    void Promise.resolve(action()).catch((error) => {
      toast.error(`${fallbackMessage}：${errorMessage(error)}`)
    })
  }

  const openOriginal = () => {
    runArticleAction(() => openUrl(detail.link), "打开原文失败")
  }

  const openLocalFile = () => {
    if (!localFilePath) {
      toast.warning("本地文章文件尚未生成，请先同步到归档仓库")
      return
    }
    if (!localFileExists) {
      toast.warning("本地文章文件不存在，请重新同步归档仓库")
      return
    }
    runArticleAction(() => openPath(localFilePath), "打开本地文件失败")
  }

  const revealLocalFile = () => {
    if (!localFilePath) {
      toast.warning("本地文章文件尚未生成，请先同步到归档仓库")
      return
    }
    if (!localFileExists) {
      toast.warning("本地文章文件不存在，请重新同步归档仓库")
      return
    }
    runArticleAction(
      () => revealItemInDir(localFilePath),
      "Reveal 本地文件失败"
    )
  }

  const copyLocalFilePath = () => {
    if (!localFilePath) {
      toast.warning("本地文章文件尚未生成，请先同步到归档仓库")
      return
    }
    void copyText(localFilePath)
  }

  const copyOriginalLink = () => {
    void copyText(detail.link)
  }

  return (
    <main className="article-detail-reader reader-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div
        className="reader-header"
        onContextMenu={(event) => {
          event.preventDefault()
          setContextMenu(
            createArticleDetailMenuState(event.clientX, event.clientY)
          )
        }}
      >
        <div className="reader-header-inner">
          {onBackToList && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="reader-mobile-back-button"
              onClick={onBackToList}
            >
              <ArrowLeftIcon className="size-3.5" />
              返回列表
            </Button>
          )}
          <div className="reader-title-row">
            <div className="min-w-0 flex-1">
              <h2 className="reader-title">{detail.title}</h2>
              <div className="reader-meta-line">
                <span className="reader-chip">
                  <CalendarClockIcon className="size-3.5" />
                  {formatDateTime(detail.create_time)}
                </span>
                {detail.author && (
                  <span className="reader-chip">
                    <PenLineIcon className="size-3.5" />
                    {detail.author}
                  </span>
                )}
                <span className="reader-chip">
                  {fetchingContent ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : detail.has_content ? (
                    <CheckCircle2Icon className="size-3.5" />
                  ) : (
                    <FileX2Icon className="size-3.5" />
                  )}
                  {fetchingContent
                    ? "正在抓取正文"
                    : detail.has_content
                      ? "正文已缓存"
                      : "仅索引"}
                </span>
              </div>
              {detail.digest && <p className="reader-deck">{detail.digest}</p>}
            </div>
            <div className="reader-action-stack">
              {cover && (
                <div className="reader-cover">
                  <img
                    src={cover}
                    alt=""
                    referrerPolicy="no-referrer"
                    loading="lazy"
                    decoding="async"
                    className="size-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none"
                    }}
                  />
                </div>
              )}
              <ArticleDetailActionDropdown
                detail={detail}
                localFile={localFile}
                onOpenOriginal={openOriginal}
                onOpenLocalFile={openLocalFile}
                onRevealLocalFile={revealLocalFile}
                onCopyLocalFilePath={copyLocalFilePath}
                onCopyOriginalLink={copyOriginalLink}
              />
            </div>
          </div>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="reader-paper">
          <ArticleBody
            detail={detail}
            fetchingContent={fetchingContent}
            onFetchContent={fetchContent}
          />
        </div>
      </ScrollArea>
      {contextMenu && (
        <ArticleDetailContextMenu
          menu={contextMenu}
          detail={detail}
          localFile={localFile}
          onClose={() => setContextMenu(null)}
          onOpenOriginal={openOriginal}
          onOpenLocalFile={openLocalFile}
          onRevealLocalFile={revealLocalFile}
          onCopyLocalFilePath={copyLocalFilePath}
          onCopyOriginalLink={copyOriginalLink}
        />
      )}
    </main>
  )
}

function ArticleDetailActionDropdown({
  detail,
  localFile,
  onOpenOriginal,
  onOpenLocalFile,
  onRevealLocalFile,
  onCopyLocalFilePath,
  onCopyOriginalLink,
}: {
  detail: Detail
  localFile: ArticleLocalFile | null
  onOpenOriginal: () => void
  onOpenLocalFile: () => void
  onRevealLocalFile: () => void
  onCopyLocalFilePath: () => void
  onCopyOriginalLink: () => void
}) {
  const localFilePath = localFile?.path ?? null
  const localFileExists = Boolean(localFile?.exists)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          className="reader-menu-button"
          aria-label="文章操作"
          title="文章操作"
        >
          <MoreHorizontalIcon className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="min-w-0">
          <div className="truncate text-foreground">{detail.title}</div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {localFileStatus(localFile)}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenOriginal}>
          <ExternalLinkIcon className="size-4" />
          查看原文
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!localFileExists}
          onSelect={onOpenLocalFile}
        >
          <FileTextIcon className="size-4" />
          查看本地文件
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!localFileExists}
          onSelect={onRevealLocalFile}
        >
          <FolderOpenIcon className="size-4" />
          Reveal 本地文件
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={!localFilePath}
          onSelect={onCopyLocalFilePath}
        >
          <CopyIcon className="size-4" />
          复制本地路径
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onCopyOriginalLink}>
          <LinkIcon className="size-4" />
          复制原文链接
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ArticleDetailContextMenu({
  menu,
  detail,
  localFile,
  onClose,
  onOpenOriginal,
  onOpenLocalFile,
  onRevealLocalFile,
  onCopyLocalFilePath,
  onCopyOriginalLink,
}: {
  menu: ArticleDetailMenuState
  detail: Detail
  localFile: ArticleLocalFile | null
  onClose: () => void
  onOpenOriginal: () => void
  onOpenLocalFile: () => void
  onRevealLocalFile: () => void
  onCopyLocalFilePath: () => void
  onCopyOriginalLink: () => void
}) {
  const localFilePath = localFile?.path ?? null
  const localFileExists = Boolean(localFile?.exists)

  const run = (action: () => void) => {
    onClose()
    action()
  }

  return createPortal(
    <div
      role="menu"
      className="article-context-menu article-detail-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="article-context-title">
        <div>{detail.title}</div>
        <div className="article-context-subtitle">
          {localFileStatus(localFile)}
        </div>
      </div>
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(onOpenOriginal)}
      >
        <ExternalLinkIcon className="size-3.5" />
        查看原文
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        disabled={!localFileExists}
        onClick={() => run(onOpenLocalFile)}
      >
        <FileTextIcon className="size-3.5" />
        查看本地文件
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        disabled={!localFileExists}
        onClick={() => run(onRevealLocalFile)}
      >
        <FolderOpenIcon className="size-3.5" />
        Reveal 本地文件
      </button>
      <div className="article-context-separator" />
      <button
        role="menuitem"
        className="article-context-item"
        disabled={!localFilePath}
        onClick={() => run(onCopyLocalFilePath)}
      >
        <CopyIcon className="size-3.5" />
        复制本地路径
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(onCopyOriginalLink)}
      >
        <LinkIcon className="size-3.5" />
        复制原文链接
      </button>
    </div>,
    document.body
  )
}

function localFileStatus(localFile: ArticleLocalFile | null): string {
  if (!localFile) return "本地 Markdown 未生成"
  return localFile.exists ? "本地 Markdown 已生成" : "本地路径存在，文件缺失"
}

function createArticleDetailMenuState(
  clientX: number,
  clientY: number
): ArticleDetailMenuState {
  const width = 242
  const height = 238
  const padding = 8
  const x = Math.min(clientX, window.innerWidth - width - padding)
  const y = Math.min(clientY, window.innerHeight - height - padding)

  return {
    x: Math.max(padding, x),
    y: Math.max(padding, y),
  }
}

function ArticleBody({
  detail,
  fetchingContent,
  onFetchContent,
}: {
  detail: Detail
  fetchingContent: boolean
  onFetchContent: () => void
}) {
  const articleRef = useRef<HTMLElement | null>(null)
  const preparedHtml = useMemo(() => {
    if (!detail.content_html) return null
    return prepareWechatContentHtml(detail.content_html)
  }, [detail.content_html])

  useEffect(() => {
    if (!preparedHtml) return
    const article = articleRef.current
    if (!article) return

    let cancelled = false
    void resolveWechatArticleImages(article, () => cancelled)

    return () => {
      cancelled = true
    }
  }, [preparedHtml])

  if (preparedHtml) {
    return (
      <article
        ref={articleRef}
        className="article-body"
        dangerouslySetInnerHTML={{ __html: preparedHtml }}
      />
    )
  }
  if (detail.content_md) {
    return (
      <article className="article-body">
        <pre className="whitespace-pre-wrap">{detail.content_md}</pre>
      </article>
    )
  }
  return (
    <div className="flex min-h-[420px] items-center justify-center p-8">
      <div className="empty-state-panel max-w-md rounded-lg px-8 py-10 text-center">
        <FileX2Icon className="mx-auto mb-3 size-8 text-muted-foreground" />
        <div className="text-sm font-medium">本篇正文未抓取</div>
        <div className="mx-auto mt-1 max-w-72 text-xs leading-relaxed text-muted-foreground">
          将从当前文章链接补抓正文，并写入 wcx 本地缓存。
        </div>
        <Button
          className="mt-5"
          disabled={fetchingContent}
          onClick={onFetchContent}
        >
          {fetchingContent ? (
            <LoaderCircleIcon className="size-4 animate-spin" />
          ) : (
            <DownloadIcon className="size-4" />
          )}
          {fetchingContent ? "正在抓取正文" : "抓取正文"}
        </Button>
      </div>
    </div>
  )
}

function formatDateTime(unix: number): string {
  const d = new Date(unix * 1000)
  return d.toLocaleString()
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function prepareWechatContentHtml(html: string): string {
  if (typeof DOMParser === "undefined") return html

  try {
    const doc = new DOMParser().parseFromString(html, "text/html")

    restoreEscapedWechatLinks(doc)

    doc.querySelectorAll("img").forEach((img) => {
      const src = pickWechatImageSrc(img)
      if (src) {
        if (isWechatRemoteImageUrl(src)) {
          img.setAttribute("data-wxmp-image-src", src)
          img.removeAttribute("src")
        } else {
          img.setAttribute("src", src)
        }
      }
      img.setAttribute("referrerpolicy", "no-referrer")
      img.setAttribute("loading", "lazy")
      img.setAttribute("decoding", "async")
      if (!img.getAttribute("alt")) {
        img.setAttribute("alt", "")
      }
    })

    doc.querySelectorAll("[style]").forEach((element) => {
      markWechatStyleImages(element)
    })

    return doc.body.innerHTML
  } catch {
    return html
  }
}

function restoreEscapedWechatLinks(doc: Document) {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []

  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const text = node.nodeValue ?? ""
    if (text.includes("<a") && text.includes("</a>")) {
      textNodes.push(node)
    }
  }

  textNodes.forEach((node) => replaceEscapedAnchorText(node, doc))
}

function replaceEscapedAnchorText(node: Text, doc: Document) {
  const text = node.nodeValue ?? ""
  const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/gi
  const fragment = doc.createDocumentFragment()
  let lastIndex = 0
  let changed = false

  for (const match of text.matchAll(anchorPattern)) {
    const matchedText = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      fragment.append(doc.createTextNode(text.slice(lastIndex, index)))
    }

    const anchor = createSafeArticleAnchor(doc, matchedText)
    if (anchor) {
      fragment.append(anchor)
      changed = true
    } else {
      fragment.append(doc.createTextNode(matchedText))
    }

    lastIndex = index + matchedText.length
  }

  if (!changed) return

  if (lastIndex < text.length) {
    fragment.append(doc.createTextNode(text.slice(lastIndex)))
  }
  node.parentNode?.replaceChild(fragment, node)
}

function createSafeArticleAnchor(
  doc: Document,
  anchorHtml: string
): HTMLAnchorElement | null {
  const template = doc.createElement("template")
  template.innerHTML = anchorHtml
  const parsed = template.content.querySelector("a")
  const href = safeArticleHref(parsed?.getAttribute("href") ?? "")
  if (!parsed || !href) return null

  const anchor = doc.createElement("a")
  anchor.href = href
  anchor.textContent = parsed.textContent?.trim() || href
  anchor.target = "_blank"
  anchor.rel = "noopener noreferrer"

  const className = parsed.getAttribute("class")
  if (className) {
    anchor.className = className
  }

  return anchor
}

function safeArticleHref(value: string): string | null {
  const href = value.trim()
  if (!href) return null

  try {
    const url = new URL(href)
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.toString()
    }
  } catch {
    return null
  }

  return null
}

function pickWechatImageSrc(img: Element): string | null {
  const attrs = [
    "data-src",
    "data-original",
    "data-original-src",
    "data-backsrc",
    "data-actualsrc",
    "src",
  ]

  for (const attr of attrs) {
    const value = normalizeWechatImageUrl(img.getAttribute(attr))
    if (value && !value.startsWith("data:image/")) {
      return value
    }
  }

  return normalizeWechatImageUrl(img.getAttribute("src"))
}

async function resolveWechatArticleImages(
  article: HTMLElement,
  isCancelled: () => boolean
) {
  await Promise.all([
    resolveWechatImgElements(article, isCancelled),
    resolveWechatStyleImages(article, isCancelled),
  ])
}

async function resolveWechatImgElements(
  article: HTMLElement,
  isCancelled: () => boolean
) {
  const images = Array.from(
    article.querySelectorAll<HTMLImageElement>("img[data-wxmp-image-src]")
  )
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("data-wxmp-image-src")
      if (!src) return

      try {
        const dataUrl = await resolveWechatImageDataUrl(src)
        if (isCancelled() || !article.contains(img)) return

        img.src = dataUrl
        img.removeAttribute("data-wxmp-image-error")
      } catch (error) {
        if (isCancelled() || !article.contains(img)) return

        console.warn("resolve WeChat image failed", error)
        img.setAttribute("data-wxmp-image-error", "true")
      }
    })
  )
}

async function resolveWechatStyleImages(
  article: HTMLElement,
  isCancelled: () => boolean
) {
  const elements = Array.from(
    article.querySelectorAll<HTMLElement>("[data-wxmp-style-image-srcs]")
  )

  await Promise.all(
    elements.map(async (element) => {
      const template = element.getAttribute("data-wxmp-style-template")
      const srcs = parseStyleImageSrcs(
        element.getAttribute("data-wxmp-style-image-srcs")
      )
      if (!template || srcs.length === 0) return

      try {
        const resolved = new Map<string, string>()
        await Promise.all(
          srcs.map(async (src) => {
            resolved.set(src, await resolveWechatImageDataUrl(src))
          })
        )

        if (isCancelled() || !article.contains(element)) return

        element.setAttribute(
          "style",
          replaceWechatStyleImageUrls(template, resolved)
        )
        element.removeAttribute("data-wxmp-style-image-error")
      } catch (error) {
        if (isCancelled() || !article.contains(element)) return

        console.warn("resolve WeChat style image failed", error)
        element.setAttribute("data-wxmp-style-image-error", "true")
      }
    })
  )
}

function resolveWechatImageDataUrl(src: string) {
  const cached = resolvedWechatImageCache.get(src)
  if (cached) return cached

  const request = api
    .resolveWechatImage(src)
    .then((image) => image.data_url)
    .catch((error) => {
      resolvedWechatImageCache.delete(src)
      throw error
    })

  resolvedWechatImageCache.set(src, request)
  return request
}

function markWechatStyleImages(element: Element) {
  const style = element.getAttribute("style")
  if (!style) return

  const srcs = extractWechatStyleImageSrcs(style)
  if (srcs.length === 0) return

  element.setAttribute("data-wxmp-style-template", style)
  element.setAttribute("data-wxmp-style-image-srcs", JSON.stringify(srcs))
  element.setAttribute(
    "style",
    replaceWechatStyleImageUrls(
      style,
      new Map(srcs.map((src) => [src, TRANSPARENT_IMAGE_DATA_URL]))
    )
  )
}

function extractWechatStyleImageSrcs(style: string): string[] {
  const srcs = new Set<string>()

  for (const match of style.matchAll(createCssUrlPattern())) {
    const src = normalizeWechatImageUrl(match[2])
    if (src && isWechatRemoteImageUrl(src)) {
      srcs.add(src)
    }
  }

  return Array.from(srcs)
}

function replaceWechatStyleImageUrls(
  style: string,
  replacements: Map<string, string>
) {
  return style.replace(createCssUrlPattern(), (token, _quote, rawUrl) => {
    const src = normalizeWechatImageUrl(rawUrl)
    const replacement = src ? replacements.get(src) : null
    if (!replacement) return token
    return `url("${replacement}")`
  })
}

function parseStyleImageSrcs(value: string | null): string[] {
  if (!value) return []

  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}
