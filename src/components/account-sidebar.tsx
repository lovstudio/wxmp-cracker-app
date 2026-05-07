import { useEffect, useMemo, useState, type CSSProperties } from "react"
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
  Clock3Icon,
  CopyIcon,
  DatabaseIcon,
  GripVerticalIcon,
  KeyRoundIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
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
  loggedIn: boolean
  authAccount: LoginAccount | null
  lastLoginAt: number | null
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

interface AccountMenuState {
  account: Account
  archived: boolean
  pinned: boolean
  x: number
  y: number
}

export function AccountSidebar({
  accounts,
  archivedAccounts,
  pinnedFakeids,
  activeFakeid,
  loggedIn,
  authAccount,
  lastLoginAt,
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
  const authStatusLabel = loggedIn ? "已登录" : "未登录"
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
          <div className="mt-3 rounded-md border border-sidebar-border/65 bg-sidebar/35 px-2.5 py-2">
            <div className="flex min-w-0 items-center gap-2">
              {authAvatar ? (
                <Avatar src={authAvatar} fallback={authFallback} compact />
              ) : (
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-sidebar-border/65 bg-sidebar-accent/70 text-sidebar-primary">
                  {loggedIn ? (
                    <CheckCircle2Icon className="size-3.5" />
                  ) : (
                    <AlertCircleIcon className="size-3.5" />
                  )}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-2">
                  <div className="truncate text-sm font-semibold text-sidebar-foreground">
                    {loggedIn
                      ? (authAccount?.nickname ?? "账号信息同步中")
                      : "未登录用户账号"}
                  </div>
                  <span
                    className="auth-status-badge"
                    data-state={loggedIn ? "online" : "offline"}
                  >
                    {authStatusLabel}
                  </span>
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-sidebar-foreground/48">
                  {loggedIn ? (
                    <>
                      <Clock3Icon className="size-3 shrink-0" />
                      <span className="shrink-0">
                        {formatLastLogin(lastLoginAt)}
                      </span>
                    </>
                  ) : (
                    <span className="truncate">扫码后才能新增公众号</span>
                  )}
                </div>
              </div>
              {loggedIn ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      size="icon"
                      variant="outline"
                      aria-label="登录账号菜单"
                      title="登录账号菜单"
                      className="size-8 shrink-0 border-sidebar-border/70 bg-sidebar-accent/60 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                    >
                      <MoreHorizontalIcon className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-56">
                    <DropdownMenuLabel>登录账号</DropdownMenuLabel>
                    <div className="px-1.5 pb-1 text-xs text-muted-foreground">
                      <div className="truncate font-medium text-foreground">
                        {authAccount?.nickname ?? "账号信息同步中"}
                      </div>
                      {authAlias && (
                        <div className="mt-1 truncate">别名 {authAlias}</div>
                      )}
                      {authId && (
                        <div className="mt-1 truncate">ID {authId}</div>
                      )}
                    </div>
                    <DropdownMenuSeparator />
                    {authId && (
                      <DropdownMenuItem onClick={() => void copyText(authId)}>
                        <CopyIcon className="size-3.5" />
                        复制账号 ID
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onClick={onLogin}>
                      <KeyRoundIcon className="size-3.5" />
                      更新凭证
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  aria-label="扫码登录"
                  title="扫码登录"
                  className="size-8 shrink-0 border-sidebar-border/70 bg-sidebar-accent/60 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
                  onClick={onLogin}
                >
                  <KeyRoundIcon className="size-3.5" />
                </Button>
              )}
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
      <SidebarFooter className="border-t border-sidebar-border/70 p-4">
        <div className="flex items-center gap-2 text-[11px] text-sidebar-foreground/48">
          <DatabaseIcon className="size-3.5" />
          <span className="truncate">wcx 本地缓存</span>
          <ArchiveIcon className="ml-auto size-3.5" />
        </div>
      </SidebarFooter>
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
        className="account-row h-auto rounded-lg py-3 pr-12 pl-9 text-sidebar-foreground hover:bg-sidebar-accent/70"
      >
        <Avatar src={account.avatar} fallback={account.nickname[0] ?? "?"} />
        <div className="flex-1 overflow-hidden">
          <div className="flex min-w-0 items-center gap-1.5">
            <div className="min-w-0 flex-1 truncate text-[13px] font-semibold">
              {account.nickname}
            </div>
            {isPinned && (
              <PinIcon className="size-3 shrink-0 text-sidebar-primary" />
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-sidebar-foreground/48">
            {account.signature || account.alias || "无签名"}
          </div>
        </div>
        <span className="mr-2 ml-2 rounded-sm border border-sidebar-border/50 bg-sidebar/45 px-1.5 py-0.5 font-mono text-[10px] text-sidebar-foreground/58 tabular-nums">
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
        <SidebarMenuAction
          type="button"
          showOnHover
          aria-label={`${account.nickname} 操作`}
          title="账号操作"
          className="top-1/2 right-2 z-10 size-7 -translate-y-1/2 bg-sidebar/65 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <MoreHorizontalIcon className="size-3.5" />
        </SidebarMenuAction>
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
        <span className="mr-2 ml-2 rounded-sm border border-sidebar-border/40 bg-sidebar/35 px-1.5 py-0.5 font-mono text-[10px] text-sidebar-foreground/42 tabular-nums">
          {account.article_count.toLocaleString()}
        </span>
      </SidebarMenuButton>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuAction
            type="button"
            showOnHover
            aria-label={`${account.nickname} 归档操作`}
            title="归档操作"
            className="top-1/2 right-2 z-10 size-7 -translate-y-1/2 bg-sidebar/65 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <MoreHorizontalIcon className="size-3.5" />
          </SidebarMenuAction>
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
      {archived ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() => run(() => onRestore(account.fakeid))}
          >
            <RotateCcwIcon className="size-3.5" />
            取消归档
          </button>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() => run(() => copyText(account.fakeid))}
          >
            <CopyIcon className="size-3.5" />
            复制 FakeID
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() => run(() => onSelect(account.fakeid))}
          >
            <CheckCircle2Icon className="size-3.5" />
            选中公众号
          </button>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() =>
              run(() =>
                pinned ? onUnpin(account.fakeid) : onPin(account.fakeid)
              )
            }
          >
            {pinned ? (
              <PinOffIcon className="size-3.5" />
            ) : (
              <PinIcon className="size-3.5" />
            )}
            {pinned ? "取消固定" : "固定"}
          </button>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() => run(() => onMoveToTop(account.fakeid))}
          >
            <ArrowUpToLineIcon className="size-3.5" />
            置顶
          </button>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() => run(() => onMoveToBottom(account.fakeid))}
          >
            <ArrowDownToLineIcon className="size-3.5" />
            置底
          </button>
          <button
            type="button"
            role="menuitem"
            className="article-context-item"
            onClick={() => run(() => copyText(account.fakeid))}
          >
            <CopyIcon className="size-3.5" />
            复制 FakeID
          </button>
          <div className="article-context-separator" />
          <button
            type="button"
            role="menuitem"
            className="article-context-item account-context-item-destructive"
            onClick={() => run(() => onArchive(account.fakeid))}
          >
            <ArchiveIcon className="size-3.5" />
            归档
          </button>
        </>
      )}
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
  const height = archived ? 104 : 254
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
}: {
  src: string | null
  fallback: string
  compact?: boolean
}) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const imageSrc = normalizeWechatImageUrl(src)
  const showImage = imageSrc && failedSrc !== imageSrc
  const sizeClass = compact ? "size-8" : "size-9"
  const textClass = compact ? "text-xs" : "text-sm"

  if (showImage) {
    return (
      <img
        src={imageSrc}
        alt=""
        referrerPolicy="no-referrer"
        loading="lazy"
        decoding="async"
        className={`avatar-ring ${sizeClass} shrink-0 rounded-md object-cover`}
        onError={(e) => {
          e.currentTarget.style.display = "none"
          setFailedSrc(imageSrc)
        }}
      />
    )
  }
  return (
    <div
      className={`avatar-ring flex ${sizeClass} shrink-0 items-center justify-center rounded-md bg-sidebar-accent ${textClass} font-semibold text-sidebar-primary`}
    >
      {fallback}
    </div>
  )
}
