#!/usr/bin/env bun

import { createHmac } from "node:crypto"
import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url))
const LOCAL_SECRET_PATH = join(PROJECT_ROOT, ".activation-secret.local")

function resolvePrimaryWorktreeRoot(projectRoot) {
  const gitFile = join(projectRoot, ".git")
  if (!existsSync(gitFile) || !statSync(gitFile).isFile()) return null

  const gitDirValue = readFileSync(gitFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim()
  if (!gitDirValue) return null

  const gitDir = isAbsolute(gitDirValue)
    ? gitDirValue
    : resolve(projectRoot, gitDirValue)
  const commonDirFile = join(gitDir, "commondir")
  if (!existsSync(commonDirFile)) return null

  const commonDirValue = readFileSync(commonDirFile, "utf8").trim()
  const commonGitDir = isAbsolute(commonDirValue)
    ? commonDirValue
    : resolve(gitDir, commonDirValue)
  return dirname(commonGitDir)
}

const PRIMARY_WORKTREE_ROOT = resolvePrimaryWorktreeRoot(PROJECT_ROOT)
const SECRET_PATHS = [
  LOCAL_SECRET_PATH,
  ...(PRIMARY_WORKTREE_ROOT && PRIMARY_WORKTREE_ROOT !== PROJECT_ROOT
    ? [join(PRIMARY_WORKTREE_ROOT, ".activation-secret.local")]
    : []),
]

function readFirstNonEmpty(paths) {
  for (const path of paths) {
    if (!existsSync(path)) continue
    const value = readFileSync(path, "utf8").trim()
    if (value) return value
  }
  return ""
}

const ACTIVATION_SECRET =
  process.env.WXMP_ACTIVATION_SECRET?.trim() || readFirstNonEmpty(SECRET_PATHS)

if (!ACTIVATION_SECRET) {
  console.error(
    "Set WXMP_ACTIVATION_SECRET or create .activation-secret.local in this worktree or the primary repository worktree before generating codes."
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
