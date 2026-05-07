import { useCallback, useEffect, useState, type FormEvent } from "react"
import {
  KeyRoundIcon,
  Loader2Icon,
  LogInIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { LicenseAdminPanel } from "@/components/license-admin-panel"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { api, type LicenseStatus } from "@/lib/api"
import { isTauri } from "@/lib/tauri"
import { copyableToast as toast } from "@/lib/toast"

interface LicenseGateProps {
  accountId: string | null
  accountLabel?: string | null
  open: boolean
  onActivated?: (status: LicenseStatus) => void
  onOpenAuth: () => void
  onOpenChange: (open: boolean) => void
}

export function LicenseGate({
  accountId,
  accountLabel,
  open,
  onActivated,
  onOpenAuth,
  onOpenChange,
}: LicenseGateProps) {
  const runningInTauri = isTauri()
  const [status, setStatus] = useState<LicenseStatus | null>(null)
  const [code, setCode] = useState("")
  const [activating, setActivating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshStatus = useCallback(async () => {
    let nextStatus = await api.licenseStatus(accountId)
    if (accountId && (!nextStatus.active || nextStatus.kind !== "official")) {
      try {
        nextStatus = await api.syncRemoteLicense(accountId)
      } catch (caughtError) {
        console.warn("Unable to sync remote license", caughtError)
      }
    }
    setStatus(nextStatus)
    return nextStatus
  }, [accountId])

  useEffect(() => {
    let cancelled = false

    if (!open) {
      return
    }

    if (!runningInTauri) {
      onActivated?.(browserPreviewLicenseStatus())
      onOpenChange(false)
      return
    }

    refreshStatus()
      .then((nextStatus) => {
        if (!cancelled) {
          if (nextStatus.active) {
            onActivated?.(nextStatus)
            onOpenChange(false)
          }
        }
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(errorMessage(caughtError))
        }
      })

    return () => {
      cancelled = true
    }
  }, [onActivated, onOpenChange, open, refreshStatus, runningInTauri])

  const submitActivation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setActivating(true)

    try {
      if (!accountId) {
        throw new Error("请先登录 Lovstudio 账号，再激活该账号。")
      }

      const nextStatus = await api.activateLicense(code, accountId)
      setStatus(nextStatus)
      setCode("")

      if (nextStatus.active) {
        toast.success(nextStatus.message)
        onActivated?.(nextStatus)
        onOpenChange(false)
      } else {
        setError(nextStatus.message)
      }
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setActivating(false)
    }
  }

  if (!open) {
    return null
  }

  const currentAccountId = accountId ?? status?.current_account_id ?? null
  const boundAccountId = status?.account_id ?? null

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !activating) {
          onOpenChange(false)
        }
      }}
    >
      <Card className="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto">
        <CardHeader>
          <div className="mb-1 flex items-center gap-2">
            <ShieldAlertIcon className="size-5 text-primary" />
            <CardTitle>需要激活</CardTitle>
          </div>
          <CardDescription>
            {status?.message ?? "请输入激活码后继续使用。"}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 pb-4">
          <form className="grid gap-4" onSubmit={submitActivation}>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <div className="font-medium">免费额度</div>
                <div className="text-muted-foreground">第 1 个账号</div>
              </div>
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
                <div className="font-medium">授权后</div>
                <div className="text-muted-foreground">继续抓取</div>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium">当前 Lovstudio 账号</div>
              {accountLabel ? (
                <div className="mt-1 truncate text-xs text-muted-foreground">
                  {accountLabel}
                </div>
              ) : null}
              <div className="mt-1 font-mono text-xs break-all text-muted-foreground">
                {currentAccountId ?? "未登录"}
              </div>
            </div>
            {boundAccountId ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
                <div className="font-medium">授权绑定 Lovstudio 账号</div>
                <div className="mt-1 font-mono text-xs break-all text-muted-foreground">
                  {boundAccountId}
                </div>
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="activation-code">激活码</Label>
              <div className="relative">
                <KeyRoundIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  id="activation-code"
                  className="h-9 pl-8 font-mono text-sm"
                  disabled={activating}
                  onChange={(event) => setCode(event.target.value)}
                  placeholder="WXMP.TRIAL..."
                  spellCheck={false}
                  value={code}
                />
              </div>
            </div>
            {error ? (
              <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <div className="grid gap-3">
              <Button
                disabled={activating}
                onClick={onOpenAuth}
                type="button"
                variant="outline"
              >
                <LogInIcon />
                登录 Lovstudio 账号
              </Button>
              <Button
                disabled={activating || !code.trim() || !currentAccountId}
                type="submit"
              >
                {activating ? (
                  <Loader2Icon className="size-4 animate-spin" />
                ) : (
                  <>
                    <ShieldCheckIcon />
                    激活当前账号
                  </>
                )}
              </Button>
              {status?.license_id ? (
                <p className="text-center text-xs text-muted-foreground">
                  授权 ID: {status.license_id}
                </p>
              ) : null}
            </div>
          </form>
          <div className="border-t border-border pt-4">
            <div className="mb-3">
              <div className="text-sm font-medium">管理员授权</div>
              <p className="mt-1 text-xs text-muted-foreground">
                为目标 Lovstudio 账号写入云端授权，目标用户登录后会自动激活。
              </p>
            </div>
            <LicenseAdminPanel
              defaultTargetAccountId={currentAccountId}
              onAuthorized={(license) => {
                if (license.account_id !== currentAccountId) {
                  return
                }

                api
                  .syncRemoteLicense(currentAccountId)
                  .then((nextStatus) => {
                    setStatus(nextStatus)
                    if (nextStatus.active) {
                      onActivated?.(nextStatus)
                      onOpenChange(false)
                    }
                  })
                  .catch((caughtError) => {
                    setError(errorMessage(caughtError))
                  })
              }}
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

function browserPreviewLicenseStatus(): LicenseStatus {
  return {
    active: true,
    kind: "official",
    activated_at: null,
    expires_at: null,
    days_remaining: null,
    customer: "Dev",
    license_id: "browser",
    account_id: "browser",
    current_account_id: "browser",
    message: "浏览器预览模式已跳过本机授权校验。",
  }
}

function errorMessage(error: unknown): string {
  const message =
    typeof error === "object" && error && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error)

  if (
    message.includes("Command license_status not found") ||
    message.includes("Command activate_license not found") ||
    message.includes("Command sync_remote_license not found")
  ) {
    return "授权命令未加载。请完全退出当前 Tauri 应用后重新启动，Rust 后端会重新编译并注册授权命令。"
  }

  return message
}
