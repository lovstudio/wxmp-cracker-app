const LOVSTUDIO_SITE_URL = (
  (import.meta.env.VITE_LOVSTUDIO_SITE_URL as string | undefined) ??
  "https://lovstudio.ai"
).replace(/\/$/, "")

type DeviceAuthStartResponse = {
  deviceCode?: string
  device_code?: string
  userCode?: string
  user_code?: string
  verificationUri?: string
  verification_uri?: string
  verificationUriComplete?: string
  verification_uri_complete?: string
  expiresIn?: number
  expires_in?: number
  interval?: number
  error?: string
  detail?: string
}

type DeviceAuthPollResponse = {
  status?: "pending" | "authenticated"
  accessToken?: string
  refreshToken?: string
  expiresIn?: number
  expiresAt?: number
  user?: {
    id: string
    email?: string
  }
  error?: string
  detail?: string
}

export type LovstudioDeviceAuth = {
  deviceCode: string
  userCode: string
  verificationUri: string
  verificationUriComplete: string
  expiresAt: number
  intervalMs: number
}

export type LovstudioDeviceAuthPollResult =
  | {
      status: "pending"
    }
  | {
      status: "authenticated"
      accessToken: string
      refreshToken: string
      user: {
        id: string
        email?: string
      }
    }

export async function startLovstudioDeviceAuth() {
  const response = await postJson<DeviceAuthStartResponse>(
    "/api/lovcode/auth/start",
    {
      clientName: "微探桌面端",
      scope: "wxmp-cracker",
    }
  )

  const deviceCode = response.deviceCode ?? response.device_code
  const userCode = response.userCode ?? response.user_code
  const verificationUri = response.verificationUri ?? response.verification_uri
  const verificationUriComplete =
    response.verificationUriComplete ?? response.verification_uri_complete
  const expiresIn = response.expiresIn ?? response.expires_in ?? 600
  const interval = response.interval ?? 5

  if (
    !deviceCode ||
    !userCode ||
    !verificationUri ||
    !verificationUriComplete
  ) {
    throw new Error("Lovstudio 登录服务返回了不完整的授权信息。")
  }

  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete,
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: Math.max(interval, 2) * 1000,
  } satisfies LovstudioDeviceAuth
}

export async function pollLovstudioDeviceAuth(
  deviceCode: string
): Promise<LovstudioDeviceAuthPollResult> {
  const response = await postJson<DeviceAuthPollResponse>(
    "/api/lovcode/auth/poll",
    {
      deviceCode,
    }
  )

  if (
    response.status === "pending" ||
    response.error === "authorization_pending"
  ) {
    return { status: "pending" }
  }

  if (response.status !== "authenticated") {
    throw new Error(
      response.detail || response.error || "Lovstudio 授权未完成。"
    )
  }

  if (!response.accessToken || !response.refreshToken || !response.user?.id) {
    throw new Error("Lovstudio 登录服务没有返回可用的会话。")
  }

  return {
    status: "authenticated",
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    user: response.user,
  }
}

async function postJson<T>(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${LOVSTUDIO_SITE_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  })

  const json = (await response.json().catch(() => ({}))) as T & {
    error?: string
    detail?: string
  }

  if (!response.ok) {
    throw new Error(
      json.detail || json.error || `Lovstudio 请求失败：${response.status}`
    )
  }

  return json
}
