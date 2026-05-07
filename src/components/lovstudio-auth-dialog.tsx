import { useEffect, useState, type FormEvent } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  CheckCircle2Icon,
  Loader2Icon,
  LogInIcon,
  LogOutIcon,
  MailIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react"

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
import {
  pollLovstudioDeviceAuth,
  startLovstudioDeviceAuth,
  type LovstudioDeviceAuth,
} from "@/lib/lovstudio-device-auth"
import { assertLovstudioAuthReachable } from "@/lib/lovstudio-auth-service"
import { isTauri } from "@/lib/tauri"
import { copyableToast as toast } from "@/lib/toast"

interface LovstudioAuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LovstudioAuthDialog({
  open,
  onOpenChange,
}: LovstudioAuthDialogProps) {
  const {
    completeOAuthFromUrl,
    completeTokenSession,
    isLoading,
    profile,
    signInWithEmailOtp,
    signOut,
    user,
  } = useAuth()
  const [email, setEmail] = useState("")
  const [callbackUrl, setCallbackUrl] = useState("")
  const [busy, setBusy] = useState(false)
  const [deviceAuth, setDeviceAuth] = useState<LovstudioDeviceAuth | null>(null)
  const [pollingDeviceAuth, setPollingDeviceAuth] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || user || !deviceAuth) {
      return
    }

    let cancelled = false
    let timeoutId: number | undefined

    const poll = async () => {
      if (Date.now() > deviceAuth.expiresAt) {
        setPollingDeviceAuth(false)
        setError("Lovstudio 授权码已过期，请重新发起登录。")
        setDeviceAuth(null)
        return
      }

      setPollingDeviceAuth(true)

      try {
        const result = await pollLovstudioDeviceAuth(deviceAuth.deviceCode)

        if (cancelled) {
          return
        }

        if (result.status === "authenticated") {
          await completeTokenSession(result.accessToken, result.refreshToken)
          toast.success("Lovstudio 登录成功")
          setDeviceAuth(null)
          onOpenChange(false)
          return
        }

        timeoutId = window.setTimeout(poll, deviceAuth.intervalMs)
      } catch (caughtError) {
        if (!cancelled) {
          setPollingDeviceAuth(false)
          setError(errorMessage(caughtError))
        }
      }
    }

    timeoutId = window.setTimeout(poll, 1200)

    return () => {
      cancelled = true
      if (timeoutId) window.clearTimeout(timeoutId)
    }
  }, [completeTokenSession, deviceAuth, onOpenChange, open, user])

  if (!open) {
    return null
  }

  const submitEmail = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      await assertLovstudioAuthReachable()
      await signInWithEmailOtp(email.trim(), authRedirectUrl())
      setMessage("登录链接已发送，请到邮箱中点击确认。")
      toast.success("登录链接已发送")
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setBusy(false)
    }
  }

  const submitGoogle = async () => {
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      const nextDeviceAuth = await startLovstudioDeviceAuth()
      setDeviceAuth(nextDeviceAuth)

      await openDeviceAuthUrl(nextDeviceAuth)

      setMessage(
        `已打开 Lovstudio 授权页。授权码：${nextDeviceAuth.userCode}。确认授权后这里会自动完成登录。`
      )
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setBusy(false)
    }
  }

  const submitCallbackUrl = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setMessage(null)
    setError(null)

    try {
      await completeOAuthFromUrl(callbackUrl)
      setCallbackUrl("")
      toast.success("Lovstudio 登录成功")
      onOpenChange(false)
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onOpenChange(false)
        }
      }}
    >
      <Card className="w-full max-w-sm">
        <CardHeader className="relative pr-12">
          <div className="mb-1 flex items-center gap-2">
            <UserRoundIcon className="size-5 text-primary" />
            <CardTitle>登录 Lovstudio</CardTitle>
          </div>
          <CardDescription>
            授权、试用和正式套餐都绑定到 Lovstudio 账号。会打开官网授权页，可用
            Google 或邮箱登录。
          </CardDescription>
          <Button
            aria-label="关闭 Lovstudio 登录"
            className="absolute top-3 right-3"
            disabled={busy}
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </CardHeader>
        <CardContent className="grid gap-4">
          {isLoading ? (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              正在检查登录状态
            </div>
          ) : user ? (
            <div className="grid gap-3">
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm">
                <div className="font-medium">
                  {profile?.display_name ?? user.email ?? "Lovstudio 账号"}
                </div>
                <div className="mt-1 font-mono text-xs break-all text-muted-foreground">
                  {user.id}
                </div>
              </div>
              <Button
                disabled={busy}
                onClick={() => onOpenChange(false)}
                type="button"
              >
                继续使用
              </Button>
              <Button
                disabled={busy}
                onClick={() => void signOut()}
                type="button"
                variant="outline"
              >
                <LogOutIcon />
                退出登录
              </Button>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Button
                  className="w-full"
                  disabled={busy}
                  onClick={() => void submitGoogle()}
                  type="button"
                >
                  {busy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <>
                      <LogInIcon />
                      打开 Lovstudio 官网登录
                    </>
                  )}
                </Button>
                {deviceAuth ? (
                  <div className="rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm">
                    <div className="text-xs text-muted-foreground">授权码</div>
                    <div className="mt-1 font-mono text-lg font-semibold tracking-widest">
                      {deviceAuth.userCode}
                    </div>
                    <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      {pollingDeviceAuth ? (
                        <Loader2Icon className="size-3.5 animate-spin" />
                      ) : null}
                      在浏览器确认授权后，微探会自动完成登录。
                    </div>
                    <Button
                      className="mt-3 w-full"
                      disabled={busy}
                      onClick={() => void openDeviceAuthUrl(deviceAuth)}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      重新打开授权页
                    </Button>
                  </div>
                ) : null}
              </div>
              {message ? (
                <p className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-sm text-primary">
                  {message}
                </p>
              ) : null}
              {error ? (
                <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              ) : null}
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <div className="h-px flex-1 bg-border" />
                或
                <div className="h-px flex-1 bg-border" />
              </div>
              <form className="grid gap-3" onSubmit={submitEmail}>
                <div className="grid gap-2">
                  <Label htmlFor="lovstudio-email">邮箱</Label>
                  <div className="relative">
                    <MailIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="lovstudio-email"
                      autoComplete="email"
                      className="pl-8"
                      disabled={busy}
                      inputMode="email"
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="you@example.com"
                      type="email"
                      value={email}
                    />
                  </div>
                </div>
                <Button disabled={busy || !email.trim()} type="submit">
                  {busy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <>
                      <MailIcon />
                      发送邮箱登录链接
                    </>
                  )}
                </Button>
                <p className="text-xs text-muted-foreground">
                  邮箱登录需要当前应用能连接 Lovstudio
                  登录服务；网络受限时优先使用上方官网授权。
                </p>
              </form>
              <form
                className="grid gap-3 border-t border-border pt-4"
                onSubmit={submitCallbackUrl}
              >
                <div className="grid gap-2">
                  <Label htmlFor="lovstudio-callback-url">登录回调链接</Label>
                  <Input
                    id="lovstudio-callback-url"
                    disabled={busy}
                    onChange={(event) => setCallbackUrl(event.target.value)}
                    placeholder="浏览器地址栏中的完整链接"
                    spellCheck={false}
                    value={callbackUrl}
                  />
                </div>
                <Button
                  disabled={busy || !callbackUrl.trim()}
                  type="submit"
                  variant="outline"
                >
                  {busy ? (
                    <Loader2Icon className="size-4 animate-spin" />
                  ) : (
                    <>
                      <CheckCircle2Icon />
                      完成登录
                    </>
                  )}
                </Button>
              </form>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function authRedirectUrl() {
  const [url] = window.location.href.split("#")
  return url
}

async function openDeviceAuthUrl(deviceAuth: LovstudioDeviceAuth) {
  if (isTauri()) {
    await openUrl(deviceAuth.verificationUriComplete)
    return
  }

  const popup = window.open(
    deviceAuth.verificationUriComplete,
    "_blank",
    "noopener,noreferrer"
  )

  if (!popup) {
    window.location.assign(deviceAuth.verificationUriComplete)
  }
}

function errorMessage(error: unknown) {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }

  return String(error)
}
