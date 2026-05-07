import {
  ArchiveIcon,
  BarChart3Icon,
  BookOpenTextIcon,
  InfoIcon,
  MoonIcon,
  PenLineIcon,
  SunIcon,
  Table2Icon,
} from "lucide-react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useTheme } from "@/components/theme-provider"
import type { ComponentType } from "react"

export type WorkspaceTabId =
  | "reader"
  | "collection"
  | "profile"
  | "trends"
  | "style"

interface TopBarProps {
  accountCount: number
  articleCount: number
  activeTab: WorkspaceTabId
  onTabChange: (tab: WorkspaceTabId) => void
}

const workspaceTabs = [
  { id: "reader", label: "阅读", icon: BookOpenTextIcon },
  { id: "collection", label: "采集管理", icon: Table2Icon },
  { id: "profile", label: "基本信息", icon: InfoIcon },
  { id: "trends", label: "趋势分析", icon: BarChart3Icon },
  { id: "style", label: "文风分析", icon: PenLineIcon },
] satisfies Array<{
  id: WorkspaceTabId
  label: string
  icon: ComponentType<{ className?: string }>
}>

export function TopBar({
  accountCount,
  articleCount,
  activeTab,
  onTabChange,
}: TopBarProps) {
  const { theme, setTheme } = useTheme()
  const isDark = theme === "dark"
  const nextTheme = isDark ? "light" : "dark"

  return (
    <header className="top-bar sticky top-0 z-10 flex h-(--header-height) shrink-0 items-center gap-3 border-b border-border/70 px-4 backdrop-blur-xl">
      <SidebarTrigger className="-ml-1 border border-border/70 bg-card/70 text-foreground shadow-sm" />
      <Separator orientation="vertical" className="h-5 bg-border/70" />
      <nav className="workspace-tab-nav min-w-0 flex-1" aria-label="账号工作区">
        <div className="workspace-tab-list" role="tablist">
          {workspaceTabs.map((tab) => {
            const Icon = tab.icon
            const selected = activeTab === tab.id

            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-active={selected}
                className="workspace-tab"
                onClick={() => onTabChange(tab.id)}
              >
                <Icon className="size-3.5" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
      <div className="hidden items-center gap-2 md:flex">
        <div className="topbar-pill">
          <ArchiveIcon className="size-3.5" />
          <span>{accountCount.toLocaleString()} 个账号</span>
        </div>
        <div className="topbar-pill">
          <span className="font-mono tabular-nums">
            {articleCount.toLocaleString()}
          </span>
          <span>篇文章</span>
        </div>
      </div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
            className="border-border/70 bg-card/70 text-foreground shadow-sm"
            onClick={() => setTheme(nextTheme)}
          >
            {isDark ? (
              <SunIcon className="size-4" />
            ) : (
              <MoonIcon className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {isDark ? "切换浅色主题" : "切换深色主题"}
        </TooltipContent>
      </Tooltip>
    </header>
  )
}
