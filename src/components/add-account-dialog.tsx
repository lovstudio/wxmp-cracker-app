import { useState } from "react"
import {
  AlertCircleIcon,
  ArrowLeftIcon,
  CheckIcon,
  CheckCircle2Icon,
  CircleIcon,
  LoaderCircleIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
} from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import type { AccountSearchResult, FetchAccountProgress } from "@/lib/api"
import { normalizeWechatImageUrl } from "@/lib/media"

type Step = "search" | "fetch"
type ProcessStepState = "pending" | "running" | "done" | "warning" | "error"

interface Props {
  open: boolean
  busy: boolean
  progressEvents: FetchAccountProgress[]
  onOpenChange: (open: boolean) => void
  onSearch: (query: string) => Promise<AccountSearchResult[]>
  onSubmit: (
    account: AccountSearchResult,
    limit: number,
    withContent: boolean
  ) => void
}

export function AddAccountDialog({
  open,
  busy,
  progressEvents,
  onOpenChange,
  onSearch,
  onSubmit,
}: Props) {
  if (!open) return null

  return (
    <AddAccountDialogContent
      busy={busy}
      progressEvents={progressEvents}
      onOpenChange={onOpenChange}
      onSearch={onSearch}
      onSubmit={onSubmit}
    />
  )
}

function AddAccountDialogContent({
  busy,
  progressEvents,
  onOpenChange,
  onSearch,
  onSubmit,
}: Omit<Props, "open">) {
  const [step, setStep] = useState<Step>("search")
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchedQuery, setSearchedQuery] = useState("")
  const [searchError, setSearchError] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<AccountSearchResult[]>([])
  const [selectedFakeid, setSelectedFakeid] = useState<string | null>(null)
  const [limit, setLimit] = useState("20")
  const [withContent, setWithContent] = useState(false)

  const trimmedQuery = query.trim()
  const parsedLimit = Number.parseInt(limit, 10)
  const selectedAccount =
    searchResults.find((account) => account.fakeid === selectedFakeid) ?? null
  const hasCurrentResults =
    searchedQuery === trimmedQuery && searchResults.length > 0
  const actionBusy = busy || searching
  const canSearch = trimmedQuery.length > 0
  const canConfirmSelection = Boolean(selectedAccount)
  const canFetch =
    Boolean(selectedAccount) && Number.isFinite(parsedLimit) && parsedLimit > 0

  const resetSearchResults = () => {
    setSearchedQuery("")
    setSearchError(null)
    setSearchResults([])
    setSelectedFakeid(null)
  }

  const searchAccounts = async () => {
    if (!canSearch || actionBusy) return
    setSearching(true)
    setSearchError(null)
    setSelectedFakeid(null)

    try {
      const results = await onSearch(trimmedQuery)
      setSearchResults(results)
      setSearchedQuery(trimmedQuery)
    } catch (error) {
      setSearchResults([])
      setSearchedQuery("")
      setSearchError(errorMessage(error))
    } finally {
      setSearching(false)
    }
  }

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
              新增公众号
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {step === "search" ? "1 / 2 搜索公众号" : "2 / 2 抓取文章"}
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

        {step === "search" ? (
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
                  {searching ? (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  ) : (
                    <SearchIcon className="size-4" />
                  )}
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
          {step === "fetch" ? (
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
            {step === "search" ? (
              <Button
                type="submit"
                disabled={
                  actionBusy ||
                  (hasCurrentResults ? !canConfirmSelection : !canSearch)
                }
              >
                {searching ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : hasCurrentResults ? (
                  <CheckIcon className="size-4" />
                ) : (
                  <SearchIcon className="size-4" />
                )}
                {hasCurrentResults ? "确认选择" : "搜索公众号"}
              </Button>
            ) : (
              <Button type="submit" disabled={!canFetch || busy}>
                {busy ? (
                  <LoaderCircleIcon className="size-4 animate-spin" />
                ) : (
                  <PlusIcon className="size-4" />
                )}
                开始抓取
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
}: {
  busy: boolean
  error: string | null
  query: string
  results: AccountSearchResult[]
  selectedFakeid: string | null
  onSelect: (fakeid: string) => void
}) {
  if (busy) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/70 text-sm text-muted-foreground">
        <LoaderCircleIcon className="mr-2 size-4 animate-spin" />
        正在搜索
      </div>
    )
  }

  if (error) {
    return (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
        {error}
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
      ? `准备抓取 ${limit} 篇文章索引，并同步正文`
      : `准备抓取 ${limit} 篇文章索引`,
    current: 0,
    total: limit,
    title: null,
  }
  const visibleEvents = events.length > 0 ? events : [fallbackEvent]
  const latest = visibleEvents[visibleEvents.length - 1] ?? fallbackEvent
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
  const recentEvents = visibleEvents.slice(-8)

  return (
    <div className="rounded-md border border-border/70 bg-muted/20 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">抓取过程</div>
          <div className="mt-1 truncate text-xs text-muted-foreground">
            {latest.message}
          </div>
          {latest.title ? (
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {latest.title}
            </div>
          ) : null}
        </div>
        <FetchStateIcon state={eventState(latest)} />
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-background/80">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {fetchSteps(withContent).map((step) => {
          const state = processStepState(step.stages, visibleEvents)
          return (
            <div
              key={step.label}
              className="flex min-w-0 items-center gap-2 rounded-md border border-border/50 bg-background/45 px-2 py-1.5"
            >
              <FetchStateIcon state={state} small />
              <span className="truncate text-xs text-muted-foreground">
                {step.label}
              </span>
            </div>
          )
        })}
      </div>

      <div className="mt-3 max-h-32 space-y-1 overflow-y-auto pr-1">
        {recentEvents.map((event, index) => (
          <div
            key={`${event.stage}-${event.message}-${index}`}
            className="flex min-w-0 items-start gap-2 text-xs leading-5"
          >
            <FetchStateIcon state={eventState(event)} small />
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
        ))}
      </div>
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

function fetchSteps(withContent: boolean) {
  return [
    { label: "确认目标公众号", stages: ["prepare"] },
    { label: "写入账号信息", stages: ["account"] },
    { label: "抓取文章索引", stages: ["articles"] },
    ...(withContent ? [{ label: "抓取正文", stages: ["content"] }] : []),
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
  if (latest?.stage === "complete" && latest.status === "done") {
    return "done"
  }

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
