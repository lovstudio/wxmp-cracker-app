import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  AlertCircleIcon,
  CalendarIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FileX2Icon,
  HistoryIcon,
  LinkIcon,
  LoaderCircleIcon,
  PlayCircleIcon,
  RefreshCwIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { createPortal } from "react-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  api,
  onFetchAccountProgress,
  type Account,
  type AccountSearchResult,
  type ArticleMatchField,
  type ArticleSummary,
  type FetchAccountProgress,
  type FetchMode,
} from "@/lib/api"
import { runWithProviderExecutionReport } from "@/lib/gateway"
import { normalizeWechatImageUrl } from "@/lib/media"
import { copyText, copyableToast as toast } from "@/lib/toast"
import { openUrl } from "@tauri-apps/plugin-opener"

interface Props {
  account?: Account | null
  fakeid: string | null
  activeAid: string | null
  refreshKey?: number
  onSelect: (aid: string) => void
  onContentFetched?: (aid: string) => void
  onCollectionUpdated?: () => void
}

interface ArticleMenuState {
  article: ArticleSummary
  x: number
  y: number
}

interface AuditSelection {
  date: string
}

type ProcessStepState = "pending" | "running" | "done" | "warning" | "error"

type CollectionTask = FetchMode | "content"

const MAX_RESUME_PROGRESS_EVENTS = 24
const RESUME_BATCH_SIZE = 20
const MAX_RESUME_LIMIT = 500
const MIN_CONTENT_SEARCH_LENGTH = 2
const CONTENT_SEARCH_DEBOUNCE_MS = 220
const CONTENT_FILL_INTERVAL_MS = 1200
const MAX_CONTENT_FILL_FAILURES = 3

const RESUME_MODE_LABELS: Record<CollectionTask, string> = {
  forward: "向前续抓",
  backward: "向后续抓",
  audit: "完备性回扫",
  content: "补齐正文",
}

export function ArticleList({
  account,
  fakeid,
  activeAid,
  refreshKey = 0,
  onSelect,
  onContentFetched,
  onCollectionUpdated,
}: Props) {
  const [items, setItems] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [resumeMode, setResumeMode] = useState<CollectionTask>("forward")
  const [resumeLimit, setResumeLimit] = useState(RESUME_BATCH_SIZE)
  const [resumeAuditDate, setResumeAuditDate] = useState<string | null>(null)
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
  const [resumeProgressEvents, setResumeProgressEvents] = useState<
    FetchAccountProgress[]
  >([])
  const [cancellingResume, setCancellingResume] = useState(false)
  const [auditDialogOpen, setAuditDialogOpen] = useState(false)
  const [q, setQ] = useState("")
  const [menu, setMenu] = useState<ArticleMenuState | null>(null)
  const [fetchingAid, setFetchingAid] = useState<string | null>(null)
  const [searchItems, setSearchItems] = useState<ArticleSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState("")
  const [searchError, setSearchError] = useState<string | null>(null)
  const [contentSearchVersion, setContentSearchVersion] = useState(0)
  const selectedAccount = account?.fakeid === fakeid ? account : null
  const resumeActiveRef = useRef(false)
  const contentFillCancelRef = useRef(false)
  const articleSearchCacheRef = useRef(new Map<string, ArticleSummary[]>())

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

  useEffect(() => {
    if (!selectedAccount) return

    let active = true
    const progressFakeid = selectedAccount.fakeid
    const progress = onFetchAccountProgress((event) => {
      if (
        !active ||
        !resumeActiveRef.current ||
        event.fakeid !== progressFakeid
      ) {
        return
      }
      setResumeProgressEvents((current) => appendProgressEvent(current, event))
    })

    return () => {
      active = false
      progress.then((unlisten) => unlisten())
    }
  }, [selectedAccount])

  const trimmedQuery = q.trim()
  const debouncedSearchQuery = useDebouncedValue(
    trimmedQuery,
    CONTENT_SEARCH_DEBOUNCE_MS
  )

  useEffect(() => {
    if (!fakeid || !debouncedSearchQuery) {
      setSearchItems([])
      setSearchedQuery("")
      setSearchError(null)
      setSearching(false)
      return
    }

    if (debouncedSearchQuery.length < MIN_CONTENT_SEARCH_LENGTH) {
      setSearchItems([])
      setSearchedQuery("")
      setSearchError(null)
      setSearching(false)
      return
    }

    const cacheKey = articleSearchCacheKey(
      fakeid,
      debouncedSearchQuery,
      contentSearchVersion
    )
    const cachedSearchItems = articleSearchCacheRef.current.get(cacheKey)
    if (cachedSearchItems) {
      setSearchItems(cachedSearchItems)
      setSearchedQuery(debouncedSearchQuery)
      setSearchError(null)
      setSearching(false)
      return
    }

    let cancelled = false
    setSearchError(null)
    setSearching(true)

    api
      .searchArticles(fakeid, debouncedSearchQuery)
      .then((result) => {
        if (cancelled) return
        articleSearchCacheRef.current.set(cacheKey, result)
        pruneArticleSearchCache(articleSearchCacheRef.current)
        setSearchItems(result)
        setSearchedQuery(debouncedSearchQuery)
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

    return () => {
      cancelled = true
    }
  }, [fakeid, debouncedSearchQuery, refreshKey, contentSearchVersion])

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
  const nextResumeLimit = nextResumeTarget(items.length)
  const collectionBusy = Boolean(fetchingAid) || resuming
  const canRunCollectionAction =
    Boolean(selectedAccount) && !loading && !collectionBusy
  const canResume = canRunCollectionAction && items.length < MAX_RESUME_LIMIT
  const canAudit = canRunCollectionAction && items.length > 0

  const cachedCount = useMemo(
    () => items.filter((item) => item.has_content).length,
    [items]
  )
  const missingContentCount = items.length - cachedCount
  const canFillContent = canRunCollectionAction && missingContentCount > 0

  const fetchArticleContent = async (article: ArticleSummary) => {
    if (collectionBusy) return

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

  const resumeCollection = async (
    mode: FetchMode,
    auditSelection?: AuditSelection
  ) => {
    if (!selectedAccount) return
    if (mode === "audit" ? !canAudit : !canResume) return

    const initialCount = items.length
    const targetLimit = mode === "audit" ? MAX_RESUME_LIMIT : nextResumeLimit
    const label = RESUME_MODE_LABELS[mode]
    const auditDate = mode === "audit" ? (auditSelection?.date ?? null) : null
    const startEvent = initialResumeProgress(
      selectedAccount,
      targetLimit,
      mode,
      auditDate
    )
    resumeActiveRef.current = true
    setResumeMode(mode)
    setResumeLimit(targetLimit)
    setResumeAuditDate(auditDate)
    setResumeProgressEvents([startEvent])
    setCancellingResume(false)
    setResumeDialogOpen(true)
    setResuming(true)
    toast.info(
      mode === "audit"
        ? `正在检测 ${selectedAccount.nickname}${formatAuditDatePhrase(auditDate)}的文章完备性`
        : `正在${label} ${selectedAccount.nickname}，目标索引 ${targetLimit} 篇`
    )
    try {
      await api.fetchSelectedAccount(
        accountToSearchResult(selectedAccount),
        targetLimit,
        false,
        mode,
        auditDate
      )
      const updatedItems = await api.listArticles(selectedAccount.fakeid)
      const sortedItems = [...updatedItems].sort(
        (a, b) => b.create_time - a.create_time
      )
      setItems(sortedItems)
      setContentSearchVersion((current) => current + 1)
      onCollectionUpdated?.()
      const addedCount = sortedItems.length - initialCount
      const successMessage =
        mode === "audit"
          ? addedCount > 0
            ? `${formatAuditDateScope(auditDate)}完备性检测完成，补漏 ${addedCount} 篇`
            : `${formatAuditDateScope(auditDate)}完备性检测完成，未发现遗漏`
          : addedCount > 0
            ? `${label}完成，新增 ${addedCount} 篇索引`
            : `${label}完成，当前没有新增文章`
      setResumeProgressEvents((current) =>
        appendProgressEvent(current, {
          fakeid: selectedAccount.fakeid,
          nickname: selectedAccount.nickname,
          stage: "complete",
          status: "done",
          message: successMessage,
          current: targetLimit,
          total: targetLimit,
          title: null,
        })
      )
      toast.success(successMessage)
    } catch (error) {
      const message = errorMessage(error)
      if (isFetchInterruptedMessage(message)) {
        const interruptedMessage =
          mode === "audit" ? "完备性检测已打断" : `${label}已打断`
        setResumeProgressEvents((current) =>
          appendProgressEvent(current, {
            fakeid: selectedAccount.fakeid,
            nickname: selectedAccount.nickname,
            stage: "cancel",
            status: "warning",
            message: interruptedMessage,
            current: null,
            total: targetLimit,
            title: null,
          })
        )
        try {
          const updatedItems = await api.listArticles(selectedAccount.fakeid)
          const sortedItems = sortedArticlesByCreateTime(updatedItems)
          setItems(sortedItems)
          setContentSearchVersion((current) => current + 1)
          onCollectionUpdated?.()
        } catch (refreshError) {
          console.warn(
            "Unable to refresh articles after fetch interruption",
            refreshError
          )
        }
        toast.info(interruptedMessage)
        return
      }
      setResumeProgressEvents((current) =>
        appendProgressEvent(current, {
          fakeid: selectedAccount.fakeid,
          nickname: selectedAccount.nickname,
          stage: "error",
          status: "error",
          message,
          current: null,
          total: targetLimit,
          title: null,
        })
      )
      toast.wxmpError(message, api.openLogin)
    } finally {
      resumeActiveRef.current = false
      setResuming(false)
      setCancellingResume(false)
    }
  }

  const fillMissingContents = async () => {
    if (!selectedAccount || !canFillContent) return

    const missing = sortedArticlesByCreateTime(items).filter(
      (item) => !item.has_content
    )
    if (missing.length === 0) return

    const total = missing.length
    const pushEvent = (
      event: Omit<FetchAccountProgress, "fakeid" | "nickname">
    ) =>
      setResumeProgressEvents((current) =>
        appendProgressEvent(current, {
          fakeid: selectedAccount.fakeid,
          nickname: selectedAccount.nickname,
          ...event,
        })
      )

    contentFillCancelRef.current = false
    setResumeMode("content")
    setResumeLimit(total)
    setResumeAuditDate(null)
    setResumeProgressEvents([
      {
        fakeid: selectedAccount.fakeid,
        nickname: selectedAccount.nickname,
        stage: "prepare",
        status: "done",
        message: `共 ${total.toLocaleString()} 篇文章缺失正文，开始补齐`,
        current: 0,
        total,
        title: null,
      },
    ])
    setCancellingResume(false)
    setResumeDialogOpen(true)
    setResuming(true)
    toast.info(`正在补齐 ${selectedAccount.nickname} 的 ${total} 篇正文`)

    let succeeded = 0
    let failed = 0
    let consecutiveFailures = 0

    try {
      for (const [index, article] of missing.entries()) {
        if (contentFillCancelRef.current) break
        if (index > 0) {
          // 篇间节流，避免高频请求触发微信风控
          await sleep(CONTENT_FILL_INTERVAL_MS)
          if (contentFillCancelRef.current) break
        }

        setFetchingAid(article.aid)
        pushEvent({
          stage: "content",
          status: "running",
          message: "正在抓取正文",
          current: index,
          total,
          title: article.title,
        })

        try {
          const updated = await runWithProviderExecutionReport(
            {
              endpoint: "fetch_article_content",
              observedValue: {
                aid: article.aid,
                fakeid: article.fakeid,
                force: false,
              },
              targetFakeid: article.fakeid,
            },
            () => api.fetchArticleContent(article.aid, false)
          )
          setItems((current) =>
            current.map((item) =>
              item.aid === updated.aid
                ? { ...item, has_content: updated.has_content }
                : item
            )
          )
          onContentFetched?.(updated.aid)
          succeeded += 1
          consecutiveFailures = 0
          pushEvent({
            stage: "content",
            status: "done",
            message: "正文已写入缓存",
            current: index + 1,
            total,
            title: article.title,
          })
        } catch (error) {
          failed += 1
          consecutiveFailures += 1
          pushEvent({
            stage: "content",
            status: "warning",
            message: `抓取失败：${errorMessage(error)}`,
            current: index + 1,
            total,
            title: article.title,
          })
          if (consecutiveFailures >= MAX_CONTENT_FILL_FAILURES) {
            pushEvent({
              stage: "error",
              status: "error",
              message: `连续失败 ${consecutiveFailures} 次，已停止补齐`,
              current: index + 1,
              total,
              title: null,
            })
            toast.wxmpError(errorMessage(error), api.openLogin)
            return
          }
        }
      }

      const interrupted = contentFillCancelRef.current
      const summary = `成功 ${succeeded} 篇${failed > 0 ? `，失败 ${failed} 篇` : ""}`
      const message = interrupted
        ? `补齐正文已打断，${summary}`
        : `补齐正文完成，${summary}`
      pushEvent({
        stage: interrupted ? "cancel" : "complete",
        status: interrupted ? "warning" : "done",
        message,
        current: succeeded + failed,
        total,
        title: null,
      })
      if (interrupted) toast.info(message)
      else toast.success(message)
    } finally {
      if (succeeded > 0) setContentSearchVersion((current) => current + 1)
      setFetchingAid(null)
      setResuming(false)
      setCancellingResume(false)
    }
  }

  const interruptResume = async () => {
    if (!selectedAccount || !resuming || cancellingResume) {
      return
    }

    if (resumeMode === "content") {
      contentFillCancelRef.current = true
      setCancellingResume(true)
      setResumeProgressEvents((current) =>
        appendProgressEvent(current, {
          fakeid: selectedAccount.fakeid,
          nickname: selectedAccount.nickname,
          stage: "cancel",
          status: "warning",
          message: "正在打断补齐正文",
          current: null,
          total: resumeLimit,
          title: null,
        })
      )
      return
    }

    const label =
      resumeMode === "audit" ? "完备性检测" : RESUME_MODE_LABELS[resumeMode]
    setCancellingResume(true)
    setResumeProgressEvents((current) =>
      appendProgressEvent(current, {
        fakeid: selectedAccount.fakeid,
        nickname: selectedAccount.nickname,
        stage: "cancel",
        status: "warning",
        message: `正在打断${label}`,
        current: null,
        total: resumeLimit,
        title: null,
      })
    )

    try {
      const interrupted = await api.cancelFetchAccount(selectedAccount.fakeid)
      if (!interrupted) {
        setCancellingResume(false)
        toast.info("当前没有可打断的抓取任务")
      }
    } catch (error) {
      setCancellingResume(false)
      toast.error(errorMessage(error))
    }
  }

  return (
    <aside className="article-list-panel flex h-full min-h-0 w-[min(420px,100%)] max-w-full shrink-0 flex-col overflow-hidden">
      <div className="border-b border-border/70 px-4 py-3">
        <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="font-heading text-xl leading-tight font-semibold text-foreground">
              文章索引
            </div>
            <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              {fakeid
                ? `${filtered.length.toLocaleString()} / ${items.length.toLocaleString()} 篇`
                : "未选择公众号"}
              {fakeid && (
                <>
                  <span className="text-border">/</span>
                  <span>{cachedCount.toLocaleString()} 篇正文</span>
                </>
              )}
            </div>
          </div>
          <div className="mt-0.5 inline-flex shrink-0">
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="h-7 rounded-l-lg rounded-r-none border-r-0 px-2.5"
              disabled={!canResume}
              title={`向前续抓到 ${nextResumeLimit} 篇索引（最新方向）`}
              onClick={() => void resumeCollection("forward")}
            >
              {resuming ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : (
                <PlayCircleIcon className="size-3.5" />
              )}
              {resuming ? `${RESUME_MODE_LABELS[resumeMode]}中` : "向前续抓"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  className="h-7 rounded-l-none rounded-r-lg px-1.5"
                  disabled={!canResume && !canAudit}
                  aria-label="更多抓取选项"
                  title="更多抓取选项"
                >
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    void resumeCollection("forward")
                  }}
                  disabled={!canResume}
                >
                  <PlayCircleIcon className="size-4" />
                  <div className="flex flex-col">
                    <span>向前续抓</span>
                    <span className="text-[11px] text-muted-foreground">
                      从最新开始，目标 {nextResumeLimit} 篇
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    void resumeCollection("backward")
                  }}
                  disabled={!canResume || items.length === 0}
                >
                  <HistoryIcon className="size-4" />
                  <div className="flex flex-col">
                    <span>向后续抓</span>
                    <span className="text-[11px] text-muted-foreground">
                      从本地最老一篇之后向旧再抓 {RESUME_BATCH_SIZE} 篇
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    setAuditDialogOpen(true)
                  }}
                  disabled={!canAudit}
                >
                  <RefreshCwIcon className="size-4" />
                  <div className="flex flex-col">
                    <span>检测完备性</span>
                    <span className="text-[11px] text-muted-foreground">
                      选择日期，精确检测当天文章是否缺漏
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    void fillMissingContents()
                  }}
                  disabled={!canFillContent}
                >
                  <DownloadIcon className="size-4" />
                  <div className="flex flex-col">
                    <span>补齐全部正文</span>
                    <span className="text-[11px] text-muted-foreground">
                      {missingContentCount > 0
                        ? `逐篇抓取 ${missingContentCount.toLocaleString()} 篇缺失正文`
                        : "所有文章正文均已抓取"}
                    </span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
          busy={collectionBusy}
          onClose={() => setMenu(null)}
          onSelect={() => onSelect(menu.article.aid)}
          onFetchContent={fetchArticleContent}
        />
      )}
      {auditDialogOpen && selectedAccount ? (
        <AuditDateDialog
          account={selectedAccount}
          busy={resuming}
          items={items}
          onClose={() => setAuditDialogOpen(false)}
          onSubmit={(selection) => {
            setAuditDialogOpen(false)
            void resumeCollection("audit", selection)
          }}
        />
      ) : null}
      {resumeDialogOpen && selectedAccount ? (
        <ResumeProgressDialog
          account={selectedAccount}
          auditDate={resumeAuditDate}
          busy={resuming}
          cancelling={cancellingResume}
          events={resumeProgressEvents}
          limit={resumeLimit}
          mode={resumeMode}
          onCancel={resuming ? interruptResume : undefined}
          onClose={() => setResumeDialogOpen(false)}
        />
      ) : null}
    </aside>
  )
}

function ResumeProgressDialog({
  account,
  auditDate,
  busy,
  cancelling = false,
  events,
  limit,
  mode,
  onCancel,
  onClose,
}: {
  account: Account
  auditDate: string | null
  busy: boolean
  cancelling?: boolean
  events: FetchAccountProgress[]
  limit: number
  mode: CollectionTask
  onCancel?: () => void
  onClose: () => void
}) {
  const modeLabel = RESUME_MODE_LABELS[mode]
  const visibleEvents =
    events.length > 0
      ? events
      : [initialResumeProgress(account, limit, mode, auditDate)]
  const latest = visibleEvents[visibleEvents.length - 1]
  const progressEvent =
    [...visibleEvents]
      .reverse()
      .find(
        (event) =>
          typeof event.current === "number" &&
          typeof event.total === "number" &&
          event.total > 0
      ) ?? latest
  const current =
    typeof progressEvent.current === "number" ? progressEvent.current : 0
  const total =
    typeof progressEvent.total === "number" && progressEvent.total > 0
      ? progressEvent.total
      : limit
  const progressPercent =
    total > 0 ? Math.min(Math.max((current / total) * 100, 0), 100) : 0
  const recentEvents = visibleEvents.slice(-7)

  const closeIfIdle = () => {
    if (!busy) onClose()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeIfIdle()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="resume-progress-title"
        className="dialog-panel w-full max-w-[560px] rounded-xl p-4 text-card-foreground shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              id="resume-progress-title"
              className="font-heading text-lg leading-tight font-semibold"
            >
              {mode === "content" ? "补齐全部正文" : `${modeLabel}文章索引`}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {account.nickname} ·{" "}
              {mode === "audit"
                ? formatAuditDateScope(auditDate)
                : mode === "content"
                  ? `补齐 ${limit.toLocaleString()} 篇正文`
                  : `目标 ${limit.toLocaleString()} 篇`}
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={busy}
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <div className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium">{latest.message}</div>
              {latest.title ? (
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {latest.title}
                </div>
              ) : null}
            </div>
            <ProgressStateIcon state={eventState(latest)} />
          </div>

          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>

          <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>实时进度</span>
            <span className="font-mono text-foreground">
              {Math.min(current, total).toLocaleString()} /{" "}
              {total.toLocaleString()}
            </span>
          </div>
        </div>

        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          {resumeSteps(mode).map((step) => {
            const state = processStepState(step.stages, visibleEvents)
            return (
              <div
                key={step.label}
                className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-background/55 px-2.5 py-2"
              >
                <ProgressStateIcon state={state} small />
                <span className="truncate text-xs text-muted-foreground">
                  {step.label}
                </span>
              </div>
            )
          })}
        </div>

        <div className="mt-4 max-h-40 space-y-1 overflow-y-auto pr-1">
          {recentEvents.map((event, index) => {
            const isLatest = index === recentEvents.length - 1
            const rawState = eventState(event)
            const state: ProcessStepState =
              !isLatest && rawState === "running" ? "done" : rawState
            return (
              <div
                key={`${event.stage}-${event.status}-${event.current ?? "x"}-${index}`}
                className="flex min-w-0 items-start gap-2 rounded-md px-1 py-0.5 text-xs leading-5"
              >
                <ProgressStateIcon state={state} small />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-foreground/85">
                    {formatProgressMessage(event)}
                  </div>
                  {event.title ? (
                    <div className="truncate text-muted-foreground">
                      {event.title}
                    </div>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          {busy && onCancel ? (
            <Button
              type="button"
              variant="destructive"
              disabled={cancelling}
              onClick={onCancel}
            >
              {cancelling ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <XIcon className="size-4" />
              )}
              {cancelling ? "打断中" : "打断"}
            </Button>
          ) : null}
          <Button type="button" disabled={busy} onClick={onClose}>
            {busy ? (
              <LoaderCircleIcon className="size-4 animate-spin" />
            ) : (
              <CheckCircle2Icon className="size-4" />
            )}
            {busy ? `${modeLabel}中` : "完成"}
          </Button>
        </div>
      </section>
    </div>,
    document.body
  )
}

function AuditDateDialog({
  account,
  busy,
  items,
  onClose,
  onSubmit,
}: {
  account: Account
  busy: boolean
  items: ArticleSummary[]
  onClose: () => void
  onSubmit: (selection: AuditSelection) => void
}) {
  const auditableItems = useMemo(
    () => sortedArticlesByCreateTime(items).slice(0, MAX_RESUME_LIMIT),
    [items]
  )
  const newestDate = auditableItems[0]
    ? formatDate(auditableItems[0].create_time)
    : currentDateInputValue()
  const oldestDate = auditableItems[auditableItems.length - 1]
    ? formatDate(auditableItems[auditableItems.length - 1].create_time)
    : newestDate
  const [selectedDate, setSelectedDate] = useState(oldestDate)
  const normalizedDate = clampDateInput(selectedDate, oldestDate, newestDate)
  const dayArticleCount = auditDayCountForDate(auditableItems, normalizedDate)
  const canSubmit = Boolean(normalizedDate) && !busy

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/35 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="audit-date-title"
        className="dialog-panel w-full max-w-[520px] rounded-xl p-4 text-card-foreground shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div
              id="audit-date-title"
              className="font-heading text-lg leading-tight font-semibold"
            >
              检测完备性
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {account.nickname}
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={busy}
            onClick={onClose}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <div className="mt-4 space-y-2">
          <Label htmlFor="audit-check-date">检测日期</Label>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
            <Input
              id="audit-check-date"
              type="date"
              min={oldestDate}
              max={newestDate}
              value={selectedDate}
              disabled={busy}
              onChange={(event) => setSelectedDate(event.target.value)}
            />
            <div className="flex min-h-8 items-center rounded-lg border border-border/70 bg-muted/30 px-3 text-xs text-muted-foreground">
              {oldestDate} 至 {newestDate}
            </div>
          </div>
          <div className="text-xs leading-5 text-muted-foreground">
            将检测 {normalizedDate || "所选日期"} 当天的所有文章，当前本地当天{" "}
            <span className="font-mono text-foreground">
              {dayArticleCount.toLocaleString()}
            </span>{" "}
            篇；执行时由 wcx 按日期边界自动覆盖当天。
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </Button>
          <Button
            type="button"
            disabled={!canSubmit}
            onClick={() =>
              onSubmit({
                date: normalizedDate,
              })
            }
          >
            <RefreshCwIcon className="size-4" />
            开始检测
          </Button>
        </div>
      </section>
    </div>,
    document.body
  )
}

function ProgressStateIcon({
  state,
  small = false,
}: {
  state: ProcessStepState
  small?: boolean
}) {
  const className = small ? "size-3" : "size-4"

  if (state === "running") {
    return (
      <LoaderCircleIcon
        className={cn(className, "shrink-0 animate-spin text-primary")}
      />
    )
  }

  if (state === "done") {
    return (
      <CheckCircle2Icon className={cn(className, "shrink-0 text-primary")} />
    )
  }

  if (state === "error" || state === "warning") {
    return (
      <AlertCircleIcon
        className={cn(
          className,
          "shrink-0",
          state === "error" ? "text-destructive" : "text-primary"
        )}
      />
    )
  }

  return (
    <CircleIcon className={cn(className, "shrink-0 text-muted-foreground")} />
  )
}

function initialResumeProgress(
  account: Pick<Account, "fakeid" | "nickname">,
  limit: number,
  mode: CollectionTask = "forward",
  auditDate: string | null = null
): FetchAccountProgress {
  const label = RESUME_MODE_LABELS[mode]
  const message =
    mode === "audit"
      ? auditDate
        ? `准备${label}，检测 ${auditDate} 当天`
        : `准备${label}，目标重扫 ${limit.toLocaleString()} 篇索引`
      : mode === "content"
        ? `准备补齐 ${limit.toLocaleString()} 篇正文`
        : `准备${label}到 ${limit.toLocaleString()} 篇文章索引`
  return {
    fakeid: account.fakeid,
    nickname: account.nickname,
    stage: "prepare",
    status: "running",
    message,
    current: 0,
    total: limit,
    title: null,
  }
}

function appendProgressEvent(
  events: FetchAccountProgress[],
  next: FetchAccountProgress
) {
  const last = events[events.length - 1]
  if (
    last &&
    last.stage === next.stage &&
    last.status === next.status &&
    last.message === next.message &&
    last.current === next.current &&
    last.total === next.total &&
    last.title === next.title
  ) {
    return events
  }

  return [...events, next].slice(-MAX_RESUME_PROGRESS_EVENTS)
}

function nextResumeTarget(currentCount: number) {
  const normalizedCount = Math.max(currentCount, 0)
  if (normalizedCount >= MAX_RESUME_LIMIT) return MAX_RESUME_LIMIT
  return Math.min(
    Math.max(normalizedCount + RESUME_BATCH_SIZE, RESUME_BATCH_SIZE),
    MAX_RESUME_LIMIT
  )
}

function sortedArticlesByCreateTime(items: ArticleSummary[]) {
  return [...items].sort((a, b) => b.create_time - a.create_time)
}

function auditDayCountForDate(items: ArticleSummary[], dateInput: string) {
  const range = dateUnixRange(dateInput)
  if (!range) return 0
  const [start, end] = range
  return items.filter(
    (item) => item.create_time >= start && item.create_time < end
  ).length
}

function dateUnixRange(dateInput: string): [number, number] | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateInput)) return null
  const [year, month, day] = dateInput.split("-").map(Number)
  const start = new Date(year, month - 1, day).getTime() / 1000
  const end = new Date(year, month - 1, day + 1).getTime() / 1000
  return [start, end]
}

function clampDateInput(value: string, min: string, max: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return ""
  if (value < min) return min
  if (value > max) return max
  return value
}

function currentDateInputValue() {
  const now = new Date()
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

function formatAuditDateScope(date: string | null) {
  return date ? `检测 ${date} 当天` : "检测当前区间"
}

function formatAuditDatePhrase(date: string | null) {
  return date ? ` ${date} 当天` : ""
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

function isFetchInterruptedMessage(message: string) {
  const normalized = message.toLowerCase()
  return (
    message.includes("已打断") ||
    normalized.includes("cancelled") ||
    normalized.includes("canceled")
  )
}

function resumeSteps(mode: CollectionTask) {
  if (mode === "content") {
    return [
      { label: "确认目标", stages: ["prepare"] },
      { label: "抓取正文", stages: ["content"] },
      { label: "完成入库", stages: ["complete"] },
    ]
  }
  return [
    { label: "确认目标", stages: ["prepare"] },
    { label: "同步账号", stages: ["account"] },
    { label: "续抓索引", stages: ["articles"] },
    { label: "完成入库", stages: ["complete"] },
  ]
}

function processStepState(
  stages: string[],
  events: FetchAccountProgress[]
): ProcessStepState {
  if (
    events.some(
      (event) => event.status === "error" && stages.includes(event.stage)
    )
  ) {
    return "error"
  }

  if (
    events.some(
      (event) => event.status === "warning" && stages.includes(event.stage)
    )
  ) {
    return "warning"
  }

  if (
    events.some(
      (event) => event.status === "done" && stages.includes(event.stage)
    )
  ) {
    return "done"
  }

  if (
    events.some(
      (event) => event.status === "running" && stages.includes(event.stage)
    )
  ) {
    return "running"
  }

  const latest = events[events.length - 1]
  if (latest?.stage === "complete" && latest.status === "done") return "done"

  return "pending"
}

function eventState(event: FetchAccountProgress): ProcessStepState {
  if (event.status === "done") return "done"
  if (event.status === "warning") return "warning"
  if (event.status === "error") return "error"
  if (event.status === "running") return "running"
  return "pending"
}

function formatProgressMessage(event: FetchAccountProgress) {
  if (
    typeof event.current === "number" &&
    typeof event.total === "number" &&
    event.total > 0
  ) {
    return `${event.message} (${event.current}/${event.total})`
  }

  return event.message
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
  busy,
  onClose,
  onSelect,
  onFetchContent,
}: {
  menu: ArticleMenuState
  fetchingAid: string | null
  busy: boolean
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
        disabled={busy}
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

function accountToSearchResult(account: Account): AccountSearchResult {
  return {
    fakeid: account.fakeid,
    nickname: account.nickname,
    alias: account.alias,
    signature: account.signature,
    avatar: account.avatar,
  }
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delayMs)
    return () => window.clearTimeout(timeout)
  }, [delayMs, value])

  return debouncedValue
}

function articleSearchCacheKey(
  fakeid: string,
  query: string,
  contentSearchVersion: number
) {
  return `${fakeid}:${contentSearchVersion}:${query}`
}

function pruneArticleSearchCache(cache: Map<string, ArticleSummary[]>) {
  const maxEntries = 40
  if (cache.size <= maxEntries) return

  for (const key of cache.keys()) {
    cache.delete(key)
    if (cache.size <= maxEntries) return
  }
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
