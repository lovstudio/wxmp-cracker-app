import { invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import type { ArticlePublicMetricsSnapshot } from "@/lib/api"

export type AcquisitionCapability =
  | "article.resolve"
  | "article.content.fetch"
  | "article.metrics.fetch"
  | "account.resolve"
  | "account.articles.list"

export type AcquisitionJobStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "completed"
  | "partial"
  | "failed"
  | "cancelled"

export interface AcquisitionJob {
  job_id: string
  capability: AcquisitionCapability
  resource_key: string
  requested_provider_id: string | null
  selected_provider_id: string | null
  status: AcquisitionJobStatus
  created_at: number
  started_at: number | null
  completed_at: number | null
  result: unknown | null
  error_code: string | null
  error_message: string | null
  diagnostic_id: string
}

export interface AcquisitionProviderManifest {
  id: string
  name: string
  provider_version: string
  api_version: number
  execution_mode: "builtin" | "sidecar" | "remote"
  capabilities: Array<{
    id: AcquisitionCapability
    fields: string[]
    pagination: string | null
  }>
  requirements: string[]
  side_effects: Array<
    "foreground_window" | "clipboard" | "remote_data_transfer" | "paid_request"
  >
  data_boundary: "local_only" | "remote_processing"
  max_concurrency: number
  supports_cancellation: boolean
}

export interface AcquisitionProviderAttempt {
  attempt_id: string
  job_id: string
  provider_id: string
  provider_version: string
  status: "running" | "completed" | "partial" | "failed"
  started_at: number
  completed_at: number | null
  duration_ms: number | null
  returned_fields: string[]
  error_code: string | null
  error_message: string | null
}

interface ArticleMetricsAcquisitionResult {
  kind: "article_metrics"
  data: ArticlePublicMetricsSnapshot
}

const JOB_UPDATED_EVENT = "acquisition-job-updated"
const ARTICLE_METRICS_JOB_TIMEOUT_MS = 120_000

export const onAcquisitionJobUpdated = (
  callback: (job: AcquisitionJob) => void
) =>
  listen<AcquisitionJob>(JOB_UPDATED_EVENT, (event) => callback(event.payload))

export const getAcquisitionJob = (jobId: string) =>
  invoke<AcquisitionJob | null>("get_acquisition_job", { jobId })

export const listAcquisitionAttempts = (jobId: string) =>
  invoke<AcquisitionProviderAttempt[]>("list_acquisition_attempts", { jobId })

export const listAcquisitionProviders = () =>
  invoke<AcquisitionProviderManifest[]>("list_acquisition_providers")

export async function captureArticleMetricsWithJob(
  aid: string
): Promise<ArticlePublicMetricsSnapshot> {
  const created = await invoke<AcquisitionJob>(
    "create_article_metrics_acquisition_job",
    { aid }
  )

  let unlisten: UnlistenFn | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    let resolveCompletion!: (value: ArticlePublicMetricsSnapshot) => void
    let rejectCompletion!: (error: Error) => void
    const completion = new Promise<ArticlePublicMetricsSnapshot>(
      (resolve, reject) => {
        resolveCompletion = resolve
        rejectCompletion = reject
      }
    )
    let settled = false
    const settle = (
      outcome:
        | { kind: "success"; value: ArticlePublicMetricsSnapshot }
        | { kind: "failure"; error: Error }
    ) => {
      if (settled) return
      settled = true
      if (outcome.kind === "success") resolveCompletion(outcome.value)
      else rejectCompletion(outcome.error)
    }
    const accept = (job: AcquisitionJob) => {
      if (job.job_id !== created.job_id) return
      try {
        const snapshot = articleMetricsFromAcquisitionJob(job)
        if (snapshot) settle({ kind: "success", value: snapshot })
      } catch (error) {
        settle({ kind: "failure", error: toError(error) })
      }
    }

    unlisten = await onAcquisitionJobUpdated(accept)
    timeout = setTimeout(
      () =>
        settle({
          kind: "failure",
          error: new Error(
            `互动数据任务等待超时（诊断 ID：${created.diagnostic_id}）`
          ),
        }),
      ARTICLE_METRICS_JOB_TIMEOUT_MS
    )

    accept(created)
    try {
      const current = await getAcquisitionJob(created.job_id)
      if (!current) {
        settle({
          kind: "failure",
          error: new Error(
            `找不到互动数据任务（诊断 ID：${created.diagnostic_id}）`
          ),
        })
      } else {
        accept(current)
      }
    } catch (error) {
      // The event subscription is already active. A one-off refresh failure
      // must not cancel a backend job that can still publish its terminal state.
      console.warn("[acquisition] initial job refresh failed", {
        jobId: created.job_id,
        error: toError(error).message,
      })
    }
    return await completion
  } finally {
    if (timeout) clearTimeout(timeout)
    unlisten?.()
  }
}

export function articleMetricsFromAcquisitionJob(
  job: AcquisitionJob
): ArticlePublicMetricsSnapshot | null {
  if (job.status === "failed" || job.status === "cancelled") {
    const message =
      job.error_message ??
      (job.status === "cancelled" ? "互动数据任务已取消" : "互动数据任务失败")
    throw new Error(`${message}（诊断 ID：${job.diagnostic_id}）`)
  }
  if (job.status !== "completed" && job.status !== "partial") return null
  if (!isArticleMetricsResult(job.result)) {
    throw new Error(`互动数据任务结果无效（诊断 ID：${job.diagnostic_id}）`)
  }
  return job.result.data
}

function isArticleMetricsResult(
  value: unknown
): value is ArticleMetricsAcquisitionResult {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  if (candidate.kind !== "article_metrics") return false
  if (!candidate.data || typeof candidate.data !== "object") return false
  const data = candidate.data as Record<string, unknown>
  return typeof data.aid === "string" && typeof data.status === "string"
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
