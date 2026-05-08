use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, Row};
use serde::Serialize;
use std::path::PathBuf;

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
    let conn = Connection::open(&p).with_context(|| format!("open {:?}", p))?;
    Ok(conn)
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
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub match_fields: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_excerpt: Option<String>,
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
    pub content_html: Option<String>,
    pub content_md: Option<String>,
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

fn article_search_summary_from_row(row: &Row<'_>, query: &str) -> rusqlite::Result<ArticleSummary> {
    let mut article = article_summary_from_row(row)?;
    let content_md: Option<String> = row.get(9)?;
    let content_html: Option<String> = row.get(10)?;

    if text_matches(&article.title, query) {
        article.match_fields.push("title".to_string());
    }

    if article
        .digest
        .as_deref()
        .is_some_and(|digest| text_matches(digest, query))
    {
        article.match_fields.push("digest".to_string());
    }

    if article
        .author
        .as_deref()
        .is_some_and(|author| text_matches(author, query))
    {
        article.match_fields.push("author".to_string());
    }

    let content_excerpt = content_md
        .as_deref()
        .and_then(|content| match_excerpt(content, query))
        .or_else(|| {
            content_html
                .as_deref()
                .and_then(|content| match_excerpt(&strip_html_tags(content), query))
        });

    if content_excerpt.is_some()
        || content_md
            .as_deref()
            .is_some_and(|content| text_matches(content, query))
        || content_html
            .as_deref()
            .is_some_and(|content| text_matches(content, query))
    {
        article.match_fields.push("content".to_string());
    }

    article.match_excerpt = content_excerpt.or_else(|| {
        article
            .digest
            .as_deref()
            .and_then(|text| match_excerpt(text, query))
    });

    Ok(article)
}

fn article_summary_from_row(row: &Row<'_>) -> rusqlite::Result<ArticleSummary> {
    let has_content: i64 = row.get(8)?;
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

fn text_matches(text: &str, query: &str) -> bool {
    text.to_lowercase().contains(&query.to_lowercase())
}

fn match_excerpt(text: &str, query: &str) -> Option<String> {
    let text = collapse_whitespace(text);
    let (start, end) = find_match_range(&text, query)?;
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

fn find_match_range(text: &str, query: &str) -> Option<(usize, usize)> {
    let text_chars = text.chars().collect::<Vec<_>>();
    let query_chars = query.chars().collect::<Vec<_>>();
    let query_len = query_chars.len();

    if query_len == 0 || query_len > text_chars.len() {
        return None;
    }

    let query_lower = query.to_lowercase();
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
                    content_html, content_md,
                    CASE
                        WHEN NULLIF(TRIM(content_md), '') IS NOT NULL
                          OR NULLIF(TRIM(content_html), '') IS NOT NULL
                        THEN 1 ELSE 0
                    END
             FROM articles WHERE aid = ?1",
            [aid],
            |row| {
                let has_content: i64 = row.get(10)?;
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
                    content_html: row.get(8)?,
                    content_md: row.get(9)?,
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
