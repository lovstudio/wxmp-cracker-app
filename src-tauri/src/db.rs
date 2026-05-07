use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension};
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
        .query_map([fakeid], |row| {
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
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
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
