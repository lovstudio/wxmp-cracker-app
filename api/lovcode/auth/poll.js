import { createClient } from "@supabase/supabase-js"

const CORS_HEADERS = {
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Origin": "*",
}

export default async function handler(request, response) {
  applyCors(response)

  if (request.method === "OPTIONS") {
    response.status(204).end()
    return
  }

  if (request.method !== "POST") {
    response.status(405).json({ error: "method_not_allowed" })
    return
  }

  try {
    const input = await readJsonBody(request)
    const deviceCode = getString(input.deviceCode, 128)

    if (!deviceCode) {
      response.status(400).json({ error: "invalid_request" })
      return
    }

    const admin = adminClient()
    const { data: row, error } = await admin
      .from("cli_device_codes")
      .select("*")
      .eq("device_code", deviceCode)
      .maybeSingle()

    if (error) {
      response.status(500).json({ detail: error.message, error: "server_error" })
      return
    }

    if (!row) {
      response.status(200).json({ error: "expired_token" })
      return
    }

    if (new Date(row.expires_at) < new Date()) {
      await admin.from("cli_device_codes").delete().eq("device_code", deviceCode)
      response.status(200).json({ error: "expired_token" })
      return
    }

    if (!row.user_id) {
      response
        .status(200)
        .json({ error: "authorization_pending", status: "pending" })
      return
    }

    if (row.consumed_at) {
      response
        .status(400)
        .json({ detail: "code already consumed", error: "access_denied" })
      return
    }

    const { data: userData, error: userError } =
      await admin.auth.admin.getUserById(row.user_id)

    if (userError || !userData?.user?.email) {
      response
        .status(500)
        .json({ detail: "user lookup failed", error: "server_error" })
      return
    }

    const { data: linkData, error: linkError } =
      await admin.auth.admin.generateLink({
        email: userData.user.email,
        type: "magiclink",
      })

    if (linkError || !linkData?.properties?.hashed_token) {
      response
        .status(500)
        .json({ detail: "link generation failed", error: "server_error" })
      return
    }

    const anon = anonClient()
    const { data: sessionData, error: verifyError } =
      await anon.auth.verifyOtp({
        token_hash: linkData.properties.hashed_token,
        type: "magiclink",
      })

    if (verifyError || !sessionData?.session) {
      response
        .status(500)
        .json({ detail: "otp verify failed", error: "server_error" })
      return
    }

    await admin
      .from("cli_device_codes")
      .update({ consumed_at: new Date().toISOString() })
      .eq("device_code", deviceCode)

    response.status(200).json(tokenPayload(sessionData.session))
  } catch (error) {
    response.status(500).json({
      detail: error instanceof Error ? error.message : "Unknown error",
      error: "server_error",
    })
  }
}

function adminClient() {
  const supabaseUrl = supabaseUrlEnv()
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase server env is not configured.")
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function anonClient() {
  const supabaseUrl = supabaseUrlEnv()
  const anonKey =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    process.env.SUPABASE_ANON_KEY

  if (!supabaseUrl || !anonKey) {
    throw new Error("Supabase client env is not configured.")
  }

  return createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function supabaseUrlEnv() {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL
  )
}

function applyCors(response) {
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    response.setHeader(key, value)
  }
}

async function readJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body
  if (typeof request.body === "string") return JSON.parse(request.body || "{}")
  return {}
}

function getString(value, maxChars) {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed) return null
  return Array.from(trimmed).slice(0, maxChars).join("")
}

function tokenPayload(session) {
  return {
    accessToken: session.access_token,
    expiresAt:
      session.expires_at || Math.floor(Date.now() / 1000) + session.expires_in,
    expiresIn: session.expires_in,
    refreshToken: session.refresh_token,
    status: "authenticated",
    user: {
      email: session.user.email || "",
      id: session.user.id,
    },
  }
}
