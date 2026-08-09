import {
  ActivityIcon,
  AlertTriangleIcon,
  BarChart3Icon,
  BookOpenTextIcon,
  GaugeIcon,
  GitForkIcon,
  InfoIcon,
  ListChecksIcon,
  Loader2Icon,
  LogInIcon,
  MoreHorizontalIcon,
  MoonIcon,
  NetworkIcon,
  PenLineIcon,
  ShieldCheckIcon,
  SunIcon,
  Table2Icon,
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
  { id: "reader", label: "阅读", icon: BookOpenTextIcon },
  { id: "collection", label: "采集管理", icon: Table2Icon },
  { id: "profile", label: "基本信息", icon: InfoIcon },
  { id: "trends", label: "趋势分析", icon: BarChart3Icon },
  { id: "style", label: "文风分析", icon: PenLineIcon },
  { id: "github-sync", label: "GitHub 归档", icon: GitForkIcon },
] satisfies Array<{
  id: WorkspaceTabId
  label: string
  icon: ComponentType<{ className?: string }>
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
    <header className="top-bar sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-2 border-b border-border/70 px-3 backdrop-blur-xl sm:gap-3 sm:px-4">
      <SidebarTrigger
        aria-label="展开或收起侧栏"
        className="-ml-1 border border-border/70 bg-card/70 text-foreground shadow-sm"
      />
      <div className="topbar-rule hidden sm:block" aria-hidden="true" />
      <nav className="workspace-tab-nav min-w-0 flex-1" aria-label="账号工作区">
        <div
          className="workspace-tab-list"
          role="tablist"
          aria-orientation="horizontal"
        >
          {workspaceTabs.map((tab, index) => {
            const Icon = tab.icon
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
                <Icon className="size-3.5" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
      {user ? (
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {typeof setupProgress === "number" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="hidden border-border/70 bg-card/70 text-foreground shadow-sm sm:inline-flex"
              aria-label="打开账号准备清单"
              onClick={onOpenSetup}
            >
              <ListChecksIcon className="size-4" />
              账号准备 {setupProgress}/3
            </Button>
          ) : null}
          <ResourceConditions />
          <WorkspaceActions
            isDark={isDark}
            onOpenLicenseAdmin={onOpenLicenseAdmin}
            onSetTheme={() => setTheme(nextTheme)}
          />
        </div>
      ) : (
        <div className="ml-auto flex items-center gap-2">
          {typeof setupProgress === "number" ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="hidden border-border/70 bg-card/70 text-foreground shadow-sm sm:inline-flex"
              aria-label="打开账号准备清单"
              onClick={onOpenSetup}
            >
              <ListChecksIcon className="size-4" />
              账号准备 {setupProgress}/3
            </Button>
          ) : null}
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
              size="icon"
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

  return (
    <div
      className="topbar-resource-group hidden min-w-0 items-center gap-1.5 lg:flex"
      role="group"
      aria-label="当前资源状态"
    >
      <ResourcePill
        icon={GaugeIcon}
        label="频率"
        value={loading && !entitlement ? "读取中" : quotaLabel}
        detail={
          entitlement && gatewayOverview
            ? `有效可用频率 = min(理论额度 ${gatewayOverview.theoretical_hourly_quota}, 可执行池 ${gatewayOverview.executable_pool_hourly_capacity}) = ${gatewayOverview.effective_hourly_quota} 次/小时。`
            : entitlement
              ? `理论额度：L${entitlement.account_level} × ${entitlement.account_level_factor} + ${entitlement.own_capability_units} × ${entitlement.own_capability_factor} = ${entitlement.hourly_quota} 次/小时。`
              : (error ?? "正在读取当前可用频率。")
        }
        loading={loading && !entitlement}
      />
      <ResourcePill
        icon={NetworkIcon}
        label="节点"
        value={providerStatusLabel(gatewayOverview?.provider_status)}
        detail={
          gatewayOverview
            ? `当前公众号节点：${providerStatusLabel(gatewayOverview.provider_status)}；健康分 ${gatewayOverview.provider_health_score}/100。`
            : (error ?? "正在读取当前节点状态。")
        }
      />
      <ResourcePill
        icon={ActivityIcon}
        label="执行池"
        value={
          gatewayOverview
            ? `${gatewayOverview.executable_pool_hourly_capacity.toLocaleString()}/h`
            : "-"
        }
        detail={
          gatewayOverview
            ? `当前账号可执行池 = 自用节点剩余 ${gatewayOverview.self_remaining_capacity} + 外部商业化池 ${gatewayOverview.commercial_pool_hourly_capacity} = ${gatewayOverview.executable_pool_hourly_capacity} 次/小时。`
            : (error ?? "正在读取可执行资源池。")
        }
      />
      <ResourcePill
        icon={AlertTriangleIcon}
        label="队列"
        value={
          gatewayOverview
            ? `${gatewayOverview.queued_requests}/${gatewayOverview.running_requests}`
            : "-"
        }
        detail={
          gatewayOverview
            ? `当前账号请求排队 ${gatewayOverview.queued_requests}，运行中 ${gatewayOverview.running_requests}，未关闭预警 ${gatewayOverview.open_alerts}。`
            : (error ?? "正在读取队列和预警。")
        }
      />
    </div>
  )
}

function ResourcePill({
  icon: Icon,
  label,
  value,
  detail,
  loading = false,
}: {
  icon: ComponentType<{ className?: string }>
  label: string
  value: string
  detail: string
  loading?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className="topbar-pill max-w-[148px]"
          role="status"
          aria-label={`${label}：${value}`}
        >
          {loading ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <Icon className="size-3.5" />
          )}
          <span className="text-muted-foreground">{label}</span>
          <span className="truncate font-mono tabular-nums">{value}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px]">
        {detail}
      </TooltipContent>
    </Tooltip>
  )
}

function providerStatusLabel(status?: string | null) {
  if (status === "online") return "在线"
  if (status === "degraded") return "降级"
  if (status === "paused") return "暂停"
  if (status === "cooldown") return "冷却"
  if (status === "offline") return "离线"
  return "-"
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
