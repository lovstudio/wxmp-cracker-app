import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2Icon,
  CopyIcon,
  ExternalLinkIcon,
  GitForkIcon,
  Loader2Icon,
  LogOutIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
} from "lucide-react"
import { openUrl } from "@tauri-apps/plugin-opener"
import {
  api,
  onGithubSyncProgress,
  type GhOauthStatus,
  type GhRepoBrief,
  type GhSyncProgress,
  type GhSyncSettings,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { copyableToast as toast } from "@/lib/toast"

export function GithubSyncSettings() {
  const [statusLoading, setStatusLoading] = useState(true)
  const [status, setStatus] = useState<GhOauthStatus>({
    logged_in: false,
    login: null,
    avatar_url: null,
  })
  const [settings, setSettings] = useState<GhSyncSettings | null>(null)
  const [repos, setRepos] = useState<GhRepoBrief[]>([])
  const [reposLoading, setReposLoading] = useState(false)
  const [newRepoName, setNewRepoName] = useState("wxmp-archive")
  const [newRepoPrivate, setNewRepoPrivate] = useState(true)
  const [creatingRepo, setCreatingRepo] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [progress, setProgress] = useState<GhSyncProgress | null>(null)
  const [device, setDevice] = useState<{
    user_code: string
    verification_uri: string
    device_code: string
    interval: number
    expires_at: number
  } | null>(null)
  const [deviceError, setDeviceError] = useState<string | null>(null)
  const pollTimer = useRef<number | null>(null)

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true)
    try {
      const [s, conf] = await Promise.all([
        api.githubOauthStatus(),
        api.githubSyncSettingsGet(),
      ])
      setStatus(s)
      setSettings(conf)
    } catch (e) {
      toast.error(`读取 GitHub 状态失败: ${String(e)}`)
    } finally {
      setStatusLoading(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // listen for sync progress events
  useEffect(() => {
    const off = onGithubSyncProgress((p) => {
      setProgress(p)
      if (p.stage === "done") {
        setSyncing(false)
      }
    })
    return () => {
      void off.then((fn) => fn())
    }
  }, [])

  useEffect(() => {
    return () => {
      if (pollTimer.current) window.clearInterval(pollTimer.current)
    }
  }, [])

  // ---- repo list -----------------------------------------------------------
  const loadRepos = useCallback(async () => {
    if (!status.logged_in) return
    setReposLoading(true)
    try {
      const items = await api.githubListRepos()
      setRepos(items)
    } catch (e) {
      toast.error(`拉取仓库列表失败: ${String(e)}`)
    } finally {
      setReposLoading(false)
    }
  }, [status.logged_in])

  useEffect(() => {
    if (status.logged_in) void loadRepos()
  }, [status.logged_in, loadRepos])

  // ---- OAuth device flow ---------------------------------------------------
  const startLogin = useCallback(async () => {
    setDeviceError(null)
    try {
      const dc = await api.githubOauthStart()
      setDevice({
        user_code: dc.user_code,
        verification_uri: dc.verification_uri,
        device_code: dc.device_code,
        interval: dc.interval,
        expires_at: Date.now() + dc.expires_in * 1000,
      })
      // start polling
      if (pollTimer.current) window.clearInterval(pollTimer.current)
      pollTimer.current = window.setInterval(async () => {
        try {
          const outcome = await api.githubOauthPoll(dc.device_code)
          if (outcome.kind === "authorized") {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            pollTimer.current = null
            setDevice(null)
            toast.success(`GitHub 登录成功: ${outcome.login}`)
            await refreshStatus()
          } else if (outcome.kind === "denied") {
            if (pollTimer.current) window.clearInterval(pollTimer.current)
            pollTimer.current = null
            setDeviceError(outcome.message)
          }
          // pending: keep polling
        } catch (e) {
          setDeviceError(String(e))
          if (pollTimer.current) window.clearInterval(pollTimer.current)
          pollTimer.current = null
        }
      }, Math.max(dc.interval, 3) * 1000)
    } catch (e) {
      toast.error(`发起 GitHub 登录失败: ${String(e)}`)
    }
  }, [refreshStatus])

  const cancelDeviceFlow = () => {
    if (pollTimer.current) window.clearInterval(pollTimer.current)
    pollTimer.current = null
    setDevice(null)
  }

  const logout = async () => {
    try {
      await api.githubOauthLogout()
      setStatus({ logged_in: false, login: null, avatar_url: null })
      setRepos([])
      toast.success("已断开 GitHub 连接")
    } catch (e) {
      toast.error(`断开失败: ${String(e)}`)
    }
  }

  // ---- repo selection + create --------------------------------------------
  const updateSettings = async (patch: Partial<GhSyncSettings>) => {
    if (!settings) return
    const next = { ...settings, ...patch }
    setSettings(next)
    try {
      await api.githubSyncSettingsSet(next)
    } catch (e) {
      toast.error(`保存设置失败: ${String(e)}`)
      void refreshStatus()
    }
  }

  const createRepo = async () => {
    const name = newRepoName.trim()
    if (!name) {
      toast.error("仓库名不能为空")
      return
    }
    setCreatingRepo(true)
    try {
      const repo = await api.githubCreateRepo(name, newRepoPrivate)
      toast.success(`仓库已创建: ${repo.full_name}`)
      await loadRepos()
      await updateSettings({
        repo_full_name: repo.full_name,
        branch: repo.default_branch,
      })
    } catch (e) {
      toast.error(`创建仓库失败: ${String(e)}`)
    } finally {
      setCreatingRepo(false)
    }
  }

  // ---- sync --------------------------------------------------------------
  const runSync = async () => {
    if (!settings?.repo_full_name) {
      toast.error("请先选择或创建归档仓库")
      return
    }
    setSyncing(true)
    setProgress(null)
    try {
      const summary = await api.githubSyncArticles({})
      const msg =
        summary.pushed > 0
          ? `已推送 ${summary.pushed} 篇文章 (${summary.skipped} 已跳过)`
          : "无新增内容,已是最新"
      toast.success(msg)
      if (summary.repo_html_url) {
        toast.success(`查看仓库: ${summary.repo_html_url}`)
      }
      await refreshStatus()
    } catch (e) {
      toast.error(`同步失败: ${String(e)}`)
    } finally {
      setSyncing(false)
    }
  }

  // ---- render -----------------------------------------------------------
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header className="space-y-1">
        <h2 className="font-serif text-2xl text-foreground">GitHub 归档</h2>
        <p className="text-sm text-muted-foreground">
          把抓取到的公众号文章自动同步到你自己的 GitHub 仓库,作为永久归档,并支持
          GitHub Actions 生成静态站点。
        </p>
      </header>

      {/* Account section */}
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
          <GitForkIcon className="size-4" />
          GitHub 账号
        </div>
        {statusLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2Icon className="size-3.5 animate-spin" />
            正在读取登录状态…
          </div>
        ) : status.logged_in ? (
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {status.avatar_url ? (
                <img
                  src={status.avatar_url}
                  alt={status.login ?? "avatar"}
                  className="size-10 rounded-full border border-border"
                />
              ) : null}
              <div>
                <div className="text-sm font-medium">{status.login}</div>
                <div className="text-xs text-muted-foreground">已连接</div>
              </div>
            </div>
            <Button variant="outline" size="sm" onClick={logout}>
              <LogOutIcon className="size-3.5" />
              断开连接
            </Button>
          </div>
        ) : (
          <Button onClick={startLogin}>
            <GitForkIcon className="size-4" />
            用 GitHub 登录
          </Button>
        )}
      </section>

      {/* Repo section */}
      {status.logged_in && settings ? (
        <>
          <section className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-foreground">归档仓库</div>
              <Button
                variant="outline"
                size="sm"
                onClick={loadRepos}
                disabled={reposLoading}
              >
                <RefreshCwIcon
                  className={
                    "size-3.5" + (reposLoading ? " animate-spin" : "")
                  }
                />
                刷新列表
              </Button>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">选择已有仓库</Label>
              <Select
                value={settings.repo_full_name ?? ""}
                onValueChange={(v) =>
                  updateSettings({
                    repo_full_name: v,
                    branch:
                      repos.find((r) => r.full_name === v)?.default_branch ??
                      settings.branch,
                  })
                }
                disabled={reposLoading || repos.length === 0}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="未选择仓库" />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((r) => (
                    <SelectItem key={r.full_name} value={r.full_name}>
                      {r.full_name}
                      {r.private ? " · 私有" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {settings.repo_full_name ? (
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                  onClick={() =>
                    openUrl(`https://github.com/${settings.repo_full_name}`)
                  }
                >
                  <ExternalLinkIcon className="size-3" />
                  在 GitHub 中打开
                </button>
              ) : null}
            </div>

            <div className="border-t border-border/60 pt-4 space-y-2">
              <Label className="text-xs text-muted-foreground">
                或新建一个归档仓库
              </Label>
              <div className="flex gap-2">
                <Input
                  value={newRepoName}
                  onChange={(e) => setNewRepoName(e.target.value)}
                  placeholder="wxmp-archive"
                  className="flex-1"
                />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={createRepo}
                  disabled={creatingRepo}
                >
                  {creatingRepo ? (
                    <Loader2Icon className="size-3.5 animate-spin" />
                  ) : (
                    <PlusIcon className="size-3.5" />
                  )}
                  新建
                </Button>
              </div>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Switch
                  checked={newRepoPrivate}
                  onCheckedChange={setNewRepoPrivate}
                />
                <span>设为私有仓库</span>
              </div>
            </div>
          </section>

          {/* Sync options */}
          <section className="rounded-xl border border-border bg-card p-5 space-y-4">
            <div className="text-sm font-medium text-foreground">同步选项</div>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-sm">同步图片到归档</Label>
                <div className="text-xs text-muted-foreground">
                  下载微信 CDN 图片到仓库 assets/ 目录,避免链接过期。
                </div>
              </div>
              <Switch
                checked={settings.sync_images}
                onCheckedChange={(v) => updateSettings({ sync_images: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <Label className="text-sm">抓取完成自动推送</Label>
                <div className="text-xs text-muted-foreground">
                  每次抓取任务结束后自动增量同步到 GitHub。
                </div>
              </div>
              <Switch
                checked={settings.auto_push}
                onCheckedChange={(v) => updateSettings({ auto_push: v })}
              />
            </div>
          </section>

          {/* Sync action */}
          <section className="rounded-xl border border-border bg-card p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-foreground">
                  立即同步
                </div>
                <div className="text-xs text-muted-foreground">
                  扫描本地所有有正文的文章,推送增量到 GitHub 仓库。
                </div>
              </div>
              <Button
                onClick={runSync}
                disabled={syncing || !settings.repo_full_name}
              >
                {syncing ? (
                  <Loader2Icon className="size-3.5 animate-spin" />
                ) : (
                  <PlayIcon className="size-3.5" />
                )}
                {syncing ? "同步中…" : "全量同步"}
              </Button>
            </div>
            {progress ? <ProgressLine progress={progress} /> : null}
            {settings.last_synced_at ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <CheckCircle2Icon className="size-3.5 text-primary" />
                上次成功同步:{" "}
                {new Date(settings.last_synced_at * 1000).toLocaleString()}
              </div>
            ) : null}
            {settings.last_error ? (
              <div className="text-xs text-destructive">
                上次同步出错: {settings.last_error}
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      <Dialog
        open={!!device}
        onOpenChange={(o) => {
          if (!o) cancelDeviceFlow()
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>在 GitHub 上完成授权</DialogTitle>
            <DialogDescription>
              请打开下方链接,在 GitHub 页面输入授权码,完成后回到这里。
            </DialogDescription>
          </DialogHeader>
          {device ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">授权码</div>
                <div className="flex items-center gap-2">
                  <div className="font-mono text-2xl tracking-widest rounded-lg border border-border bg-muted px-4 py-2">
                    {device.user_code}
                  </div>
                  <Button
                    size="icon-sm"
                    variant="outline"
                    onClick={() => {
                      navigator.clipboard.writeText(device.user_code)
                      toast.success("已复制授权码")
                    }}
                  >
                    <CopyIcon className="size-3.5" />
                  </Button>
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => openUrl(device.verification_uri)}
              >
                <ExternalLinkIcon className="size-3.5" />
                打开 GitHub 授权页
              </Button>
              {deviceError ? (
                <div className="text-xs text-destructive">{deviceError}</div>
              ) : (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2Icon className="size-3.5 animate-spin" />
                  正在等待你在 GitHub 上完成授权…
                </div>
              )}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={cancelDeviceFlow}>
              取消
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ProgressLine({ progress }: { progress: GhSyncProgress }) {
  let text = ""
  switch (progress.stage) {
    case "start":
      text = `共 ${progress.total_candidates} 篇候选`
      break
    case "prepare":
      text = progress.message
      break
    case "render":
      text = `渲染中 ${progress.current}/${progress.total} · ${progress.title}`
      break
    case "image":
      text = `下载图片 ${progress.current}/${progress.total}`
      break
    case "commit":
      text = `提交 ${progress.changed} 个变更`
      break
    case "push":
      text = progress.message
      break
    case "done":
      text = progress.message
      break
  }
  return (
    <div className="text-xs text-muted-foreground border-l-2 border-primary/40 pl-3">
      {text}
    </div>
  )
}
