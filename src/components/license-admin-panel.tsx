import { useEffect, useState, type FormEvent } from "react"
import {
  CloudUploadIcon,
  Loader2Icon,
  LogInIcon,
  LogOutIcon,
  SaveIcon,
  ShieldCheckIcon,
  ShieldXIcon,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAuth } from "@/hooks/useAuth"
import type { LicenseKind } from "@/lib/api"
import {
  CLOUD_LICENSE_DAYS,
  resolveUserIdByEmail,
  upsertCloudLicense,
  type CloudLicense,
} from "@/lib/cloud-license"
import {
  fetchQuotaSettings,
  updateQuotaSettings,
  type QuotaSettings,
} from "@/lib/quota"
import { copyableToast as toast } from "@/lib/toast"

interface LicenseAdminPanelProps {
  defaultTargetAccountId?: string | null
  onAuthorized?: (license: CloudLicense) => void
}

interface LicenseAdminDialogProps extends LicenseAdminPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function LicenseAdminDialog({
  defaultTargetAccountId,
  onAuthorized,
  onOpenChange,
  open,
}: LicenseAdminDialogProps) {
  if (!open) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/45 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onOpenChange(false)
        }
      }}
    >
      <Card className="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto">
        <CardHeader className="relative pr-12">
          <div className="mb-1 flex items-center gap-2">
            <ShieldCheckIcon className="size-5 text-primary" />
            <CardTitle>授权与频率管理</CardTitle>
          </div>
          <CardDescription>
            管理员可授权目标 Lovstudio 账号，并调整接口频率参数。
          </CardDescription>
          <Button
            aria-label="关闭授权管理"
            className="absolute top-3 right-3"
            onClick={() => onOpenChange(false)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        </CardHeader>
        <CardContent>
          <LicenseAdminPanel
            defaultTargetAccountId={defaultTargetAccountId}
            onAuthorized={(license) => {
              onAuthorized?.(license)
              onOpenChange(false)
            }}
          />
        </CardContent>
      </Card>
    </div>
  )
}

export function LicenseAdminPanel({
  defaultTargetAccountId,
  onAuthorized,
}: LicenseAdminPanelProps) {
  const { isActualAdmin, isLoading, profile, signIn, signOut, user } = useAuth()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [targetMode, setTargetMode] = useState<"email" | "uid">("email")
  const [targetEmail, setTargetEmail] = useState("")
  const [targetAccountId, setTargetAccountId] = useState(
    defaultTargetAccountId ?? ""
  )
  const [kind, setKind] = useState<LicenseKind>("official")
  const [quotaLevel, setQuotaLevel] = useState("1")
  const [customer, setCustomer] = useState("")
  const [quotaSettings, setQuotaSettings] = useState<QuotaSettings | null>(null)
  const [accountLevelFactor, setAccountLevelFactor] = useState("5")
  const [ownCapabilityFactor, setOwnCapabilityFactor] = useState("50")
  const [defaultAccountLevel, setDefaultAccountLevel] = useState("0")
  const [busy, setBusy] = useState(false)
  const [quotaBusy, setQuotaBusy] = useState(false)
  const [quotaLoading, setQuotaLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (defaultTargetAccountId && !targetAccountId.trim()) {
      setTargetAccountId(defaultTargetAccountId)
      setTargetMode("uid")
    }
  }, [defaultTargetAccountId, targetAccountId])

  useEffect(() => {
    let cancelled = false

    if (!isActualAdmin) {
      return
    }

    setQuotaLoading(true)
    fetchQuotaSettings()
      .then((settings) => {
        if (cancelled) return
        setQuotaSettings(settings)
        setAccountLevelFactor(String(settings.account_level_factor))
        setOwnCapabilityFactor(String(settings.own_capability_factor))
        setDefaultAccountLevel(String(settings.default_account_level))
      })
      .catch((caughtError) => {
        if (!cancelled) {
          setError(errorMessage(caughtError))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setQuotaLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [isActualAdmin])

  const submitSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      await signIn(email, password)
      setPassword("")
      toast.success("管理员账号已登录")
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setBusy(false)
    }
  }

  const submitAuthorization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)

    try {
      const normalizedQuotaLevel = parseNonNegativeInt(quotaLevel, "账号级别")
      const resolvedAccountId =
        targetMode === "email"
          ? await resolveUserIdByEmail(targetEmail)
          : targetAccountId.trim()
      if (!resolvedAccountId) {
        throw new Error("请输入目标用户的邮箱或账号 ID。")
      }
      const license = await upsertCloudLicense({
        accountId: resolvedAccountId,
        kind,
        quotaLevel: normalizedQuotaLevel,
        customer,
      })
      const message = `已授权 ${license.account_id}，${licenseKindLabel(
        license.kind
      )}、账号级别 L${license.quota_level}，有效至 ${formatDate(
        license.expires_at
      )}。`
      setNotice(message)
      toast.success("云端授权已生效")
      onAuthorized?.(license)
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setBusy(false)
    }
  }

  const submitQuotaSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setQuotaBusy(true)
    setError(null)
    setNotice(null)

    try {
      const settings = await updateQuotaSettings({
        accountLevelFactor: parseNonNegativeInt(
          accountLevelFactor,
          "每级基础保障"
        ),
        ownCapabilityFactor: parseNonNegativeInt(
          ownCapabilityFactor,
          "每个自有公众号能力加成"
        ),
        defaultAccountLevel: parseNonNegativeInt(
          defaultAccountLevel,
          "默认账号级别"
        ),
      })
      setQuotaSettings(settings)
      setNotice(
        `额度模型已更新：每级基础保障 ${settings.account_level_factor} 次/小时，每个自有公众号能力加成 ${settings.own_capability_factor} 次/小时。`
      )
      toast.success("频率参数已更新")
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setQuotaBusy(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-3 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" />
        正在检查管理员权限
      </div>
    )
  }

  if (!user) {
    return (
      <form className="grid gap-3" onSubmit={submitSignIn}>
        <div className="grid gap-2">
          <Label htmlFor="license-admin-email">管理员邮箱</Label>
          <Input
            id="license-admin-email"
            autoComplete="email"
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="license-admin-password">密码</Label>
          <Input
            id="license-admin-password"
            autoComplete="current-password"
            disabled={busy}
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </div>
        {error ? <ErrorMessage message={error} /> : null}
        <Button disabled={busy || !email.trim() || !password} type="submit">
          {busy ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <>
              <LogInIcon />
              登录管理员账号
            </>
          )}
        </Button>
      </form>
    )
  }

  if (!isActualAdmin) {
    return (
      <div className="grid gap-3">
        <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-3 text-sm text-destructive">
          <div className="flex items-center gap-2 font-medium">
            <ShieldXIcon className="size-4" />
            当前账号无管理员权限
          </div>
          <div className="mt-1 text-xs break-all">
            {profile?.email ?? user.email ?? user.id}
          </div>
        </div>
        <Button
          disabled={busy}
          onClick={() => void signOut()}
          type="button"
          variant="outline"
        >
          <LogOutIcon />
          退出 Supabase 登录
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-5">
      <div className="rounded-lg border border-border bg-muted/35 px-3 py-2 text-sm">
        <div className="font-medium">当前管理员</div>
        <div className="mt-1 text-xs break-all text-muted-foreground">
          {profile?.display_name ?? user.email ?? user.id}
        </div>
      </div>
      <form className="grid gap-4" onSubmit={submitAuthorization}>
        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label>目标 Lovstudio 账号</Label>
            <div className="inline-flex overflow-hidden rounded-md border border-border text-xs">
              <button
                className={`px-2 py-0.5 transition ${
                  targetMode === "email"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-muted"
                }`}
                disabled={busy}
                onClick={() => setTargetMode("email")}
                type="button"
              >
                邮箱
              </button>
              <button
                className={`px-2 py-0.5 transition ${
                  targetMode === "uid"
                    ? "bg-primary text-primary-foreground"
                    : "bg-transparent text-muted-foreground hover:bg-muted"
                }`}
                disabled={busy}
                onClick={() => setTargetMode("uid")}
                type="button"
              >
                用户 ID
              </button>
            </div>
          </div>
          {targetMode === "email" ? (
            <Input
              id="license-target-email"
              autoComplete="off"
              disabled={busy}
              onChange={(event) => setTargetEmail(event.target.value)}
              placeholder="customer@example.com"
              spellCheck={false}
              type="email"
              value={targetEmail}
            />
          ) : (
            <Input
              id="license-target-account"
              className="font-mono text-sm"
              disabled={busy}
              onChange={(event) => setTargetAccountId(event.target.value)}
              placeholder="Supabase user.id"
              spellCheck={false}
              value={targetAccountId}
            />
          )}
          <p className="text-xs text-muted-foreground">
            {targetMode === "email"
              ? "需对方已用此邮箱注册过 Lovstudio 账号。"
              : "Supabase auth.users.id（UUID）。"}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_112px]">
          <div className="grid gap-2">
            <Label htmlFor="license-kind">授权类型</Label>
            <Select
              disabled={busy}
              onValueChange={(value) => setKind(value as LicenseKind)}
              value={kind}
            >
              <SelectTrigger id="license-kind" className="h-9 w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="trial">试用 7 天</SelectItem>
                <SelectItem value="official">正式 1 年</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {licenseKindLabel(kind)}会从授权写入时开始计算，
              {CLOUD_LICENSE_DAYS[kind]} 天后到期。
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="license-quota-level">账号级别</Label>
            <Input
              id="license-quota-level"
              disabled={busy}
              min={0}
              onChange={(event) => setQuotaLevel(event.target.value)}
              type="number"
              value={quotaLevel}
            />
          </div>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="license-customer">客户备注</Label>
          <Input
            id="license-customer"
            disabled={busy}
            onChange={(event) => setCustomer(event.target.value)}
            placeholder="可选"
            value={customer}
          />
        </div>
        <Button
          disabled={
            busy ||
            (targetMode === "email"
              ? !targetEmail.trim()
              : !targetAccountId.trim())
          }
          type="submit"
        >
          {busy ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <>
              <CloudUploadIcon />
              授权目标账号
            </>
          )}
        </Button>
      </form>
      <form
        className="grid gap-4 border-t border-border pt-5"
        onSubmit={submitQuotaSettings}
      >
        <div>
          <div className="text-sm font-medium">额度模型</div>
          <div className="mt-1 text-xs text-muted-foreground">
            平台共享池保守分配基础保障，自有公众号能力独立计入加成。
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-2">
            <Label htmlFor="quota-default-level">未授权默认等级</Label>
            <Input
              id="quota-default-level"
              disabled={quotaBusy || quotaLoading}
              min={0}
              onChange={(event) => setDefaultAccountLevel(event.target.value)}
              type="number"
              value={defaultAccountLevel}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quota-account-factor">每级基础保障</Label>
            <Input
              id="quota-account-factor"
              disabled={quotaBusy || quotaLoading}
              min={0}
              onChange={(event) => setAccountLevelFactor(event.target.value)}
              type="number"
              value={accountLevelFactor}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="quota-capability-factor">自有能力加成</Label>
            <Input
              id="quota-capability-factor"
              disabled={quotaBusy || quotaLoading}
              min={0}
              onChange={(event) => setOwnCapabilityFactor(event.target.value)}
              type="number"
              value={ownCapabilityFactor}
            />
          </div>
        </div>
        {quotaSettings ? (
          <div className="rounded-lg border border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
            当前：未授权默认 L{quotaSettings.default_account_level}
            ，每级基础保障 {quotaSettings.account_level_factor}{" "}
            次/小时，自有能力加成 {quotaSettings.own_capability_factor} 次/小时
          </div>
        ) : null}
        <Button
          disabled={quotaBusy || quotaLoading}
          type="submit"
          variant="outline"
        >
          {quotaBusy || quotaLoading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <>
              <SaveIcon />
              保存频率参数
            </>
          )}
        </Button>
      </form>
      {error ? <ErrorMessage message={error} /> : null}
      {notice ? (
        <p className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-sm text-primary">
          {notice}
        </p>
      ) : null}
    </div>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
      {message}
    </p>
  )
}

function licenseKindLabel(kind: LicenseKind) {
  return kind === "trial" ? "试用授权" : "正式授权"
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value))
}

function parseNonNegativeInt(value: string, label: string) {
  const number = Number.parseInt(value, 10)
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${label}必须是大于等于 0 的整数。`)
  }
  return number
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
