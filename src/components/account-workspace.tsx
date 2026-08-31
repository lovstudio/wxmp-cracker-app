import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  Columns3Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileDownIcon,
  FileX2Icon,
  LoaderCircleIcon,
  PenLineIcon,
  PlayCircleIcon,
  RotateCcwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  TrendingUpIcon,
} from "lucide-react"
import type { WorkspaceTabId } from "@/components/top-bar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  api,
  type Account,
  type AccountSearchResult,
  type ArticleSummary,
} from "@/lib/api"
import { runWithProviderExecutionReport } from "@/lib/gateway"
import { normalizeWechatImageUrl } from "@/lib/media"
import { copyableToast as toast } from "@/lib/toast"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  activeArticleFilterCount,
  DEFAULT_ARTICLE_FILTERS,
  type ArticleTagFilter,
  type ArticleFilters,
  type ArticleTypeFilter,
  type ContentCacheFilter,
  type CopyrightFilter,
} from "@/lib/article-filters"
import {
  ARTICLE_TABLE_COLUMNS,
  activeArticleManagementFilterCount,
  articleManagementAuthorValue,
  articleManagementTagValue,
  articleTableCellValue,
  articleTableExportFileName,
  articleTypeLabel,
  buildArticleTableCsv,
  copyrightLabel,
  DEFAULT_ARTICLE_MANAGEMENT_FILTERS,
  DEFAULT_ARTICLE_TABLE_COLUMNS,
  filterArticleTableRows,
  type ArticleAuthorFilter,
  type ArticleCompletenessFilter,
  type ArticleLocalFileFilter,
  type ArticleManagementFilters,
  type ArticlePresenceFilter,
  type ArticleTableColumnId,
} from "@/lib/article-table-export"

interface AccountWorkspaceProps {
  tab: Exclude<WorkspaceTabId, "reader" | "tags" | "github-sync">
  account: Account | null
  refreshKey: number
  onContentFetched?: (aid: string) => void
  onCollectionUpdated?: () => void
}

export function AccountWorkspace({
  tab,
  account,
  refreshKey,
  onContentFetched,
  onCollectionUpdated,
}: AccountWorkspaceProps) {
  if (!account) {
    return (
      <WorkspaceShell title="账号工作区" kicker="未选择公众号">
        <div className="empty-state-panel mx-auto mt-16 max-w-md rounded-lg px-8 py-10 text-center">
          <AlertCircleIcon className="mx-auto mb-3 size-8 text-muted-foreground" />
          <div className="text-sm font-medium">未选择公众号</div>
          <div className="mt-1 text-xs text-muted-foreground">
            左侧选择一个公众号后会显示账号级管理视图。
          </div>
        </div>
      </WorkspaceShell>
    )
  }

  if (tab === "collection") {
    return (
      <ArticleManager
        account={account}
        refreshKey={refreshKey}
        onContentFetched={onContentFetched}
        onCollectionUpdated={onCollectionUpdated}
      />
    )
  }

  if (tab === "profile") {
    return <AccountProfile account={account} />
  }

  if (tab === "trends") {
    return <TrendAnalysis account={account} refreshKey={refreshKey} />
  }

  return <StyleAnalysis account={account} refreshKey={refreshKey} />
}

const ARTICLE_MANAGER_COLUMNS_STORAGE_KEY = "wxmp:article-manager-columns:v2"

function ArticleManager({
  account,
  refreshKey,
  onContentFetched,
  onCollectionUpdated,
}: {
  account: Account
  refreshKey: number
  onContentFetched?: (aid: string) => void
  onCollectionUpdated?: () => void
}) {
  const { articles, setArticles, loading } = useAccountArticles(
    account.fakeid,
    refreshKey,
    "management"
  )
  const [fetchingAid, setFetchingAid] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [query, setQuery] = useState("")
  const [filters, setFilters] = useState<ArticleFilters>(
    DEFAULT_ARTICLE_FILTERS
  )
  const [managementFilters, setManagementFilters] =
    useState<ArticleManagementFilters>(DEFAULT_ARTICLE_MANAGEMENT_FILTERS)
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false)
  const [visibleColumns, setVisibleColumns] = useState<ArticleTableColumnId[]>(
    readArticleManagerColumns
  )
  const filteredArticles = useMemo(
    () => filterArticleTableRows(articles, query, filters, managementFilters),
    [articles, filters, managementFilters, query]
  )
  const tagOptions = useMemo(
    () =>
      Array.from(
        new Set(
          articles.flatMap((article) =>
            (article.tags ?? []).map((tag) => tag.trim()).filter(Boolean)
          )
        )
      ).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [articles]
  )
  const authorOptions = useMemo(
    () =>
      Array.from(
        new Set(
          articles
            .map((article) => article.author?.trim() ?? "")
            .filter(Boolean)
        )
      ).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [articles]
  )
  const cachedCount = articles.filter((article) => article.has_content).length
  const advancedFilterCount =
    activeArticleManagementFilterCount(managementFilters)
  const filterCount =
    activeArticleFilterCount(filters) +
    advancedFilterCount +
    (query.trim() ? 1 : 0)
  const dateRangeInvalid = Boolean(
    managementFilters.publishedFrom &&
    managementFilters.publishedTo &&
    managementFilters.publishedFrom > managementFilters.publishedTo
  )
  const nextResumeLimit = Math.min(Math.max(articles.length + 20, 20), 500)
  const collectionBusy = Boolean(fetchingAid) || resuming || exporting
  const canResume = !loading && !collectionBusy && articles.length < 500

  useEffect(() => {
    window.localStorage.setItem(
      ARTICLE_MANAGER_COLUMNS_STORAGE_KEY,
      JSON.stringify(visibleColumns)
    )
  }, [visibleColumns])

  useEffect(() => {
    setQuery("")
    setFilters(DEFAULT_ARTICLE_FILTERS)
    setManagementFilters(DEFAULT_ARTICLE_MANAGEMENT_FILTERS)
    setAdvancedFiltersOpen(false)
  }, [account.fakeid])

  const fetchContent = async (article: ArticleSummary) => {
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
      setArticles((current) =>
        current.map((item) =>
          item.aid === updated.aid
            ? { ...item, has_content: updated.has_content }
            : item
        )
      )
      onContentFetched?.(updated.aid)
      toast.success(
        article.has_content ? "正文已重新抓取" : "正文已抓取并写入缓存"
      )
    } catch (error) {
      toast.wxmpError(errorMessage(error), api.openLogin)
    } finally {
      setFetchingAid(null)
    }
  }

  const resumeCollection = async () => {
    if (!canResume) return

    setResuming(true)
    toast.info(`正在续采 ${account.nickname}，目标索引 ${nextResumeLimit} 篇`)
    try {
      await api.fetchSelectedAccount(
        accountToSearchResult(account),
        nextResumeLimit,
        false
      )
      const updatedArticles = await api.listArticleManagementRows(
        account.fakeid
      )
      setArticles(
        [...updatedArticles].sort((a, b) => b.create_time - a.create_time)
      )
      onCollectionUpdated?.()
      toast.success(
        updatedArticles.length > articles.length
          ? `续采完成，新增 ${updatedArticles.length - articles.length} 篇索引`
          : "续采完成，当前没有新增文章"
      )
    } catch (error) {
      toast.wxmpError(errorMessage(error), api.openLogin)
    } finally {
      setResuming(false)
    }
  }

  const toggleColumn = (column: ArticleTableColumnId, checked: boolean) => {
    setVisibleColumns((current) => {
      if (checked) {
        return ARTICLE_TABLE_COLUMNS.map((item) => item.id).filter(
          (id) => id === column || current.includes(id)
        )
      }
      if (current.length === 1) return current
      return current.filter((id) => id !== column)
    })
  }

  const resetFilters = () => {
    setQuery("")
    setFilters(DEFAULT_ARTICLE_FILTERS)
    setManagementFilters(DEFAULT_ARTICLE_MANAGEMENT_FILTERS)
  }

  const exportTable = async () => {
    if (loading || exporting || filteredArticles.length === 0) return

    setExporting(true)
    try {
      const csv = buildArticleTableCsv(filteredArticles, visibleColumns)
      const path = await api.exportArticlesTable(
        articleTableExportFileName(account.nickname),
        csv
      )
      toast.success(
        `已导出 ${filteredArticles.length} 篇文章的表格数据：${path}`
      )
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setExporting(false)
    }
  }

  return (
    <WorkspaceShell title="文章管理" kicker={account.nickname}>
      <div className="account-metric-grid">
        <Metric label="索引文章" value={articles.length.toLocaleString()} />
        <Metric
          label="当前结果"
          value={filteredArticles.length.toLocaleString()}
        />
        <Metric label="正文已抓取" value={cachedCount.toLocaleString()} />
      </div>
      <div className="workspace-panel overflow-hidden">
        <div className="space-y-3 border-b border-border/70 px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="font-serif text-base font-semibold">
                文章数据库
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {loading
                  ? "正在读取本地索引"
                  : `显示 ${filteredArticles.length} / ${articles.length} 篇，续采目标 ${nextResumeLimit} 篇`}
              </div>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" size="sm" variant="outline">
                    <Columns3Icon className="size-3.5" />
                    列配置 · {visibleColumns.length}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuGroup>
                    <DropdownMenuLabel>显示字段</DropdownMenuLabel>
                    {ARTICLE_TABLE_COLUMNS.map((column) => {
                      const checked = visibleColumns.includes(column.id)
                      return (
                        <DropdownMenuCheckboxItem
                          key={column.id}
                          checked={checked}
                          disabled={checked && visibleColumns.length === 1}
                          onCheckedChange={(nextChecked) =>
                            toggleColumn(column.id, nextChecked === true)
                          }
                          onSelect={(event) => event.preventDefault()}
                        >
                          {column.label}
                        </DropdownMenuCheckboxItem>
                      )
                    })}
                  </DropdownMenuGroup>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() =>
                      setVisibleColumns([...DEFAULT_ARTICLE_TABLE_COLUMNS])
                    }
                  >
                    <RotateCcwIcon className="size-3.5" />
                    恢复默认列
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={
                  loading || collectionBusy || filteredArticles.length === 0
                }
                onClick={() => void exportTable()}
              >
                {exporting ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <FileDownIcon className="size-3.5" />
                )}
                {exporting ? "导出中" : "导出表格"}
              </Button>
              <Button
                type="button"
                size="sm"
                className="shrink-0"
                disabled={!canResume}
                onClick={() => void resumeCollection()}
              >
                {resuming ? (
                  <LoaderCircleIcon className="size-3.5 animate-spin" />
                ) : (
                  <PlayCircleIcon className="size-3.5" />
                )}
                {resuming ? "续采中" : "一键续采"}
              </Button>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="search-shell relative min-w-64 flex-1 rounded-lg">
              <SearchIcon className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索标题、标签、作者、网址或文件地址"
                className="h-9 border-0 bg-transparent pl-9 focus-visible:ring-1"
                aria-label="搜索文章"
              />
            </div>
            <Select
              value={filters.articleType}
              onValueChange={(articleType) =>
                setFilters((current) => ({
                  ...current,
                  articleType: articleType as ArticleTypeFilter,
                }))
              }
            >
              <SelectTrigger className="h-9 w-32" aria-label="筛选内容形态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部形态</SelectItem>
                <SelectItem value="article">图文</SelectItem>
                <SelectItem value="sticker">贴图</SelectItem>
                <SelectItem value="other">其他形态</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.copyright}
              onValueChange={(copyright) =>
                setFilters((current) => ({
                  ...current,
                  copyright: copyright as CopyrightFilter,
                }))
              }
            >
              <SelectTrigger className="h-9 w-32" aria-label="筛选版权属性">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部版权</SelectItem>
                <SelectItem value="original">原创</SelectItem>
                <SelectItem value="reprint">转载</SelectItem>
                <SelectItem value="default">默认</SelectItem>
                <SelectItem value="unknown">未标注</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={filters.contentCache}
              onValueChange={(contentCache) =>
                setFilters((current) => ({
                  ...current,
                  contentCache: contentCache as ContentCacheFilter,
                }))
              }
            >
              <SelectTrigger className="h-9 w-32" aria-label="筛选正文状态">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部正文</SelectItem>
                <SelectItem value="cached">已抓取</SelectItem>
                <SelectItem value="missing">未抓取</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9"
              aria-expanded={advancedFiltersOpen}
              aria-controls="article-management-advanced-filters"
              onClick={() => setAdvancedFiltersOpen((open) => !open)}
            >
              <SlidersHorizontalIcon className="size-3.5" />
              精细筛选
              {advancedFilterCount > 0 && ` · ${advancedFilterCount}`}
            </Button>
            {filterCount > 0 && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-muted-foreground"
                onClick={resetFilters}
              >
                <RotateCcwIcon className="size-3.5" />
                清除筛选 · {filterCount}
              </Button>
            )}
          </div>
          {advancedFiltersOpen && (
            <div
              id="article-management-advanced-filters"
              className="rounded-xl border border-border/70 bg-muted/25 p-3"
            >
              <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-serif text-sm font-semibold">
                    精细筛选
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    按标签、作者、发布日期、网址、文件和字段完整度组合筛选。
                  </div>
                </div>
                {advancedFilterCount > 0 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="text-muted-foreground"
                    onClick={() =>
                      setManagementFilters(DEFAULT_ARTICLE_MANAGEMENT_FILTERS)
                    }
                  >
                    <RotateCcwIcon className="size-3" />
                    重置精细筛选
                  </Button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                <ArticleFilterField label="标签">
                  <Select
                    value={managementFilters.tag}
                    onValueChange={(tag) =>
                      setManagementFilters((current) => ({
                        ...current,
                        tag: tag as ArticleTagFilter,
                      }))
                    }
                  >
                    <SelectTrigger className="h-9 w-full" aria-label="筛选标签">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部标签</SelectItem>
                      <SelectItem value="tagged">有标签</SelectItem>
                      <SelectItem value="untagged">无标签</SelectItem>
                      {tagOptions.map((tag) => (
                        <SelectItem
                          key={tag}
                          value={articleManagementTagValue(tag)}
                        >
                          {tag}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </ArticleFilterField>
                <ArticleFilterField label="作者">
                  <Select
                    value={managementFilters.author}
                    onValueChange={(author) =>
                      setManagementFilters((current) => ({
                        ...current,
                        author: author as ArticleAuthorFilter,
                      }))
                    }
                  >
                    <SelectTrigger className="h-9 w-full" aria-label="筛选作者">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部作者</SelectItem>
                      <SelectItem value="missing">未标注作者</SelectItem>
                      {authorOptions.map((author) => (
                        <SelectItem
                          key={author}
                          value={articleManagementAuthorValue(author)}
                        >
                          {author}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </ArticleFilterField>
                <ArticleFilterField label="开始日期">
                  <Input
                    type="date"
                    value={managementFilters.publishedFrom}
                    max={managementFilters.publishedTo || undefined}
                    className="h-9 bg-background"
                    aria-label="筛选开始日期"
                    onChange={(event) =>
                      setManagementFilters((current) => ({
                        ...current,
                        publishedFrom: event.target.value,
                      }))
                    }
                  />
                </ArticleFilterField>
                <ArticleFilterField label="结束日期">
                  <Input
                    type="date"
                    value={managementFilters.publishedTo}
                    min={managementFilters.publishedFrom || undefined}
                    className="h-9 bg-background"
                    aria-label="筛选结束日期"
                    onChange={(event) =>
                      setManagementFilters((current) => ({
                        ...current,
                        publishedTo: event.target.value,
                      }))
                    }
                  />
                </ArticleFilterField>
                <ArticleFilterField label="原文网址">
                  <Select
                    value={managementFilters.originalUrl}
                    onValueChange={(originalUrl) =>
                      setManagementFilters((current) => ({
                        ...current,
                        originalUrl: originalUrl as ArticlePresenceFilter,
                      }))
                    }
                  >
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="筛选原文网址状态"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部网址状态</SelectItem>
                      <SelectItem value="present">已记录网址</SelectItem>
                      <SelectItem value="missing">未记录网址</SelectItem>
                    </SelectContent>
                  </Select>
                </ArticleFilterField>
                <ArticleFilterField label="封面网址">
                  <Select
                    value={managementFilters.coverUrl}
                    onValueChange={(coverUrl) =>
                      setManagementFilters((current) => ({
                        ...current,
                        coverUrl: coverUrl as ArticlePresenceFilter,
                      }))
                    }
                  >
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="筛选封面网址状态"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部封面状态</SelectItem>
                      <SelectItem value="present">已记录封面</SelectItem>
                      <SelectItem value="missing">未记录封面</SelectItem>
                    </SelectContent>
                  </Select>
                </ArticleFilterField>
                <ArticleFilterField label="本地文件">
                  <Select
                    value={managementFilters.localFile}
                    onValueChange={(localFile) =>
                      setManagementFilters((current) => ({
                        ...current,
                        localFile: localFile as ArticleLocalFileFilter,
                      }))
                    }
                  >
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="筛选本地文件状态"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部文件状态</SelectItem>
                      <SelectItem value="generated">已生成文件</SelectItem>
                      <SelectItem value="missing">未生成文件</SelectItem>
                    </SelectContent>
                  </Select>
                </ArticleFilterField>
                <ArticleFilterField label="字段完整度">
                  <Select
                    value={managementFilters.completeness}
                    onValueChange={(completeness) =>
                      setManagementFilters((current) => ({
                        ...current,
                        completeness: completeness as ArticleCompletenessFilter,
                      }))
                    }
                  >
                    <SelectTrigger
                      className="h-9 w-full"
                      aria-label="筛选字段完整度"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部完整度</SelectItem>
                      <SelectItem value="complete">核心字段完整</SelectItem>
                      <SelectItem value="missing_author">缺少作者</SelectItem>
                      <SelectItem value="missing_digest">缺少摘要</SelectItem>
                      <SelectItem value="missing_cover">缺少封面</SelectItem>
                      <SelectItem value="missing_tags">缺少标签</SelectItem>
                    </SelectContent>
                  </Select>
                </ArticleFilterField>
              </div>
              {dateRangeInvalid && (
                <div className="mt-2 text-xs text-destructive">
                  开始日期不能晚于结束日期，请调整日期范围。
                </div>
              )}
            </div>
          )}
        </div>
        <Table className="min-w-max">
          <TableHeader>
            <TableRow>
              {visibleColumns.map((column) => (
                <TableHead
                  key={column}
                  className={articleManagerColumnClass(column)}
                >
                  {articleManagerColumnLabel(column)}
                </TableHead>
              ))}
              <TableHead className="w-40 text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 6 }, (_, index) => (
                <TableRow key={index}>
                  {visibleColumns.map((column) => (
                    <TableCell key={column}>
                      <div className="h-3 w-24 rounded bg-muted/70" />
                    </TableCell>
                  ))}
                  <TableCell />
                </TableRow>
              ))}
            {!loading &&
              filteredArticles.map((article) => {
                const rowFetching = fetchingAid === article.aid
                const rowSyncing = resuming
                const rowBusy = rowFetching || rowSyncing

                return (
                  <TableRow key={article.aid}>
                    {visibleColumns.map((column) => (
                      <ArticleManagerCell
                        key={column}
                        article={article}
                        column={column}
                        status={
                          rowSyncing
                            ? "syncing"
                            : rowFetching
                              ? "fetching"
                              : undefined
                        }
                      />
                    ))}
                    <TableCell>
                      <div className="flex justify-end gap-1.5">
                        <Button
                          type="button"
                          size="xs"
                          variant="outline"
                          disabled={collectionBusy}
                          onClick={() => void fetchContent(article)}
                        >
                          {rowBusy ? (
                            <LoaderCircleIcon className="size-3 animate-spin" />
                          ) : (
                            <DownloadIcon className="size-3" />
                          )}
                          {rowSyncing
                            ? "续采中"
                            : rowFetching
                              ? "抓取中"
                              : article.has_content
                                ? "重抓"
                                : "抓取"}
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label="打开原文"
                          onClick={() => void openUrl(article.link)}
                        >
                          <ExternalLinkIcon className="size-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            {!loading && filteredArticles.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={visibleColumns.length + 1}
                  className="h-36 text-center text-muted-foreground"
                >
                  {articles.length === 0
                    ? "当前公众号还没有本地文章索引"
                    : "当前筛选条件下没有文章"}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </WorkspaceShell>
  )
}

function ArticleFilterField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="block text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  )
}

function ArticleManagerCell({
  article,
  column,
  status,
}: {
  article: ArticleSummary
  column: ArticleTableColumnId
  status?: "fetching" | "syncing"
}) {
  if (column === "content_status") {
    return (
      <TableCell>
        <ArticleStatusBadge hasContent={article.has_content} state={status} />
      </TableCell>
    )
  }

  if (column === "title") {
    return (
      <TableCell>
        <div className="max-w-[380px] min-w-64 truncate font-medium">
          {article.title}
        </div>
      </TableCell>
    )
  }

  if (column === "digest") {
    return (
      <TableCell>
        <div className="max-w-[360px] min-w-56 truncate text-xs text-muted-foreground">
          {article.digest || "未填写"}
        </div>
      </TableCell>
    )
  }

  if (column === "tags") {
    const tags = article.tags ?? []
    return (
      <TableCell>
        {tags.length > 0 ? (
          <div className="flex max-w-64 items-center gap-1 overflow-hidden">
            {tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="shrink-0 rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[11px] font-medium text-primary"
              >
                {tag}
              </span>
            ))}
            {tags.length > 3 && (
              <span className="text-[11px] text-muted-foreground">
                +{tags.length - 3}
              </span>
            )}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">无标签</span>
        )}
      </TableCell>
    )
  }

  if (column === "published_at") {
    return (
      <TableCell className="font-mono text-xs text-muted-foreground">
        {formatDate(article.create_time)}
      </TableCell>
    )
  }

  if (column === "article_type") {
    return <TableCell>{articleTypeLabel(article.article_type)}</TableCell>
  }

  if (column === "copyright") {
    return <TableCell>{copyrightLabel(article.copyright_type)}</TableCell>
  }

  if (column === "link" || column === "cover") {
    const url = column === "link" ? article.link : article.cover
    return (
      <TableCell>
        <div
          className="max-w-64 truncate font-mono text-xs text-muted-foreground"
          title={url ?? undefined}
        >
          {url || "未记录"}
        </div>
      </TableCell>
    )
  }

  if (column === "local_file_path") {
    return (
      <TableCell>
        <div
          className="max-w-80 truncate font-mono text-xs text-muted-foreground"
          title={article.local_file_path ?? undefined}
        >
          {article.local_file_path || "未生成"}
        </div>
      </TableCell>
    )
  }

  return (
    <TableCell className="max-w-48 truncate text-sm text-muted-foreground">
      {articleTableCellValue(article, column) || "未标注"}
    </TableCell>
  )
}

function articleManagerColumnLabel(column: ArticleTableColumnId) {
  return (
    ARTICLE_TABLE_COLUMNS.find((item) => item.id === column)?.label ?? column
  )
}

function articleManagerColumnClass(column: ArticleTableColumnId) {
  if (column === "title") return "min-w-72"
  if (column === "tags") return "min-w-40"
  if (column === "digest") return "min-w-64"
  if (column === "link" || column === "cover") return "min-w-56"
  if (column === "local_file_path") return "min-w-72"
  return "min-w-28"
}

function readArticleManagerColumns(): ArticleTableColumnId[] {
  if (typeof window === "undefined") return [...DEFAULT_ARTICLE_TABLE_COLUMNS]

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(ARTICLE_MANAGER_COLUMNS_STORAGE_KEY) ?? "[]"
    )
    if (!Array.isArray(stored)) return [...DEFAULT_ARTICLE_TABLE_COLUMNS]

    const allowed = new Set(ARTICLE_TABLE_COLUMNS.map((column) => column.id))
    const columns = stored.filter(
      (column): column is ArticleTableColumnId =>
        typeof column === "string" &&
        allowed.has(column as ArticleTableColumnId)
    )
    return columns.length > 0 ? columns : [...DEFAULT_ARTICLE_TABLE_COLUMNS]
  } catch {
    return [...DEFAULT_ARTICLE_TABLE_COLUMNS]
  }
}

function AccountProfile({ account }: { account: Account }) {
  const avatar = normalizeWechatImageUrl(account.avatar)

  return (
    <WorkspaceShell title="公众号基本信息" kicker={account.nickname}>
      <div className="workspace-panel p-5">
        <div className="flex min-w-0 items-start gap-4">
          {avatar ? (
            <img
              src={avatar}
              alt=""
              referrerPolicy="no-referrer"
              className="size-16 shrink-0 rounded-lg object-cover"
            />
          ) : (
            <div className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-muted text-lg font-semibold text-primary">
              {account.nickname[0] ?? "?"}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-heading text-3xl leading-tight font-semibold">
              {account.nickname}
            </div>
            <div className="mt-2 text-sm text-muted-foreground">
              {account.signature || "暂无签名"}
            </div>
          </div>
        </div>
      </div>
      <div className="account-info-grid">
        <InfoRow label="FakeID" value={account.fakeid} />
        <InfoRow label="别名" value={account.alias || "未记录"} />
        <InfoRow label="文章索引" value={`${account.article_count} 篇`} />
        <InfoRow label="签名" value={account.signature || "未记录"} wide />
      </div>
    </WorkspaceShell>
  )
}

function TrendAnalysis({
  account,
  refreshKey,
}: {
  account: Account
  refreshKey: number
}) {
  const { articles, loading } = useAccountArticles(account.fakeid, refreshKey)
  const buckets = useMemo(() => buildMonthlyBuckets(articles), [articles])
  const maxCount = Math.max(1, ...buckets.map((bucket) => bucket.count))
  const cachedCount = articles.filter((article) => article.has_content).length

  return (
    <WorkspaceShell title="趋势分析" kicker={account.nickname}>
      <div className="account-metric-grid">
        <Metric label="索引文章" value={articles.length.toLocaleString()} />
        <Metric
          label="正文覆盖"
          value={formatPercent(cachedCount, articles.length)}
        />
        <Metric
          label="最近发布"
          value={articles.length ? formatDate(articles[0].create_time) : "-"}
        />
      </div>
      <div className="workspace-panel p-5">
        <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
          <TrendingUpIcon className="size-4 text-primary" />
          月度发布密度
        </div>
        <div className="space-y-3">
          {loading &&
            Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="h-7 rounded bg-muted" />
            ))}
          {!loading &&
            buckets.map((bucket) => (
              <div
                key={bucket.key}
                className="grid grid-cols-[72px_minmax(0,1fr)_44px] items-center gap-3 text-xs"
              >
                <span className="font-mono text-muted-foreground">
                  {bucket.label}
                </span>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${(bucket.count / maxCount) * 100}%` }}
                  />
                </div>
                <span className="text-right font-mono">{bucket.count}</span>
              </div>
            ))}
          {!loading && buckets.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              暂无趋势数据
            </div>
          )}
        </div>
      </div>
    </WorkspaceShell>
  )
}

function StyleAnalysis({
  account,
  refreshKey,
}: {
  account: Account
  refreshKey: number
}) {
  const { articles, loading } = useAccountArticles(account.fakeid, refreshKey)
  const analysis = useMemo(() => analyzeStyle(articles), [articles])

  return (
    <WorkspaceShell title="文风分析" kicker={account.nickname}>
      <div className="account-metric-grid">
        <Metric label="平均标题长度" value={analysis.avgTitleLength} />
        <Metric label="平均摘要长度" value={analysis.avgDigestLength} />
        <Metric label="疑问标题占比" value={analysis.questionRate} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[1fr_1fr]">
        <div className="workspace-panel p-5">
          <div className="mb-4 flex items-center gap-2 text-sm font-semibold">
            <PenLineIcon className="size-4 text-primary" />
            高频作者
          </div>
          <div className="space-y-2">
            {loading &&
              Array.from({ length: 4 }, (_, index) => (
                <div key={index} className="h-8 rounded bg-muted" />
              ))}
            {!loading &&
              analysis.topAuthors.map((author) => (
                <div
                  key={author.name}
                  className="flex items-center justify-between rounded-md border border-border/60 px-3 py-2 text-sm"
                >
                  <span className="truncate">{author.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {author.count}
                  </span>
                </div>
              ))}
            {!loading && analysis.topAuthors.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                暂无作者数据
              </div>
            )}
          </div>
        </div>
        <div className="workspace-panel p-5">
          <div className="mb-4 text-sm font-semibold">标题符号节奏</div>
          <div className="space-y-3">
            {analysis.punctuation.map((item) => (
              <div
                key={item.mark}
                className="grid grid-cols-[36px_minmax(0,1fr)_44px] items-center gap-3 text-xs"
              >
                <span className="font-heading text-lg">{item.mark}</span>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{
                      width: `${(item.count / Math.max(1, analysis.maxPunctuation)) * 100}%`,
                    }}
                  />
                </div>
                <span className="text-right font-mono">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </WorkspaceShell>
  )
}

function WorkspaceShell({
  title,
  kicker,
  children,
}: {
  title: string
  kicker: string
  children: ReactNode
}) {
  return (
    <main className="reader-surface flex min-w-0 flex-1 flex-col overflow-hidden">
      <ScrollArea className="flex-1">
        <div className="account-workspace">
          <div className="mb-5">
            <div className="text-xs font-semibold text-primary">{kicker}</div>
            <h2 className="mt-1 font-heading text-3xl leading-tight font-semibold">
              {title}
            </h2>
          </div>
          {children}
        </div>
      </ScrollArea>
    </main>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="workspace-panel px-4 py-3">
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 font-mono text-xl leading-tight">{value}</div>
    </div>
  )
}

function InfoRow({
  label,
  value,
  wide = false,
}: {
  label: string
  value: string
  wide?: boolean
}) {
  return (
    <div className={`workspace-panel px-4 py-3 ${wide ? "md:col-span-2" : ""}`}>
      <div className="text-[11px] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium break-words">{value}</div>
    </div>
  )
}

type ArticleStatusState = "cached" | "missing" | "fetching" | "syncing"

function ArticleStatusBadge({
  hasContent,
  state,
}: {
  hasContent: boolean
  state?: Extract<ArticleStatusState, "fetching" | "syncing">
}) {
  const resolvedState: ArticleStatusState =
    state ?? (hasContent ? "cached" : "missing")
  const label = articleStatusLabel(resolvedState)

  return (
    <span className="article-status-badge" data-state={resolvedState}>
      {resolvedState === "fetching" || resolvedState === "syncing" ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : resolvedState === "cached" ? (
        <CheckCircle2Icon className="size-3" />
      ) : (
        <FileX2Icon className="size-3" />
      )}
      <span>{label}</span>
    </span>
  )
}

function articleStatusLabel(state: ArticleStatusState): string {
  if (state === "fetching") return "抓取中"
  if (state === "syncing") return "续采中"
  if (state === "cached") return "正文已抓取"
  return "正文未抓取"
}

function useAccountArticles(
  fakeid: string,
  refreshKey: number,
  source: "summary" | "management" = "summary"
) {
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const request =
      source === "management"
        ? api.listArticleManagementRows(fakeid)
        : api.listArticles(fakeid)
    request
      .then((result) => {
        if (!cancelled) {
          setArticles([...result].sort((a, b) => b.create_time - a.create_time))
        }
      })
      .catch(() => !cancelled && setArticles([]))
      .finally(() => !cancelled && setLoading(false))

    return () => {
      cancelled = true
    }
  }, [fakeid, refreshKey, source])

  return { articles, setArticles, loading }
}

function buildMonthlyBuckets(articles: ArticleSummary[]) {
  const counts = new Map<string, number>()

  articles.forEach((article) => {
    const date = new Date(article.create_time * 1000)
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  })

  return Array.from(counts.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-8)
    .map(([key, count]) => ({
      key,
      label: key.slice(2),
      count,
    }))
}

function analyzeStyle(articles: ArticleSummary[]) {
  const avgTitleLength = average(
    articles.map((article) => article.title.trim().length)
  )
  const digests = articles
    .map((article) => article.digest?.trim().length ?? 0)
    .filter(Boolean)
  const questionCount = articles.filter((article) =>
    /[?？]/.test(article.title)
  ).length
  const authorCounts = new Map<string, number>()

  articles.forEach((article) => {
    if (!article.author) return
    authorCounts.set(
      article.author,
      (authorCounts.get(article.author) ?? 0) + 1
    )
  })

  const punctuation = ["？", "！", "：", "、", "《", "》"].map((mark) => ({
    mark,
    count: articles.reduce(
      (total, article) => total + countOccurrences(article.title, mark),
      0
    ),
  }))

  return {
    avgTitleLength: avgTitleLength ? `${avgTitleLength.toFixed(1)} 字` : "-",
    avgDigestLength: digests.length ? `${average(digests).toFixed(1)} 字` : "-",
    questionRate: formatPercent(questionCount, articles.length),
    topAuthors: Array.from(authorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count })),
    punctuation,
    maxPunctuation: Math.max(1, ...punctuation.map((item) => item.count)),
  }
}

function average(values: number[]) {
  if (values.length === 0) return 0
  return values.reduce((total, value) => total + value, 0) / values.length
}

function countOccurrences(input: string, needle: string) {
  return input.split(needle).length - 1
}

function formatDate(unix: number): string {
  const date = new Date(unix * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

function formatPercent(part: number, total: number): string {
  if (!total) return "0%"
  return `${Math.round((part / total) * 100)}%`
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

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
