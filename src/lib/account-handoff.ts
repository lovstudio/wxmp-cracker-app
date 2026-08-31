import type { Account, ArticleSummary } from "@/lib/api"

interface AccountAgentHandoffInput {
  account: Account
  articles: ArticleSummary[]
  cacheDbPath: string
}

export function buildAccountAgentHandoff({
  account,
  articles,
  cacheDbPath,
}: AccountAgentHandoffInput): string {
  const archiveRoot = joinSiblingPath(cacheDbPath, "archive")
  const orderedArticles = [...articles].sort(
    (left, right) => right.create_time - left.create_time
  )
  const exampleArticles = uniqueArticleAnchors(orderedArticles)
  const escapedFakeid = account.fakeid.replaceAll("'", "''")

  const locator = {
    schema: "wxmp-account-agent-handoff/v1",
    instruction:
      "始终用 account.fakeid 作为公众号唯一主键；名称、微信号和签名只用于人工核对。",
    account: {
      fakeid: account.fakeid,
      nickname: account.nickname,
      alias: account.alias,
      signature: account.signature,
      avatar: account.avatar,
      article_count: account.article_count,
    },
    local_state: {
      indexed_articles: articles.length,
      articles_with_cached_content: articles.filter(
        (article) => article.has_content
      ).length,
    },
    storage: {
      sqlite_database: cacheDbPath,
      sqlite_accounts_table: "accounts",
      sqlite_articles_table: "articles",
      markdown_archive_root: archiveRoot,
      markdown_archive_index: joinLocalPath(archiveRoot, "index.json"),
      markdown_lookup_rule:
        "读取 index.json 的 articles 对象，筛选 value.fakeid 等于 account.fakeid；value.markdown_path 是相对 markdown_archive_root 的文章文件路径。若索引或文件不存在，以 SQLite 为准，说明正文尚未导出为 Markdown。",
    },
    queries: {
      account_sql: `SELECT fakeid, nickname, alias, signature, round_head_img, updated_at FROM accounts WHERE fakeid = '${escapedFakeid}';`,
      articles_sql: `SELECT aid, fakeid, title, link, digest, author, create_time, CASE WHEN NULLIF(TRIM(content_md), '') IS NOT NULL OR NULLIF(TRIM(content_html), '') IS NOT NULL THEN 1 ELSE 0 END AS has_content FROM articles WHERE fakeid = '${escapedFakeid}' ORDER BY create_time DESC;`,
    },
    verification_article_anchors: exampleArticles.map((article) => ({
      aid: article.aid,
      title: article.title,
      link: article.link,
      create_time: article.create_time,
      has_content: article.has_content,
    })),
  }

  return [
    "微探公众号定位信息（供 Agent 使用）",
    "",
    "以下 JSON 描述本机权威数据源和精确查询方式。",
    JSON.stringify(locator, null, 2),
  ].join("\n")
}

function uniqueArticleAnchors(articles: ArticleSummary[]): ArticleSummary[] {
  if (articles.length <= 4) return articles

  return [...articles.slice(0, 3), articles[articles.length - 1]]
}

function joinSiblingPath(filePath: string, sibling: string): string {
  const separatorIndex = Math.max(
    filePath.lastIndexOf("/"),
    filePath.lastIndexOf("\\")
  )
  if (separatorIndex < 0) return sibling

  return joinLocalPath(filePath.slice(0, separatorIndex), sibling)
}

function joinLocalPath(parent: string, child: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return `${parent.replace(/[\\/]+$/, "")}${separator}${child}`
}
