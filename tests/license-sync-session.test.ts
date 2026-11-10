import { beforeEach, describe, expect, mock, test } from "bun:test"

const accountId = "34b6688b-a54f-405b-91f9-c8604baa8253"
const invoked: Array<{ command: string; args: unknown }> = []
let session: { access_token: string; user: { id: string } } | null = null

// bun's module mocks apply to every test file that runs later, so keep the rest of the real module.
const tauriCore = await import("@tauri-apps/api/core")
mock.module("@tauri-apps/api/core", () => ({
  ...tauriCore,
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args })
    return { active: true }
  },
}))
mock.module("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
    },
  },
}))

const { syncRemoteLicense } = await import("../src/lib/cloud-license")

describe("cloud license sync", () => {
  beforeEach(() => {
    invoked.length = 0
    session = null
  })

  test("looks the licence up with the signed-in account's own session", async () => {
    session = { access_token: "session-token", user: { id: accountId } }

    await syncRemoteLicense(accountId)

    expect(invoked).toEqual([
      {
        command: "sync_remote_license",
        args: { accountId, accessToken: "session-token" },
      },
    ])
  })

  test("does not look up an account other than the session's own", async () => {
    session = {
      access_token: "session-token",
      user: { id: "00000000-0000-4000-8000-000000000000" },
    }

    await expect(syncRemoteLicense(accountId)).rejects.toThrow(
      "请重新登录后再同步授权"
    )
    expect(invoked).toEqual([])
  })

  test("does not look anything up while signed out", async () => {
    await expect(syncRemoteLicense(accountId)).rejects.toThrow(
      "请重新登录后再同步授权"
    )
    expect(invoked).toEqual([])
  })
})
