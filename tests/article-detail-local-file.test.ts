import { expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

test("local Markdown actions refresh the generated-file status", async () => {
  const source = await readFile(
    new URL("../src/components/article-detail.tsx", import.meta.url),
    "utf8"
  )
  const start = source.indexOf("const runLocalFileAction")
  const end = source.indexOf("\n  const copyOriginalLink", start)
  const localFileActions = source.slice(start, end)

  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  expect(localFileActions).toContain("setLocalFile({ path, exists: true })")
  expect(localFileActions).toContain("api.openArticleLocalFile(aid)")
  expect(localFileActions).toContain("api.revealArticleLocalFile(aid)")
  expect(localFileActions).toContain("api.exportArticleLocal(aid)")
})
