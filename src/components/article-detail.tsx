import { useEffect, useMemo, useState } from "react"
import {
  ArrowLeftIcon,
  BookOpenTextIcon,
  CalendarClockIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileX2Icon,
  LoaderCircleIcon,
  PenLineIcon,
} from "lucide-react"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { openUrl } from "@tauri-apps/plugin-opener"
import { api, type ArticleDetail as Detail } from "@/lib/api"
import { runWithProviderExecutionReport } from "@/lib/gateway"
import { normalizeWechatImageUrl } from "@/lib/media"
import { copyableToast as toast } from "@/lib/toast"

interface Props {
  aid: string | null
  refreshKey?: number
  onBackToList?: () => void
  onContentFetched?: (aid: string) => void
}

export function ArticleDetail({
  aid,
  refreshKey = 0,
  onBackToList,
  onContentFetched,
}: Props) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(false)
  const [fetchingContent, setFetchingContent] = useState(false)

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

  return (
    <main className="article-detail-reader reader-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="reader-header">
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
              <Button
                size="sm"
                variant="outline"
                className="reader-open-button"
                onClick={() => openUrl(detail.link)}
              >
                <ExternalLinkIcon className="size-3.5" />
                原文
              </Button>
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
    </main>
  )
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
  const preparedHtml = useMemo(() => {
    if (!detail.content_html) return null
    return prepareWechatContentHtml(detail.content_html)
  }, [detail.content_html])

  if (preparedHtml) {
    return (
      <article
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

    doc.querySelectorAll("img").forEach((img) => {
      const src = pickWechatImageSrc(img)
      if (src) {
        img.setAttribute("src", src)
      }
      img.setAttribute("referrerpolicy", "no-referrer")
      img.setAttribute("loading", "lazy")
      img.setAttribute("decoding", "async")
      if (!img.getAttribute("alt")) {
        img.setAttribute("alt", "")
      }
    })

    return doc.body.innerHTML
  } catch {
    return html
  }
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
