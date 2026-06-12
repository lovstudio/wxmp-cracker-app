import { supabase } from "@/integrations/supabase/client"
import type { Database, Json } from "@/integrations/supabase/types"

export type GatewayRequestKind = "self" | "commercial"
export type EnqueuedGatewayRequest =
  Database["public"]["Functions"]["enqueue_wxmp_gateway_request"]["Returns"][number]
export type ClaimedGatewayRequest =
  Database["public"]["Functions"]["claim_wxmp_gateway_request"]["Returns"][number]
export type CompletedGatewayRequest =
  Database["public"]["Functions"]["complete_wxmp_gateway_request"]["Returns"][number]
export type GatewayNodeHeartbeat =
  Database["public"]["Functions"]["heartbeat_wxmp_provider_node"]["Returns"][number]
export type ReportedProviderExecution =
  Database["public"]["Functions"]["report_wxmp_provider_execution"]["Returns"][number]
export type StartedProviderExecution =
  Database["public"]["Functions"]["start_wxmp_provider_execution"]["Returns"][number]

export const RESOURCE_CONDITIONS_REFRESH_EVENT =
  "wxmp-resource-conditions:refresh"

export async function enqueueGatewayRequest(input: {
  requestKind: GatewayRequestKind
  endpoint: string
  targetFakeid?: string | null
  payload?: Json
  quotaCost?: number
  priority?: number
  idempotencyKey?: string | null
}): Promise<EnqueuedGatewayRequest | null> {
  const { data, error } = await supabase.rpc("enqueue_wxmp_gateway_request", {
    _request_kind: input.requestKind,
    _endpoint: input.endpoint,
    _target_fakeid: input.targetFakeid ?? null,
    _payload: input.payload ?? {},
    _quota_cost: input.quotaCost ?? 1,
    _priority: input.priority ?? 100,
    _idempotency_key: input.idempotencyKey ?? null,
  })

  if (error) throw error
  return data?.[0] ?? null
}

export async function heartbeatMyGatewayNode(): Promise<GatewayNodeHeartbeat | null> {
  const { data, error } = await supabase.rpc("heartbeat_wxmp_provider_node")

  if (error) throw error
  return data?.[0] ?? null
}

export async function claimGatewayRequest(input?: {
  providerNodeId?: string | null
  leaseSeconds?: number
}): Promise<ClaimedGatewayRequest | null> {
  const { data, error } = await supabase.rpc("claim_wxmp_gateway_request", {
    _provider_node_id: input?.providerNodeId ?? null,
    _lease_seconds: input?.leaseSeconds ?? 300,
  })

  if (error) throw error
  return data?.[0] ?? null
}

export async function completeGatewayRequest(input: {
  requestId: string
  leaseId: string
  status: "succeeded" | "failed" | "cancelled" | "expired"
  resultPayload?: Json
  errorCode?: string | null
  errorMessage?: string | null
  latencyMs?: number | null
}): Promise<CompletedGatewayRequest | null> {
  const { data, error } = await supabase.rpc("complete_wxmp_gateway_request", {
    _request_id: input.requestId,
    _lease_id: input.leaseId,
    _status: input.status,
    _result_payload: input.resultPayload ?? {},
    _error_code: input.errorCode ?? null,
    _error_message: input.errorMessage ?? null,
    _latency_ms: input.latencyMs ?? null,
  })

  if (error) throw error
  return data?.[0] ?? null
}

export async function reportProviderExecution(input: {
  endpoint: string
  status: "succeeded" | "failed"
  quotaCost?: number
  errorCode?: string | null
  errorMessage?: string | null
  latencyMs?: number | null
  observedValue?: Json
}): Promise<ReportedProviderExecution | null> {
  const { data, error } = await supabase.rpc("report_wxmp_provider_execution", {
    _endpoint: input.endpoint,
    _status: input.status,
    _quota_cost: input.quotaCost ?? 1,
    _error_code: input.errorCode ?? null,
    _error_message: input.errorMessage ?? null,
    _latency_ms: input.latencyMs ?? null,
    _observed_value: input.observedValue ?? {},
  })

  if (error) throw error
  return data?.[0] ?? null
}

export async function startProviderExecution(input: {
  endpoint: string
  targetFakeid?: string | null
  payload?: Json
  quotaCost?: number
  priority?: number
}): Promise<StartedProviderExecution | null> {
  const { data, error } = await supabase.rpc("start_wxmp_provider_execution", {
    _endpoint: input.endpoint,
    _target_fakeid: input.targetFakeid ?? null,
    _payload: input.payload ?? {},
    _quota_cost: input.quotaCost ?? 1,
    _priority: input.priority ?? 100,
  })

  if (error) throw error
  return data?.[0] ?? null
}

export async function runWithProviderExecutionReport<T>(
  metadata: {
    endpoint: string
    targetFakeid?: string | null
    quotaCost?: number
    observedValue?: Json
  },
  action: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()
  let execution: StartedProviderExecution | null = null

  try {
    execution = await startProviderExecution({
      endpoint: metadata.endpoint,
      targetFakeid: metadata.targetFakeid,
      payload: metadata.observedValue,
      quotaCost: metadata.quotaCost,
    })
  } catch (error) {
    console.warn("Unable to start wxmp provider execution request", error)
  }

  notifyResourceConditionsChanged()

  try {
    const result = await action()
    if (execution) {
      await safeCompleteGatewayRequest({
        requestId: execution.request_id,
        leaseId: execution.lease_id,
        status: "succeeded",
        resultPayload: {
          endpoint: metadata.endpoint,
          observed: metadata.observedValue ?? {},
          inline: true,
        },
        latencyMs: elapsedMs(startedAt),
      })
    } else {
      await safeReportProviderExecution({
        endpoint: metadata.endpoint,
        status: "succeeded",
        quotaCost: metadata.quotaCost,
        observedValue: metadata.observedValue,
        latencyMs: elapsedMs(startedAt),
      })
    }
    return result
  } catch (error) {
    const message = errorMessage(error)
    if (execution) {
      await safeCompleteGatewayRequest({
        requestId: execution.request_id,
        leaseId: execution.lease_id,
        status: "failed",
        resultPayload: {
          endpoint: metadata.endpoint,
          error: message,
          observed: metadata.observedValue ?? {},
          inline: true,
        },
        errorCode: classifyProviderError(message),
        errorMessage: message,
        latencyMs: elapsedMs(startedAt),
      })
    } else {
      await safeReportProviderExecution({
        endpoint: metadata.endpoint,
        status: "failed",
        quotaCost: metadata.quotaCost,
        observedValue: metadata.observedValue,
        errorCode: classifyProviderError(message),
        errorMessage: message,
        latencyMs: elapsedMs(startedAt),
      })
    }
    throw error
  } finally {
    notifyResourceConditionsChanged()
  }
}

export function notifyResourceConditionsChanged() {
  window.dispatchEvent(new Event(RESOURCE_CONDITIONS_REFRESH_EVENT))
}

export function enqueueGatewayFetchSelectedAccount(input: {
  requestKind: GatewayRequestKind
  account: {
    fakeid: string
    nickname: string
    alias?: string | null
    signature?: string | null
    avatar?: string | null
  }
  limit: number
  withContent: boolean
  mode?: "forward" | "backward" | "audit"
  auditDate?: string | null
  priority?: number
  idempotencyKey?: string | null
}) {
  return enqueueGatewayRequest({
    requestKind: input.requestKind,
    endpoint: "fetch_selected_account",
    targetFakeid: input.account.fakeid,
    payload: {
      account: input.account,
      limit: input.limit,
      with_content: input.withContent,
      mode: input.mode ?? "forward",
      audit_date: input.auditDate ?? null,
    },
    priority: input.priority,
    idempotencyKey: input.idempotencyKey,
  })
}

async function safeReportProviderExecution(input: {
  endpoint: string
  status: "succeeded" | "failed"
  quotaCost?: number
  errorCode?: string | null
  errorMessage?: string | null
  latencyMs?: number | null
  observedValue?: Json
}) {
  try {
    await reportProviderExecution(input)
  } catch (error) {
    console.warn("Unable to report wxmp provider execution", error)
  }
}

async function safeCompleteGatewayRequest(input: {
  requestId: string
  leaseId: string
  status: "succeeded" | "failed"
  resultPayload?: Json
  errorCode?: string | null
  errorMessage?: string | null
  latencyMs?: number | null
}) {
  try {
    await completeGatewayRequest(input)
  } catch (error) {
    console.warn("Unable to complete wxmp gateway request", error)
  }
}

function classifyProviderError(message: string) {
  if (message.includes("触发风控") || message.includes("RateLimit")) {
    return "rate_limited"
  }
  if (
    message.includes("认证失败") ||
    message.includes("尚未登录") ||
    message.includes("请先扫码登录")
  ) {
    return "auth_error"
  }
  if (message.includes("未找到 wcx")) {
    return "worker_unavailable"
  }
  return "worker_error"
}

function elapsedMs(startedAt: number) {
  return Math.max(0, Math.round(performance.now() - startedAt))
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
