import type { Account, FetchAccountProgress, FetchMode } from "@/lib/api"

export type CollectionTask = FetchMode | "content"

export const RESUME_MODE_LABELS: Record<CollectionTask, string> = {
  forward: "向前续抓",
  backward: "向后续抓",
  audit: "完备性回扫",
  classify: "分类回填",
  content: "补齐正文",
}

export function initialResumeProgress(
  account: Pick<Account, "fakeid" | "nickname">,
  limit: number,
  mode: CollectionTask = "forward",
  auditDate: string | null = null
): FetchAccountProgress {
  const label = RESUME_MODE_LABELS[mode]
  const message =
    mode === "audit"
      ? auditDate
        ? `已确认目标：${account.nickname}（${account.fakeid}），检测 ${auditDate} 当天`
        : `已确认目标：${account.nickname}（${account.fakeid}），重扫 ${limit.toLocaleString()} 篇索引`
      : mode === "content"
        ? `已确认目标：${account.nickname}（${account.fakeid}），补齐 ${limit.toLocaleString()} 篇正文`
        : mode === "classify"
          ? `已确认目标：${account.nickname}（${account.fakeid}），回填 ${limit.toLocaleString()} 篇旧文章分类`
        : `已确认目标：${account.nickname}（${account.fakeid}），${label} ${limit.toLocaleString()} 篇文章索引`

  return {
    fakeid: account.fakeid,
    nickname: account.nickname,
    stage: "prepare",
    status: "done",
    message,
    current: 0,
    total: limit,
    title: null,
  }
}
