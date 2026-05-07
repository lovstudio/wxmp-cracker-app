import { supabase } from "@/integrations/supabase/client"
import type {
  Database,
  Tables,
  TablesInsert,
} from "@/integrations/supabase/types"

export type QuotaSettings = Tables<"wxmp_quota_settings">
export type UserCapability = Tables<"wxmp_user_capabilities">
export type QuotaEntitlement =
  Database["public"]["Functions"]["get_wxmp_quota_entitlement"]["Returns"][number]
export type GatewayOverview =
  Database["public"]["Functions"]["get_wxmp_gateway_overview"]["Returns"][number]

export async function fetchQuotaSettings(): Promise<QuotaSettings> {
  const { data, error } = await supabase
    .from("wxmp_quota_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle()

  if (error) throw quotaSchemaError(error)
  if (!data) {
    throw new Error("尚未初始化频率参数。")
  }

  return data
}

export async function updateQuotaSettings(input: {
  accountLevelFactor: number
  ownCapabilityFactor: number
  defaultAccountLevel: number
}): Promise<QuotaSettings> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw quotaSchemaError(userError)
  if (!userData.user) {
    throw new Error("请先登录管理员账号。")
  }

  const payload: TablesInsert<"wxmp_quota_settings"> = {
    id: "default",
    account_level_factor: normalizeNonNegativeInt(
      input.accountLevelFactor,
      "每级基础保障"
    ),
    own_capability_factor: normalizeNonNegativeInt(
      input.ownCapabilityFactor,
      "每个自有公众号能力加成"
    ),
    default_account_level: normalizeNonNegativeInt(
      input.defaultAccountLevel,
      "默认账号级别"
    ),
    updated_by: userData.user.id,
  }

  const { data, error } = await supabase
    .from("wxmp_quota_settings")
    .upsert(payload, { onConflict: "id" })
    .select("*")
    .single()

  if (error) throw quotaSchemaError(error)
  return data
}

export async function fetchMyCapability(): Promise<UserCapability | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw quotaSchemaError(userError)
  if (!userData.user) return null

  const { data, error } = await supabase
    .from("wxmp_user_capabilities")
    .select("*")
    .eq("user_id", userData.user.id)
    .maybeSingle()

  if (error) throw quotaSchemaError(error)
  return data
}

export async function saveMyCapability(input: {
  mpUsername?: string | null
  mpNickname?: string | null
  mpAlias?: string | null
  serviceType?: string | null
  capabilityEnabled: boolean
  providesToOthers: boolean
}): Promise<UserCapability> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw quotaSchemaError(userError)
  if (!userData.user) {
    throw new Error("请先登录 Lovstudio 账号。")
  }

  const providesToOthers = input.providesToOthers
  const activeCapability = input.capabilityEnabled || providesToOthers

  if (activeCapability && !hasCapabilityIdentity(input)) {
    throw new Error("请先扫码登录微信公众号，再保存公众号能力。")
  }

  const payload: TablesInsert<"wxmp_user_capabilities"> = {
    user_id: userData.user.id,
    mp_username: nullableText(input.mpUsername),
    mp_nickname: nullableText(input.mpNickname),
    mp_alias: nullableText(input.mpAlias),
    service_type: nullableText(input.serviceType),
    capability_units: input.capabilityEnabled ? 1 : 0,
    provides_to_others: providesToOthers,
    commercial_terms_accepted_at: providesToOthers
      ? new Date().toISOString()
      : null,
    status: activeCapability ? "active" : "paused",
  }

  const { data, error } = await supabase
    .from("wxmp_user_capabilities")
    .upsert(payload, { onConflict: "user_id" })
    .select("*")
    .single()

  if (error) throw quotaSchemaError(error)
  return data
}

export async function fetchMyQuotaEntitlement(
  accountId?: string | null
): Promise<QuotaEntitlement | null> {
  let targetAccountId = accountId?.trim() ?? ""

  if (!targetAccountId) {
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError) throw quotaSchemaError(userError)
    targetAccountId = userData.user?.id ?? ""
  }

  if (!targetAccountId) return null

  const { data, error } = await supabase.rpc("get_wxmp_quota_entitlement", {
    _account_id: targetAccountId,
  })

  if (error) throw quotaSchemaError(error)
  return data?.[0] ?? null
}

export async function fetchMyGatewayOverview(
  accountId?: string | null
): Promise<GatewayOverview | null> {
  let targetAccountId = accountId?.trim() ?? ""

  if (!targetAccountId) {
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError) throw quotaSchemaError(userError)
    targetAccountId = userData.user?.id ?? ""
  }

  if (!targetAccountId) return null

  const { data, error } = await supabase.rpc("get_wxmp_gateway_overview", {
    _account_id: targetAccountId,
  })

  if (error) throw quotaSchemaError(error)
  return data?.[0] ?? null
}

function quotaSchemaError(error: unknown) {
  if (isQuotaSchemaCacheMiss(error)) {
    return new Error(
      "频率额度表尚未部署到当前 Supabase 项目。请先在 Supabase SQL Editor 执行 supabase/wxmp_licenses.sql，然后刷新 PostgREST schema cache 后重试。"
    )
  }

  return error
}

function isQuotaSchemaCacheMiss(error: unknown) {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as {
    code?: unknown
    message?: unknown
  }
  const code = typeof candidate.code === "string" ? candidate.code : ""
  const message = typeof candidate.message === "string" ? candidate.message : ""

  return (
    code === "PGRST202" ||
    code === "PGRST205" ||
    message.includes("schema cache") ||
    message.includes("wxmp_user_capabilities") ||
    message.includes("wxmp_quota_settings") ||
    message.includes("wxmp_provider_nodes") ||
    message.includes("wxmp_gateway_requests") ||
    message.includes("wxmp_provider_leases") ||
    message.includes("wxmp_provider_health_events") ||
    message.includes("wxmp_gateway_alerts") ||
    message.includes("get_wxmp_quota_entitlement") ||
    message.includes("get_wxmp_gateway_overview") ||
    message.includes("enqueue_wxmp_gateway_request") ||
    message.includes("heartbeat_wxmp_provider_node") ||
    message.includes("claim_wxmp_gateway_request") ||
    message.includes("complete_wxmp_gateway_request") ||
    message.includes("start_wxmp_provider_execution") ||
    message.includes("report_wxmp_provider_execution")
  )
}

function normalizeNonNegativeInt(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label}必须是大于等于 0 的整数。`)
  }
  return Math.floor(value)
}

function nullableText(value?: string | null) {
  const trimmed = value?.trim() ?? ""
  return trimmed ? trimmed : null
}

function hasCapabilityIdentity(input: {
  mpUsername?: string | null
  mpNickname?: string | null
}) {
  return Boolean(input.mpUsername?.trim() || input.mpNickname?.trim())
}
