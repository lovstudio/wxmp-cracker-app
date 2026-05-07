import { useCallback, useEffect, useMemo, useState } from "react"
import {
  GaugeIcon,
  Loader2Icon,
  NetworkIcon,
  RefreshCwIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  WechatCapabilityStatusFeedback,
  WechatCommercialAuthorizationSetting,
  WechatSelfCapabilityPreferenceControl,
  useWechatCapabilityQuotaRevision,
} from "@/components/wechat-capability-settings"
import { useAuth } from "@/hooks/useAuth"
import {
  fetchMyGatewayOverview,
  fetchMyQuotaEntitlement,
  type GatewayOverview,
  type QuotaEntitlement,
} from "@/lib/quota"

export function QuotaSettingsPanel() {
  const { user } = useAuth()
  const quotaRevision = useWechatCapabilityQuotaRevision()
  const [entitlement, setEntitlement] = useState<QuotaEntitlement | null>(null)
  const [gatewayOverview, setGatewayOverview] =
    useState<GatewayOverview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const quotaBreakdown = useMemo(() => {
    if (!entitlement) return null
    const accountAllowance =
      entitlement.account_level * entitlement.account_level_factor
    const capabilityAllowance =
      entitlement.own_capability_units * entitlement.own_capability_factor
    const theoreticalAllowance =
      gatewayOverview?.theoretical_hourly_quota ?? entitlement.hourly_quota
    const executablePool =
      gatewayOverview?.executable_pool_hourly_capacity ?? null
    const effectiveAllowance =
      gatewayOverview?.effective_hourly_quota ?? theoreticalAllowance
    return {
      accountAllowance,
      capabilityAllowance,
      theoreticalAllowance,
      executablePool,
      effectiveAllowance,
    }
  }, [entitlement, gatewayOverview])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      if (!user) {
        setEntitlement(null)
        setGatewayOverview(null)
        return
      }

      const [nextEntitlement, nextGatewayOverview] = await Promise.all([
        fetchMyQuotaEntitlement(user.id),
        fetchMyGatewayOverview(user.id),
      ])
      setEntitlement(nextEntitlement)
      setGatewayOverview(nextGatewayOverview)
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setLoading(false)
    }
  }, [user])

  useEffect(() => {
    void refresh()
  }, [refresh, quotaRevision])

  return (
    <div className="grid min-w-0 gap-4 pb-1">
      <section className="min-w-0 rounded-xl border border-border bg-background/80 p-4">
        <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <GaugeIcon className="size-4 text-primary" />
            <div className="text-sm font-semibold">接口频率</div>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-label="刷新频率"
            disabled={loading}
            onClick={() => void refresh()}
          >
            {loading ? (
              <Loader2Icon className="size-4 animate-spin" />
            ) : (
              <RefreshCwIcon className="size-4" />
            )}
          </Button>
        </div>
        {user ? (
          <>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <QuotaMetric
                label="账号级别"
                value={entitlement ? `L${entitlement.account_level}` : "-"}
                detail={
                  entitlement
                    ? `当前账号等级为 L${entitlement.account_level}；未授权账号按服务端默认等级计算。`
                    : "正在读取授权等级。"
                }
              />
              <QuotaMetric
                label="理论额度"
                value={quotaBreakdown?.theoreticalAllowance ?? "-"}
                detail={
                  entitlement && quotaBreakdown
                    ? `L${entitlement.account_level} × ${entitlement.account_level_factor} + ${entitlement.own_capability_units} × ${entitlement.own_capability_factor} = ${quotaBreakdown.theoreticalAllowance} 次/小时`
                    : "正在计算理论频率额度。"
                }
              />
              <QuotaMetric
                label="执行池"
                value={quotaBreakdown?.executablePool ?? "-"}
                detail={
                  quotaBreakdown &&
                  quotaBreakdown.executablePool !== null &&
                  gatewayOverview
                    ? `自用节点剩余 ${gatewayOverview.self_remaining_capacity} + 外部商业化池 ${gatewayOverview.commercial_pool_hourly_capacity} = ${quotaBreakdown.executablePool} 次/小时`
                    : "正在计算当前可执行资源池。"
                }
              />
              <QuotaMetric
                label="有效频率"
                value={quotaBreakdown?.effectiveAllowance ?? "-"}
                detail={
                  quotaBreakdown
                    ? `min(理论额度 ${quotaBreakdown.theoreticalAllowance}, 执行池 ${quotaBreakdown.executablePool ?? quotaBreakdown.theoreticalAllowance}) = ${quotaBreakdown.effectiveAllowance} 次/小时`
                    : "正在汇总可用频率。"
                }
              />
            </div>
            {error ? (
              <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </>
        ) : (
          <div className="rounded-lg border border-border bg-muted/45 px-3 py-3 text-sm text-muted-foreground">
            登录 Lovstudio 后同步频率额度。
          </div>
        )}
      </section>

      {user ? (
        <>
          <section className="min-w-0 rounded-xl border border-border bg-background/80 p-4">
            <div className="mb-3 flex min-w-0 items-center gap-2">
              <NetworkIcon className="size-4 text-primary" />
              <div className="text-sm font-semibold">能力网关</div>
            </div>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
              <QuotaMetric
                label="当前节点"
                value={providerStatusLabel(gatewayOverview?.provider_status)}
                detail={
                  gatewayOverview
                    ? `当前公众号节点状态为 ${providerStatusLabel(gatewayOverview.provider_status)}；自用 ${gatewayOverview.self_use_enabled ? "已启用" : "未启用"}，商业化 ${gatewayOverview.commercial_enabled ? "已授权" : "未授权"}。`
                    : "正在读取当前公众号节点。"
                }
              />
              <QuotaMetric
                label="健康分"
                value={gatewayOverview?.provider_health_score ?? "-"}
                detail={
                  gatewayOverview
                    ? `当前节点健康分 ${gatewayOverview.provider_health_score}/100；系统会结合失败率、限频、冷却与最近心跳调整。`
                    : "正在读取健康分。"
                }
              />
              <QuotaMetric
                label="池节点"
                value={gatewayOverview?.commercial_pool_nodes ?? "-"}
                detail={
                  gatewayOverview
                    ? `外部商业化支持池中当前可调度公众号节点数为 ${gatewayOverview.commercial_pool_nodes}。`
                    : "正在统计外部商业化支持池。"
                }
              />
              <QuotaMetric
                label="外部池剩余"
                value={gatewayOverview?.commercial_pool_hourly_capacity ?? "-"}
                detail={
                  gatewayOverview
                    ? `外部在线或降级且未冷却的商业化节点剩余额度求和：${gatewayOverview.commercial_pool_hourly_capacity} 次/小时。`
                    : "正在计算外部商业化池剩余能力。"
                }
              />
              <QuotaMetric
                label="自用剩余"
                value={gatewayOverview?.self_remaining_capacity ?? "-"}
                detail={
                  gatewayOverview
                    ? `当前自用公众号节点本小时剩余 ${gatewayOverview.self_remaining_capacity} 次；理论自用额度为 ${gatewayOverview.self_hourly_quota} 次/小时。`
                    : "正在计算自用节点剩余能力。"
                }
              />
              <QuotaMetric
                label="商业化能力"
                value={gatewayOverview?.commercial_capability_units ?? "-"}
                detail={
                  gatewayOverview
                    ? `当前公众号对外可贡献 ${gatewayOverview.commercial_capability_units} 个商业化能力单元；是否实际被调度还取决于健康分、冷却与剩余容量。`
                    : "正在读取商业化能力单元。"
                }
              />
              <QuotaMetric
                label="排队/运行"
                value={
                  gatewayOverview
                    ? `${gatewayOverview.queued_requests}/${gatewayOverview.running_requests}`
                    : "-"
                }
                detail={
                  gatewayOverview
                    ? `当前账号发起的网关请求：排队 ${gatewayOverview.queued_requests}，执行中 ${gatewayOverview.running_requests}。`
                    : "正在读取请求队列。"
                }
              />
              <QuotaMetric
                label="预警"
                value={gatewayOverview?.open_alerts ?? "-"}
                detail={
                  gatewayOverview
                    ? `当前账号未关闭预警 ${gatewayOverview.open_alerts} 条；最近健康事件：${formatEventTime(gatewayOverview.last_health_event_at)}。`
                    : "正在读取预警状态。"
                }
              />
            </div>
          </section>
          <section className="min-w-0 rounded-xl border border-border bg-background/80 p-4">
            <div className="mb-3 grid min-w-0 gap-1">
              <div className="text-sm font-semibold">关联能力设置</div>
              <p className="text-xs leading-5 text-muted-foreground">
                自用优先决定当前公众号是否计入你的自有能力；商业化授权只决定剩余能力是否可对外调度。
              </p>
            </div>
            <div className="grid gap-3">
              <WechatSelfCapabilityPreferenceControl variant="quota" />
              <WechatCommercialAuthorizationSetting variant="quota" />
              <WechatCapabilityStatusFeedback />
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

function QuotaMetric({
  label,
  value,
  detail,
}: {
  label: string
  value: string | number
  detail: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="min-w-0 rounded-lg border border-border bg-muted/45 px-3 py-2 text-left outline-hidden transition-colors hover:bg-muted/65 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="text-[10px] text-muted-foreground">{label}</div>
          <div className="mt-1 font-mono text-base leading-tight tabular-nums">
            {typeof value === "number" ? value.toLocaleString() : value}
          </div>
        </button>
      </TooltipTrigger>
      <TooltipContent className="z-[100] max-w-[260px] text-left" side="top">
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
  if (status === "offline") return "未接入"
  return "-"
}

function formatEventTime(value?: string | null) {
  if (!value) return "暂无"
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return "暂无"

  return date.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
