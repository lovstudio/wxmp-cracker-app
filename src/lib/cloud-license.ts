import { supabase } from "@/integrations/supabase/client"
import type { Tables, TablesInsert } from "@/integrations/supabase/types"
import type { LicenseKind } from "@/lib/api"

export type CloudLicense = Tables<"wxmp_licenses">

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
