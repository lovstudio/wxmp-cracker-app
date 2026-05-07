import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import { restrictToVerticalAxis } from "@dnd-kit/modifiers"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  AlertCircleIcon,
  ArchiveIcon,
  ArrowDownToLineIcon,
  ArrowUpToLineIcon,
  CheckCircle2Icon,
  CopyIcon,
  GripVerticalIcon,
  KeyRoundIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  Settings2Icon,
  UserRoundIcon,
  XIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import type { Account, LoginAccount } from "@/lib/api"
import { normalizeWechatImageUrl } from "@/lib/media"
import { copyText } from "@/lib/toast"
import { createPortal } from "react-dom"

interface Props {
  accounts: Account[]
  archivedAccounts: Account[]
  pinnedFakeids: string[]
  activeFakeid: string | null
  lovstudioDisplayName: string | null
  lovstudioEmail: string | null
  lovstudioAvatarUrl: string | null
  lovstudioUserId: string | null
  loggedIn: boolean
  authAccount: LoginAccount | null
  lastLoginAt: number | null
  onLovstudioLogin: () => void
  onLovstudioLogout: () => void
  onSelect: (fakeid: string) => void
  onAddAccount: () => void
  onLogin: () => void
  onReorder: (activeFakeid: string, overFakeid: string) => void
  onArchive: (fakeid: string) => void
  onRestore: (fakeid: string) => void
  onPin: (fakeid: string) => void
  onUnpin: (fakeid: string) => void
  onMoveToTop: (fakeid: string) => void
  onMoveToBottom: (fakeid: string) => void
}

type SettingsPane = "account" | "connections"

interface AccountMenuState {
  account: Account
  archived: boolean
  pinned: boolean
  x: number
  y: number
}

interface AccountContextMenuAction {
  key: string
  label: string
  icon: ReactNode
  action: () => unknown | Promise<unknown>
  destructive?: boolean
}

interface AccountContextMenuGroup {
  key: string
  ariaLabel: string
  items: AccountContextMenuAction[]
}

export function AccountSidebar({
  accounts,
  archivedAccounts,
  pinnedFakeids,
  activeFakeid,
  lovstudioDisplayName,
  lovstudioEmail,
  lovstudioAvatarUrl,
  lovstudioUserId,
  loggedIn,
  authAccount,
  lastLoginAt,
  onLovstudioLogin,
  onLovstudioLogout,
  onSelect,
  onAddAccount,
  onLogin,
  onReorder,
  onArchive,
  onRestore,
  onPin,
  onUnpin,
  onMoveToTop,
  onMoveToBottom,
}: Props) {
  const [q, setQ] = useState("")
  const [contextMenu, setContextMenu] = useState<AccountMenuState | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPane, setSettingsPane] = useState<SettingsPane>("connections")
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 6,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )
  const authAvatar = loggedIn ? (authAccount?.avatar ?? null) : null
  const authFallback = authAccount?.nickname?.[0] ?? "微"
  const authId = authAccount?.username || null
  const authAlias = authAccount?.alias || null
  const authStatusLabel = loggedIn ? "扫码已登录" : "未扫码"
  const lovstudioLoggedIn = Boolean(lovstudioUserId)
  const lovstudioName =
    lovstudioDisplayName ?? lovstudioEmail ?? "Lovstudio 账号"
  const lovstudioFallback = lovstudioName.trim().slice(0, 1) || "L"
  const pinnedFakeidSet = useMemo(() => new Set(pinnedFakeids), [pinnedFakeids])
  const pinnedAccounts = useMemo(
    () => accounts.filter((account) => pinnedFakeidSet.has(account.fakeid)),
    [accounts, pinnedFakeidSet]
  )
  const unpinnedAccounts = useMemo(
    () => accounts.filter((account) => !pinnedFakeidSet.has(account.fakeid)),
    [accounts, pinnedFakeidSet]
  )

  const filteredPinned = useMemo(() => {
    return filterAccounts(pinnedAccounts, q)
  }, [pinnedAccounts, q])
  const filtered = useMemo(() => {
    return filterAccounts(unpinnedAccounts, q)
  }, [unpinnedAccounts, q])
  const filteredArchived = useMemo(() => {
    return filterAccounts(archivedAccounts, q)
  }, [archivedAccounts, q])
  const filteredPinnedIds = useMemo(
    () => filteredPinned.map((account) => account.fakeid),
    [filteredPinned]
  )
  const filteredIds = useMemo(
    () => filtered.map((account) => account.fakeid),
    [filtered]
  )
  const hasSearchResults =
    filteredPinned.length > 0 ||
    filtered.length > 0 ||
    filteredArchived.length > 0

  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    onReorder(String(active.id), String(over.id))
  }

  const openSettings = (pane: SettingsPane) => {
    setSettingsPane(pane)
    setSettingsOpen(true)
  }

  const openContextMenu = (
    account: Account,
    archived: boolean,
    pinned: boolean,
    clientX: number,
    clientY: number
  ) => {
    setContextMenu(
      createAccountMenuState(account, archived, pinned, clientX, clientY)
    )
  }

  useEffect(() => {
    if (!contextMenu) return

    const close = () => setContextMenu(null)
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close()
    }

    window.addEventListener("click", close)
    window.addEventListener("resize", close)
    window.addEventListener("scroll", close, true)
    window.addEventListener("keydown", closeOnEscape)

    return () => {
      window.removeEventListener("click", close)
      window.removeEventListener("resize", close)
      window.removeEventListener("scroll", close, true)
      window.removeEventListener("keydown", closeOnEscape)
    }
  }, [contextMenu])

  const renderSortableAccounts = (items: Account[], itemIds: string[]) => (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
        {items.map((a) => (
          <SortableAccountItem
            key={a.fakeid}
            account={a}
            isActive={a.fakeid === activeFakeid}
            isPinned={pinnedFakeidSet.has(a.fakeid)}
            onSelect={onSelect}
            onArchive={onArchive}
            onPin={onPin}
            onUnpin={onUnpin}
            onMoveToTop={onMoveToTop}
            onMoveToBottom={onMoveToBottom}
            onOpenContextMenu={openContextMenu}
          />
        ))}
      </SortableContext>
    </DndContext>
  )

  return (
    <Sidebar collapsible="offcanvas" className="library-sidebar">
      <SidebarHeader className="gap-4 p-4">
        <div className="library-brand rounded-lg p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="font-heading text-2xl leading-none font-semibold text-sidebar-foreground">
                微探
              </div>
              <div className="mt-1 text-[12px] font-medium text-sidebar-foreground/58">
                Powered by Lovstudio
              </div>
            </div>
            <div className="brand-mark-frame flex size-9 items-center justify-center rounded-md p-1.5 text-sidebar-primary">
              <img src="/app-logo.svg" alt="微探" className="size-full" />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="metric-cell rounded-md px-3 py-2">
              <div className="text-[10px] text-sidebar-foreground/48">账号</div>
              <div className="font-mono text-lg leading-tight text-sidebar-foreground">
                {accounts.length}
              </div>
            </div>
            <div className="metric-cell rounded-md px-3 py-2">
              <div className="text-[10px] text-sidebar-foreground/48">文章</div>
              <div className="font-mono text-lg leading-tight text-sidebar-foreground">
                {accounts
                  .reduce((s, a) => s + a.article_count, 0)
                  .toLocaleString()}
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-2">
          <div className="search-shell relative min-w-0 flex-1 rounded-lg">
            <SearchIcon className="absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-sidebar-foreground/45" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索公众号、别名或签名"
              className="h-9 border-0 bg-transparent pr-3 pl-9 text-sidebar-foreground placeholder:text-sidebar-foreground/36 focus-visible:ring-1 focus-visible:ring-sidebar-ring/70"
            />
          </div>
          <Button
            type="button"
            size="icon"
            variant="outline"
            aria-label="新增公众号"
            title="新增公众号"
            className="size-9 shrink-0 border-sidebar-border/70 bg-sidebar-accent/60 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
            onClick={onAddAccount}
          >
            <PlusIcon className="size-4" />
          </Button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {!hasSearchResults && (
          <SidebarGroup className="px-3 pb-4">
            <SidebarMenu className="gap-1">
              <div className="mx-1 rounded-md border border-sidebar-border/60 px-3 py-8 text-center text-xs text-sidebar-foreground/48">
                没有匹配的公众号
              </div>
            </SidebarMenu>
          </SidebarGroup>
        )}
        {filteredPinned.length > 0 && (
          <SidebarGroup className="px-3 pb-2">
            <SidebarGroupLabel className="h-7 gap-1.5 px-1 text-[10px] font-semibold text-sidebar-foreground/42">
              <PinIcon className="size-3" />
              已固定
            </SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {renderSortableAccounts(filteredPinned, filteredPinnedIds)}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {filtered.length > 0 && (
          <SidebarGroup className="px-3 pb-4">
            <SidebarGroupLabel className="h-7 px-1 text-[10px] font-semibold text-sidebar-foreground/42">
              公众号库
            </SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {renderSortableAccounts(filtered, filteredIds)}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {filteredArchived.length > 0 && (
          <SidebarGroup className="border-t border-sidebar-border/60 px-3 py-3">
            <SidebarGroupLabel className="h-7 px-1 text-[10px] font-semibold text-sidebar-foreground/42">
              已归档
            </SidebarGroupLabel>
            <SidebarMenu className="gap-1">
              {filteredArchived.map((a) => (
                <ArchivedAccountItem
                  key={a.fakeid}
                  account={a}
                  onRestore={onRestore}
                  onOpenContextMenu={openContextMenu}
                />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border/70 p-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-sidebar-foreground/68 outline-hidden transition-colors hover:bg-sidebar-accent/45 hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
            >
              <Settings2Icon className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">设置</span>
              <span
                className={`size-1.5 shrink-0 rounded-full ${
                  lovstudioLoggedIn ? "bg-emerald-500" : "bg-sidebar-border"
                }`}
                aria-label={
                  lovstudioLoggedIn ? "Lovstudio 已登录" : "Lovstudio 未登录"
                }
              />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top" className="w-72">
            <DropdownMenuLabel>设置</DropdownMenuLabel>
            <div className="flex min-w-0 items-center gap-2 px-1.5 pb-2">
              {lovstudioLoggedIn ? (
                <Avatar
                  src={lovstudioAvatarUrl}
                  fallback={lovstudioFallback}
                  compact
                  shape="circle"
                />
              ) : (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <UserRoundIcon className="size-3.5" />
                </div>
              )}
              <div className="min-w-0 flex-1 text-xs">
                <div className="truncate font-medium text-foreground">
                  {lovstudioLoggedIn ? lovstudioName : "未登录 Lovstudio"}
                </div>
                <div className="mt-0.5 truncate text-muted-foreground">
                  {lovstudioLoggedIn
                    ? lovstudioEmail || "授权绑定 Lovstudio 账号"
                    : "登录后可激活和远程授权"}
                </div>
              </div>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openSettings("account")}>
              <UserRoundIcon className="size-3.5" />
              账号设置
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openSettings("connections")}>
              <Settings2Icon className="size-3.5" />
              连接配置
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarFooter>
      {settingsOpen ? (
        <AppSettingsWindow
          authAccount={authAccount}
          authAlias={authAlias}
          authAvatar={authAvatar}
          authFallback={authFallback}
          authId={authId}
          authStatusLabel={authStatusLabel}
          lastLoginAt={lastLoginAt}
          loggedIn={loggedIn}
          lovstudioAvatarUrl={lovstudioAvatarUrl}
          lovstudioEmail={lovstudioEmail}
          lovstudioFallback={lovstudioFallback}
          lovstudioLoggedIn={lovstudioLoggedIn}
          lovstudioName={lovstudioName}
          lovstudioUserId={lovstudioUserId}
          initialPane={settingsPane}
          onClose={() => setSettingsOpen(false)}
          onLogin={onLogin}
          onLovstudioLogin={onLovstudioLogin}
          onLovstudioLogout={onLovstudioLogout}
        />
      ) : null}
      {contextMenu && (
        <AccountContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onSelect={onSelect}
          onArchive={onArchive}
          onRestore={onRestore}
          onPin={onPin}
          onUnpin={onUnpin}
          onMoveToTop={onMoveToTop}
          onMoveToBottom={onMoveToBottom}
        />
      )}
    </Sidebar>
  )
}

function AppSettingsWindow({
  authAccount,
  authAlias,
  authAvatar,
  authFallback,
  authId,
  authStatusLabel,
  lastLoginAt,
  loggedIn,
  lovstudioAvatarUrl,
  lovstudioEmail,
  lovstudioFallback,
  lovstudioLoggedIn,
  lovstudioName,
  lovstudioUserId,
  initialPane,
  onClose,
  onLogin,
  onLovstudioLogin,
  onLovstudioLogout,
}: {
  authAccount: LoginAccount | null
  authAlias: string | null
  authAvatar: string | null
  authFallback: string
  authId: string | null
  authStatusLabel: string
  lastLoginAt: number | null
  loggedIn: boolean
  lovstudioAvatarUrl: string | null
  lovstudioEmail: string | null
  lovstudioFallback: string
  lovstudioLoggedIn: boolean
  lovstudioName: string
  lovstudioUserId: string | null
  initialPane: SettingsPane
  onClose: () => void
  onLogin: () => void
  onLovstudioLogin: () => void
  onLovstudioLogout: () => void
}) {
  const [activePane, setActivePane] = useState<SettingsPane>(initialPane)
  const [confirmingLogout, setConfirmingLogout] = useState(false)
  const openLovstudioLogin = () => {
    onClose()
    onLovstudioLogin()
  }
  const confirmLovstudioLogout = () => {
    setConfirmingLogout(false)
    onLovstudioLogout()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center bg-black/35 p-6 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <div className="grid h-[min(680px,calc(100dvh-48px))] w-[min(880px,calc(100vw-48px))] overflow-hidden rounded-xl border border-border bg-card shadow-2xl md:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="hidden border-r border-border bg-muted/45 p-3 md:block">
          <div className="mb-5 flex items-center gap-2 px-1">
            <span className="size-3 rounded-full bg-red-500/80" />
            <span className="size-3 rounded-full bg-yellow-500/80" />
            <span className="size-3 rounded-full bg-green-500/80" />
          </div>
          <div className="grid gap-1">
            <SettingsNavButton
              active={activePane === "account"}
              icon={<UserRoundIcon className="size-4" />}
              label="账号"
              onClick={() => setActivePane("account")}
            />
            <SettingsNavButton
              active={activePane === "connections"}
              icon={<Settings2Icon className="size-4" />}
              label="连接"
              onClick={() => setActivePane("connections")}
            />
          </div>
        </aside>
        <section className="flex min-w-0 flex-col">
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-5">
            <div className="min-w-0 flex-1">
              <div className="truncate text-base font-semibold">
                {activePane === "account" ? "账号" : "连接"}
              </div>
            </div>
            <div className="flex gap-1 md:hidden">
              <Button
                type="button"
                size="sm"
                variant={activePane === "account" ? "secondary" : "ghost"}
                onClick={() => setActivePane("account")}
              >
                账号
              </Button>
              <Button
                type="button"
                size="sm"
                variant={activePane === "connections" ? "secondary" : "ghost"}
                onClick={() => setActivePane("connections")}
              >
                连接
              </Button>
            </div>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="关闭设置"
              onClick={onClose}
            >
              <XIcon className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {activePane === "account" ? (
              <div className="grid gap-4">
                <section className="rounded-xl border border-border bg-background/80 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    {lovstudioLoggedIn ? (
                      <Avatar
                        src={lovstudioAvatarUrl}
                        fallback={lovstudioFallback}
                        shape="circle"
                      />
                    ) : (
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <UserRoundIcon className="size-4" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">
                        {lovstudioLoggedIn ? lovstudioName : "Lovstudio"}
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {lovstudioLoggedIn
                          ? lovstudioEmail || "已绑定 Lovstudio 账号"
                          : "未登录"}
                      </div>
                    </div>
                    <span
                      className="auth-status-badge shrink-0"
                      data-state={lovstudioLoggedIn ? "online" : "offline"}
                    >
                      {lovstudioLoggedIn ? "已登录" : "未登录"}
                    </span>
                  </div>
                  {lovstudioUserId ? (
                    <button
                      type="button"
                      className="mt-3 flex w-full min-w-0 items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-left font-mono text-xs text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                      onClick={() => void copyText(lovstudioUserId)}
                    >
                      <CopyIcon className="size-3.5 shrink-0" />
                      <span className="truncate">{lovstudioUserId}</span>
                    </button>
                  ) : null}
                  {!lovstudioLoggedIn ? (
                    <div className="mt-4 flex justify-end">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={openLovstudioLogin}
                      >
                        <UserRoundIcon className="size-3.5" />
                        登录 Lovstudio
                      </Button>
                    </div>
                  ) : null}
                </section>
                {lovstudioLoggedIn ? (
                  <section className="rounded-xl border border-destructive/20 bg-destructive/5 p-4">
                    <div className="flex min-w-0 items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-destructive">
                          退出 Lovstudio
                        </div>
                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                          本机将停止使用当前账号同步授权。
                        </div>
                      </div>
                      {!confirmingLogout ? (
                        <Button
                          type="button"
                          variant="destructive"
                          onClick={() => setConfirmingLogout(true)}
                        >
                          <LogOutIcon className="size-3.5" />
                          退出登录
                        </Button>
                      ) : (
                        <div className="flex shrink-0 gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={() => setConfirmingLogout(false)}
                          >
                            取消
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={confirmLovstudioLogout}
                          >
                            确认退出
                          </Button>
                        </div>
                      )}
                    </div>
                  </section>
                ) : null}
              </div>
            ) : (
              <div className="grid gap-4">
                <section className="rounded-xl border border-border bg-background/80 p-4">
                  <div className="flex min-w-0 items-center gap-3">
                    {authAvatar ? (
                      <Avatar src={authAvatar} fallback={authFallback} />
                    ) : (
                      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                        {loggedIn ? (
                          <CheckCircle2Icon className="size-4" />
                        ) : (
                          <AlertCircleIcon className="size-4" />
                        )}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <div className="truncate text-sm font-semibold">
                          微信公众号
                        </div>
                        <span
                          className="auth-status-badge"
                          data-state={loggedIn ? "online" : "offline"}
                        >
                          {authStatusLabel}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate text-xs text-muted-foreground">
                        {loggedIn
                          ? (authAccount?.nickname ?? "账号信息同步中")
                          : "未配置"}
                      </div>
                    </div>
                    <Button type="button" variant="outline" onClick={onLogin}>
                      <KeyRoundIcon className="size-3.5" />
                      {loggedIn ? "更新" : "配置"}
                    </Button>
                  </div>
                  {loggedIn ? (
                    <div className="mt-4 grid gap-2 rounded-lg bg-muted/55 p-3 text-xs text-muted-foreground">
                      <SettingsInfoRow
                        label="上次登录"
                        value={formatLastLogin(lastLoginAt)}
                      />
                      {authAlias ? (
                        <SettingsInfoRow label="别名" value={authAlias} />
                      ) : null}
                      {authId ? (
                        <button
                          type="button"
                          className="grid grid-cols-[72px_minmax(0,1fr)] gap-3 text-left outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => void copyText(authId)}
                        >
                          <span>ID</span>
                          <span className="truncate font-mono">{authId}</span>
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </section>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>,
    document.body
  )
}

function SettingsNavButton({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean
  icon: ReactNode
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      data-active={active}
      className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-sm text-muted-foreground outline-hidden transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[active=true]:bg-background data-[active=true]:text-foreground data-[active=true]:shadow-sm"
      onClick={onClick}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

function SettingsInfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <span>{label}</span>
      <span className="truncate text-foreground">{value}</span>
    </div>
  )
}

function SortableAccountItem({
  account,
  isActive,
  isPinned,
  onSelect,
  onArchive,
  onPin,
  onUnpin,
  onMoveToTop,
  onMoveToBottom,
  onOpenContextMenu,
}: {
  account: Account
  isActive: boolean
  isPinned: boolean
  onSelect: (fakeid: string) => void
  onArchive: (fakeid: string) => void
  onPin: (fakeid: string) => void
  onUnpin: (fakeid: string) => void
  onMoveToTop: (fakeid: string) => void
  onMoveToBottom: (fakeid: string) => void
  onOpenContextMenu: (
    account: Account,
    archived: boolean,
    pinned: boolean,
    clientX: number,
    clientY: number
  ) => void
}) {
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({ id: account.fakeid })
  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 12 : undefined,
  }

  return (
    <SidebarMenuItem
      ref={setNodeRef}
      data-dragging={isDragging ? "true" : "false"}
      style={style}
      className="account-sortable-item"
      onContextMenu={(event) => {
        event.preventDefault()
        onOpenContextMenu(
          account,
          false,
          isPinned,
          event.clientX,
          event.clientY
        )
      }}
    >
      <button
        ref={setActivatorNodeRef}
        type="button"
        aria-label={`拖拽排序 ${account.nickname}`}
        title="拖拽排序"
        className="account-drag-handle absolute top-1/2 left-1.5 z-10 flex size-7 -translate-y-1/2 cursor-grab items-center justify-center rounded-md text-sidebar-foreground/42 outline-hidden transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <SidebarMenuButton
        type="button"
        isActive={isActive}
        onClick={() => onSelect(account.fakeid)}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          ) {
            return
          }
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onOpenContextMenu(
            account,
            false,
            isPinned,
            rect.left + 36,
            rect.top + 28
          )
        }}
        aria-haspopup="menu"
        className="account-row h-auto rounded-lg py-3 pr-3 pl-9 text-sidebar-foreground hover:bg-sidebar-accent/70"
      >
        <Avatar src={account.avatar} fallback={account.nickname[0] ?? "?"} />
        <div className="flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {account.nickname}
            </div>
          </div>
          <div className="mt-0.5 truncate text-[11px] text-sidebar-foreground/48">
            {account.signature || account.alias || "无签名"}
          </div>
        </div>
        <span className="account-row-trailing ml-auto flex h-7 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-sidebar-border/50 bg-sidebar/45 font-mono text-[10px] text-sidebar-foreground/58 tabular-nums transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0">
          {account.article_count.toLocaleString()}
        </span>
      </SidebarMenuButton>
      <AccountActionMenu
        account={account}
        isPinned={isPinned}
        onArchive={onArchive}
        onPin={onPin}
        onUnpin={onUnpin}
        onMoveToTop={onMoveToTop}
        onMoveToBottom={onMoveToBottom}
      />
    </SidebarMenuItem>
  )
}

function AccountActionMenu({
  account,
  isPinned,
  onArchive,
  onPin,
  onUnpin,
  onMoveToTop,
  onMoveToBottom,
}: {
  account: Account
  isPinned: boolean
  onArchive: (fakeid: string) => void
  onPin: (fakeid: string) => void
  onUnpin: (fakeid: string) => void
  onMoveToTop: (fakeid: string) => void
  onMoveToBottom: (fakeid: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${account.nickname} 操作`}
          title="账号操作"
          className="pointer-events-none absolute top-1/2 right-3 z-10 flex h-7 w-10 -translate-y-1/2 items-center justify-center rounded-sm border border-sidebar-border/50 bg-sidebar/45 p-0 text-sidebar-foreground/70 opacity-0 outline-hidden transition-opacity group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-expanded:pointer-events-auto aria-expanded:opacity-100 [&>svg]:size-3.5 [&>svg]:shrink-0"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuLabel className="truncate">
          {account.nickname}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() =>
            isPinned ? onUnpin(account.fakeid) : onPin(account.fakeid)
          }
        >
          {isPinned ? (
            <PinOffIcon className="size-3.5" />
          ) : (
            <PinIcon className="size-3.5" />
          )}
          {isPinned ? "取消固定" : "固定"}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMoveToTop(account.fakeid)}>
          <ArrowUpToLineIcon className="size-3.5" />
          置顶
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onMoveToBottom(account.fakeid)}>
          <ArrowDownToLineIcon className="size-3.5" />
          置底
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => void copyText(account.fakeid)}>
          <CopyIcon className="size-3.5" />
          复制 FakeID
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onArchive(account.fakeid)}
        >
          <ArchiveIcon className="size-3.5" />
          归档
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ArchivedAccountItem({
  account,
  onRestore,
  onOpenContextMenu,
}: {
  account: Account
  onRestore: (fakeid: string) => void
  onOpenContextMenu: (
    account: Account,
    archived: boolean,
    pinned: boolean,
    clientX: number,
    clientY: number
  ) => void
}) {
  return (
    <SidebarMenuItem
      onContextMenu={(event) => {
        event.preventDefault()
        onOpenContextMenu(account, true, false, event.clientX, event.clientY)
      }}
    >
      <SidebarMenuButton
        type="button"
        onClick={() => onRestore(account.fakeid)}
        onKeyDown={(event) => {
          if (
            event.key !== "ContextMenu" &&
            !(event.shiftKey && event.key === "F10")
          ) {
            return
          }
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onOpenContextMenu(account, true, false, rect.left + 36, rect.top + 28)
        }}
        aria-haspopup="menu"
        className="account-row h-auto rounded-lg px-3 py-3 text-sidebar-foreground/62 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      >
        <Avatar src={account.avatar} fallback={account.nickname[0] ?? "?"} />
        <div className="flex-1 overflow-hidden">
          <div className="truncate text-[13px] font-semibold">
            {account.nickname}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-sidebar-foreground/42">
            {account.signature || account.alias || "无签名"}
          </div>
        </div>
        <span className="account-row-trailing ml-auto flex h-7 w-10 shrink-0 items-center justify-center overflow-hidden rounded-sm border border-sidebar-border/40 bg-sidebar/35 font-mono text-[10px] text-sidebar-foreground/42 tabular-nums transition-opacity group-focus-within/menu-item:opacity-0 group-hover/menu-item:opacity-0">
          {account.article_count.toLocaleString()}
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={`${account.nickname} 归档操作`}
            title="归档操作"
            className="pointer-events-none absolute top-1/2 right-3 z-10 flex h-7 w-10 -translate-y-1/2 items-center justify-center rounded-sm border border-sidebar-border/40 bg-sidebar/35 p-0 text-sidebar-foreground/70 opacity-0 outline-hidden transition-opacity group-focus-within/menu-item:pointer-events-auto group-focus-within/menu-item:opacity-100 group-hover/menu-item:pointer-events-auto group-hover/menu-item:opacity-100 hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring aria-expanded:pointer-events-auto aria-expanded:opacity-100 [&>svg]:size-3.5 [&>svg]:shrink-0"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel className="truncate">
            {account.nickname}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onRestore(account.fakeid)}>
            <RotateCcwIcon className="size-3.5" />
            取消归档
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => void copyText(account.fakeid)}>
            <CopyIcon className="size-3.5" />
            复制 FakeID
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  )
}

function AccountContextMenu({
  menu,
  onClose,
  onSelect,
  onArchive,
  onRestore,
  onPin,
  onUnpin,
  onMoveToTop,
  onMoveToBottom,
}: {
  menu: AccountMenuState
  onClose: () => void
  onSelect: (fakeid: string) => void
  onArchive: (fakeid: string) => void
  onRestore: (fakeid: string) => void
  onPin: (fakeid: string) => void
  onUnpin: (fakeid: string) => void
  onMoveToTop: (fakeid: string) => void
  onMoveToBottom: (fakeid: string) => void
}) {
  const { account, archived, pinned } = menu
  const run = (action: () => unknown | Promise<unknown>) => {
    onClose()
    void action()
  }
  const groups: AccountContextMenuGroup[] = archived
    ? [
        {
          key: "archive",
          ariaLabel: "归档操作",
          items: [
            {
              key: "restore",
              label: "取消归档",
              icon: <RotateCcwIcon className="size-3.5" />,
              action: () => onRestore(account.fakeid),
            },
            {
              key: "copy-fakeid",
              label: "复制 FakeID",
              icon: <CopyIcon className="size-3.5" />,
              action: () => copyText(account.fakeid),
            },
          ],
        },
      ]
    : [
        {
          key: "primary",
          ariaLabel: "主要操作",
          items: [
            {
              key: "select",
              label: "选中公众号",
              icon: <CheckCircle2Icon className="size-3.5" />,
              action: () => onSelect(account.fakeid),
            },
            {
              key: "pin",
              label: pinned ? "取消固定" : "固定",
              icon: pinned ? (
                <PinOffIcon className="size-3.5" />
              ) : (
                <PinIcon className="size-3.5" />
              ),
              action: () =>
                pinned ? onUnpin(account.fakeid) : onPin(account.fakeid),
            },
          ],
        },
        {
          key: "order",
          ariaLabel: "排序操作",
          items: [
            {
              key: "move-to-top",
              label: "置顶",
              icon: <ArrowUpToLineIcon className="size-3.5" />,
              action: () => onMoveToTop(account.fakeid),
            },
            {
              key: "move-to-bottom",
              label: "置底",
              icon: <ArrowDownToLineIcon className="size-3.5" />,
              action: () => onMoveToBottom(account.fakeid),
            },
          ],
        },
        {
          key: "copy",
          ariaLabel: "复制操作",
          items: [
            {
              key: "copy-fakeid",
              label: "复制 FakeID",
              icon: <CopyIcon className="size-3.5" />,
              action: () => copyText(account.fakeid),
            },
          ],
        },
        {
          key: "danger",
          ariaLabel: "危险操作",
          items: [
            {
              key: "archive",
              label: "归档",
              icon: <ArchiveIcon className="size-3.5" />,
              action: () => onArchive(account.fakeid),
              destructive: true,
            },
          ],
        },
      ]

  return createPortal(
    <div
      role="menu"
      className="article-context-menu account-context-menu"
      style={{ left: menu.x, top: menu.y }}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="article-context-title">{account.nickname}</div>
      {groups.map((group, groupIndex) => (
        <Fragment key={group.key}>
          {groupIndex > 0 && (
            <div role="separator" className="article-context-separator" />
          )}
          <div
            role="group"
            aria-label={group.ariaLabel}
            className="article-context-group"
          >
            {group.items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className={
                  item.destructive
                    ? "article-context-item account-context-item-destructive"
                    : "article-context-item"
                }
                onClick={() => run(item.action)}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </Fragment>
      ))}
    </div>,
    document.body
  )
}

function createAccountMenuState(
  account: Account,
  archived: boolean,
  pinned: boolean,
  clientX: number,
  clientY: number
): AccountMenuState {
  const width = 190
  const height = getAccountContextMenuEstimatedHeight(archived)
  const padding = 8
  const x = Math.min(clientX, window.innerWidth - width - padding)
  const y = Math.min(clientY, window.innerHeight - height - padding)

  return {
    account,
    archived,
    pinned,
    x: Math.max(padding, x),
    y: Math.max(padding, y),
  }
}

function getAccountContextMenuEstimatedHeight(archived: boolean) {
  const itemCount = archived ? 2 : 6
  const groupCount = archived ? 1 : 4
  const verticalPadding = 12
  const titleHeight = 44
  const itemHeight = 30
  const separatorHeight = 11

  return (
    verticalPadding +
    titleHeight +
    itemCount * itemHeight +
    (groupCount - 1) * separatorHeight
  )
}

function formatLastLogin(lastLoginAt: number | null): string {
  if (!lastLoginAt) return "时间未知"

  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - lastLoginAt * 1000) / 1000)
  )
  if (elapsedSeconds < 60) return "刚刚"

  const elapsedMinutes = Math.floor(elapsedSeconds / 60)
  if (elapsedMinutes < 60) return `${elapsedMinutes} 分钟前`

  const elapsedHours = Math.floor(elapsedMinutes / 60)
  if (elapsedHours < 24) return `${elapsedHours} 小时前`

  const elapsedDays = Math.floor(elapsedHours / 24)
  if (elapsedDays < 30) return `${elapsedDays} 天前`

  const elapsedMonths = Math.floor(elapsedDays / 30)
  if (elapsedMonths < 12) return `${elapsedMonths} 个月前`

  return `${Math.floor(elapsedMonths / 12)} 年前`
}

function filterAccounts(accounts: Account[], query: string) {
  const s = query.trim().toLowerCase()
  if (!s) return accounts

  return accounts.filter(
    (a) =>
      a.nickname.toLowerCase().includes(s) ||
      (a.alias ?? "").toLowerCase().includes(s) ||
      (a.signature ?? "").toLowerCase().includes(s)
  )
}

function Avatar({
  src,
  fallback,
  compact = false,
  shape = "rounded",
}: {
  src: string | null
  fallback: string
  compact?: boolean
  shape?: "rounded" | "circle"
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const imageSrc = normalizeWechatImageUrl(src)
  const showImage = imageSrc && failedSrc !== imageSrc
  const sizeClass = compact ? "size-8" : "size-9"
  const textClass = compact ? "text-xs" : "text-sm"
  const shapeClass = shape === "circle" ? "rounded-full" : "rounded-md"

  if (showImage) {
    return (
      <img
        src={imageSrc}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        className={`avatar-ring ${sizeClass} ${shapeClass} shrink-0 object-cover`}
        onError={(e) => {
          e.currentTarget.style.display = "none"
          setFailedSrc(imageSrc)
        }}
      />
    )
  }
  return (
    <div
      className={`avatar-ring flex ${sizeClass} ${shapeClass} shrink-0 items-center justify-center bg-sidebar-accent ${textClass} font-semibold text-sidebar-primary`}
    >
      {fallback}
    </div>
  )
}
