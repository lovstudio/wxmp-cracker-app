import { useEffect, useMemo, useState, type ReactNode } from "react"
import {
  AlertCircleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  ExternalLinkIcon,
  FileX2Icon,
  LoaderCircleIcon,
  PenLineIcon,
  PlayCircleIcon,
  TrendingUpIcon,
} from "lucide-react"
import type { WorkspaceTabId } from "@/components/top-bar"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
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

interface AccountWorkspaceProps {
  tab: Exclude<WorkspaceTabId, "reader">
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
      <CollectionManager
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

function CollectionManager({
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
    refreshKey
  )
  const [fetchingAid, setFetchingAid] = useState<string | null>(null)
  const [resuming, setResuming] = useState(false)
  const cachedCount = articles.filter((article) => article.has_content).length
  const nextResumeLimit = Math.min(Math.max(articles.length + 20, 20), 500)
  const collectionBusy = Boolean(fetchingAid) || resuming
  const canResume = !loading && !collectionBusy && articles.length < 500

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
      const updatedArticles = await api.listArticles(account.fakeid)
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

  return (
    <WorkspaceShell title="采集管理" kicker={account.nickname}>
      <div className="account-metric-grid">
        <Metric label="索引文章" value={articles.length.toLocaleString()} />
        <Metric label="正文已抓取" value={cachedCount.toLocaleString()} />
        <Metric
          label="缓存率"
          value={formatPercent(cachedCount, articles.length)}
        />
      </div>
      <div className="workspace-panel overflow-hidden">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/70 px-4 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold">文章采集队列</div>
            <div className="mt-1 text-xs text-muted-foreground">
              {loading
                ? "正在读取本地索引"
                : `当前 ${articles.length} 篇，续采目标 ${nextResumeLimit} 篇`}
            </div>
          </div>
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[44%]">文章</TableHead>
              <TableHead>状态</TableHead>
              <TableHead>作者</TableHead>
              <TableHead>发布时间</TableHead>
              <TableHead className="text-right">操作</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading &&
              Array.from({ length: 6 }, (_, index) => (
                <TableRow key={index}>
                  <TableCell>
                    <div className="h-3 w-64 rounded bg-muted" />
                  </TableCell>
                  <TableCell>
                    <div className="h-5 w-20 rounded bg-muted" />
                  </TableCell>
                  <TableCell>
                    <div className="h-3 w-20 rounded bg-muted/70" />
                  </TableCell>
                  <TableCell>
                    <div className="h-3 w-24 rounded bg-muted/70" />
                  </TableCell>
                  <TableCell />
                </TableRow>
              ))}
            {!loading &&
              articles.map((article) => {
                const rowFetching = fetchingAid === article.aid
                const rowSyncing = resuming
                const rowBusy = rowFetching || rowSyncing

                return (
                  <TableRow key={article.aid}>
                    <TableCell>
                      <div className="max-w-[420px] min-w-0">
                        <div className="truncate font-medium">
                          {article.title}
                        </div>
                        {article.digest && (
                          <div className="mt-1 truncate text-xs text-muted-foreground">
                            {article.digest}
                          </div>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <ArticleStatusBadge
                        hasContent={article.has_content}
                        state={
                          rowSyncing
                            ? "syncing"
                            : rowFetching
                              ? "fetching"
                              : undefined
                        }
                      />
                    </TableCell>
                    <TableCell className="max-w-32 truncate">
                      {article.author || "未标注"}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {formatDate(article.create_time)}
                    </TableCell>
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
            {!loading && articles.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-36 text-center text-muted-foreground"
                >
                  当前公众号还没有本地文章索引
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </WorkspaceShell>
  )
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

function useAccountArticles(fakeid: string, refreshKey: number) {
  const [articles, setArticles] = useState<ArticleSummary[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    api
      .listArticles(fakeid)
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
  }, [fakeid, refreshKey])

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
