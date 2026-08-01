use base64::Engine as _;
use regex::Regex;
use reqwest::header::{
    HeaderMap, HeaderValue, ACCEPT, CONTENT_TYPE, COOKIE, ORIGIN, REFERER, USER_AGENT,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter};

use crate::auth;
use crate::db::{self, Account, ArticleDetail, ArticleSummary};
use crate::license;

#[derive(Serialize)]
pub struct CmdError {
    pub message: String,
}

#[derive(Serialize)]
pub struct FetchAccountResult {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Serialize)]
pub struct ArticleLocalFile {
    pub path: String,
    pub exists: bool,
}

#[derive(Serialize)]
pub struct ResolvedWechatImage {
    pub data_url: String,
    pub content_type: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct AccountSearchResult {
    pub fakeid: String,
    pub nickname: String,
    #[serde(default)]
    pub alias: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
    #[serde(default, alias = "round_head_img")]
    pub avatar: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct FetchAccountProgress {
    pub fakeid: String,
    pub nickname: String,
    pub stage: String,
    pub status: String,
    pub message: String,
    #[serde(default)]
    pub current: Option<u32>,
    #[serde(default)]
    pub total: Option<u32>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Deserialize)]
struct ArticleContentPayload {
    html: String,
    md: String,
}

#[derive(Default)]
struct ArticlePageMetadata {
    biz: Option<String>,
    appmsgid: Option<String>,
    itemidx: Option<String>,
    title: Option<String>,
    account_nickname: Option<String>,
    author: Option<String>,
    digest: Option<String>,
    cover: Option<String>,
    create_time: Option<i64>,
}

const FETCH_ACCOUNT_PROGRESS_EVENT: &str = "fetch-account://progress";
const FETCH_PROGRESS_PREFIX: &str = "__WXMP_FETCH_PROGRESS__";
const ACCOUNT_SEARCH_CACHE_TTL: Duration = Duration::from_secs(300);
const ACCOUNT_SEARCH_CACHE_MAX_ITEMS: usize = 64;
const WECHAT_REFERER_URL: &str = "https://mp.weixin.qq.com/";
const WECHAT_ORIGIN_URL: &str = "https://mp.weixin.qq.com";
const WECHAT_SEARCH_BIZ_URL: &str = "https://mp.weixin.qq.com/cgi-bin/searchbiz";
const WECHAT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WECHAT_DIRECT_SEARCH_TIMEOUT: Duration = Duration::from_secs(8);
const WECHAT_ARTICLE_PAGE_TIMEOUT: Duration = Duration::from_secs(20);
const WECHAT_IMAGE_TIMEOUT: Duration = Duration::from_secs(20);
const WECHAT_IMAGE_MAX_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Clone)]
struct ActiveFetchProcess {
    account: AccountSearchResult,
    cancel_requested: Arc<AtomicBool>,
    pid: u32,
}

struct ActiveFetchGuard {
    fakeid: String,
    pid: u32,
}

#[derive(Clone)]
struct CachedAccountSearch {
    created_at: Instant,
    results: Vec<AccountSearchResult>,
}

#[derive(Deserialize)]
struct WechatSearchResponse {
    #[serde(default)]
    base_resp: Option<WechatBaseResponse>,
    #[serde(default)]
    list: Vec<WechatSearchAccount>,
}

#[derive(Deserialize)]
struct WechatBaseResponse {
    #[serde(default)]
    ret: i64,
    #[serde(default)]
    err_msg: String,
}

#[derive(Deserialize)]
struct WechatSearchAccount {
    #[serde(default)]
    fakeid: String,
    #[serde(default)]
    nickname: String,
    #[serde(default)]
    alias: Option<String>,
    #[serde(default)]
    signature: Option<String>,
    #[serde(default)]
    round_head_img: Option<String>,
}

static ACTIVE_FETCH_PROCESSES: OnceLock<Mutex<HashMap<String, ActiveFetchProcess>>> =
    OnceLock::new();
static WCX_PATH_CACHE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
static ACCOUNT_SEARCH_CACHE: OnceLock<Mutex<HashMap<String, CachedAccountSearch>>> =
    OnceLock::new();
static WECHAT_SEARCH_CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
static WECHAT_ARTICLE_CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();
static WECHAT_IMAGE_CLIENT: OnceLock<Result<reqwest::blocking::Client, String>> = OnceLock::new();

impl Drop for ActiveFetchGuard {
    fn drop(&mut self) {
        let mut processes = active_fetch_processes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if processes
            .get(&self.fakeid)
            .is_some_and(|active| active.pid == self.pid)
        {
            processes.remove(&self.fakeid);
        }
    }
}

impl From<anyhow::Error> for CmdError {
    fn from(e: anyhow::Error) -> Self {
        CmdError {
            message: format!("{e:#}"),
        }
    }
}

impl std::fmt::Debug for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::fmt::Display for CmdError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

#[tauri::command]
pub async fn auth_status() -> auth::LoginStatus {
    let status = auth::current_status().await;
    if let Some(account) = status.account.as_ref() {
        if let Err(error) = persist_login_account_metadata(account) {
            log::warn!("failed to sync logged-in account metadata: {error:#}");
        }
    }
    status
}

#[tauri::command]
pub fn open_login(app: AppHandle) -> Result<(), CmdError> {
    auth::open_login_window(&app).map_err(Into::into)
}

#[tauri::command]
pub fn auth_logout(app: AppHandle) -> Result<(), CmdError> {
    auth::logout(&app).map_err(Into::into)
}

#[tauri::command]
pub fn license_status(account_id: Option<String>) -> Result<license::LicenseStatus, CmdError> {
    let account_id = normalize_optional_account_id(account_id);
    license::status(account_id.as_deref()).map_err(Into::into)
}

#[tauri::command]
pub fn activate_license(
    code: String,
    account_id: String,
) -> Result<license::LicenseStatus, CmdError> {
    license::activate(&code, &account_id).map_err(Into::into)
}

#[tauri::command]
pub async fn sync_remote_license(account_id: String) -> Result<license::LicenseStatus, CmdError> {
    license::sync_remote(&account_id).await.map_err(Into::into)
}

#[tauri::command]
pub fn list_accounts() -> Result<Vec<Account>, CmdError> {
    db::list_accounts().map_err(Into::into)
}

#[tauri::command]
pub fn list_articles(fakeid: String) -> Result<Vec<ArticleSummary>, CmdError> {
    db::list_articles(&fakeid).map_err(Into::into)
}

#[tauri::command]
pub fn search_articles(fakeid: String, query: String) -> Result<Vec<ArticleSummary>, CmdError> {
    db::search_articles(&fakeid, &query).map_err(Into::into)
}

#[tauri::command]
pub fn get_article(aid: String) -> Result<Option<ArticleDetail>, CmdError> {
    db::get_article(&aid).map_err(Into::into)
}

#[tauri::command]
pub fn cache_db_path() -> Result<String, CmdError> {
    db::cache_db_path()
        .map(|p| p.display().to_string())
        .map_err(Into::into)
}

#[tauri::command]
pub fn article_local_file(aid: String) -> Result<Option<ArticleLocalFile>, CmdError> {
    let aid = aid.trim().to_string();
    if aid.is_empty() {
        return Err(CmdError {
            message: "缺少文章 ID".to_string(),
        });
    }

    archive::article_local_file_path(&aid)
        .map(|path| {
            path.map(|path| ArticleLocalFile {
                exists: path.exists(),
                path: path.display().to_string(),
            })
        })
        .map_err(Into::into)
}

/// Render this one article to the local archive on demand (no whole-account
/// export needed) and return its absolute md path.
async fn ensure_article_local_file(app: AppHandle, aid: String) -> Result<PathBuf, CmdError> {
    let aid = aid.trim().to_string();
    if aid.is_empty() {
        return Err(CmdError {
            message: "缺少文章 ID".to_string(),
        });
    }
    tauri::async_runtime::spawn_blocking(move || sync::archive_one(&app, &aid, false))
        .await
        .map_err(|e| CmdError {
            message: format!("导出文章任务失败: {e}"),
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn export_article_local(app: AppHandle, aid: String) -> Result<String, CmdError> {
    let path = ensure_article_local_file(app, aid).await?;
    Ok(path.display().to_string())
}

// Open/reveal from Rust so the opener bypasses the webview's path scope (the
// archive lives outside the app-specific data dir).
#[tauri::command]
pub async fn open_article_local_file(app: AppHandle, aid: String) -> Result<String, CmdError> {
    let path = ensure_article_local_file(app, aid).await?;
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|error| CmdError {
        message: format!("打开本地文件失败: {error}"),
    })?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn reveal_article_local_file(app: AppHandle, aid: String) -> Result<String, CmdError> {
    let path = ensure_article_local_file(app, aid).await?;
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| CmdError {
        message: format!("Reveal 本地文件失败: {error}"),
    })?;
    Ok(path.display().to_string())
}

#[tauri::command]
pub async fn resolve_wechat_image(url: String) -> Result<ResolvedWechatImage, CmdError> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err(CmdError {
            message: "缺少图片 URL".to_string(),
        });
    }

    tauri::async_runtime::spawn_blocking(move || resolve_wechat_image_blocking(&url))
        .await
        .map_err(|e| CmdError {
            message: format!("微信图片解析任务失败: {e}"),
        })?
}

fn normalize_optional_account_id(account_id: Option<String>) -> Option<String> {
    account_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn persist_login_account_metadata(account: &auth::LoginAccount) -> anyhow::Result<bool> {
    let Some(fakeid) = login_account_fakeid(account) else {
        return Ok(false);
    };
    let metadata = db::AccountUpsert {
        fakeid: &fakeid,
        nickname: account.nickname.as_deref().unwrap_or_default(),
        alias: account.alias.as_deref(),
        signature: None,
        avatar: account.avatar.as_deref(),
    };
    db::merge_account_metadata_if_exists(&metadata)
}

fn login_account_fakeid(account: &auth::LoginAccount) -> Option<String> {
    let bizuin = account.bizuin.as_deref()?.trim();
    if bizuin.is_empty() || !bizuin.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    Some(base64::engine::general_purpose::STANDARD.encode(bizuin.as_bytes()))
}

#[tauri::command]
pub async fn search_accounts(query: String) -> Result<Vec<AccountSearchResult>, CmdError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(CmdError {
            message: "请输入公众号名称".to_string(),
        });
    }

    let cache_key = account_search_cache_key(&query);
    if let Some(results) = cached_account_search(&cache_key) {
        log::info!(
            "wechat account search cache hit: query_chars={}, results={}",
            query.chars().count(),
            results.len()
        );
        persist_existing_account_search_metadata(&results);
        return Ok(results);
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Some(results) = cached_account_search(&cache_key) {
            persist_existing_account_search_metadata(&results);
            return Ok(results);
        }

        let started_at = Instant::now();
        let results = search_accounts_direct(&query)?;
        log::info!(
            "wechat account search completed: query_chars={}, results={}, elapsed_ms={}",
            query.chars().count(),
            results.len(),
            started_at.elapsed().as_millis()
        );

        persist_existing_account_search_metadata(&results);
        remember_account_search(cache_key, &results);
        Ok(results)
    })
    .await
    .map_err(|e| CmdError {
        message: format!("公众号搜索任务失败: {e}"),
    })?
}

fn persist_existing_account_search_metadata(accounts: &[AccountSearchResult]) {
    for account in accounts {
        let metadata = db::AccountUpsert {
            fakeid: &account.fakeid,
            nickname: &account.nickname,
            alias: account.alias.as_deref(),
            signature: account.signature.as_deref(),
            avatar: account.avatar.as_deref(),
        };
        if let Err(error) = db::merge_account_metadata_if_exists(&metadata) {
            log::warn!(
                "failed to refresh cached account metadata for {}: {error:#}",
                account.fakeid
            );
        }
    }
}

fn search_accounts_direct(query: &str) -> Result<Vec<AccountSearchResult>, CmdError> {
    let config = auth::read_config().ok_or_else(|| CmdError {
        message: "尚未登录，请先扫码登录".to_string(),
    })?;
    let token = config.token.trim();
    let cookie = config.cookie.trim();
    if token.is_empty() || cookie.is_empty() {
        return Err(CmdError {
            message: "尚未登录，请先扫码登录".to_string(),
        });
    }

    let referer =
        format!("https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token={token}");
    let request_url = format!(
        "{WECHAT_SEARCH_BIZ_URL}?action=search_biz&begin=0&count=5&query={}&token={}&lang=zh_CN&f=json&ajax=1",
        urlencoding::encode(query),
        urlencoding::encode(token)
    );
    let response = wechat_search_client()?
        .get(request_url)
        .header(COOKIE, cookie)
        .header(REFERER, referer)
        .send()
        .map_err(|error| CmdError {
            message: format!("微信公众号搜索请求失败: {error}"),
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CmdError {
            message: format!(
                "微信公众号搜索 HTTP {status}: {}",
                truncate_for_error(&body, 200)
            ),
        });
    }

    let payload = response
        .json::<WechatSearchResponse>()
        .map_err(|error| CmdError {
            message: format!("解析微信公众号搜索结果失败: {error}"),
        })?;
    let results = search_results_from_response(payload)?;
    if let Err(error) = record_wechat_search_pace(&config) {
        log::warn!("failed to record shared WeChat request pace: {error:#}");
    }
    Ok(results)
}

fn record_wechat_search_pace(config: &auth::WcxConfig) -> anyhow::Result<()> {
    let base = dirs::data_dir().ok_or_else(|| anyhow::anyhow!("no data dir"))?;
    let path = base.join("wcx").join("request-guard.db");
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let connection = rusqlite::Connection::open(path)?;
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS request_guard (
             guard_key TEXT PRIMARY KEY,
             next_allowed_at REAL NOT NULL DEFAULT 0,
             cooldown_until REAL NOT NULL DEFAULT 0
         );",
    )?;

    let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs_f64();
    let key = wechat_pace_guard_key(config);
    connection.execute(
        "INSERT INTO request_guard (guard_key, next_allowed_at, cooldown_until)
         VALUES (?1, ?2, 0)
         ON CONFLICT(guard_key) DO UPDATE SET
           next_allowed_at = MAX(request_guard.next_allowed_at, excluded.next_allowed_at)",
        rusqlite::params![key, now + 15.0],
    )?;
    Ok(())
}

fn wechat_pace_guard_key(config: &auth::WcxConfig) -> String {
    let session_marker = config
        .last_login_at
        .map(|value| value.to_string())
        .unwrap_or_default();
    let fingerprint = format!("{}\n{}\n{}", config.token, config.cookie, session_marker);
    let digest = Sha256::digest(fingerprint.as_bytes());
    format!("wechat-session:{}:pace", &hex::encode(digest)[..20])
}

fn search_results_from_response(
    payload: WechatSearchResponse,
) -> Result<Vec<AccountSearchResult>, CmdError> {
    let ret = payload.base_resp.as_ref().map(|resp| resp.ret).unwrap_or(0);
    if ret != 0 {
        let message = payload
            .base_resp
            .as_ref()
            .map(|resp| resp.err_msg.trim())
            .filter(|message| !message.is_empty())
            .unwrap_or("unknown");
        if ret == 200013 {
            return Err(CmdError {
                message: format!(
                    "微信公众号搜索返回频率限制（ret=200013）：{message}。这不代表登录账号异常。"
                ),
            });
        }
        if matches!(ret, 200003 | 200002 | 200008) {
            return Err(CmdError {
                message: format!("认证失败（ret={ret}）：{message}，请重新登录。"),
            });
        }
        return Err(CmdError {
            message: format!("微信公众号搜索 API 错误（ret={ret}）：{message}"),
        });
    }

    Ok(payload
        .list
        .into_iter()
        .map(|account| AccountSearchResult {
            fakeid: account.fakeid,
            nickname: account.nickname,
            alias: account.alias,
            signature: account.signature,
            avatar: account.round_head_img,
        })
        .filter(|account| !account.fakeid.is_empty() && !account.nickname.is_empty())
        .collect())
}

fn wechat_search_client() -> Result<&'static reqwest::blocking::Client, CmdError> {
    WECHAT_SEARCH_CLIENT
        .get_or_init(build_wechat_search_client)
        .as_ref()
        .map_err(|message| CmdError {
            message: message.clone(),
        })
}

fn build_wechat_search_client() -> Result<reqwest::blocking::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(WECHAT_USER_AGENT));
    headers.insert(ACCEPT, HeaderValue::from_static("*/*"));
    headers.insert(ORIGIN, HeaderValue::from_static(WECHAT_ORIGIN_URL));
    headers.insert(REFERER, HeaderValue::from_static(WECHAT_REFERER_URL));

    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .timeout(WECHAT_DIRECT_SEARCH_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化微信公众号搜索客户端失败: {error}"))
}

pub fn prewarm_wechat_search_client() {
    let started_at = Instant::now();
    match wechat_search_client() {
        Ok(_) => log::info!(
            "wechat search client initialized: elapsed_ms={}",
            started_at.elapsed().as_millis()
        ),
        Err(error) => log::warn!("wechat search client initialization failed: {error}"),
    }
}

fn wechat_image_client() -> Result<&'static reqwest::blocking::Client, CmdError> {
    WECHAT_IMAGE_CLIENT
        .get_or_init(build_wechat_image_client)
        .as_ref()
        .map_err(|message| CmdError {
            message: message.clone(),
        })
}

fn build_wechat_image_client() -> Result<reqwest::blocking::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(WECHAT_USER_AGENT));
    headers.insert(REFERER, HeaderValue::from_static(WECHAT_REFERER_URL));

    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .timeout(WECHAT_IMAGE_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化微信图片客户端失败: {error}"))
}

fn resolve_wechat_image_blocking(url: &str) -> Result<ResolvedWechatImage, CmdError> {
    let url = normalize_wechat_image_url(url)?;
    if !is_allowed_wechat_image_url(&url) {
        return Err(CmdError {
            message: "只允许解析微信公众平台图片 URL".to_string(),
        });
    }

    let response = wechat_image_client()?
        .get(url.clone())
        .send()
        .map_err(|error| CmdError {
            message: format!("微信图片请求失败: {error}"),
        })?;

    let status = response.status();
    if !status.is_success() {
        return Err(CmdError {
            message: format!("微信图片 HTTP {status}"),
        });
    }

    if response
        .content_length()
        .is_some_and(|length| length > WECHAT_IMAGE_MAX_BYTES)
    {
        return Err(CmdError {
            message: "微信图片过大，已拒绝解析".to_string(),
        });
    }

    let content_type = image_content_type(
        &url,
        response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok()),
    )
    .ok_or_else(|| CmdError {
        message: "微信图片响应不是图片内容".to_string(),
    })?;

    let mut bytes = Vec::new();
    let mut limited_response = response.take(WECHAT_IMAGE_MAX_BYTES + 1);
    limited_response
        .read_to_end(&mut bytes)
        .map_err(|error| CmdError {
            message: format!("读取微信图片失败: {error}"),
        })?;

    if bytes.len() as u64 > WECHAT_IMAGE_MAX_BYTES {
        return Err(CmdError {
            message: "微信图片过大，已拒绝解析".to_string(),
        });
    }

    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(ResolvedWechatImage {
        data_url: format!("data:{content_type};base64,{encoded}"),
        content_type,
    })
}

fn normalize_wechat_image_url(value: &str) -> Result<reqwest::Url, CmdError> {
    let trimmed = value.trim().replace("&amp;", "&");
    let absolute = if let Some(rest) = trimmed.strip_prefix("//") {
        format!("https:{rest}")
    } else {
        trimmed
    };
    let mut url = reqwest::Url::parse(&absolute).map_err(|error| CmdError {
        message: format!("图片 URL 无效: {error}"),
    })?;

    if url.scheme() == "http" {
        let _ = url.set_scheme("https");
    }

    Ok(url)
}

fn is_allowed_wechat_image_url(url: &reqwest::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url
            .host_str()
            .is_some_and(|host| is_wechat_image_host(&host.to_ascii_lowercase()))
}

fn is_wechat_image_host(host: &str) -> bool {
    host == "mmbiz.qpic.cn"
        || host.ends_with(".mmbiz.qpic.cn")
        || host == "mmbiz.qlogo.cn"
        || host.ends_with(".mmbiz.qlogo.cn")
        || host == "wx.qlogo.cn"
        || host.ends_with(".wx.qlogo.cn")
        || host == "thirdwx.qlogo.cn"
        || host.ends_with(".thirdwx.qlogo.cn")
}

fn image_content_type(url: &reqwest::Url, header: Option<&str>) -> Option<String> {
    let content_type = header
        .and_then(|value| value.split(';').next())
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .filter(|value| value.starts_with("image/"));

    content_type.or_else(|| image_content_type_hint(url.as_str()).map(str::to_string))
}

fn image_content_type_hint(url: &str) -> Option<&'static str> {
    let lower = url.to_ascii_lowercase();
    if lower.contains("wx_fmt=jpeg") || lower.contains("wx_fmt=jpg") {
        Some("image/jpeg")
    } else if lower.contains("wx_fmt=png") {
        Some("image/png")
    } else if lower.contains("wx_fmt=gif") {
        Some("image/gif")
    } else if lower.contains("wx_fmt=webp") {
        Some("image/webp")
    } else {
        None
    }
}

fn truncate_for_error(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

#[tauri::command]
pub async fn fetch_account(
    query: String,
    limit: Option<u32>,
    with_content: bool,
) -> Result<FetchAccountResult, CmdError> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Err(CmdError {
            message: "请输入公众号名称或 fakeid".to_string(),
        });
    }

    let limit = limit.unwrap_or(10).clamp(1, 500);

    tauri::async_runtime::spawn_blocking(move || {
        let wcx = locate_wcx().map_err(|message| CmdError { message })?;
        let mut cmd = Command::new(wcx);
        cmd.arg("fetch")
            .arg(&query)
            .arg("--limit")
            .arg(limit.to_string());

        if with_content {
            cmd.arg("--content");
        }

        let output = cmd.output().map_err(|e| CmdError {
            message: format!("运行 wcx fetch 失败: {e}"),
        })?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();

        if !output.status.success() {
            let detail = first_nonempty_line(&stderr)
                .or_else(|| first_nonempty_line(&stdout))
                .unwrap_or_else(|| format!("wcx fetch 退出码: {}", output.status));
            return Err(CmdError { message: detail });
        }

        Ok(FetchAccountResult { stdout, stderr })
    })
    .await
    .map_err(|e| CmdError {
        message: format!("wcx fetch 任务失败: {e}"),
    })?
}

#[tauri::command]
pub async fn fetch_selected_account(
    app: AppHandle,
    account: AccountSearchResult,
    limit: Option<u32>,
    with_content: bool,
    mode: Option<String>,
    audit_date: Option<String>,
) -> Result<FetchAccountResult, CmdError> {
    if account.fakeid.trim().is_empty() || account.nickname.trim().is_empty() {
        return Err(CmdError {
            message: "请选择一个有效的公众号".to_string(),
        });
    }

    let limit = limit.unwrap_or(10).clamp(1, 500);
    let mode = mode
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("forward")
        .to_string();
    if !matches!(mode.as_str(), "forward" | "backward" | "audit") {
        return Err(CmdError {
            message: format!("未知抓取模式：{mode}"),
        });
    }
    let audit_date = audit_date
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if audit_date.is_some() && mode != "audit" {
        return Err(CmdError {
            message: "--audit-date 只能用于完备性回扫".to_string(),
        });
    }
    if let Some(date) = audit_date.as_deref() {
        if !is_iso_date(date) {
            return Err(CmdError {
                message: format!("日期格式应为 YYYY-MM-DD：{date}"),
            });
        }
    }

    tauri::async_runtime::spawn_blocking(move || {
        let prepare_msg = match mode.as_str() {
            "backward" => "正在启动向后续抓任务",
            "audit" => "正在启动完备性回扫任务",
            _ => "正在启动抓取任务",
        };
        emit_fetch_progress(
            &app,
            fetch_progress(
                &account,
                "prepare",
                "running",
                prepare_msg,
                None,
                Some(limit),
                None,
            ),
        );

        let wcx = locate_wcx().map_err(|message| CmdError { message })?;
        let account_json = serde_json::to_string(&account).map_err(|e| CmdError {
            message: format!("序列化公众号选择失败: {e}"),
        })?;
        let mut cmd = Command::new(&wcx);
        cmd.arg("fetch-selected-account-json")
            .arg(account_json)
            .arg(limit.to_string())
            .arg(if with_content { "1" } else { "0" })
            .arg("--mode")
            .arg(&mode);
        if let Some(date) = audit_date {
            cmd.arg("--audit-date").arg(date);
        }

        run_fetch_progress_command(&app, &account, cmd)
    })
    .await
    .map_err(|e| CmdError {
        message: format!("wcx 精确抓取任务失败: {e}"),
    })?
}

#[tauri::command]
pub fn cancel_fetch_account(app: AppHandle, fakeid: String) -> Result<bool, CmdError> {
    let fakeid = fakeid.trim().to_string();
    if fakeid.is_empty() {
        return Err(CmdError {
            message: "缺少公众号 fakeid".to_string(),
        });
    }

    let active = {
        let processes = active_fetch_processes()
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        processes.get(&fakeid).cloned()
    };

    let Some(active) = active else {
        return Ok(false);
    };

    active.cancel_requested.store(true, Ordering::SeqCst);
    emit_fetch_progress(
        &app,
        fetch_progress(
            &active.account,
            "cancel",
            "warning",
            "正在打断当前抓取任务",
            None,
            None,
            None,
        ),
    );

    if let Err(message) = terminate_process(active.pid) {
        active.cancel_requested.store(false, Ordering::SeqCst);
        return Err(CmdError {
            message: format!("打断 wcx 抓取失败: {message}"),
        });
    }

    Ok(true)
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
}

#[tauri::command]
pub async fn fetch_article_content(
    aid: String,
    force: Option<bool>,
) -> Result<ArticleDetail, CmdError> {
    let aid = aid.trim().to_string();
    if aid.is_empty() {
        return Err(CmdError {
            message: "缺少文章 ID".to_string(),
        });
    }
    let force = force.unwrap_or(false);

    tauri::async_runtime::spawn_blocking(move || {
        let article = db::get_article(&aid)
            .map_err(CmdError::from)?
            .ok_or_else(|| CmdError {
                message: "未找到该文章".to_string(),
            })?;

        if !force && has_article_body(&article) {
            return Ok(article);
        }

        let wcx = locate_wcx().map_err(|message| CmdError { message })?;

        let mut needs_fallback = false;
        match fetch_single_article_content(&wcx, &article.link) {
            Ok(content) if !content.html.trim().is_empty() || !content.md.trim().is_empty() => {
                db::set_article_content(&article.aid, &content.html, &content.md)
                    .map_err(CmdError::from)?;
            }
            Ok(_) => {
                log::warn!("single article content fetch returned empty content");
                needs_fallback = true;
            }
            Err(single_error) => {
                log::warn!("single article content fetch failed: {single_error}");
                needs_fallback = true;
            }
        }

        if needs_fallback {
            let account = fallback_fetch_account(&article)?;
            let mut limit = db::article_fetch_limit(&article.aid, &article.fakeid)
                .map_err(CmdError::from)?
                .ok_or_else(|| CmdError {
                    message: "无法计算当前文章的补抓位置".to_string(),
                })?;
            run_wcx_fetch_content(&wcx, &account, limit)?;

            let after_first_fallback =
                db::get_article(&aid)
                    .map_err(CmdError::from)?
                    .ok_or_else(|| CmdError {
                        message: "正文抓取后未找到该文章".to_string(),
                    })?;
            if !has_article_body(&after_first_fallback) {
                if let Some(next_limit) = db::article_fetch_limit(&article.aid, &article.fakeid)
                    .map_err(CmdError::from)?
                {
                    if next_limit > limit {
                        limit = next_limit;
                        run_wcx_fetch_content(&wcx, &account, limit)?;
                    }
                }
            }
        }

        let updated = db::get_article(&aid)
            .map_err(CmdError::from)?
            .ok_or_else(|| CmdError {
                message: "正文抓取后未找到该文章".to_string(),
            })?;

        if !has_article_body(&updated) {
            return Err(CmdError {
                message: "抓取完成，但本地缓存仍没有正文；可能是微信页面暂时无法访问".to_string(),
            });
        }

        Ok(updated)
    })
    .await
    .map_err(|e| CmdError {
        message: format!("正文抓取任务失败: {e}"),
    })?
}

#[tauri::command]
pub async fn import_article_link(link: String) -> Result<ArticleDetail, CmdError> {
    let url = normalize_wechat_article_link(&link)?;

    tauri::async_runtime::spawn_blocking(move || {
        let wcx = locate_wcx().map_err(|message| CmdError { message })?;
        let content =
            fetch_single_article_content(&wcx, url.as_str()).map_err(|message| CmdError {
                message: format!("抓取文章正文失败: {message}"),
            })?;
        let (content_html, content_md) = normalize_article_content(content)?;

        let mut metadata = article_metadata_from_url(&url);
        match fetch_article_page_metadata(&url) {
            Ok(page_metadata) => metadata.merge_missing(page_metadata),
            Err(error) => log::warn!("article metadata fetch failed: {error}"),
        }

        let itemidx = metadata
            .itemidx
            .as_deref()
            .and_then(clean_optional_string)
            .unwrap_or_else(|| "1".to_string());
        let standard_aid = metadata
            .appmsgid
            .as_deref()
            .and_then(clean_optional_string)
            .map(|appmsgid| format!("{appmsgid}_{itemidx}"));
        let existing = standard_aid
            .as_deref()
            .map(db::get_article)
            .transpose()
            .map_err(CmdError::from)?
            .flatten();
        let aid = existing
            .as_ref()
            .map(|article| article.aid.clone())
            .unwrap_or_else(|| format!("direct_{}", short_hash(url.as_str(), 16)));
        let fakeid = existing
            .as_ref()
            .map(|article| article.fakeid.clone())
            .or_else(|| metadata.biz.as_deref().and_then(clean_optional_string))
            .unwrap_or_else(|| format!("direct-{}", short_hash(url.as_str(), 12)));
        let existing_account = db::get_account(&fakeid).map_err(CmdError::from)?;
        let account_nickname = existing_account
            .as_ref()
            .map(|account| account.nickname.clone())
            .or_else(|| {
                metadata
                    .account_nickname
                    .as_deref()
                    .and_then(clean_optional_string)
            })
            .or_else(|| metadata.author.as_deref().and_then(clean_optional_string))
            .unwrap_or_else(|| format!("公众号 {}", short_label(&fakeid, 8)));
        let title = metadata
            .title
            .as_deref()
            .and_then(clean_optional_string)
            .or_else(|| existing.as_ref().map(|article| article.title.clone()))
            .unwrap_or_else(|| format!("微信文章 {}", short_hash(url.as_str(), 8)));
        let create_time = metadata
            .create_time
            .filter(|value| *value > 0)
            .or_else(|| existing.as_ref().map(|article| article.create_time))
            .unwrap_or_else(|| chrono::Utc::now().timestamp());
        let digest = metadata
            .digest
            .as_deref()
            .and_then(clean_optional_string)
            .or_else(|| existing.as_ref().and_then(|article| article.digest.clone()));
        let cover = metadata
            .cover
            .as_deref()
            .and_then(clean_optional_string)
            .or_else(|| existing.as_ref().and_then(|article| article.cover.clone()));
        let author = metadata
            .author
            .as_deref()
            .and_then(clean_optional_string)
            .or_else(|| existing.as_ref().and_then(|article| article.author.clone()));
        let link = url.to_string();

        let account = db::AccountUpsert {
            fakeid: &fakeid,
            nickname: &account_nickname,
            alias: None,
            signature: None,
            avatar: None,
        };
        let article = db::ArticleUpsert {
            aid: &aid,
            fakeid: &fakeid,
            title: &title,
            link: &link,
            digest: digest.as_deref(),
            cover: cover.as_deref(),
            author: author.as_deref(),
            create_time,
            update_time: Some(create_time),
            content_html: Some(content_html.as_str()),
            content_md: Some(content_md.as_str()),
        };

        db::upsert_account_and_article(&account, &article).map_err(CmdError::from)?;
        db::get_article(&aid)
            .map_err(CmdError::from)?
            .ok_or_else(|| CmdError {
                message: "文章已写入，但重新读取缓存失败".to_string(),
            })
    })
    .await
    .map_err(|e| CmdError {
        message: format!("文章链接导入任务失败: {e}"),
    })?
}

impl ArticlePageMetadata {
    fn merge_missing(&mut self, other: ArticlePageMetadata) {
        if self.biz.is_none() {
            self.biz = other.biz;
        }
        if self.appmsgid.is_none() {
            self.appmsgid = other.appmsgid;
        }
        if self.itemidx.is_none() {
            self.itemidx = other.itemidx;
        }
        if self.title.is_none() {
            self.title = other.title;
        }
        if self.account_nickname.is_none() {
            self.account_nickname = other.account_nickname;
        }
        if self.author.is_none() {
            self.author = other.author;
        }
        if self.digest.is_none() {
            self.digest = other.digest;
        }
        if self.cover.is_none() {
            self.cover = other.cover;
        }
        if self.create_time.is_none() {
            self.create_time = other.create_time;
        }
    }
}

fn normalize_wechat_article_link(value: &str) -> Result<reqwest::Url, CmdError> {
    let candidate = extract_first_url(value)
        .unwrap_or_else(|| value.trim().to_string())
        .replace("&amp;", "&");
    if candidate.trim().is_empty() {
        return Err(CmdError {
            message: "请输入微信公众号文章链接".to_string(),
        });
    }

    let mut url = reqwest::Url::parse(candidate.trim()).map_err(|error| CmdError {
        message: format!("文章链接无效: {error}"),
    })?;
    if url.scheme() == "http" {
        let _ = url.set_scheme("https");
    }
    if !matches!(url.scheme(), "https") {
        return Err(CmdError {
            message: "只支持 https 微信公众号文章链接".to_string(),
        });
    }
    if !url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("mp.weixin.qq.com"))
    {
        return Err(CmdError {
            message: "只支持 mp.weixin.qq.com 的公众号文章链接".to_string(),
        });
    }

    let path = url.path();
    let looks_like_article = path.starts_with("/s")
        || path.contains("appmsg")
        || query_param(&url, "__biz").is_some()
        || query_param(&url, "sn").is_some();
    if !looks_like_article {
        return Err(CmdError {
            message: "请输入具体的微信公众号文章链接".to_string(),
        });
    }

    Ok(url)
}

fn extract_first_url(value: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r#"https?://[^\s"'<>]+"#).expect("url regex"));
    re.find(value).map(|matched| {
        matched
            .as_str()
            .trim_end_matches([
                ',', '.', ';', ':', '，', '。', '；', '：', ')', '）', ']', '】',
            ])
            .to_string()
    })
}

fn normalize_article_content(content: ArticleContentPayload) -> Result<(String, String), CmdError> {
    let mut html = content.html.trim().to_string();
    let mut md = content.md.trim().to_string();

    if html.is_empty() && md.is_empty() {
        return Err(CmdError {
            message: "抓取完成，但文章正文为空".to_string(),
        });
    }

    if md.is_empty() {
        md = collapse_whitespace(&strip_html_tags(&html));
    }
    if html.is_empty() {
        html = markdown_text_to_html(&md);
    }

    Ok((html, md))
}

fn article_metadata_from_url(url: &reqwest::Url) -> ArticlePageMetadata {
    ArticlePageMetadata {
        biz: query_param(url, "__biz"),
        appmsgid: query_param(url, "mid").or_else(|| query_param(url, "appmsgid")),
        itemidx: query_param(url, "idx").or_else(|| query_param(url, "itemidx")),
        ..ArticlePageMetadata::default()
    }
}

fn fetch_article_page_metadata(url: &reqwest::Url) -> Result<ArticlePageMetadata, CmdError> {
    let response = wechat_article_client()?
        .get(url.clone())
        .send()
        .map_err(|error| CmdError {
            message: format!("微信文章元数据请求失败: {error}"),
        })?;
    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CmdError {
            message: format!(
                "微信文章元数据 HTTP {status}: {}",
                truncate_for_error(&body, 200)
            ),
        });
    }
    let html = response.text().map_err(|error| CmdError {
        message: format!("读取微信文章元数据失败: {error}"),
    })?;

    Ok(parse_article_page_metadata(&html))
}

fn parse_article_page_metadata(html: &str) -> ArticlePageMetadata {
    ArticlePageMetadata {
        biz: extract_js_string(html, &["biz", "__biz", "user_name"]),
        appmsgid: extract_js_string(html, &["appmsgid", "mid"]),
        itemidx: extract_js_string(html, &["itemidx", "idx"]),
        title: extract_element_text_by_class(html, "rich_media_title")
            .or_else(|| extract_js_string(html, &["msg_title"]))
            .or_else(|| extract_meta_content(html, &["og:title", "twitter:title"]))
            .or_else(|| extract_title_tag(html)),
        account_nickname: extract_element_text_by_id(html, "js_name")
            .or_else(|| extract_js_string(html, &["nickname", "nick_name"])),
        author: extract_js_string(html, &["author"])
            .or_else(|| extract_meta_content(html, &["author", "article:author"])),
        digest: extract_js_string(html, &["msg_desc"])
            .or_else(|| extract_meta_content(html, &["og:description", "description"])),
        cover: extract_js_string(html, &["msg_cdn_url", "cdn_url"])
            .or_else(|| extract_meta_content(html, &["og:image", "twitter:image"])),
        create_time: extract_js_i64(html, &["ct", "createTime", "publish_time"]),
    }
}

fn wechat_article_client() -> Result<&'static reqwest::blocking::Client, CmdError> {
    WECHAT_ARTICLE_CLIENT
        .get_or_init(build_wechat_article_client)
        .as_ref()
        .map_err(|message| CmdError {
            message: message.clone(),
        })
}

fn build_wechat_article_client() -> Result<reqwest::blocking::Client, String> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(WECHAT_USER_AGENT));
    headers.insert(REFERER, HeaderValue::from_static(WECHAT_REFERER_URL));

    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .timeout(WECHAT_ARTICLE_PAGE_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化微信文章客户端失败: {error}"))
}

fn query_param(url: &reqwest::Url, key: &str) -> Option<String> {
    url.query_pairs()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.into_owned())
        .and_then(|value| clean_optional_string(&value))
}

fn extract_meta_content(html: &str, keys: &[&str]) -> Option<String> {
    static META_RE: OnceLock<Regex> = OnceLock::new();
    let meta_re = META_RE.get_or_init(|| Regex::new(r"(?is)<meta\b[^>]*>").expect("meta regex"));

    meta_re.find_iter(html).find_map(|tag| {
        let tag = tag.as_str();
        let key = attr_value(tag, "property")
            .or_else(|| attr_value(tag, "name"))
            .or_else(|| attr_value(tag, "itemprop"))?;
        if !keys
            .iter()
            .any(|candidate| key.eq_ignore_ascii_case(candidate))
        {
            return None;
        }
        attr_value(tag, "content").and_then(|content| clean_optional_string(&content))
    })
}

fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let attr = regex::escape(attr);
    let double = Regex::new(&format!(r#"(?is)\b{attr}\s*=\s*"([^"]*)""#)).expect("attr regex");
    let single = Regex::new(&format!(r#"(?is)\b{attr}\s*=\s*'([^']*)'"#)).expect("attr regex");
    double
        .captures(tag)
        .or_else(|| single.captures(tag))
        .and_then(|captures| {
            captures
                .get(1)
                .map(|value| decode_html_text(value.as_str()))
        })
}

fn extract_title_tag(html: &str) -> Option<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"(?is)<title\b[^>]*>(.*?)</title>").expect("title"));
    re.captures(html)
        .and_then(|captures| captures.get(1))
        .and_then(|value| {
            clean_optional_string(&decode_html_text(&strip_html_tags(value.as_str())))
        })
}

fn extract_element_text_by_id(html: &str, id: &str) -> Option<String> {
    let id = regex::escape(id);
    let re = Regex::new(&format!(
        r#"(?is)<(?:a|span|div|h1|h2)\b[^>]*\bid\s*=\s*["']{id}["'][^>]*>(.*?)</(?:a|span|div|h1|h2)>"#
    ))
    .expect("id element regex");
    re.captures(html)
        .and_then(|captures| captures.get(1))
        .and_then(|value| {
            clean_optional_string(&decode_html_text(&strip_html_tags(value.as_str())))
        })
}

fn extract_element_text_by_class(html: &str, class_name: &str) -> Option<String> {
    let class_name = regex::escape(class_name);
    let re = Regex::new(&format!(
        r#"(?is)<(?:h1|h2|div|span)\b[^>]*\bclass\s*=\s*["'][^"']*{class_name}[^"']*["'][^>]*>(.*?)</(?:h1|h2|div|span)>"#
    ))
    .expect("class element regex");
    re.captures(html)
        .and_then(|captures| captures.get(1))
        .and_then(|value| {
            clean_optional_string(&decode_html_text(&strip_html_tags(value.as_str())))
        })
}

fn extract_js_string(html: &str, names: &[&str]) -> Option<String> {
    for name in names {
        let escaped = regex::escape(name);
        let double = Regex::new(&format!(
            r#"(?s)(?:var\s+)?{escaped}\s*=\s*"((?:\\.|[^"\\])*)""#
        ))
        .expect("js string regex");
        let single = Regex::new(&format!(
            r#"(?s)(?:var\s+)?{escaped}\s*=\s*'((?:\\.|[^'\\])*)'"#
        ))
        .expect("js string regex");
        let json_double = Regex::new(&format!(r#"(?s)"{escaped}"\s*:\s*"((?:\\.|[^"\\])*)""#))
            .expect("json string regex");

        if let Some(value) = double
            .captures(html)
            .or_else(|| single.captures(html))
            .or_else(|| json_double.captures(html))
            .and_then(|captures| captures.get(1))
            .and_then(|value| {
                clean_optional_string(&decode_html_text(&unescape_js_string(value.as_str())))
            })
        {
            return Some(value);
        }
    }

    None
}

fn extract_js_i64(html: &str, names: &[&str]) -> Option<i64> {
    for name in names {
        let escaped = regex::escape(name);
        let re = Regex::new(&format!(
            r#"(?s)(?:var\s+)?{escaped}\s*=\s*["']?([0-9]{{8,}})["']?"#
        ))
        .expect("js int regex");
        if let Some(value) = re
            .captures(html)
            .and_then(|captures| captures.get(1))
            .and_then(|value| value.as_str().parse::<i64>().ok())
        {
            return Some(value);
        }
    }

    None
}

fn unescape_js_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars().peekable();

    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }

        match chars.next() {
            Some('n') => output.push('\n'),
            Some('r') => output.push('\r'),
            Some('t') => output.push('\t'),
            Some('\\') => output.push('\\'),
            Some('"') => output.push('"'),
            Some('\'') => output.push('\''),
            Some('/') => output.push('/'),
            Some('x') => {
                let code = take_hex(&mut chars, 2);
                if let Some(ch) = code.and_then(|code| char::from_u32(code)) {
                    output.push(ch);
                }
            }
            Some('u') => {
                let code = take_hex(&mut chars, 4);
                if let Some(ch) = code.and_then(|code| char::from_u32(code)) {
                    output.push(ch);
                }
            }
            Some(other) => output.push(other),
            None => output.push('\\'),
        }
    }

    output
}

fn take_hex<I>(chars: &mut std::iter::Peekable<I>, count: usize) -> Option<u32>
where
    I: Iterator<Item = char>,
{
    let mut value = String::new();
    for _ in 0..count {
        let ch = chars.next()?;
        if !ch.is_ascii_hexdigit() {
            return None;
        }
        value.push(ch);
    }
    u32::from_str_radix(&value, 16).ok()
}

fn strip_html_tags(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut inside_tag = false;

    for ch in html.chars() {
        match ch {
            '<' => inside_tag = true,
            '>' => {
                inside_tag = false;
                output.push(' ');
            }
            _ if !inside_tag => output.push(ch),
            _ => {}
        }
    }

    output
}

fn decode_html_text(value: &str) -> String {
    let decoded = value
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'");

    decode_numeric_entities(&decoded)
}

fn decode_numeric_entities(value: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"&#(x[0-9a-fA-F]+|\d+);").expect("entity regex"));
    re.replace_all(value, |captures: &regex::Captures| {
        let raw = &captures[1];
        let code = raw
            .strip_prefix('x')
            .or_else(|| raw.strip_prefix('X'))
            .map(|hex| u32::from_str_radix(hex, 16))
            .unwrap_or_else(|| raw.parse::<u32>());
        code.ok()
            .and_then(char::from_u32)
            .map(|ch| ch.to_string())
            .unwrap_or_else(|| captures[0].to_string())
    })
    .into_owned()
}

fn clean_optional_string(value: &str) -> Option<String> {
    let text = collapse_whitespace(&decode_html_text(value));
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn markdown_text_to_html(value: &str) -> String {
    let body = value
        .split("\n\n")
        .map(str::trim)
        .filter(|paragraph| !paragraph.is_empty())
        .map(|paragraph| format!("<p>{}</p>", escape_html(paragraph).replace('\n', "<br/>")))
        .collect::<String>();
    format!(r#"<div id="js_content">{body}</div>"#)
}

fn escape_html(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn short_hash(value: &str, len: usize) -> String {
    archive::sha256_hex(value).chars().take(len).collect()
}

fn short_label(value: &str, len: usize) -> String {
    value.chars().take(len).collect()
}

fn account_search_cache() -> &'static Mutex<HashMap<String, CachedAccountSearch>> {
    ACCOUNT_SEARCH_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn account_search_cache_key(query: &str) -> String {
    query.trim().to_lowercase()
}

fn cached_account_search(key: &str) -> Option<Vec<AccountSearchResult>> {
    let mut cache = account_search_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    let Some(entry) = cache.get(key) else {
        return None;
    };

    if entry.created_at.elapsed() <= ACCOUNT_SEARCH_CACHE_TTL {
        return Some(entry.results.clone());
    }

    cache.remove(key);
    None
}

fn remember_account_search(key: String, results: &[AccountSearchResult]) {
    let mut cache = account_search_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let now = Instant::now();

    cache.retain(|_, entry| now.duration_since(entry.created_at) <= ACCOUNT_SEARCH_CACHE_TTL);

    if cache.len() >= ACCOUNT_SEARCH_CACHE_MAX_ITEMS {
        if let Some(oldest_key) = cache
            .iter()
            .min_by_key(|(_, entry)| entry.created_at)
            .map(|(cache_key, _)| cache_key.clone())
        {
            cache.remove(&oldest_key);
        }
    }

    cache.insert(
        key,
        CachedAccountSearch {
            created_at: now,
            results: results.to_vec(),
        },
    );
}

fn locate_wcx() -> Result<PathBuf, String> {
    if let Some(cached) = cached_wcx_path() {
        return Ok(cached);
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(bin) = env::var("WCX_BIN") {
        candidates.push(PathBuf::from(bin));
    }

    // Bundled sidecar: next to the app binary
    if let Ok(exe) = env::current_exe() {
        if let Some(dir) = exe.parent() {
            let suffix = if cfg!(windows) { ".exe" } else { "" };
            candidates.push(dir.join(format!("wcx{suffix}")));
        }
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/wcx"));
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/wcx"));
    candidates.push(PathBuf::from("/usr/local/bin/wcx"));
    candidates.push(PathBuf::from("wcx"));

    let mut seen = HashSet::new();
    let mut failures: Vec<String> = Vec::new();

    for candidate in candidates {
        if !seen.insert(candidate.clone()) {
            continue;
        }

        match Command::new(&candidate).arg("--version").output() {
            Ok(output) if output.status.success() => {
                remember_wcx_path(&candidate);
                return Ok(candidate);
            }
            Ok(output) => failures.push(format_wcx_failure(&candidate, &output)),
            Err(e) => failures.push(format!("{}: {e}", candidate.display())),
        }
    }

    if failures.is_empty() {
        Err("未找到 wcx，请先安装并确保 wcx 在 PATH 或 ~/.local/bin/wcx".to_string())
    } else {
        Err(format!(
            "未找到 wcx 或 wcx 无法启动。已尝试：{}",
            failures.join("；")
        ))
    }
}

fn wcx_path_cache() -> &'static Mutex<Option<PathBuf>> {
    WCX_PATH_CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_wcx_path() -> Option<PathBuf> {
    wcx_path_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

fn remember_wcx_path(path: &Path) {
    *wcx_path_cache()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(path.to_path_buf());
}

fn format_wcx_failure(candidate: &Path, output: &Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = first_nonempty_line(&stderr).or_else(|| first_nonempty_line(&stdout));
    let status = output
        .status
        .code()
        .map(|code| format!("退出码 {code}"))
        .unwrap_or_else(|| output.status.to_string());

    match detail {
        Some(detail) => format!("{}: {status}, {detail}", candidate.display()),
        None => format!("{}: {status}", candidate.display()),
    }
}

fn fetch_single_article_content(wcx: &Path, link: &str) -> Result<ArticleContentPayload, String> {
    let output = Command::new(wcx)
        .arg("fetch-article-content-json")
        .arg(link)
        .output()
        .map_err(|e| format!("运行 wcx 文章抓取模块失败: {e}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let detail = first_nonempty_line(&stderr)
            .or_else(|| first_nonempty_line(&stdout))
            .unwrap_or_else(|| format!("wcx 文章抓取模块退出码: {}", output.status));
        return Err(detail);
    }

    let payload = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| "wcx 文章抓取模块没有输出".to_string())?;

    serde_json::from_str::<ArticleContentPayload>(payload)
        .map_err(|e| format!("解析 wcx 文章抓取结果失败: {e}"))
}

fn fallback_fetch_account(article: &ArticleDetail) -> Result<AccountSearchResult, CmdError> {
    let account = db::get_account(&article.fakeid).map_err(CmdError::from)?;
    Ok(match account {
        Some(account) => AccountSearchResult {
            fakeid: account.fakeid,
            nickname: account.nickname,
            alias: account.alias,
            signature: account.signature,
            avatar: account.avatar,
        },
        None => AccountSearchResult {
            fakeid: article.fakeid.clone(),
            nickname: article.fakeid.clone(),
            alias: None,
            signature: None,
            avatar: None,
        },
    })
}

fn run_wcx_fetch_content(
    wcx: &Path,
    account: &AccountSearchResult,
    limit: u32,
) -> Result<(), CmdError> {
    let account_json = serde_json::to_string(account).map_err(|e| CmdError {
        message: format!("序列化公众号选择失败: {e}"),
    })?;
    let output = Command::new(wcx)
        .arg("fetch-selected-account-json")
        .arg(account_json)
        .arg(limit.to_string())
        .arg("1")
        .arg("--mode")
        .arg("forward")
        .output()
        .map_err(|e| CmdError {
            message: format!("运行 wcx 精确抓取失败: {e}"),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let detail = first_nonempty_line(&stderr)
            .or_else(|| first_nonempty_line(&stdout))
            .unwrap_or_else(|| format!("wcx 精确抓取退出码: {}", output.status));
        return Err(CmdError { message: detail });
    }

    Ok(())
}

fn run_fetch_progress_command(
    app: &AppHandle,
    account: &AccountSearchResult,
    mut cmd: Command,
) -> Result<FetchAccountResult, CmdError> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| {
            let message = format!("运行 wcx 精确抓取失败: {e}");
            emit_fetch_progress(
                app,
                fetch_progress(account, "error", "error", &message, None, None, None),
            );
            CmdError { message }
        })?;
    let (_active_fetch, cancel_requested) = register_active_fetch(account, child.id());

    let stdout = child.stdout.take().ok_or_else(|| CmdError {
        message: "无法读取 wcx 抓取输出".to_string(),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| CmdError {
        message: "无法读取 wcx 抓取错误输出".to_string(),
    })?;

    let stderr_handle = thread::spawn(move || {
        let mut text = String::new();
        let mut reader = BufReader::new(stderr);
        let _ = reader.read_to_string(&mut text);
        text
    });

    let mut stdout_text = String::new();
    let mut last_progress: Option<FetchAccountProgress> = None;
    for line in BufReader::new(stdout).lines() {
        let line = match line {
            Ok(line) => line,
            Err(_e) if cancel_requested.load(Ordering::SeqCst) => break,
            Err(e) => {
                return Err(CmdError {
                    message: format!("读取 wcx 抓取输出失败: {e}"),
                });
            }
        };
        stdout_text.push_str(&line);
        stdout_text.push('\n');

        if let Some(payload) = line.strip_prefix(FETCH_PROGRESS_PREFIX) {
            match serde_json::from_str::<FetchAccountProgress>(payload.trim()) {
                Ok(progress) => {
                    last_progress = Some(progress.clone());
                    emit_fetch_progress(app, progress);
                }
                Err(e) => log::warn!("invalid fetch progress payload: {e}"),
            }
        }
    }

    let status = child.wait().map_err(|e| CmdError {
        message: format!("等待 wcx 精确抓取结束失败: {e}"),
    })?;
    let stderr_text = stderr_handle.join().unwrap_or_default();

    if !status.success() {
        if cancel_requested.load(Ordering::SeqCst) {
            let message = "当前抓取任务已打断";
            emit_fetch_progress(
                app,
                fetch_progress(account, "cancel", "warning", message, None, None, None),
            );
            return Err(CmdError {
                message: message.to_string(),
            });
        }

        let detail = first_nonempty_line(&stderr_text)
            .or_else(|| first_nonempty_line(&stdout_text))
            .unwrap_or_else(|| format!("wcx 精确抓取退出码: {status}"));
        let error_progress = match last_progress {
            Some(last) => fetch_progress(
                account,
                &last.stage,
                "error",
                &detail,
                last.current,
                last.total,
                last.title,
            ),
            None => fetch_progress(account, "error", "error", &detail, None, None, None),
        };
        emit_fetch_progress(app, error_progress);
        return Err(CmdError { message: detail });
    }

    Ok(FetchAccountResult {
        stdout: stdout_text,
        stderr: stderr_text,
    })
}

fn active_fetch_processes() -> &'static Mutex<HashMap<String, ActiveFetchProcess>> {
    ACTIVE_FETCH_PROCESSES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn register_active_fetch(
    account: &AccountSearchResult,
    pid: u32,
) -> (ActiveFetchGuard, Arc<AtomicBool>) {
    let cancel_requested = Arc::new(AtomicBool::new(false));
    let active = ActiveFetchProcess {
        account: account.clone(),
        cancel_requested: Arc::clone(&cancel_requested),
        pid,
    };

    let mut processes = active_fetch_processes()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    processes.insert(account.fakeid.clone(), active);

    (
        ActiveFetchGuard {
            fakeid: account.fakeid.clone(),
            pid,
        },
        cancel_requested,
    )
}

#[cfg(unix)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let output = Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .output()
        .map_err(|e| format!("执行 kill 失败: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(first_nonempty_line(&stderr)
        .or_else(|| first_nonempty_line(&stdout))
        .unwrap_or_else(|| format!("kill 退出码: {}", output.status)))
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> Result<(), String> {
    let output = Command::new("taskkill")
        .arg("/PID")
        .arg(pid.to_string())
        .arg("/T")
        .arg("/F")
        .output()
        .map_err(|e| format!("执行 taskkill 失败: {e}"))?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(first_nonempty_line(&stderr)
        .or_else(|| first_nonempty_line(&stdout))
        .unwrap_or_else(|| format!("taskkill 退出码: {}", output.status)))
}

fn emit_fetch_progress(app: &AppHandle, progress: FetchAccountProgress) {
    let _ = app.emit(FETCH_ACCOUNT_PROGRESS_EVENT, progress);
}

fn fetch_progress(
    account: &AccountSearchResult,
    stage: &str,
    status: &str,
    message: &str,
    current: Option<u32>,
    total: Option<u32>,
    title: Option<String>,
) -> FetchAccountProgress {
    FetchAccountProgress {
        fakeid: account.fakeid.clone(),
        nickname: account.nickname.clone(),
        stage: stage.to_string(),
        status: status.to_string(),
        message: message.to_string(),
        current,
        total,
        title,
    }
}

fn has_article_body(article: &ArticleDetail) -> bool {
    article
        .content_html
        .as_deref()
        .map(str::trim)
        .is_some_and(|s| !s.is_empty())
        || article
            .content_md
            .as_deref()
            .map(str::trim)
            .is_some_and(|s| !s.is_empty())
}

fn first_nonempty_line(s: &str) -> Option<String> {
    s.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToOwned::to_owned)
}

// ---------------- GitHub archive integration -----------------------------

use crate::archive;
use crate::github;
use crate::sync;

#[tauri::command]
pub async fn github_oauth_start() -> Result<github::DeviceCodeStart, CmdError> {
    github::device_start().await.map_err(Into::into)
}

#[tauri::command]
pub async fn github_oauth_poll(device_code: String) -> Result<github::DevicePollOutcome, CmdError> {
    github::device_poll(&device_code).await.map_err(Into::into)
}

#[tauri::command]
pub async fn github_oauth_status() -> Result<github::OauthStatus, CmdError> {
    github::status().await.map_err(Into::into)
}

#[tauri::command]
pub fn github_oauth_logout() -> Result<(), CmdError> {
    github::logout().map_err(Into::into)
}

#[tauri::command]
pub async fn github_list_repos() -> Result<Vec<github::RepoBrief>, CmdError> {
    github::list_repos().await.map_err(Into::into)
}

#[tauri::command]
pub async fn github_create_repo(
    name: String,
    private: bool,
) -> Result<github::RepoBrief, CmdError> {
    github::create_repo(&name, private)
        .await
        .map_err(Into::into)
}

#[tauri::command]
pub fn github_sync_settings_get() -> Result<archive::SyncSettings, CmdError> {
    archive::load_settings().map_err(Into::into)
}

#[tauri::command]
pub fn reveal_archive_folder(
    aid: Option<String>,
    account_fakeid: Option<String>,
) -> Result<String, CmdError> {
    let normalized_aid = aid
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(aid) = normalized_aid.as_deref() {
        if let Some(path) = archive::article_local_file_path(aid).map_err(CmdError::from)? {
            if path.exists() {
                tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|error| CmdError {
                    message: format!("Reveal 归档文章失败: {error}"),
                })?;

                return Ok(path
                    .parent()
                    .unwrap_or(path.as_path())
                    .display()
                    .to_string());
            }
        }
    }

    // Scoped to a single account: open that account's local archive folder
    // (its `articles` md list) directly.
    let normalized_fakeid = account_fakeid
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(fakeid) = normalized_fakeid.as_deref() {
        if let Some(dir) = account_archive_dir(fakeid).map_err(CmdError::from)? {
            if dir.exists() {
                tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|error| CmdError {
                    message: format!("打开公众号归档目录失败: {error}"),
                })?;
                return Ok(dir.display().to_string());
            }
            return Err(CmdError {
                message: "当前公众号尚未导出本地归档，请先点「导出本地归档」".to_string(),
            });
        }
    }

    // Reveal priority: local md archive (the browsable per-account mirror) →
    // synced GitHub repo dir → local data root. This keeps the action useful
    // even before a GitHub archive repo is bound.
    let settings = archive::load_settings().map_err(CmdError::from)?;
    let local_archive = archive::archive_dir().map_err(CmdError::from)?;
    let target = if local_archive.exists() {
        local_archive
    } else {
        settings
            .repo_full_name
            .as_deref()
            .and_then(|repo_full_name| archive::repo_local_path(repo_full_name).ok())
            .filter(|repo_dir| repo_dir.exists())
            .map_or_else(|| archive::data_root().map_err(CmdError::from), Ok)?
    };

    tauri_plugin_opener::open_path(&target, None::<&str>).map_err(|error| CmdError {
        message: format!("打开归档文件夹失败: {error}"),
    })?;

    Ok(target.display().to_string())
}

/// Resolve an account's local archive folder, preferring its `articles`
/// subdir (the md list) when present. Returns None if the account is unknown.
fn account_archive_dir(fakeid: &str) -> anyhow::Result<Option<std::path::PathBuf>> {
    let Some(account) = db::get_account(fakeid)? else {
        return Ok(None);
    };
    let slug = archive::title_slug(&account.nickname, 40);
    let account_dir = archive::archive_dir()?.join("accounts").join(slug);
    let articles_dir = account_dir.join("articles");
    Ok(Some(if articles_dir.exists() {
        articles_dir
    } else {
        account_dir
    }))
}

#[tauri::command]
pub fn github_sync_settings_set(
    settings: archive::SyncSettings,
) -> Result<archive::SyncSettings, CmdError> {
    archive::save_settings(&settings).map_err(CmdError::from)?;
    Ok(settings)
}

#[tauri::command]
pub async fn github_sync_articles(
    app: AppHandle,
    options: sync::SyncOptions,
) -> Result<sync::SyncSummary, CmdError> {
    tauri::async_runtime::spawn_blocking(move || sync::sync_articles(&app, options))
        .await
        .map_err(|e| CmdError {
            message: format!("同步任务失败: {e}"),
        })?
        .map_err(Into::into)
}

#[tauri::command]
pub async fn archive_articles_local(
    app: AppHandle,
    options: sync::SyncOptions,
) -> Result<sync::LocalArchiveSummary, CmdError> {
    tauri::async_runtime::spawn_blocking(move || sync::archive_local(&app, options))
        .await
        .map_err(|e| CmdError {
            message: format!("本地归档任务失败: {e}"),
        })?
        .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_response_maps_valid_accounts_and_skips_incomplete_rows() {
        let results = search_results_from_response(WechatSearchResponse {
            base_resp: Some(WechatBaseResponse {
                ret: 0,
                err_msg: String::new(),
            }),
            list: vec![
                WechatSearchAccount {
                    fakeid: "fake-id".to_string(),
                    nickname: "深思圈".to_string(),
                    alias: Some("thinking-circle".to_string()),
                    signature: Some("保持思考".to_string()),
                    round_head_img: Some("https://example.com/avatar.jpg".to_string()),
                },
                WechatSearchAccount {
                    fakeid: String::new(),
                    nickname: "缺少标识".to_string(),
                    alias: None,
                    signature: None,
                    round_head_img: None,
                },
            ],
        })
        .expect("successful WeChat response should be parsed");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].fakeid, "fake-id");
        assert_eq!(results[0].nickname, "深思圈");
        assert_eq!(results[0].alias.as_deref(), Some("thinking-circle"));
        assert_eq!(
            results[0].avatar.as_deref(),
            Some("https://example.com/avatar.jpg")
        );
    }

    #[test]
    fn search_response_explains_platform_rate_limit_without_blaming_login() {
        let result = search_results_from_response(WechatSearchResponse {
            base_resp: Some(WechatBaseResponse {
                ret: 200013,
                err_msg: "freq control".to_string(),
            }),
            list: Vec::new(),
        });
        let error = match result {
            Ok(_) => panic!("rate-limited response should be surfaced"),
            Err(error) => error,
        };

        assert!(error.message.contains("ret=200013"));
        assert!(error.message.contains("这不代表登录账号异常"));
    }

    #[test]
    fn direct_search_uses_the_same_pace_key_as_wcx() {
        let config = auth::WcxConfig {
            token: "token".to_string(),
            cookie: "cookie".to_string(),
            account: None,
            last_login_at: Some(123),
        };

        assert_eq!(
            wechat_pace_guard_key(&config),
            "wechat-session:dd4a9375d43c1ed01c42:pace"
        );
    }

    #[test]
    fn login_bizuin_maps_to_the_cached_account_fakeid() {
        let account = auth::LoginAccount {
            nickname: Some("手工川".to_string()),
            username: Some("gh_example".to_string()),
            avatar: Some("https://wx.qlogo.cn/avatar/64".to_string()),
            alias: None,
            service_type: Some("1".to_string()),
            bizuin: Some("3869894872".to_string()),
        };

        assert_eq!(
            login_account_fakeid(&account).as_deref(),
            Some("Mzg2OTg5NDg3Mg==")
        );
    }
}
