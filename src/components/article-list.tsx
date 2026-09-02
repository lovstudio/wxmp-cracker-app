import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  AlertCircleIcon,
  BarChart3Icon,
  CalendarIcon,
  CheckIcon,
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  FileX2Icon,
  FolderOpenIcon,
  HistoryIcon,
  LinkIcon,
  ListFilterIcon,
  LoaderCircleIcon,
  PencilIcon,
  PlayCircleIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { createPortal } from "react-dom"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import {
  api,
  notifyArticlePublicMetricsUpdated,
  onFetchAccountProgress,
  type Account,
  type AccountSearchResult,
  type ArticleMatchField,
  type ArticlePublicMetricsSnapshot,
  type ArticleSummary,
  type ArticleTag,
  type FetchAccountProgress,
  type FetchMode,
} from "@/lib/api"
import { runWithProviderExecutionReport } from "@/lib/gateway"
import {
  DEFAULT_ARTICLE_FILTERS,
  activeArticleFilterCount,
  articleTagFilterName,
  articleTagFilterValue,
  articleTypeBucket,
  copyrightBucket,
  filterArticles,
  filterArticlesByTag,
  type ArticleFilters,
  type ArticleTagFilter,
  type ArticleTypeFilter,
  type ContentCacheFilter,
  type CopyrightFilter,
} from "@/lib/article-filters"
import {
  initialResumeProgress,
  RESUME_MODE_LABELS,
  type CollectionTask,
} from "@/lib/article-fetch-progress"
import { normalizeWechatImageUrl } from "@/lib/media"
import { copyText, copyableToast as toast, isWxmpAuthError } from "@/lib/toast"
import { openUrl } from "@tauri-apps/plugin-opener"

interface Props {
  account?: Account | null
  fakeid: string | null
  wechatLoggedIn: boolean
  wechatAuthChecking: boolean
  activeAid: string | null
  query?: string
  refreshKey?: number
  onSelect: (aid: string) => void
  onQueryChange?: (query: string) => void
  onContentFetched?: (aid: string) => void
  onCollectionUpdated?: () => void
  onWechatLogin: () => void
  onWechatSessionInvalid: () => void
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

type PendingWechatAction =
  | {
      kind: "article-content"
      accountFakeid: string
      article: ArticleSummary
    }
  | {
      kind: "resume"
      accountFakeid: string
      mode: FetchMode
      auditSelection?: AuditSelection
    }
  | {
      kind: "fill-content"
      accountFakeid: string
    }

const MAX_RESUME_PROGRESS_EVENTS = 24
const DEFAULT_FETCH_LIMIT = 10
const MAX_RESUME_LIMIT = 500
const MIN_CONTENT_SEARCH_LENGTH = 2
const CONTENT_SEARCH_DEBOUNCE_MS = 220
const CONTENT_FILL_INTERVAL_MS = 1200
const MAX_CONTENT_FILL_FAILURES = 3

export function ArticleList({
  account,
  fakeid,
  wechatLoggedIn,
  wechatAuthChecking,
  activeAid,
  query,
  refreshKey = 0,
  onSelect,
  onQueryChange,
  onContentFetched,
  onCollectionUpdated,
  onWechatLogin,
  onWechatSessionInvalid,
}: Props) {
  const [items, setItems] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [resumeMode, setResumeMode] = useState<CollectionTask>("forward")
  const [resumeLimit, setResumeLimit] = useState(DEFAULT_FETCH_LIMIT)
  const [resumeAuditDate, setResumeAuditDate] = useState<string | null>(null)
  const [resumeBatchInput, setResumeBatchInput] = useState(
    String(DEFAULT_FETCH_LIMIT)
  )
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false)
  const [resumeProgressEvents, setResumeProgressEvents] = useState<
    FetchAccountProgress[]
  >([])
  const [cancellingResume, setCancellingResume] = useState(false)
  const [auditDialogOpen, setAuditDialogOpen] = useState(false)
  const [uncontrolledQuery, setUncontrolledQuery] = useState("")
  const [menu, setMenu] = useState<ArticleMenuState | null>(null)
  const [fetchingAid, setFetchingAid] = useState<string | null>(null)
  const [metricsUpdatingAid, setMetricsUpdatingAid] = useState<string | null>(
    null
  )
  const [searchItems, setSearchItems] = useState<ArticleSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState("")
  const [searchError, setSearchError] = useState<string | null>(null)
  const [contentSearchVersion, setContentSearchVersion] = useState(0)
  const [pendingWechatAction, setPendingWechatAction] =
    useState<PendingWechatAction | null>(null)
  const [tagDialog, setTagDialog] = useState<{
    article: ArticleSummary
    focusCreate: boolean
  } | null>(null)
  const [tagOptions, setTagOptions] = useState<ArticleTag[]>([])
  const [tagsLoading, setTagsLoading] = useState(false)
  const [tagError, setTagError] = useState<string | null>(null)
  const [tagActionKey, setTagActionKey] = useState<string | null>(null)
  const [articleFilters, setArticleFilters] = useState<ArticleFilters>(
    DEFAULT_ARTICLE_FILTERS
  )
  const [articleTagFilter, setArticleTagFilter] =
    useState<ArticleTagFilter>("all")
  const selectedAccount = account?.fakeid === fakeid ? account : null
  const q = query ?? uncontrolledQuery
  const resumeActiveRef = useRef(false)
  const contentFillCancelRef = useRef(false)
  const articleSearchCacheRef = useRef(new Map<string, ArticleSummary[]>())
  const updateQuery = (nextQuery: string) => {
    if (query === undefined) {
      setUncontrolledQuery(nextQuery)
    }
    onQueryChange?.(nextQuery)
  }
  const resetArticleFilters = () => {
    setArticleFilters(DEFAULT_ARTICLE_FILTERS)
    setArticleTagFilter("all")
  }

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

  const activeTagArticleAid =
    tagDialog?.article.aid ?? menu?.article.aid ?? null
  useEffect(() => {
    if (!activeTagArticleAid) {
      setTagOptions([])
      setTagError(null)
      setTagsLoading(false)
      return
    }

    let cancelled = false
    setTagsLoading(true)
    setTagError(null)
    api
      .listArticleTags(activeTagArticleAid)
      .then((tags) => {
        if (!cancelled) setTagOptions(tags)
      })
      .catch((error) => {
        if (cancelled) return
        setTagOptions([])
        setTagError(errorMessage(error))
      })
      .finally(() => {
        if (!cancelled) setTagsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [activeTagArticleAid])

  useEffect(() => {
    setArticleFilters(DEFAULT_ARTICLE_FILTERS)
    setArticleTagFilter("all")
  }, [fakeid])

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
    listArticlesWithTags(fakeid)
      .then((articles) => {
        if (!cancelled) setItems(articles)
      })
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

  const matchedArticles = useMemo(() => {
    if (!(trimmedQuery && searchedQuery === trimmedQuery && !searchError)) {
      return localFiltered
    }

    const tagsByAid = Object.fromEntries(
      items.map((article) => [article.aid, article.tags ?? []])
    )
    return attachArticleTags(searchItems, tagsByAid)
  }, [
    items,
    localFiltered,
    searchError,
    searchItems,
    searchedQuery,
    trimmedQuery,
  ])
  const activeFilterCount =
    activeArticleFilterCount(articleFilters) +
    (articleTagFilter === "all" ? 0 : 1)
  const filtered = useMemo(
    () =>
      filterArticlesByTag(
        filterArticles(matchedArticles, articleFilters),
        articleTagFilter
      ),
    [articleFilters, articleTagFilter, matchedArticles]
  )
  const activeFilterLabels = articleFilterLabels(
    articleFilters,
    articleTagFilter
  )
  const showCollectionBoundaries = Boolean(
    fakeid && !loading && !trimmedQuery && activeFilterCount === 0
  )
  const resumeBatchSize = parseFetchLimitInput(resumeBatchInput)
  const resumeFetchLimit = nextResumeFetchLimit(items.length, resumeBatchSize)
  const collectionBusy = Boolean(fetchingAid) || resuming
  const fetchActionsBlocked =
    collectionBusy || wechatAuthChecking || pendingWechatAction !== null
  const canRunCollectionAction =
    Boolean(selectedAccount) && !loading && !fetchActionsBlocked
  const canResume = canRunCollectionAction && items.length < MAX_RESUME_LIMIT
  const canAudit = canRunCollectionAction && items.length > 0

  const cachedCount = useMemo(
    () => items.filter((item) => item.has_content).length,
    [items]
  )
  const missingContentCount = items.length - cachedCount
  const canFillContent = canRunCollectionAction && missingContentCount > 0
  const missingClassificationCount = useMemo(
    () =>
      items.filter(
        (item) => item.article_type == null || item.copyright_type == null
      ).length,
    [items]
  )
  const canBackfillClassifications =
    canRunCollectionAction && missingClassificationCount > 0

  const queueWechatAction = (
    action: PendingWechatAction,
    sessionInvalid = false
  ) => {
    setPendingWechatAction(action)
    setResumeDialogOpen(false)
    setResumeProgressEvents([])
    if (sessionInvalid) onWechatSessionInvalid()
    else onWechatLogin()
  }

  const reloadArticleTags = async (aid: string) => {
    const tags = await api.listArticleTags(aid)
    setTagOptions(tags)
    setTagError(null)
  }

  const updateArticleTagAssignment = async (
    article: ArticleSummary,
    tag: ArticleTag,
    assigned: boolean
  ) => {
    if (tagActionKey) return false
    const actionKey = `toggle:${tag.id}`
    setTagActionKey(actionKey)
    setTagError(null)
    setTagOptions((current) =>
      current.map((item) =>
        item.id === tag.id
          ? {
              ...item,
              assigned,
              article_count: Math.max(
                0,
                item.article_count + (assigned ? 1 : -1)
              ),
            }
          : item
      )
    )
    try {
      await api.setArticleTag(article.aid, tag.id, assigned)
      setItems((current) =>
        current.map((item) => {
          if (item.aid !== article.aid) return item
          const tags = new Set(item.tags ?? [])
          if (assigned) tags.add(tag.name)
          else tags.delete(tag.name)
          return { ...item, tags: sortedTags(tags) }
        })
      )
      return true
    } catch (error) {
      const message = errorMessage(error)
      setTagError(message)
      setTagOptions((current) =>
        current.map((item) =>
          item.id === tag.id
            ? {
                ...item,
                assigned: tag.assigned,
                article_count: tag.article_count,
              }
            : item
        )
      )
      toast.error(`更新标签失败：${message}`)
      return false
    } finally {
      setTagActionKey(null)
    }
  }

  const createAndAssignArticleTag = async (
    article: ArticleSummary,
    name: string
  ) => {
    if (tagActionKey) return false
    setTagActionKey("create")
    setTagError(null)
    try {
      const tag = await api.createAndAssignArticleTag(article.aid, name)
      await reloadArticleTags(article.aid)
      setItems((current) =>
        current.map((item) =>
          item.aid === article.aid
            ? {
                ...item,
                tags: sortedTags(new Set([...(item.tags ?? []), tag.name])),
              }
            : item
        )
      )
      toast.success(`已新建并添加标签“${tag.name}”`)
      return true
    } catch (error) {
      const message = errorMessage(error)
      setTagError(message)
      toast.error(`新建标签失败：${message}`)
      return false
    } finally {
      setTagActionKey(null)
    }
  }

  const renameArticleTag = async (tag: ArticleTag, name: string) => {
    if (tagActionKey) return false
    setTagActionKey(`rename:${tag.id}`)
    setTagError(null)
    try {
      const updated = await api.updateArticleTag(tag.id, name)
      setTagOptions((current) =>
        current.map((item) =>
          item.id === tag.id ? { ...item, name: updated.name } : item
        )
      )
      setItems((current) =>
        current.map((item) => ({
          ...item,
          tags: sortedTags(
            new Set(
              (item.tags ?? []).map((name) =>
                name === tag.name ? updated.name : name
              )
            )
          ),
        }))
      )
      setArticleTagFilter((current) =>
        current === articleTagFilterValue(tag.name)
          ? articleTagFilterValue(updated.name)
          : current
      )
      toast.success(`标签已重命名为“${updated.name}”`)
      return true
    } catch (error) {
      const message = errorMessage(error)
      setTagError(message)
      toast.error(`编辑标签失败：${message}`)
      return false
    } finally {
      setTagActionKey(null)
    }
  }

  const removeArticleTag = async (tag: ArticleTag) => {
    if (tagActionKey) return false
    setTagActionKey(`delete:${tag.id}`)
    setTagError(null)
    try {
      await api.deleteArticleTag(tag.id)
      setTagOptions((current) => current.filter((item) => item.id !== tag.id))
      setItems((current) =>
        current.map((item) => ({
          ...item,
          tags: (item.tags ?? []).filter((name) => name !== tag.name),
        }))
      )
      setArticleTagFilter((current) =>
        current === articleTagFilterValue(tag.name) ? "all" : current
      )
      toast.success(`已删除标签“${tag.name}”`)
      return true
    } catch (error) {
      const message = errorMessage(error)
      setTagError(message)
      toast.error(`删除标签失败：${message}`)
      return false
    } finally {
      setTagActionKey(null)
    }
  }

  const revealArchiveFolder = async () => {
    try {
      await api.revealArchiveFolder(activeAid, fakeid)
    } catch (error) {
      toast.error(`Reveal 归档文件夹失败：${errorMessage(error)}`)
    }
  }

  const [exportingArchive, setExportingArchive] = useState(false)
  const exportLocalArchive = async () => {
    if (exportingArchive || !selectedAccount) return
    setExportingArchive(true)
    toast.info(`正在导出 ${selectedAccount.nickname} 的本地 Markdown 归档…`)
    try {
      const summary = await api.archiveArticlesLocal({
        account_fakeid: selectedAccount.fakeid,
      })
      toast.success(`已导出 ${summary.rendered} 篇文章到本地归档`)
      await api.revealArchiveFolder(null, selectedAccount.fakeid)
    } catch (error) {
      toast.error(`导出本地归档失败：${errorMessage(error)}`)
    } finally {
      setExportingArchive(false)
    }
  }

  const runFetchArticleContent = async (article: ArticleSummary) => {
    if (collectionBusy) return

    setFetchingAid(article.aid)
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
        article.has_content ? "正文已重新采集" : "正文已采集"
      )
    } catch (error) {
      const message = errorMessage(error)
      if (isWxmpAuthError(message)) {
        queueWechatAction(
          {
            kind: "article-content",
            accountFakeid: article.fakeid,
            article,
          },
          true
        )
        return
      }
      toast.wxmpError(message, api.openLogin)
    } finally {
      setFetchingAid(null)
    }
  }

  const fetchArticleContent = async (article: ArticleSummary) => {
    if (wechatAuthChecking) return
    if (!wechatLoggedIn) {
      queueWechatAction({
        kind: "article-content",
        accountFakeid: article.fakeid,
        article,
      })
      return
    }

    await runFetchArticleContent(article)
  }

  const updateArticlePublicMetrics = async (article: ArticleSummary) => {
    if (metricsUpdatingAid) return
    const startedAt = performance.now()
    console.log("[DEBUG][article-public-metrics] list update entry:", {
      aid: article.aid,
    })
    setMetricsUpdatingAid(article.aid)
    try {
      const snapshot = await api.captureArticlePublicMetrics(article.aid)
      console.log("[DEBUG][article-public-metrics] list update success:", {
        aid: article.aid,
        sourceKind: snapshot.source_kind,
        captureMethod: snapshot.capture_method,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      notifyArticlePublicMetricsUpdated(snapshot)
      toast.success(formatMetricsUpdateToast(snapshot))
    } catch (error) {
      console.log("[DEBUG][article-public-metrics] list update failed:", {
        aid: article.aid,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: errorMessage(error),
      })
      toast.error(`更新阅读量相关数据失败：${errorMessage(error)}`)
    } finally {
      console.log("[DEBUG][article-public-metrics] list update settled:", {
        aid: article.aid,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      setMetricsUpdatingAid(null)
    }
  }

  const runResumeCollection = async (
    mode: FetchMode,
    auditSelection?: AuditSelection
  ) => {
    if (!selectedAccount) return
    if (loading || collectionBusy) return
    if (
      mode === "audit" || mode === "classify"
        ? items.length === 0
        : items.length >= MAX_RESUME_LIMIT
    ) {
      return
    }

    const initialCount = items.length
    const initialMissingClassifications = missingClassificationCount
    const targetLimit =
      mode === "audit"
        ? MAX_RESUME_LIMIT
        : mode === "classify"
          ? Math.min(items.length, MAX_RESUME_LIMIT)
          : resumeFetchLimit
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
    try {
      await api.fetchSelectedAccount(
        accountToSearchResult(selectedAccount),
        targetLimit,
        false,
        mode,
        auditDate
      )
      const updatedItems = await listArticlesWithTags(selectedAccount.fakeid)
      const sortedItems = [...updatedItems].sort(
        (a, b) => b.create_time - a.create_time
      )
      setItems(sortedItems)
      setContentSearchVersion((current) => current + 1)
      onCollectionUpdated?.()
      const addedCount = sortedItems.length - initialCount
      const remainingClassifications = sortedItems.filter(
        (item) => item.article_type == null || item.copyright_type == null
      ).length
      const filledClassifications = Math.max(
        initialMissingClassifications - remainingClassifications,
        0
      )
      const successMessage =
        mode === "audit"
          ? addedCount > 0
            ? `${formatAuditDateScope(auditDate)}完备性检测完成，补漏 ${addedCount} 篇`
            : `${formatAuditDateScope(auditDate)}完备性检测完成，未发现遗漏`
          : mode === "classify"
            ? remainingClassifications > 0
              ? `${label}完成，补齐 ${filledClassifications} 篇，仍有 ${remainingClassifications} 篇未提供完整分类`
              : `${label}完成，${filledClassifications} 篇旧数据已补齐`
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
    } catch (error) {
      const message = errorMessage(error)
      if (isWxmpAuthError(message)) {
        queueWechatAction(
          {
            kind: "resume",
            accountFakeid: selectedAccount.fakeid,
            mode,
            auditSelection,
          },
          true
        )
        return
      }
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
          const updatedItems = await listArticlesWithTags(
            selectedAccount.fakeid
          )
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
    } finally {
      resumeActiveRef.current = false
      setResuming(false)
      setCancellingResume(false)
    }
  }

  const resumeCollection = async (
    mode: FetchMode,
    auditSelection?: AuditSelection
  ) => {
    if (!selectedAccount || wechatAuthChecking) return
    if (!wechatLoggedIn) {
      queueWechatAction({
        kind: "resume",
        accountFakeid: selectedAccount.fakeid,
        mode,
        auditSelection,
      })
      return
    }

    await runResumeCollection(mode, auditSelection)
  }

  const runFillMissingContents = async () => {
    if (!selectedAccount || loading || collectionBusy) return

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
      initialResumeProgress(selectedAccount, total, "content"),
    ])
    setCancellingResume(false)
    setResumeDialogOpen(true)
    setResuming(true)

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
          message: "正在采集正文",
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
            message: "正文已采集",
            current: index + 1,
            total,
            title: article.title,
          })
        } catch (error) {
          const message = errorMessage(error)
          if (isWxmpAuthError(message)) {
            queueWechatAction(
              {
                kind: "fill-content",
                accountFakeid: selectedAccount.fakeid,
              },
              true
            )
            return
          }
          failed += 1
          consecutiveFailures += 1
          pushEvent({
            stage: "content",
            status: "warning",
            message: `采集失败：${message}`,
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
    } finally {
      if (succeeded > 0) setContentSearchVersion((current) => current + 1)
      setFetchingAid(null)
      setResuming(false)
      setCancellingResume(false)
    }
  }

  const fillMissingContents = async () => {
    if (!selectedAccount || wechatAuthChecking) return
    if (!wechatLoggedIn) {
      queueWechatAction({
        kind: "fill-content",
        accountFakeid: selectedAccount.fakeid,
      })
      return
    }

    await runFillMissingContents()
  }

  const pendingWechatActionRunnerRef = useRef<
    (action: PendingWechatAction) => void
  >(() => undefined)
  useEffect(() => {
    pendingWechatActionRunnerRef.current = (action) => {
      if (action.accountFakeid !== selectedAccount?.fakeid) return

      if (action.kind === "article-content") {
        void runFetchArticleContent(action.article)
        return
      }
      if (action.kind === "resume") {
        void runResumeCollection(action.mode, action.auditSelection)
        return
      }
      void runFillMissingContents()
    }
  })

  useEffect(() => {
    if (
      !wechatLoggedIn ||
      wechatAuthChecking ||
      collectionBusy ||
      !pendingWechatAction
    ) {
      return
    }

    const action = pendingWechatAction
    setPendingWechatAction(null)
    queueMicrotask(() => pendingWechatActionRunnerRef.current(action))
  }, [collectionBusy, pendingWechatAction, wechatAuthChecking, wechatLoggedIn])

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
        toast.info("当前没有可打断的采集任务")
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
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="outline"
                  aria-label="更多索引与存储工具"
                  title="更多索引与存储工具"
                >
                  <ChevronDownIcon className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
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
                        ? `逐篇采集 ${missingContentCount.toLocaleString()} 篇缺失正文`
                        : "所有文章正文均已采集"}
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault()
                    void exportLocalArchive()
                  }}
                  disabled={exportingArchive || !selectedAccount}
                >
                  <DownloadIcon className="size-4" />
                  <div className="flex flex-col">
                    <span>导出本地归档（Markdown）</span>
                    <span className="text-[11px] text-muted-foreground">
                      将当前公众号正文导出为本地 md 并打开目录
                    </span>
                  </div>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => {
                    void revealArchiveFolder()
                  }}
                  disabled={!selectedAccount}
                >
                  <FolderOpenIcon className="size-4" />
                  <div className="flex flex-col">
                    <span>Reveal 归档文件夹</span>
                    <span className="text-[11px] text-muted-foreground">
                      打开当前公众号的本地归档目录
                    </span>
                  </div>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <div className="flex min-w-0 items-stretch gap-2">
          <div className="search-shell relative min-w-0 flex-1 rounded-lg">
            <SearchIcon className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => updateQuery(e.target.value)}
              placeholder={fakeid ? "搜索标题、摘要或正文" : "请先选择公众号"}
              disabled={!fakeid}
              className="h-9 border-0 bg-transparent pr-8 pl-9 focus-visible:ring-1"
            />
            {searching && trimmedQuery && (
              <LoaderCircleIcon className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>
          <ArticleFilterMenu
            filters={articleFilters}
            tagFilter={articleTagFilter}
            candidates={matchedArticles}
            activeCount={activeFilterCount}
            disabled={!fakeid || loading}
            missingClassificationCount={missingClassificationCount}
            classificationBusy={resuming && resumeMode === "classify"}
            canBackfillClassifications={canBackfillClassifications}
            onChange={setArticleFilters}
            onTagFilterChange={setArticleTagFilter}
            onReset={resetArticleFilters}
            onBackfillClassifications={() => void resumeCollection("classify")}
          />
        </div>
        {activeFilterLabels.length > 0 && (
          <div
            className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5"
            aria-label="当前文章筛选条件"
          >
            <span className="mr-0.5 text-[11px] text-muted-foreground">
              已筛选
            </span>
            {activeFilterLabels.map((label) => (
              <span
                key={label}
                className="inline-flex h-6 items-center rounded-md border border-primary/25 bg-primary/10 px-2 text-[11px] font-medium text-primary"
              >
                {label}
              </span>
            ))}
            <Button
              type="button"
              size="xs"
              variant="ghost"
              className="text-muted-foreground"
              onClick={resetArticleFilters}
            >
              清除
            </Button>
          </div>
        )}
        {searchError && trimmedQuery && (
          <div className="mt-2 text-[11px] text-destructive">
            全文检索失败，已退回标题/摘要搜索
          </div>
        )}
      </div>
      <ScrollArea className="min-h-0 min-w-0 flex-1">
        {showCollectionBoundaries && items.length > 0 && (
          <ArticleCollectionBoundary
            edge="start"
            mode="forward"
            busy={resuming && resumeMode === "forward"}
            disabled={!canResume}
            itemCount={items.length}
            batchInput={resumeBatchInput}
            batchSize={resumeBatchSize}
            fetchLimit={resumeFetchLimit}
            onBatchInputChange={setResumeBatchInput}
            onClick={() => void resumeCollection("forward")}
          />
        )}
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
              {items.length === 0
                ? "暂无缓存文章"
                : activeFilterCount > 0
                  ? "筛选条件下无结果"
                  : "没有匹配结果"}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {items.length === 0
                ? "当前公众号还没有本地记录"
                : activeFilterCount > 0
                  ? "调整条件，或清除筛选查看全部文章"
                  : "换个关键词试试"}
            </div>
            {items.length > 0 && activeFilterCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="mt-4"
                onClick={resetArticleFilters}
              >
                清除筛选
              </Button>
            )}
            {items.length === 0 && !trimmedQuery && (
              <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>本次</span>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_RESUME_LIMIT}
                    value={resumeBatchInput}
                    disabled={resuming}
                    onChange={(event) =>
                      setResumeBatchInput(event.target.value)
                    }
                    className="h-7 w-16 bg-background/70 px-2 text-center text-xs"
                    aria-label="本次采集篇数"
                  />
                  <span>篇</span>
                </label>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canResume}
                  onClick={() => void resumeCollection("forward")}
                >
                  {resuming && resumeMode === "forward" ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <PlayCircleIcon className="size-3.5" />
                  )}
                  采集首批 {resumeBatchSize} 篇
                </Button>
              </div>
            )}
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
        {showCollectionBoundaries && items.length > 0 && (
          <ArticleCollectionBoundary
            edge="end"
            mode="backward"
            busy={resuming && resumeMode === "backward"}
            disabled={!canResume}
            itemCount={items.length}
            batchInput={resumeBatchInput}
            batchSize={resumeBatchSize}
            fetchLimit={resumeFetchLimit}
            onBatchInputChange={setResumeBatchInput}
            onClick={() => void resumeCollection("backward")}
          />
        )}
      </ScrollArea>
      {menu && (
        <ArticleContextMenu
          menu={menu}
          accountName={selectedAccount?.nickname ?? null}
          fetchingAid={fetchingAid}
          metricsUpdatingAid={metricsUpdatingAid}
          busy={fetchActionsBlocked}
          tags={tagOptions}
          tagsLoading={tagsLoading}
          tagError={tagError}
          tagActionKey={tagActionKey}
          onClose={() => setMenu(null)}
          onSelect={() => onSelect(menu.article.aid)}
          onFetchContent={fetchArticleContent}
          onUpdateMetrics={updateArticlePublicMetrics}
          onToggleTag={(tag, assigned) =>
            updateArticleTagAssignment(menu.article, tag, assigned)
          }
          onCreateTag={() =>
            setTagDialog({ article: menu.article, focusCreate: true })
          }
          onManageTags={() =>
            setTagDialog({ article: menu.article, focusCreate: false })
          }
        />
      )}
      {tagDialog ? (
        <ArticleTagDialog
          key={tagDialog.article.aid}
          article={tagDialog.article}
          focusCreate={tagDialog.focusCreate}
          tags={tagOptions}
          loading={tagsLoading}
          error={tagError}
          actionKey={tagActionKey}
          onClose={() => setTagDialog(null)}
          onCreate={(name) =>
            createAndAssignArticleTag(tagDialog.article, name)
          }
          onToggle={(tag, assigned) =>
            updateArticleTagAssignment(tagDialog.article, tag, assigned)
          }
          onRename={renameArticleTag}
          onDelete={removeArticleTag}
        />
      ) : null}
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

function ArticleFilterMenu({
  filters,
  tagFilter,
  candidates,
  activeCount,
  disabled,
  missingClassificationCount,
  classificationBusy,
  canBackfillClassifications,
  onChange,
  onTagFilterChange,
  onReset,
  onBackfillClassifications,
}: {
  filters: ArticleFilters
  tagFilter: ArticleTagFilter
  candidates: ArticleSummary[]
  activeCount: number
  disabled: boolean
  missingClassificationCount: number
  classificationBusy: boolean
  canBackfillClassifications: boolean
  onChange: (filters: ArticleFilters) => void
  onTagFilterChange: (tagFilter: ArticleTagFilter) => void
  onReset: () => void
  onBackfillClassifications: () => void
}) {
  const articleTypeCounts = {
    all: candidates.length,
    article: candidates.filter(
      (article) => articleTypeBucket(article.article_type) === "article"
    ).length,
    sticker: candidates.filter(
      (article) => articleTypeBucket(article.article_type) === "sticker"
    ).length,
    other: candidates.filter(
      (article) => articleTypeBucket(article.article_type) === "other"
    ).length,
  }
  const copyrightCounts = {
    all: candidates.length,
    original: candidates.filter(
      (article) => copyrightBucket(article.copyright_type) === "original"
    ).length,
    reprint: candidates.filter(
      (article) => copyrightBucket(article.copyright_type) === "reprint"
    ).length,
    default: candidates.filter(
      (article) => copyrightBucket(article.copyright_type) === "default"
    ).length,
    unknown: candidates.filter(
      (article) => copyrightBucket(article.copyright_type) === "unknown"
    ).length,
  }
  const cacheCounts = {
    all: candidates.length,
    cached: candidates.filter((article) => article.has_content).length,
    missing: candidates.filter((article) => !article.has_content).length,
  }
  const candidateTagSets = candidates.map((article) =>
    Array.from(
      new Set((article.tags ?? []).map((tag) => tag.trim()).filter(Boolean))
    )
  )
  const tagCounts = new Map<string, number>()
  candidateTagSets.forEach((tags) => {
    tags.forEach((tag) => tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1))
  })
  const selectedTagName = articleTagFilterName(tagFilter)
  const tagOptions = Array.from(tagCounts.entries()).sort(([left], [right]) =>
    left.localeCompare(right, "zh-CN")
  )
  if (selectedTagName && !tagCounts.has(selectedTagName)) {
    tagOptions.unshift([selectedTagName, 0])
  }
  const taggedCount = candidateTagSets.filter((tags) => tags.length > 0).length
  const tagFilterLabel =
    selectedTagName ??
    (tagFilter === "tagged"
      ? "有标签"
      : tagFilter === "untagged"
        ? "无标签"
        : "全部")
  const triggerLabel =
    activeCount > 0 ? `筛选文章，已启用 ${activeCount} 项` : "筛选文章"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          size="icon-lg"
          variant="outline"
          disabled={disabled}
          aria-label={triggerLabel}
          aria-pressed={activeCount > 0}
          title={triggerLabel}
          className={cn(
            "relative",
            activeCount > 0 &&
              "border-primary/35 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
          )}
        >
          <ListFilterIcon className="size-4" />
          {activeCount > 0 && (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-primary text-[9px] leading-none font-semibold text-primary-foreground ring-2 ring-background">
              {activeCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>内容形态</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.articleType}
          onValueChange={(value) =>
            onChange({
              ...filters,
              articleType: value as ArticleTypeFilter,
            })
          }
        >
          <ArticleFilterRadioItem
            value="all"
            label="全部"
            count={articleTypeCounts.all}
          />
          <ArticleFilterRadioItem
            value="article"
            label="图文"
            count={articleTypeCounts.article}
          />
          <ArticleFilterRadioItem
            value="sticker"
            label="贴图"
            count={articleTypeCounts.sticker}
          />
          <ArticleFilterRadioItem
            value="other"
            label="其他 / 未标注"
            count={articleTypeCounts.other}
          />
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>版权属性</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.copyright}
          onValueChange={(value) =>
            onChange({
              ...filters,
              copyright: value as CopyrightFilter,
            })
          }
        >
          <ArticleFilterRadioItem
            value="all"
            label="全部"
            count={copyrightCounts.all}
          />
          <ArticleFilterRadioItem
            value="original"
            label="原创"
            count={copyrightCounts.original}
          />
          <ArticleFilterRadioItem
            value="reprint"
            label="转载"
            count={copyrightCounts.reprint}
          />
          <ArticleFilterRadioItem
            value="default"
            label="默认"
            count={copyrightCounts.default}
          />
          <ArticleFilterRadioItem
            value="unknown"
            label="未标注"
            count={copyrightCounts.unknown}
          />
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>正文状态</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={filters.contentCache}
          onValueChange={(value) =>
            onChange({
              ...filters,
              contentCache: value as ContentCacheFilter,
            })
          }
        >
          <ArticleFilterRadioItem
            value="all"
            label="全部"
            count={cacheCounts.all}
          />
          <ArticleFilterRadioItem
            value="cached"
            label="已采集正文"
            count={cacheCounts.cached}
          />
          <ArticleFilterRadioItem
            value="missing"
            label="缺少正文"
            count={cacheCounts.missing}
          />
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <TagIcon className="size-4" />
            <span className="min-w-0 flex-1">标签</span>
            <span className="max-w-24 truncate text-[11px] text-muted-foreground">
              {tagFilterLabel}
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-[min(70vh,24rem)] w-64 overflow-y-auto">
            <DropdownMenuLabel>文章标签</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={tagFilter}
              onValueChange={(value) =>
                onTagFilterChange(value as ArticleTagFilter)
              }
            >
              <ArticleFilterRadioItem
                value="all"
                label="全部"
                count={candidates.length}
              />
              <ArticleFilterRadioItem
                value="tagged"
                label="有标签"
                count={taggedCount}
              />
              <ArticleFilterRadioItem
                value="untagged"
                label="无标签"
                count={candidates.length - taggedCount}
              />
              {tagOptions.length > 0 && <DropdownMenuSeparator />}
              {tagOptions.map(([tag, count]) => (
                <ArticleFilterRadioItem
                  key={tag}
                  value={articleTagFilterValue(tag)}
                  label={tag}
                  count={count}
                />
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        {missingClassificationCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                onBackfillClassifications()
              }}
              disabled={!canBackfillClassifications}
            >
              {classificationBusy ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <RefreshCwIcon className="size-4" />
              )}
              <div className="flex min-w-0 flex-col">
                <span>补齐旧数据分类</span>
                <span className="truncate text-[11px] text-muted-foreground">
                  {classificationBusy
                    ? "正在从公众号资料补全分类"
                    : `${missingClassificationCount.toLocaleString()} 篇当前未标注，将按公众号真实资料补全分类`}
                </span>
              </div>
            </DropdownMenuItem>
          </>
        )}

        {activeCount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onReset}>
              <XIcon className="size-4" />
              清除全部筛选
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ArticleFilterRadioItem({
  value,
  label,
  count,
}: {
  value: string
  label: string
  count: number
}) {
  return (
    <DropdownMenuRadioItem
      value={value}
      onSelect={(event) => event.preventDefault()}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="mr-4 font-mono text-[11px] text-muted-foreground">
        {count.toLocaleString()}
      </span>
    </DropdownMenuRadioItem>
  )
}

function articleFilterLabels(
  filters: ArticleFilters,
  tagFilter: ArticleTagFilter
) {
  const labels: string[] = []
  if (filters.articleType !== "all") {
    labels.push(
      {
        article: "形态：图文",
        sticker: "形态：贴图",
        other: "形态：其他 / 未标注",
      }[filters.articleType]
    )
  }
  if (filters.copyright !== "all") {
    labels.push(
      {
        default: "版权：默认",
        original: "版权：原创",
        reprint: "版权：转载",
        unknown: "版权：未标注",
      }[filters.copyright]
    )
  }
  if (filters.contentCache !== "all") {
    labels.push(
      filters.contentCache === "cached" ? "正文：已采集" : "正文：缺失"
    )
  }
  if (tagFilter !== "all") {
    const tagName = articleTagFilterName(tagFilter)
    labels.push(
      tagName
        ? `标签：${tagName}`
        : tagFilter === "tagged"
          ? "标签：有标签"
          : "标签：无标签"
    )
  }
  return labels
}

async function listArticlesWithTags(fakeid: string) {
  const [articles, tagsByAid] = await Promise.all([
    api.listArticles(fakeid),
    api.listArticleTagNames(fakeid),
  ])
  return attachArticleTags(articles, tagsByAid)
}

function attachArticleTags(
  articles: ArticleSummary[],
  tagsByAid: Record<string, string[]>
) {
  return articles.map((article) => ({
    ...article,
    tags: sortedTags(new Set(tagsByAid[article.aid] ?? article.tags ?? [])),
  }))
}

function sortedTags(tags: Set<string>) {
  return Array.from(tags)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
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
              {mode === "content"
                ? "补齐全部正文"
                : mode === "classify"
                  ? "补齐旧数据分类"
                  : `${modeLabel}文章索引`}
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {account.nickname} ·{" "}
              {mode === "audit"
                ? formatAuditDateScope(auditDate)
                : mode === "content"
                  ? `补齐 ${limit.toLocaleString()} 篇正文`
                  : mode === "classify"
                    ? `补全 ${limit.toLocaleString()} 篇旧文章`
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

function parseFetchLimitInput(value: string) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) return DEFAULT_FETCH_LIMIT
  return Math.min(Math.max(parsed, 1), MAX_RESUME_LIMIT)
}

function nextResumeFetchLimit(currentCount: number, batchSize: number) {
  const normalizedCount = Math.max(currentCount, 0)
  if (normalizedCount >= MAX_RESUME_LIMIT) return 1
  return Math.min(batchSize, MAX_RESUME_LIMIT - normalizedCount)
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
      { label: "采集正文", stages: ["content"] },
      { label: "完成入库", stages: ["complete"] },
    ]
  }
  if (mode === "classify") {
    return [
      { label: "确认目标", stages: ["prepare"] },
      { label: "同步账号", stages: ["account"] },
      { label: "补全分类", stages: ["articles"] },
      { label: "完成入库", stages: ["complete"] },
    ]
  }
  return [
    { label: "确认目标", stages: ["prepare"] },
    { label: "同步账号", stages: ["account"] },
    { label: "继续采集", stages: ["articles"] },
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

function ArticleCollectionBoundary({
  edge,
  mode,
  busy,
  disabled,
  itemCount,
  batchInput,
  batchSize,
  fetchLimit,
  onBatchInputChange,
  onClick,
}: {
  edge: "start" | "end"
  mode: Extract<FetchMode, "forward" | "backward">
  busy: boolean
  disabled: boolean
  itemCount: number
  batchInput: string
  batchSize: number
  fetchLimit: number
  onBatchInputChange: (value: string) => void
  onClick: () => void
}) {
  const isForward = mode === "forward"
  const Icon = isForward ? PlayCircleIcon : HistoryIcon
  const limitReached = itemCount >= MAX_RESUME_LIMIT
  const description = limitReached
    ? `已达 ${MAX_RESUME_LIMIT.toLocaleString()} 篇索引上限`
    : isForward
      ? `从列表顶部补最新索引，本次 ${fetchLimit.toLocaleString()} 篇`
      : `从列表底部继续向旧采集 ${fetchLimit || batchSize} 篇`

  return (
    <div
      className={cn(
        "px-3 py-2",
        edge === "start"
          ? "border-b border-border/70"
          : "border-t border-border/70"
      )}
    >
      <div className="grid min-w-0 gap-2 rounded-lg border border-border/70 bg-card/55 px-3 py-2">
        <div className="min-w-0">
          <div className="truncate text-xs font-medium text-foreground">
            {isForward ? "列表起点" : "列表末尾"}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {description}
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-between gap-2">
          <label className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="shrink-0">本次</span>
            <Input
              type="number"
              min={1}
              max={MAX_RESUME_LIMIT}
              value={batchInput}
              disabled={disabled || busy}
              onChange={(event) => onBatchInputChange(event.target.value)}
              className="h-7 w-16 bg-background/70 px-2 text-center text-xs"
              aria-label="本次采集篇数"
            />
            <span className="shrink-0">篇</span>
          </label>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={onClick}
            className="h-7 px-2.5"
          >
            {busy ? (
              <LoaderCircleIcon className="size-3.5 animate-spin" />
            ) : (
              <Icon className="size-3.5" />
            )}
            {busy ? `${RESUME_MODE_LABELS[mode]}中` : RESUME_MODE_LABELS[mode]}
          </Button>
        </div>
      </div>
    </div>
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
  const label = isFetching ? "采集中" : hasContent ? "正文已采集" : "正文未采集"

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
  accountName,
  fetchingAid,
  metricsUpdatingAid,
  busy,
  tags,
  tagsLoading,
  tagError,
  tagActionKey,
  onClose,
  onSelect,
  onFetchContent,
  onUpdateMetrics,
  onToggleTag,
  onCreateTag,
  onManageTags,
}: {
  menu: ArticleMenuState
  accountName: string | null
  fetchingAid: string | null
  metricsUpdatingAid: string | null
  busy: boolean
  tags: ArticleTag[]
  tagsLoading: boolean
  tagError: string | null
  tagActionKey: string | null
  onClose: () => void
  onSelect: () => void
  onFetchContent: (article: ArticleSummary) => Promise<void>
  onUpdateMetrics: (article: ArticleSummary) => Promise<void>
  onToggleTag: (tag: ArticleTag, assigned: boolean) => Promise<boolean>
  onCreateTag: () => void
  onManageTags: () => void
}) {
  const article = menu.article
  const fetching = fetchingAid === article.aid
  const updatingMetrics = metricsUpdatingAid === article.aid

  const run = (action: () => unknown | Promise<unknown>) => {
    onClose()
    void action()
  }

  return createPortal(
    <div
      role="menu"
      className="article-context-menu article-tag-context-menu"
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
          ? "正在采集"
          : article.has_content
            ? "重新采集正文"
            : "采集正文"}
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        disabled={Boolean(metricsUpdatingAid)}
        onClick={() => run(() => onUpdateMetrics(article))}
      >
        {updatingMetrics ? (
          <LoaderCircleIcon className="size-3.5 animate-spin" />
        ) : (
          <BarChart3Icon className="size-3.5" />
        )}
        {updatingMetrics ? "正在更新互动数据" : "更新阅读量相关数据"}
      </button>
      <div className="article-context-separator" />
      <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
        <TagIcon className="size-3" />
        标签
      </div>
      <div
        role="group"
        aria-label="切换文章标签"
        className="max-h-36 overflow-y-auto pr-0.5"
      >
        {tagsLoading ? (
          <div className="flex h-8 items-center gap-2 px-2 text-xs text-muted-foreground">
            <LoaderCircleIcon className="size-3.5 animate-spin" />
            正在读取标签
          </div>
        ) : tagError ? (
          <div className="flex items-start gap-2 px-2 py-1.5 text-xs leading-relaxed text-destructive">
            <AlertCircleIcon className="mt-0.5 size-3.5 shrink-0" />
            <span className="line-clamp-2">{tagError}</span>
          </div>
        ) : tags.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">
            暂无标签，可从这里新建
          </div>
        ) : (
          tags.map((tag) => (
            <button
              key={tag.id}
              role="menuitemcheckbox"
              aria-checked={tag.assigned}
              className="article-context-item"
              disabled={Boolean(tagActionKey)}
              onClick={() => void onToggleTag(tag, !tag.assigned)}
            >
              {tagActionKey === `toggle:${tag.id}` ? (
                <LoaderCircleIcon className="size-3.5 animate-spin" />
              ) : tag.assigned ? (
                <CheckIcon className="size-3.5" />
              ) : (
                <CircleIcon className="size-3.5" />
              )}
              <span className="min-w-0 flex-1 truncate">{tag.name}</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">
                {tag.article_count}
              </span>
            </button>
          ))
        )}
      </div>
      <button
        role="menuitem"
        className="article-context-item"
        disabled={Boolean(tagActionKey)}
        onClick={() => run(onCreateTag)}
      >
        <PlusIcon className="size-3.5" />
        新建标签…
      </button>
      <button
        role="menuitem"
        className="article-context-item"
        disabled={Boolean(tagActionKey)}
        onClick={() => run(onManageTags)}
      >
        <PencilIcon className="size-3.5" />
        管理全部标签…
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
      <button
        role="menuitem"
        className="article-context-item"
        disabled={busy}
        onClick={() => run(() => copyArticleBasicInfo(article, accountName))}
      >
        <CopyIcon className="size-3.5" />
        复制基本信息（含文件地址）
      </button>
    </div>,
    document.body
  )
}

function ArticleTagDialog({
  article,
  focusCreate,
  tags,
  loading,
  error,
  actionKey,
  onClose,
  onCreate,
  onToggle,
  onRename,
  onDelete,
}: {
  article: ArticleSummary
  focusCreate: boolean
  tags: ArticleTag[]
  loading: boolean
  error: string | null
  actionKey: string | null
  onClose: () => void
  onCreate: (name: string) => Promise<boolean>
  onToggle: (tag: ArticleTag, assigned: boolean) => Promise<boolean>
  onRename: (tag: ArticleTag, name: string) => Promise<boolean>
  onDelete: (tag: ArticleTag) => Promise<boolean>
}) {
  const [newTagName, setNewTagName] = useState("")
  const [editingTagId, setEditingTagId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState("")
  const [pendingDelete, setPendingDelete] = useState<ArticleTag | null>(null)
  const busy = actionKey !== null

  const submitNewTag = async (event: FormEvent) => {
    event.preventDefault()
    const name = newTagName.trim()
    if (!name || busy) return
    if (await onCreate(name)) setNewTagName("")
  }

  const submitRename = async (event: FormEvent, tag: ArticleTag) => {
    event.preventDefault()
    const name = editingName.trim()
    if (!name || busy) return
    if (await onRename(tag, name)) {
      setEditingTagId(null)
      setEditingName("")
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>管理文章标签</DialogTitle>
          <DialogDescription className="line-clamp-2">
            为《{article.title}》切换标签，也可以统一新建、重命名或删除标签。
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submitNewTag} className="space-y-2">
          <Label htmlFor="new-article-tag">新建并添加到当前文章</Label>
          <div className="flex gap-2">
            <Input
              id="new-article-tag"
              autoFocus={focusCreate}
              maxLength={24}
              value={newTagName}
              disabled={busy}
              placeholder="例如：产品洞察"
              onChange={(event) => setNewTagName(event.target.value)}
            />
            <Button
              type="submit"
              disabled={!newTagName.trim() || busy}
              className="shrink-0"
            >
              {actionKey === "create" ? (
                <LoaderCircleIcon className="size-4 animate-spin" />
              ) : (
                <PlusIcon className="size-4" />
              )}
              新建
            </Button>
          </div>
          <div className="text-xs text-muted-foreground">
            最多 24 个字符；名称不区分英文大小写。
          </div>
        </form>

        {error ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive select-text"
          >
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border bg-muted/40 px-3 py-2">
            <div className="font-serif text-sm font-semibold text-foreground">
              全部标签
            </div>
            <div className="text-xs text-muted-foreground">
              {tags.length} 个
            </div>
          </div>
          <div className="max-h-[min(48vh,360px)] overflow-y-auto p-1.5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-8 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                正在读取标签
              </div>
            ) : tags.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                还没有标签，在上方创建第一个标签。
              </div>
            ) : (
              tags.map((tag) => {
                const editing = editingTagId === tag.id
                const toggling = actionKey === `toggle:${tag.id}`
                return (
                  <div
                    key={tag.id}
                    className="flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-muted/60"
                  >
                    <Checkbox
                      id={`article-tag-${tag.id}`}
                      checked={tag.assigned}
                      disabled={busy}
                      aria-label={`${tag.assigned ? "移除" : "添加"}标签 ${tag.name}`}
                      onCheckedChange={(checked) =>
                        void onToggle(tag, checked === true)
                      }
                    />
                    {toggling ? (
                      <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-primary" />
                    ) : null}
                    {editing ? (
                      <form
                        onSubmit={(event) => void submitRename(event, tag)}
                        className="flex min-w-0 flex-1 items-center gap-1.5"
                      >
                        <Input
                          autoFocus
                          maxLength={24}
                          value={editingName}
                          disabled={busy}
                          aria-label={`编辑标签 ${tag.name}`}
                          className="h-7"
                          onChange={(event) =>
                            setEditingName(event.target.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Escape") {
                              event.preventDefault()
                              setEditingTagId(null)
                            }
                          }}
                        />
                        <Button
                          type="submit"
                          size="icon-xs"
                          variant="ghost"
                          disabled={!editingName.trim() || busy}
                          aria-label="保存标签名称"
                        >
                          {actionKey === `rename:${tag.id}` ? (
                            <LoaderCircleIcon className="animate-spin" />
                          ) : (
                            <CheckIcon />
                          )}
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          aria-label="取消编辑"
                          onClick={() => setEditingTagId(null)}
                        >
                          <XIcon />
                        </Button>
                      </form>
                    ) : (
                      <label
                        htmlFor={`article-tag-${tag.id}`}
                        className="min-w-0 flex-1 cursor-pointer truncate text-sm text-foreground"
                      >
                        {tag.name}
                      </label>
                    )}
                    {!editing ? (
                      <>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {tag.article_count} 篇
                        </span>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          aria-label={`编辑标签 ${tag.name}`}
                          onClick={() => {
                            setEditingTagId(tag.id)
                            setEditingName(tag.name)
                            setPendingDelete(null)
                          }}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          disabled={busy}
                          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          aria-label={`删除标签 ${tag.name}`}
                          onClick={() => {
                            setPendingDelete(tag)
                            setEditingTagId(null)
                          }}
                        >
                          <Trash2Icon />
                        </Button>
                      </>
                    ) : null}
                  </div>
                )
              })
            )}
          </div>
        </div>

        {pendingDelete ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-3">
            <div className="text-sm font-medium text-foreground">
              删除“{pendingDelete.name}”？
            </div>
            <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
              该标签会从 {pendingDelete.article_count}{" "}
              篇文章中移除，文章本身不会被删除。
            </div>
            <div className="mt-3 flex justify-end gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => setPendingDelete(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  void onDelete(pendingDelete).then((deleted) => {
                    if (deleted) setPendingDelete(null)
                  })
                }
              >
                {actionKey === `delete:${pendingDelete.id}` ? (
                  <LoaderCircleIcon className="animate-spin" />
                ) : (
                  <Trash2Icon />
                )}
                确认删除
              </Button>
            </div>
          </div>
        ) : null}

        <DialogFooter className="items-center justify-between">
          <div className="mr-auto text-xs text-muted-foreground">
            勾选后立即保存到本机数据库。
          </div>
          <Button type="button" variant="outline" onClick={onClose}>
            完成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

async function copyArticleBasicInfo(
  article: ArticleSummary,
  accountName: string | null
) {
  if (!article.has_content) {
    toast.warning("请先采集正文，再复制包含文件地址的基本信息")
    return
  }

  try {
    const localFilePath = await api.exportArticleLocal(article.aid)
    const basicInfo = [
      `文章标题：${article.title}`,
      accountName ? `公众号：${accountName}` : null,
      article.author ? `作者：${article.author}` : null,
      `发布时间：${formatDate(article.create_time)}`,
      `文章 ID：${article.aid}`,
      `公众号 ID：${article.fakeid}`,
      `原文链接：${article.link}`,
      `文件地址：${localFilePath}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n")

    await copyText(basicInfo)
  } catch (error) {
    toast.error(`复制基本信息失败：${errorMessage(error)}`)
  }
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
  const width = 250
  const height = 540
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

function formatMetricsUpdateToast(snapshot: ArticlePublicMetricsSnapshot) {
  const backend = snapshot.source_kind === "wechat_mp_backend"
  const metrics = [
    [backend ? "阅读人数" : "阅读", snapshot.read_count],
    ["点赞", snapshot.like_count],
    ["推荐", snapshot.recommend_count],
  ] as const
  const visible = metrics.flatMap(([label, value]) =>
    value === null
      ? []
      : [`${label} ${new Intl.NumberFormat("zh-CN").format(value)}`]
  )
  const source = backend
    ? "公众号后台"
    : snapshot.source_kind === "wechat_account_feed"
      ? "公众号文章列表"
      : snapshot.source_kind === "wechat_local_session"
        ? "本机微信"
        : "本机微信"
  return visible.length > 0
    ? `已从${source}更新：${visible.join(" · ")}`
    : `已从${source}更新互动数据`
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
