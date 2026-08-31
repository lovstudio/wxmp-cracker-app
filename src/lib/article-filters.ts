import type { ArticleSummary } from "@/lib/api"

export type ArticleTypeFilter = "all" | "article" | "sticker" | "other"
export type CopyrightFilter =
  | "all"
  | "default"
  | "original"
  | "reprint"
  | "unknown"
export type ContentCacheFilter = "all" | "cached" | "missing"
export type ArticleTagFilter = "all" | "tagged" | "untagged" | `tag:${string}`

export interface ArticleFilters {
  articleType: ArticleTypeFilter
  copyright: CopyrightFilter
  contentCache: ContentCacheFilter
}

export const DEFAULT_ARTICLE_FILTERS: ArticleFilters = {
  articleType: "all",
  copyright: "all",
  contentCache: "all",
}

export function filterArticles(
  articles: ArticleSummary[],
  filters: ArticleFilters
) {
  return articles.filter((article) => {
    if (
      filters.articleType !== "all" &&
      articleTypeBucket(article.article_type) !== filters.articleType
    ) {
      return false
    }
    if (
      filters.copyright !== "all" &&
      copyrightBucket(article.copyright_type) !== filters.copyright
    ) {
      return false
    }
    if (filters.contentCache === "cached" ? !article.has_content : false) {
      return false
    }
    if (filters.contentCache === "missing" ? article.has_content : false) {
      return false
    }
    return true
  })
}

export function activeArticleFilterCount(filters: ArticleFilters) {
  return Object.values(filters).filter((value) => value !== "all").length
}

export function filterArticlesByTag(
  articles: ArticleSummary[],
  tagFilter: ArticleTagFilter
) {
  if (tagFilter === "all") return articles

  return articles.filter((article) => {
    const tags = normalizedArticleTags(article)
    if (tagFilter === "tagged") return tags.length > 0
    if (tagFilter === "untagged") return tags.length === 0
    return tags.includes(tagFilter.slice("tag:".length))
  })
}

export function articleTagFilterValue(tag: string): ArticleTagFilter {
  return `tag:${tag}`
}

export function articleTagFilterName(tagFilter: ArticleTagFilter) {
  return tagFilter.startsWith("tag:") ? tagFilter.slice("tag:".length) : null
}

function normalizedArticleTags(article: ArticleSummary) {
  return (article.tags ?? []).map((tag) => tag.trim()).filter(Boolean)
}

export function articleTypeBucket(
  value: number | null | undefined
): Exclude<ArticleTypeFilter, "all"> {
  if (value === 9) return "article"
  if (value === 10002) return "sticker"
  return "other"
}

export function copyrightBucket(
  value: number | null | undefined
): Exclude<CopyrightFilter, "all"> {
  if (value === 0) return "default"
  if (value === 1) return "original"
  if (value === 2) return "reprint"
  return "unknown"
}
