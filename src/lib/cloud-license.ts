import { supabase } from "@/integrations/supabase/client"
import type { Tables, TablesInsert } from "@/integrations/supabase/types"
import type { LicenseKind } from "@/lib/api"

export type CloudLicense = Tables<"wxmp_licenses">
export type CloudLicenseWithAccount = CloudLicense & {
  account_email: string | null
}

export const CLOUD_LICENSE_DAYS: Record<LicenseKind, number> = {
  trial: 7,
  official: 365,
}

export async function upsertCloudLicense(input: {
  accountId: string
  kind: LicenseKind
  quotaLevel?: number
  customer?: string | null
}): Promise<CloudLicense> {
  const accountId = input.accountId.trim()
  if (!accountId) {
    throw new Error("请输入目标用户的账号 ID。")
  }
  const quotaLevel = normalizeQuotaLevel(input.quotaLevel)

  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError) throw userError
  if (!userData.user) {
    throw new Error("请先登录管理员账号。")
  }

  const now = new Date().toISOString()
  const payload: TablesInsert<"wxmp_licenses"> = {
    account_id: accountId,
    kind: input.kind,
    quota_level: quotaLevel,
    expires_at: licenseExpiresAt(input.kind),
    customer: nullableText(input.customer),
    status: "active",
    created_by: userData.user.id,
    updated_at: now,
  }

  const { data, error } = await supabase
    .from("wxmp_licenses")
    .upsert(payload, { onConflict: "account_id" })
    .select("*")
    .single()

  if (error) throw error
  return data
}

export async function listCloudLicenses(
  limit?: number
): Promise<CloudLicenseWithAccount[]> {
  const query = supabase
    .from("wxmp_licenses")
    .select("*")
    .order("updated_at", { ascending: false })
  const { data, error } =
    typeof limit === "number" ? await query.limit(limit) : await query

  if (error) throw error
  const licenses = data ?? []
  const emailByAccountId = await fetchProfileEmails(
    licenses.map((license) => license.account_id)
  )

  return licenses.map((license) => ({
    ...license,
    account_email: emailByAccountId.get(license.account_id) ?? null,
  }))
}

export async function resolveUserIdByEmail(email: string): Promise<string> {
  const trimmed = email.trim()
  if (!trimmed) {
    throw new Error("请输入目标用户的邮箱。")
  }
  const { data, error } = await supabase.rpc("resolve_user_id_by_email", {
    _email: trimmed,
  })
  if (error) throw error
  if (!data) {
    throw new Error(`未找到邮箱为 ${trimmed} 的 Lovstudio 账号，确认对方已注册。`)
  }
  return data as string
}

export function licenseExpiresAt(kind: LicenseKind) {
  const durationMs = CLOUD_LICENSE_DAYS[kind] * 86_400_000
  return new Date(Date.now() + durationMs).toISOString()
}

function nullableText(value?: string | null) {
  const trimmed = value?.trim() ?? ""
  return trimmed ? trimmed : null
}

function normalizeQuotaLevel(value?: number) {
  if (value === undefined) return 1
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("账号级别必须是大于等于 0 的整数。")
  }
  return Math.floor(value)
}

async function fetchProfileEmails(accountIds: string[]) {
  const uniqueAccountIds = Array.from(new Set(accountIds.filter(Boolean)))
  const emailByAccountId = new Map<string, string>()

  if (uniqueAccountIds.length === 0) {
    return emailByAccountId
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("id,email")
    .in("id", uniqueAccountIds)

  if (error) {
    console.warn("Unable to load license account emails", error)
    return emailByAccountId
  }

  for (const profile of data ?? []) {
    if (profile.email) {
      emailByAccountId.set(profile.id, profile.email)
    }
  }

  return emailByAccountId
}
