import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckIcon,
  CheckCircle2Icon,
  CircleIcon,
  LinkIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  ShieldCheckIcon,
  XIcon,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AccountSearchResult, FetchAccountProgress } from "@/lib/api"
import { normalizeWechatImageUrl } from "@/lib/media"
import {
  isWxmpAuthError,
  isWxmpLocalCooldownError,
  isWxmpRateLimitError,
} from "@/lib/toast"
import { WXMP_BATCH_FETCH_GUARD_DESCRIPTION } from "@/lib/wxmp-availability"

type Step = "search" | "fetch"
type AddMode = "account" | "article"
type ProcessStepState = "pending" | "running" | "done" | "warning" | "error"

interface Props {
  open: boolean
  initialQuery?: string | null
  busy: boolean
  progressEvents: FetchAccountProgress[]
  loggedIn: boolean
  onOpenChange: (open: boolean) => void
  onSearch: (query: string) => Promise<AccountSearchResult[]>
  onLogin: () => void
  onSubmit: (
    account: AccountSearchResult,
    limit: number,
    withContent: boolean
  ) => void
  onImportArticleLink: (link: string) => Promise<void>
}

export function AddAccountDialog({
  open,
  initialQuery = null,
  busy,
  progressEvents,
  loggedIn,
  onOpenChange,
  onSearch,
  onLogin,
  onSubmit,
  onImportArticleLink,
}: Props) {
  if (!open) return null

  return (
    <AddAccountDialogContent
      initialQuery={initialQuery}
      busy={busy}
      progressEvents={progressEvents}
      loggedIn={loggedIn}
      onOpenChange={onOpenChange}
      onSearch={onSearch}
      onLogin={onLogin}
      onSubmit={onSubmit}
      onImportArticleLink={onImportArticleLink}
    />
  )
}

function AddAccountDialogContent({
  initialQuery,
  busy,
  progressEvents,
  loggedIn,
  onOpenChange,
  onSearch,
  onLogin,
  onSubmit,
  onImportArticleLink,
}: Omit<Props, "open">) {
  const normalizedInitialQuery = initialQuery?.trim() ?? ""
  const [mode, setMode] = useState<AddMode>(
    isWechatArticleInput(normalizedInitialQuery) ? "article" : "account"
  )
  const [step, setStep] = useState<Step>("search")
  const [query, setQuery] = useState(normalizedInitialQuery)
  const [articleLink, setArticleLink] = useState(
    isWechatArticleInput(normalizedInitialQuery) ? normalizedInitialQuery : ""
  )
  const [articleError, setArticleError] = useState<string | null>(null)
  const [importingArticle, setImportingArticle] = useState(false)
  const [searching, setSearching] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState("")
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<AccountSearchResult[]>([])
  const [selectedFakeid, setSelectedFakeid] = useState<string | null>(null)
  const [limit, setLimit] = useState("10")
  const [withContent, setWithContent] = useState(false)
  const [initialSearchStarted, setInitialSearchStarted] = useState(false)

  const trimmedQuery = query.trim()
  const trimmedArticleLink = articleLink.trim()
  const parsedLimit = Number.parseInt(limit, 10)
  const selectedAccount =
    searchResults.find((account) => account.fakeid === selectedFakeid) ?? null
  const hasCurrentResults =
    searchedQuery === trimmedQuery && searchResults.length > 0
  const actionBusy = busy || searching || importingArticle
  const rateLimited = hasRateLimitError(progressEvents)
  const canSearch = trimmedQuery.length > 0
  const canImportArticle = trimmedArticleLink.length > 0
  const canConfirmSelection = Boolean(selectedAccount)
  const canFetch =
    Boolean(selectedAccount) && Number.isFinite(parsedLimit) && parsedLimit > 0

  const switchToArticleImport = () => {
    setMode("article")
    setArticleError(null)
  }

  const resetSearchResults = () => {
    setSearchedQuery("")
    setSearchError(null)
    setSearchResults([])
    setSelectedFakeid(null)
  }

  const searchAccountsFor = useCallback(
    async (searchQuery: string) => {
      const normalizedQuery = searchQuery.trim()
      if (!normalizedQuery || busy || searching) return

      setSearching(true)
      setSearchError(null)
      setSelectedFakeid(null)

      try {
        const results = await onSearch(normalizedQuery)
        setSearchResults(results)
        setSearchedQuery(normalizedQuery)
      } catch (error) {
        setSearchResults([])
        setSearchedQuery("")
        setSearchError(errorMessage(error))
      } finally {
        setSearching(false)
      }
    },
    [busy, onSearch, searching]
  )

  const searchAccounts = async () => {
    if (!canSearch || actionBusy) return
    await searchAccountsFor(trimmedQuery)
  }

  const submitArticleLink = async () => {
    if (!canImportArticle || actionBusy) return

    setImportingArticle(true)
    setArticleError(null)
    try {
      await onImportArticleLink(trimmedArticleLink)
    } catch (error) {
      setArticleError(errorMessage(error))
    } finally {
      setImportingArticle(false)
    }
  }

  useEffect(() => {
    if (!normalizedInitialQuery || initialSearchStarted) return

    setInitialSearchStarted(true)
    void searchAccountsFor(normalizedInitialQuery)
  }, [initialSearchStarted, normalizedInitialQuery, searchAccountsFor])

  // After a successful re-login, the previous auth error is stale — clear it and
  // re-run the last search so results load without the user having to retry.
  const wasLoggedIn = useRef(loggedIn)
  useEffect(() => {
    const justLoggedIn = loggedIn && !wasLoggedIn.current
    wasLoggedIn.current = loggedIn
    if (!justLoggedIn) return

    setSearchError(null)
    if (trimmedQuery) void searchAccountsFor(trimmedQuery)
  }, [loggedIn, trimmedQuery, searchAccountsFor])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 px-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget || actionBusy) return
        onOpenChange(false)
      }}
    >
      <form
        className="dialog-panel w-full max-w-[560px] rounded-lg p-4 text-card-foreground shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault()

          if (mode === "article") {
            void submitArticleLink()
            return
          }

          if (step === "search") {
            if (hasCurrentResults) {
              if (!canConfirmSelection) return
              setStep("fetch")
              return
            }

            void searchAccounts()
            return
          }

          if (!selectedAccount || !canFetch || busy) return
          onSubmit(
            selectedAccount,
            Math.min(Math.max(parsedLimit, 1), 500),
            withContent
          )
        }}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <div className="font-heading text-lg leading-none font-semibold">
              新增内容
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {mode === "account"
                ? step === "search"
                  ? "1 / 2 搜索公众号"
                  : "2 / 2 抓取文章"
                : "文章链接"}
            </div>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="size-8"
            disabled={actionBusy}
            onClick={() => onOpenChange(false)}
          >
            <XIcon className="size-4" />
          </Button>
        </div>

        <div className="mb-4 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
          <button
            type="button"
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors ${
              mode === "account"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={actionBusy}
            onClick={() => {
              setMode("account")
              setArticleError(null)
            }}
          >
            <SearchIcon className="size-4" />
            公众号
          </button>
          <button
            type="button"
            className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-2 text-sm font-medium transition-colors ${
              mode === "article"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
            disabled={actionBusy}
            onClick={() => {
              setMode("article")
              setArticleError(null)
            }}
          >
            <LinkIcon className="size-4" />
            文章链接
          </button>
        </div>

        {mode === "article" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="article-link">微信公众号文章链接</Label>
              <Input
                id="article-link"
                value={articleLink}
                disabled={actionBusy}
                autoFocus
                placeholder="https://mp.weixin.qq.com/s/..."
                onChange={(event) => {
                  setArticleLink(event.target.value)
                  setArticleError(null)
                }}
              />
            </div>

            {articleError ? (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <AlertCircleIcon className="mt-0.5 size-4 shrink-0" />
                <span className="min-w-0 break-words">{articleError}</span>
              </div>
            ) : null}
          </div>
        ) : step === "search" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="track-query">公众号名称</Label>
              <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2">
                <Input
                  id="track-query"
                  value={query}
                  disabled={actionBusy}
                  autoFocus
                  placeholder="例如：人民日报"
                  onChange={(event) => {
                    setQuery(event.target.value)
                    resetSearchResults()
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canSearch || actionBusy}
                  onClick={() => void searchAccounts()}
                >
                  <SearchIcon className="size-4" />
                  搜索
                </Button>
              </div>
            </div>

            <SearchResults
              busy={searching}
              error={searchError}
              query={searchedQuery}
              results={searchResults}
              selectedFakeid={selectedFakeid}
              onSelect={setSelectedFakeid}
              onLogin={onLogin}
              onImportArticle={switchToArticleImport}
            />
          </div>
        ) : (
          <div className="space-y-4">
            {selectedAccount ? (
              <SelectedAccount account={selectedAccount} />
            ) : null}

            <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-3">
              <div className="space-y-2">
                <Label htmlFor="track-limit">抓取篇数</Label>
                <Input
                  id="track-limit"
                  type="number"
                  min={1}
                  max={500}
                  value={limit}
                  disabled={busy}
                  onChange={(event) => setLimit(event.target.value)}
                />
              </div>
              <label className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-muted/35 px-3 text-sm">
                <Checkbox
                  checked={withContent}
                  disabled={busy}
                  onCheckedChange={(checked) =>
                    setWithContent(checked === true)
                  }
                />
                <span>抓正文</span>
              </label>
            </div>

            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-5 text-muted-foreground">
              <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>{WXMP_BATCH_FETCH_GUARD_DESCRIPTION}</span>
            </div>

            {selectedAccount && (busy || progressEvents.length > 0) ? (
              <FetchProcess
                account={selectedAccount}
                events={progressEvents}
                limit={Math.min(Math.max(parsedLimit || 1, 1), 500)}
                withContent={withContent}
              />
            ) : null}
          </div>
        )}

        <div className="mt-5 flex items-center justify-between gap-2">
          {mode === "account" && step === "fetch" ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setStep("search")}
            >
              <ArrowLeftIcon className="size-4" />
              上一步
            </Button>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={actionBusy}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            {mode === "article" ? (
              <Button type="submit" disabled={!canImportArticle || actionBusy}>
                {importingArticle ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <LinkIcon className="size-4" />
                )}
                抓取并录入
              </Button>
            ) : step === "search" ? (
              <Button
                type="submit"
                disabled={
                  actionBusy ||
                  (hasCurrentResults ? !canConfirmSelection : !canSearch)
                }
              >
                {hasCurrentResults ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <SearchIcon className="size-4" />
                )}
                {hasCurrentResults ? "确认选择" : "搜索公众号"}
              </Button>
            ) : rateLimited ? (
              <Button
                type="button"
                disabled={actionBusy}
                onClick={switchToArticleImport}
              >
                改用文章链接
              </Button>
            ) : (
              <Button type="submit" disabled={!canFetch || busy}>
                {!busy ? <PlusIcon className="size-4" /> : null}
                {busy ? "抓取中" : "开始抓取"}
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

function SearchResults({
  busy,
  error,
  query,
  results,
  selectedFakeid,
  onSelect,
  onLogin,
  onImportArticle,
}: {
  busy: boolean
  error: string | null
  query: string
  results: AccountSearchResult[]
  selectedFakeid: string | null
  onSelect: (fakeid: string) => void
  onLogin: () => void
  onImportArticle: () => void
}) {
  if (busy) {
    return (
      <div
        className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/70 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
        正在搜索
      </div>
    )
  }

  if (error) {
    const isAuthError = isWxmpAuthError(error)
    const isRateLimitError = isWxmpRateLimitError(error)
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        <span className="min-w-0 break-words">{error}</span>
        {isAuthError || isRateLimitError ? (
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0"
            onClick={isAuthError ? onLogin : onImportArticle}
          >
            {isAuthError ? "重新登录" : "文章链接"}
          </Button>
        ) : null}
      </div>
    )
  }

  if (query && results.length === 0) {
    return (
      <div className="rounded-md border border-border/70 bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
        没有找到匹配的公众号
      </div>
    )
  }

  if (results.length === 0) return null

  return (
    <div className="max-h-[300px] space-y-2 overflow-y-auto pr-1">
      {results.map((account) => (
        <AccountResult
          key={account.fakeid}
          account={account}
          selected={selectedFakeid === account.fakeid}
          onSelect={() => onSelect(account.fakeid)}
        />
      ))}
    </div>
  )
}

function FetchProcess({
  account,
  events,
  limit,
  withContent,
}: {
  account: AccountSearchResult
  events: FetchAccountProgress[]
  limit: number
  withContent: boolean
}) {
  const fallbackEvent: FetchAccountProgress = {
    fakeid: account.fakeid,
    nickname: account.nickname,
    stage: "prepare",
    status: "running",
    message: withContent
      ? `准备获取 ${limit} 篇文章索引，并同步正文`
      : `准备获取 ${limit} 篇文章索引`,
    current: 0,
    total: limit,
    title: null,
  }
  const visibleEvents = events.length > 0 ? events : [fallbackEvent]
  const latest = visibleEvents[visibleEvents.length - 1] ?? fallbackEvent
  const steps = fetchSteps(withContent)
  const currentStepIndex = activeFetchStepIndex(steps, visibleEvents)
  const currentStep = steps[currentStepIndex] ?? steps[0]
  const localCooldown = isWxmpLocalCooldownError(latest.message)
  const rateLimited = isWxmpRateLimitError(latest.message)
  const progressEvent =
    [...visibleEvents]
      .reverse()
      .find(
        (event) =>
          typeof event.current === "number" &&
          typeof event.total === "number" &&
          event.total > 0
      ) ?? fallbackEvent
  const progressPercent =
    typeof progressEvent.current === "number" &&
    typeof progressEvent.total === "number" &&
    progressEvent.total > 0
      ? Math.min(
          Math.max((progressEvent.current / progressEvent.total) * 100, 0),
          100
        )
      : 0
  const headline = localCooldown
    ? "本地保护冷却中"
    : rateLimited
      ? "微信文章列表接口限流"
      : latest.status === "error"
        ? "抓取中断"
        : latest.status === "warning"
          ? "部分内容需要重试"
          : latest.stage === "complete" && latest.status === "done"
            ? "抓取完成"
            : currentStep.label

  return (
    <div
      className="rounded-lg border border-border/70 bg-muted/20 p-3"
      aria-busy={latest.status === "running"}
      aria-live="polite"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium">{headline}</div>
        <div
          className={`mt-1 text-xs text-muted-foreground ${
            latest.status === "error" || latest.status === "warning"
              ? "leading-5 break-words"
              : "truncate"
          }`}
        >
          {latest.message}
        </div>
        {latest.title ? (
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {latest.title}
          </div>
        ) : null}
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <ol
        className={`mt-3 grid gap-2 ${steps.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}
      >
        {steps.map((step, index) => {
          const state = fetchStepState(step, index, currentStepIndex, latest)
          const isCurrent = index === currentStepIndex && state !== "done"
          return (
            <li
              key={step.label}
              className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 ${
                state === "error"
                  ? "border-destructive/40 bg-destructive/10"
                  : isCurrent
                    ? "border-primary/40 bg-primary/10"
                    : "border-border/50 bg-background/45"
              }`}
              aria-current={isCurrent ? "step" : undefined}
            >
              <FetchStateIcon state={state} small />
              <span className="min-w-0">
                <span className="block text-[10px] leading-none text-muted-foreground">
                  第 {index + 1} 步
                </span>
                <span
                  className={`mt-1 block truncate text-xs ${
                    isCurrent
                      ? "font-medium text-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {step.label}
                </span>
              </span>
            </li>
          )
        })}
      </ol>

      {rateLimited ? (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5">
          <div className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
            <ShieldCheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>
              {localCooldown
                ? "这是应用依据上一次 ret=200013 设置的本地保护，本次没有请求微信。重新登录不会解除；界面所示时间也不是微信给出的解封时间。"
                : "微信文章列表接口刚返回 ret=200013；应用随后自行暂停该接口一小时。这个保护时间不是微信给出的解封时间，也不等于公众号后台账号异常。"}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function FetchStateIcon({
  state,
  small = false,
}: {
  state: ProcessStepState
  small?: boolean
}) {
  const size = small ? "size-3.5" : "size-4"

  if (state === "done") {
    return <CheckCircle2Icon className={`${size} shrink-0 text-primary`} />
  }

  if (state === "running") {
    return (
      <LoaderCircleIcon
        className={`${size} shrink-0 animate-spin text-primary`}
      />
    )
  }

  if (state === "warning" || state === "error") {
    return <AlertCircleIcon className={`${size} shrink-0 text-destructive`} />
  }

  return <CircleIcon className={`${size} shrink-0 text-muted-foreground/55`} />
}

function AccountResult({
  account,
  selected,
  onSelect,
}: {
  account: AccountSearchResult
  selected: boolean
  onSelect: () => void
}) {
  const alias = cleanText(account.alias)
  const signature = cleanText(account.signature)

  return (
    <button
      type="button"
      className={`flex w-full min-w-0 items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors ${
        selected
          ? "border-primary/70 bg-primary/10 ring-2 ring-ring/25"
          : "border-border/70 bg-background/55 hover:bg-muted/45"
      }`}
      aria-pressed={selected}
      onClick={onSelect}
    >
      <AccountAvatar account={account} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {account.nickname}
          </span>
          {alias ? (
            <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {alias}
            </span>
          ) : null}
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {account.fakeid}
        </div>
        {signature ? (
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {signature}
          </div>
        ) : null}
      </div>
      {selected ? <CheckIcon className="size-4 shrink-0 text-primary" /> : null}
    </button>
  )
}

function SelectedAccount({ account }: { account: AccountSearchResult }) {
  const alias = cleanText(account.alias)
  const signature = cleanText(account.signature)

  return (
    <div className="flex min-w-0 items-center gap-3 rounded-md border border-primary/35 bg-primary/10 px-3 py-2">
      <AccountAvatar account={account} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">
            {account.nickname}
          </span>
          {alias ? (
            <span className="shrink-0 rounded-sm border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {alias}
            </span>
          ) : null}
        </div>
        <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground">
          {account.fakeid}
        </div>
        {signature ? (
          <div className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
            {signature}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function AccountAvatar({ account }: { account: AccountSearchResult }) {
  const avatar = normalizeWechatImageUrl(account.avatar)

  return (
    <Avatar size="lg">
      {avatar ? (
        <AvatarImage
          src={avatar}
          alt=""
          referrerPolicy="no-referrer"
          loading="lazy"
          decoding="async"
        />
      ) : null}
      <AvatarFallback>{account.nickname[0] ?? "?"}</AvatarFallback>
    </Avatar>
  )
}

function cleanText(value: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}

function isWechatArticleInput(value: string) {
  return /^https?:\/\/mp\.weixin\.qq\.com\//i.test(value.trim())
}

function fetchSteps(withContent: boolean) {
  return [
    {
      label: "获取文章列表",
      stages: ["prepare", "account", "articles"],
      completedBy: "articles",
    },
    ...(withContent
      ? [
          {
            label: "下载文章正文",
            stages: ["content"],
            completedBy: "content",
          },
        ]
      : []),
    { label: "完成", stages: ["complete"], completedBy: "complete" },
  ]
}

function hasRateLimitError(events: FetchAccountProgress[]) {
  return events.some(
    (event) => event.status === "error" && isWxmpRateLimitError(event.message)
  )
}

type FetchStep = ReturnType<typeof fetchSteps>[number]

function activeFetchStepIndex(
  steps: FetchStep[],
  events: FetchAccountProgress[]
): number {
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const stepIndex = steps.findIndex((step) =>
      step.stages.includes(events[eventIndex].stage)
    )
    if (stepIndex >= 0) return stepIndex
  }

  return 0
}

function fetchStepState(
  step: FetchStep,
  stepIndex: number,
  currentStepIndex: number,
  latest: FetchAccountProgress
): ProcessStepState {
  if (stepIndex < currentStepIndex) return "done"
  if (stepIndex > currentStepIndex) return "pending"
  if (latest.status === "error") return "error"
  if (latest.status === "warning") return "warning"
  if (latest.status === "done" && latest.stage === step.completedBy)
    return "done"

  return "running"
}
