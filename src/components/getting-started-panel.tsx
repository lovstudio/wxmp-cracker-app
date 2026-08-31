import type { ReactNode } from "react"
import {
  ArrowRightIcon,
  BookOpenTextIcon,
  CheckCircle2Icon,
  Link2Icon,
  Loader2Icon,
  SearchIcon,
  ShieldCheckIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import type { LicenseStatus } from "@/lib/api"

interface GettingStartedPanelProps {
  lovstudioLoading: boolean
  lovstudioReady: boolean
  lovstudioLabel: string | null
  licenseStatus: LicenseStatus | null
  sourceReady: boolean
  sourceLabel: string | null
  savedAccountCount: number
  articleCount: number
  canClose?: boolean
  onLovstudioLogin: () => void
  onOpenLicense: () => void
  onConnectWechat: () => void
  onAddAccount: () => void
  onClose?: () => void
  presentation?: "page" | "dialog"
}

type GettingStartedDialogProps = Omit<
  GettingStartedPanelProps,
  "canClose" | "onClose" | "presentation"
> & {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type StepState = "complete" | "current" | "upcoming"

export function GettingStartedPanel({
  lovstudioLoading,
  lovstudioReady,
  lovstudioLabel,
  licenseStatus,
  sourceReady,
  sourceLabel,
  savedAccountCount,
  articleCount,
  canClose = false,
  onLovstudioLogin,
  onOpenLicense,
  onConnectWechat,
  onAddAccount,
  onClose,
  presentation = "page",
}: GettingStartedPanelProps) {
  const hasSavedAccount = savedAccountCount > 0
  const completedSteps = [lovstudioReady, sourceReady, hasSavedAccount].filter(
    Boolean
  ).length
  const currentStep = !lovstudioReady
    ? 1
    : !sourceReady
      ? 2
      : !hasSavedAccount
        ? 3
        : null

  const steps: Array<{
    number: number
    icon: ReactNode
    title: string
    description: string
    state: StepState
    status: string
    detail: string
    action: ReactNode
  }> = [
    {
      number: 1,
      icon: <UserRoundIcon className="size-4" />,
      title: "连接 Lovstudio 账号",
      description: "激活状态、账号等级和使用权益都会跟随这个账号保存。",
      state: stepState(lovstudioReady, currentStep === 1),
      status: lovstudioReady ? "已连接" : "待连接",
      detail: lovstudioReady
        ? `${lovstudioLabel ?? "Lovstudio 账号已准备好"} · ${licenseStatus ? licenseSummary(licenseStatus) : "正在读取权益"}`
        : "登录一次，之后打开微探会自动恢复。",
      action: lovstudioReady ? (
        <Button type="button" variant="outline" onClick={onOpenLicense}>
          <ShieldCheckIcon className="size-4" />
          查看账号权益
        </Button>
      ) : (
        <Button
          type="button"
          disabled={lovstudioLoading}
          onClick={onLovstudioLogin}
        >
          {lovstudioLoading ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : (
            <UserRoundIcon className="size-4" />
          )}
          {lovstudioLoading ? "正在检查" : "登录并连接"}
        </Button>
      ),
    },
    {
      number: 2,
      icon: <Link2Icon className="size-4" />,
      title: "准备公众号来源",
      description:
        "连接自己的公众号账号，或直接使用已经保存的公共来源；连接信息会保留在本机。",
      state: stepState(sourceReady, currentStep === 2),
      status: sourceReady ? "已准备" : "待准备",
      detail: sourceReady
        ? (sourceLabel ?? "公众号来源已准备好")
        : "扫码连接后，就可以搜索公众号并获取文章。",
      action: sourceReady ? (
        <Button type="button" variant="outline" onClick={onConnectWechat}>
          <Link2Icon className="size-4" />
          更新连接
        </Button>
      ) : (
        <Button
          type="button"
          disabled={!lovstudioReady}
          onClick={onConnectWechat}
        >
          <Link2Icon className="size-4" />
          连接公众号账号
        </Button>
      ),
    },
    {
      number: 3,
      icon: <BookOpenTextIcon className="size-4" />,
      title: "搜索、下载并使用",
      description:
        "搜索目标公众号，选择文章范围开始采集；已保存的公众号会一直出现在左侧账号库。",
      state: stepState(hasSavedAccount, currentStep === 3),
      status: hasSavedAccount ? "已就绪" : "下一步",
      detail: hasSavedAccount
        ? `已保存 ${savedAccountCount} 个公众号 · ${articleCount.toLocaleString()} 篇文章`
        : "从搜索公众号开始，完成后直接进入阅读工作台。",
      action: hasSavedAccount ? (
        canClose && onClose ? (
          <Button type="button" variant="outline" onClick={onClose}>
            <ArrowRightIcon className="size-4" />
            进入工作台
          </Button>
        ) : null
      ) : (
        <Button
          type="button"
          disabled={!lovstudioReady || !sourceReady}
          onClick={onAddAccount}
        >
          <SearchIcon className="size-4" />
          搜索公众号
        </Button>
      ),
    },
  ]

  return (
    <section className="getting-started flex min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div
        className={
          presentation === "dialog"
            ? "flex w-full flex-col justify-center px-6 py-6 sm:px-8 sm:py-8"
            : "mx-auto flex w-full max-w-5xl flex-col justify-center px-5 py-8 sm:px-8 lg:px-12 lg:py-12"
        }
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.16em] text-primary">
              开始使用
            </p>
            <h1
              className={`mt-3 font-serif text-3xl leading-tight font-semibold text-foreground ${
                presentation === "page" ? "sm:text-4xl" : ""
              }`}
            >
              三步，准备好你的阅读工作台
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              {completedSteps === 3
                ? "准备已经完成。之后重新打开微探，账号和文章都会回到原来的位置。"
                : "只需完成下面三步。每一步都会保存下来，不用在设置里来回寻找入口。"}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge
              variant={completedSteps === 3 ? "default" : "secondary"}
              className="h-7 rounded-full px-3"
            >
              {completedSteps}/3 已完成
            </Badge>
            {presentation === "page" && canClose && onClose ? (
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="返回工作台"
                onClick={onClose}
              >
                <XIcon className="size-4" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="mt-8 grid gap-3 lg:grid-cols-3">
          {steps.map((step) => (
            <SetupStepCard key={step.number} {...step} />
          ))}
        </div>

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card/70 px-4 py-3 text-xs text-muted-foreground shadow-sm">
          <span>
            完成后，左侧保留公众号，中间查看文章，右侧阅读正文与分析内容。
          </span>
          {licenseStatus ? (
            <span className="inline-flex items-center gap-1.5">
              <span
                className={`size-1.5 rounded-full ${licenseStatus.active ? "bg-primary" : "bg-muted-foreground/50"}`}
                aria-hidden="true"
              />
              当前权益：{licenseSummary(licenseStatus)}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function GettingStartedDialog({
  open,
  onOpenChange,
  ...panelProps
}: GettingStartedDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[min(760px,calc(100dvh-32px))] w-[min(960px,calc(100vw-32px))] max-w-none overflow-hidden p-0 sm:max-w-none">
        <DialogHeader className="sr-only">
          <DialogTitle>账号准备</DialogTitle>
          <DialogDescription>
            检查 Lovstudio、公众号来源和文章库的准备状态。
          </DialogDescription>
        </DialogHeader>
        <GettingStartedPanel
          {...panelProps}
          presentation="dialog"
          canClose
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function SetupStepCard({
  number,
  icon,
  title,
  description,
  state,
  status,
  detail,
  action,
}: {
  number: number
  icon: ReactNode
  title: string
  description: string
  state: StepState
  status: string
  detail: string
  action: ReactNode
}) {
  const complete = state === "complete"
  const current = state === "current"

  return (
    <article
      className={`flex min-h-[248px] flex-col rounded-2xl border p-5 transition-colors ${
        current
          ? "border-primary/45 bg-card shadow-md ring-1 ring-primary/10"
          : complete
            ? "border-border bg-card/75"
            : "border-border/70 bg-card/45"
      }`}
      aria-current={current ? "step" : undefined}
    >
      <div className="flex items-start justify-between gap-3">
        <div
          className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${
            complete
              ? "bg-primary/12 text-primary"
              : current
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground"
          }`}
          aria-hidden="true"
        >
          {complete ? <CheckCircle2Icon className="size-4" /> : icon}
        </div>
        <Badge
          variant={complete ? "default" : current ? "secondary" : "outline"}
          className="rounded-full"
        >
          {number}. {status}
        </Badge>
      </div>
      <h2 className="mt-5 font-serif text-xl font-semibold text-foreground">
        {title}
      </h2>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        {description}
      </p>
      <p className="mt-3 min-h-5 truncate text-xs font-medium text-foreground/70">
        {detail}
      </p>
      {action ? <div className="mt-auto pt-5">{action}</div> : null}
    </article>
  )
}

function stepState(complete: boolean, current: boolean): StepState {
  if (complete) return "complete"
  if (current) return "current"
  return "upcoming"
}

function licenseSummary(status: LicenseStatus) {
  if (!status.active) return "基础使用"
  if (status.kind === "official") return "正式授权"
  if (status.days_remaining !== null)
    return `试用中 · 剩余 ${status.days_remaining} 天`
  return "试用中"
}
