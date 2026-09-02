import { useCallback, useEffect, useMemo, useState } from "react"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  BookOpenIcon,
  CheckCircle2Icon,
  ExternalLinkIcon,
  KeyRoundIcon,
  Loader2Icon,
  PlayIcon,
  RefreshCwIcon,
  SaveIcon,
  UnplugIcon,
} from "lucide-react"
import {
  api,
  onFeishuSyncProgress,
  type Account,
  type FeishuSettings,
  type FeishuSettingsInput,
  type FeishuSpaceBrief,
  type FeishuSyncProgress,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { copyableToast as toast } from "@/lib/toast"
import { isTauri } from "@/lib/tauri"

const FEISHU_DEVELOPER_URL = "https://open.feishu.cn/app"

interface Props {
  accounts: Account[]
}

export function IntegrationSettings({ accounts }: Props) {
  const [settings, setSettings] = useState<FeishuSettings | null>(null)
  const [draft, setDraft] = useState<FeishuSettingsInput | null>(null)
  const [loading, setLoading] = useState(true)
  const [appId, setAppId] = useState("")
  const [appSecret, setAppSecret] = useState("")
  const [credentialsBusy, setCredentialsBusy] = useState(false)
  const [editingCredentials, setEditingCredentials] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [spaces, setSpaces] = useState<FeishuSpaceBrief[]>([])
  const [spacesLoading, setSpacesLoading] = useState(false)
  const [wikiTargetInput, setWikiTargetInput] = useState("")
  const [targetLoading, setTargetLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<FeishuSyncProgress | null>(null)

  const applySettings = useCallback((next: FeishuSettings) => {
    setSettings(next)
    setDraft(settingsToInput(next))
    setAppId(next.app_id ?? "")
  }, [])

  const refreshSettings = useCallback(async () => {
    setLoading(true)
    try {
      if (!isTauri()) {
        applySettings(browserPreviewSettings())
        return
      }
      applySettings(await api.feishuSettingsGet())
    } catch (error) {
      toast.error(`读取飞书集成失败：${errorMessage(error)}`)
    } finally {
      setLoading(false)
    }
  }, [applySettings])

  const loadSpaces = useCallback(async () => {
    setSpacesLoading(true)
    try {
      const nextSpaces = await api.feishuListSpaces()
      setSpaces(nextSpaces)
      if (nextSpaces.length === 0) {
        toast.info("应用当前看不到知识库，请先把应用添加为知识库成员")
      }
    } catch (error) {
      toast.error(`读取知识库失败：${errorMessage(error)}`)
    } finally {
      setSpacesLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshSettings()
  }, [refreshSettings])

  useEffect(() => {
    if (settings?.has_app_secret) void loadSpaces()
  }, [settings?.has_app_secret, loadSpaces])

  useEffect(() => {
    if (!isTauri()) return
    const unlisten = onFeishuSyncProgress((nextProgress) => {
      setProgress(nextProgress)
      if (nextProgress.stage === "done") setSyncing(false)
    })
    return () => {
      void unlisten.then((stop) => stop())
    }
  }, [])

  const selectedAccounts = useMemo(
    () =>
      accounts.filter((account) =>
        draft?.account_fakeids.includes(account.fakeid)
      ),
    [accounts, draft?.account_fakeids]
  )

  const configureCredentials = async () => {
    if (!appId.trim() || !appSecret.trim()) {
      toast.error("请输入飞书 App ID 和 App Secret")
      return
    }
    setCredentialsBusy(true)
    try {
      const next = await api.feishuConfigureCredentials(
        appId.trim(),
        appSecret.trim()
      )
      applySettings(next)
      setAppSecret("")
      setEditingCredentials(false)
      toast.success("飞书应用凭证已验证，App Secret 已存入系统钥匙串")
    } catch (error) {
      toast.error(`连接飞书失败：${errorMessage(error)}`)
    } finally {
      setCredentialsBusy(false)
    }
  }

  const saveSettings = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const next = await api.feishuSettingsSet(draft)
      applySettings(next)
      toast.success(next.enabled ? "飞书同步设置已保存" : "飞书同步已停用")
    } catch (error) {
      toast.error(`保存飞书设置失败：${errorMessage(error)}`)
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    setDisconnecting(true)
    try {
      const next = await api.feishuDisconnect()
      applySettings(next)
      setSpaces([])
      setAppSecret("")
      setConfirmDisconnect(false)
      toast.success("已断开飞书，远端知识库中的既有文章不会被删除")
    } catch (error) {
      toast.error(`断开飞书失败：${errorMessage(error)}`)
    } finally {
      setDisconnecting(false)
    }
  }

  const resolveWikiTarget = async () => {
    if (!wikiTargetInput.trim()) {
      toast.error("请输入飞书知识库页面链接或 Wiki Token")
      return
    }
    setTargetLoading(true)
    try {
      const node = await api.feishuResolveWikiTarget(wikiTargetInput.trim())
      if (node.obj_type !== "docx") {
        toast.error("当前只支持把文章写入飞书新版文档页面")
        return
      }
      const space = spaces.find((item) => item.space_id === node.space_id)
      setDraft((current) =>
        current
          ? {
              ...current,
              space_id: node.space_id,
              space_name: space?.name ?? node.space_id,
              parent_node_token: node.node_token,
              parent_node_title: node.title || "指定页面",
            }
          : current
      )
      setWikiTargetInput("")
      toast.success(`已识别目标页面：${node.title || node.node_token}`)
    } catch (error) {
      toast.error(`识别知识库页面失败：${errorMessage(error)}`)
    } finally {
      setTargetLoading(false)
    }
  }

  const runSync = async () => {
    if (!draft?.enabled) {
      toast.error("请先启用并保存飞书同步")
      return
    }
    setSyncing(true)
    setProgress({ stage: "start", total: 0 })
    try {
      const saved = await api.feishuSettingsSet(draft)
      applySettings(saved)
      const summary = await api.feishuSyncArticles()
      const next = await api.feishuSettingsGet()
      applySettings(next)
      if (summary.failed > 0) {
        toast.error(
          `同步完成，但有 ${summary.failed} 篇失败：${summary.last_error ?? "请检查飞书权限"}`
        )
      } else {
        toast.success(
          `飞书同步完成：新增 ${summary.created}，更新 ${summary.updated}，跳过 ${summary.skipped}`
        )
      }
    } catch (error) {
      toast.error(`飞书同步失败：${errorMessage(error)}`)
    } finally {
      setSyncing(false)
    }
  }

  if (loading || !settings || !draft) {
    return (
      <div className="flex min-h-48 items-center justify-center text-sm text-muted-foreground">
        <Loader2Icon className="mr-2 size-4 animate-spin" />
        正在读取集成设置
      </div>
    )
  }

  const connected = Boolean(settings.app_id && settings.has_app_secret)
  const selectedAll =
    accounts.length > 0 && selectedAccounts.length === accounts.length
  const canSync =
    connected &&
    draft.enabled &&
    Boolean(draft.space_id) &&
    draft.account_fakeids.length > 0

  return (
    <div className="grid gap-4">
      <section className="rounded-xl border border-border bg-background/80 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <BookOpenIcon className="size-5" />
            </div>
            <div className="min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <h2 className="truncate font-serif text-base font-semibold text-foreground">
                  飞书知识库
                </h2>
                <span
                  className="auth-status-badge shrink-0"
                  data-state={connected ? "online" : "offline"}
                >
                  {connected ? "已连接" : "未连接"}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                将指定公众号中已采集正文的文章增量写入你授权给应用的知识库。
              </p>
            </div>
          </div>
          {connected ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditingCredentials((value) => !value)}
            >
              <KeyRoundIcon className="size-3.5" />
              更新凭证
            </Button>
          ) : null}
        </div>

        {!connected || editingCredentials ? (
          <div className="mt-4 grid gap-3 rounded-lg border border-border bg-card p-4">
            <div className="grid gap-1.5">
              <Label htmlFor="feishu-app-id">App ID</Label>
              <Input
                id="feishu-app-id"
                value={appId}
                onChange={(event) => setAppId(event.target.value)}
                placeholder="cli_xxxxxxxxxxxxxxxx"
                autoComplete="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="feishu-app-secret">App Secret</Label>
              <Input
                id="feishu-app-secret"
                type="password"
                value={appSecret}
                onChange={(event) => setAppSecret(event.target.value)}
                placeholder={
                  connected ? "输入新的 App Secret" : "仅保存到 macOS 钥匙串"
                }
                autoComplete="new-password"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-xs leading-5 text-muted-foreground">
                使用你自己的飞书企业自建应用。应用必须已发布，并拥有知识库读取、节点创建及新版文档读写权限。
              </p>
              <div className="flex gap-2">
                {editingCredentials ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setEditingCredentials(false)
                      setAppSecret("")
                      setAppId(settings.app_id ?? "")
                    }}
                  >
                    取消
                  </Button>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  disabled={credentialsBusy}
                  onClick={() => void configureCredentials()}
                >
                  {credentialsBusy ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <CheckCircle2Icon className="size-3.5" />
                  )}
                  验证并连接
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div className="mt-4 rounded-lg bg-muted/55 p-3 text-xs leading-5 text-muted-foreground">
          <div className="font-medium text-foreground">首次连接前</div>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            <li>
              在飞书开放平台创建企业自建应用，并发布包含 Wiki 与 Docx
              权限的版本。
            </li>
            <li>进入目标知识库设置，将该应用添加为可编辑的知识库成员。</li>
            <li>回到这里验证凭证、选择知识库和需要同步的公众号。</li>
          </ol>
          <button
            type="button"
            className="mt-2 inline-flex items-center gap-1 text-primary outline-hidden hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => void openUrl(FEISHU_DEVELOPER_URL)}
          >
            打开飞书开放平台
            <ExternalLinkIcon className="size-3" />
          </button>
        </div>
      </section>

      {connected ? (
        <>
          <section className="rounded-xl border border-border bg-background/80 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-serif text-sm font-semibold text-foreground">
                  同步位置
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  文章会以新版文档子页面写入知识库根目录或指定页面。
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={spacesLoading}
                onClick={() => void loadSpaces()}
              >
                <RefreshCwIcon
                  className={`size-3.5 ${spacesLoading ? "animate-spin" : ""}`}
                />
                刷新
              </Button>
            </div>
            <div className="mt-4 grid gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="feishu-space">知识库</Label>
                <Select
                  value={draft.space_id ?? ""}
                  onValueChange={(spaceId) => {
                    const space = spaces.find(
                      (item) => item.space_id === spaceId
                    )
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            space_id: spaceId,
                            space_name: space?.name ?? null,
                            parent_node_token: null,
                            parent_node_title: null,
                          }
                        : current
                    )
                  }}
                >
                  <SelectTrigger id="feishu-space" className="w-full">
                    <SelectValue placeholder="选择已授权给应用的知识库" />
                  </SelectTrigger>
                  <SelectContent>
                    {spaces.map((space) => (
                      <SelectItem key={space.space_id} value={space.space_id}>
                        {space.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="feishu-parent-page">指定父页面（可选）</Label>
                <div className="flex gap-2">
                  <Input
                    id="feishu-parent-page"
                    value={wikiTargetInput}
                    onChange={(event) => setWikiTargetInput(event.target.value)}
                    placeholder="粘贴 https://xxx.feishu.cn/wiki/..."
                  />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={targetLoading}
                    onClick={() => void resolveWikiTarget()}
                  >
                    {targetLoading ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : null}
                    识别
                  </Button>
                </div>
              </div>
              {draft.parent_node_token ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs text-foreground">
                  <span>
                    写入页面：
                    {draft.parent_node_title || draft.parent_node_token}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setDraft((current) =>
                        current
                          ? {
                              ...current,
                              parent_node_token: null,
                              parent_node_title: null,
                            }
                          : current
                      )
                    }
                  >
                    改为根目录
                  </Button>
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-background/80 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-serif text-sm font-semibold text-foreground">
                  同步公众号
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  只有这里勾选的公众号会进入飞书知识库。
                </p>
              </div>
              {accounts.length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            account_fakeids: selectedAll
                              ? []
                              : accounts.map((account) => account.fakeid),
                          }
                        : current
                    )
                  }
                >
                  {selectedAll ? "取消全选" : "全选"}
                </Button>
              ) : null}
            </div>
            <div className="mt-4 grid gap-2">
              {accounts.length === 0 ? (
                <div className="rounded-lg bg-muted/55 px-3 py-4 text-center text-xs text-muted-foreground">
                  尚未采集公众号，请先添加公众号后再配置同步范围。
                </div>
              ) : (
                accounts.map((account) => {
                  const checked = draft.account_fakeids.includes(account.fakeid)
                  return (
                    <label
                      key={account.fakeid}
                      className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(value) =>
                          setDraft((current) => {
                            if (!current) return current
                            const next = new Set(current.account_fakeids)
                            if (value === true) next.add(account.fakeid)
                            else next.delete(account.fakeid)
                            return {
                              ...current,
                              account_fakeids: [...next],
                            }
                          })
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {account.nickname}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          已采集 {account.article_count} 篇
                        </span>
                      </span>
                    </label>
                  )
                })
              )}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-background/80 p-4">
            <h3 className="font-serif text-sm font-semibold text-foreground">
              同步规则
            </h3>
            <div className="mt-4 grid gap-4">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="feishu-enabled">启用飞书同步</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    允许手动同步；关闭不会删除飞书中的既有文档。
                  </p>
                </div>
                <Switch
                  id="feishu-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(enabled) =>
                    setDraft((current) =>
                      current ? { ...current, enabled } : current
                    )
                  }
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Label htmlFor="feishu-auto-sync">采集完成后自动同步</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    新增文章或补齐正文后，仅同步发生变化的文章。
                  </p>
                </div>
                <Switch
                  id="feishu-auto-sync"
                  checked={draft.auto_sync}
                  disabled={!draft.enabled}
                  onCheckedChange={(autoSync) =>
                    setDraft((current) =>
                      current ? { ...current, auto_sync: autoSync } : current
                    )
                  }
                />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <div className="text-xs text-muted-foreground">
                  已记录 {settings.synced_article_count} 篇
                  {settings.last_synced_at
                    ? ` · 上次同步 ${formatTime(settings.last_synced_at)}`
                    : " · 尚未同步"}
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={saving}
                    onClick={() => void saveSettings()}
                  >
                    {saving ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <SaveIcon className="size-3.5" />
                    )}
                    保存设置
                  </Button>
                  <Button
                    type="button"
                    disabled={!canSync || syncing}
                    onClick={() => void runSync()}
                  >
                    {syncing ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <PlayIcon className="size-3.5" />
                    )}
                    {syncing ? progressLabel(progress) : "立即同步"}
                  </Button>
                </div>
              </div>
              {settings.last_error ? (
                <div className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-xs leading-5 text-destructive">
                  {settings.last_error}
                </div>
              ) : null}
            </div>
          </section>

          <section className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-destructive">
                  断开飞书
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  移除本机凭证和同步记录，不会删除飞书中的既有文档。
                </p>
              </div>
              {confirmDisconnect ? (
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmDisconnect(false)}
                  >
                    取消
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={disconnecting}
                    onClick={() => void disconnect()}
                  >
                    {disconnecting ? (
                      <Loader2Icon className="size-3.5 animate-spin" />
                    ) : (
                      <UnplugIcon className="size-3.5" />
                    )}
                    确认断开
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  onClick={() => setConfirmDisconnect(true)}
                >
                  <UnplugIcon className="size-3.5" />
                  断开连接
                </Button>
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  )
}

function settingsToInput(settings: FeishuSettings): FeishuSettingsInput {
  return {
    enabled: settings.enabled,
    auto_sync: settings.auto_sync,
    space_id: settings.space_id,
    space_name: settings.space_name,
    parent_node_token: settings.parent_node_token,
    parent_node_title: settings.parent_node_title,
    account_fakeids: settings.account_fakeids,
  }
}

function browserPreviewSettings(): FeishuSettings {
  return {
    app_id: null,
    has_app_secret: false,
    enabled: false,
    auto_sync: false,
    space_id: null,
    space_name: null,
    parent_node_token: null,
    parent_node_title: null,
    account_fakeids: [],
    last_synced_at: null,
    last_error: null,
    synced_article_count: 0,
  }
}

function progressLabel(progress: FeishuSyncProgress | null) {
  if (progress?.stage === "article") {
    return `${progress.current}/${progress.total}`
  }
  return "同步中…"
}

function formatTime(timestamp: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp * 1000))
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }
  return String(error)
}
