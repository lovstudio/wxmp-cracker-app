import type { Account, FetchAccountProgress, FetchMode } from "@/lib/api"

export type CollectionTask = FetchMode | "content"

export const RESUME_MODE_LABELS: Record<CollectionTask, string> = {
  forward: "采集新文章",
  backward: "采集历史文章",
  audit: "完整性校验",
  classify: "分类补全",
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
        ? `已确认目标：${account.nickname}，检测 ${auditDate} 当天`
        : `已确认目标：${account.nickname}，校验 ${limit.toLocaleString()} 篇文章`
      : mode === "content"
        ? `已确认目标：${account.nickname}，补齐 ${limit.toLocaleString()} 篇正文`
        : mode === "classify"
          ? `已确认目标：${account.nickname}，补全 ${limit.toLocaleString()} 篇文章分类`
        : `已确认目标：${account.nickname}，${label} ${limit.toLocaleString()} 篇文章`

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
