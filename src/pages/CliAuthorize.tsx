import { useEffect, useMemo, useState } from "react"
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useAuth } from "@/hooks/useAuth"
import { supabase } from "@/integrations/supabase/client"

type Phase = "loading" | "need-login" | "ready" | "claimed"

type DeviceCodeRow = {
  user_code: string
  client_name: string | null
  scope: string | null
  expires_at: string
  approved: boolean
}

type DeviceCodeLookupResult = {
  data: DeviceCodeRow[] | null
  error: { message: string } | null
}

type DeviceCodeApproveResult = {
  data: boolean | null
  error: { message: string } | null
}

const lovstudioData = supabase as unknown as {
  rpc: {
    (
      fn: "lookup_cli_device_code",
      args: { p_user_code: string }
    ): Promise<DeviceCodeLookupResult>
    (
      fn: "approve_cli_device_code",
      args: { p_user_code: string }
    ): Promise<DeviceCodeApproveResult>
  }
}

export function CliAuthorize() {
  const params = useMemo(() => new URLSearchParams(window.location.search), [])
  const { isLoading, user } = useAuth()
  const [codeInput, setCodeInput] = useState("")
  const [phase, setPhase] = useState<Phase>("loading")
  const [deviceRow, setDeviceRow] = useState<DeviceCodeRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [claiming, setClaiming] = useState(false)

  useEffect(() => {
    if (isLoading) return

    if (!user) {
      setPhase("need-login")
      return
    }

    const code = params.get("code")
    if (code) setCodeInput(normalizeCode(code))
    setPhase("ready")
  }, [isLoading, params, user])

  const lookupCode = async () => {
    const normalized = normalizeCode(codeInput)
    if (!normalized) return

    setError(null)
    setDeviceRow(null)

    const { data, error: selectError } = await lovstudioData.rpc(
      "lookup_cli_device_code",
      { p_user_code: normalized }
    )

    if (selectError) {
      setError(`查询失败：${selectError.message}`)
      return
    }

    const row = data?.[0]

    if (!row) {
      setError("授权码不存在或已过期。")
      return
    }

    setDeviceRow(row)
  }

  const approve = async () => {
    if (!deviceRow || !user) return

    setClaiming(true)
    setError(null)

    const { data: approved, error: updateError } = await lovstudioData.rpc(
      "approve_cli_device_code",
      { p_user_code: deviceRow.user_code }
    )

    setClaiming(false)

    if (updateError || !approved) {
      setError(
        updateError
          ? `授权失败：${updateError.message}`
          : "授权失败，授权码已过期或已被使用。"
      )
      return
    }

    setPhase("claimed")
  }

  if (phase === "loading") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
      </main>
    )
  }

  if (phase === "need-login") {
    const redirect = `/cli/authorize${window.location.search}`

    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>登录 Lovstudio</CardTitle>
            <CardDescription>
              需要先登录 Lovstudio 账号，才能授权微碳桌面端。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              className="w-full"
              type="button"
              onClick={() =>
                window.location.assign(
                  `/auth?redirect=${encodeURIComponent(redirect)}`
                )
              }
            >
              前往登录
            </Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (phase === "claimed") {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2Icon className="size-5 text-emerald-600" />
              授权成功
            </CardTitle>
            <CardDescription>
              回到微碳桌面端，它会在几秒内自动完成登录。
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="break-all text-xs text-muted-foreground">
              当前账号：{user?.email ?? user?.id}
            </p>
          </CardContent>
        </Card>
      </main>
    )
  }

  const clientLabel =
    deviceRow?.client_name ||
    (deviceRow?.scope === "wxmp-cracker" ? "微碳桌面端" : "Lovstudio 客户端")

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>授权微碳登录</CardTitle>
          <CardDescription>
            确认后，微碳桌面端会绑定当前 Lovstudio 账号。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {!deviceRow ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="device-code">授权码</Label>
                <Input
                  id="device-code"
                  autoFocus
                  className="font-mono tracking-widest"
                  onChange={(event) =>
                    setCodeInput(normalizeCode(event.target.value))
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void lookupCode()
                  }}
                  placeholder="ABCD-EFGH"
                  value={codeInput}
                />
              </div>
              {error ? <ErrorMessage message={error} /> : null}
              <Button
                className="w-full"
                disabled={!codeInput.trim()}
                onClick={() => void lookupCode()}
                type="button"
              >
                继续
              </Button>
            </>
          ) : (
            <>
              <div className="rounded-lg border border-border bg-muted/40 p-3">
                <div className="text-xs text-muted-foreground">授权码</div>
                <div className="mt-1 font-mono text-lg font-semibold tracking-widest">
                  {deviceRow.user_code}
                </div>
                <div className="mt-3 text-xs text-muted-foreground">客户端</div>
                <div className="mt-1 text-sm">{clientLabel}</div>
                <div className="mt-3 text-xs text-muted-foreground">账号</div>
                <div className="mt-1 break-all text-sm">
                  {user?.email ?? user?.id}
                </div>
              </div>
              {error ? <ErrorMessage message={error} /> : null}
              <div className="flex gap-2">
                <Button
                  disabled={claiming}
                  onClick={() => {
                    setDeviceRow(null)
                    setError(null)
                  }}
                  type="button"
                  variant="outline"
                >
                  取消
                </Button>
                <Button
                  className="flex-1"
                  disabled={claiming}
                  onClick={() => void approve()}
                  type="button"
                >
                  {claiming ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    "确认授权"
                  )}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      <XCircleIcon className="size-4 shrink-0" />
      <span>{message}</span>
    </p>
  )
}

function normalizeCode(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "")
}
