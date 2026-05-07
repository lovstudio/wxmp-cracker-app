import { useEffect, useState, type CSSProperties } from "react"
import { AccountSidebar } from "@/components/account-sidebar"
import { AccountWorkspace } from "@/components/account-workspace"
import { ArticleList } from "@/components/article-list"
import { ArticleDetail as ArticleDetailView } from "@/components/article-detail"
import { TopBar, type WorkspaceTabId } from "@/components/top-bar"
import { AddAccountDialog } from "@/components/add-account-dialog"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import {
  api,
  onLoginError,
  onLoginSuccess,
  type Account,
  type LoginAccount,
} from "@/lib/api"
import { isTauri } from "@/lib/tauri"
import { copyableToast as toast } from "@/lib/toast"

const ACCOUNT_ORDER_STORAGE_KEY = "wxmp.accountOrder"
const ARCHIVED_ACCOUNTS_STORAGE_KEY = "wxmp.archivedAccounts"
const PINNED_ACCOUNTS_STORAGE_KEY = "wxmp.pinnedAccounts"

export default function App() {
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
  const [addingAccount, setAddingAccount] = useState(false)
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
  const totalArticles = activeAccounts.reduce(
    (total, account) => total + account.article_count,
    0
  )
  const activeAccount =
    activeAccounts.find((account) => account.fakeid === selectedFakeid) ?? null

  const refreshAccounts = async () => {
    try {
      const list = await api.listAccounts()
      setAccounts(list)
    } catch (e) {
      if (isTauri()) {
        toast.error(`读取缓存失败: ${e}`)
      }
    }
  }

  const refreshAuth = async () => {
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
  }

  useEffect(() => {
    refreshAccounts()
    refreshAuth()
    const ok = onLoginSuccess(() => {
      toast.success("登录成功，已保存凭证")
      refreshAuth()
    })
    const err = onLoginError((m) => {
      toast.error(`登录失败: ${m}`)
    })
    return () => {
      ok.then((un) => un())
      err.then((un) => un())
    }
  }, [])

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
    if (!loggedIn) {
      toast.error("请先扫码登录")
      return
    }
    setAddAccountOpen(true)
  }

  const addAccount = async (
    query: string,
    limit: number,
    withContent: boolean
  ) => {
    setAddingAccount(true)
    try {
      await api.fetchAccount(query, limit, withContent)
      const list = await api.listAccounts()
      setAccounts(list)

      const needle = query.trim().toLowerCase()
      const added = list.find((account) => {
        return (
          account.fakeid.toLowerCase() === needle ||
          account.nickname.toLowerCase() === needle ||
          (account.alias ?? "").toLowerCase() === needle ||
          account.nickname.toLowerCase().includes(needle)
        )
      })

      if (added) {
        setActiveFakeid(added.fakeid)
        setActiveAid(null)
      }

      toast.success("已新增公众号")
      setAddAccountOpen(false)
    } catch (e) {
      toast.error(errorMessage(e))
    } finally {
      setAddingAccount(false)
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
    <TooltipProvider>
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
            loggedIn={loggedIn}
            authAccount={authAccount}
            lastLoginAt={lastLoginAt}
            onAddAccount={openAddAccount}
            onLogin={() => {
              api.openLogin().catch((e) => toast.error(errorMessage(e)))
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
              accountCount={activeAccounts.length}
              articleCount={totalArticles}
              activeTab={activeTab}
              onTabChange={setActiveTab}
            />
            <div className="workspace-grid flex min-h-0 flex-1 overflow-hidden">
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
        onOpenChange={setAddAccountOpen}
        onSubmit={addAccount}
      />
      <Toaster />
    </TooltipProvider>
  )
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    return String((error as { message: unknown }).message)
  }
  return String(error)
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

function moveStringItem(items: string[], oldIndex: number, newIndex: number) {
  const next = [...items]
  const [item] = next.splice(oldIndex, 1)
  next.splice(newIndex, 0, item)
  return next
}
