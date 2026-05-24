import { useCallback, useEffect, useState, type CSSProperties } from "react"
import { AccountSidebar } from "@/components/account-sidebar"
import { AccountWorkspace } from "@/components/account-workspace"
import { ArticleList } from "@/components/article-list"
import { ArticleDetail as ArticleDetailView } from "@/components/article-detail"
import { TopBar, type WorkspaceTabId } from "@/components/top-bar"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { LovstudioAuthDialog } from "@/components/lovstudio-auth-dialog"
import { LicenseAdminDialog } from "@/components/license-admin-panel"
import { LicenseGate } from "@/components/license-gate"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { AuthProvider, useAuth } from "@/hooks/useAuth"
import { useAutoUpdate } from "@/hooks/useAutoUpdate"
import { useWxmpGatewayWorker } from "@/hooks/useWxmpGatewayWorker"
import {
  api,
  onFetchAccountProgress,
  onLoginError,
  onLoginSuccess,
  type Account,
  type AccountSearchResult,
  type FetchAccountProgress,
  type LicenseStatus,
  type LoginAccount,
} from "@/lib/api"
import { isTauri } from "@/lib/tauri"
import { copyableToast as toast } from "@/lib/toast"

const ACCOUNT_ORDER_STORAGE_KEY = "wxmp.accountOrder"
const ARCHIVED_ACCOUNTS_STORAGE_KEY = "wxmp.archivedAccounts"
const PINNED_ACCOUNTS_STORAGE_KEY = "wxmp.pinnedAccounts"
const MAX_FETCH_PROGRESS_EVENTS = 36

export default function App() {
  return (
    <TooltipProvider>
      <AuthProvider>
        <WorkspaceApp />
      </AuthProvider>
      <Toaster />
    </TooltipProvider>
  )
}

type PendingFetch = {
  account: AccountSearchResult
  limit: number
  withContent: boolean
}

function WorkspaceApp() {
  const {
    isLoading: lovstudioAuthLoading,
    profile,
    signOut: signOutLovstudio,
    user,
  } = useAuth()
  const [accounts, setAccounts] = useState<Account[]>([])
  const [accountOrder, setAccountOrder] = useState<string[]>(() =>
    readStringList(ACCOUNT_ORDER_STORAGE_KEY)
  )
  const [archivedFakeids, setArchivedFakeids] = useState<string[]>(() =>
    readStringList(ARCHIVED_ACCOUNTS_STORAGE_KEY)
  )
  const [pinnedFakeids, setPinnedFakeids] = useState<string[]>(() =>
    readStringList(PINNED_ACCOUNTS_STORAGE_KEY)
  )
  const [activeFakeid, setActiveFakeid] = useState<string | null>(null)
  const [activeAid, setActiveAid] = useState<string | null>(null)
  const [loggedIn, setLoggedIn] = useState(false)
  const [authAccount, setAuthAccount] = useState<LoginAccount | null>(null)
  const [lastLoginAt, setLastLoginAt] = useState<number | null>(null)
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const [lovstudioAuthOpen, setLovstudioAuthOpen] = useState(false)
  const [addingAccount, setAddingAccount] = useState(false)
  const [licenseOpen, setLicenseOpen] = useState(false)
  const [licenseAdminOpen, setLicenseAdminOpen] = useState(false)
  const [licenseStatus, setLicenseStatus] = useState<LicenseStatus | null>(null)
  const [pendingFetch, setPendingFetch] = useState<PendingFetch | null>(null)
  const [fetchProgressEvents, setFetchProgressEvents] = useState<
    FetchAccountProgress[]
  >([])
  const [articleRefreshKey, setArticleRefreshKey] = useState(0)
  const [activeTab, setActiveTab] = useState<WorkspaceTabId>("reader")
  const orderedAccounts = orderAccounts(accounts, accountOrder)
  const archivedFakeidSet = new Set(archivedFakeids)
  const unarchivedAccounts = orderedAccounts.filter(
    (account) => !archivedFakeidSet.has(account.fakeid)
  )
  const activeAccounts = groupPinnedAccounts(unarchivedAccounts, pinnedFakeids)
  const archivedAccounts = orderedAccounts.filter((account) =>
    archivedFakeidSet.has(account.fakeid)
  )
  const selectedFakeid =
    activeFakeid &&
    activeAccounts.some((account) => account.fakeid === activeFakeid)
      ? activeFakeid
      : (activeAccounts[0]?.fakeid ?? null)
  const activeAccount =
    activeAccounts.find((account) => account.fakeid === selectedFakeid) ?? null
  const lovstudioAccountId = user?.id ?? null
  const lovstudioDisplayName =
    profile?.display_name ??
    authUserMetadataString(user, [
      "display_name",
      "full_name",
      "name",
      "preferred_username",
    ])
  const lovstudioEmail =
    profile?.email ?? user?.email ?? authUserMetadataString(user, ["email"])
  const lovstudioAvatarUrl =
    profile?.avatar_url ??
    authUserMetadataString(user, ["avatar_url", "picture"])

  const refreshAccounts = useCallback(async () => {
    try {
      const list = await api.listAccounts()
      setAccounts(list)
    } catch (e) {
      if (isTauri()) {
        toast.error(`读取缓存失败: ${e}`)
      }
    }
  }, [])

  const refreshAuth = useCallback(async () => {
    try {
      const s = await api.authStatus()
      setLoggedIn(s.logged_in)
      setAuthAccount(s.account)
      setLastLoginAt(s.last_login_at)
    } catch {
      setLoggedIn(false)
      setAuthAccount(null)
      setLastLoginAt(null)
    }
  }, [])

  const refreshLicenseStatus = useCallback(async () => {
    if (!isTauri()) {
      setLicenseStatus(browserPreviewLicenseStatus())
      return browserPreviewLicenseStatus()
    }

    try {
      const localStatus = await api.licenseStatus(lovstudioAccountId)
      const status = await syncRemoteLicenseIfNeeded(
        localStatus,
        lovstudioAccountId
      )
      setLicenseStatus(status)
      return status
    } catch (error) {
      const status = licenseErrorStatus(errorMessage(error))
      setLicenseStatus(status)
      return status
    }
  }, [lovstudioAccountId])

  const refreshAfterGatewayRequest = useCallback(async () => {
    await refreshAccounts()
    setArticleRefreshKey((key) => key + 1)
  }, [refreshAccounts])

  useAutoUpdate()

  useWxmpGatewayWorker({
    enabled: Boolean(user && loggedIn),
    onRequestFinished: refreshAfterGatewayRequest,
  })

  useEffect(() => {
    const initialRefreshTimer = window.setTimeout(() => {
      void refreshAccounts()
      void refreshAuth()
      void refreshLicenseStatus()
    }, 0)
    const ok = onLoginSuccess(() => {
      toast.success("登录成功，已保存凭证")
      refreshAuth()
      refreshLicenseStatus()
    })
    const err = onLoginError((m) => {
      toast.error(`登录失败: ${m}`)
    })
    const progress = onFetchAccountProgress((event) => {
      setFetchProgressEvents((currentEvents) =>
        [...currentEvents, event].slice(-MAX_FETCH_PROGRESS_EVENTS)
      )
    })
    return () => {
      window.clearTimeout(initialRefreshTimer)
      ok.then((un) => un())
      err.then((un) => un())
      progress.then((un) => un())
    }
  }, [refreshAccounts, refreshAuth, refreshLicenseStatus])

  useEffect(() => {
    if (lovstudioAuthLoading) {
      return
    }

    void refreshLicenseStatus()
  }, [lovstudioAuthLoading, refreshLicenseStatus])

  useEffect(() => {
    writeStringList(ACCOUNT_ORDER_STORAGE_KEY, accountOrder)
  }, [accountOrder])

  useEffect(() => {
    writeStringList(ARCHIVED_ACCOUNTS_STORAGE_KEY, archivedFakeids)
  }, [archivedFakeids])

  useEffect(() => {
    writeStringList(PINNED_ACCOUNTS_STORAGE_KEY, pinnedFakeids)
  }, [pinnedFakeids])

  const openAddAccount = () => {
    if (!lovstudioAccountId) {
      toast.error("请先登录 Lovstudio 账号")
      setLovstudioAuthOpen(true)
      return
    }

    if (!loggedIn) {
      toast.wxmpError("请先扫码登录微信公众号", api.openLogin)
      api.openLogin().catch((e) =>
        toast.wxmpError(errorMessage(e), api.openLogin)
      )
      return
    }
    setFetchProgressEvents([])
    setAddAccountOpen(true)
  }

  const addAccount = async (
    account: AccountSearchResult,
    limit: number,
    withContent: boolean
  ) => {
    if (needsLicenseForFetch(accounts, account)) {
      const allowed = await hasActiveLicense()
      if (!allowed) {
        setPendingFetch({ account, limit, withContent })
        setLicenseOpen(true)
        return
      }
    }

    await fetchSelectedAccount(account, limit, withContent)
  }

  const hasActiveLicense = async () => {
    const status = await refreshLicenseStatus()
    return status.active
  }

  const fetchSelectedAccount = async (
    account: AccountSearchResult,
    limit: number,
    withContent: boolean
  ) => {
    setAddingAccount(true)
    setFetchProgressEvents([initialFetchProgress(account, limit, withContent)])
    try {
      await api.fetchSelectedAccount(account, limit, withContent)
      const list = await api.listAccounts()
      setAccounts(list)

      const added = list.find((item) => item.fakeid === account.fakeid)

      if (added) {
        setAccountOrder((currentOrder) =>
          moveAccountOrderItemToFront(currentOrder, list, added.fakeid)
        )
        setActiveFakeid(added.fakeid)
        setActiveAid(null)
      }

      toast.success(`已新增 ${added?.nickname ?? account.nickname}`)
      setAddAccountOpen(false)
      setFetchProgressEvents([])
    } catch (e) {
      const message = errorMessage(e)
      setFetchProgressEvents((currentEvents) =>
        [
          ...currentEvents,
          {
            fakeid: account.fakeid,
            nickname: account.nickname,
            stage: "error",
            status: "error",
            message,
            current: null,
            total: null,
            title: null,
          },
        ].slice(-MAX_FETCH_PROGRESS_EVENTS)
      )
      toast.wxmpError(message, api.openLogin)
    } finally {
      setAddingAccount(false)
    }
  }

  const continuePendingFetch = (status: LicenseStatus) => {
    setLicenseStatus(status)
    const nextFetch = pendingFetch
    setPendingFetch(null)
    setLicenseOpen(false)

    if (nextFetch) {
      void fetchSelectedAccount(
        nextFetch.account,
        nextFetch.limit,
        nextFetch.withContent
      )
    }
  }

  const preserveCurrentSelection = () => {
    if (!activeFakeid && selectedFakeid) {
      setActiveFakeid(selectedFakeid)
    }
  }

  const reorderAccount = (activeId: string, overId: string) => {
    preserveCurrentSelection()
    setAccountOrder((currentOrder) => {
      const nextOrder = mergeAccountOrder(currentOrder, accounts)
      const oldIndex = nextOrder.indexOf(activeId)
      const newIndex = nextOrder.indexOf(overId)

      if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) {
        return currentOrder
      }

      return moveStringItem(nextOrder, oldIndex, newIndex)
    })
  }

  const moveAccountToTop = (fakeid: string) => {
    preserveCurrentSelection()
    setAccountOrder((currentOrder) => {
      const nextOrder = mergeAccountOrder(currentOrder, accounts)
      const oldIndex = nextOrder.indexOf(fakeid)
      if (oldIndex <= 0) return currentOrder
      return moveStringItem(nextOrder, oldIndex, 0)
    })
  }

  const moveAccountToBottom = (fakeid: string) => {
    preserveCurrentSelection()
    setAccountOrder((currentOrder) => {
      const nextOrder = mergeAccountOrder(currentOrder, accounts)
      const oldIndex = nextOrder.indexOf(fakeid)
      const newIndex = nextOrder.length - 1
      if (oldIndex < 0 || oldIndex === newIndex) return currentOrder
      return moveStringItem(nextOrder, oldIndex, newIndex)
    })
  }

  const pinAccount = (fakeid: string) => {
    const account = accounts.find((a) => a.fakeid === fakeid)
    preserveCurrentSelection()
    setPinnedFakeids((currentPinned) =>
      currentPinned.includes(fakeid)
        ? currentPinned
        : [...currentPinned, fakeid]
    )
    toast.success(`已固定 ${account?.nickname ?? "公众号"}`)
  }

  const unpinAccount = (fakeid: string) => {
    const account = accounts.find((a) => a.fakeid === fakeid)
    preserveCurrentSelection()
    setPinnedFakeids((currentPinned) =>
      currentPinned.filter((id) => id !== fakeid)
    )
    toast.info(`已取消固定 ${account?.nickname ?? "公众号"}`)
  }

  const archiveAccount = (fakeid: string) => {
    const account = accounts.find((a) => a.fakeid === fakeid)
    setArchivedFakeids((currentArchived) =>
      currentArchived.includes(fakeid)
        ? currentArchived
        : [...currentArchived, fakeid]
    )

    if (selectedFakeid === fakeid) {
      const fallback =
        activeAccounts.find((a) => a.fakeid !== fakeid)?.fakeid ?? null
      setActiveFakeid(fallback)
      setActiveAid(null)
    }

    toast.info(`已归档 ${account?.nickname ?? "公众号"}`)
  }

  const restoreAccount = (fakeid: string) => {
    const account = accounts.find((a) => a.fakeid === fakeid)
    setArchivedFakeids((currentArchived) =>
      currentArchived.filter((id) => id !== fakeid)
    )
    toast.success(`已恢复 ${account?.nickname ?? "公众号"}`)
  }

  return (
    <>
      <div className="app-shell">
        <SidebarProvider
          className="h-full min-h-0 overflow-hidden"
          style={
            {
              "--sidebar-width": "calc(var(--spacing) * 80)",
              "--header-height": "calc(var(--spacing) * 14)",
            } as CSSProperties
          }
        >
          <AccountSidebar
            accounts={activeAccounts}
            archivedAccounts={archivedAccounts}
            pinnedFakeids={pinnedFakeids}
            activeFakeid={selectedFakeid}
            lovstudioDisplayName={lovstudioDisplayName}
            lovstudioEmail={lovstudioEmail}
            lovstudioAvatarUrl={lovstudioAvatarUrl}
            lovstudioUserId={lovstudioAccountId}
            loggedIn={loggedIn}
            authAccount={authAccount}
            lastLoginAt={lastLoginAt}
            onAddAccount={openAddAccount}
            onLovstudioLogin={() => setLovstudioAuthOpen(true)}
            onLovstudioLogout={() => void signOutLovstudio()}
            onLogin={() => {
              api.openLogin().catch((e) =>
                toast.wxmpError(errorMessage(e), api.openLogin)
              )
            }}
            onSelect={(id) => {
              setActiveFakeid(id)
              setActiveAid(null)
            }}
            onReorder={reorderAccount}
            onArchive={archiveAccount}
            onRestore={restoreAccount}
            onPin={pinAccount}
            onUnpin={unpinAccount}
            onMoveToTop={moveAccountToTop}
            onMoveToBottom={moveAccountToBottom}
          />
          <SidebarInset className="app-main h-full min-h-0 overflow-hidden">
            <TopBar
              activeTab={activeTab}
              onOpenLicenseAdmin={() => setLicenseAdminOpen(true)}
              onOpenLovstudioLogin={() => setLovstudioAuthOpen(true)}
              onTabChange={setActiveTab}
            />
            <div
              className="workspace-grid flex min-h-0 flex-1 overflow-hidden"
              data-reader-view={
                activeTab === "reader"
                  ? activeAid
                    ? "detail"
                    : "list"
                  : undefined
              }
            >
              {activeTab === "reader" ? (
                <>
                  <ArticleList
                    fakeid={selectedFakeid}
                    activeAid={activeAid}
                    refreshKey={articleRefreshKey}
                    onSelect={setActiveAid}
                    onContentFetched={() => {
                      setArticleRefreshKey((key) => key + 1)
                    }}
                  />
                  <ArticleDetailView
                    aid={activeAid}
                    refreshKey={articleRefreshKey}
                    onBackToList={() => setActiveAid(null)}
                    onContentFetched={() => {
                      setArticleRefreshKey((key) => key + 1)
                    }}
                  />
                </>
              ) : (
                <AccountWorkspace
                  tab={activeTab}
                  account={activeAccount}
                  refreshKey={articleRefreshKey}
                  onContentFetched={() => {
                    setArticleRefreshKey((key) => key + 1)
                  }}
                  onCollectionUpdated={() => {
                    refreshAccounts()
                    setArticleRefreshKey((key) => key + 1)
                  }}
                />
              )}
            </div>
          </SidebarInset>
        </SidebarProvider>
      </div>
      <AddAccountDialog
        open={addAccountOpen}
        busy={addingAccount}
        progressEvents={fetchProgressEvents}
        onOpenChange={(open) => {
          setAddAccountOpen(open)
          if (!open) setFetchProgressEvents([])
        }}
        onSearch={api.searchAccounts}
        onSubmit={addAccount}
      />
      {licenseStatus && !licenseStatus.active ? (
        <ActivationWatermark
          message={licenseStatus.message}
          onActivate={() => setLicenseOpen(true)}
        />
      ) : null}
      <LicenseGate
        accountId={lovstudioAccountId}
        accountLabel={lovstudioEmail ?? lovstudioDisplayName}
        open={licenseOpen}
        onActivated={continuePendingFetch}
        onOpenAuth={() => setLovstudioAuthOpen(true)}
        onOpenChange={(open) => {
          setLicenseOpen(open)
          if (!open) setPendingFetch(null)
        }}
      />
      <LicenseAdminDialog
        defaultTargetAccountId={lovstudioAccountId}
        open={licenseAdminOpen}
        onAuthorized={(license) => {
          if (license.account_id === lovstudioAccountId) {
            void refreshLicenseStatus()
          }
        }}
        onOpenChange={setLicenseAdminOpen}
      />
      <LovstudioAuthDialog
        open={lovstudioAuthOpen}
        onOpenChange={setLovstudioAuthOpen}
      />
    </>
  )
}

function ActivationWatermark({
  message,
  onActivate,
}: {
  message: string
  onActivate: () => void
}) {
  return (
    <button
      type="button"
      className="fixed right-6 bottom-5 z-30 max-w-[280px] text-right text-foreground/45 transition-colors hover:text-foreground/75 focus-visible:text-foreground focus-visible:outline-none"
      title={message}
      onClick={onActivate}
    >
      <span className="block font-heading text-2xl leading-none font-semibold">
        微探未激活
      </span>
      <span className="mt-1 block text-sm">立即激活</span>
    </button>
  )
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

function initialFetchProgress(
  account: AccountSearchResult,
  limit: number,
  withContent: boolean
): FetchAccountProgress {
  return {
    fakeid: account.fakeid,
    nickname: account.nickname,
    stage: "prepare",
    status: "running",
    message: withContent
      ? `准备抓取 ${limit} 篇文章索引，并同步正文`
      : `准备抓取 ${limit} 篇文章索引`,
    current: 0,
    total: limit,
    title: null,
  }
}

function needsLicenseForFetch(
  accounts: Account[],
  account: AccountSearchResult
) {
  const alreadyTracked = accounts.some((item) => item.fakeid === account.fakeid)
  return !alreadyTracked && accounts.length >= 1
}

async function syncRemoteLicenseIfNeeded(
  status: LicenseStatus,
  accountId: string | null
) {
  if (!isTauri() || !accountId) {
    return status
  }

  if (status.active && status.kind === "official") {
    return status
  }

  try {
    return await api.syncRemoteLicense(accountId)
  } catch (error) {
    console.warn("Unable to sync remote license", error)
    return status
  }
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

function licenseErrorStatus(message: string): LicenseStatus {
  return {
    active: false,
    kind: null,
    activated_at: null,
    expires_at: null,
    days_remaining: null,
    customer: null,
    license_id: null,
    account_id: null,
    current_account_id: null,
    message,
  }
}

function authUserMetadataString(
  user: {
    user_metadata?: Record<string, unknown> | null
    identities?: Array<{
      identity_data?: Record<string, unknown> | null
    }> | null
  } | null,
  keys: string[]
) {
  const metadataSources = [
    user?.user_metadata,
    ...(user?.identities?.map((identity) => identity.identity_data) ?? []),
  ]

  for (const key of keys) {
    for (const metadata of metadataSources) {
      const value = metadata?.[key]

      if (typeof value === "string" && value.trim()) {
        return value.trim()
      }
    }
  }

  return null
}

function readStringList(key: string): string[] {
  try {
    const raw = window.localStorage.getItem(key)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

function writeStringList(key: string, value: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Ignore storage failures; the UI still works for the current session.
  }
}

function orderAccounts(accounts: Account[], order: string[]): Account[] {
  return mergeAccountOrder(order, accounts)
    .map((fakeid) => accounts.find((account) => account.fakeid === fakeid))
    .filter((account): account is Account => Boolean(account))
}

function groupPinnedAccounts(
  accounts: Account[],
  pinnedFakeids: string[]
): Account[] {
  const pinnedFakeidSet = new Set(pinnedFakeids)
  const pinned = accounts.filter((account) =>
    pinnedFakeidSet.has(account.fakeid)
  )
  const unpinned = accounts.filter(
    (account) => !pinnedFakeidSet.has(account.fakeid)
  )
  return [...pinned, ...unpinned]
}

function mergeAccountOrder(order: string[], accounts: Account[]): string[] {
  const knownIds = new Set(accounts.map((account) => account.fakeid))
  const orderedKnownIds = order.filter((fakeid) => knownIds.has(fakeid))
  const orderedKnownIdSet = new Set(orderedKnownIds)
  const newIds = accounts
    .map((account) => account.fakeid)
    .filter((fakeid) => !orderedKnownIdSet.has(fakeid))

  return [...orderedKnownIds, ...newIds]
}

function moveAccountOrderItemToFront(
  order: string[],
  accounts: Account[],
  fakeid: string
): string[] {
  const nextOrder = mergeAccountOrder(order, accounts)
  const oldIndex = nextOrder.indexOf(fakeid)

  if (oldIndex <= 0) return nextOrder

  return moveStringItem(nextOrder, oldIndex, 0)
}

function moveStringItem(items: string[], oldIndex: number, newIndex: number) {
  const next = [...items]
  const [item] = next.splice(oldIndex, 1)
  next.splice(newIndex, 0, item)
  return next
}
