import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"
import {
  FileCheck2Icon,
  HandshakeIcon,
  Loader2Icon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { useAuth } from "@/hooks/useAuth"
import type { LoginAccount } from "@/lib/api"
import { fetchMyCapability, saveMyCapability } from "@/lib/quota"
import { copyableToast as toast } from "@/lib/toast"

interface WechatCapabilityProps {
  authAccount: LoginAccount | null
  loggedIn: boolean
}

type WechatCapabilitySettings = ReturnType<
  typeof useWechatCapabilitySettingsState
>

const WechatCapabilitySettingsContext =
  createContext<WechatCapabilitySettings | null>(null)

export function WechatCapabilitySettingsProvider({
  authAccount,
  loggedIn,
  children,
}: WechatCapabilityProps & {
  children: ReactNode
}) {
  const settings = useWechatCapabilitySettingsState({ authAccount, loggedIn })

  return (
    <WechatCapabilitySettingsContext.Provider value={settings}>
      {children}
    </WechatCapabilitySettingsContext.Provider>
  )
}

type CapabilityControlVariant = "connection" | "quota"
type CommercialAuthorizationVariant = CapabilityControlVariant | "commercial"

export function WechatSelfCapabilityPreferenceControl({
  variant = "connection",
}: {
  variant?: CapabilityControlVariant
}) {
  const settings = useWechatCapabilitySettings()
  const capabilityHint = selfCapabilityHint(settings, variant)

  return (
    <WechatSelfCapabilityControl
      checked={settings.capabilityEnabled}
      disabled={
        !settings.user ||
        !settings.loggedIn ||
        !settings.hasWechatIdentity ||
        settings.loading ||
        settings.saving
      }
      hint={capabilityHint}
      onCheckedChange={(enabled) => {
        void settings.persistCapability(enabled, settings.providesToOthers)
      }}
    />
  )
}

export function WechatCapabilityStatusFeedback({
  className,
  loadingLabel = "正在读取设置",
  savingLabel = "正在保存设置",
}: {
  className?: string
  loadingLabel?: string
  savingLabel?: string
}) {
  const settings = useWechatCapabilitySettings()

  return (
    <CapabilityStatusFeedback
      className={className}
      loading={settings.loading}
      saving={settings.saving}
      error={settings.error}
      savingLabel={savingLabel}
      loadingLabel={loadingLabel}
    />
  )
}

export function useWechatCapabilityQuotaRevision() {
  return useWechatCapabilitySettings().quotaRevision
}

export function WechatCommercialAuthorizationSetting({
  variant = "connection",
}: {
  variant?: CommercialAuthorizationVariant
}) {
  const settings = useWechatCapabilitySettings()
  const commercialHint = commercialAuthorizationHint(settings, variant)

  return (
    <WechatCommercialAuthorizationControl
      checked={settings.providesToOthers}
      disabled={!settings.canSave || settings.loading || settings.saving}
      hint={commercialHint}
      onCheckedChange={(enabled) => {
        void settings.persistCapability(settings.capabilityEnabled, enabled)
      }}
    />
  )
}

export function WechatCommercialSupportPanel() {
  const settings = useWechatCapabilitySettings()
  const accountLabel = settings.loggedIn
    ? (settings.authAccount?.nickname ??
      settings.authAccount?.username ??
      "当前公众号")
    : "未连接公众号"

  return (
    <div className="grid min-w-0 gap-4 pb-1">
      <section className="min-w-0 rounded-xl border border-border bg-background/80 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <HandshakeIcon className="size-4" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold">公众号商业化支持</h3>
              <span className="rounded-md border border-primary/20 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                需额外约定
              </span>
            </div>
            <p className="mt-1 text-sm leading-6 text-muted-foreground">
              将当前已扫码公众号的剩余接口能力，对外作为数据支持服务的一部分参与调度。商业化授权与自用优先相互独立，只按服务端计算后的可用剩余能力参与他用。
            </p>
          </div>
        </div>
      </section>

      <section className="grid min-w-0 gap-3 md:grid-cols-3">
        <CommercialMechanismCard
          icon={<FileCheck2Icon className="size-4" />}
          title="先签署约定"
          body="授权范围、收益结算、数据边界与退出规则都写入额外商业条款；未完成签约时不应进入对外调度。"
        />
        <CommercialMechanismCard
          icon={<ShieldCheckIcon className="size-4" />}
          title="只调度剩余能力"
          body="平台根据账号状态、接口频率与当前使用量计算可供服务的剩余能力，不要求开启自用优先。"
        />
        <CommercialMechanismCard
          icon={<RefreshCwIcon className="size-4" />}
          title="关闭后停止新增"
          body="关闭授权后不再接受新的商业化调度；已发生的支持记录、结算与争议处理按已签署条款执行。"
        />
      </section>

      <section className="min-w-0 rounded-xl border border-border bg-background/80 p-4">
        <div className="mb-3 grid min-w-0 gap-1">
          <div className="text-sm font-semibold">当前授权账号</div>
          <div className="truncate text-xs text-muted-foreground">
            {accountLabel}
          </div>
        </div>
        <WechatCommercialAuthorizationSetting variant="commercial" />
        <CapabilityStatusFeedback
          className="mt-3"
          loading={settings.loading}
          saving={settings.saving}
          error={settings.error}
          savingLabel="正在保存商业化授权"
          loadingLabel="正在读取授权状态"
        />
      </section>
    </div>
  )
}

export function WechatCommercialAuthorizationControl({
  checked,
  disabled,
  hint,
  onCheckedChange,
}: {
  checked: boolean
  disabled: boolean
  hint: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-muted/35 px-3 py-3 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(checkedState) => {
          onCheckedChange(checkedState === true)
        }}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="font-medium">
          授权当前公众号账号参与商业化数据支持
        </span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

export function WechatSelfCapabilityControl({
  checked,
  disabled,
  hint,
  onCheckedChange,
}: {
  checked: boolean
  disabled: boolean
  hint: string
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <label className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-muted/35 px-3 py-3 text-sm">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(checkedState) => {
          onCheckedChange(checkedState === true)
        }}
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="font-medium">优先使用当前已登录的公众号账号</span>
        <span className="text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function selfCapabilityHint(
  settings: WechatCapabilitySettings,
  variant: CapabilityControlVariant
) {
  if (!settings.user) return "登录 Lovstudio 后可启用。"
  if (!settings.loggedIn || !settings.hasWechatIdentity) {
    return "扫码登录并同步账号信息后可启用。"
  }
  if (variant === "quota") {
    return settings.capabilityEnabled
      ? "当前公众号能力已计入上方自有能力。"
      : "关闭时，上方自有能力不计入这个公众号账号。"
  }
  return "启用后会优先消耗这个公众号账号的可用能力。"
}

function commercialAuthorizationHint(
  settings: WechatCapabilitySettings,
  variant: CommercialAuthorizationVariant
) {
  if (variant === "commercial") return commercialSupportHint(settings)
  if (variant === "quota") return quotaCommercialHint(settings)
  return connectionCommercialHint(settings)
}

function connectionCommercialHint(settings: WechatCapabilitySettings) {
  if (!settings.user) return "登录 Lovstudio 后可授权。"
  if (!settings.loggedIn || !settings.hasWechatIdentity) {
    return "扫码登录并同步账号信息后可授权。"
  }
  if (settings.providesToOthers) return "已授权参与商业化数据支持。"
  return "与自用优先独立；勾选前需签订额外商业条款。"
}

function quotaCommercialHint(settings: WechatCapabilitySettings) {
  if (!settings.user) return "登录 Lovstudio 后可授权。"
  if (!settings.loggedIn || !settings.hasWechatIdentity) {
    return "扫码登录并同步账号信息后可授权。"
  }
  if (settings.providesToOthers) {
    return "已允许剩余能力参与他用；不增加上方自用频率。"
  }
  return "关闭时不对外调度；不影响上方自用频率。"
}

function commercialSupportHint(settings: WechatCapabilitySettings) {
  if (!settings.user) return "登录 Lovstudio 后可签署并启用。"
  if (!settings.loggedIn || !settings.hasWechatIdentity) {
    return "先在连接页扫码同步公众号账号。"
  }
  if (settings.providesToOthers) {
    return "当前公众号已参与商业化数据支持。"
  }
  return "勾选后进入商业化支持池，不会改变自用优先设置。"
}

function useWechatCapabilitySettings() {
  const settings = useContext(WechatCapabilitySettingsContext)
  if (!settings) {
    throw new Error("WechatCapabilitySettingsProvider is required.")
  }
  return settings
}

function useWechatCapabilitySettingsState({
  authAccount,
  loggedIn,
}: WechatCapabilityProps) {
  const { user } = useAuth()
  const [capabilityEnabled, setCapabilityEnabled] = useState(false)
  const [providesToOthers, setProvidesToOthers] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [quotaRevision, setQuotaRevision] = useState(0)
  const hasWechatIdentity = Boolean(
    authAccount?.username?.trim() || authAccount?.nickname?.trim()
  )
  const canSave = Boolean(user && loggedIn && hasWechatIdentity)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)

    try {
      if (!canSave) {
        setCapabilityEnabled(false)
        setProvidesToOthers(false)
        return
      }

      const nextCapability = await fetchMyCapability()

      if (nextCapability) {
        const active = nextCapability.status === "active"
        const enabled = active && nextCapability.capability_units > 0
        setCapabilityEnabled(enabled)
        setProvidesToOthers(active && nextCapability.provides_to_others)
      } else {
        setCapabilityEnabled(false)
        setProvidesToOthers(false)
      }
    } catch (caughtError) {
      setError(errorMessage(caughtError))
    } finally {
      setLoading(false)
    }
  }, [canSave])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const persistCapability = useCallback(
    async (nextEnabled: boolean, nextProvidesToOthers: boolean) => {
      setCapabilityEnabled(nextEnabled)
      setProvidesToOthers(nextProvidesToOthers)

      if (!canSave) return

      setSaving(true)
      setError(null)

      try {
        const nextCapability = await saveMyCapability({
          mpNickname: authAccount?.nickname,
          mpUsername: authAccount?.username,
          mpAlias: authAccount?.alias,
          serviceType: authAccount?.service_type,
          capabilityEnabled: nextEnabled,
          providesToOthers: nextProvidesToOthers,
        })
        const savedActive = nextCapability.status === "active"
        const savedEnabled = savedActive && nextCapability.capability_units > 0

        setCapabilityEnabled(savedEnabled)
        setProvidesToOthers(savedActive && nextCapability.provides_to_others)
        setQuotaRevision((revision) => revision + 1)
        toast.success("公众号能力设置已保存")
      } catch (caughtError) {
        setError(errorMessage(caughtError))
        await refresh()
      } finally {
        setSaving(false)
      }
    },
    [authAccount, canSave, refresh]
  )

  return {
    authAccount,
    loggedIn,
    user,
    capabilityEnabled,
    providesToOthers,
    loading,
    saving,
    error,
    hasWechatIdentity,
    canSave,
    quotaRevision,
    persistCapability,
  }
}

function CommercialMechanismCard({
  icon,
  title,
  body,
}: {
  icon: ReactNode
  title: string
  body: string
}) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-background/80 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          {icon}
        </span>
        <span className="min-w-0 truncate">{title}</span>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">{body}</p>
    </div>
  )
}

function CapabilityStatusFeedback({
  loading,
  saving,
  error,
  loadingLabel,
  savingLabel,
  className,
}: {
  loading: boolean
  saving: boolean
  error: string | null
  loadingLabel: string
  savingLabel: string
  className?: string
}) {
  return (
    <>
      {loading || saving ? (
        <p
          className={`flex items-center gap-2 px-1 text-xs text-muted-foreground ${
            className ?? ""
          }`}
        >
          <Loader2Icon className="size-3 animate-spin" />
          {saving ? savingLabel : loadingLabel}
        </p>
      ) : null}
      {error ? (
        <p
          className={`rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive ${
            className ?? ""
          }`}
        >
          {error}
        </p>
      ) : null}
    </>
  )
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
}
