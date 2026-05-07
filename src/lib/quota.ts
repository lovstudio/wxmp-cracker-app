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

export async function fetchQuotaSettings(): Promise<QuotaSettings> {
  const { data, error } = await supabase
    .from("wxmp_quota_settings")
    .select("*")
    .eq("id", "default")
    .maybeSingle()

  if (error) throw error
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
  if (userError) throw userError
  if (!userData.user) {
    throw new Error("请先登录管理员账号。")
  }

  const payload: TablesInsert<"wxmp_quota_settings"> = {
    id: "default",
    account_level_factor: normalizeNonNegativeInt(
      input.accountLevelFactor,
      "账号级别系数 J"
    ),
    own_capability_factor: normalizeNonNegativeInt(
      input.ownCapabilityFactor,
      "公众号能力系数 K"
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

  if (error) throw error
  return data
}

export async function fetchMyCapability(): Promise<UserCapability | null> {
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw userError
  if (!userData.user) return null

  const { data, error } = await supabase
    .from("wxmp_user_capabilities")
    .select("*")
    .eq("user_id", userData.user.id)
    .maybeSingle()

  if (error) throw error
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
  if (userError) throw userError
  if (!userData.user) {
    throw new Error("请先登录 Lovstudio 账号。")
  }

  if (input.capabilityEnabled && !hasCapabilityIdentity(input)) {
    throw new Error("请先扫码登录微信公众号，再保存公众号能力。")
  }

  const providesToOthers = input.capabilityEnabled && input.providesToOthers
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
    status: input.capabilityEnabled ? "active" : "paused",
  }

  const { data, error } = await supabase
    .from("wxmp_user_capabilities")
    .upsert(payload, { onConflict: "user_id" })
    .select("*")
    .single()

  if (error) throw error
  return data
}

export async function fetchMyQuotaEntitlement(
  accountId?: string | null
): Promise<QuotaEntitlement | null> {
  let targetAccountId = accountId?.trim() ?? ""

  if (!targetAccountId) {
    const { data: userData, error: userError } = await supabase.auth.getUser()
    if (userError) throw userError
    targetAccountId = userData.user?.id ?? ""
  }

  if (!targetAccountId) return null

  const { data, error } = await supabase.rpc("get_wxmp_quota_entitlement", {
    _account_id: targetAccountId,
  })

  if (error) throw error
  return data?.[0] ?? null
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
