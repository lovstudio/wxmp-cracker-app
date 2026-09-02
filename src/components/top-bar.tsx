import {
  ActivityIcon,
  AlertTriangleIcon,
  CheckCircle2Icon,
  GaugeIcon,
  ListChecksIcon,
  Loader2Icon,
  LogInIcon,
  MoreHorizontalIcon,
  MoonIcon,
  NetworkIcon,
  ShieldCheckIcon,
  SunIcon,
} from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTheme } from "@/components/theme-provider"
import { useAuth } from "@/hooks/useAuth"
import {
  fetchMyGatewayOverview,
  fetchMyQuotaEntitlement,
  type GatewayOverview,
  type QuotaEntitlement,
} from "@/lib/quota"
import { RESOURCE_CONDITIONS_REFRESH_EVENT } from "@/lib/gateway"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from "react"

export type WorkspaceTabId =
  | "reader"
  | "collection"
  | "tags"
  | "profile"
  | "trends"
  | "style"
  | "github-sync"

interface TopBarProps {
  activeTab: WorkspaceTabId
  setupProgress?: number
  onOpenLicenseAdmin: () => void
  onOpenLovstudioLogin: () => void
  onOpenSetup: () => void
  onTabChange: (tab: WorkspaceTabId) => void
}

const RESOURCE_REFRESH_MS = 10_000

const workspaceTabs = [
  { id: "reader", label: "阅读" },
  { id: "collection", label: "文章管理" },
  { id: "tags", label: "标签管理" },
  { id: "profile", label: "基本信息" },
  { id: "trends", label: "趋势分析" },
  { id: "style", label: "文风分析" },
  { id: "github-sync", label: "GitHub 归档" },
] satisfies Array<{
  id: WorkspaceTabId
  label: string
}>

export function TopBar({
  activeTab,
  setupProgress,
  onOpenLicenseAdmin,
  onOpenLovstudioLogin,
  onOpenSetup,
  onTabChange,
}: TopBarProps) {
  const { isLoading: authLoading, user } = useAuth()
  const { theme, setTheme } = useTheme()
  const isDark = theme === "dark"
  const nextTheme = isDark ? "light" : "dark"
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  const handleTabKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number
  ) => {
    const nextIndex =
      event.key === "ArrowRight"
        ? (index + 1) % workspaceTabs.length
        : event.key === "ArrowLeft"
          ? (index - 1 + workspaceTabs.length) % workspaceTabs.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? workspaceTabs.length - 1
              : null

    if (nextIndex === null) return

    event.preventDefault()
    onTabChange(workspaceTabs[nextIndex].id)
    requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus())
  }

  return (
    <header className="top-bar sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border/70 px-3 backdrop-blur-xl sm:px-4">
      <SidebarTrigger
        aria-label="展开或收起侧栏"
        className="topbar-action-button -ml-1"
      />
      <div className="topbar-rule hidden sm:block" aria-hidden="true" />
      <nav className="workspace-tab-nav min-w-0 flex-1" aria-label="账号工作区">
        <div
          className="workspace-tab-list"
          role="tablist"
          aria-orientation="horizontal"
        >
          {workspaceTabs.map((tab, index) => {
            const selected = activeTab === tab.id

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                data-active={selected}
                className="workspace-tab"
                ref={(element) => {
                  tabRefs.current[index] = element
                }}
                onClick={() => onTabChange(tab.id)}
                onKeyDown={(event) => handleTabKeyDown(event, index)}
              >
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
      {user ? (
        <div className="topbar-utility-cluster ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
          <SetupProgressButton progress={setupProgress} onOpen={onOpenSetup} />
          <ResourceConditions />
          <WorkspaceActions
            isDark={isDark}
            onOpenLicenseAdmin={onOpenLicenseAdmin}
            onSetTheme={() => setTheme(nextTheme)}
          />
        </div>
      ) : (
        <div className="topbar-utility-cluster ml-auto flex items-center gap-1.5">
          <SetupProgressButton progress={setupProgress} onOpen={onOpenSetup} />
          <Button
            type="button"
            size="sm"
            className="shadow-sm"
            disabled={authLoading}
            onClick={onOpenLovstudioLogin}
          >
            {authLoading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <LogInIcon className="size-4" />
            )}
            登录 Lovstudio
          </Button>
        </div>
      )}
    </header>
  )
}

function SetupProgressButton({
  progress,
  onOpen,
}: {
  progress?: number
  onOpen: () => void
}) {
  if (typeof progress !== "number") return null

  const complete = progress >= 3
  const label = complete ? "账号已准备" : `账号准备 ${progress}/3`

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="topbar-setup-button hidden md:inline-flex"
      aria-label={`${label}，打开准备清单`}
      onClick={onOpen}
    >
      {complete ? (
        <CheckCircle2Icon className="size-3.5" />
      ) : (
        <ListChecksIcon className="size-3.5" />
      )}
      {label}
    </Button>
  )
}

function WorkspaceActions({
  isDark,
  onOpenLicenseAdmin,
  onSetTheme,
}: {
  isDark: boolean
  onOpenLicenseAdmin: () => void
  onSetTheme: () => void
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="打开工作区选项"
              className="topbar-action-button"
            >
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">更多工作区选项</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" className="w-56">
        <DropdownMenuLabel className="px-2 text-xs text-muted-foreground">
          工作区选项
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onOpenLicenseAdmin}>
          <ShieldCheckIcon />
          授权与额度管理
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onSetTheme}>
          {isDark ? <SunIcon /> : <MoonIcon />}
          {isDark ? "切换浅色主题" : "切换深色主题"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ResourceConditions() {
  const { user } = useAuth()
  const [entitlement, setEntitlement] = useState<QuotaEntitlement | null>(null)
  const [gatewayOverview, setGatewayOverview] =
    useState<GatewayOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const quotaLabel = useMemo(() => {
    if (gatewayOverview) {
      return `${gatewayOverview.effective_hourly_quota.toLocaleString()}/h`
    }
    if (!entitlement) return "-"
    return `${entitlement.hourly_quota.toLocaleString()}/h`
  }, [entitlement, gatewayOverview])

  const refresh = useCallback(async () => {
    if (!user) {
      setEntitlement(null)
      setGatewayOverview(null)
      setError(null)
      return
    }

    setLoading(true)
    try {
      const [nextEntitlement, nextGatewayOverview] = await Promise.all([
        fetchMyQuotaEntitlement(user.id),
        fetchMyGatewayOverview(user.id),
      ])
      setEntitlement(nextEntitlement)
      setGatewayOverview(nextGatewayOverview)
      setError(null)
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void refresh()
    const interval = window.setInterval(
      () => void refresh(),
      RESOURCE_REFRESH_MS
    )

    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        void refresh()
      }
    }
    const refreshWhenResourceChanges = () => void refresh()
    document.addEventListener("visibilitychange", refreshWhenVisible)
    window.addEventListener(
      RESOURCE_CONDITIONS_REFRESH_EVENT,
      refreshWhenResourceChanges
    )

    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", refreshWhenVisible)
      window.removeEventListener(
        RESOURCE_CONDITIONS_REFRESH_EVENT,
        refreshWhenResourceChanges
      )
    }
  }, [refresh])

  if (!user) return null

  const providerLabel = providerStatusLabel(gatewayOverview?.provider_status)
  const openAlerts = gatewayOverview?.open_alerts ?? 0
  const isInitialLoad = loading && !entitlement && !gatewayOverview
  const state = error
    ? "error"
    : isInitialLoad
      ? "loading"
      : openAlerts > 0 ||
          (gatewayOverview?.provider_status &&
            gatewayOverview.provider_status !== "online")
        ? "warning"
        : entitlement || gatewayOverview
          ? "ready"
          : "unknown"
  const summaryLabel = error
    ? "资源异常"
    : isInitialLoad
      ? "读取资源"
      : openAlerts > 0
        ? `${openAlerts} 项预警`
        : gatewayOverview?.provider_status === "online"
          ? "资源正常"
          : providerLabel === "-"
            ? "资源待同步"
            : providerLabel
  const quotaDetail =
    entitlement && gatewayOverview
      ? `当前每小时实际可用的采集次数：${gatewayOverview.effective_hourly_quota} 次/小时。`
      : entitlement
        ? `根据账号等级计算的每小时上限：${entitlement.hourly_quota} 次/小时。`
        : (error ?? "正在读取当前可用频率。")
  const providerDetail = gatewayOverview
    ? `当前公众号账号：${providerLabel}；稳定性 ${gatewayOverview.provider_health_score}/100。`
    : (error ?? "正在读取当前账号状态。")
  const poolDetail = gatewayOverview
    ? `综合当前可用资源后的每小时上限：${gatewayOverview.executable_pool_hourly_capacity} 次/小时。`
    : (error ?? "正在计算可用上限。")
  const queueDetail = gatewayOverview
    ? `当前账号请求排队 ${gatewayOverview.queued_requests}，进行中 ${gatewayOverview.running_requests}，未处理提醒 ${openAlerts}。`
    : (error ?? "正在读取请求状态。")

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="topbar-resource-summary hidden min-w-0 lg:inline-flex"
          role="status"
          tabIndex={0}
          data-state={state}
          aria-label={`运行资源：${summaryLabel}，可用频率 ${quotaLabel}`}
        >
          {isInitialLoad ? (
            <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
          ) : (
            <span className="topbar-resource-dot" aria-hidden="true" />
          )}
          <span className="topbar-resource-label">{summaryLabel}</span>
          <span className="topbar-resource-divider" aria-hidden="true" />
          <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate font-mono tabular-nums">{quotaLabel}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        align="end"
        className="w-[320px] max-w-[calc(100vw-24px)] px-3 py-3"
      >
        <div className="font-heading text-sm font-semibold">运行资源</div>
        <div className="mt-1 text-[11px] text-background/70">
          当前账号的可用频率与请求情况
        </div>
        <div className="mt-3 grid gap-2.5">
          <ResourceDetail
            icon={GaugeIcon}
            label="可用频率"
            value={isInitialLoad ? "读取中" : quotaLabel}
            detail={quotaDetail}
          />
          <ResourceDetail
            icon={NetworkIcon}
            label="公众号账号"
            value={providerLabel}
            detail={providerDetail}
          />
          <ResourceDetail
            icon={ActivityIcon}
            label="可用上限"
            value={
              gatewayOverview
                ? `${gatewayOverview.executable_pool_hourly_capacity.toLocaleString()}/h`
                : "-"
            }
            detail={poolDetail}
          />
          <ResourceDetail
            icon={AlertTriangleIcon}
            label="队列 / 运行"
            value={
              gatewayOverview
                ? `${gatewayOverview.queued_requests}/${gatewayOverview.running_requests}`
                : "-"
            }
            detail={queueDetail}
          />
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ResourceDetail({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  detail: string
}) {
  return (
    <div className="grid grid-cols-[18px_minmax(0,1fr)_auto] items-start gap-x-2">
      <Icon className="mt-0.5 size-3.5 text-background/70" />
      <div className="min-w-0">
        <div className="text-xs font-medium">{label}</div>
        <div className="mt-0.5 text-[10px] leading-relaxed text-background/65">
          {detail}
        </div>
      </div>
      <span className="font-mono text-xs font-medium tabular-nums">
        {value}
      </span>
    </div>
  )
}

function providerStatusLabel(status?: string | null) {
  if (status === "online") return "在线"
  if (status === "degraded") return "受限"
  if (status === "paused") return "暂停"
  if (status === "cooldown") return "暂歇"
  if (status === "offline") return "离线"
  return "-"
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
