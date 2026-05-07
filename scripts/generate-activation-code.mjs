#!/usr/bin/env bun

import { createHmac } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"

const LOCAL_SECRET_PATH = new URL("../.activation-secret.local", import.meta.url)

const ACTIVATION_SECRET =
  process.env.WXMP_ACTIVATION_SECRET ??
  (existsSync(LOCAL_SECRET_PATH)
    ? readFileSync(LOCAL_SECRET_PATH, "utf8").trim()
    : "")

if (!ACTIVATION_SECRET) {
  console.error(
    "Set WXMP_ACTIVATION_SECRET or create .activation-secret.local before generating codes."
  )
  process.exit(1)
}

const kind = process.argv[2]?.toLowerCase()
const accountId = process.argv[3]?.trim()
const customer = process.argv[4]

if ((kind !== "trial" && kind !== "official") || !accountId) {
  console.error(
    "Usage: bun scripts/generate-activation-code.mjs <trial|official> <account-id> [customer]"
  )
  process.exit(1)
}

const payload = {
  v: 1,
  kind,
  account_id: accountId,
  issued_at: Math.floor(Date.now() / 1000),
  ...(customer ? { customer } : {}),
}
const payloadText = JSON.stringify(payload)
const payloadBase64 = Buffer.from(payloadText).toString("base64url")
const signature = createHmac("sha256", ACTIVATION_SECRET)
  .update(payloadBase64)
  .digest("base64url")

console.log(`WXMP.${kind.toUpperCase()}.${payloadBase64}.${signature}`)
