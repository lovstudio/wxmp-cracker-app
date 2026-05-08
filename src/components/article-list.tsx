import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  CalendarIcon,
  CheckCircle2Icon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FileX2Icon,
  LinkIcon,
  LoaderCircleIcon,
  SearchIcon,
} from "lucide-react"
import { createPortal } from "react-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { api, type ArticleMatchField, type ArticleSummary } from "@/lib/api"
import { runWithProviderExecutionReport } from "@/lib/gateway"
import { normalizeWechatImageUrl } from "@/lib/media"
import { copyText, copyableToast as toast } from "@/lib/toast"
import { openUrl } from "@tauri-apps/plugin-opener"

interface Props {
  fakeid: string | null
  activeAid: string | null
  refreshKey?: number
  onSelect: (aid: string) => void
  onContentFetched?: (aid: string) => void
}

interface ArticleMenuState {
  article: ArticleSummary
  x: number
  y: number
}

export function ArticleList({
  fakeid,
  activeAid,
  refreshKey = 0,
  onSelect,
  onContentFetched,
}: Props) {
  const [items, setItems] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [q, setQ] = useState("")
  const [menu, setMenu] = useState<ArticleMenuState | null>(null)
  const [fetchingAid, setFetchingAid] = useState<string | null>(null)
  const [searchItems, setSearchItems] = useState<ArticleSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState("")
  const [searchError, setSearchError] = useState<string | null>(null)
  const [contentSearchVersion, setContentSearchVersion] = useState(0)

  useEffect(() => {
    if (!menu) return

    const close = () => setMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }

    window.addEventListener("click", close)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    window.addEventListener("keydown", closeOnEscape)

    return () => {
      window.removeEventListener("click", close)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [menu])

  useEffect(() => {
    if (!fakeid) {
      setItems([])
      setSearchItems([])
      setSearchedQuery("")
      setSearchError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .listArticles(fakeid)
      .then((r) => !cancelled && setItems(r))
      .catch(() => !cancelled && setItems([]))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [fakeid, refreshKey])

  const trimmedQuery = q.trim()

  useEffect(() => {
    if (!fakeid || !trimmedQuery) {
      setSearchItems([])
      setSearchedQuery("")
      setSearchError(null)
      setSearching(false)
      return
    }

    let cancelled = false
    setSearchError(null)
    setSearching(true)

    const timeout = window.setTimeout(() => {
      api
        .searchArticles(fakeid, trimmedQuery)
        .then((result) => {
          if (cancelled) return
          setSearchItems(result)
          setSearchedQuery(trimmedQuery)
        })
        .catch((error) => {
          if (cancelled) return
          setSearchItems([])
          setSearchedQuery("")
          setSearchError(errorMessage(error))
        })
        .finally(() => {
          if (!cancelled) setSearching(false)
        })
    }, 180)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [fakeid, trimmedQuery, refreshKey, contentSearchVersion])

  const localFiltered = useMemo(() => {
    const s = trimmedQuery.toLowerCase()
    if (!s) return items
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(s) ||
        (i.digest ?? "").toLowerCase().includes(s) ||
        (i.author ?? "").toLowerCase().includes(s)
    )
  }, [items, trimmedQuery])

  const filtered =
    trimmedQuery && searchedQuery === trimmedQuery && !searchError
      ? searchItems
      : localFiltered

  const cachedCount = useMemo(
    () => items.filter((item) => item.has_content).length,
    [items]
  )

  const fetchArticleContent = async (article: ArticleSummary) => {
    if (fetchingAid) return

    setFetchingAid(article.aid)
    toast.info(article.has_content ? "正在重新抓取正文" : "正在抓取正文")
    try {
      const updated = await runWithProviderExecutionReport(
        {
          endpoint: "fetch_article_content",
          observedValue: {
            aid: article.aid,
            fakeid: article.fakeid,
            force: article.has_content,
          },
          targetFakeid: article.fakeid,
        },
        () => api.fetchArticleContent(article.aid, article.has_content)
      )
      setItems((current) =>
        current.map((item) =>
          item.aid === updated.aid
            ? { ...item, has_content: updated.has_content }
            : item
        )
      )
      onContentFetched?.(updated.aid)
      setContentSearchVersion((current) => current + 1)
      toast.success(
        article.has_content ? "正文已重新抓取" : "正文已抓取并写入缓存"
      )
    } catch (e) {
      toast.wxmpError(errorMessage(e), api.openLogin)
    } finally {
      setFetchingAid(null)
    }
  }

  return (
    <aside className="article-list-panel flex h-full min-h-0 w-[min(420px,100%)] max-w-full shrink-0 flex-col overflow-hidden">
      <div className="border-b border-border/70 px-4 py-4">
        <div className="mb-3 flex items-end justify-between gap-3">
          <div>
            <div className="font-heading text-2xl leading-none font-semibold">
              文章索引
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              {fakeid
                ? `${filtered.length.toLocaleString()} / ${items.length.toLocaleString()} 篇`
                : "未选择公众号"}
            </div>
          </div>
          <div className="rounded-md border border-border/70 bg-muted/50 px-2.5 py-1.5 text-right">
            <div className="font-mono text-sm leading-none text-foreground">
              {cachedCount.toLocaleString()}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">已抓取</div>
          </div>
        </div>
        <div className="search-shell relative rounded-lg">
          <SearchIcon className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={fakeid ? "搜索标题、摘要或正文" : "请先选择公众号"}
            disabled={!fakeid}
            className="h-9 border-0 bg-transparent pr-8 pl-9 focus-visible:ring-1"
          />
          {searching && trimmedQuery && (
            <LoaderCircleIcon className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        {searchError && trimmedQuery && (
          <div className="mt-2 text-[11px] text-destructive">
            全文检索失败，已退回标题/摘要搜索
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        {loading && (
          <div className="space-y-0">
            {Array.from({ length: 7 }, (_, index) => (
              <div key={index} className="border-b border-border/60 px-4 py-4">
                <div className="mb-3 flex gap-3">
                  <div className="cover-thumb h-16 w-20 shrink-0 rounded-md" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="h-3 w-5/6 rounded bg-muted" />
                    <div className="h-3 w-2/3 rounded bg-muted/70" />
                    <div className="h-2 w-1/2 rounded bg-muted/50" />
                  </div>
                </div>
                {index === 0 && <div className="scanline h-px w-full" />}
              </div>
            ))}
          </div>
        )}
        {!loading && filtered.length === 0 && fakeid && (
          <div className="m-4 flex flex-col items-center rounded-lg border border-border/70 px-6 py-10 text-center">
            <FileX2Icon className="mb-3 size-8 text-muted-foreground" />
            <div className="text-sm font-medium">
              {items.length === 0 ? "暂无缓存文章" : "没有匹配结果"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {items.length === 0
                ? "当前公众号还没有本地记录"
                : "换个关键词试试"}
            </div>
          </div>
        )}
        {filtered.map((a) => {
          const cover = normalizeWechatImageUrl(a.cover)
          const matchFields = getVisibleMatchFields(a, trimmedQuery)
          const matchExcerpt = trimmedQuery ? a.match_excerpt : null

          return (
            <button
              key={a.aid}
              onClick={() => onSelect(a.aid)}
              onContextMenu={(event) => {
                event.preventDefault()
                setMenu(createArticleMenuState(a, event.clientX, event.clientY))
              }}
              onKeyDown={(event) => {
                if (
                  event.key !== "ContextMenu" &&
                  !(event.shiftKey && event.key === "F10")
                ) {
                  return
                }
                event.preventDefault()
                onSelect(a.aid)
                const rect = event.currentTarget.getBoundingClientRect()
                setMenu(
                  createArticleMenuState(a, rect.left + 28, rect.top + 28)
                )
              }}
              aria-haspopup="menu"
              className={cn(
                "article-card block w-full max-w-full min-w-0 overflow-hidden px-4 py-4 text-left transition-colors",
                activeAid === a.aid && "is-active"
              )}
            >
              <div className="flex min-w-0 gap-3 overflow-hidden">
                <div className="cover-thumb relative h-[72px] w-[92px] shrink-0 overflow-hidden rounded-md border border-border/70">
                  <FileTextIcon className="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/70" />
                  {cover && (
                    <img
                      src={cover}
                      alt=""
                      referrerPolicy="no-referrer"
                      loading="lazy"
                      decoding="async"
                      className="relative z-10 size-full object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none"
                      }}
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <div className="line-clamp-2 min-w-0 flex-1 text-[14px] leading-snug font-semibold break-words text-foreground">
                      {highlightText(a.title, trimmedQuery)}
                    </div>
                    <ArticleContentStatus
                      hasContent={a.has_content}
                      isFetching={fetchingAid === a.aid}
                    />
                  </div>
                  {a.digest && (
                    <div className="mt-1.5 line-clamp-2 text-xs leading-relaxed break-words text-muted-foreground">
                      {highlightText(a.digest, trimmedQuery)}
                    </div>
                  )}
                  {matchFields.length > 0 && (
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="inline-flex h-5 max-w-full items-center rounded-md border border-primary/25 bg-primary/10 px-1.5 font-medium text-primary">
                        命中：{formatMatchFields(matchFields)}
                      </span>
                    </div>
                  )}
                  {matchExcerpt && (
                    <div className="mt-1.5 line-clamp-2 rounded-md border border-border/70 bg-muted/35 px-2 py-1.5 text-[11px] leading-relaxed break-words text-muted-foreground">
                      <span className="mr-1 font-medium text-foreground">
                        片段
                      </span>
                      {highlightText(matchExcerpt, trimmedQuery)}
                    </div>
                  )}
                  <div className="mt-2 flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] text-muted-foreground">
                    <CalendarIcon className="size-3 shrink-0" />
                    <span className="shrink-0 font-mono">
                      {formatDate(a.create_time)}
                    </span>
                    {a.author && (
                      <span className="ml-1 min-w-0 flex-1 truncate font-medium">
                        {highlightText(a.author, trimmedQuery)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </ScrollArea>
      {menu && (
        <ArticleContextMenu
          menu={menu}
          fetchingAid={fetchingAid}
          onClose={() => setMenu(null)}
          onSelect={() => onSelect(menu.article.aid)}
          onFetchContent={fetchArticleContent}
        />
      )}
    </aside>
  )
}

function ArticleContentStatus({
  hasContent,
  isFetching,
}: {
  hasContent: boolean
  isFetching: boolean
}) {
  const state = isFetching ? "fetching" : hasContent ? "cached" : "missing"
  const label = isFetching ? "抓取中" : hasContent ? "正文已抓取" : "正文未抓取"

  return (
    <span
      className="article-status-badge"
      data-state={state}
      aria-label={`正文状态：${label}`}
    >
      {isFetching ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : hasContent ? (
        <CheckCircle2Icon className="size-3" />
      ) : (
        <FileX2Icon className="size-3" />
      )}
      <span>{label}</span>
    </span>
  )
}

const MATCH_FIELD_LABELS: Record<ArticleMatchField, string> = {
  title: "标题",
  digest: "摘要",
  author: "作者",
  content: "正文",
}

function getVisibleMatchFields(
  article: ArticleSummary,
  query: string
): ArticleMatchField[] {
  const fields = article.match_fields ?? []
  if (fields.length > 0) return Array.from(new Set(fields))

  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery) return []

  const inferred: ArticleMatchField[] = []
  if (article.title.toLowerCase().includes(normalizedQuery)) {
    inferred.push("title")
  }
  if ((article.digest ?? "").toLowerCase().includes(normalizedQuery)) {
    inferred.push("digest")
  }
  if ((article.author ?? "").toLowerCase().includes(normalizedQuery)) {
    inferred.push("author")
  }

  return inferred
}

function formatMatchFields(fields: ArticleMatchField[]): string {
  return fields.map((field) => MATCH_FIELD_LABELS[field]).join(" / ")
}

function highlightText(text: string, query: string): ReactNode {
  const trimmedQuery = query.trim()
  if (!trimmedQuery) return text

  const pattern = new RegExp(`(${escapeRegExp(trimmedQuery)})`, "gi")
  const parts = text.split(pattern)
  const queryLower = trimmedQuery.toLowerCase()

  if (parts.length === 1) return text

  return parts.map((part, index) =>
    part.toLowerCase() === queryLower ? (
      <mark
        key={`${part}-${index}`}
        className="rounded-[3px] bg-primary/20 px-0.5 text-foreground"
      >
        {part}
      </mark>
    ) : (
      part
    )
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function ArticleContextMenu({
  menu,
  fetchingAid,
  onClose,
  onSelect,
  onFetchContent,
}: {
  menu: ArticleMenuState
  fetchingAid: string | null
  onClose: () => void
  onSelect: () => void
  onFetchContent: (article: ArticleSummary) => Promise<void>
}) {
  const article = menu.article
  const fetching = fetchingAid === article.aid

  const run = (action: () => unknown | Promise<unknown>) => {
    onClose()
    void action()
  }

  return createPortal(
    <div
      role="menu"
      className="article-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="article-context-title">{article.title}</div>
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(onSelect)}
      >
        <CheckCircle2Icon className="size-3.5" />
        选中文章
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(() => openUrl(article.link))}
      >
        <ExternalLinkIcon className="size-3.5" />
        打开原文
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        disabled={Boolean(fetchingAid)}
        onClick={() => run(() => onFetchContent(article))}
      >
        {fetching ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <DownloadIcon className="size-3.5" />
        )}
        {fetching
          ? "正在抓取"
          : article.has_content
            ? "重新抓取正文"
            : "抓取正文"}
      </button>
      <div className="article-context-separator" />
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(() => copyText(article.title))}
      >
        <CopyIcon className="size-3.5" />
        复制标题
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(() => copyText(article.link))}
      >
        <LinkIcon className="size-3.5" />
        复制链接
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        onClick={() => run(() => copyText(`${article.title}\n${article.link}`))}
      >
        <FileTextIcon className="size-3.5" />
        复制标题和链接
      </button>
    </div>,
    document.body
  )
}

function createArticleMenuState(
  article: ArticleSummary,
  clientX: number,
  clientY: number
): ArticleMenuState {
  const width = 226
  const height = 254
  const padding = 8
  const x = Math.min(clientX, window.innerWidth - width - padding)
  const y = Math.min(clientY, window.innerHeight - height - padding)

  return {
    article,
    x: Math.max(padding, x),
    y: Math.max(padding, y),
  }
}

function formatDate(unix: number): string {
  const d = new Date(unix * 1000)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
