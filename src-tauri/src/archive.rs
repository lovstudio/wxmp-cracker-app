use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};

/// File name used in the wcx data dir to persist GitHub-sync user prefs.
const SETTINGS_FILE: &str = "github-sync.json";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncSettings {
    #[serde(default)]
    pub repo_full_name: Option<String>,
    #[serde(default = "default_branch")]
    pub branch: String,
    #[serde(default = "default_true")]
    pub sync_images: bool,
    #[serde(default)]
    pub auto_push: bool,
    #[serde(default)]
    pub last_synced_at: Option<i64>,
    #[serde(default)]
    pub last_error: Option<String>,
}

fn default_branch() -> String {
    "main".into()
}

fn default_true() -> bool {
    true
}

impl Default for SyncSettings {
    fn default() -> Self {
        Self {
            repo_full_name: None,
            branch: default_branch(),
            sync_images: true,
            auto_push: false,
            last_synced_at: None,
            last_error: None,
        }
    }
}

pub fn settings_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    Ok(base.join("wcx").join(SETTINGS_FILE))
}

pub fn load_settings() -> Result<SyncSettings> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(SyncSettings::default());
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {:?}", path))?;
    let parsed: SyncSettings =
        serde_json::from_str(&raw).with_context(|| format!("parse {:?}", path))?;
    Ok(parsed)
}

pub fn save_settings(settings: &SyncSettings) -> Result<()> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir {:?}", parent))?;
    }
    let body = serde_json::to_string_pretty(settings)?;
    fs::write(&path, body).with_context(|| format!("write {:?}", path))?;
    Ok(())
}

pub fn repos_root() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    Ok(base.join("wcx").join("repos"))
}

pub fn repo_local_path(full_name: &str) -> Result<PathBuf> {
    let safe = full_name.replace('/', "__");
    Ok(repos_root()?.join(safe))
}

// ---- index.json schema ---------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexFile {
    pub generated_at: String,
    #[serde(default)]
    pub accounts: HashMap<String, IndexAccount>,
    #[serde(default)]
    pub articles: HashMap<String, IndexArticle>,
}

impl Default for IndexFile {
    fn default() -> Self {
        Self {
            generated_at: Utc::now().to_rfc3339(),
            accounts: HashMap::new(),
            articles: HashMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexAccount {
    pub fakeid: String,
    pub nickname: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signature: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub article_count: i64,
    pub last_synced_at: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IndexArticle {
    pub aid: String,
    pub fakeid: String,
    pub nickname: String,
    pub title: String,
    pub link: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    pub create_time: i64,
    pub publish_date: String,
    pub markdown_path: String,
    /// SHA-256 of the rendered markdown body — used to detect drift.
    pub content_hash: String,
}

pub fn load_index(repo_dir: &Path) -> Result<IndexFile> {
    let path = repo_dir.join("index.json");
    if !path.exists() {
        return Ok(IndexFile::default());
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("read {:?}", path))?;
    let parsed: IndexFile =
        serde_json::from_str(&raw).with_context(|| format!("parse {:?}", path))?;
    Ok(parsed)
}

pub fn save_index(repo_dir: &Path, index: &IndexFile) -> Result<()> {
    let mut snapshot = index.clone();
    snapshot.generated_at = Utc::now().to_rfc3339();
    let path = repo_dir.join("index.json");
    let body = serde_json::to_string_pretty(&snapshot)?;
    fs::write(&path, body).with_context(|| format!("write {:?}", path))?;
    Ok(())
}

/// Convert a create_time (epoch seconds) into UTC YYYY-MM-DD for filename prefix.
pub fn publish_date(epoch: i64) -> String {
    DateTime::<Utc>::from_timestamp(epoch, 0)
        .unwrap_or_else(|| Utc::now())
        .format("%Y-%m-%d")
        .to_string()
}

/// Slugify a Chinese-friendly title. Keeps CJK characters intact (slug crate strips them),
/// so we do a manual pass: drop punctuation, collapse whitespace, replace with dashes.
pub fn title_slug(title: &str, max_chars: usize) -> String {
    let mut out = String::with_capacity(title.len());
    let mut last_was_dash = false;
    for ch in title.chars() {
        let keep = ch.is_alphanumeric() || is_cjk(ch);
        if keep {
            out.push(ch);
            last_was_dash = false;
        } else if !last_was_dash && !out.is_empty() {
            out.push('-');
            last_was_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.chars().count() > max_chars {
        out = out.chars().take(max_chars).collect();
        while out.ends_with('-') {
            out.pop();
        }
    }
    if out.is_empty() {
        "untitled".into()
    } else {
        out
    }
}

fn is_cjk(ch: char) -> bool {
    matches!(ch as u32,
        0x4E00..=0x9FFF      // CJK Unified Ideographs
        | 0x3400..=0x4DBF    // CJK Extension A
        | 0x3040..=0x30FF    // Hiragana + Katakana
        | 0xAC00..=0xD7AF    // Hangul Syllables
    )
}

/// Compute SHA-256 hex of a string. Used as content fingerprint for index.json.
pub fn sha256_hex(data: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    hex::encode(hasher.finalize())
}

/// Bail with a typed error so callers can distinguish "not configured" from "real error".
pub fn ensure_repo_configured(settings: &SyncSettings) -> Result<&str> {
    settings
        .repo_full_name
        .as_deref()
        .ok_or_else(|| anyhow!("尚未选择归档仓库，请先在设置中绑定一个 GitHub 仓库。"))
}
