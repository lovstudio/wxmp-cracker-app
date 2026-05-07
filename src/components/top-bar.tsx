import {
  ActivityIcon,
  AlertTriangleIcon,
  BarChart3Icon,
  BookOpenTextIcon,
  GaugeIcon,
  InfoIcon,
  Loader2Icon,
  MoonIcon,
  NetworkIcon,
  PenLineIcon,
  ShieldCheckIcon,
  SunIcon,
  Table2Icon,
} from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
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
  useState,
  type ComponentType,
} from "react"

export type WorkspaceTabId =
  | "reader"
  | "collection"
  | "profile"
  | "trends"
  | "style"

interface TopBarProps {
  activeTab: WorkspaceTabId
  onOpenLicenseAdmin: () => void
  onTabChange: (tab: WorkspaceTabId) => void
}

const RESOURCE_REFRESH_MS = 10_000

const workspaceTabs = [
  { id: "reader", label: "阅读", icon: BookOpenTextIcon },
  { id: "collection", label: "采集管理", icon: Table2Icon },
  { id: "profile", label: "基本信息", icon: InfoIcon },
  { id: "trends", label: "趋势分析", icon: BarChart3Icon },
  { id: "style", label: "文风分析", icon: PenLineIcon },
] satisfies Array<{
  id: WorkspaceTabId
  label: string
  icon: ComponentType<{ className?: string }>
}>

export function TopBar({
  activeTab,
  onOpenLicenseAdmin,
  onTabChange,
}: TopBarProps) {
  const { theme, setTheme } = useTheme()
  const isDark = theme === "dark"
  const nextTheme = isDark ? "light" : "dark"

  return (
    <header className="top-bar sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-3 border-b border-border/70 px-4 backdrop-blur-xl">
      <SidebarTrigger className="-ml-1 border border-border/70 bg-card/70 text-foreground shadow-sm" />
      <Separator orientation="vertical" className="h-5 bg-border/70" />
      <nav className="workspace-tab-nav min-w-0 flex-1" aria-label="账号工作区">
        <div className="workspace-tab-list" role="tablist">
          {workspaceTabs.map((tab) => {
            const Icon = tab.icon
            const selected = activeTab === tab.id

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-active={selected}
                className="workspace-tab"
                onClick={() => onTabChange(tab.id)}
              >
                <Icon className="size-3.5" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
      <ResourceConditions />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label="打开授权与频率管理"
            className="border-border/70 bg-card/70 text-foreground shadow-sm"
            onClick={onOpenLicenseAdmin}
          >
            <ShieldCheckIcon className="size-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">授权与频率管理</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
            className="border-border/70 bg-card/70 text-foreground shadow-sm"
            onClick={() => setTheme(nextTheme)}
          >
            {isDark ? (
              <SunIcon className="size-4" />
            ) : (
              <MoonIcon className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isDark ? "切换浅色主题" : "切换深色主题"}
        </TooltipContent>
      </Tooltip>
    </header>
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

  if (!user) {
    return (
      <div className="hidden items-center gap-2 lg:flex">
        <ResourcePill
          icon={ShieldCheckIcon}
          label="资源"
          value="未登录"
          detail="登录 Lovstudio 后显示当前可用频率、节点与队列资源。"
        />
      </div>
    )
  }

  return (
    <div className="hidden min-w-0 items-center gap-2 lg:flex">
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
        <div className="topbar-pill max-w-[148px]" role="status">
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
