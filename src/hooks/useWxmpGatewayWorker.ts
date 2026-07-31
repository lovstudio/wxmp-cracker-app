import { useEffect, useRef } from "react"

import { useAuth } from "@/hooks/useAuth"
import {
  api,
  type AccountSearchResult,
  type FetchAccountResult,
  type FetchMode,
} from "@/lib/api"
import {
  claimGatewayRequest,
  completeGatewayRequest,
  heartbeatMyGatewayNode,
  type ClaimedGatewayRequest,
} from "@/lib/gateway"
import { isTauri } from "@/lib/tauri"
import type { Json } from "@/integrations/supabase/types"

const WORKER_POLL_MS = 12_000
const WORKER_LEASE_SECONDS = 300

export function useWxmpGatewayWorker({
  enabled,
  onRequestFinished,
}: {
  enabled: boolean
  onRequestFinished?: () => void | Promise<void>
}) {
  const { user } = useAuth()
  const runningRef = useRef(false)
  const onRequestFinishedRef = useRef(onRequestFinished)

  useEffect(() => {
    onRequestFinishedRef.current = onRequestFinished
  }, [onRequestFinished])

  useEffect(() => {
    if (!enabled || !user || !isTauri()) {
      return
    }

    let cancelled = false

    const tick = async () => {
      if (cancelled || runningRef.current) return

      runningRef.current = true
      try {
        await heartbeatMyGatewayNode()
        const request = await claimGatewayRequest({
          leaseSeconds: WORKER_LEASE_SECONDS,
        })

        if (!request || cancelled) return

        await executeAndCompleteGatewayRequest(request)
        await onRequestFinishedRef.current?.()
      } catch (error) {
        console.warn("wxmp gateway worker tick failed", error)
      } finally {
        runningRef.current = false
      }
    }

    void tick()
    const interval = window.setInterval(() => void tick(), WORKER_POLL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [enabled, user])
}

async function executeAndCompleteGatewayRequest(
  request: ClaimedGatewayRequest
) {
  const startedAt = performance.now()

  try {
    const resultPayload = await executeGatewayRequest(request)
    await completeGatewayRequest({
      requestId: request.request_id,
      leaseId: request.lease_id,
      status: "succeeded",
      resultPayload,
      latencyMs: elapsedMs(startedAt),
    })
  } catch (error) {
    const message = errorMessage(error)
    await completeGatewayRequest({
      requestId: request.request_id,
      leaseId: request.lease_id,
      status: "failed",
      resultPayload: {
        error: message,
      },
      errorCode: classifyGatewayError(message),
      errorMessage: message,
      latencyMs: elapsedMs(startedAt),
    })
  }
}

async function executeGatewayRequest(
  request: ClaimedGatewayRequest
): Promise<Json> {
  if (request.endpoint === "fetch_selected_account") {
    return executeFetchSelectedAccount(request.payload)
  }

  if (request.endpoint === "fetch_account") {
    return executeFetchAccount(request.payload)
  }

  if (request.endpoint === "search_accounts") {
    return executeSearchAccounts(request.payload)
  }

  throw new Error(`不支持的网关端点：${request.endpoint ?? "unknown"}`)
}

async function executeFetchSelectedAccount(payload: Json): Promise<Json> {
  const input = parseFetchSelectedAccountPayload(payload)
  const result = await api.fetchSelectedAccount(
    input.account,
    input.limit,
    input.withContent,
    input.mode,
    input.auditDate
  )
  const articles = await api.listArticles(input.account.fakeid)
  const selectedArticles = articles.slice(0, input.limit)
  const articlePayload = input.withContent
    ? await Promise.all(
        selectedArticles.map(async (article) => {
          const detail = await api.getArticle(article.aid)
          return detail ?? article
        })
      )
    : selectedArticles

  return toJson({
    endpoint: "fetch_selected_account",
    account: input.account,
    limit: input.limit,
    with_content: input.withContent,
    mode: input.mode,
    audit_date: input.auditDate,
    stdout: result.stdout,
    stderr: result.stderr,
    articles: articlePayload,
  })
}

async function executeFetchAccount(payload: Json): Promise<Json> {
  const input = parseFetchAccountPayload(payload)
  const result: FetchAccountResult = await api.fetchAccount(
    input.query,
    input.limit,
    input.withContent
  )

  return toJson({
    endpoint: "fetch_account",
    query: input.query,
    limit: input.limit,
    with_content: input.withContent,
    stdout: result.stdout,
    stderr: result.stderr,
  })
}

async function executeSearchAccounts(payload: Json): Promise<Json> {
  const input = parseSearchAccountsPayload(payload)
  const results = await api.searchAccounts(input.query)

  return toJson({
    endpoint: "search_accounts",
    query: input.query,
    results,
  })
}

function parseFetchSelectedAccountPayload(payload: Json) {
  const object = jsonObject(payload)
  const account = jsonObject(object.account)
  const fakeid = stringValue(account.fakeid)
  const nickname = stringValue(account.nickname)

  if (!fakeid || !nickname) {
    throw new Error("网关请求缺少公众号 fakeid 或昵称。")
  }

  return {
    account: {
      fakeid,
      nickname,
      alias: nullableString(account.alias),
      signature: nullableString(account.signature),
      avatar: nullableString(account.avatar),
    } satisfies AccountSearchResult,
    limit: positiveInt(object.limit, 20, 500),
    withContent: booleanValue(object.with_content),
    mode: fetchModeValue(object.mode),
    auditDate: nullableString(object.audit_date),
  }
}

function parseFetchAccountPayload(payload: Json) {
  const object = jsonObject(payload)
  const query = stringValue(object.query)

  if (!query) {
    throw new Error("网关请求缺少公众号查询条件。")
  }

  return {
    query,
    limit: positiveInt(object.limit, 20, 500),
    withContent: booleanValue(object.with_content),
  }
}

function parseSearchAccountsPayload(payload: Json) {
  const object = jsonObject(payload)
  const query = stringValue(object.query)

  if (!query) {
    throw new Error("网关请求缺少公众号查询条件。")
  }

  return { query }
}

function jsonObject(value: Json | undefined): Record<string, Json | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }
  return value
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

function stringValue(value: Json | undefined) {
  return typeof value === "string" ? value.trim() : ""
}

function nullableString(value: Json | undefined) {
  const text = stringValue(value)
  return text ? text : null
}

function booleanValue(value: Json | undefined) {
  return value === true
}

function fetchModeValue(value: Json | undefined): FetchMode {
  const text = stringValue(value)
  if (text === "backward" || text === "audit") return text
  return "forward"
}

function positiveInt(value: Json | undefined, fallback: number, max: number) {
  const numberValue = typeof value === "number" ? value : fallback
  if (!Number.isFinite(numberValue) || numberValue < 1) {
    return fallback
  }
  return Math.floor(Math.min(numberValue, max))
}

function classifyGatewayError(message: string) {
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
