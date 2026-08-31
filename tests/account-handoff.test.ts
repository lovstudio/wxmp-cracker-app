import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { buildAccountAgentHandoff } from "../src/lib/account-handoff"
import type { Account, ArticleSummary } from "../src/lib/api"

const account: Account = {
  fakeid: "fake'id",
  nickname: "手工川",
  alias: "craft-river",
  signature: "做手工",
  avatar: "https://example.com/avatar.jpg",
  article_count: 5,
}

const article = (aid: string, createTime: number): ArticleSummary => ({
  aid,
  fakeid: account.fakeid,
  title: `文章 ${aid}`,
  link: `https://mp.weixin.qq.com/s/${aid}`,
  digest: null,
  cover: null,
  author: null,
  create_time: createTime,
  has_content: aid !== "oldest",
})

describe("buildAccountAgentHandoff", () => {
  test("provides stable database and archive locators without exporting files", () => {
    const text = buildAccountAgentHandoff({
      account,
      articles: [
        article("oldest", 1),
        article("latest", 5),
        article("third", 3),
        article("second", 4),
        article("fourth", 2),
      ],
      cacheDbPath: "/Users/mark/Library/Application Support/wcx/cache.db",
    })

    expect(text).toContain('"fakeid": "fake\'id"')
    expect(text).toContain(
      '"sqlite_database": "/Users/mark/Library/Application Support/wcx/cache.db"'
    )
    expect(text).toContain(
      '"markdown_archive_index": "/Users/mark/Library/Application Support/wcx/archive/index.json"'
    )
    expect(text).toContain("WHERE fakeid = 'fake''id'")
    expect(text).toContain('"article_count": 5')
    expect(text).toContain('"indexed_articles": 5')
    expect(text).toContain('"articles_with_cached_content": 4')
    expect(text).toContain('"aid": "latest"')
    expect(text).toContain('"aid": "oldest"')
    expect(text).not.toContain('"aid": "fourth"')
  })

  test("derives Windows archive paths", () => {
    const text = buildAccountAgentHandoff({
      account,
      articles: [],
      cacheDbPath: "C:\\Users\\mark\\AppData\\Roaming\\wcx\\cache.db",
    })

    expect(text).toContain(
      '"markdown_archive_index": "C:\\\\Users\\\\mark\\\\AppData\\\\Roaming\\\\wcx\\\\archive\\\\index.json"'
    )
  })
})

test("copying account locators never starts an archive export", async () => {
  const source = await readFile(
    new URL("../src/components/account-sidebar.tsx", import.meta.url),
    "utf8"
  )
  const start = source.indexOf("async function copyAccountBasicInfo")
  const end = source.indexOf("\nfunction errorMessage", start)
  const copyFlow = source.slice(start, end)

  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  expect(copyFlow).toContain("buildAccountAgentHandoff")
  expect(copyFlow).not.toContain("archiveArticlesLocal")
})
