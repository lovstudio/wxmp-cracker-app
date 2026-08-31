import { describe, expect, test } from "bun:test"
import { buildArticleTagHandoff } from "../src/lib/article-tag-handoff"
import type { Account, ArticleSummary, ArticleTag } from "../src/lib/api"

const tag: ArticleTag = {
  id: 7,
  name: "产品洞察",
  article_count: 99,
  assigned: false,
}

const accounts: Account[] = [
  {
    fakeid: "account-1",
    nickname: "手工川",
    alias: null,
    signature: null,
    avatar: null,
    article_count: 2,
  },
]

const article = (aid: string, createTime: number): ArticleSummary => ({
  aid,
  fakeid: "account-1",
  title: `文章 ${aid}`,
  link: `https://mp.weixin.qq.com/s/${aid}`,
  digest: `摘要 ${aid}`,
  cover: null,
  author: "作者",
  create_time: createTime,
  has_content: aid === "newest",
  article_type: 9,
  copyright_type: 1,
})

describe("buildArticleTagHandoff", () => {
  test("copies the tag with every linked article index in stable order", () => {
    const text = buildArticleTagHandoff({
      tag,
      accounts,
      articles: [article("oldest", 1), article("newest", 5)],
    })

    expect(text).toContain("微探标签文章索引：产品洞察")
    expect(text).toContain('"schema": "wxmp-article-tag-index/v1"')
    expect(text).toContain('"article_count": 2')
    expect(text).toContain('"account_name": "手工川"')
    expect(text).toContain('"aid": "newest"')
    expect(text).toContain('"aid": "oldest"')
    expect(text.indexOf('"aid": "newest"')).toBeLessThan(
      text.indexOf('"aid": "oldest"')
    )
    expect(text).toContain('"has_content": true')
    expect(text).toContain('"article_type": 9')
  })

  test("uses the actual copied index count and keeps unknown accounts explicit", () => {
    const orphan = { ...article("orphan", 3), fakeid: "missing-account" }
    const text = buildArticleTagHandoff({
      tag,
      accounts: [],
      articles: [orphan],
    })

    expect(text).toContain('"article_count": 1')
    expect(text).toContain('"account_name": null')
    expect(text).not.toContain('"article_count": 99')
  })
})
