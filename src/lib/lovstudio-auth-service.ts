import { supabaseUrl } from "@/integrations/supabase/client"

const AUTH_HEALTH_TIMEOUT_MS = 6_000

export async function assertLovstudioAuthReachable() {
  const controller = new AbortController()
  const timer = window.setTimeout(
    () => controller.abort(),
    AUTH_HEALTH_TIMEOUT_MS
  )

  try {
    await fetch(`${supabaseUrl}/auth/v1/health`, {
      cache: "no-store",
      mode: "no-cors",
      signal: controller.signal,
    })
  } catch {
    throw new Error(
      "当前网络无法连接 Lovstudio 登录服务（Supabase）。请切换网络或代理后重试。"
    )
  } finally {
    window.clearTimeout(timer)
  }
}
