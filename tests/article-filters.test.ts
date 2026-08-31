import { describe, expect, test } from "bun:test"
import {
  activeArticleFilterCount,
  articleTagFilterName,
  articleTagFilterValue,
  filterArticles,
  filterArticlesByTag,
  type ArticleFilters,
} from "../src/lib/article-filters"
import type { ArticleSummary } from "../src/lib/api"

const article = (
  aid: string,
  articleType: number | null,
  copyrightType: number | null,
  hasContent = true,
  tags: string[] = []
): ArticleSummary => ({
  aid,
  fakeid: "account",
  title: aid,
  link: `https://mp.weixin.qq.com/s/${aid}`,
  digest: null,
  cover: null,
  author: null,
  create_time: 1,
  has_content: hasContent,
  article_type: articleType,
  copyright_type: copyrightType,
  tags,
})

const filters = (overrides: Partial<ArticleFilters>): ArticleFilters => ({
  articleType: "all",
  copyright: "all",
  contentCache: "all",
  ...overrides,
})

describe("article filters", () => {
  const articles = [
    article("original-article", 9, 1),
    article("reprinted-article", 9, 2, false),
    article("default-sticker", 10002, 0),
    article("legacy", null, null),
  ]

  test("combines content type, copyright, and cache filters", () => {
    expect(
      filterArticles(
        articles,
        filters({ articleType: "article", copyright: "original" })
      ).map((item) => item.aid)
    ).toEqual(["original-article"])

    expect(
      filterArticles(articles, filters({ contentCache: "missing" })).map(
        (item) => item.aid
      )
    ).toEqual(["reprinted-article"])
  })

  test("keeps legacy and unrecognized metadata in explicit buckets", () => {
    expect(
      filterArticles(articles, filters({ articleType: "other" })).map(
        (item) => item.aid
      )
    ).toEqual(["legacy"])
    expect(
      filterArticles(articles, filters({ copyright: "unknown" })).map(
        (item) => item.aid
      )
    ).toEqual(["legacy"])
  })

  test("reports the number of active dimensions", () => {
    expect(activeArticleFilterCount(filters({}))).toBe(0)
    expect(
      activeArticleFilterCount(
        filters({ articleType: "sticker", contentCache: "cached" })
      )
    ).toBe(2)
  })

  test("filters tagged, untagged, and exact-tag articles", () => {
    const taggedArticles = [
      article("research", 9, 1, true, ["研究", "精选"]),
      article("product", 9, 1, true, ["产品"]),
      article("untagged", 9, 1),
    ]

    expect(
      filterArticlesByTag(taggedArticles, "tagged").map((item) => item.aid)
    ).toEqual(["research", "product"])
    expect(
      filterArticlesByTag(taggedArticles, "untagged").map((item) => item.aid)
    ).toEqual(["untagged"])
    expect(
      filterArticlesByTag(taggedArticles, articleTagFilterValue("精选")).map(
        (item) => item.aid
      )
    ).toEqual(["research"])
    expect(articleTagFilterName(articleTagFilterValue("精选"))).toBe("精选")
  })
})
