import { randomBytes } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const DEVICE_CODE_TTL_SEC = 10 * 60
const POLL_INTERVAL_SEC = 5
const USER_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
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
    const clientName = getString(input.clientName, "微探桌面端", 80)
    const scope = getString(input.scope, "wxmp-cracker", 40)
    const supabase = adminClient()
    const deviceCode = randomHex(32)
    let code = userCode()
    let insertError = null

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const { error } = await supabase.from("cli_device_codes").insert({
        client_name: clientName,
        device_code: deviceCode,
        expires_at: new Date(
          Date.now() + DEVICE_CODE_TTL_SEC * 1000
        ).toISOString(),
        scope,
        user_code: code,
      })

      if (!error) {
        insertError = null
        break
      }

      insertError = error
      if (error.code === "23505") {
        code = userCode()
        continue
      }
      break
    }

    if (insertError) {
      response.status(500).json({
        detail: insertError.message,
        error: "device_code_insert_failed",
      })
      return
    }

    const verificationUri = `${siteUrl(request)}/cli/authorize`

    response.status(200).json({
      deviceCode,
      expiresIn: DEVICE_CODE_TTL_SEC,
      interval: POLL_INTERVAL_SEC,
      userCode: code,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(
        code
      )}`,
    })
  } catch (error) {
    response.status(500).json({
      detail: error instanceof Error ? error.message : "Unknown error",
      error: "server_error",
    })
  }
}

function adminClient() {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("Supabase server env is not configured.")
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
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

function randomHex(byteLength) {
  return randomBytes(byteLength).toString("hex")
}

function userCode() {
  return Array.from(randomBytes(8), (byte) => {
    return USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
  })
    .join("")
    .replace(/^(.{4})(.{4})$/, "$1-$2")
}

function getString(value, fallback, maxChars) {
  if (typeof value !== "string") return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return Array.from(trimmed).slice(0, maxChars).join("")
}

function siteUrl(request) {
  const configured =
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL
  if (configured) return configured.replace(/\/$/, "")

  const host = request.headers["x-forwarded-host"] || request.headers.host
  const proto = request.headers["x-forwarded-proto"] || "https"
  return `${proto}://${host}`
}
