import type { Account, ArticleSummary, ArticleTag } from "@/lib/api"

interface ArticleTagHandoffInput {
  tag: ArticleTag
  articles: ArticleSummary[]
  accounts: Account[]
}

export function buildArticleTagHandoff({
  tag,
  articles,
  accounts,
}: ArticleTagHandoffInput): string {
  const accountNames = new Map(
    accounts.map((account) => [account.fakeid, account.nickname])
  )
  const orderedArticles = [...articles].sort(
    (left, right) =>
      right.create_time - left.create_time || left.aid.localeCompare(right.aid)
  )
  const payload = {
    schema: "wxmp-article-tag-index/v1",
    instruction:
      "articles 是该标签当前关联的完整本地文章索引；aid 与 fakeid 是文章和公众号的稳定主键。",
    tag: {
      id: tag.id,
      name: tag.name,
      article_count: orderedArticles.length,
    },
    articles: orderedArticles.map((article) => ({
      aid: article.aid,
      fakeid: article.fakeid,
      account_name: accountNames.get(article.fakeid) ?? null,
      title: article.title,
      link: article.link,
      digest: article.digest,
      cover: article.cover,
      author: article.author,
      create_time: article.create_time,
      published_at: new Date(article.create_time * 1000).toISOString(),
      has_content: article.has_content,
      article_type: article.article_type ?? null,
      copyright_type: article.copyright_type ?? null,
    })),
  }

  return [
    `微探标签文章索引：${tag.name}`,
    "",
    "以下 JSON 包含该标签及其关联的全部文章索引。",
    JSON.stringify(payload, null, 2),
  ].join("\n")
}
