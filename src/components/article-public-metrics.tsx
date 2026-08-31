import { useEffect, useMemo, useRef, useState } from "react"
import {
  BarChart3Icon,
  InfoIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  api,
  onArticlePublicMetricsUpdated,
  type ArticlePublicMetricsSnapshot,
} from "@/lib/api"
import { copyableToast as toast } from "@/lib/toast"

export function ArticlePublicMetrics({ aid }: { aid: string }) {
  const [snapshot, setSnapshot] = useState<ArticlePublicMetricsSnapshot | null>(
    null
  )
  const [loading, setLoading] = useState(true)
  const [capturing, setCapturing] = useState(false)
  const activeAidRef = useRef(aid)

  useEffect(() => {
    activeAidRef.current = aid
    let cancelled = false
    setLoading(true)
    setSnapshot(null)

    api
      .getArticlePublicMetrics(aid)
      .then((result) => {
        if (!cancelled) setSnapshot(result)
      })
      .catch(() => {
        if (!cancelled) setSnapshot(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [aid])

  useEffect(
    () =>
      onArticlePublicMetricsUpdated((updated) => {
        if (updated.aid !== activeAidRef.current) return
        setSnapshot(updated)
        setLoading(false)
      }),
    []
  )

  const metrics = useMemo(() => metricItems(snapshot), [snapshot])

  const capture = async () => {
    if (capturing) return
    const startedAt = performance.now()
    console.log("[DEBUG][article-public-metrics] detail update entry:", { aid })
    setCapturing(true)
    try {
      const result = await api.captureArticlePublicMetrics(aid)
      console.log("[DEBUG][article-public-metrics] detail update success:", {
        aid,
        sourceKind: result.source_kind,
        captureMethod: result.capture_method,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      if (activeAidRef.current !== aid) return
      setSnapshot(result)
      if (result.status === "visible") {
        toast.success(
          result.source_kind === "wechat_mp_backend"
            ? "已保存公众号后台互动数据快照"
            : result.source_kind === "wechat_account_feed"
              ? "已从公众号文章列表批量更新互动数据"
              : result.source_kind === "wechat_local_session"
                ? "已通过本机微信接口保存互动数据快照"
                : "已保存本机微信互动数据快照"
        )
      } else if (result.status === "blocked") {
        toast.warning("微信要求访问验证，本次快照未取得互动数值")
      } else {
        toast.info("公开文章页当前没有返回互动数值")
      }
    } catch (error) {
      console.log("[DEBUG][article-public-metrics] detail update failed:", {
        aid,
        elapsedMs: Math.round(performance.now() - startedAt),
        error: errorMessage(error),
      })
      if (activeAidRef.current === aid) {
        toast.error(`更新互动数据失败：${errorMessage(error)}`)
      }
    } finally {
      console.log("[DEBUG][article-public-metrics] detail update settled:", {
        aid,
        elapsedMs: Math.round(performance.now() - startedAt),
      })
      if (activeAidRef.current === aid) setCapturing(false)
    }
  }

  return (
    <section
      className="mt-4 rounded-xl border border-border bg-card/70 p-3"
      aria-label="文章互动数据快照"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <BarChart3Icon className="size-4 text-primary" />
            互动数据快照
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>来源：{sourceLabel(snapshot)}</span>
            <span aria-hidden="true">·</span>
            <span>{sourceScopeLabel(snapshot)}</span>
            {snapshot && (
              <>
                <span aria-hidden="true">·</span>
                <time
                  dateTime={new Date(snapshot.captured_at * 1000).toISOString()}
                >
                  {formatCapturedAt(snapshot.captured_at)}
                </time>
              </>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading || capturing}
          onClick={() => void capture()}
        >
          {loading || capturing ? (
            <LoaderCircleIcon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
          {snapshot ? "更新数据" : "读取数据"}
        </Button>
      </div>

      {loading ? (
        <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircleIcon className="size-3.5 animate-spin" />
          正在读取本地快照
        </div>
      ) : metrics.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="min-w-20 rounded-lg border border-border/80 bg-background/80 px-3 py-2"
            >
              <div className="text-[11px] text-muted-foreground">
                {metric.label}
              </div>
              <div className="mt-0.5 font-mono text-sm font-medium text-foreground tabular-nums">
                {formatMetric(metric.value)}
              </div>
            </div>
          ))}
        </div>
      ) : snapshot ? (
        <div
          className={
            snapshot.status === "blocked"
              ? "mt-3 flex items-start gap-2 text-xs text-destructive"
              : "mt-3 flex items-start gap-2 text-xs text-muted-foreground"
          }
        >
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {snapshot.note ??
              "公开文章页没有返回互动数值；这不能解读为阅读量或互动量为 0。"}
          </span>
        </div>
      ) : (
        <div className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            自己的文章可直接读取公众号后台数据；其他账号会先精确读取本机已授权快照，未命中时自动进入对应公众号主页，从文章列表批量获取，无需逐篇打开。缺失字段不会记成
            0。
          </span>
        </div>
      )}
    </section>
  )
}

function sourceLabel(snapshot: ArticlePublicMetricsSnapshot | null) {
  if (!snapshot) return "待读取"
  if (snapshot?.source_kind === "wechat_mp_backend") return "公众号后台内容分析"
  if (snapshot?.source_kind === "wechat_account_feed")
    return "本机微信公众号文章列表"
  if (snapshot?.source_kind === "wechat_local_session")
    return "本机微信文章接口"
  if (snapshot?.source_kind === "wechat_public_page") return "微信公众号文章页"
  return "本机微信文章缓存"
}

function sourceScopeLabel(snapshot: ArticlePublicMetricsSnapshot | null) {
  if (!snapshot) return "将按文章归属选择来源"
  if (snapshot?.source_kind === "wechat_mp_backend")
    return "人数口径，通常按日更新"
  if (snapshot?.source_kind === "wechat_account_feed")
    return "公众号列表批量计数"
  return "文章页公开计数"
}

function metricItems(snapshot: ArticlePublicMetricsSnapshot | null) {
  if (!snapshot) return []
  const backend = snapshot.source_kind === "wechat_mp_backend"
  return [
    { label: backend ? "阅读人数" : "阅读", value: snapshot.read_count },
    { label: "点赞", value: snapshot.like_count },
    { label: "推荐", value: snapshot.recommend_count },
    { label: backend ? "分享人数" : "分享", value: snapshot.share_count },
    { label: "留言", value: snapshot.comment_count },
    { label: backend ? "收藏人数" : "收藏", value: snapshot.collect_count },
  ].filter(
    (metric): metric is { label: string; value: number } =>
      metric.value !== null
  )
}

function formatMetric(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value)
}

function formatCapturedAt(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp * 1000))
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }
  return String(error)
}
