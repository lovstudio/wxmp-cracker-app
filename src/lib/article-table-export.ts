import {
  articleTypeBucket,
  articleTagFilterValue,
  copyrightBucket,
  filterArticles,
  type ArticleFilters,
  type ArticleTagFilter,
} from "@/lib/article-filters"
import type { ArticleSummary } from "@/lib/api"

export type ArticleTableColumnId =
  | "title"
  | "tags"
  | "digest"
  | "author"
  | "published_at"
  | "create_time"
  | "content_status"
  | "article_type"
  | "copyright"
  | "aid"
  | "fakeid"
  | "link"
  | "cover"
  | "local_file_path"

export type ArticleAuthorFilter = "all" | "missing" | `author:${string}`
export type ArticleLocalFileFilter = "all" | "generated" | "missing"
export type ArticlePresenceFilter = "all" | "present" | "missing"
export type ArticleCompletenessFilter =
  | "all"
  | "complete"
  | "missing_author"
  | "missing_digest"
  | "missing_cover"
  | "missing_tags"

export interface ArticleManagementFilters {
  tag: ArticleTagFilter
  author: ArticleAuthorFilter
  publishedFrom: string
  publishedTo: string
  originalUrl: ArticlePresenceFilter
  coverUrl: ArticlePresenceFilter
  localFile: ArticleLocalFileFilter
  completeness: ArticleCompletenessFilter
}

export const DEFAULT_ARTICLE_MANAGEMENT_FILTERS: ArticleManagementFilters = {
  tag: "all",
  author: "all",
  publishedFrom: "",
  publishedTo: "",
  originalUrl: "all",
  coverUrl: "all",
  localFile: "all",
  completeness: "all",
}

export const ARTICLE_TABLE_COLUMNS: ReadonlyArray<{
  id: ArticleTableColumnId
  label: string
}> = [
  { id: "title", label: "标题" },
  { id: "tags", label: "标签" },
  { id: "digest", label: "摘要" },
  { id: "author", label: "作者" },
  { id: "published_at", label: "发布时间" },
  { id: "create_time", label: "发布时间戳" },
  { id: "content_status", label: "正文状态" },
  { id: "article_type", label: "内容形态" },
  { id: "copyright", label: "版权属性" },
  { id: "aid", label: "文章 ID" },
  { id: "fakeid", label: "公众号 ID" },
  { id: "link", label: "原文网址" },
  { id: "cover", label: "封面网址" },
  { id: "local_file_path", label: "文件地址" },
]

export const DEFAULT_ARTICLE_TABLE_COLUMNS: ArticleTableColumnId[] = [
  "title",
  "tags",
  "content_status",
  "author",
  "published_at",
  "article_type",
  "copyright",
  "link",
  "local_file_path",
]

export function filterArticleTableRows(
  articles: ArticleSummary[],
  query: string,
  filters: ArticleFilters,
  managementFilters: ArticleManagementFilters = DEFAULT_ARTICLE_MANAGEMENT_FILTERS
) {
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN")
  const filtered = filterArticleManagementRows(
    filterArticles(articles, filters),
    managementFilters
  )
  if (!normalizedQuery) return filtered

  return filtered.filter((article) =>
    [
      article.title,
      article.digest,
      article.author,
      article.aid,
      article.link,
      article.cover,
      article.local_file_path,
      ...(article.tags ?? []),
    ]
      .filter((value): value is string => Boolean(value))
      .some((value) =>
        value.toLocaleLowerCase("zh-CN").includes(normalizedQuery)
      )
  )
}

export function activeArticleManagementFilterCount(
  filters: ArticleManagementFilters
) {
  return [
    filters.tag !== "all",
    filters.author !== "all",
    Boolean(filters.publishedFrom),
    Boolean(filters.publishedTo),
    filters.originalUrl !== "all",
    filters.coverUrl !== "all",
    filters.localFile !== "all",
    filters.completeness !== "all",
  ].filter(Boolean).length
}

export function articleManagementTagValue(tag: string): ArticleTagFilter {
  return articleTagFilterValue(tag)
}

export function articleManagementAuthorValue(
  author: string
): ArticleAuthorFilter {
  return `author:${author}`
}

function filterArticleManagementRows(
  articles: ArticleSummary[],
  filters: ArticleManagementFilters
) {
  const publishedFrom = localDateBoundary(filters.publishedFrom, "start")
  const publishedTo = localDateBoundary(filters.publishedTo, "end")

  if (
    publishedFrom !== null &&
    publishedTo !== null &&
    publishedFrom > publishedTo
  ) {
    return []
  }

  return articles.filter((article) => {
    const tags = (article.tags ?? []).map((tag) => tag.trim()).filter(Boolean)
    const author = article.author?.trim() ?? ""
    const digest = article.digest?.trim() ?? ""
    const originalUrl = article.link?.trim() ?? ""
    const cover = article.cover?.trim() ?? ""
    const localFilePath = article.local_file_path?.trim() ?? ""

    if (filters.tag === "tagged" && tags.length === 0) return false
    if (filters.tag === "untagged" && tags.length > 0) return false
    if (
      filters.tag.startsWith("tag:") &&
      !tags.includes(filters.tag.slice("tag:".length))
    ) {
      return false
    }

    if (filters.author === "missing" && author) return false
    if (
      filters.author.startsWith("author:") &&
      author !== filters.author.slice("author:".length)
    ) {
      return false
    }

    if (publishedFrom !== null && article.create_time < publishedFrom) {
      return false
    }
    if (publishedTo !== null && article.create_time > publishedTo) {
      return false
    }

    if (filters.originalUrl === "present" && !originalUrl) return false
    if (filters.originalUrl === "missing" && originalUrl) return false
    if (filters.coverUrl === "present" && !cover) return false
    if (filters.coverUrl === "missing" && cover) return false

    if (filters.localFile === "generated" && !localFilePath) return false
    if (filters.localFile === "missing" && localFilePath) return false

    if (
      filters.completeness === "complete" &&
      (!author || !digest || !cover || tags.length === 0)
    ) {
      return false
    }
    if (filters.completeness === "missing_author" && author) return false
    if (filters.completeness === "missing_digest" && digest) return false
    if (filters.completeness === "missing_cover" && cover) return false
    if (filters.completeness === "missing_tags" && tags.length > 0) {
      return false
    }

    return true
  })
}

function localDateBoundary(value: string, boundary: "start" | "end") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null

  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(
    year,
    month - 1,
    boundary === "end" ? day + 1 : day,
    0,
    0,
    0,
    0
  )
  const timestamp = Math.floor(date.getTime() / 1000)
  return boundary === "end" ? timestamp - 1 : timestamp
}

export function buildArticleTableCsv(
  articles: ArticleSummary[],
  columns: ArticleTableColumnId[]
) {
  if (columns.length === 0) {
    throw new Error("至少选择一列后才能导出")
  }

  const labels = new Map(
    ARTICLE_TABLE_COLUMNS.map((column) => [column.id, column.label])
  )
  const rows = [
    columns.map((column) => labels.get(column) ?? column),
    ...articles.map((article) =>
      columns.map((column) => articleTableCellValue(article, column))
    ),
  ]

  return `\uFEFF${rows
    .map((row) => row.map(csvCell).join(","))
    .join("\r\n")}\r\n`
}

export function articleTableCellValue(
  article: ArticleSummary,
  column: ArticleTableColumnId
): string {
  if (column === "title") return article.title
  if (column === "tags") return (article.tags ?? []).join("、")
  if (column === "digest") return article.digest ?? ""
  if (column === "author") return article.author ?? ""
  if (column === "published_at") {
    return new Date(article.create_time * 1000).toISOString()
  }
  if (column === "create_time") return String(article.create_time)
  if (column === "content_status") {
    return article.has_content ? "正文已采集" : "正文未采集"
  }
  if (column === "article_type") return articleTypeLabel(article.article_type)
  if (column === "copyright") return copyrightLabel(article.copyright_type)
  if (column === "aid") return article.aid
  if (column === "fakeid") return article.fakeid
  if (column === "link") return article.link
  if (column === "cover") return article.cover ?? ""
  return article.local_file_path ?? ""
}

export function articleTypeLabel(value: number | null | undefined) {
  const bucket = articleTypeBucket(value)
  if (bucket === "article") return "图文"
  if (bucket === "sticker") return "贴图"
  return "其他 / 未标注"
}

export function copyrightLabel(value: number | null | undefined) {
  const bucket = copyrightBucket(value)
  if (bucket === "original") return "原创"
  if (bucket === "reprint") return "转载"
  if (bucket === "default") return "默认"
  return "未标注"
}

export function articleTableExportFileName(
  accountName: string,
  date = new Date()
) {
  const datePart = date.toISOString().slice(0, 10)
  const safeAccountName = accountName
    .trim()
    .replace(/[\\/:*?"<>|]/g, "-")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "-" : character))
    .join("")
    .replace(/\s+/g, " ")
    .slice(0, 48)
  return `微探-${safeAccountName || "公众号"}-文章-${datePart}.csv`
}

function csvCell(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}
