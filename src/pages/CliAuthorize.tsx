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
  device_code: string
  user_code: string
  client_name: string | null
  scope: string | null
  expires_at: string
  user_id?: string | null
  consumed_at?: string | null
}

type DeviceCodeSelectResult = {
  data: DeviceCodeRow | null
  error: { message: string } | null
}

type DeviceCodeUpdateResult = {
  error: { message: string } | null
}

type DeviceCodeTable = {
  select: (columns: string) => {
    eq: (column: string, value: string) => {
      maybeSingle: () => Promise<DeviceCodeSelectResult>
    }
  }
  update: (values: Record<string, string>) => {
    eq: (column: string, value: string) => Promise<DeviceCodeUpdateResult>
  }
}

const lovstudioData = supabase as unknown as {
  from: (table: "cli_device_codes") => DeviceCodeTable
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

    const { data, error: selectError } = await lovstudioData
      .from("cli_device_codes")
      .select(
        "device_code, user_code, client_name, scope, expires_at, user_id, consumed_at"
      )
      .eq("user_code", normalized)
      .maybeSingle()

    if (selectError) {
      setError(`查询失败：${selectError.message}`)
      return
    }

    if (!data) {
      setError("授权码不存在或已过期。")
      return
    }

    if (data.user_id && data.user_id !== user?.id) {
      setError("这个授权码已被其他账号使用。")
      return
    }

    if (data.consumed_at) {
      setError("这个授权码已经完成登录，请在微探里重新发起登录。")
      return
    }

    if (new Date(data.expires_at) < new Date()) {
      setError("授权码已过期，请在微探里重新发起登录。")
      return
    }

    setDeviceRow(data)
  }

  const approve = async () => {
    if (!deviceRow || !user) return

    setClaiming(true)
    setError(null)

    const { error: updateError } = await lovstudioData
      .from("cli_device_codes")
      .update({ user_id: user.id, approved_at: new Date().toISOString() })
      .eq("device_code", deviceRow.device_code)

    setClaiming(false)

    if (updateError) {
      setError(`授权失败：${updateError.message}`)
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
              需要先登录 Lovstudio 账号，才能授权微探桌面端。
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
              回到微探桌面端，它会在几秒内自动完成登录。
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
    (deviceRow?.scope === "wxmp-cracker" ? "微探桌面端" : "Lovstudio 客户端")

  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>授权微探登录</CardTitle>
          <CardDescription>
            确认后，微探桌面端会绑定当前 Lovstudio 账号。
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
