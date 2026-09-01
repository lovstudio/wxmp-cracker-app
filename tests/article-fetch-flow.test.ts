import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { initialResumeProgress } from "../src/lib/article-fetch-progress"
import type { Account } from "../src/lib/api"

const account: Account = {
  fakeid: "Mzg2OTg5NDg3Mg==",
  nickname: "手工川",
  alias: null,
  signature: null,
  avatar: null,
  article_count: 216,
}

describe("article fetch authentication flow", () => {
  test("the progress dialog starts with a confirmed, explicit target", () => {
    const progress = initialResumeProgress(account, 10, "forward")

    expect(progress.stage).toBe("prepare")
    expect(progress.status).toBe("done")
    expect(progress.message).toContain("已确认目标：手工川")
    expect(progress.message).toContain(account.fakeid)

    const contentProgress = initialResumeProgress(account, 179, "content")
    expect(contentProgress.status).toBe("done")
    expect(contentProgress.message).toContain("补齐 179 篇正文")

    const classificationProgress = initialResumeProgress(
      account,
      226,
      "classify"
    )
    expect(classificationProgress.status).toBe("done")
    expect(classificationProgress.message).toContain("回填 226 篇旧文章分类")
  })

  test("login is gated before progress and the dialog is the only status surface", async () => {
    const source = await readFile(
      new URL("../src/components/article-list.tsx", import.meta.url),
      "utf8"
    )
    const gateStart = source.indexOf("const resumeCollection = async")
    const gateEnd = source.indexOf("const runFillMissingContents", gateStart)
    const gate = source.slice(gateStart, gateEnd)
    const runStart = source.indexOf("const runResumeCollection = async")
    const runEnd = source.indexOf("const resumeCollection = async", runStart)
    const progressFlow = source.slice(runStart, runEnd)
    const fillStart = source.indexOf("const runFillMissingContents = async")
    const fillEnd = source.indexOf(
      "const fillMissingContents = async",
      fillStart
    )
    const fillProgressFlow = source.slice(fillStart, fillEnd)

    expect(gateStart).toBeGreaterThan(-1)
    expect(gateEnd).toBeGreaterThan(gateStart)
    expect(gate.indexOf("!wechatLoggedIn")).toBeLessThan(
      gate.indexOf("runResumeCollection")
    )
    expect(gate).toContain("queueWechatAction")
    expect(progressFlow).toContain("setResumeDialogOpen(true)")
    expect(progressFlow).not.toContain("toast.")
    expect(fillProgressFlow).toContain("setResumeDialogOpen(true)")
    expect(fillProgressFlow).not.toContain("toast.")
  })

  test("rate limiting is never presented as a login recovery action", async () => {
    const dialogSource = await readFile(
      new URL("../src/components/add-account-dialog.tsx", import.meta.url),
      "utf8"
    )
    const toastSource = await readFile(
      new URL("../src/lib/toast.ts", import.meta.url),
      "utf8"
    )

    expect(dialogSource).not.toContain("完成验证后重新登录")
    expect(dialogSource).toContain("重新登录不会解除")
    expect(dialogSource).toContain("改用文章链接")

    const rateLimitBranchStart = toastSource.indexOf(
      ": isWxmpRateLimitError(message)"
    )
    const rateLimitBranchEnd = toastSource.indexOf(
      ': showCopyableToast("error", message, options)',
      rateLimitBranchStart
    )
    const rateLimitBranch = toastSource.slice(
      rateLimitBranchStart,
      rateLimitBranchEnd
    )

    expect(rateLimitBranchStart).toBeGreaterThan(-1)
    expect(rateLimitBranchEnd).toBeGreaterThan(rateLimitBranchStart)
    expect(rateLimitBranch).toContain("showCopyableToast")
    expect(rateLimitBranch).not.toContain("showWxmpRecoveryToast")
  })

  test("the UI and packaged sidecar preserve the stable-id acquisition split", async () => {
    const [dialogSource, availabilitySource, sidecarBuildSource] =
      await Promise.all([
        readFile(
          new URL("../src/components/add-account-dialog.tsx", import.meta.url),
          "utf8"
        ),
        readFile(
          new URL("../src/lib/wxmp-availability.ts", import.meta.url),
          "utf8"
        ),
        readFile(
          new URL("../scripts/build-wcx-sidecar.sh", import.meta.url),
          "utf8"
        ),
      ])

    expect(availabilitySource).toContain(
      "searchbiz 只负责把名称解析为稳定 ID（fakeid）"
    )
    expect(availabilitySource).toContain("自有号读取后台发表记录")
    expect(availabilitySource).toContain("外部号从公开索引发现候选")
    expect(availabilitySource).toContain("用文章内 biz 与该 ID 核验归属")
    expect(dialogSource).not.toContain("准备按公众号 ID 抓取")
    expect(sidecarBuildSource).toContain("--hidden-import wcx.public_index")
  })
})
