use reqwest::header::{HeaderMap, HeaderValue, COOKIE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    env,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
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

const FETCH_ACCOUNT_PROGRESS_EVENT: &str = "fetch-account://progress";
const FETCH_PROGRESS_PREFIX: &str = "__WXMP_FETCH_PROGRESS__";
const ACCOUNT_SEARCH_CACHE_TTL: Duration = Duration::from_secs(300);
const ACCOUNT_SEARCH_CACHE_MAX_ITEMS: usize = 64;
const WECHAT_REFERER_URL: &str = "https://mp.weixin.qq.com/";
const WECHAT_SEARCH_BIZ_URL: &str = "https://mp.weixin.qq.com/cgi-bin/searchbiz";
const WECHAT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const WECHAT_DIRECT_SEARCH_TIMEOUT: Duration = Duration::from_secs(12);

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
    auth::current_status().await
}

#[tauri::command]
pub fn open_login(app: AppHandle) -> Result<(), CmdError> {
    auth::open_login_window(&app).map_err(Into::into)
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

fn normalize_optional_account_id(account_id: Option<String>) -> Option<String> {
    account_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
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
        return Ok(results);
    }

    tauri::async_runtime::spawn_blocking(move || {
        if let Some(results) = cached_account_search(&cache_key) {
            return Ok(results);
        }

        let results = match search_accounts_direct(&query) {
            Ok(results) => results,
            Err(error) if is_terminal_wechat_search_error(&error.message) => return Err(error),
            Err(error) => {
                log::warn!("direct WeChat account search failed; falling back to wcx: {error}");
                search_accounts_via_wcx(&query)?
            }
        };

        remember_account_search(cache_key, &results);
        Ok(results)
    })
    .await
    .map_err(|e| CmdError {
        message: format!("公众号搜索任务失败: {e}"),
    })?
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

    let url = format!(
        "{WECHAT_SEARCH_BIZ_URL}?action=search_biz&begin=0&count=5&query={}&token={}&lang=zh_CN&f=json&ajax=1",
        urlencoding::encode(query),
        urlencoding::encode(token),
    );

    let response = wechat_search_client()?
        .get(url)
        .header(COOKIE, cookie)
        .send()
        .map_err(|error| CmdError {
            message: format!("微信搜索请求失败: {error}"),
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().unwrap_or_default();
        return Err(CmdError {
            message: format!("微信搜索 HTTP {status}: {}", truncate_for_error(&body, 200)),
        });
    }

    let payload = response
        .json::<WechatSearchResponse>()
        .map_err(|error| CmdError {
            message: format!("解析微信搜索结果失败: {error}"),
        })?;
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
                message: format!("触发风控：Rate limited (ret=200013): {message}. Wait >= 1 hour."),
            });
        }
        if matches!(ret, 200003 | 200002 | 200008) {
            return Err(CmdError {
                message: format!("认证失败：Auth failed (ret={ret}): {message}. Re-login needed."),
            });
        }
        return Err(CmdError {
            message: format!("微信搜索 API error ret={ret}: {message}"),
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

fn search_accounts_via_wcx(query: &str) -> Result<Vec<AccountSearchResult>, CmdError> {
    let wcx = locate_wcx().map_err(|message| CmdError { message })?;
    let output = Command::new(&wcx)
        .arg("search-accounts-json")
        .arg(query)
        .output()
        .map_err(|e| CmdError {
            message: format!("运行 wcx search 失败: {e}"),
        })?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        let detail = first_nonempty_line(&stderr)
            .or_else(|| first_nonempty_line(&stdout))
            .unwrap_or_else(|| format!("wcx search 退出码: {}", output.status));
        return Err(CmdError { message: detail });
    }

    let payload = stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .ok_or_else(|| CmdError {
            message: "wcx search 没有输出".to_string(),
        })?;

    serde_json::from_str::<Vec<AccountSearchResult>>(payload).map_err(|e| CmdError {
        message: format!("解析 wcx search 结果失败: {e}"),
    })
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
    headers.insert(REFERER, HeaderValue::from_static(WECHAT_REFERER_URL));

    reqwest::blocking::Client::builder()
        .default_headers(headers)
        .timeout(WECHAT_DIRECT_SEARCH_TIMEOUT)
        .build()
        .map_err(|error| format!("初始化微信搜索客户端失败: {error}"))
}

fn is_terminal_wechat_search_error(message: &str) -> bool {
    message.starts_with("尚未登录")
        || message.starts_with("认证失败")
        || message.starts_with("触发风控")
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

    let limit = limit.unwrap_or(20).clamp(1, 500);

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

    let limit = limit.unwrap_or(20).clamp(1, 500);
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
                Ok(progress) => emit_fetch_progress(app, progress),
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
        emit_fetch_progress(
            app,
            fetch_progress(account, "error", "error", &detail, None, None, None),
        );
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
