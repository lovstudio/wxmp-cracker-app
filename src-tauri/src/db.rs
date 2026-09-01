use anyhow::{bail, Context, Result};
use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use std::{collections::HashMap, fs, path::PathBuf};

/// Locate wcx's cache.db. Mirrors wcx's own logic: macOS = ~/Library/Application Support/wcx,
/// Linux = $XDG_DATA_HOME/wcx or ~/.local/share/wcx, Windows = %APPDATA%/wcx.
pub fn cache_db_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    Ok(base.join("wcx").join("cache.db"))
}

pub fn config_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    Ok(base.join("wcx").join("config.json"))
}

fn open() -> Result<Connection> {
    let p = cache_db_path()?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir {:?}", parent))?;
    }
    let conn = Connection::open(&p).with_context(|| format!("open {:?}", p))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    ensure_runtime_schema(&conn)?;
    Ok(conn)
}

fn ensure_runtime_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS accounts (
             fakeid TEXT PRIMARY KEY,
             nickname TEXT NOT NULL,
             alias TEXT,
             signature TEXT,
             round_head_img TEXT,
             updated_at INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS articles (
             aid TEXT PRIMARY KEY,
             fakeid TEXT NOT NULL,
             title TEXT NOT NULL,
             link TEXT NOT NULL,
             digest TEXT,
             cover TEXT,
             author TEXT,
             create_time INTEGER NOT NULL,
             update_time INTEGER,
             article_type INTEGER,
             copyright_type INTEGER,
             content_html TEXT,
             content_md TEXT,
             fetched_at INTEGER NOT NULL,
             FOREIGN KEY (fakeid) REFERENCES accounts(fakeid)
         );

         CREATE INDEX IF NOT EXISTS idx_articles_fakeid
             ON articles(fakeid);
         CREATE INDEX IF NOT EXISTS idx_articles_create_time
             ON articles(create_time DESC);
         CREATE INDEX IF NOT EXISTS idx_articles_fakeid_create_time
             ON articles(fakeid, create_time DESC);
         CREATE INDEX IF NOT EXISTS idx_accounts_updated_at
             ON accounts(updated_at DESC);

         CREATE TABLE IF NOT EXISTS article_tags (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             name TEXT NOT NULL COLLATE NOCASE UNIQUE,
             created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
             updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
             CHECK(length(TRIM(name)) BETWEEN 1 AND 24)
         );

         CREATE TABLE IF NOT EXISTS article_tag_links (
             aid TEXT NOT NULL,
             tag_id INTEGER NOT NULL,
             created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
             PRIMARY KEY (aid, tag_id),
             FOREIGN KEY (aid) REFERENCES articles(aid) ON DELETE CASCADE,
             FOREIGN KEY (tag_id) REFERENCES article_tags(id) ON DELETE CASCADE
         );

         CREATE INDEX IF NOT EXISTS idx_article_tag_links_tag_id
             ON article_tag_links(tag_id);",
    )?;
    ensure_article_metadata_columns(conn)?;
    Ok(())
}

fn ensure_article_metadata_columns(conn: &Connection) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(articles)")?;
    let columns = stmt
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    if !columns.iter().any(|column| column == "article_type") {
        conn.execute("ALTER TABLE articles ADD COLUMN article_type INTEGER", [])?;
    }
    if !columns.iter().any(|column| column == "copyright_type") {
        conn.execute("ALTER TABLE articles ADD COLUMN copyright_type INTEGER", [])?;
    }
    Ok(())
}

#[derive(Serialize, Debug, Clone)]
pub struct Account {
    pub fakeid: String,
    pub nickname: String,
    pub alias: Option<String>,
    pub signature: Option<String>,
    pub avatar: Option<String>,
    pub article_count: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct ArticleSummary {
    pub aid: String,
    pub fakeid: String,
    pub title: String,
    pub link: String,
    pub digest: Option<String>,
    pub cover: Option<String>,
    pub author: Option<String>,
    pub create_time: i64,
    pub has_content: bool,
    pub article_type: Option<i64>,
    pub copyright_type: Option<i64>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub match_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_excerpt: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ArticleTag {
    pub id: i64,
    pub name: String,
    pub article_count: i64,
    pub assigned: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct ArticleDetail {
    pub aid: String,
    pub fakeid: String,
    pub title: String,
    pub link: String,
    pub digest: Option<String>,
    pub cover: Option<String>,
    pub author: Option<String>,
    pub create_time: i64,
    pub has_content: bool,
    pub article_type: Option<i64>,
    pub copyright_type: Option<i64>,
    pub content_html: Option<String>,
    pub content_md: Option<String>,
}

pub struct AccountUpsert<'a> {
    pub fakeid: &'a str,
    pub nickname: &'a str,
    pub alias: Option<&'a str>,
    pub signature: Option<&'a str>,
    pub avatar: Option<&'a str>,
}

pub struct ArticleUpsert<'a> {
    pub aid: &'a str,
    pub fakeid: &'a str,
    pub title: &'a str,
    pub link: &'a str,
    pub digest: Option<&'a str>,
    pub cover: Option<&'a str>,
    pub author: Option<&'a str>,
    pub create_time: i64,
    pub update_time: Option<i64>,
    pub article_type: Option<i64>,
    pub copyright_type: Option<i64>,
    pub content_html: Option<&'a str>,
    pub content_md: Option<&'a str>,
}

pub fn merge_account_metadata_if_exists(account: &AccountUpsert<'_>) -> Result<bool> {
    let conn = open()?;
    merge_account_metadata(&conn, account)
}

pub fn upsert_account_metadata(account: &AccountUpsert<'_>) -> Result<()> {
    let conn = open()?;
    upsert_account(&conn, account)
}

fn merge_account_metadata(conn: &Connection, account: &AccountUpsert<'_>) -> Result<bool> {
    let changed = conn.execute(
        "UPDATE accounts
         SET nickname = COALESCE(NULLIF(TRIM(?2), ''), nickname),
             alias = COALESCE(NULLIF(TRIM(?3), ''), alias),
             signature = COALESCE(NULLIF(TRIM(?4), ''), signature),
             round_head_img = COALESCE(NULLIF(TRIM(?5), ''), round_head_img),
             updated_at = CAST(strftime('%s', 'now') AS INTEGER)
         WHERE fakeid = ?1
           AND (
                (NULLIF(TRIM(?2), '') IS NOT NULL AND nickname <> TRIM(?2))
             OR (NULLIF(TRIM(?3), '') IS NOT NULL AND COALESCE(alias, '') <> TRIM(?3))
             OR (NULLIF(TRIM(?4), '') IS NOT NULL AND COALESCE(signature, '') <> TRIM(?4))
             OR (NULLIF(TRIM(?5), '') IS NOT NULL AND COALESCE(round_head_img, '') <> TRIM(?5))
           )",
        (
            account.fakeid,
            account.nickname,
            account.alias,
            account.signature,
            account.avatar,
        ),
    )?;
    Ok(changed > 0)
}

pub fn list_accounts() -> Result<Vec<Account>> {
    let conn = open()?;
    let mut stmt = conn.prepare(
        "SELECT a.fakeid, a.nickname, a.alias, a.signature, a.round_head_img,
                COUNT(art.aid) AS n
         FROM accounts a
         LEFT JOIN articles art ON art.fakeid = a.fakeid
         GROUP BY a.fakeid
         ORDER BY a.updated_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Account {
                fakeid: row.get(0)?,
                nickname: row.get(1)?,
                alias: row.get(2)?,
                signature: row.get(3)?,
                avatar: row.get(4)?,
                article_count: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_articles(fakeid: &str) -> Result<Vec<ArticleSummary>> {
    let conn = open()?;
    let mut stmt = conn.prepare(
        "SELECT aid, fakeid, title, link, digest, cover, author, create_time,
                article_type, copyright_type,
                CASE
                    WHEN NULLIF(TRIM(content_md), '') IS NOT NULL
                      OR NULLIF(TRIM(content_html), '') IS NOT NULL
                    THEN 1 ELSE 0
                END
         FROM articles
         WHERE fakeid = ?1
         ORDER BY create_time DESC",
    )?;
    let rows = stmt
        .query_map([fakeid], article_summary_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn search_articles(fakeid: &str, query: &str) -> Result<Vec<ArticleSummary>> {
    let query = query.trim();
    if query.is_empty() {
        return list_articles(fakeid);
    }

    let conn = open()?;
    let pattern = like_pattern(query);
    let mut stmt = conn.prepare(
        r#"SELECT aid, fakeid, title, link, digest, cover, author, create_time,
                article_type, copyright_type,
                CASE
                    WHEN NULLIF(TRIM(content_md), '') IS NOT NULL
                      OR NULLIF(TRIM(content_html), '') IS NOT NULL
                    THEN 1 ELSE 0
                END,
                content_md,
                content_html
         FROM articles
         WHERE fakeid = ?1
           AND (
                title LIKE ?2 ESCAPE '\'
             OR COALESCE(digest, '') LIKE ?2 ESCAPE '\'
             OR COALESCE(author, '') LIKE ?2 ESCAPE '\'
             OR COALESCE(content_md, '') LIKE ?2 ESCAPE '\'
             OR COALESCE(content_html, '') LIKE ?2 ESCAPE '\'
           )
         ORDER BY create_time DESC"#,
    )?;
    let rows = stmt
        .query_map([fakeid, pattern.as_str()], |row| {
            article_search_summary_from_row(row, query)
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn list_article_tags(aid: &str) -> Result<Vec<ArticleTag>> {
    let conn = open()?;
    list_article_tags_with_conn(&conn, aid)
}

pub fn list_article_tag_names(fakeid: &str) -> Result<HashMap<String, Vec<String>>> {
    let conn = open()?;
    list_article_tag_names_with_conn(&conn, fakeid)
}

fn list_article_tag_names_with_conn(
    conn: &Connection,
    fakeid: &str,
) -> Result<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT article.aid, tag.name
         FROM articles article
         INNER JOIN article_tag_links link ON link.aid = article.aid
         INNER JOIN article_tags tag ON tag.id = link.tag_id
         WHERE article.fakeid = ?1
         ORDER BY article.create_time DESC, tag.name COLLATE NOCASE ASC, tag.id ASC",
    )?;
    let rows = stmt
        .query_map([fakeid], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut tags_by_article = HashMap::<String, Vec<String>>::new();
    for (aid, name) in rows {
        tags_by_article.entry(aid).or_default().push(name);
    }
    Ok(tags_by_article)
}

pub fn list_all_article_tags() -> Result<Vec<ArticleTag>> {
    let conn = open()?;
    list_article_tags_with_conn(&conn, "")
}

fn list_article_tags_with_conn(conn: &Connection, aid: &str) -> Result<Vec<ArticleTag>> {
    let mut stmt = conn.prepare(
        "SELECT t.id,
                t.name,
                (SELECT COUNT(*) FROM article_tag_links all_links WHERE all_links.tag_id = t.id),
                EXISTS(
                    SELECT 1
                    FROM article_tag_links current_link
                    WHERE current_link.tag_id = t.id AND current_link.aid = ?1
                )
         FROM article_tags t
         ORDER BY t.name COLLATE NOCASE ASC, t.id ASC",
    )?;
    let tags = stmt
        .query_map([aid], |row| {
            let assigned: i64 = row.get(3)?;
            Ok(ArticleTag {
                id: row.get(0)?,
                name: row.get(1)?,
                article_count: row.get(2)?,
                assigned: assigned != 0,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(tags)
}

pub fn list_tag_articles(tag_id: i64) -> Result<Vec<ArticleSummary>> {
    let conn = open()?;
    list_tag_articles_with_conn(&conn, tag_id)
}

fn list_tag_articles_with_conn(conn: &Connection, tag_id: i64) -> Result<Vec<ArticleSummary>> {
    let tag_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM article_tags WHERE id = ?1)",
        [tag_id],
        |row| row.get(0),
    )?;
    if !tag_exists {
        bail!("标签不存在或已被删除");
    }

    let mut stmt = conn.prepare(
        "SELECT article.aid,
                article.fakeid,
                article.title,
                article.link,
                article.digest,
                article.cover,
                article.author,
                article.create_time,
                article.article_type,
                article.copyright_type,
                CASE
                    WHEN NULLIF(TRIM(article.content_md), '') IS NOT NULL
                      OR NULLIF(TRIM(article.content_html), '') IS NOT NULL
                    THEN 1 ELSE 0
                END
         FROM article_tag_links link
         INNER JOIN articles article ON article.aid = link.aid
         WHERE link.tag_id = ?1
         ORDER BY article.create_time DESC, article.aid ASC",
    )?;
    let articles = stmt
        .query_map([tag_id], article_summary_from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(articles)
}

pub fn create_article_tag(name: &str) -> Result<ArticleTag> {
    let conn = open()?;
    create_article_tag_with_conn(&conn, name)
}

pub fn create_and_assign_article_tag(aid: &str, name: &str) -> Result<ArticleTag> {
    let mut conn = open()?;
    let transaction = conn.transaction()?;
    let created = create_article_tag_with_conn(&transaction, name)?;
    set_article_tag_with_conn(&transaction, aid, created.id, true)?;
    let assigned = get_article_tag_with_conn(&transaction, created.id, true)?;
    transaction.commit()?;
    Ok(assigned)
}

fn create_article_tag_with_conn(conn: &Connection, name: &str) -> Result<ArticleTag> {
    let name = normalize_article_tag_name(name)?;
    ensure_article_tag_name_available(conn, &name, None)?;
    conn.execute(
        "INSERT INTO article_tags (name) VALUES (?1)",
        [name.as_str()],
    )?;
    get_article_tag_with_conn(conn, conn.last_insert_rowid(), false)
}

pub fn update_article_tag(tag_id: i64, name: &str) -> Result<ArticleTag> {
    let conn = open()?;
    update_article_tag_with_conn(&conn, tag_id, name)
}

fn update_article_tag_with_conn(conn: &Connection, tag_id: i64, name: &str) -> Result<ArticleTag> {
    let name = normalize_article_tag_name(name)?;
    ensure_article_tag_name_available(conn, &name, Some(tag_id))?;
    let changed = conn.execute(
        "UPDATE article_tags
         SET name = ?2,
             updated_at = CAST(strftime('%s', 'now') AS INTEGER)
         WHERE id = ?1",
        (tag_id, name.as_str()),
    )?;
    if changed == 0 {
        bail!("标签不存在或已被删除");
    }
    get_article_tag_with_conn(conn, tag_id, false)
}

pub fn delete_article_tag(tag_id: i64) -> Result<()> {
    let mut conn = open()?;
    let transaction = conn.transaction()?;
    delete_article_tag_with_conn(&transaction, tag_id)?;
    transaction.commit()?;
    Ok(())
}

fn delete_article_tag_with_conn(conn: &Connection, tag_id: i64) -> Result<()> {
    conn.execute("DELETE FROM article_tag_links WHERE tag_id = ?1", [tag_id])?;
    let changed = conn.execute("DELETE FROM article_tags WHERE id = ?1", [tag_id])?;
    if changed == 0 {
        bail!("标签不存在或已被删除");
    }
    Ok(())
}

pub fn set_article_tag(aid: &str, tag_id: i64, assigned: bool) -> Result<()> {
    let conn = open()?;
    set_article_tag_with_conn(&conn, aid, tag_id, assigned)
}

fn set_article_tag_with_conn(
    conn: &Connection,
    aid: &str,
    tag_id: i64,
    assigned: bool,
) -> Result<()> {
    let article_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM articles WHERE aid = ?1)",
        [aid],
        |row| row.get(0),
    )?;
    if !article_exists {
        bail!("文章不存在或已被删除");
    }

    let tag_exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM article_tags WHERE id = ?1)",
        [tag_id],
        |row| row.get(0),
    )?;
    if !tag_exists {
        bail!("标签不存在或已被删除");
    }

    if assigned {
        conn.execute(
            "INSERT OR IGNORE INTO article_tag_links (aid, tag_id) VALUES (?1, ?2)",
            (aid, tag_id),
        )?;
    } else {
        conn.execute(
            "DELETE FROM article_tag_links WHERE aid = ?1 AND tag_id = ?2",
            (aid, tag_id),
        )?;
    }
    Ok(())
}

fn normalize_article_tag_name(value: &str) -> Result<String> {
    let name = value.trim();
    if name.is_empty() {
        bail!("标签名称不能为空");
    }
    if name.chars().count() > 24 {
        bail!("标签名称不能超过 24 个字符");
    }
    Ok(name.to_string())
}

fn ensure_article_tag_name_available(
    conn: &Connection,
    name: &str,
    excluded_tag_id: Option<i64>,
) -> Result<()> {
    let existing: Option<i64> = conn
        .query_row(
            "SELECT id
             FROM article_tags
             WHERE name = ?1 COLLATE NOCASE
               AND (?2 IS NULL OR id <> ?2)
             LIMIT 1",
            (name, excluded_tag_id),
            |row| row.get(0),
        )
        .optional()?;
    if existing.is_some() {
        bail!("标签“{name}”已存在");
    }
    Ok(())
}

fn get_article_tag_with_conn(conn: &Connection, tag_id: i64, assigned: bool) -> Result<ArticleTag> {
    conn.query_row(
        "SELECT t.id,
                t.name,
                (SELECT COUNT(*) FROM article_tag_links links WHERE links.tag_id = t.id)
         FROM article_tags t
         WHERE t.id = ?1",
        [tag_id],
        |row| {
            Ok(ArticleTag {
                id: row.get(0)?,
                name: row.get(1)?,
                article_count: row.get(2)?,
                assigned,
            })
        },
    )
    .optional()?
    .context("标签不存在或已被删除")
}

fn article_search_summary_from_row(row: &Row<'_>, query: &str) -> rusqlite::Result<ArticleSummary> {
    let mut article = article_summary_from_row(row)?;
    let content_md: Option<String> = row.get(11)?;
    let content_html: Option<String> = row.get(12)?;
    let query_lower = query.to_lowercase();

    if text_matches_lower(&article.title, &query_lower) {
        article.match_fields.push("title".to_string());
    }

    if article
        .digest
        .as_deref()
        .is_some_and(|digest| text_matches_lower(digest, &query_lower))
    {
        article.match_fields.push("digest".to_string());
    }

    if article
        .author
        .as_deref()
        .is_some_and(|author| text_matches_lower(author, &query_lower))
    {
        article.match_fields.push("author".to_string());
    }

    let content_excerpt = content_md
        .as_deref()
        .and_then(|content| match_excerpt(content, query, &query_lower))
        .or_else(|| {
            content_html
                .as_deref()
                .and_then(|content| match_excerpt(&strip_html_tags(content), query, &query_lower))
        });

    if content_excerpt.is_some()
        || content_md
            .as_deref()
            .is_some_and(|content| text_matches_lower(content, &query_lower))
        || content_html
            .as_deref()
            .is_some_and(|content| text_matches_lower(content, &query_lower))
    {
        article.match_fields.push("content".to_string());
    }

    article.match_excerpt = content_excerpt.or_else(|| {
        article
            .digest
            .as_deref()
            .and_then(|text| match_excerpt(text, query, &query_lower))
    });

    Ok(article)
}

fn article_summary_from_row(row: &Row<'_>) -> rusqlite::Result<ArticleSummary> {
    let has_content: i64 = row.get(10)?;
    Ok(ArticleSummary {
        aid: row.get(0)?,
        fakeid: row.get(1)?,
        title: row.get(2)?,
        link: row.get(3)?,
        digest: row.get(4)?,
        cover: row.get(5)?,
        author: row.get(6)?,
        create_time: row.get(7)?,
        has_content: has_content != 0,
        article_type: row.get(8)?,
        copyright_type: row.get(9)?,
        match_fields: Vec::new(),
        match_excerpt: None,
    })
}

fn like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    escaped.push('%');

    for ch in value.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            escaped.push('\\');
        }
        escaped.push(ch);
    }

    escaped.push('%');
    escaped
}

fn text_matches_lower(text: &str, query_lower: &str) -> bool {
    text.to_lowercase().contains(query_lower)
}

fn match_excerpt(text: &str, query: &str, query_lower: &str) -> Option<String> {
    let text = collapse_whitespace(text);
    let (start, end) = find_match_range(&text, query, query_lower)?;
    let chars = text.chars().collect::<Vec<_>>();
    let excerpt_start = start.saturating_sub(36);
    let excerpt_end = chars.len().min(end + 72);
    let mut excerpt = String::new();

    if excerpt_start > 0 {
        excerpt.push('…');
    }
    excerpt.extend(chars[excerpt_start..excerpt_end].iter());
    if excerpt_end < chars.len() {
        excerpt.push('…');
    }

    Some(excerpt)
}

fn find_match_range(text: &str, query: &str, query_lower: &str) -> Option<(usize, usize)> {
    let text_chars = text.chars().collect::<Vec<_>>();
    let query_chars = query.chars().collect::<Vec<_>>();
    let query_len = query_chars.len();

    if query_len == 0 || query_len > text_chars.len() {
        return None;
    }

    for start in 0..=text_chars.len().saturating_sub(query_len) {
        let candidate = text_chars[start..start + query_len]
            .iter()
            .collect::<String>();
        if candidate.to_lowercase() == query_lower {
            return Some((start, start + query_len));
        }
    }

    None
}

fn collapse_whitespace(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn strip_html_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut inside_tag = false;

    for ch in html.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => inside_tag = false,
            _ if !inside_tag => output.push(ch),
            _ => {}
        }
    }

    output
}

pub fn get_article(aid: &str) -> Result<Option<ArticleDetail>> {
    let conn = open()?;
    let row = conn
        .query_row(
            "SELECT aid, fakeid, title, link, digest, cover, author, create_time,
                    article_type, copyright_type, content_html, content_md,
                    CASE
                        WHEN NULLIF(TRIM(content_md), '') IS NOT NULL
                          OR NULLIF(TRIM(content_html), '') IS NOT NULL
                        THEN 1 ELSE 0
                    END
             FROM articles WHERE aid = ?1",
            [aid],
            |row| {
                let has_content: i64 = row.get(12)?;
                Ok(ArticleDetail {
                    aid: row.get(0)?,
                    fakeid: row.get(1)?,
                    title: row.get(2)?,
                    link: row.get(3)?,
                    digest: row.get(4)?,
                    cover: row.get(5)?,
                    author: row.get(6)?,
                    create_time: row.get(7)?,
                    has_content: has_content != 0,
                    article_type: row.get(8)?,
                    copyright_type: row.get(9)?,
                    content_html: row.get(10)?,
                    content_md: row.get(11)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

/// Returns every article that has rendered Markdown content. Optionally filtered by fakeid.
/// Used by the GitHub archive sync to enumerate what should be exported.
pub fn list_articles_with_content(fakeid: Option<&str>) -> Result<Vec<ArticleDetail>> {
    let conn = open()?;
    let (sql, has_filter) = if fakeid.is_some() {
        (
            "SELECT aid, fakeid, title, link, digest, cover, author, create_time,
                    article_type, copyright_type, content_html, content_md
             FROM articles
             WHERE fakeid = ?1
               AND NULLIF(TRIM(content_md), '') IS NOT NULL
             ORDER BY create_time DESC",
            true,
        )
    } else {
        (
            "SELECT aid, fakeid, title, link, digest, cover, author, create_time,
                    article_type, copyright_type, content_html, content_md
             FROM articles
             WHERE NULLIF(TRIM(content_md), '') IS NOT NULL
             ORDER BY create_time DESC",
            false,
        )
    };
    let mut stmt = conn.prepare(sql)?;
    let mapper = |row: &Row<'_>| {
        Ok(ArticleDetail {
            aid: row.get(0)?,
            fakeid: row.get(1)?,
            title: row.get(2)?,
            link: row.get(3)?,
            digest: row.get(4)?,
            cover: row.get(5)?,
            author: row.get(6)?,
            create_time: row.get(7)?,
            has_content: true,
            article_type: row.get(8)?,
            copyright_type: row.get(9)?,
            content_html: row.get(10)?,
            content_md: row.get(11)?,
        })
    };
    let rows: Vec<ArticleDetail> = if has_filter {
        stmt.query_map([fakeid.unwrap()], mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        stmt.query_map([], mapper)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    Ok(rows)
}

/// Look up basic account metadata. Returns None if the fakeid is unknown.
pub fn get_account(fakeid: &str) -> Result<Option<Account>> {
    let conn = open()?;
    let row = conn
        .query_row(
            "SELECT a.fakeid, a.nickname, a.alias, a.signature, a.round_head_img,
                    COUNT(art.aid) AS n
             FROM accounts a
             LEFT JOIN articles art ON art.fakeid = a.fakeid
             WHERE a.fakeid = ?1
             GROUP BY a.fakeid",
            [fakeid],
            |row| {
                Ok(Account {
                    fakeid: row.get(0)?,
                    nickname: row.get(1)?,
                    alias: row.get(2)?,
                    signature: row.get(3)?,
                    avatar: row.get(4)?,
                    article_count: row.get(5)?,
                })
            },
        )
        .optional()?;
    Ok(row)
}

pub fn set_article_content(aid: &str, content_html: &str, content_md: &str) -> Result<()> {
    let conn = open()?;
    conn.execute(
        "UPDATE articles
         SET content_html = ?1,
             content_md = ?2,
             fetched_at = CAST(strftime('%s', 'now') AS INTEGER)
         WHERE aid = ?3",
        (content_html, content_md, aid),
    )?;
    Ok(())
}

pub fn upsert_account_and_article(
    account: &AccountUpsert<'_>,
    article: &ArticleUpsert<'_>,
) -> Result<()> {
    let mut conn = open()?;
    let tx = conn.transaction()?;

    upsert_account(&tx, account)?;
    upsert_article(&tx, article)?;

    tx.commit()?;
    Ok(())
}

fn upsert_article(conn: &Connection, article: &ArticleUpsert<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO articles
            (aid, fakeid, title, link, digest, cover, author,
             create_time, update_time, article_type, copyright_type,
             content_html, content_md, fetched_at)
         VALUES
            (?1, ?2, ?3, ?4, ?5, ?6, ?7,
             ?8, ?9, ?10, ?11, ?12, ?13,
             CAST(strftime('%s', 'now') AS INTEGER))
         ON CONFLICT(aid) DO UPDATE SET
            title = excluded.title,
            link = excluded.link,
            digest = COALESCE(NULLIF(TRIM(excluded.digest), ''), articles.digest),
            cover = COALESCE(NULLIF(TRIM(excluded.cover), ''), articles.cover),
            author = COALESCE(NULLIF(TRIM(excluded.author), ''), articles.author),
            create_time = excluded.create_time,
            update_time = excluded.update_time,
            article_type = COALESCE(excluded.article_type, articles.article_type),
            copyright_type = COALESCE(excluded.copyright_type, articles.copyright_type),
            content_html = COALESCE(NULLIF(TRIM(excluded.content_html), ''), articles.content_html),
            content_md = COALESCE(NULLIF(TRIM(excluded.content_md), ''), articles.content_md),
            fetched_at = excluded.fetched_at",
        (
            article.aid,
            article.fakeid,
            article.title,
            article.link,
            article.digest,
            article.cover,
            article.author,
            article.create_time,
            article.update_time,
            article.article_type,
            article.copyright_type,
            article.content_html,
            article.content_md,
        ),
    )?;
    Ok(())
}

fn upsert_account(conn: &Connection, account: &AccountUpsert<'_>) -> Result<()> {
    conn.execute(
        "INSERT INTO accounts
            (fakeid, nickname, alias, signature, round_head_img, updated_at)
         VALUES
            (?1, ?2, ?3, ?4, ?5, CAST(strftime('%s', 'now') AS INTEGER))
         ON CONFLICT(fakeid) DO UPDATE SET
            nickname = COALESCE(NULLIF(TRIM(excluded.nickname), ''), accounts.nickname),
            alias = COALESCE(NULLIF(TRIM(excluded.alias), ''), accounts.alias),
            signature = COALESCE(NULLIF(TRIM(excluded.signature), ''), accounts.signature),
            round_head_img = COALESCE(
                NULLIF(TRIM(excluded.round_head_img), ''),
                accounts.round_head_img
            ),
            updated_at = excluded.updated_at",
        (
            account.fakeid,
            account.nickname,
            account.alias,
            account.signature,
            account.avatar,
        ),
    )?;
    Ok(())
}

pub fn article_fetch_limit(aid: &str, fakeid: &str) -> Result<Option<u32>> {
    let conn = open()?;
    let mut stmt = conn.prepare(
        "SELECT aid
         FROM articles
         WHERE fakeid = ?1
         ORDER BY create_time DESC",
    )?;
    let mut rows = stmt.query([fakeid])?;
    let mut index: u32 = 1;

    while let Some(row) = rows.next()? {
        let current: String = row.get(0)?;
        if current == aid {
            return Ok(Some(index));
        }
        index = index.saturating_add(1);
    }

    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_article_schema_gains_filter_metadata_columns() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts (
                fakeid TEXT PRIMARY KEY,
                nickname TEXT NOT NULL,
                alias TEXT,
                signature TEXT,
                round_head_img TEXT,
                updated_at INTEGER NOT NULL
            );
            CREATE TABLE articles (
                aid TEXT PRIMARY KEY,
                fakeid TEXT NOT NULL,
                title TEXT NOT NULL,
                link TEXT NOT NULL,
                digest TEXT,
                cover TEXT,
                author TEXT,
                create_time INTEGER NOT NULL,
                update_time INTEGER,
                content_html TEXT,
                content_md TEXT,
                fetched_at INTEGER NOT NULL
            );",
        )
        .unwrap();

        ensure_runtime_schema(&conn).unwrap();

        let mut stmt = conn.prepare("PRAGMA table_info(articles)").unwrap();
        let columns = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert!(columns.iter().any(|column| column == "article_type"));
        assert!(columns.iter().any(|column| column == "copyright_type"));
    }

    fn account_table() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE accounts (
                fakeid TEXT PRIMARY KEY,
                nickname TEXT NOT NULL,
                alias TEXT,
                signature TEXT,
                round_head_img TEXT,
                updated_at INTEGER NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn article_tag_tables() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        ensure_runtime_schema(&conn).unwrap();
        conn.execute(
            "INSERT INTO accounts
                (fakeid, nickname, alias, signature, round_head_img, updated_at)
             VALUES ('account-id', '手工川', NULL, NULL, NULL, 1)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO articles
                (aid, fakeid, title, link, create_time, fetched_at)
             VALUES
                ('article-1', 'account-id', '文章一', 'https://example.com/1', 2, 2),
                ('article-2', 'account-id', '文章二', 'https://example.com/2', 1, 1)",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn sparse_account_upsert_preserves_existing_avatar() {
        let conn = account_table();
        let complete = AccountUpsert {
            fakeid: "account-id",
            nickname: "深思圈",
            alias: Some("Deep_Think_Circle"),
            signature: Some("关注深思圈"),
            avatar: Some("https://mmbiz.qpic.cn/avatar.png"),
        };
        upsert_account(&conn, &complete).unwrap();

        let sparse = AccountUpsert {
            fakeid: "account-id",
            nickname: "深思圈",
            alias: None,
            signature: Some(""),
            avatar: Some(""),
        };
        upsert_account(&conn, &sparse).unwrap();

        let row = conn
            .query_row(
                "SELECT alias, signature, round_head_img FROM accounts WHERE fakeid = ?1",
                ["account-id"],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "Deep_Think_Circle");
        assert_eq!(row.1, "关注深思圈");
        assert_eq!(row.2, "https://mmbiz.qpic.cn/avatar.png");
    }

    #[test]
    fn metadata_merge_fills_a_missing_avatar_without_blank_deletions() {
        let conn = account_table();
        conn.execute(
            "INSERT INTO accounts
                (fakeid, nickname, alias, signature, round_head_img, updated_at)
             VALUES (?1, ?2, NULL, NULL, '', 1)",
            ("account-id", "手工川"),
        )
        .unwrap();

        let refresh = AccountUpsert {
            fakeid: "account-id",
            nickname: "手工川",
            alias: None,
            signature: None,
            avatar: Some("https://wx.qlogo.cn/avatar/64"),
        };
        assert!(merge_account_metadata(&conn, &refresh).unwrap());

        let sparse = AccountUpsert {
            fakeid: "account-id",
            nickname: "手工川",
            alias: None,
            signature: None,
            avatar: Some(""),
        };
        assert!(!merge_account_metadata(&conn, &sparse).unwrap());

        let avatar: String = conn
            .query_row(
                "SELECT round_head_img FROM accounts WHERE fakeid = ?1",
                ["account-id"],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(avatar, "https://wx.qlogo.cn/avatar/64");
    }

    #[test]
    fn metadata_only_article_upsert_preserves_existing_body() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        ensure_runtime_schema(&conn).unwrap();
        upsert_account(
            &conn,
            &AccountUpsert {
                fakeid: "account-id",
                nickname: "测试公众号",
                alias: None,
                signature: None,
                avatar: None,
            },
        )
        .unwrap();
        let first = ArticleUpsert {
            aid: "42_1",
            fakeid: "account-id",
            title: "旧标题",
            link: "https://mp.weixin.qq.com/s?mid=42&idx=1",
            digest: Some("旧摘要"),
            cover: Some("https://mmbiz.qpic.cn/old.jpg"),
            author: Some("旧作者"),
            create_time: 100,
            update_time: Some(100),
            article_type: Some(9),
            copyright_type: Some(1),
            content_html: Some("<p>正文</p>"),
            content_md: Some("正文"),
        };
        upsert_article(&conn, &first).unwrap();

        let metadata_only = ArticleUpsert {
            aid: "42_1",
            fakeid: "account-id",
            title: "新标题",
            link: "https://mp.weixin.qq.com/s?__biz=account-id&mid=42&idx=1",
            digest: None,
            cover: None,
            author: None,
            create_time: 100,
            update_time: Some(100),
            article_type: None,
            copyright_type: None,
            content_html: None,
            content_md: None,
        };
        upsert_article(&conn, &metadata_only).unwrap();

        let row = conn
            .query_row(
                "SELECT title, digest, cover, author, content_html, content_md,
                        article_type, copyright_type
                 FROM articles WHERE aid = '42_1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, i64>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "新标题");
        assert_eq!(row.1, "旧摘要");
        assert_eq!(row.2, "https://mmbiz.qpic.cn/old.jpg");
        assert_eq!(row.3, "旧作者");
        assert_eq!(row.4, "<p>正文</p>");
        assert_eq!(row.5, "正文");
        assert_eq!(row.6, 9);
        assert_eq!(row.7, 1);
    }

    #[test]
    fn article_tags_support_create_toggle_rename_and_delete() {
        let conn = article_tag_tables();
        let created = create_article_tag_with_conn(&conn, "  产品洞察  ").unwrap();
        assert_eq!(created.name, "产品洞察");
        assert_eq!(created.article_count, 0);
        assert!(!created.assigned);

        set_article_tag_with_conn(&conn, "article-1", created.id, true).unwrap();
        set_article_tag_with_conn(&conn, "article-1", created.id, true).unwrap();

        let article_one_tags = list_article_tags_with_conn(&conn, "article-1").unwrap();
        assert_eq!(article_one_tags.len(), 1);
        assert!(article_one_tags[0].assigned);
        assert_eq!(article_one_tags[0].article_count, 1);

        let article_two_tags = list_article_tags_with_conn(&conn, "article-2").unwrap();
        assert!(!article_two_tags[0].assigned);
        assert_eq!(article_two_tags[0].article_count, 1);

        let renamed = update_article_tag_with_conn(&conn, created.id, "增长案例").unwrap();
        assert_eq!(renamed.name, "增长案例");
        assert_eq!(renamed.article_count, 1);

        delete_article_tag_with_conn(&conn, created.id).unwrap();
        assert!(list_article_tags_with_conn(&conn, "article-1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn article_tags_list_their_complete_article_indexes() {
        let conn = article_tag_tables();
        let tag = create_article_tag_with_conn(&conn, "待研究").unwrap();
        set_article_tag_with_conn(&conn, "article-1", tag.id, true).unwrap();
        set_article_tag_with_conn(&conn, "article-2", tag.id, true).unwrap();

        let tags = list_article_tags_with_conn(&conn, "").unwrap();
        assert_eq!(tags[0].article_count, 2);
        assert!(!tags[0].assigned);

        let articles = list_tag_articles_with_conn(&conn, tag.id).unwrap();
        assert_eq!(
            articles
                .iter()
                .map(|article| article.aid.as_str())
                .collect::<Vec<_>>(),
            vec!["article-1", "article-2"]
        );
        assert_eq!(articles[0].title, "文章一");
        assert_eq!(articles[0].fakeid, "account-id");

        let missing = list_tag_articles_with_conn(&conn, tag.id + 1).unwrap_err();
        assert!(missing.to_string().contains("不存在"));
    }

    #[test]
    fn article_tag_names_are_grouped_for_management_rows() {
        let conn = article_tag_tables();
        let research = create_article_tag_with_conn(&conn, "待研究").unwrap();
        let product = create_article_tag_with_conn(&conn, "产品").unwrap();
        set_article_tag_with_conn(&conn, "article-1", research.id, true).unwrap();
        set_article_tag_with_conn(&conn, "article-1", product.id, true).unwrap();
        set_article_tag_with_conn(&conn, "article-2", product.id, true).unwrap();

        let grouped = list_article_tag_names_with_conn(&conn, "account-id").unwrap();
        assert_eq!(grouped.get("article-1").unwrap(), &vec!["产品", "待研究"]);
        assert_eq!(grouped.get("article-2").unwrap(), &vec!["产品"]);
        assert!(list_article_tag_names_with_conn(&conn, "other-account")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn article_tag_names_are_validated_and_case_insensitively_unique() {
        let conn = article_tag_tables();
        create_article_tag_with_conn(&conn, "AI").unwrap();

        let duplicate = create_article_tag_with_conn(&conn, "ai").unwrap_err();
        assert!(duplicate.to_string().contains("已存在"));
        assert!(create_article_tag_with_conn(&conn, "   ")
            .unwrap_err()
            .to_string()
            .contains("不能为空"));
        assert!(
            create_article_tag_with_conn(&conn, "1234567890123456789012345")
                .unwrap_err()
                .to_string()
                .contains("24")
        );
    }
}
