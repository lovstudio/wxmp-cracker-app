use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::read::GzDecoder;
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use regex::Regex;
use reqwest::header::{ACCEPT, COOKIE, REFERER, USER_AGENT};
use rusqlite::{Connection, OpenFlags, OptionalExtension, Row};
use serde::Serialize;
use serde_json::Value;
use sha1::{Digest as _, Sha1};
use std::{
    collections::{HashMap, HashSet},
    fs,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use crate::{auth, commands::CmdError, db};

const SOURCE_KIND: &str = "wechat_local_cache";
const LOCAL_SESSION_SOURCE_KIND: &str = "wechat_local_session";
const MP_BACKEND_SOURCE_KIND: &str = "wechat_mp_backend";
const ACCOUNT_FEED_SOURCE_KIND: &str = "wechat_account_feed";
const STATUS_VISIBLE: &str = "visible";
const CAPTURE_METHOD: &str = "chromium_simple_cache";
const AUTOMATIC_NAVIGATION_CAPTURE_METHOD: &str = "wechat_authenticated_navigation_cache";
const ACCOUNT_FEED_CAPTURE_METHOD: &str = "wechat_account_feed_batch";
const LOCAL_SESSION_CAPTURE_METHOD: &str = "wechat_profile_history_api";
const AUTHORIZED_PAGE_CAPTURE_METHOD: &str = "wechat_authorized_page_api";
const MP_BACKEND_CAPTURE_METHOD: &str = "authenticated_content_analysis";
const SOGOU_RESOLUTION_CAPTURE_METHOD: &str = "sogou_fresh_article_api";
const MP_BACKEND_URL: &str = "https://mp.weixin.qq.com/misc/appmsganalysis";
const SOGOU_WECHAT_SEARCH_URL: &str = "https://weixin.sogou.com/weixinwap";
const SOGOU_BASE_URL: &str = "https://weixin.sogou.com/";
const MP_BACKEND_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const SOGOU_BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const WECHAT_CLIENT_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 MicroMessenger/7.0.20.1781(0x6700143B) MacWechat/3.8.7(0x13080712) UnifiedPCMacWechat(0xf2641d0b)";
const WECHAT_PROFILE_HISTORY_URL: &str = "https://mp.weixin.qq.com/mp/profile_ext";
const SIMPLE_CACHE_MAGIC: u64 = 0xfcfb_6d1b_a772_5c30;
const SIMPLE_CACHE_HEADER_BYTES: u64 = 24;
const MAX_CACHE_KEY_BYTES: usize = 64 * 1024;
const MAX_CACHE_ENTRY_BYTES: u64 = 16 * 1024 * 1024;
const MAX_DECOMPRESSED_PAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SOGOU_SEARCH_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOGOU_REDIRECT_BYTES: usize = 128 * 1024;
const MAX_WECHAT_ARTICLE_PAGE_BYTES: usize = 8 * 1024 * 1024;
const MAX_SOGOU_ACCOUNT_SEARCH_PAGES: usize = 5;
const MAX_CACHE_CANDIDATES_PER_PROFILE: usize = 5_000;
const MAX_WECHAT_PROFILES: usize = 8;
const MAX_CACHED_SESSION_ATTEMPTS: usize = 4;
const MAX_WECHAT_HISTORY_PAGES: usize = 500;
const WECHAT_CACHE_EVENT_WAIT: Duration = Duration::from_millis(250);
const WECHAT_NAVIGATION_TIMEOUT: Duration = Duration::from_secs(8);
const ACCOUNT_FEED_INITIAL_TIMEOUT: Duration = Duration::from_secs(8);
const ACCOUNT_FEED_PAGE_TIMEOUT: Duration = Duration::from_millis(1_600);
const ACCOUNT_FEED_TRAVERSAL_TIMEOUT: Duration = Duration::from_secs(28);
const MAX_ACCOUNT_FEED_PAGES: usize = 80;
const MAX_ACCOUNT_FEED_STAGNANT_PAGES: usize = 2;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ArticlePublicMetricsSnapshot {
    pub id: i64,
    pub aid: String,
    pub source_url: String,
    pub source_kind: String,
    pub capture_method: String,
    pub captured_at: i64,
    pub status: String,
    pub read_count: Option<i64>,
    pub like_count: Option<i64>,
    pub recommend_count: Option<i64>,
    pub share_count: Option<i64>,
    pub comment_count: Option<i64>,
    pub collect_count: Option<i64>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
struct ParsedMetrics {
    read_count: Option<i64>,
    like_count: Option<i64>,
    recommend_count: Option<i64>,
    share_count: Option<i64>,
    comment_count: Option<i64>,
    collect_count: Option<i64>,
}

impl ParsedMetrics {
    fn has_any(&self) -> bool {
        self.read_count.is_some()
            || self.like_count.is_some()
            || self.recommend_count.is_some()
            || self.share_count.is_some()
            || self.comment_count.is_some()
            || self.collect_count.is_some()
    }

    fn merge_missing(&mut self, other: ParsedMetrics) {
        if self.read_count.is_none() {
            self.read_count = other.read_count;
        }
        if self.like_count.is_none() {
            self.like_count = other.like_count;
        }
        if self.recommend_count.is_none() {
            self.recommend_count = other.recommend_count;
        }
        if self.share_count.is_none() {
            self.share_count = other.share_count;
        }
        if self.comment_count.is_none() {
            self.comment_count = other.comment_count;
        }
        if self.collect_count.is_none() {
            self.collect_count = other.collect_count;
        }
    }
}

struct CaptureOutcome {
    source_kind: &'static str,
    method: &'static str,
    metrics: ParsedMetrics,
    captured_at: i64,
    note: Option<String>,
}

struct FreshSogouArticle {
    authorized_url: reqwest::Url,
    embedded_metrics: Option<CaptureOutcome>,
}

#[derive(Clone, Debug, PartialEq)]
struct ArticleIdentity {
    aid: String,
    mid: Option<String>,
    idx: Option<String>,
    sn: Option<String>,
    fakeid: String,
    publisher: Option<String>,
    title: String,
    create_time: i64,
    source_url: String,
}

#[derive(Clone, Debug, PartialEq)]
struct WechatCanonicalIdentity {
    biz: String,
    mid: String,
    idx: String,
    sn: Option<String>,
    canonical_url: String,
    short_url: Option<String>,
    // The authorized URL is consumed only in memory. It can contain short-lived
    // WeChat session parameters and must never be logged or persisted.
    authorized_url: Option<reqwest::Url>,
    authorized_cache_key: Option<String>,
    // SHA-derived Chromium cache filename only. It contains no URL, token,
    // cookie, or other reusable authorization material and is safe to persist.
    authorized_cache_filename: Option<String>,
    resolved_at: i64,
}

#[derive(Debug)]
struct CacheCandidate {
    path: PathBuf,
    modified_at: i64,
}

#[derive(Debug)]
struct CacheSnapshot {
    path: PathBuf,
    modified_at: i64,
    bytes: Vec<u8>,
}

#[derive(Debug)]
enum ObservedCacheChange {
    Snapshot(CacheSnapshot),
    Path(PathBuf),
}

struct CacheChangeWatcher {
    _watcher: RecommendedWatcher,
    receiver: mpsc::Receiver<ObservedCacheChange>,
}

static CAPTURE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static METRICS_SCHEMA_READY: OnceLock<Mutex<bool>> = OnceLock::new();

#[tauri::command]
pub fn get_article_public_metrics(
    aid: String,
) -> Result<Option<ArticlePublicMetricsSnapshot>, CmdError> {
    let aid = normalized_aid(&aid)?;
    latest_snapshot(&aid).map_err(Into::into)
}

#[tauri::command]
pub async fn capture_article_public_metrics(
    aid: String,
) -> Result<ArticlePublicMetricsSnapshot, CmdError> {
    let aid = normalized_aid(&aid)?;
    let debug_aid = aid.clone();
    let started = Instant::now();
    log::info!("[DEBUG][public_metrics] command entry aid={debug_aid}");
    let result = tauri::async_runtime::spawn_blocking(move || capture_and_store(&aid))
        .await
        .map_err(|error| CmdError {
            message: format!("公开互动数据抓取任务失败: {error}"),
        })?;
    match &result {
        Ok(snapshot) => log::info!(
            "[DEBUG][public_metrics] command success aid={} source={} method={} elapsed_ms={}",
            snapshot.aid,
            snapshot.source_kind,
            snapshot.capture_method,
            started.elapsed().as_millis()
        ),
        Err(error) => log::warn!(
            "[DEBUG][public_metrics] command failed aid={debug_aid} elapsed_ms={} error={}",
            started.elapsed().as_millis(),
            error.message
        ),
    }
    result
}

fn normalized_aid(value: &str) -> Result<String, CmdError> {
    let aid = value.trim();
    if aid.is_empty() {
        return Err(CmdError {
            message: "缺少文章 ID".to_string(),
        });
    }
    Ok(aid.to_string())
}

fn capture_and_store(aid: &str) -> Result<ArticlePublicMetricsSnapshot, CmdError> {
    let started = Instant::now();
    log::info!("[DEBUG][public_metrics] capture_and_store entry aid={aid}");
    let article = db::get_article(aid)
        .map_err(CmdError::from)?
        .ok_or_else(|| CmdError {
            message: "未找到该文章".to_string(),
        })?;
    let source_url = normalize_source_url(&article.link)?;
    let _capture_guard = CAPTURE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let publisher = db::get_account(&article.fakeid)
        .map_err(CmdError::from)?
        .map(|account| account.nickname);
    let mut identity = ArticleIdentity::from_article(&article, &source_url, publisher);
    let canonical_identity = resolve_article_canonical_identity(&mut identity)
        .map_err(|message| CmdError { message })?;
    let outcome = match capture_from_authenticated_mp_backend(&article) {
        Ok(Some(outcome)) => outcome,
        Ok(None) => capture_from_local_wechat_cache(&mut identity, canonical_identity.as_ref())
            .map_err(|message| CmdError { message })?,
        Err(backend_error) => {
            match capture_from_local_wechat_cache(&mut identity, canonical_identity.as_ref()) {
                Ok(outcome) => outcome,
                Err(cache_error) => {
                    return Err(CmdError {
                        message: format!("{backend_error}；{cache_error}"),
                    });
                }
            }
        }
    };
    if outcome.method == AUTOMATIC_NAVIGATION_CAPTURE_METHOD
        && canonical_identity
            .as_ref()
            .and_then(|canonical| {
                canonical
                    .authorized_cache_filename
                    .as_ref()
                    .or(canonical.authorized_cache_key.as_ref())
            })
            .is_none()
    {
        // A first-time open adds the exact article identity and authorized URL
        // to WeChat's Share Data store. Persist only the safe canonical fields
        // now so later updates take the O(1) hashed-cache path without opening
        // another search page.
        match resolve_article_canonical_identity(&mut identity) {
            Ok(Some(canonical)) => log::info!(
                "[DEBUG][public_metrics] post-navigation identity persisted aid={} mid={} idx={} has_sn={}",
                identity.aid,
                canonical.mid,
                canonical.idx,
                canonical.sn.is_some()
            ),
            Ok(None) => log::warn!(
                "[DEBUG][public_metrics] post-navigation identity still unresolved aid={}",
                identity.aid
            ),
            Err(error) => log::warn!(
                "[DEBUG][public_metrics] post-navigation identity refresh failed aid={} error={error}",
                identity.aid
            ),
        }
    }
    let snapshot = ArticlePublicMetricsSnapshot {
        id: 0,
        aid: aid.to_string(),
        source_url: source_url.to_string(),
        source_kind: outcome.source_kind.to_string(),
        capture_method: outcome.method.to_string(),
        captured_at: outcome.captured_at,
        status: STATUS_VISIBLE.to_string(),
        read_count: outcome.metrics.read_count,
        like_count: outcome.metrics.like_count,
        recommend_count: outcome.metrics.recommend_count,
        share_count: outcome.metrics.share_count,
        comment_count: outcome.metrics.comment_count,
        collect_count: outcome.metrics.collect_count,
        note: outcome.note,
    };

    let store_started = Instant::now();
    let stored = insert_snapshot(&snapshot).map_err(Into::into);
    log::info!(
        "[DEBUG][public_metrics] capture_and_store exit aid={aid} elapsed_ms={} store_ms={} stored={}",
        started.elapsed().as_millis(),
        store_started.elapsed().as_millis(),
        stored.is_ok()
    );
    stored
}

pub(crate) fn capture_and_store_for_provider(
    aid: &str,
) -> Result<ArticlePublicMetricsSnapshot, CmdError> {
    capture_and_store(aid)
}

fn capture_from_authenticated_mp_backend(
    article: &db::ArticleDetail,
) -> std::result::Result<Option<CaptureOutcome>, String> {
    let Some(config) = auth::read_config() else {
        return Ok(None);
    };
    let Some(account) = config.account.as_ref() else {
        return Ok(None);
    };
    let Some(bizuin) = account
        .bizuin
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
    else {
        return Ok(None);
    };
    if BASE64_STANDARD.encode(bizuin.as_bytes()) != article.fakeid {
        return Ok(None);
    }
    if config.token.trim().is_empty() || config.cookie.trim().is_empty() {
        return Err("当前公众号后台登录信息不完整，请重新扫码登录后再试".to_string());
    }

    let published_at = chrono::DateTime::from_timestamp(article.create_time, 0)
        .ok_or_else(|| "文章发布时间无效，无法查询公众号后台统计".to_string())?
        .with_timezone(&chrono::Local);
    let publish_date = published_at.format("%Y-%m-%d").to_string();
    let referer = format!(
        "https://mp.weixin.qq.com/misc/appmsganalysis?action=all&type=daily_v2&token={}&lang=zh_CN",
        config.token.trim()
    );
    let mut request_url =
        reqwest::Url::parse(MP_BACKEND_URL).map_err(|_| "公众号后台统计地址无效".to_string())?;
    request_url.query_pairs_mut().extend_pairs([
        ("action", "detailpage"),
        ("msgid", article.aid.as_str()),
        ("publish_date", publish_date.as_str()),
        ("pageVersion", "1"),
        ("type", "int"),
        ("token", config.token.trim()),
        ("lang", "zh_CN"),
    ]);
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::limited(4))
        .build()
        .map_err(|_| "无法初始化公众号后台统计请求".to_string())?;
    let response = client
        .get(request_url)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .header(USER_AGENT, MP_BACKEND_USER_AGENT)
        .header(COOKIE, config.cookie.trim())
        .header(REFERER, referer)
        .send()
        .map_err(|_| "公众号后台统计请求失败，请检查网络后重试".to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("公众号后台统计请求返回 HTTP {status}"));
    }
    let final_path = response.url().path().to_ascii_lowercase();
    let html = response
        .text()
        .map_err(|_| "读取公众号后台统计响应失败".to_string())?;
    if final_path.contains("login")
        || html.contains("扫码登录")
        || html.contains("二维码登录")
        || html.contains("login_frame")
    {
        return Err("微信公众号后台登录已过期，请重新扫码登录".to_string());
    }

    let metrics = parse_metrics_from_mp_backend(&html, &article.aid)?;
    Ok(Some(CaptureOutcome {
        source_kind: MP_BACKEND_SOURCE_KIND,
        method: MP_BACKEND_CAPTURE_METHOD,
        metrics,
        captured_at: system_time_to_unix(SystemTime::now()),
        note: Some(
            "数据来自当前登录公众号的后台内容分析；阅读、分享和收藏为人数口径，通常按日更新，不等同于文章页公开计数。"
                .to_string(),
        ),
    }))
}

fn parse_metrics_from_mp_backend(
    html: &str,
    expected_aid: &str,
) -> std::result::Result<ParsedMetrics, String> {
    let assignment = "window.wx.cgiData";
    let start = html
        .rfind(assignment)
        .ok_or_else(|| "公众号后台统计页缺少文章数据".to_string())?;
    let brace = html[start + assignment.len()..]
        .find('{')
        .map(|offset| start + assignment.len() + offset)
        .ok_or_else(|| "公众号后台统计页的文章数据格式异常".to_string())?;
    let cgi_data = balanced_object(html, brace)
        .ok_or_else(|| "公众号后台统计页的文章数据不完整".to_string())?;
    let article_data = extract_property_object(cgi_data, "articleData")
        .ok_or_else(|| "公众号后台尚未返回这篇文章的统计".to_string())?;
    let article: Value =
        serde_json::from_str(article_data).map_err(|_| "无法解析公众号后台文章统计".to_string())?;
    if article.get("msgid").and_then(Value::as_str) != Some(expected_aid) {
        return Err("公众号后台返回了不匹配的文章统计，已停止写入".to_string());
    }
    let stats = article
        .get("article_data_new")
        .ok_or_else(|| "公众号后台尚未生成这篇文章的统计，请稍后再试".to_string())?;
    let metrics = ParsedMetrics {
        read_count: json_metric(stats, "read_uv"),
        like_count: json_metric(stats, "like_cnt"),
        recommend_count: json_metric(stats, "zaikan_cnt"),
        share_count: json_metric(stats, "share_uv"),
        comment_count: json_metric(stats, "comment_cnt"),
        collect_count: json_metric(stats, "collection_uv"),
    };
    if !metrics.has_any() {
        return Err("公众号后台尚未生成这篇文章的统计，请稍后再试".to_string());
    }
    Ok(metrics)
}

fn json_metric(value: &Value, name: &str) -> Option<i64> {
    value.get(name).and_then(|metric| {
        metric
            .as_i64()
            .or_else(|| {
                metric
                    .as_u64()
                    .and_then(|number| i64::try_from(number).ok())
            })
            .or_else(|| {
                metric
                    .as_str()
                    .and_then(|number| number.parse::<i64>().ok())
            })
    })
}

impl ArticleIdentity {
    fn from_article(
        article: &db::ArticleDetail,
        source_url: &reqwest::Url,
        publisher: Option<String>,
    ) -> Self {
        let query_value = |names: &[&str]| {
            source_url.query_pairs().find_map(|(name, value)| {
                names.contains(&name.as_ref()).then(|| value.into_owned())
            })
        };
        let aid_parts = article.aid.rsplit_once('_').filter(|(mid, idx)| {
            !mid.is_empty()
                && !idx.is_empty()
                && mid.bytes().all(|byte| byte.is_ascii_digit())
                && idx.bytes().all(|byte| byte.is_ascii_digit())
        });
        Self {
            aid: article.aid.clone(),
            mid: query_value(&["mid", "appmsgid"])
                .or_else(|| aid_parts.map(|(mid, _)| mid.to_string())),
            idx: query_value(&["idx", "itemidx"])
                .or_else(|| aid_parts.map(|(_, idx)| idx.to_string())),
            sn: query_value(&["sn"]),
            fakeid: article.fakeid.clone(),
            publisher: publisher.filter(|value| !value.trim().is_empty()),
            title: article.title.clone(),
            create_time: article.create_time,
            source_url: source_url.to_string(),
        }
    }

    fn apply_canonical_identity(&mut self, canonical: &WechatCanonicalIdentity) {
        self.mid = Some(canonical.mid.clone());
        self.idx = Some(canonical.idx.clone());
        self.sn = canonical.sn.clone();
    }
}

impl WechatCanonicalIdentity {
    fn new(
        biz: String,
        mid: String,
        idx: String,
        sn: Option<String>,
        short_url: Option<String>,
        authorized_url: Option<reqwest::Url>,
        resolved_at: i64,
    ) -> Option<Self> {
        let biz = biz.trim().to_string();
        let mid = mid.trim().to_string();
        let idx = idx.trim().to_string();
        let sn = sn
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
        if !valid_wechat_biz(&biz)
            || !valid_decimal_identifier(&mid)
            || !valid_decimal_identifier(&idx)
            || sn.as_deref().is_some_and(|value| !valid_wechat_sn(value))
        {
            return None;
        }
        let canonical_url = safe_canonical_wechat_url(&biz, &mid, &idx, sn.as_deref())?;
        let authorized_cache_key = authorized_url
            .as_ref()
            .map(|url| format!("1/0/{}", url.as_str()));
        let authorized_cache_filename = authorized_cache_key
            .as_deref()
            .map(|key| chromium_simple_cache_filename(key, 0));
        Some(Self {
            biz,
            mid,
            idx,
            sn,
            canonical_url,
            short_url,
            authorized_url,
            authorized_cache_key,
            authorized_cache_filename,
            resolved_at,
        })
    }

    fn same_article_as(&self, other: &Self) -> bool {
        self.biz == other.biz
            && self.mid == other.mid
            && self.idx == other.idx
            && !matches!(
                (self.sn.as_deref(), other.sn.as_deref()),
                (Some(left), Some(right)) if left != right
            )
    }

    fn merge_transient_fields(&mut self, other: Self) {
        if self.sn.is_none() {
            self.sn = other.sn;
            self.canonical_url =
                safe_canonical_wechat_url(&self.biz, &self.mid, &self.idx, self.sn.as_deref())
                    .unwrap_or_else(|| self.canonical_url.clone());
        }
        if self.short_url.is_none() {
            self.short_url = other.short_url;
        }
        if self.authorized_url.is_none() {
            self.authorized_url = other.authorized_url;
        }
        if self.authorized_cache_key.is_none() {
            self.authorized_cache_key = other.authorized_cache_key;
        }
        if self.authorized_cache_filename.is_none() {
            self.authorized_cache_filename = other.authorized_cache_filename;
        }
        self.resolved_at = self.resolved_at.max(other.resolved_at);
    }
}

fn resolve_article_canonical_identity(
    identity: &mut ArticleIdentity,
) -> std::result::Result<Option<WechatCanonicalIdentity>, String> {
    let now = system_time_to_unix(SystemTime::now());
    let source_url = reqwest::Url::parse(&identity.source_url).ok();
    let mut resolved = source_url.as_ref().and_then(|url| {
        canonical_identity_from_url(
            url,
            safe_short_wechat_url(url),
            authorized_wechat_url(url),
            now,
        )
    });

    if resolved.is_none() {
        resolved = load_persisted_canonical_identity(&identity.aid)
            .map_err(|error| format!("无法读取文章的微信规范身份映射：{error}"))?;
    }

    match find_canonical_identity_in_wechat_share_data(identity, resolved.as_ref()) {
        Ok(Some(shared)) => match resolved.as_mut() {
            Some(current) if current.same_article_as(&shared) => {
                current.merge_transient_fields(shared)
            }
            Some(_) => {
                log::warn!(
                    "[DEBUG][public_metrics] ignored conflicting Share Data identity aid={}",
                    identity.aid
                );
            }
            None => resolved = Some(shared),
        },
        Ok(None) => {}
        Err(error) => {
            log::warn!(
                "[DEBUG][public_metrics] Share Data identity resolution failed aid={} error={error}",
                identity.aid
            );
        }
    }

    let Some(canonical) = resolved else {
        log::info!(
            "[DEBUG][public_metrics] canonical identity unresolved aid={}",
            identity.aid
        );
        return Ok(None);
    };
    if canonical.biz != identity.fakeid {
        return Err("微信规范身份中的公众号与当前文章不一致，已停止使用该映射".to_string());
    }
    upsert_canonical_identity(&identity.aid, &canonical)
        .map_err(|error| format!("无法保存文章的微信规范身份映射：{error}"))?;
    identity.apply_canonical_identity(&canonical);
    log::info!(
        "[DEBUG][public_metrics] canonical identity resolved aid={} mid={} idx={} has_sn={} has_authorized_url={}",
        identity.aid,
        canonical.mid,
        canonical.idx,
        canonical.sn.is_some(),
        canonical.authorized_url.is_some()
    );
    Ok(Some(canonical))
}

fn canonical_identity_from_url(
    url: &reqwest::Url,
    short_url: Option<String>,
    authorized_url: Option<reqwest::Url>,
    resolved_at: i64,
) -> Option<WechatCanonicalIdentity> {
    if url.scheme() != "https"
        || url.host_str() != Some("mp.weixin.qq.com")
        || !(url.path() == "/s" || url.path().starts_with("/s/"))
    {
        return None;
    }
    let biz = query_value(url, &["__biz"])?;
    let mid = query_value(url, &["mid", "appmsgid"])?;
    let idx = query_value(url, &["idx", "itemidx"]).unwrap_or_else(|| "1".to_string());
    let sn = query_value(url, &["sn"]);
    WechatCanonicalIdentity::new(biz, mid, idx, sn, short_url, authorized_url, resolved_at)
}

fn valid_wechat_biz(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=' | b'-' | b'_')
        })
}

fn valid_decimal_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_digit())
}

fn valid_wechat_sn(value: &str) -> bool {
    value.len() <= 256
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn safe_canonical_wechat_url(biz: &str, mid: &str, idx: &str, sn: Option<&str>) -> Option<String> {
    if !valid_wechat_biz(biz)
        || !valid_decimal_identifier(mid)
        || !valid_decimal_identifier(idx)
        || sn.is_some_and(|value| !valid_wechat_sn(value))
    {
        return None;
    }
    let mut url = reqwest::Url::parse("https://mp.weixin.qq.com/s").ok()?;
    {
        let mut pairs = url.query_pairs_mut();
        pairs.append_pair("__biz", biz);
        pairs.append_pair("mid", mid);
        pairs.append_pair("idx", idx);
        if let Some(sn) = sn {
            pairs.append_pair("sn", sn);
        }
    }
    Some(url.to_string())
}

fn safe_short_wechat_url(url: &reqwest::Url) -> Option<String> {
    if url.scheme() != "https"
        || url.host_str() != Some("mp.weixin.qq.com")
        || !url.path().starts_with("/s/")
        || url.path().len() <= 3
    {
        return None;
    }
    let mut safe = reqwest::Url::parse("https://mp.weixin.qq.com").ok()?;
    safe.set_path(url.path());
    Some(safe.to_string())
}

fn authorized_wechat_url(url: &reqwest::Url) -> Option<reqwest::Url> {
    const AUTH_QUERY_NAMES: &[&str] =
        &["key", "pass_ticket", "exportkey", "appmsg_token", "wxtoken"];
    AUTH_QUERY_NAMES
        .iter()
        .any(|name| query_value(url, &[*name]).is_some())
        .then(|| url.clone())
}

fn parse_wechat_page_key(value: &str) -> Option<(String, String, String)> {
    let (biz_mid, idx) = value.trim().rsplit_once('_')?;
    let (biz, mid) = biz_mid.rsplit_once('_')?;
    if !valid_wechat_biz(biz) || !valid_decimal_identifier(mid) || !valid_decimal_identifier(idx) {
        return None;
    }
    Some((biz.to_string(), mid.to_string(), idx.to_string()))
}

fn canonical_identity_from_share_row(
    identity: &ArticleIdentity,
    short_url: &str,
    real_url: &str,
    share_data: &[u8],
    resolved_at: i64,
) -> Option<WechatCanonicalIdentity> {
    let share: Value = serde_json::from_slice(share_data).ok()?;
    let title = share.get("title").and_then(Value::as_str)?;
    if normalized_title_key(title) != normalized_title_key(&identity.title) {
        return None;
    }
    if let (Some(expected), Some(actual)) = (
        identity.publisher.as_deref(),
        share.get("brandName").and_then(Value::as_str),
    ) {
        if normalized_title_key(expected) != normalized_title_key(actual) {
            return None;
        }
    }
    let page_key = share.get("pageKey").and_then(Value::as_str)?;
    let (biz, mid, idx) = parse_wechat_page_key(page_key)?;
    if biz != identity.fakeid {
        return None;
    }

    let short_url = reqwest::Url::parse(short_url)
        .ok()
        .and_then(|url| safe_short_wechat_url(&url));
    let authorized_url = reqwest::Url::parse(real_url).ok().filter(|url| {
        url.scheme() == "https"
            && url.host_str() == Some("mp.weixin.qq.com")
            && (url.path() == "/s" || url.path().starts_with("/s/"))
    });
    let sn = authorized_url
        .as_ref()
        .and_then(|url| canonical_identity_from_url(url, None, None, resolved_at))
        .filter(|canonical| canonical.biz == biz && canonical.mid == mid && canonical.idx == idx)
        .and_then(|canonical| canonical.sn);

    let mut canonical =
        WechatCanonicalIdentity::new(biz, mid, idx, sn, short_url, authorized_url, resolved_at)?;
    if canonical.authorized_url.is_some() {
        canonical.authorized_cache_key = Some(format!("1/0/{}", real_url.trim()));
    }
    Some(canonical)
}

fn find_canonical_identity_in_wechat_share_data(
    identity: &ArticleIdentity,
    expected: Option<&WechatCanonicalIdentity>,
) -> std::result::Result<Option<WechatCanonicalIdentity>, String> {
    let profiles = discover_wechat_profiles()?;
    let mut matched = None::<WechatCanonicalIdentity>;
    let mut scanned_rows = 0_usize;
    for (profile, _) in profiles {
        let path = profile.join("Share Data");
        if !path.is_file() {
            continue;
        }
        let resolved_at = path
            .metadata()
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(system_time_to_unix)
            .unwrap_or_default();
        let conn = match open_immutable_sqlite(&path) {
            Ok(conn) => conn,
            Err(error) => {
                log::warn!(
                    "[DEBUG][public_metrics] Share Data open skipped profile={} error={error}",
                    profile
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("unknown")
                );
                continue;
            }
        };
        let mut statement = conn
            .prepare(
                "SELECT url, real_url, share_data
                 FROM share_data_table
                 WHERE length(share_data) > 2
                 ORDER BY id DESC",
            )
            .map_err(|error| format!("无法读取微信 Share Data 表：{error}"))?;
        let mut rows = statement
            .query([])
            .map_err(|error| format!("无法查询微信 Share Data：{error}"))?;
        while let Some(row) = rows
            .next()
            .map_err(|error| format!("读取微信 Share Data 记录失败：{error}"))?
        {
            scanned_rows += 1;
            let Ok(short_url) = row.get::<_, String>(0) else {
                continue;
            };
            let Ok(real_url) = row.get::<_, String>(1) else {
                continue;
            };
            let Ok(share_data) = row.get::<_, Vec<u8>>(2) else {
                continue;
            };
            let Some(candidate) = canonical_identity_from_share_row(
                identity,
                &short_url,
                &real_url,
                &share_data,
                resolved_at,
            ) else {
                continue;
            };
            if expected.is_some_and(|expected| !expected.same_article_as(&candidate)) {
                continue;
            }
            match matched.as_mut() {
                None => matched = Some(candidate),
                Some(current) if current.same_article_as(&candidate) => {
                    current.merge_transient_fields(candidate)
                }
                Some(_) => {
                    return Err(
                        "本机微信中存在同公众号、同标题但身份不同的文章，拒绝猜测目标".to_string(),
                    );
                }
            }
        }
    }
    log::info!(
        "[DEBUG][public_metrics] Share Data scan aid={} rows={} matched={}",
        identity.aid,
        scanned_rows,
        matched.is_some()
    );
    Ok(matched)
}

fn open_immutable_sqlite(path: &Path) -> Result<Connection> {
    let mut uri =
        reqwest::Url::from_file_path(path).map_err(|_| anyhow::anyhow!("invalid SQLite path"))?;
    uri.set_query(Some("immutable=1"));
    Connection::open_with_flags(
        uri.as_str(),
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_URI
            | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| format!("open read-only SQLite database {}", path.display()))
}

fn normalize_source_url(value: &str) -> Result<reqwest::Url, CmdError> {
    let url = reqwest::Url::parse(value.trim()).map_err(|error| CmdError {
        message: format!("文章链接无效: {error}"),
    })?;
    if url.scheme() != "https"
        || !url
            .host_str()
            .is_some_and(|host| host.eq_ignore_ascii_case("mp.weixin.qq.com"))
    {
        return Err(CmdError {
            message: "仅支持抓取 mp.weixin.qq.com 的公开文章数据".to_string(),
        });
    }
    Ok(url)
}

fn capture_from_local_wechat_cache(
    identity: &mut ArticleIdentity,
    canonical_identity: Option<&WechatCanonicalIdentity>,
) -> std::result::Result<CaptureOutcome, String> {
    log::info!(
        "trying local WeChat metrics routes (has_mid={}, title_chars={})",
        identity.mid.is_some(),
        identity.title.chars().count()
    );
    let profiles = discover_wechat_profiles()?;
    let mut matched_article = false;

    let exact_cache_filename = canonical_identity.and_then(|canonical| {
        canonical.authorized_cache_filename.clone().or_else(|| {
            canonical
                .authorized_cache_key
                .as_deref()
                .map(|key| chromium_simple_cache_filename(key, 0))
        })
    });
    if let Some(cache_filename) = exact_cache_filename.as_deref() {
        match capture_from_authorized_cache_filename(identity, &profiles, cache_filename) {
            Ok(outcome) => return Ok(outcome),
            Err(matched) => matched_article |= matched,
        }
    }

    // The current WeChat 4.x profile page no longer exposes a reusable
    // appmsg_token. Prefer a small recent-cache pass, then drive WeChat's own
    // authenticated search while watching only files changed by this action.
    // This keeps a 1 GB / 40k-entry cache from turning one click into minutes.
    let recent_since = system_time_to_unix(SystemTime::now()).saturating_sub(15 * 60);
    if !profiles.is_empty() {
        match capture_from_profiles_cache(
            identity,
            &profiles,
            CAPTURE_METHOD,
            Some(recent_since),
            Some("recent-cache"),
        ) {
            Ok(outcome) => return Ok(outcome),
            Err(matched) => matched_article |= matched,
        }
    }

    if profiles.is_empty() {
        log::info!("no existing WeChat web profiles; continuing with automatic navigation");
    }

    let mut sogou_error = None;
    // Once the exact WeChat identity has been persisted, resolving the same
    // Sogou redirect again cannot add authorization or counters. Avoid the
    // extra network round-trip on every subsequent capture.
    let has_account_scoped_navigation = identity
        .publisher
        .as_deref()
        .is_some_and(|publisher| !publisher.trim().is_empty())
        && !identity.fakeid.trim().is_empty();
    if identity.aid.starts_with("sogou:")
        && canonical_identity.is_none()
        && !has_account_scoped_navigation
    {
        match resolve_fresh_sogou_article(identity) {
            Ok(fresh_article) => {
                if let Some(outcome) = fresh_article.embedded_metrics {
                    return Ok(outcome);
                }
                // Fresh Sogou pages establish the exact canonical identity,
                // but current WeChat pages no longer expose the native
                // appmsg token needed for counters. Do not repeat the same
                // rejected HTTP request; continue directly to one authorized
                // local navigation.
                sogou_error =
                    Some("后台已精确定位文章，但公开计数仍需本机微信的登录授权".to_string());
            }
            Err(error) => {
                log::warn!(
                    "[DEBUG][public_metrics] Sogou backend metrics route failed aid={} error={error}",
                    identity.aid
                );
                sogou_error = Some(error);
            }
        }

        // Resolution can establish the exact `biz/mid/idx/sn` even when the
        // anonymous counter request is rejected. Re-scan the bounded recent
        // cache with that identity before dispatching any navigation.
        if identity.mid.is_some() {
            match capture_from_profiles_cache(
                identity,
                &profiles,
                CAPTURE_METHOD,
                Some(recent_since),
                Some("post-sogou-identity-cache"),
            ) {
                Ok(outcome) => return Ok(outcome),
                Err(matched) => matched_article |= matched,
            }
        }
    }
    if identity.aid.starts_with("sogou:")
        && canonical_identity.is_none()
        && has_account_scoped_navigation
    {
        log::info!(
            "[DEBUG][public_metrics] skipped Sogou preflight because exact account-scoped navigation is available aid={}",
            identity.aid
        );
    }

    match capture_after_automatic_wechat_navigation(identity, &profiles) {
        Ok(outcome) => {
            log::info!("automatic WeChat navigation produced a matching metrics snapshot");
            Ok(outcome)
        }
        Err(automatic_error) => {
            log::warn!("automatic WeChat metrics route failed: {automatic_error}");
            if matched_article {
                return Err(format!(
                    "已找到这篇文章的近期缓存，但其中没有阅读量字段；{automatic_error}"
                ));
            }
            Err(match sogou_error {
                Some(sogou_error) => format!("{sogou_error}；{automatic_error}"),
                None => automatic_error,
            })
        }
    }
}

fn resolve_fresh_sogou_article(
    identity: &mut ArticleIdentity,
) -> std::result::Result<FreshSogouArticle, String> {
    let started = Instant::now();
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(4))
        .cookie_store(true)
        .build()
        .map_err(|_| "无法初始化搜狗微信文章解析请求".to_string())?;
    let (result_url, search_url) = resolve_fresh_sogou_result(&client, identity)?;
    log::info!(
        "[DEBUG][public_metrics] Sogou exact result resolved aid={} elapsed_ms={}",
        identity.aid,
        started.elapsed().as_millis()
    );

    let redirect_response = client
        .get(result_url)
        .header(USER_AGENT, SOGOU_BROWSER_USER_AGENT)
        .header(REFERER, search_url.as_str())
        .send()
        .map_err(|_| "搜狗文章跳转页暂时不可用".to_string())?;
    if !redirect_response.status().is_success() {
        return Err(format!(
            "搜狗文章跳转页返回 HTTP {}",
            redirect_response.status()
        ));
    }
    let redirect_html = response_text_with_limit(
        redirect_response,
        MAX_SOGOU_REDIRECT_BYTES,
        "搜狗文章跳转响应",
    )?;
    let fresh_url = fresh_wechat_url_from_sogou_redirect(&redirect_html)?;

    let page_response = client
        .get(fresh_url.clone())
        .header(USER_AGENT, WECHAT_CLIENT_USER_AGENT)
        .header(REFERER, SOGOU_BASE_URL)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .map_err(|_| "搜狗已定位文章，但微信文章页请求失败".to_string())?;
    if !page_response.status().is_success() {
        return Err(format!("微信文章页返回 HTTP {}", page_response.status()));
    }
    let final_url = page_response.url().clone();
    if final_url.path().contains("wappoc_appmsgcaptcha") {
        return Err("微信要求验证当前文章访问，已停止后台解析".to_string());
    }
    let page = response_text_with_limit(
        page_response,
        MAX_WECHAT_ARTICLE_PAGE_BYTES,
        "微信文章页响应",
    )?;
    let page_title =
        extract_page_title(&page).ok_or_else(|| "微信文章页没有返回可校验的标题".to_string())?;
    if normalized_title_key(&page_title) != normalized_title_key(&identity.title) {
        return Err("搜狗返回了标题不匹配的微信文章，已停止写入".to_string());
    }
    let canonical = canonical_identity_from_page_script(&page, &final_url)
        .ok_or_else(|| "微信文章页缺少规范文章 ID".to_string())?;
    if canonical.biz != identity.fakeid {
        return Err("搜狗返回文章的公众号与目标公众号不一致，已停止写入".to_string());
    }
    upsert_canonical_identity(&identity.aid, &canonical)
        .map_err(|error| format!("无法保存搜狗解析出的微信文章身份：{error}"))?;
    identity.apply_canonical_identity(&canonical);
    log::info!(
        "[DEBUG][public_metrics] Sogou canonical identity persisted aid={} mid={} idx={} has_sn={} elapsed_ms={}",
        identity.aid,
        canonical.mid,
        canonical.idx,
        canonical.sn.is_some(),
        started.elapsed().as_millis()
    );

    let embedded_metrics = parse_metrics_from_html(&page);
    let embedded_metrics = embedded_metrics.has_any().then(|| CaptureOutcome {
        source_kind: SOURCE_KIND,
        method: SOGOU_RESOLUTION_CAPTURE_METHOD,
        metrics: embedded_metrics,
        captured_at: system_time_to_unix(SystemTime::now()),
        note: Some("通过后台刷新搜狗结果并校验微信文章身份后读取公开互动数据。".to_string()),
    });

    Ok(FreshSogouArticle {
        authorized_url: fresh_url,
        embedded_metrics,
    })
}

fn resolve_fresh_sogou_result(
    client: &reqwest::blocking::Client,
    identity: &ArticleIdentity,
) -> std::result::Result<(reqwest::Url, reqwest::Url), String> {
    let mut queries = vec![(identity.title.trim().to_string(), 1_usize)];
    if let Ok(Some(account)) = db::get_account(&identity.fakeid) {
        if let Some(alias) = account.alias.map(|value| value.trim().to_string()) {
            if !alias.is_empty() {
                queries.push((alias, MAX_SOGOU_ACCOUNT_SEARCH_PAGES));
            }
        }
    }
    if let Some(publisher) = identity.publisher.as_deref().map(str::trim) {
        if !publisher.is_empty() {
            queries.push((publisher.to_string(), MAX_SOGOU_ACCOUNT_SEARCH_PAGES));
        }
    }
    let mut seen_queries = HashSet::new();
    queries.retain(|(query, _)| seen_queries.insert(normalized_title_key(query)));

    for (query, pages) in queries {
        for page in 1..=pages {
            let mut search_url = reqwest::Url::parse(SOGOU_WECHAT_SEARCH_URL)
                .map_err(|_| "搜狗微信搜索地址无效".to_string())?;
            let page_value = page.to_string();
            search_url.query_pairs_mut().extend_pairs([
                ("type", "2"),
                ("ie", "utf8"),
                ("page", page_value.as_str()),
                ("query", query.as_str()),
            ]);
            let search_response = client
                .get(search_url.clone())
                .header(USER_AGENT, SOGOU_BROWSER_USER_AGENT)
                .header(
                    ACCEPT,
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                )
                .send()
                .map_err(|_| "搜狗微信搜索暂时不可用".to_string())?;
            if !search_response.status().is_success() {
                return Err(format!(
                    "搜狗微信搜索返回 HTTP {}",
                    search_response.status()
                ));
            }
            let search_html = response_text_with_limit(
                search_response,
                MAX_SOGOU_SEARCH_BYTES,
                "搜狗微信搜索响应",
            )?;
            if sogou_page_requires_verification(&search_html) {
                return Err("搜狗微信搜索要求验证码，已停止后台解析".to_string());
            }
            match exact_sogou_result_url(&search_html, identity) {
                Ok(result_url) => return Ok((result_url, search_url)),
                Err(error) if error.contains("没有返回 ID、标题和公众号均匹配") => {}
                Err(error) => return Err(error),
            }
        }
    }
    Err("搜狗微信索引当前未返回目标文章的稳定 ID".to_string())
}

fn response_text_with_limit(
    response: reqwest::blocking::Response,
    maximum_bytes: usize,
    label: &str,
) -> std::result::Result<String, String> {
    let bytes = response.bytes().map_err(|_| format!("无法读取{label}"))?;
    if bytes.len() > maximum_bytes {
        return Err(format!("{label}过大，已停止解析"));
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| format!("{label}不是有效 UTF-8"))
}

fn sogou_page_requires_verification(html: &str) -> bool {
    ["antispider", "请输入验证码", "访问过于频繁", "异常访问"]
        .iter()
        .any(|marker| html.contains(marker))
}

fn exact_sogou_result_url(
    html: &str,
    identity: &ArticleIdentity,
) -> std::result::Result<reqwest::Url, String> {
    let list_item_re =
        Regex::new(r#"(?is)<li\b([^>]*)>(.*?)</li>"#).expect("Sogou result item regex");
    let stable_id_re =
        Regex::new(r#"(?is)\bd=[\"']([^\"']+)[\"']"#).expect("Sogou stable id regex");
    let link_re =
        Regex::new(r#"(?is)<a\b[^>]*\bhref=[\"']([^\"']*?/link\?url=[^\"']+)[\"'][^>]*>(.*?)</a>"#)
            .expect("Sogou result link regex");
    let tags_re = Regex::new(r"(?is)<[^>]+>").expect("HTML tag regex");
    let expected_title = normalized_title_key(&identity.title);
    let expected_publisher = identity
        .publisher
        .as_deref()
        .map(normalized_title_key)
        .filter(|value| !value.is_empty());
    let expected_stable_id = identity
        .aid
        .strip_prefix("sogou:")
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        });
    let mut matches = Vec::new();
    for item in list_item_re.captures_iter(html) {
        let Some(attributes) = item.get(1).map(|value| value.as_str()) else {
            continue;
        };
        let Some(block) = item.get(2).map(|value| value.as_str()) else {
            continue;
        };
        if let Some(expected_stable_id) = expected_stable_id {
            let candidate_stable_id = stable_id_re
                .captures(attributes)
                .and_then(|capture| capture.get(1))
                .map(|value| value.as_str())
                .and_then(|value| value.rsplit('-').next());
            if candidate_stable_id != Some(expected_stable_id) {
                continue;
            }
        }
        let normalized_block = normalized_title_key(&decode_common_html_entities(
            &tags_re.replace_all(block, " "),
        ));
        if expected_publisher
            .as_ref()
            .is_some_and(|publisher| !normalized_block.contains(publisher))
        {
            continue;
        }
        for link in link_re.captures_iter(block) {
            let Some(raw_href) = link.get(1).map(|value| value.as_str()) else {
                continue;
            };
            let Some(raw_title) = link.get(2).map(|value| value.as_str()) else {
                continue;
            };
            let title = decode_common_html_entities(&tags_re.replace_all(raw_title, " "));
            if normalized_title_key(&title) != expected_title {
                continue;
            }
            let href = decode_common_html_entities(raw_href)
                .chars()
                .filter(|character| !character.is_ascii_whitespace())
                .collect::<String>();
            let base =
                reqwest::Url::parse(SOGOU_BASE_URL).map_err(|_| "搜狗基础地址无效".to_string())?;
            let url = base
                .join(&href)
                .map_err(|_| "搜狗文章结果链接无效".to_string())?;
            if url.scheme() != "https"
                || url.host_str() != Some("weixin.sogou.com")
                || url.path() != "/link"
                || query_value(&url, &["url"]).is_none()
            {
                return Err("搜狗文章结果链接不在允许范围内".to_string());
            }
            matches.push(url);
        }
    }
    matches.sort_by(|left, right| left.as_str().cmp(right.as_str()));
    matches.dedup();
    match matches.len() {
        0 => Err("搜狗微信搜索没有返回 ID、标题和公众号均匹配的文章".to_string()),
        1 => Ok(matches.remove(0)),
        _ => Err("搜狗微信搜索返回了多个同 ID 结果，已拒绝猜测".to_string()),
    }
}

fn fresh_wechat_url_from_sogou_redirect(html: &str) -> std::result::Result<reqwest::Url, String> {
    let fragment_re =
        Regex::new(r#"url\s*\+=\s*'([^']*)'"#).expect("Sogou redirect fragment regex");
    let mut value = String::new();
    for capture in fragment_re.captures_iter(html) {
        let Some(fragment) = capture.get(1).map(|value| value.as_str()) else {
            continue;
        };
        value.push_str(&decode_simple_js_string(fragment)?);
    }
    let value = decode_common_html_entities(&value)
        .replace('@', "")
        .chars()
        .filter(|character| !character.is_ascii_whitespace())
        .collect::<String>();
    let url = reqwest::Url::parse(&value)
        .map_err(|_| "搜狗文章跳转页没有返回有效微信地址".to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("mp.weixin.qq.com")
        || !(url.path() == "/s" || url.path().starts_with("/s/"))
    {
        return Err("搜狗文章跳转目标不是微信文章".to_string());
    }
    Ok(url)
}

fn decode_simple_js_string(value: &str) -> std::result::Result<String, String> {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(character) = chars.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        let Some(escaped) = chars.next() else {
            return Err("搜狗文章跳转脚本转义不完整".to_string());
        };
        match escaped {
            'n' => output.push('\n'),
            'r' => output.push('\r'),
            't' => output.push('\t'),
            '\\' | '/' | '\'' | '"' => output.push(escaped),
            'x' => {
                let digits = chars.by_ref().take(2).collect::<String>();
                let value = u8::from_str_radix(&digits, 16)
                    .map_err(|_| "搜狗文章跳转脚本包含无效十六进制转义".to_string())?;
                output.push(char::from(value));
            }
            'u' => {
                let digits = chars.by_ref().take(4).collect::<String>();
                let value = u32::from_str_radix(&digits, 16)
                    .ok()
                    .and_then(char::from_u32)
                    .ok_or_else(|| "搜狗文章跳转脚本包含无效 Unicode 转义".to_string())?;
                output.push(value);
            }
            other => output.push(other),
        }
    }
    Ok(output)
}

fn canonical_identity_from_page_script(
    page: &str,
    final_url: &reqwest::Url,
) -> Option<WechatCanonicalIdentity> {
    let scalar = |name: &str| {
        extract_js_scalar_value(page, name)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };
    let biz = query_value(final_url, &["__biz"]).or_else(|| scalar("biz"))?;
    let mid = query_value(final_url, &["mid", "appmsgid"]).or_else(|| scalar("mid"))?;
    let idx = query_value(final_url, &["idx", "itemidx"])
        .or_else(|| scalar("idx"))
        .unwrap_or_else(|| "1".to_string());
    let sn = query_value(final_url, &["sn"]).or_else(|| scalar("sn"));
    WechatCanonicalIdentity::new(
        biz,
        mid,
        idx,
        sn,
        None,
        None,
        system_time_to_unix(SystemTime::now()),
    )
}

#[allow(dead_code)]
fn capture_from_authorized_wechat_page(
    identity: &ArticleIdentity,
    authorized_url: &reqwest::Url,
) -> std::result::Result<CaptureOutcome, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(4))
        .cookie_store(true)
        .build()
        .map_err(|_| "无法初始化微信文章授权请求".to_string())?;
    let page_response = client
        .get(authorized_url.clone())
        .header(USER_AGENT, WECHAT_CLIENT_USER_AGENT)
        .header(
            ACCEPT,
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        )
        .send()
        .map_err(|_| "本机微信文章授权地址暂时不可用".to_string())?;
    if !page_response.status().is_success() {
        return Err(format!(
            "本机微信文章授权页返回 HTTP {}",
            page_response.status()
        ));
    }
    let final_url = page_response.url().clone();
    if final_url.path().contains("wappoc_appmsgcaptcha") {
        return Err("本机微信文章授权已过期".to_string());
    }
    let page = page_response
        .text()
        .map_err(|_| "无法读取本机微信文章授权页".to_string())?;
    let canonical = canonical_identity_from_url(&final_url, None, None, 0)
        .or_else(|| canonical_identity_from_url(authorized_url, None, None, 0))
        .or_else(|| canonical_identity_from_page_script(&page, &final_url))
        .ok_or_else(|| "本机微信文章授权页缺少规范文章身份".to_string())?;
    if canonical.biz != identity.fakeid
        || identity.mid.as_deref() != Some(canonical.mid.as_str())
        || identity
            .idx
            .as_deref()
            .is_some_and(|expected| expected != canonical.idx)
    {
        return Err("本机微信授权页返回了其他文章，已拒绝读取".to_string());
    }
    if let Some(page_title) = extract_page_title(&page) {
        if normalized_title_key(&page_title) != normalized_title_key(&identity.title) {
            return Err("本机微信授权页标题与目标文章不一致".to_string());
        }
    }

    let scalar = |name: &str, fallback: &str| {
        extract_js_scalar_value(&page, name).unwrap_or_else(|| fallback.to_string())
    };
    let biz = scalar("biz", &canonical.biz);
    let mid = scalar("mid", &canonical.mid);
    let idx = scalar("idx", &canonical.idx);
    let sn = scalar("sn", canonical.sn.as_deref().unwrap_or_default());
    if biz != canonical.biz || mid != canonical.mid || idx != canonical.idx {
        return Err("本机微信授权页脚本中的文章身份不一致".to_string());
    }
    let device_type = scalar("devicetype", "UnifiedPCMac");
    let client_version = scalar("clientversion", "");
    let page_title = scalar("msg_title", &identity.title);
    let session_field_present = |name: &str| {
        extract_js_string_value(&page, name)
            .or_else(|| extract_js_scalar_value(&page, name))
            .or_else(|| query_value(&final_url, &[name]))
            .or_else(|| query_value(authorized_url, &[name]))
            .is_some_and(|value| !value.is_empty())
    };
    log::info!(
        "[DEBUG][public_metrics] authorized article session fields page_bytes={} uin={} key={} pass_ticket={} appmsg_token={} wxtoken={} clientversion={}",
        page.len(),
        session_field_present("uin"),
        session_field_present("key"),
        session_field_present("pass_ticket"),
        session_field_present("appmsg_token"),
        session_field_present("wxtoken"),
        !client_version.is_empty()
    );
    let mut endpoint = reqwest::Url::parse("https://mp.weixin.qq.com/mp/getappmsgext")
        .map_err(|_| "微信文章互动接口地址无效".to_string())?;
    {
        let session_value = |name: &str| {
            extract_js_string_value(&page, name)
                .or_else(|| extract_js_scalar_value(&page, name))
                .or_else(|| query_value(&final_url, &[name]))
                .or_else(|| query_value(authorized_url, &[name]))
                .filter(|value| !value.is_empty())
        };
        let mut query = endpoint.query_pairs_mut();
        query.append_pair("f", "json");
        query.append_pair("x5", "0");
        query.append_pair("__biz", &biz);
        query.append_pair("devicetype", &device_type);
        query.append_pair("clientversion", &client_version);
        for name in ["uin", "key", "pass_ticket", "wxtoken", "appmsg_token"] {
            if let Some(value) = session_value(name) {
                query.append_pair(name, &value);
            }
        }
        if let Some(enter_id) = query_value(&final_url, &["enterid"]) {
            query.append_pair("enterid", &enter_id);
        }
    }

    let encoded_title = urlencoding::encode(&decode_common_html_entities(&page_title)).into_owned();
    let form = vec![
        ("r", format!("{}", system_time_to_unix(SystemTime::now()))),
        ("__biz", biz.clone()),
        ("appmsg_type", scalar("appmsg_type", "9")),
        ("mid", mid),
        ("sn", sn),
        ("idx", idx),
        ("scene", scalar("source", "0")),
        ("subscene", scalar("subscene", "0")),
        ("ascene", scalar("ascene", "0")),
        ("title", encoded_title),
        ("ct", scalar("ct", "")),
        ("abtest_cookie", scalar("abtest_cookie", "")),
        ("devicetype", device_type),
        ("version", client_version),
        ("is_need_ticket", "0".to_string()),
        ("is_need_ad", "0".to_string()),
        ("comment_id", scalar("comment_id", "")),
        ("is_need_reward", scalar("is_need_reward", "0")),
        ("both_ad", "0".to_string()),
        ("reward_uin_count", "0".to_string()),
        ("send_time", scalar("send_time", "")),
        ("msg_daily_idx", scalar("msg_daily_idx", "")),
        ("is_original", "0".to_string()),
        ("is_only_read", scalar("is_only_read", "0")),
        ("req_id", scalar("req_id", "")),
        ("pass_ticket", scalar("pass_ticket", "")),
        ("is_temp_url", scalar("is_temp_url", "0")),
        ("item_show_type", scalar("item_show_type", "0")),
        ("tmp_version", "1".to_string()),
        ("more_read_type", scalar("more_read_type", "0")),
        ("appmsg_like_type", scalar("appmsg_like_type", "1")),
        ("related_video_sn", "".to_string()),
        ("related_video_num", "5".to_string()),
        ("vid", "".to_string()),
        ("is_pay_subscribe", scalar("isPaySubscribe", "0")),
        ("pay_subscribe_uin_count", "0".to_string()),
        ("has_red_packet_cover", "0".to_string()),
        ("album_video_num", "5".to_string()),
        ("cur_album_id", "".to_string()),
        ("is_public_related_video", "0".to_string()),
        (
            "export_key",
            query_value(&final_url, &["exportkey"]).unwrap_or_default(),
        ),
        ("export_key_extinfo", "".to_string()),
        ("segment_comment_id", scalar("segment_comment_id", "")),
        ("business_type", "0".to_string()),
    ];
    let form_body = form
        .iter()
        .map(|(name, value)| {
            format!(
                "{}={}",
                urlencoding::encode(name),
                urlencoding::encode(value)
            )
        })
        .collect::<Vec<_>>()
        .join("&");
    let response = client
        .post(endpoint)
        .header(USER_AGENT, WECHAT_CLIENT_USER_AGENT)
        .header(ACCEPT, "application/json, text/javascript, */*; q=0.01")
        .header(REFERER, final_url.as_str())
        .header("Origin", "https://mp.weixin.qq.com")
        .header("X-Requested-With", "XMLHttpRequest")
        .header("RDEV_TRANSFER_SCOPE", "mmbizmp")
        .header(
            "Content-Type",
            "application/x-www-form-urlencoded; charset=UTF-8",
        )
        .body(form_body)
        .send()
        .map_err(|_| "微信文章互动接口请求失败".to_string())?;
    if !response.status().is_success() {
        return Err(format!("微信文章互动接口返回 HTTP {}", response.status()));
    }
    let payload: Value = response
        .json()
        .map_err(|_| "微信文章互动接口返回了无法解析的数据".to_string())?;
    let return_code = payload
        .get("base_resp")
        .and_then(|base| json_metric(base, "ret"))
        .unwrap_or_default();
    let mut payload_keys = payload
        .as_object()
        .map(|object| object.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    payload_keys.sort();
    log::info!(
        "[DEBUG][public_metrics] appmsgext response ret={return_code} keys={} has_appmsgstat={} has_appmsgact={}",
        payload_keys.join(","),
        payload.get("appmsgstat").is_some(),
        payload.get("appmsgact").is_some()
    );
    if return_code != 0 {
        return Err(format!("微信文章互动接口未授权本次请求（{return_code}）"));
    }
    let metrics = parse_metrics_from_appmsgext(&payload);
    if !metrics.has_any() {
        return Err("微信文章互动接口没有返回公开计数字段".to_string());
    }
    Ok(CaptureOutcome {
        source_kind: LOCAL_SESSION_SOURCE_KIND,
        method: AUTHORIZED_PAGE_CAPTURE_METHOD,
        metrics,
        captured_at: system_time_to_unix(SystemTime::now()),
        note: Some(
            "通过本机微信保存的目标文章授权会话直接请求互动数据；未执行标题搜索。".to_string(),
        ),
    })
}

fn parse_metrics_from_appmsgext(payload: &Value) -> ParsedMetrics {
    let stats = payload.get("appmsgstat").unwrap_or(&Value::Null);
    let actions = payload.get("appmsgact").unwrap_or(&Value::Null);
    ParsedMetrics {
        read_count: json_metric(stats, "real_read_num").or_else(|| json_metric(stats, "read_num")),
        like_count: json_metric(actions, "old_like_num").or_else(|| json_metric(stats, "like_num")),
        recommend_count: json_metric(actions, "like_num"),
        share_count: json_metric(actions, "share_count")
            .or_else(|| json_metric(actions, "share_num")),
        comment_count: json_metric(payload, "comment_count")
            .or_else(|| json_metric(actions, "comment_count")),
        collect_count: json_metric(actions, "collect_count")
            .or_else(|| json_metric(actions, "favorite_count")),
    }
}

fn discover_wechat_profiles() -> std::result::Result<Vec<(PathBuf, i64)>, String> {
    let profiles_root = wechat_profiles_root()?;
    let entries = match fs::read_dir(&profiles_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取本机微信网页缓存：{error}")),
    };
    let mut profiles = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name == "multitab" || name.starts_with("multitab_"))
        })
        .filter_map(|entry| {
            let modified_at = entry.metadata().ok()?.modified().ok()?;
            Some((entry.path(), system_time_to_unix(modified_at)))
        })
        .collect::<Vec<_>>();
    profiles.sort_by_key(|(_, modified_at)| std::cmp::Reverse(*modified_at));
    profiles.truncate(MAX_WECHAT_PROFILES);
    Ok(profiles)
}

fn start_cache_change_watcher() -> std::result::Result<Option<CacheChangeWatcher>, String> {
    let profiles_root = wechat_profiles_root()?;
    if !profiles_root.is_dir() {
        return Ok(None);
    }
    let (sender, receiver) = mpsc::channel();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        let Ok(event) = event else {
            return;
        };
        for path in event.paths {
            if !is_simple_cache_data_path(&path) {
                continue;
            }
            let change = match cache_entry_is_article_page(&path) {
                Some(false) => continue,
                Some(true) => snapshot_cache_entry(&path)
                    .map(ObservedCacheChange::Snapshot)
                    .unwrap_or_else(|| ObservedCacheChange::Path(path)),
                None => ObservedCacheChange::Path(path),
            };
            let _ = sender.send(change);
        }
    })
    .map_err(|error| format!("无法监听本机微信缓存变化：{error}"))?;
    watcher
        .watch(&profiles_root, RecursiveMode::Recursive)
        .map_err(|error| format!("无法监听本机微信缓存目录：{error}"))?;
    log::info!("[DEBUG][public_metrics] cache change watcher started");
    Ok(Some(CacheChangeWatcher {
        _watcher: watcher,
        receiver,
    }))
}

fn is_simple_cache_data_path(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.ends_with("_0"))
}

fn cache_entry_is_article_page(path: &Path) -> Option<bool> {
    let metadata = path.metadata().ok()?;
    if metadata.len() <= SIMPLE_CACHE_HEADER_BYTES || metadata.len() > MAX_CACHE_ENTRY_BYTES {
        return Some(false);
    }
    let mut file = File::open(path).ok()?;
    let mut header = [0u8; SIMPLE_CACHE_HEADER_BYTES as usize];
    file.read_exact(&mut header).ok()?;
    if u64::from_le_bytes(header[0..8].try_into().ok()?) != SIMPLE_CACHE_MAGIC {
        return Some(false);
    }
    let key_length = u32::from_le_bytes(header[12..16].try_into().ok()?) as usize;
    if key_length == 0 || key_length > MAX_CACHE_KEY_BYTES {
        return Some(false);
    }
    let mut key = vec![0_u8; key_length];
    file.read_exact(&mut key).ok()?;
    let Some(url) = parse_cache_key_url(&key) else {
        return Some(false);
    };
    Some(
        url.host_str() == Some("mp.weixin.qq.com")
            && (url.path() == "/s" || url.path().starts_with("/s/")),
    )
}

fn snapshot_cache_entry(path: &Path) -> Option<CacheSnapshot> {
    let metadata = path.metadata().ok()?;
    if metadata.len() <= SIMPLE_CACHE_HEADER_BYTES || metadata.len() > MAX_CACHE_ENTRY_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 != metadata.len() {
        return None;
    }
    Some(CacheSnapshot {
        path: path.to_path_buf(),
        modified_at: metadata
            .modified()
            .ok()
            .map(system_time_to_unix)
            .unwrap_or_default(),
        bytes,
    })
}

fn changed_cache_entries(watcher: &CacheChangeWatcher, wait: Duration) -> Vec<ObservedCacheChange> {
    let mut changes = Vec::new();
    if !wait.is_zero() {
        if let Ok(change) = watcher.receiver.recv_timeout(wait) {
            changes.push(change);
        }
    }
    while let Ok(change) = watcher.receiver.try_recv() {
        changes.push(change);
    }
    changes
}

fn capture_from_profiles_cache(
    identity: &ArticleIdentity,
    profiles: &[(PathBuf, i64)],
    method: &'static str,
    modified_since: Option<i64>,
    debug_phase: Option<&str>,
) -> std::result::Result<CaptureOutcome, bool> {
    let started = Instant::now();
    let mut matched_article = false;
    let mut candidate_count = 0_usize;
    for (profile, _) in profiles {
        let cache_dir = profile.join("Cache").join("Cache_Data");
        let candidates = recent_cache_candidates_since(&cache_dir, modified_since);
        candidate_count += candidates.len();
        for candidate in candidates {
            match read_metrics_cache_entry(&candidate, identity) {
                Ok(CacheEntryResult::NotMatched) => {}
                Ok(CacheEntryResult::MatchedWithoutMetrics { canonical }) => {
                    persist_verified_cache_identity(identity, canonical.as_ref());
                    matched_article = true;
                }
                Ok(CacheEntryResult::Metrics { metrics, canonical }) => {
                    persist_verified_cache_identity(identity, canonical.as_ref());
                    if let Some(phase) = debug_phase {
                        log::info!(
                            "[DEBUG][public_metrics] cache scan matched phase={phase} profiles={} candidates={} elapsed_ms={}",
                            profiles.len(),
                            candidate_count,
                            started.elapsed().as_millis()
                        );
                    }
                    return Ok(cache_capture_outcome(
                        method,
                        metrics,
                        candidate.modified_at,
                    ));
                }
                Err(_) => continue,
            }
        }
    }
    if let Some(phase) = debug_phase {
        log::info!(
            "[DEBUG][public_metrics] cache scan missed phase={phase} profiles={} candidates={} modified_since={} matched_without_metrics={} elapsed_ms={}",
            profiles.len(),
            candidate_count,
            modified_since.unwrap_or_default(),
            matched_article,
            started.elapsed().as_millis()
        );
    }
    Err(matched_article)
}

fn chromium_simple_cache_filename(cache_key: &str, file_index: u8) -> String {
    let digest = Sha1::digest(cache_key.as_bytes());
    let mut first_eight = [0_u8; 8];
    first_eight.copy_from_slice(&digest[..8]);
    format!("{:016x}_{file_index}", u64::from_le_bytes(first_eight))
}

fn capture_from_authorized_cache_key(
    identity: &ArticleIdentity,
    profiles: &[(PathBuf, i64)],
    cache_key: &str,
) -> std::result::Result<CaptureOutcome, bool> {
    let filename = chromium_simple_cache_filename(cache_key, 0);
    capture_from_authorized_cache_filename(identity, profiles, &filename)
}

fn capture_from_authorized_cache_filename(
    identity: &ArticleIdentity,
    profiles: &[(PathBuf, i64)],
    filename: &str,
) -> std::result::Result<CaptureOutcome, bool> {
    let started = Instant::now();
    let mut matched_without_metrics = false;
    for (profile, _) in profiles {
        let path = profile.join("Cache").join("Cache_Data").join(&filename);
        let Ok(metadata) = path.metadata() else {
            continue;
        };
        let candidate = CacheCandidate {
            path,
            modified_at: metadata
                .modified()
                .ok()
                .map(system_time_to_unix)
                .unwrap_or_default(),
        };
        match read_metrics_cache_entry(&candidate, identity) {
            Ok(CacheEntryResult::Metrics { metrics, canonical }) => {
                persist_verified_cache_identity(identity, canonical.as_ref());
                log::info!(
                    "[DEBUG][public_metrics] exact hashed cache matched aid={} elapsed_ms={}",
                    identity.aid,
                    started.elapsed().as_millis()
                );
                return Ok(cache_capture_outcome(
                    CAPTURE_METHOD,
                    metrics,
                    candidate.modified_at,
                ));
            }
            Ok(CacheEntryResult::MatchedWithoutMetrics { canonical }) => {
                persist_verified_cache_identity(identity, canonical.as_ref());
                matched_without_metrics = true;
            }
            Ok(CacheEntryResult::NotMatched) | Err(_) => {}
        }
    }
    log::info!(
        "[DEBUG][public_metrics] exact hashed cache missed aid={} matched_without_metrics={} elapsed_ms={}",
        identity.aid,
        matched_without_metrics,
        started.elapsed().as_millis()
    );
    Err(matched_without_metrics)
}

fn capture_from_changed_cache_entries(
    identity: &ArticleIdentity,
    watcher: &CacheChangeWatcher,
    wait: Duration,
    modified_since: i64,
    checked: &mut HashSet<(PathBuf, i64, u64)>,
    matched_without_metrics: &mut bool,
) -> Option<CaptureOutcome> {
    let started = Instant::now();
    let changed_entries = changed_cache_entries(watcher, wait);
    let changed_count = changed_entries.len();
    let mut candidate_count = 0_usize;
    for entry in changed_entries {
        let (path, modified_at, entry_len, snapshot) = match entry {
            ObservedCacheChange::Snapshot(snapshot) => {
                let entry_len = snapshot.bytes.len() as u64;
                (
                    snapshot.path,
                    snapshot.modified_at,
                    entry_len,
                    Some(snapshot.bytes),
                )
            }
            ObservedCacheChange::Path(path) => {
                let Ok(metadata) = path.metadata() else {
                    continue;
                };
                if metadata.len() <= SIMPLE_CACHE_HEADER_BYTES
                    || metadata.len() > MAX_CACHE_ENTRY_BYTES
                {
                    continue;
                }
                let modified_at = metadata
                    .modified()
                    .ok()
                    .map(system_time_to_unix)
                    .unwrap_or_default();
                (path, modified_at, metadata.len(), None)
            }
        };
        if modified_at < modified_since {
            continue;
        }
        let fingerprint = (path.clone(), modified_at, entry_len);
        if checked.contains(&fingerprint) {
            continue;
        }
        candidate_count += 1;
        let result = if let Some(snapshot) = snapshot.as_deref() {
            read_metrics_cache_bytes(snapshot, identity)
        } else {
            read_metrics_cache_entry(
                &CacheCandidate {
                    path: path.clone(),
                    modified_at,
                },
                identity,
            )
        };
        match result {
            Ok(CacheEntryResult::Metrics { metrics, canonical }) => {
                persist_verified_cache_identity(identity, canonical.as_ref());
                log::info!(
                    "[DEBUG][public_metrics] cache event matched changes={changed_count} candidates={candidate_count} snapshotted={} elapsed_ms={}",
                    snapshot.is_some(),
                    started.elapsed().as_millis()
                );
                return Some(cache_capture_outcome(
                    AUTOMATIC_NAVIGATION_CAPTURE_METHOD,
                    metrics,
                    modified_at,
                ));
            }
            Ok(CacheEntryResult::MatchedWithoutMetrics { canonical }) => {
                persist_verified_cache_identity(identity, canonical.as_ref());
                *matched_without_metrics = true;
                checked.insert(fingerprint);
            }
            Ok(CacheEntryResult::NotMatched) => {
                checked.insert(fingerprint);
            }
            Err(_) => {
                // The browser may still be writing this file. A later event
                // will retry it instead of treating a partial read as final.
            }
        }
    }
    if changed_count > 0 {
        log::info!(
            "[DEBUG][public_metrics] cache event missed changes={changed_count} candidates={candidate_count} elapsed_ms={}",
            started.elapsed().as_millis()
        );
    }
    None
}

fn cache_capture_outcome(
    method: &'static str,
    metrics: ParsedMetrics,
    captured_at: i64,
) -> CaptureOutcome {
    let note = if method == AUTOMATIC_NAVIGATION_CAPTURE_METHOD {
        "微探已通过本机微信的授权页面打开目标文章；数据来自微信客户端刚收到的页面快照。"
    } else {
        "数据来自本机微信文章缓存，是微信客户端当时收到的页面快照。"
    };
    CaptureOutcome {
        source_kind: SOURCE_KIND,
        method,
        metrics,
        captured_at,
        note: Some(note.to_string()),
    }
}

fn persist_verified_cache_identity(
    identity: &ArticleIdentity,
    canonical: Option<&WechatCanonicalIdentity>,
) {
    let Some(canonical) = canonical else {
        return;
    };
    match upsert_canonical_identity(&identity.aid, canonical) {
        Ok(()) => log::info!(
            "[DEBUG][public_metrics] verified cache identity persisted aid={} mid={} idx={} has_sn={}",
            identity.aid,
            canonical.mid,
            canonical.idx,
            canonical.sn.is_some()
        ),
        Err(error) => log::warn!(
            "[DEBUG][public_metrics] verified cache identity persistence failed aid={} error={error}",
            identity.aid
        ),
    }
}

#[derive(Debug)]
struct CachedWechatSession {
    bootstrap_url: reqwest::Url,
    modified_at: i64,
}

#[derive(Debug)]
struct HistoryArticle {
    title: String,
    content_url: String,
    published_at: i64,
}

fn capture_after_automatic_wechat_navigation(
    identity: &ArticleIdentity,
    initial_profiles: &[(PathBuf, i64)],
) -> std::result::Result<CaptureOutcome, String> {
    #[cfg(target_os = "macos")]
    if identity
        .publisher
        .as_deref()
        .is_some_and(|publisher| !publisher.trim().is_empty())
        && !identity.fakeid.trim().is_empty()
    {
        return capture_from_wechat_account_feed(identity);
    }

    let started = Instant::now();
    let modified_since = system_time_to_unix(SystemTime::now()).saturating_sub(5);
    let cache_watcher = match start_cache_change_watcher() {
        Ok(watcher) => watcher,
        Err(error) => {
            log::warn!("[DEBUG][public_metrics] cache watcher unavailable error={error}");
            None
        }
    };
    let mut matched_without_metrics = false;
    let mut checked_event_candidates = HashSet::new();

    // A successful AXPress only proves that macOS accepted the synthetic
    // action; WeChat may still leave the search-results page unchanged. Treat
    // a matching metrics cache entry as the navigation postcondition. Do not
    // restart the global search automatically: every global search creates a
    // new WeChat browser page, so one user action must create at most one page.
    log::info!(
        "[DEBUG][public_metrics] automatic navigation started modified_since={modified_since}"
    );
    // Even a canonical public URL still needs WeChat's native H5ExtTransfer
    // route before the social counters are authorized.
    #[cfg(target_os = "macos")]
    let navigation = open_wechat_article_automatically(identity)?;
    #[cfg(not(target_os = "macos"))]
    open_wechat_article_automatically(identity)?;
    log::info!(
        "[DEBUG][public_metrics] automatic navigation dispatched elapsed_ms={}",
        started.elapsed().as_millis()
    );
    let outcome = wait_for_automatic_capture(
        identity,
        initial_profiles,
        cache_watcher.as_ref(),
        modified_since,
        WECHAT_NAVIGATION_TIMEOUT,
        &mut checked_event_candidates,
        &mut matched_without_metrics,
        started,
    );
    #[cfg(target_os = "macos")]
    navigation.finish(true);
    if let Some(outcome) = outcome {
        return Ok(outcome);
    }
    log::warn!(
        "[DEBUG][public_metrics] automatic navigation unconfirmed timeout_ms={} matched_without_metrics={matched_without_metrics} elapsed_ms={}",
        WECHAT_NAVIGATION_TIMEOUT.as_millis(),
        started.elapsed().as_millis()
    );
    if matched_without_metrics {
        Err("微信已尝试打开目标文章，但页面未返回阅读量字段；文章可能已删除、不可见或当前账号无权访问。".to_string())
    } else {
        Err("微信已尝试打开目标文章，但没有生成可匹配的文章缓存；本次不会继续新建搜索窗口，请稍后重试。".to_string())
    }
}

#[cfg(target_os = "macos")]
fn capture_from_wechat_account_feed(
    identity: &ArticleIdentity,
) -> std::result::Result<CaptureOutcome, String> {
    let started = Instant::now();
    let capture_started_ms = system_time_to_unix_millis(SystemTime::now()).saturating_sub(3_000);
    let local_articles = db::list_articles(&identity.fakeid)
        .map_err(|error| format!("无法读取该公众号的本地文章列表：{error}"))?;
    if local_articles.is_empty() {
        return Err("该公众号没有可更新的本地文章".to_string());
    }

    let mut canonical_aids = HashMap::<(String, String), String>::new();
    for article in &local_articles {
        if let Ok(Some(canonical)) = load_persisted_canonical_identity(&article.aid) {
            if canonical.biz == identity.fakeid {
                canonical_aids.insert((canonical.mid, canonical.idx), article.aid.clone());
            }
        }
    }
    let mut title_aids = HashMap::<String, Vec<usize>>::new();
    for (index, article) in local_articles.iter().enumerate() {
        title_aids
            .entry(normalized_title_key(&article.title))
            .or_default()
            .push(index);
    }

    log::info!(
        "[DEBUG][public_metrics] account feed capture started aid={} local_articles={} canonical_articles={}",
        identity.aid,
        local_articles.len(),
        canonical_aids.len()
    );
    let mut navigation = open_wechat_article_automatically(identity)?;
    let traversal_deadline = Instant::now() + ACCOUNT_FEED_TRAVERSAL_TIMEOUT;
    let initial_deadline = Instant::now() + ACCOUNT_FEED_INITIAL_TIMEOUT;
    let mut seen_versions = HashSet::<(String, String, i64)>::new();
    let mut observed_articles = HashSet::<(String, String)>::new();
    let mut matched_aids = HashSet::<String>::new();
    let mut persisted_aids = HashSet::<String>::new();
    let mut target_outcome = None;
    let mut initial_batch_seen = false;
    let mut page_count = 0_usize;
    let mut stagnant_pages = 0_usize;

    let traversal_result = (|| -> std::result::Result<(), String> {
        loop {
            let records = crate::wechat_account_feed::read_account_feed_metrics(
                &identity.fakeid,
                capture_started_ms,
            )?;
            let observed_before = observed_articles.len();
            persist_account_feed_records(
                identity,
                &records,
                &local_articles,
                &canonical_aids,
                &title_aids,
                &mut seen_versions,
                &mut observed_articles,
                &mut matched_aids,
                &mut persisted_aids,
                &mut target_outcome,
            );
            if observed_articles.len() > observed_before {
                initial_batch_seen = true;
                break;
            }
            if Instant::now() >= initial_deadline {
                return Err("已进入目标公众号，但微信没有返回公众号文章列表的批量数据".to_string());
            }
            thread::sleep(Duration::from_millis(80));
        }

        // The user's requested article is the latency-critical result. Every
        // batch encountered on the way is still persisted for its sibling
        // local articles, but do not keep the UI spinner alive solely to walk
        // older unrelated pages after the target has been found.
        while target_outcome.is_none()
            && matched_aids.len() < local_articles.len()
            && page_count < MAX_ACCOUNT_FEED_PAGES
            && Instant::now() < traversal_deadline
            && stagnant_pages < MAX_ACCOUNT_FEED_STAGNANT_PAGES
        {
            let observed_before = observed_articles.len();
            navigation.load_next_account_feed_page()?;
            page_count += 1;
            let page_deadline =
                (Instant::now() + ACCOUNT_FEED_PAGE_TIMEOUT).min(traversal_deadline);
            while Instant::now() < page_deadline {
                let records = crate::wechat_account_feed::read_account_feed_metrics(
                    &identity.fakeid,
                    capture_started_ms,
                )?;
                persist_account_feed_records(
                    identity,
                    &records,
                    &local_articles,
                    &canonical_aids,
                    &title_aids,
                    &mut seen_versions,
                    &mut observed_articles,
                    &mut matched_aids,
                    &mut persisted_aids,
                    &mut target_outcome,
                );
                if observed_articles.len() > observed_before {
                    break;
                }
                thread::sleep(Duration::from_millis(70));
            }
            if observed_articles.len() > observed_before {
                stagnant_pages = 0;
            } else {
                stagnant_pages += 1;
            }
            log::info!(
                "[DEBUG][public_metrics] account feed page processed page={} matched_local={} total_local={} batch_records={} stagnant_pages={} elapsed_ms={}",
                page_count,
                matched_aids.len(),
                local_articles.len(),
                observed_articles.len(),
                stagnant_pages,
                started.elapsed().as_millis()
            );
        }
        Ok(())
    })();

    navigation.finish(true);
    log::info!(
        "[DEBUG][public_metrics] account feed capture finished aid={} initial_batch_seen={} pages={} matched_local={} persisted_other={} target_found={} elapsed_ms={}",
        identity.aid,
        initial_batch_seen,
        page_count,
        matched_aids.len(),
        persisted_aids.len(),
        target_outcome.is_some(),
        started.elapsed().as_millis()
    );
    if let Some(outcome) = target_outcome {
        return Ok(outcome);
    }
    if let Err(error) = traversal_result {
        return Err(error);
    }
    Err(format!(
        "已读取该公众号的文章列表并更新 {} 篇本地文章，但尚未遍历到目标文章；本次没有使用标题搜索或打开错误文章。",
        matched_aids.len()
    ))
}

#[cfg(target_os = "macos")]
#[allow(clippy::too_many_arguments)]
fn persist_account_feed_records(
    requested: &ArticleIdentity,
    records: &[crate::wechat_account_feed::AccountFeedArticleMetrics],
    local_articles: &[db::ArticleSummary],
    canonical_aids: &HashMap<(String, String), String>,
    title_aids: &HashMap<String, Vec<usize>>,
    seen_versions: &mut HashSet<(String, String, i64)>,
    observed_articles: &mut HashSet<(String, String)>,
    matched_aids: &mut HashSet<String>,
    persisted_aids: &mut HashSet<String>,
    target_outcome: &mut Option<CaptureOutcome>,
) {
    for record in records {
        observed_articles.insert((record.mid.clone(), record.idx.clone()));
        let version = (
            record.mid.clone(),
            record.idx.clone(),
            record.update_time_ms,
        );
        if !seen_versions.insert(version) {
            continue;
        }
        let Some(article) =
            match_local_account_article(record, local_articles, canonical_aids, title_aids)
        else {
            continue;
        };
        let metrics = ParsedMetrics {
            read_count: record.read_count,
            like_count: record.like_count,
            recommend_count: record.recommend_count,
            share_count: record.share_count,
            comment_count: record.comment_count,
            collect_count: record.collect_count,
        };
        if !metrics.has_any() {
            continue;
        }
        let captured_at = (record.update_time_ms / 1_000).max(1);
        let canonical = WechatCanonicalIdentity::new(
            record.biz.clone(),
            record.mid.clone(),
            record.idx.clone(),
            record.sn.clone(),
            None,
            None,
            captured_at,
        );
        if let Some(canonical) = canonical.as_ref() {
            if let Err(error) = upsert_canonical_identity(&article.aid, canonical) {
                log::warn!(
                    "[DEBUG][public_metrics] account feed canonical persistence failed aid={} error={error}",
                    article.aid
                );
            }
        }
        matched_aids.insert(article.aid.clone());
        let note = Some(
            "从本机微信的公众号文章列表批量响应读取；未按标题搜索或逐篇打开文章。".to_string(),
        );
        if article.aid == requested.aid {
            *target_outcome = Some(CaptureOutcome {
                source_kind: ACCOUNT_FEED_SOURCE_KIND,
                method: ACCOUNT_FEED_CAPTURE_METHOD,
                metrics,
                captured_at,
                note,
            });
            continue;
        }
        if !persisted_aids.insert(article.aid.clone()) {
            continue;
        }
        let snapshot = ArticlePublicMetricsSnapshot {
            id: 0,
            aid: article.aid.clone(),
            source_url: article.link.clone(),
            source_kind: ACCOUNT_FEED_SOURCE_KIND.to_string(),
            capture_method: ACCOUNT_FEED_CAPTURE_METHOD.to_string(),
            captured_at,
            status: STATUS_VISIBLE.to_string(),
            read_count: metrics.read_count,
            like_count: metrics.like_count,
            recommend_count: metrics.recommend_count,
            share_count: metrics.share_count,
            comment_count: metrics.comment_count,
            collect_count: metrics.collect_count,
            note,
        };
        match insert_snapshot(&snapshot) {
            Ok(stored) => log::info!(
                "[DEBUG][public_metrics] account feed batch snapshot stored aid={} snapshot_id={} mid={} idx={}",
                stored.aid,
                stored.id,
                record.mid,
                record.idx
            ),
            Err(error) => log::warn!(
                "[DEBUG][public_metrics] account feed batch snapshot persistence failed aid={} error={error}",
                article.aid
            ),
        }
    }
}

#[cfg(target_os = "macos")]
fn match_local_account_article<'a>(
    record: &crate::wechat_account_feed::AccountFeedArticleMetrics,
    local_articles: &'a [db::ArticleSummary],
    canonical_aids: &HashMap<(String, String), String>,
    title_aids: &HashMap<String, Vec<usize>>,
) -> Option<&'a db::ArticleSummary> {
    if let Some(aid) = canonical_aids.get(&(record.mid.clone(), record.idx.clone())) {
        return local_articles.iter().find(|article| article.aid == *aid);
    }
    let candidates = title_aids.get(&normalized_title_key(&record.title))?;
    if candidates.len() == 1 {
        return local_articles.get(candidates[0]);
    }
    let record_date = record.create_time.and_then(local_date);
    candidates
        .iter()
        .filter_map(|index| local_articles.get(*index))
        .find(|article| record_date.is_some() && local_date(article.create_time) == record_date)
}

fn system_time_to_unix_millis(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

#[allow(clippy::too_many_arguments)]
fn wait_for_automatic_capture(
    identity: &ArticleIdentity,
    initial_profiles: &[(PathBuf, i64)],
    cache_watcher: Option<&CacheChangeWatcher>,
    modified_since: i64,
    timeout: Duration,
    checked_event_candidates: &mut HashSet<(PathBuf, i64, u64)>,
    matched_without_metrics: &mut bool,
    started: Instant,
) -> Option<CaptureOutcome> {
    let deadline = Instant::now() + timeout;
    let mut event_attempt = 0_usize;
    loop {
        if let Some(watcher) = cache_watcher.as_ref() {
            let wait = if event_attempt == 0 {
                Duration::ZERO
            } else {
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(WECHAT_CACHE_EVENT_WAIT)
            };
            if let Some(outcome) = capture_from_changed_cache_entries(
                identity,
                watcher,
                wait,
                modified_since,
                checked_event_candidates,
                matched_without_metrics,
            ) {
                log::info!(
                    "[DEBUG][public_metrics] matching metrics recovered from cache event event_attempt={} elapsed_ms={}",
                    event_attempt + 1,
                    started.elapsed().as_millis()
                );
                return Some(outcome);
            }
        }

        let timed_out = Instant::now() >= deadline;
        let run_filtered_fallback = cache_watcher.is_none() || event_attempt == 0 || timed_out;
        if !run_filtered_fallback {
            event_attempt += 1;
            continue;
        }
        let discovered_profiles = discover_wechat_profiles().unwrap_or_default();
        let profiles = if discovered_profiles.is_empty() {
            initial_profiles
        } else {
            discovered_profiles.as_slice()
        };
        let debug_phase = format!("automatic-navigation-event-{}", event_attempt + 1);
        match capture_from_profiles_cache(
            identity,
            profiles,
            AUTOMATIC_NAVIGATION_CAPTURE_METHOD,
            Some(modified_since),
            Some(&debug_phase),
        ) {
            Ok(outcome) => {
                log::info!(
                    "[DEBUG][public_metrics] matching metrics recovered from filtered scan event_attempt={} elapsed_ms={}",
                    event_attempt + 1,
                    started.elapsed().as_millis()
                );
                return Some(outcome);
            }
            Err(matched) => *matched_without_metrics |= matched,
        }
        if timed_out {
            break;
        }
        if cache_watcher.is_none() {
            thread::sleep(
                deadline
                    .saturating_duration_since(Instant::now())
                    .min(WECHAT_CACHE_EVENT_WAIT),
            );
        }
        event_attempt += 1;
    }
    None
}

#[cfg(target_os = "macos")]
fn open_wechat_article_automatically(
    identity: &ArticleIdentity,
) -> std::result::Result<crate::wechat_automation::WechatArticleSearchSession, String> {
    crate::wechat_automation::open_article_via_search(
        &crate::wechat_automation::WechatArticleSearchTarget {
            title: &identity.title,
            publisher: identity.publisher.as_deref(),
            fakeid: &identity.fakeid,
            published_at: identity.create_time,
        },
    )
}

#[cfg(not(target_os = "macos"))]
fn open_wechat_article_automatically(
    _identity: &ArticleIdentity,
) -> std::result::Result<(), String> {
    Err("当前系统暂不支持自动操作本机微信".to_string())
}

fn capture_from_cached_account_session(
    identity: &ArticleIdentity,
    profiles: &[(PathBuf, i64)],
) -> std::result::Result<CaptureOutcome, String> {
    let sessions = find_cached_wechat_sessions(&identity.fakeid, profiles);
    if sessions.is_empty() {
        return Err(
            "未找到这个公众号的本机微信会话；请先在微信中打开该公众号任意一篇文章，再重试。"
                .to_string(),
        );
    }
    let mut last_error = None;
    for session in sessions {
        match capture_from_one_cached_account_session(identity, &session) {
            Ok(outcome) => return Ok(outcome),
            Err(error) => last_error = Some(error),
        }
    }
    Err(last_error.unwrap_or_else(|| {
        "这个公众号的本机微信会话不可用；请在微信中重新打开该公众号任意文章。".to_string()
    }))
}

fn capture_from_one_cached_account_session(
    identity: &ArticleIdentity,
    session: &CachedWechatSession,
) -> std::result::Result<CaptureOutcome, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::limited(4))
        .cookie_store(true)
        .build()
        .map_err(|_| "无法初始化本机微信会话请求".to_string())?;

    let bootstrap_response = client
        .get(session.bootstrap_url.clone())
        .header(USER_AGENT, WECHAT_CLIENT_USER_AGENT)
        .send()
        .map_err(|_| {
            "本机微信会话已找到，但无法刷新；请在微信中重新打开该公众号任意文章".to_string()
        })?;
    if !bootstrap_response.status().is_success() {
        return Err(format!(
            "本机微信会话刷新返回 HTTP {}；请在微信中重新打开该公众号任意文章",
            bootstrap_response.status()
        ));
    }
    if bootstrap_response
        .url()
        .path()
        .contains("wappoc_appmsgcaptcha")
    {
        return Err(
            "这个公众号的本机微信会话已过期；请在微信中重新打开该公众号任意文章。".to_string(),
        );
    }
    let bootstrap_html = bootstrap_response
        .text()
        .map_err(|_| "读取本机微信会话页面失败".to_string())?;
    if bootstrap_html.contains("链接已过期") || bootstrap_html.contains("Link expired") {
        return Err(
            "这个公众号的本机微信会话链接已过期；请在微信中重新打开该公众号任意文章。".to_string(),
        );
    }
    let appmsg_token = extract_js_string_value(&bootstrap_html, "appmsg_token")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "这个公众号的本机微信会话页面未返回授权参数（响应 {} 字节）；请在微信中重新打开该公众号任意文章。",
                bootstrap_html.len()
            )
        })?;
    let wxtoken = extract_js_string_value(&bootstrap_html, "wxtoken")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "777".to_string());
    let uin = required_query_value(&session.bootstrap_url, "uin")?;
    let key = required_query_value(&session.bootstrap_url, "key")?;
    let pass_ticket = required_query_value(&session.bootstrap_url, "pass_ticket")?;

    let article = find_target_in_wechat_history(
        &client,
        identity,
        session,
        &uin,
        &key,
        &pass_ticket,
        &wxtoken,
        &appmsg_token,
    )?;
    let expected_title = normalized_title_key(&identity.title);

    let target_url = session_url_for_history_article(&article.content_url, &session.bootstrap_url)?;
    let target_response = client
        .get(target_url)
        .header(USER_AGENT, WECHAT_CLIENT_USER_AGENT)
        .header(REFERER, session.bootstrap_url.as_str())
        .send()
        .map_err(|_| "已定位目标文章，但微信文章页请求失败".to_string())?;
    if !target_response.status().is_success() {
        return Err(format!(
            "微信目标文章页返回 HTTP {}",
            target_response.status()
        ));
    }
    if target_response
        .url()
        .path()
        .contains("wappoc_appmsgcaptcha")
    {
        return Err(
            "已定位目标文章，但微信要求重新验证会话；请在微信中重新打开该公众号任意文章。"
                .to_string(),
        );
    }
    let target_html = target_response
        .text()
        .map_err(|_| "读取微信目标文章页失败".to_string())?;
    if let Some(page_title) = extract_page_title(&target_html) {
        if normalized_title_key(&page_title) != expected_title {
            return Err("微信返回了标题不匹配的文章，已停止写入。".to_string());
        }
    }
    let metrics = parse_metrics_from_html(&target_html);
    if !metrics.has_any() {
        return Err(
            "微信已返回目标文章，但页面未包含阅读量字段；请在微信中刷新该公众号任意文章后重试。"
                .to_string(),
        );
    }

    Ok(CaptureOutcome {
        source_kind: LOCAL_SESSION_SOURCE_KIND,
        method: LOCAL_SESSION_CAPTURE_METHOD,
        metrics,
        captured_at: system_time_to_unix(SystemTime::now()).max(session.modified_at),
        note: Some(
            "通过本机微信中同公众号的有效会话查询历史消息并读取目标文章页；无需预先打开当前文章。"
                .to_string(),
        ),
    })
}

#[allow(clippy::too_many_arguments)]
fn find_target_in_wechat_history(
    client: &reqwest::blocking::Client,
    identity: &ArticleIdentity,
    session: &CachedWechatSession,
    uin: &str,
    key: &str,
    pass_ticket: &str,
    wxtoken: &str,
    appmsg_token: &str,
) -> std::result::Result<HistoryArticle, String> {
    let expected_title = normalized_title_key(&identity.title);
    let expected_date = local_date(identity.create_time);
    let mut offset = 0_i64;
    let mut visited_offsets = HashSet::new();
    let mut found_same_title_on_other_date = false;

    for _ in 0..MAX_WECHAT_HISTORY_PAGES {
        if !visited_offsets.insert(offset) {
            break;
        }
        let offset_value = offset.to_string();
        let mut history_url = reqwest::Url::parse(WECHAT_PROFILE_HISTORY_URL)
            .map_err(|_| "微信历史消息接口地址无效".to_string())?;
        history_url.query_pairs_mut().extend_pairs([
            ("action", "getmsg"),
            ("__biz", identity.fakeid.as_str()),
            ("f", "json"),
            ("offset", offset_value.as_str()),
            ("count", "10"),
            ("is_ok", "1"),
            ("scene", "124"),
            ("uin", uin),
            ("key", key),
            ("pass_ticket", pass_ticket),
            ("wxtoken", wxtoken),
            ("appmsg_token", appmsg_token),
            ("x5", "0"),
        ]);
        let history_response = client
            .get(history_url)
            .header(USER_AGENT, WECHAT_CLIENT_USER_AGENT)
            .header(REFERER, session.bootstrap_url.as_str())
            .send()
            .map_err(|_| "微信历史消息接口请求失败".to_string())?;
        if !history_response.status().is_success() {
            return Err(format!(
                "微信历史消息接口返回 HTTP {}",
                history_response.status()
            ));
        }
        let history: Value = history_response
            .json()
            .map_err(|_| "微信历史消息接口返回了无法解析的数据".to_string())?;
        if history.get("ret").and_then(Value::as_i64) != Some(0) {
            let message = history
                .get("errmsg")
                .and_then(Value::as_str)
                .unwrap_or("会话无效");
            return Err(format!("这个公众号的本机微信会话不可用（{message}）"));
        }
        let general_list = history
            .get("general_msg_list")
            .and_then(Value::as_str)
            .ok_or_else(|| "微信历史消息接口没有返回文章列表".to_string())?;
        let general_list: Value = serde_json::from_str(general_list)
            .map_err(|_| "无法解析微信历史消息文章列表".to_string())?;
        let articles = parse_history_articles(&general_list);

        for article in &articles {
            if normalized_title_key(&article.title) != expected_title {
                continue;
            }
            if expected_date.is_none()
                || local_date(article.published_at).as_ref() == expected_date.as_ref()
            {
                return Ok(HistoryArticle {
                    title: article.title.clone(),
                    content_url: article.content_url.clone(),
                    published_at: article.published_at,
                });
            }
            found_same_title_on_other_date = true;
        }

        let passed_target_date = expected_date.is_some_and(|target_date| {
            articles
                .iter()
                .filter_map(|article| local_date(article.published_at))
                .min()
                .is_some_and(|oldest_date| oldest_date < target_date)
        });
        let can_continue = json_integer(&history, "can_msg_continue") == Some(1);
        let next_offset = json_integer(&history, "next_offset");
        if passed_target_date || !can_continue || next_offset.is_none_or(|next| next <= offset) {
            break;
        }
        offset = next_offset.expect("next offset checked above");
        thread::sleep(Duration::from_millis(120));
    }

    if found_same_title_on_other_date {
        Err("微信历史消息中存在同名文章，但发布时间不匹配，已停止写入。".to_string())
    } else {
        Err("已自动遍历目标发布时间附近的公众号历史消息，但未找到该文章；文章可能已被删除或不再公开。".to_string())
    }
}

fn json_integer(value: &Value, name: &str) -> Option<i64> {
    value.get(name).and_then(|item| {
        item.as_i64()
            .or_else(|| item.as_str().and_then(|text| text.parse().ok()))
    })
}

fn find_cached_wechat_sessions(
    fakeid: &str,
    profiles: &[(PathBuf, i64)],
) -> Vec<CachedWechatSession> {
    let mut matches = Vec::new();
    for (profile, _) in profiles {
        matches.extend(find_favicon_wechat_sessions(fakeid, profile));
        let cache_dir = profile.join("Cache").join("Cache_Data");
        for candidate in recent_cache_candidates(&cache_dir) {
            let Ok(cache_url) = read_cache_entry_url(&candidate) else {
                continue;
            };
            if cache_url.host_str() != Some("mp.weixin.qq.com")
                || !(cache_url.path() == "/s" || cache_url.path().starts_with("/s/"))
                || query_value(&cache_url, &["__biz"]).as_deref() != Some(fakeid)
                || ["uin", "key", "pass_ticket"]
                    .iter()
                    .any(|name| query_value(&cache_url, &[*name]).is_none())
            {
                continue;
            }
            matches.push(CachedWechatSession {
                bootstrap_url: cache_url,
                modified_at: candidate.modified_at,
            });
        }
    }
    matches.sort_by_key(|session| std::cmp::Reverse(session.modified_at));
    matches.dedup_by(|left, right| left.bootstrap_url == right.bootstrap_url);
    matches.truncate(MAX_CACHED_SESSION_ATTEMPTS);
    matches
}

fn find_favicon_wechat_sessions(fakeid: &str, profile: &Path) -> Vec<CachedWechatSession> {
    let database_path = profile.join("Favicons");
    let Ok(database_url) = reqwest::Url::from_file_path(&database_path) else {
        return Vec::new();
    };
    let database_uri = format!("{database_url}?immutable=1");
    let flags = rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
        | rusqlite::OpenFlags::SQLITE_OPEN_URI
        | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(database_uri, flags) else {
        return Vec::new();
    };
    let modified_at = fs::metadata(&database_path)
        .and_then(|metadata| metadata.modified())
        .map(system_time_to_unix)
        .unwrap_or_default();
    let Ok(mut statement) = conn.prepare(
        "SELECT page_url
         FROM icon_mapping
         WHERE page_url LIKE ?1
         ORDER BY id DESC
         LIMIT 32",
    ) else {
        return Vec::new();
    };
    let pattern = format!("%{fakeid}%");
    let Ok(rows) = statement.query_map([pattern], |row| row.get::<_, String>(0)) else {
        return Vec::new();
    };

    rows.filter_map(|row| row.ok())
        .filter_map(|value| reqwest::Url::parse(&value).ok())
        .filter(|url| {
            url.host_str() == Some("mp.weixin.qq.com")
                && (url.path() == "/s" || url.path().starts_with("/s/"))
                && query_value(url, &["__biz"]).as_deref() == Some(fakeid)
                && ["uin", "key", "pass_ticket"]
                    .iter()
                    .all(|name| query_value(url, &[*name]).is_some())
        })
        .map(|bootstrap_url| CachedWechatSession {
            bootstrap_url,
            modified_at,
        })
        .collect()
}

fn required_query_value(url: &reqwest::Url, name: &str) -> std::result::Result<String, String> {
    query_value(url, &[name])
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("本机微信会话缺少 {name} 参数"))
}

fn parse_history_articles(value: &Value) -> Vec<HistoryArticle> {
    let mut articles = Vec::new();
    let Some(items) = value.get("list").and_then(Value::as_array) else {
        return articles;
    };
    for item in items {
        let published_at = item
            .get("comm_msg_info")
            .and_then(|info| info.get("datetime"))
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let Some(info) = item.get("app_msg_ext_info") else {
            continue;
        };
        push_history_article(info, published_at, &mut articles);
        if let Some(multi) = info
            .get("multi_app_msg_item_list")
            .and_then(Value::as_array)
        {
            for child in multi {
                push_history_article(child, published_at, &mut articles);
            }
        }
    }
    articles
}

fn push_history_article(value: &Value, published_at: i64, articles: &mut Vec<HistoryArticle>) {
    let Some(title) = value.get("title").and_then(Value::as_str) else {
        return;
    };
    let Some(content_url) = value.get("content_url").and_then(Value::as_str) else {
        return;
    };
    if title.trim().is_empty() || content_url.trim().is_empty() {
        return;
    }
    articles.push(HistoryArticle {
        title: decode_common_html_entities(title),
        content_url: decode_common_html_entities(content_url),
        published_at,
    });
}

fn session_url_for_history_article(
    value: &str,
    bootstrap_url: &reqwest::Url,
) -> std::result::Result<reqwest::Url, String> {
    let value = value.trim();
    let mut target = reqwest::Url::parse(value)
        .or_else(|_| bootstrap_url.join(value))
        .map_err(|_| "微信历史消息返回了无效的文章链接".to_string())?;
    if target.scheme() == "http" {
        let _ = target.set_scheme("https");
    }
    if target.host_str() != Some("mp.weixin.qq.com") {
        return Err("微信历史消息返回了非微信文章链接".to_string());
    }

    const SESSION_QUERY_NAMES: &[&str] = &[
        "key",
        "pass_ticket",
        "uin",
        "appmsg_token",
        "wxtoken",
        "devicetype",
        "version",
        "lang",
        "countrycode",
        "exportkey",
        "acctmode",
        "wx_header",
        "ascene",
        "enterid",
    ];
    let mut pairs = target
        .query_pairs()
        .filter(|(name, _)| !SESSION_QUERY_NAMES.contains(&name.as_ref()))
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    for name in SESSION_QUERY_NAMES {
        if let Some(value) = query_value(bootstrap_url, &[*name]) {
            pairs.push(((*name).to_string(), value));
        }
    }
    target.set_query(None);
    target.query_pairs_mut().extend_pairs(pairs);
    Ok(target)
}

fn local_date(timestamp: i64) -> Option<chrono::NaiveDate> {
    chrono::DateTime::from_timestamp(timestamp, 0)
        .map(|value| value.with_timezone(&chrono::Local).date_naive())
}

fn normalized_title_key(value: &str) -> String {
    decode_common_html_entities(value)
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn decode_common_html_entities(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#34;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn extract_js_string_value(source: &str, name: &str) -> Option<String> {
    for (start, _) in source.match_indices(name) {
        let after_name = source.get(start + name.len()..)?.trim_start();
        let separator = after_name.as_bytes().first().copied()?;
        if !matches!(separator, b':' | b'=') {
            continue;
        }
        let value_source = after_name.get(1..)?.trim_start();
        let quote = value_source.as_bytes().first().copied()?;
        if !matches!(quote, b'\'' | b'"') {
            continue;
        }
        let mut escaped = false;
        for (offset, byte) in value_source.as_bytes()[1..].iter().enumerate() {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == quote {
                let value = value_source.get(1..offset + 1)?;
                let value = decode_common_html_entities(value).trim().to_string();
                if !value.is_empty() {
                    return Some(value);
                }
                break;
            }
        }
    }
    None
}

fn extract_js_scalar_value(source: &str, name: &str) -> Option<String> {
    for (start, _) in source.match_indices(name) {
        let before = source.get(..start)?.chars().next_back();
        let after_index = start + name.len();
        let after = source.get(after_index..)?.chars().next();
        if before.is_some_and(|value| value.is_alphanumeric() || matches!(value, '_' | '$'))
            || after.is_some_and(|value| value.is_alphanumeric() || matches!(value, '_' | '$'))
        {
            continue;
        }
        let after_name = source.get(after_index..)?.trim_start();
        let separator = after_name.as_bytes().first().copied()?;
        if !matches!(separator, b':' | b'=') {
            continue;
        }
        let value_source = after_name.get(1..)?.trim_start();
        let first = value_source.as_bytes().first().copied()?;
        if matches!(first, b'\'' | b'"') {
            let mut escaped = false;
            for (offset, byte) in value_source.as_bytes()[1..].iter().enumerate() {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == first {
                    let value = value_source.get(1..offset + 1)?;
                    return Some(decode_common_html_entities(value));
                }
            }
            continue;
        }
        let end = value_source
            .find(|character: char| {
                character.is_whitespace() || matches!(character, ',' | ';' | '}' | ')' | '|')
            })
            .unwrap_or(value_source.len());
        let value = value_source.get(..end)?.trim();
        if value.is_empty() || matches!(value, "null" | "undefined") {
            continue;
        }
        return Some(match value {
            "true" => "1".to_string(),
            "false" => "0".to_string(),
            _ => value.to_string(),
        });
    }
    None
}

fn extract_page_title(html: &str) -> Option<String> {
    let title_re = Regex::new(
        r#"(?is)<h[12][^>]*class=[\"'][^\"']*rich_media_title[^\"']*[\"'][^>]*>(.*?)</h[12]>"#,
    )
    .expect("article title regex");
    let tags_re = Regex::new(r"(?is)<[^>]+>").expect("html tag regex");
    title_re
        .captures(html)
        .and_then(|captures| captures.get(1))
        .map(|matched| tags_re.replace_all(matched.as_str(), " "))
        .map(|value| collapse_text_whitespace(&decode_common_html_entities(&value)))
        .filter(|value| !value.is_empty())
}

fn collapse_text_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn wechat_profiles_root() -> std::result::Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok(home
        .join("Library")
        .join("Containers")
        .join("com.tencent.xinWeChat")
        .join("Data")
        .join("Documents")
        .join("app_data")
        .join("radium")
        .join("web")
        .join("profiles"))
}

fn recent_cache_candidates(cache_dir: &Path) -> Vec<CacheCandidate> {
    recent_cache_candidates_since(cache_dir, None)
}

fn recent_cache_candidates_since(
    cache_dir: &Path,
    modified_since: Option<i64>,
) -> Vec<CacheCandidate> {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return Vec::new();
    };
    let mut candidates = entries
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with("_0"))
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            if metadata.len() <= SIMPLE_CACHE_HEADER_BYTES || metadata.len() > MAX_CACHE_ENTRY_BYTES
            {
                return None;
            }
            let modified_at = metadata.modified().ok().map(system_time_to_unix)?;
            if modified_since.is_some_and(|minimum| modified_at < minimum) {
                return None;
            }
            Some(CacheCandidate {
                path: entry.path(),
                modified_at,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.modified_at));
    candidates.truncate(MAX_CACHE_CANDIDATES_PER_PROFILE);
    candidates
}

enum CacheEntryResult {
    NotMatched,
    MatchedWithoutMetrics {
        canonical: Option<WechatCanonicalIdentity>,
    },
    Metrics {
        metrics: ParsedMetrics,
        canonical: Option<WechatCanonicalIdentity>,
    },
}

fn read_metrics_cache_entry(
    candidate: &CacheCandidate,
    identity: &ArticleIdentity,
) -> Result<CacheEntryResult> {
    let bytes = fs::read(&candidate.path)
        .with_context(|| format!("read cache entry {}", candidate.path.display()))?;
    read_metrics_cache_bytes(&bytes, identity)
}

fn read_metrics_cache_bytes(bytes: &[u8], identity: &ArticleIdentity) -> Result<CacheEntryResult> {
    if bytes.len() <= SIMPLE_CACHE_HEADER_BYTES as usize
        || bytes.len() as u64 > MAX_CACHE_ENTRY_BYTES
    {
        return Ok(CacheEntryResult::NotMatched);
    }
    let header = &bytes[..SIMPLE_CACHE_HEADER_BYTES as usize];
    if u64::from_le_bytes(header[0..8].try_into().expect("8-byte cache magic"))
        != SIMPLE_CACHE_MAGIC
    {
        return Ok(CacheEntryResult::NotMatched);
    }

    let key_length =
        u32::from_le_bytes(header[12..16].try_into().expect("4-byte cache key length")) as usize;
    if key_length == 0 || key_length > MAX_CACHE_KEY_BYTES {
        return Ok(CacheEntryResult::NotMatched);
    }
    let key_start = SIMPLE_CACHE_HEADER_BYTES as usize;
    let Some(key_end) = key_start.checked_add(key_length) else {
        return Ok(CacheEntryResult::NotMatched);
    };
    let Some(key) = bytes.get(key_start..key_end) else {
        return Ok(CacheEntryResult::NotMatched);
    };
    let Some(cache_url) = parse_cache_key_url(key) else {
        return Ok(CacheEntryResult::NotMatched);
    };
    if !cache_url_matches_article(&cache_url, identity) {
        return Ok(CacheEntryResult::NotMatched);
    }

    let encoded = bytes
        .get(key_end..)
        .context("cache entry response is missing")?;

    let page = if encoded.starts_with(&[0x1f, 0x8b]) {
        let mut decoded = Vec::new();
        GzDecoder::new(encoded)
            .take(MAX_DECOMPRESSED_PAGE_BYTES + 1)
            .read_to_end(&mut decoded)?;
        if decoded.len() as u64 > MAX_DECOMPRESSED_PAGE_BYTES {
            anyhow::bail!("decompressed cache entry exceeds limit");
        }
        decoded
    } else {
        encoded.to_vec()
    };
    let page = String::from_utf8_lossy(&page);
    if identity.mid.is_none()
        && extract_page_title(&page).is_none_or(|title| {
            normalized_title_key(&title) != normalized_title_key(&identity.title)
        })
    {
        return Ok(CacheEntryResult::NotMatched);
    }
    if identity.mid.is_none()
        && extract_declared_number(&page, &["ct", "create_time", "publish_time"])
            .and_then(local_date)
            .zip(local_date(identity.create_time))
            .is_some_and(|(actual, expected)| actual != expected)
    {
        return Ok(CacheEntryResult::NotMatched);
    }
    let mut canonical = canonical_identity_from_url(
        &cache_url,
        safe_short_wechat_url(&cache_url),
        None,
        system_time_to_unix(SystemTime::now()),
    )
    .or_else(|| canonical_identity_from_page_script(&page, &cache_url))
    .filter(|canonical| canonical.biz == identity.fakeid);
    if let Some(canonical) = canonical.as_mut() {
        canonical.authorized_cache_filename = Some(chromium_simple_cache_filename(
            &String::from_utf8_lossy(key),
            0,
        ));
    }
    let metrics = parse_metrics_from_html(&page);
    if metrics.has_any() {
        Ok(CacheEntryResult::Metrics { metrics, canonical })
    } else {
        Ok(CacheEntryResult::MatchedWithoutMetrics { canonical })
    }
}

fn cache_url_matches_article(cache_url: &reqwest::Url, identity: &ArticleIdentity) -> bool {
    if cache_url.host_str() != Some("mp.weixin.qq.com")
        || !(cache_url.path() == "/s" || cache_url.path().starts_with("/s/"))
    {
        return false;
    }

    if let Some(expected_mid) = identity.mid.as_deref() {
        if query_value(cache_url, &["__biz"]).is_some_and(|actual| actual != identity.fakeid) {
            return false;
        }
        let mid = query_value(cache_url, &["mid", "appmsgid"]);
        if mid.as_deref() != Some(expected_mid) {
            return false;
        }
        if let Some(expected_idx) = identity.idx.as_deref() {
            let idx = query_value(cache_url, &["idx", "itemidx"]);
            if idx.as_deref().unwrap_or("1") != expected_idx {
                return false;
            }
        }
        if let Some(expected_sn) = identity.sn.as_deref() {
            let sn = query_value(cache_url, &["sn"]);
            if sn.is_some_and(|actual| actual != expected_sn) {
                return false;
            }
        }
        return true;
    }

    cache_url.as_str().starts_with(&identity.source_url)
        || query_value(cache_url, &["__biz"]).as_deref() == Some(identity.fakeid.as_str())
}

fn read_cache_entry_url(candidate: &CacheCandidate) -> Result<reqwest::Url> {
    let mut file = File::open(&candidate.path)
        .with_context(|| format!("open cache entry {}", candidate.path.display()))?;
    let mut header = [0u8; SIMPLE_CACHE_HEADER_BYTES as usize];
    file.read_exact(&mut header)?;
    if u64::from_le_bytes(header[0..8].try_into().expect("8-byte cache magic"))
        != SIMPLE_CACHE_MAGIC
    {
        anyhow::bail!("not a Chromium simple cache entry");
    }
    let key_length =
        u32::from_le_bytes(header[12..16].try_into().expect("4-byte cache key length")) as usize;
    if key_length == 0 || key_length > MAX_CACHE_KEY_BYTES {
        anyhow::bail!("invalid Chromium cache key length");
    }
    let mut key = vec![0u8; key_length];
    file.read_exact(&mut key)?;
    parse_cache_key_url(&key).context("cache key does not contain an https URL")
}

fn parse_cache_key_url(key: &[u8]) -> Option<reqwest::Url> {
    let url_start = key.windows(8).position(|window| window == b"https://")?;
    reqwest::Url::parse(&String::from_utf8_lossy(&key[url_start..])).ok()
}

fn query_value(url: &reqwest::Url, names: &[&str]) -> Option<String> {
    url.query_pairs()
        .find_map(|(name, value)| names.contains(&name.as_ref()).then(|| value.into_owned()))
}

fn system_time_to_unix(time: SystemTime) -> i64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or_default()
}

fn parse_metrics_from_html(html: &str) -> ParsedMetrics {
    let mut metrics = ParsedMetrics {
        read_count: extract_declared_number(html, &["read_num_new", "read_num"]),
        like_count: extract_declared_number(html, &["like_num"]),
        ..ParsedMetrics::default()
    };

    if let Some(block) = extract_assigned_object(html, "window.appmsg_bar_data") {
        metrics.merge_missing(parse_metrics_from_object(block));
    }
    if let Some(cgi_data) = extract_assigned_object(html, "window.cgiDataNew") {
        if let Some(block) = extract_property_object(cgi_data, "appmsg_bar_data") {
            metrics.merge_missing(parse_metrics_from_object(block));
        }
    }
    metrics
}

fn parse_metrics_from_object(block: &str) -> ParsedMetrics {
    ParsedMetrics {
        read_count: extract_property_number(block, &["read_num_new", "read_num"]),
        like_count: extract_property_number(block, &["old_like_count", "like_num"]),
        recommend_count: extract_property_number(block, &["like_count"]),
        share_count: extract_property_number(block, &["share_count"]),
        comment_count: extract_property_number(block, &["comment_count"]),
        collect_count: extract_property_number(block, &["collect_count"]),
    }
}

fn extract_declared_number(html: &str, names: &[&str]) -> Option<i64> {
    for name in names {
        let name = regex::escape(name);
        let re = Regex::new(&format!(
            r#"(?m)\bvar\s+{name}\s*=\s*["']?([0-9]+)["']?\s*(?:\*\s*1)?\s*;"#
        ))
        .expect("declared metric regex");
        if let Some(number) = re
            .captures(html)
            .and_then(|captures| captures.get(1))
            .and_then(|value| value.as_str().parse::<i64>().ok())
        {
            return Some(number);
        }
    }
    None
}

fn extract_property_number(block: &str, names: &[&str]) -> Option<i64> {
    for name in names {
        let name = regex::escape(name);
        let re = Regex::new(&format!(
            r#"(?m)(?:\b{0}\b|["']{0}["'])\s*:\s*["']?([0-9]+)["']?\s*(?:\*\s*1)?"#,
            name
        ))
        .expect("metric property regex");
        if let Some(number) = re
            .captures(block)
            .and_then(|captures| captures.get(1))
            .and_then(|value| value.as_str().parse::<i64>().ok())
        {
            return Some(number);
        }
    }
    None
}

fn extract_assigned_object<'a>(source: &'a str, assignment: &str) -> Option<&'a str> {
    let start = source.find(assignment)?;
    let brace = source[start + assignment.len()..].find('{')? + start + assignment.len();
    balanced_object(source, brace)
}

fn extract_property_object<'a>(source: &'a str, property: &str) -> Option<&'a str> {
    let property_re = Regex::new(&format!(
        r#"(?m)(?:\b{}\b|["']{}["'])\s*:"#,
        regex::escape(property),
        regex::escape(property)
    ))
    .expect("property object regex");
    let matched = property_re.find(source)?;
    let brace = source[matched.end()..].find('{')? + matched.end();
    balanced_object(source, brace)
}

fn balanced_object(source: &str, open_brace: usize) -> Option<&str> {
    let bytes = source.as_bytes();
    if bytes.get(open_brace) != Some(&b'{') {
        return None;
    }
    let mut depth = 0usize;
    let mut quote = None;
    let mut escaped = false;
    for (offset, byte) in bytes[open_brace..].iter().enumerate() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == active_quote {
                quote = None;
            }
            continue;
        }
        match *byte {
            b'\'' | b'"' => quote = Some(*byte),
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return source.get(open_brace..=open_brace + offset);
                }
            }
            _ => {}
        }
    }
    None
}

fn metrics_db_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    Ok(base.join("wcx").join("public-metrics.db"))
}

fn open_metrics_db() -> Result<Connection> {
    let path = metrics_db_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
    }
    let conn = Connection::open(&path).with_context(|| format!("open {}", path.display()))?;
    let mut schema_ready = METRICS_SCHEMA_READY
        .get_or_init(|| Mutex::new(false))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if !*schema_ready {
        ensure_schema(&conn)?;
        *schema_ready = true;
    }
    Ok(conn)
}

fn ensure_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS article_public_metric_snapshots (
             id INTEGER PRIMARY KEY AUTOINCREMENT,
             aid TEXT NOT NULL,
             source_url TEXT NOT NULL,
             source_kind TEXT NOT NULL,
             capture_method TEXT NOT NULL,
             captured_at INTEGER NOT NULL,
             status TEXT NOT NULL,
             read_count INTEGER,
             like_count INTEGER,
             recommend_count INTEGER,
             share_count INTEGER,
             comment_count INTEGER,
             collect_count INTEGER,
             note TEXT
         );
         CREATE INDEX IF NOT EXISTS idx_article_public_metrics_latest
             ON article_public_metric_snapshots(aid, captured_at DESC, id DESC);
         CREATE INDEX IF NOT EXISTS idx_article_public_metrics_inserted
             ON article_public_metric_snapshots(aid, id DESC);

         CREATE TABLE IF NOT EXISTS article_wechat_identities (
             aid TEXT PRIMARY KEY,
             biz TEXT NOT NULL,
             mid TEXT NOT NULL,
             idx TEXT NOT NULL,
             sn TEXT,
             canonical_url TEXT NOT NULL,
             short_url TEXT,
             cache_filename TEXT,
             resolved_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_article_wechat_identity_canonical
             ON article_wechat_identities(biz, mid, idx);",
    )?;
    let identity_columns = conn
        .prepare("PRAGMA table_info(article_wechat_identities)")?
        .query_map([], |row| row.get::<_, String>(1))?
        .collect::<rusqlite::Result<HashSet<_>>>()?;
    if !identity_columns.contains("cache_filename") {
        conn.execute(
            "ALTER TABLE article_wechat_identities ADD COLUMN cache_filename TEXT",
            [],
        )?;
    }
    Ok(())
}

fn load_persisted_canonical_identity(aid: &str) -> Result<Option<WechatCanonicalIdentity>> {
    let conn = open_metrics_db()?;
    let persisted = conn
        .query_row(
            "SELECT biz, mid, idx, sn, short_url, cache_filename, resolved_at
             FROM article_wechat_identities
             WHERE aid = ?1",
            [aid],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            },
        )
        .optional()?;
    Ok(persisted.and_then(
        |(biz, mid, idx, sn, short_url, cache_filename, resolved_at)| {
            let mut identity =
                WechatCanonicalIdentity::new(biz, mid, idx, sn, short_url, None, resolved_at)?;
            identity.authorized_cache_filename = cache_filename.filter(|value| {
                value.len() <= 64
                    && value
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() || byte == b'_')
            });
            Some(identity)
        },
    ))
}

fn upsert_canonical_identity(aid: &str, identity: &WechatCanonicalIdentity) -> Result<()> {
    let conn = open_metrics_db()?;
    conn.execute(
        "INSERT INTO article_wechat_identities (
             aid, biz, mid, idx, sn, canonical_url, short_url, cache_filename, resolved_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(aid) DO UPDATE SET
             biz = excluded.biz,
             mid = excluded.mid,
             idx = excluded.idx,
             sn = excluded.sn,
             canonical_url = excluded.canonical_url,
             short_url = COALESCE(excluded.short_url, article_wechat_identities.short_url),
             cache_filename = COALESCE(excluded.cache_filename, article_wechat_identities.cache_filename),
             resolved_at = excluded.resolved_at",
        (
            aid,
            &identity.biz,
            &identity.mid,
            &identity.idx,
            &identity.sn,
            &identity.canonical_url,
            &identity.short_url,
            &identity.authorized_cache_filename,
            identity.resolved_at,
        ),
    )?;
    Ok(())
}

fn insert_snapshot(
    snapshot: &ArticlePublicMetricsSnapshot,
) -> Result<ArticlePublicMetricsSnapshot> {
    let conn = open_metrics_db()?;
    insert_snapshot_with_conn(&conn, snapshot)
}

fn insert_snapshot_with_conn(
    conn: &Connection,
    snapshot: &ArticlePublicMetricsSnapshot,
) -> Result<ArticlePublicMetricsSnapshot> {
    conn.execute(
        "INSERT INTO article_public_metric_snapshots (
             aid, source_url, source_kind, capture_method, captured_at, status,
             read_count, like_count, recommend_count, share_count, comment_count,
             collect_count, note
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        (
            &snapshot.aid,
            &snapshot.source_url,
            &snapshot.source_kind,
            &snapshot.capture_method,
            snapshot.captured_at,
            &snapshot.status,
            snapshot.read_count,
            snapshot.like_count,
            snapshot.recommend_count,
            snapshot.share_count,
            snapshot.comment_count,
            snapshot.collect_count,
            &snapshot.note,
        ),
    )?;
    snapshot_by_id(conn, conn.last_insert_rowid())
}

fn latest_snapshot(aid: &str) -> Result<Option<ArticlePublicMetricsSnapshot>> {
    let conn = open_metrics_db()?;
    conn.query_row(
        "SELECT id, aid, source_url, source_kind, capture_method, captured_at, status,
                read_count, like_count, recommend_count, share_count, comment_count,
                collect_count, note
         FROM article_public_metric_snapshots
         WHERE aid = ?1
         ORDER BY id DESC
         LIMIT 1",
        [aid],
        snapshot_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn snapshot_by_id(conn: &Connection, id: i64) -> Result<ArticlePublicMetricsSnapshot> {
    conn.query_row(
        "SELECT id, aid, source_url, source_kind, capture_method, captured_at, status,
                read_count, like_count, recommend_count, share_count, comment_count,
                collect_count, note
         FROM article_public_metric_snapshots
         WHERE id = ?1",
        [id],
        snapshot_from_row,
    )
    .map_err(Into::into)
}

fn snapshot_from_row(row: &Row<'_>) -> rusqlite::Result<ArticlePublicMetricsSnapshot> {
    Ok(ArticlePublicMetricsSnapshot {
        id: row.get(0)?,
        aid: row.get(1)?,
        source_url: row.get(2)?,
        source_kind: row.get(3)?,
        capture_method: row.get(4)?,
        captured_at: row.get(5)?,
        status: row.get(6)?,
        read_count: row.get(7)?,
        like_count: row.get(8)?,
        recommend_count: row.get(9)?,
        share_count: row.get(10)?,
        comment_count: row.get(11)?,
        collect_count: row.get(12)?,
        note: row.get(13)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    struct LiveTestLogger;

    impl log::Log for LiveTestLogger {
        fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
            metadata.level() <= log::Level::Info
        }

        fn log(&self, record: &log::Record<'_>) {
            if self.enabled(record.metadata()) {
                eprintln!(
                    "[{}][{}] {}",
                    record.level(),
                    record.target(),
                    record.args()
                );
            }
        }

        fn flush(&self) {}
    }

    static LIVE_TEST_LOGGER: LiveTestLogger = LiveTestLogger;

    fn init_live_test_logger() {
        static INIT: std::sync::Once = std::sync::Once::new();
        INIT.call_once(|| {
            let _ = log::set_logger(&LIVE_TEST_LOGGER);
            log::set_max_level(log::LevelFilter::Info);
        });
    }

    #[test]
    fn parses_legacy_and_new_public_page_metrics() {
        let html = r#"
            <script>
              var read_num = "12345" * 1;
              var like_num = "88" * 1;
              window.appmsg_bar_data = {
                like_count: '66' * 1,
                share_count: '12' * 1,
                comment_count: '7' * 1,
                collect_count: '9' * 1,
              };
            </script>
        "#;
        let parsed = parse_metrics_from_html(html);

        assert_eq!(parsed.read_count, Some(12_345));
        assert_eq!(parsed.like_count, Some(88));
        assert_eq!(parsed.recommend_count, Some(66));
        assert_eq!(parsed.share_count, Some(12));
        assert_eq!(parsed.comment_count, Some(7));
        assert_eq!(parsed.collect_count, Some(9));
    }

    #[test]
    fn blank_page_values_remain_unavailable_instead_of_zero() {
        let html = r#"
            <script>
              var read_num = "" * 1;
              var like_num = "" * 1;
              window.appmsg_bar_data = { share_count: '' * 1 };
            </script>
        "#;

        assert_eq!(parse_metrics_from_html(html), ParsedMetrics::default());
    }

    fn sogou_test_identity() -> ArticleIdentity {
        ArticleIdentity {
            aid: "sogou:test".to_string(),
            mid: None,
            idx: None,
            sn: None,
            fakeid: "Mzg3NDc2MjQxMg==".to_string(),
            publisher: Some("深思圈".to_string()),
            title: "在 a16z 的办公室,听 Decagon 创始人分享如何从 2 个人干到 1000 人".to_string(),
            create_time: 1_785_545_698,
            source_url: "https://mp.weixin.qq.com/s?src=11&signature=expired".to_string(),
        }
    }

    #[test]
    fn resolves_one_exact_sogou_article_result_without_visual_ranking() {
        let html = r#"
            <ul class="news-list">
              <li d="prefix-prefix-test">
                <div class="txt-box">
                  <h3><a href="/link?url=abc 123&amp;type=2">
                    在 <em>a16z</em> 的办公室，听 Decagon 创始人分享如何从 2 个人干到 1000 人
                  </a></h3>
                  <div class="s-p"><a>深思圈</a></div>
                </div>
              </li>
              <li d="prefix-prefix-not-the-target">
                <h3><a href="/link?url=wrong">相似但不是目标文章</a></h3>
                <span>深思圈</span>
              </li>
            </ul>
        "#;

        let url = exact_sogou_result_url(html, &sogou_test_identity())
            .expect("resolve exact structured result");

        assert_eq!(url.host_str(), Some("weixin.sogou.com"));
        assert_eq!(url.path(), "/link");
        assert_eq!(query_value(&url, &["url"]).as_deref(), Some("abc123"));
    }

    #[test]
    fn rejects_ambiguous_exact_sogou_article_results() {
        let result = r#"
            <li d="prefix-prefix-test"><h3><a href="/link?url={token}">在 a16z 的办公室,听 Decagon 创始人分享如何从 2 个人干到 1000 人</a></h3><span>深思圈</span></li>
        "#;
        let html = format!(
            "{}{}",
            result.replace("{token}", "first"),
            result.replace("{token}", "second")
        );

        let error = exact_sogou_result_url(&html, &sogou_test_identity())
            .expect_err("ambiguous results must not be guessed");

        assert!(error.contains("多个同 ID"));
    }

    #[test]
    fn reconstructs_and_validates_sogou_wechat_redirect() {
        let html = r#"
            <script>
              var url = '';
              url += 'https:\/\/mp.weixin.qq.com\/s?__biz=Mzg3NDc2MjQxMg%3D%3D&amp;';
              url += 'mid=2247500001&amp;idx=1&amp;sn=test\x2dsn @ ';
              window.location.replace(url);
            </script>
        "#;

        let url = fresh_wechat_url_from_sogou_redirect(html).expect("reconstruct redirect");

        assert_eq!(url.host_str(), Some("mp.weixin.qq.com"));
        assert_eq!(query_value(&url, &["mid"]).as_deref(), Some("2247500001"));
        assert_eq!(query_value(&url, &["sn"]).as_deref(), Some("test-sn"));
    }

    #[test]
    fn extracts_canonical_identity_from_fresh_article_script() {
        let page = r#"
            <script>
              var biz = "Mzg3NDc2MjQxMg==";
              var mid = "2247500001";
              var idx = 2;
              var sn = "safe_sn-1";
            </script>
        "#;
        let final_url = reqwest::Url::parse(
            "https://mp.weixin.qq.com/s?src=11&timestamp=1785545698&signature=fresh",
        )
        .expect("fresh article URL");

        let canonical = canonical_identity_from_page_script(page, &final_url)
            .expect("extract canonical identity");

        assert_eq!(canonical.biz, "Mzg3NDc2MjQxMg==");
        assert_eq!(canonical.mid, "2247500001");
        assert_eq!(canonical.idx, "2");
        assert_eq!(canonical.sn.as_deref(), Some("safe_sn-1"));
        assert!(canonical.authorized_url.is_none());
    }

    #[test]
    fn parses_current_wechat_client_bar_data() {
        let html = r#"
            <script>
              window.cgiDataNew = {
                appmsg_bar_data: {
                  read_num: '661' * 1,
                  like_count: '18' * 1,
                  old_like_count: '44' * 1,
                  share_count: '95' * 1,
                  comment_count: '4' * 1,
                  collect_count: '15' * 1,
                  show_friend_seen: '2' * 1,
                }
              };
              var read_num_new = '661' * 1;
            </script>
        "#;
        let parsed = parse_metrics_from_html(html);

        assert_eq!(parsed.read_count, Some(661));
        assert_eq!(parsed.like_count, Some(44));
        assert_eq!(parsed.recommend_count, Some(18));
        assert_eq!(parsed.share_count, Some(95));
        assert_eq!(parsed.comment_count, Some(4));
        assert_eq!(parsed.collect_count, Some(15));
    }

    #[test]
    fn parses_authenticated_mp_backend_metrics_and_checks_article_identity() {
        let html = r#"
            <script>window.wx.cgiData = {};</script>
            <script>
              window.wx.cgiData = {
                articleData: {
                  "title": "测试文章",
                  "msgid": "2247498514_2",
                  "article_data_new": {
                    "read_uv": 9,
                    "like_cnt": 0,
                    "zaikan_cnt": 0,
                    "share_uv": 0,
                    "comment_cnt": 0,
                    "collection_uv": 0
                  }
                }
              };
            </script>
        "#;
        let parsed =
            parse_metrics_from_mp_backend(html, "2247498514_2").expect("parse backend metrics");

        assert_eq!(parsed.read_count, Some(9));
        assert_eq!(parsed.like_count, Some(0));
        assert_eq!(parsed.recommend_count, Some(0));
        assert_eq!(parsed.share_count, Some(0));
        assert!(parse_metrics_from_mp_backend(html, "2247498514_1").is_err());
    }

    #[test]
    fn resolves_share_data_to_a_safe_canonical_identity() {
        let identity = ArticleIdentity {
            aid: "sogou:test-canonical".to_string(),
            mid: None,
            idx: None,
            sn: None,
            fakeid: "Mzg3NDc2MjQxMg==".to_string(),
            publisher: Some("深思圈".to_string()),
            title: "在 a16z 的办公室,听 Decagon 创始人分享".to_string(),
            create_time: 1_700_000_000,
            source_url: "https://mp.weixin.qq.com/s?src=11&signature=expired".to_string(),
        };
        let share_data = serde_json::json!({
            "title": "在 a16z 的办公室，听 Decagon 创始人分享",
            "brandName": "深思圈",
            "pageKey": "Mzg3NDc2MjQxMg==_2247494972_1"
        })
        .to_string();
        let canonical = canonical_identity_from_share_row(
            &identity,
            "https://mp.weixin.qq.com/s/safe-short-id?tracking=discarded",
            "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247494972&idx=1&sn=abcdef0123456789&key=secret&pass_ticket=secret",
            share_data.as_bytes(),
            1_700_000_100,
        )
        .expect("resolve canonical identity");

        assert_eq!(canonical.mid, "2247494972");
        assert_eq!(canonical.idx, "1");
        assert_eq!(canonical.sn.as_deref(), Some("abcdef0123456789"));
        assert_eq!(
            canonical.short_url.as_deref(),
            Some("https://mp.weixin.qq.com/s/safe-short-id")
        );
        assert!(canonical.authorized_url.is_some());
        assert!(!canonical.canonical_url.contains("key="));
        assert!(!canonical.canonical_url.contains("pass_ticket="));
        assert_eq!(
            reqwest::Url::parse(&canonical.canonical_url)
                .expect("safe canonical URL")
                .query_pairs()
                .map(|(name, _)| name.into_owned())
                .collect::<Vec<_>>(),
            vec!["__biz", "mid", "idx", "sn"]
        );
    }

    #[test]
    fn parses_page_key_and_rejects_malformed_identifiers() {
        assert_eq!(
            parse_wechat_page_key("Mzg3NDc2MjQxMg==_2247494972_1"),
            Some((
                "Mzg3NDc2MjQxMg==".to_string(),
                "2247494972".to_string(),
                "1".to_string()
            ))
        );
        assert!(parse_wechat_page_key("biz_not-a-number_1").is_none());
        assert!(safe_canonical_wechat_url("biz", "mid", "1", None).is_none());
    }

    #[test]
    fn derives_chromium_simple_cache_filename_from_the_exact_key() {
        assert_eq!(
            chromium_simple_cache_filename(
                "1/0/https://mp.weixin.qq.com/s?__biz=test&mid=1&idx=1",
                0
            ),
            "c799e1f60bc37eef_0"
        );
    }

    #[test]
    fn reads_the_hashed_article_cache_without_scanning_the_directory() {
        let temp = tempfile::tempdir().expect("temp profile");
        let cache_dir = temp.path().join("Cache").join("Cache_Data");
        fs::create_dir_all(&cache_dir).expect("create cache directory");
        let cache_key =
            "1/0/https://mp.weixin.qq.com/s?__biz=test&mid=2247494972&idx=1&sn=safe&key=secret";
        let path = cache_dir.join(chromium_simple_cache_filename(cache_key, 0));
        let html = br#"
            <script>
              window.cgiDataNew = {appmsg_bar_data: {
                read_num: '2757' * 1,
                old_like_count: '36' * 1,
                like_count: '21' * 1,
              }};
            </script>
        "#;
        let mut entry = Vec::new();
        entry.extend_from_slice(&SIMPLE_CACHE_MAGIC.to_le_bytes());
        entry.extend_from_slice(&5u32.to_le_bytes());
        entry.extend_from_slice(&(cache_key.len() as u32).to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(cache_key.as_bytes());
        entry.extend_from_slice(html);
        fs::write(path, entry).expect("write hashed cache entry");
        let identity = ArticleIdentity {
            aid: "sogou:hashed-cache".to_string(),
            mid: Some("2247494972".to_string()),
            idx: Some("1".to_string()),
            sn: Some("safe".to_string()),
            fakeid: "test".to_string(),
            publisher: None,
            title: "测试文章".to_string(),
            create_time: 1_700_000_000,
            source_url: "https://mp.weixin.qq.com/s/example".to_string(),
        };

        let outcome = capture_from_authorized_cache_key(
            &identity,
            &[(temp.path().to_path_buf(), 0)],
            cache_key,
        )
        .expect("read exact hashed cache");
        assert_eq!(outcome.metrics.read_count, Some(2757));
        assert_eq!(outcome.metrics.like_count, Some(36));
        assert_eq!(outcome.metrics.recommend_count, Some(21));
    }

    #[test]
    fn parses_authorized_appmsgext_metrics() {
        let payload = serde_json::json!({
            "base_resp": {"ret": 0},
            "appmsgstat": {"real_read_num": 1234, "like_num": 21},
            "appmsgact": {"old_like_num": 21, "like_num": 8, "share_count": 5},
            "comment_count": 3
        });
        let metrics = parse_metrics_from_appmsgext(&payload);

        assert_eq!(metrics.read_count, Some(1234));
        assert_eq!(metrics.like_count, Some(21));
        assert_eq!(metrics.recommend_count, Some(8));
        assert_eq!(metrics.share_count, Some(5));
        assert_eq!(metrics.comment_count, Some(3));
    }

    #[test]
    fn extracts_quoted_numeric_and_boolean_page_scalars() {
        let html = r#"
            var mid = "2247494972";
            window.idx = 1;
            window.isPaySubscribe = false;
        "#;

        assert_eq!(
            extract_js_scalar_value(html, "mid").as_deref(),
            Some("2247494972")
        );
        assert_eq!(extract_js_scalar_value(html, "idx").as_deref(), Some("1"));
        assert_eq!(
            extract_js_scalar_value(html, "isPaySubscribe").as_deref(),
            Some("0")
        );
    }

    #[test]
    fn identity_schema_never_persists_authorized_urls() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        ensure_schema(&conn).expect("create schema");
        let columns = conn
            .prepare("PRAGMA table_info(article_wechat_identities)")
            .expect("prepare table info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table info")
            .collect::<rusqlite::Result<Vec<_>>>()
            .expect("collect columns");

        assert!(columns.contains(&"canonical_url".to_string()));
        assert!(columns.contains(&"cache_filename".to_string()));
        assert!(!columns.contains(&"authorized_url".to_string()));
        assert!(!columns.contains(&"pass_ticket".to_string()));
        assert!(!columns.contains(&"key".to_string()));
    }

    #[test]
    fn reads_metrics_from_a_gzip_chromium_simple_cache_entry() {
        let temp = tempfile::tempdir().expect("temp cache directory");
        let path = temp.path().join("article_0");
        let key = b"1/0/https://mp.weixin.qq.com/s?__biz=test&mid=2247498514&idx=1&key=secret";
        let html = br#"
            <script>
              window.cgiDataNew = {appmsg_bar_data: {
                read_num: '661' * 1,
                old_like_count: '44' * 1,
                like_count: '18' * 1,
              }};
              var read_num_new = '661' * 1;
            </script>
        "#;
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(html).expect("compress cached response");
        let compressed = encoder.finish().expect("finish cached response");

        let mut entry = Vec::new();
        entry.extend_from_slice(&SIMPLE_CACHE_MAGIC.to_le_bytes());
        entry.extend_from_slice(&5u32.to_le_bytes());
        entry.extend_from_slice(&(key.len() as u32).to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(key);
        entry.extend_from_slice(&compressed);
        entry.extend_from_slice(b"trailing chromium metadata");
        fs::write(&path, &entry).expect("write cache entry");

        let candidate = CacheCandidate {
            path,
            modified_at: 1_700_000_000,
        };
        let identity = ArticleIdentity {
            aid: "2247498514_1".to_string(),
            mid: Some("2247498514".to_string()),
            idx: Some("1".to_string()),
            sn: None,
            fakeid: "test".to_string(),
            publisher: Some("测试公众号".to_string()),
            title: "测试文章".to_string(),
            create_time: 1_700_000_000,
            source_url: "https://mp.weixin.qq.com/s/example".to_string(),
        };
        let CacheEntryResult::Metrics {
            metrics: parsed, ..
        } = read_metrics_cache_entry(&candidate, &identity).expect("parse cache entry")
        else {
            panic!("expected cached metrics")
        };

        assert_eq!(parsed.read_count, Some(661));
        assert_eq!(parsed.like_count, Some(44));
        assert_eq!(parsed.recommend_count, Some(18));

        fs::remove_file(&candidate.path).expect("remove transient cache entry");
        let CacheEntryResult::Metrics {
            metrics: snapshot_parsed,
            ..
        } = read_metrics_cache_bytes(&entry, &identity).expect("parse snapshotted cache bytes")
        else {
            panic!("expected metrics from snapshotted cache bytes")
        };
        assert_eq!(snapshot_parsed.read_count, Some(661));
    }

    #[test]
    fn recent_cache_scan_excludes_entries_older_than_the_capture_window() {
        let temp = tempfile::tempdir().expect("temp cache directory");
        let path = temp.path().join("article_0");
        fs::write(&path, vec![0_u8; SIMPLE_CACHE_HEADER_BYTES as usize + 1])
            .expect("write cache entry");

        assert_eq!(recent_cache_candidates(temp.path()).len(), 1);
        let future = system_time_to_unix(SystemTime::now()) + 60;
        assert!(recent_cache_candidates_since(temp.path(), Some(future)).is_empty());
    }

    #[test]
    fn matches_a_sogou_article_cache_entry_by_publisher_and_page_title() {
        let temp = tempfile::tempdir().expect("temp cache directory");
        let path = temp.path().join("article_0");
        let key = b"1/0/https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg==&mid=2247500000&idx=1&key=secret";
        let html = r#"
            <h1 class="rich_media_title" id="activity-name">
              <span class="js_title_inner">我在硅谷，聊了两小时</span>
            </h1>
            <script>
              window.cgiDataNew = {appmsg_bar_data: {
                read_num: '801' * 1,
                old_like_count: '20' * 1,
              }};
            </script>
        "#
        .as_bytes();
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(html).expect("compress cached response");
        let compressed = encoder.finish().expect("finish cached response");
        let mut entry = Vec::new();
        entry.extend_from_slice(&SIMPLE_CACHE_MAGIC.to_le_bytes());
        entry.extend_from_slice(&5u32.to_le_bytes());
        entry.extend_from_slice(&(key.len() as u32).to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(key);
        entry.extend_from_slice(&compressed);
        fs::write(&path, entry).expect("write cache entry");

        let identity = ArticleIdentity {
            aid: "sogou:test-title-match".to_string(),
            mid: None,
            idx: None,
            sn: None,
            fakeid: "Mzg3NDc2MjQxMg==".to_string(),
            publisher: Some("深思圈".to_string()),
            title: "我在硅谷,聊了两小时".to_string(),
            create_time: 1_700_000_000,
            source_url: "https://mp.weixin.qq.com/s?src=11&signature=expired".to_string(),
        };
        let candidate = CacheCandidate {
            path,
            modified_at: 1_700_000_000,
        };
        let CacheEntryResult::Metrics { metrics, canonical } =
            read_metrics_cache_entry(&candidate, &identity).expect("read title-matched entry")
        else {
            panic!("expected cached metrics")
        };

        assert_eq!(metrics.read_count, Some(801));
        assert_eq!(metrics.like_count, Some(20));
        let canonical = canonical.expect("derive canonical identity from verified cache");
        assert_eq!(canonical.biz, identity.fakeid);
        assert_eq!(canonical.mid, "2247500000");
        assert_eq!(canonical.idx, "1");
    }

    #[test]
    fn rejects_same_title_and_publisher_from_a_different_publish_date() {
        let key = b"1/0/https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg==&mid=2247500001&idx=1&key=secret";
        let html = r#"
            <h1 class="rich_media_title">重复标题</h1>
            <script>
              var ct = "1700000000";
              var read_num_new = "801" * 1;
            </script>
        "#
        .as_bytes();
        let mut entry = Vec::new();
        entry.extend_from_slice(&SIMPLE_CACHE_MAGIC.to_le_bytes());
        entry.extend_from_slice(&5u32.to_le_bytes());
        entry.extend_from_slice(&(key.len() as u32).to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(&0u32.to_le_bytes());
        entry.extend_from_slice(key);
        entry.extend_from_slice(html);
        let identity = ArticleIdentity {
            aid: "sogou:test-date-mismatch".to_string(),
            mid: None,
            idx: None,
            sn: None,
            fakeid: "Mzg3NDc2MjQxMg==".to_string(),
            publisher: Some("深思圈".to_string()),
            title: "重复标题".to_string(),
            create_time: 1_700_259_200,
            source_url: "https://mp.weixin.qq.com/s?src=11&signature=expired".to_string(),
        };

        assert!(matches!(
            read_metrics_cache_bytes(&entry, &identity).expect("parse cache identity"),
            CacheEntryResult::NotMatched
        ));
    }

    #[test]
    fn canonical_cache_identity_requires_the_expected_sn() {
        let identity = ArticleIdentity {
            aid: "2247500001_1".to_string(),
            mid: Some("2247500001".to_string()),
            idx: Some("1".to_string()),
            sn: Some("expected-sn".to_string()),
            fakeid: "Mzg3NDc2MjQxMg==".to_string(),
            publisher: Some("深思圈".to_string()),
            title: "测试文章".to_string(),
            create_time: 1_700_000_000,
            source_url: "https://mp.weixin.qq.com/s/example".to_string(),
        };
        let matching = reqwest::Url::parse(
            "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247500001&idx=1&sn=expected-sn",
        )
        .expect("matching URL");
        let wrong = reqwest::Url::parse(
            "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247500001&idx=1&sn=other-sn",
        )
        .expect("wrong URL");
        let missing_optional_sn = reqwest::Url::parse(
            "https://mp.weixin.qq.com/s?__biz=Mzg3NDc2MjQxMg%3D%3D&mid=2247500001&idx=1",
        )
        .expect("URL without sn");
        let wrong_publisher = reqwest::Url::parse(
            "https://mp.weixin.qq.com/s?__biz=other&mid=2247500001&idx=1&sn=expected-sn",
        )
        .expect("wrong publisher URL");

        assert!(cache_url_matches_article(&matching, &identity));
        assert!(cache_url_matches_article(&missing_optional_sn, &identity));
        assert!(!cache_url_matches_article(&wrong, &identity));
        assert!(!cache_url_matches_article(&wrong_publisher, &identity));
    }

    #[test]
    fn parses_history_articles_and_reuses_only_session_query_fields() {
        let history = serde_json::json!({
            "list": [{
                "comm_msg_info": {"datetime": 1_785_545_698_i64},
                "app_msg_ext_info": {
                    "title": "主文章",
                    "content_url": "https://mp.weixin.qq.com/s?__biz=biz&amp;mid=10&amp;idx=1&amp;sn=main",
                    "multi_app_msg_item_list": [{
                        "title": "子文章",
                        "content_url": "https://mp.weixin.qq.com/s?__biz=biz&amp;mid=10&amp;idx=2&amp;sn=child"
                    }]
                }
            }]
        });
        let articles = parse_history_articles(&history);

        assert_eq!(articles.len(), 2);
        assert_eq!(articles[1].title, "子文章");
        assert!(articles[1].content_url.contains("&mid=10&idx=2"));

        let bootstrap = reqwest::Url::parse(
            "https://mp.weixin.qq.com/s?__biz=biz&mid=9&idx=1&key=session-key&pass_ticket=ticket&uin=uin&lang=zh_CN",
        )
        .expect("bootstrap URL");
        let target = session_url_for_history_article(&articles[1].content_url, &bootstrap)
            .expect("target URL");

        assert_eq!(query_value(&target, &["mid"]).as_deref(), Some("10"));
        assert_eq!(query_value(&target, &["idx"]).as_deref(), Some("2"));
        assert_eq!(
            query_value(&target, &["key"]).as_deref(),
            Some("session-key")
        );
        assert_eq!(
            query_value(&target, &["pass_ticket"]).as_deref(),
            Some("ticket")
        );
    }

    #[test]
    fn extracts_wechat_session_tokens_from_window_assignments() {
        let html = r#"
            window.wxtoken = params['wxtoken'] || '';
            window.appmsg_token = "1388_example%2Ftoken" || "";
        "#;

        assert_eq!(
            extract_js_string_value(html, "appmsg_token").as_deref(),
            Some("1388_example%2Ftoken")
        );
    }

    #[test]
    fn stores_and_reads_an_unavailable_snapshot_without_fabricating_counts() {
        let conn = Connection::open_in_memory().expect("open in-memory database");
        ensure_schema(&conn).expect("create schema");
        let input = ArticlePublicMetricsSnapshot {
            id: 0,
            aid: "2247_1".to_string(),
            source_url: "https://mp.weixin.qq.com/s/example".to_string(),
            source_kind: SOURCE_KIND.to_string(),
            capture_method: "cache_unavailable".to_string(),
            captured_at: 1_700_000_000,
            status: "unavailable".to_string(),
            read_count: None,
            like_count: None,
            recommend_count: None,
            share_count: None,
            comment_count: None,
            collect_count: None,
            note: Some("页面未返回数值".to_string()),
        };

        let stored = insert_snapshot_with_conn(&conn, &input).expect("store snapshot");

        assert!(stored.id > 0);
        assert_eq!(stored.status, "unavailable");
        assert_eq!(stored.read_count, None);
        assert_eq!(stored.note.as_deref(), Some("页面未返回数值"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn account_feed_matching_prefers_canonical_id_and_disambiguates_title_by_date() {
        let articles = vec![
            db::ArticleSummary {
                aid: "sogou:first".to_string(),
                fakeid: "biz".to_string(),
                title: "重复标题".to_string(),
                link: "https://mp.weixin.qq.com/s/first".to_string(),
                digest: None,
                cover: None,
                author: None,
                create_time: 1_700_000_000,
                has_content: true,
                article_type: None,
                copyright_type: None,
                match_fields: Vec::new(),
                match_excerpt: None,
            },
            db::ArticleSummary {
                aid: "sogou:second".to_string(),
                fakeid: "biz".to_string(),
                title: "重复 标题".to_string(),
                link: "https://mp.weixin.qq.com/s/second".to_string(),
                digest: None,
                cover: None,
                author: None,
                create_time: 1_700_086_400,
                has_content: true,
                article_type: None,
                copyright_type: None,
                match_fields: Vec::new(),
                match_excerpt: None,
            },
        ];
        let record = crate::wechat_account_feed::AccountFeedArticleMetrics {
            biz: "biz".to_string(),
            mid: "42".to_string(),
            idx: "1".to_string(),
            sn: None,
            link: "https://mp.weixin.qq.com/s?__biz=biz&mid=42&idx=1".to_string(),
            transient_fetch_link: None,
            title: "重复标题".to_string(),
            publisher: Some("测试公众号".to_string()),
            digest: None,
            cover: None,
            create_time: Some(1_700_086_400),
            update_time_ms: 1_700_086_400_000,
            read_count: Some(100),
            like_count: Some(10),
            recommend_count: Some(5),
            share_count: Some(4),
            comment_count: Some(3),
            collect_count: Some(2),
        };
        let title_aids = HashMap::from([(normalized_title_key("重复标题"), vec![0, 1])]);

        let canonical = HashMap::from([(
            (record.mid.clone(), record.idx.clone()),
            "sogou:first".to_string(),
        )]);
        assert_eq!(
            match_local_account_article(&record, &articles, &canonical, &title_aids)
                .map(|article| article.aid.as_str()),
            Some("sogou:first")
        );

        assert_eq!(
            match_local_account_article(&record, &articles, &HashMap::new(), &title_aids)
                .map(|article| article.aid.as_str()),
            Some("sogou:second")
        );
    }

    #[test]
    #[ignore = "requires an owned article plus a current authenticated mp.weixin.qq.com backend session; never opens WeChat UI"]
    fn live_authenticated_mp_backend_reads_owned_article_without_ui() {
        init_live_test_logger();
        let aid = std::env::var("WXMP_TEST_ARTICLE_AID")
            .expect("set WXMP_TEST_ARTICLE_AID to an owned article id");
        let article = db::get_article(&aid)
            .expect("read article database")
            .expect("article exists");
        let outcome = capture_from_authenticated_mp_backend(&article)
            .expect("authenticated backend request succeeds")
            .expect("article belongs to the authenticated account");

        assert!(outcome.metrics.has_any());
        eprintln!(
            "live authenticated backend metrics: source={} method={} read={:?} like={:?} recommend={:?} share={:?} comment={:?} collect={:?}",
            outcome.source_kind,
            outcome.method,
            outcome.metrics.read_count,
            outcome.metrics.like_count,
            outcome.metrics.recommend_count,
            outcome.metrics.share_count,
            outcome.metrics.comment_count,
            outcome.metrics.collect_count
        );
    }

    #[test]
    #[ignore = "requires a real article row plus an authenticated backend or local WeChat cache"]
    fn live_capture_reads_real_metrics() {
        init_live_test_logger();
        let aid = std::env::var("WXMP_TEST_ARTICLE_AID")
            .expect("set WXMP_TEST_ARTICLE_AID to an article id");
        let snapshot = capture_and_store(&aid).expect("capture live public metrics snapshot");

        assert_eq!(snapshot.aid, aid);
        assert!(matches!(
            snapshot.source_kind.as_str(),
            SOURCE_KIND
                | LOCAL_SESSION_SOURCE_KIND
                | MP_BACKEND_SOURCE_KIND
                | ACCOUNT_FEED_SOURCE_KIND
        ));
        assert_eq!(snapshot.status, STATUS_VISIBLE);
        assert!(snapshot.read_count.is_some());
        assert_eq!(
            latest_snapshot(&aid)
                .expect("read latest snapshot")
                .expect("latest snapshot exists")
                .id,
            snapshot.id
        );
        eprintln!(
            "live WeChat metrics snapshot: id={} source={} method={} captured_at={} read={:?} like={:?} recommend={:?} share={:?} comment={:?} collect={:?}",
            snapshot.id,
            snapshot.source_kind,
            snapshot.capture_method,
            snapshot.captured_at,
            snapshot.read_count,
            snapshot.like_count,
            snapshot.recommend_count,
            snapshot.share_count,
            snapshot.comment_count,
            snapshot.collect_count
        );
    }

    #[test]
    #[ignore = "requires a real article row plus local WeChat Share Data and cache"]
    fn live_resolves_canonical_identity_without_opening_wechat() {
        let aid = std::env::var("WXMP_TEST_ARTICLE_AID")
            .expect("set WXMP_TEST_ARTICLE_AID to an article id");
        let article = db::get_article(&aid)
            .expect("read article database")
            .expect("article exists");
        let source_url = normalize_source_url(&article.link).expect("valid source URL");
        let publisher = db::get_account(&article.fakeid)
            .expect("read publisher")
            .map(|account| account.nickname);
        let mut identity = ArticleIdentity::from_article(&article, &source_url, publisher);
        let canonical = resolve_article_canonical_identity(&mut identity)
            .expect("resolve canonical identity")
            .expect("canonical identity exists");
        assert_eq!(canonical.biz, article.fakeid);
        assert!(identity.mid.is_some());
        eprintln!(
            "canonical identity: mid={} idx={} has_sn={} has_authorized_url={}",
            canonical.mid,
            canonical.idx,
            canonical.sn.is_some(),
            canonical.authorized_url.is_some()
        );

        let profiles = discover_wechat_profiles().expect("discover WeChat profiles");
        let cache_key = canonical
            .authorized_cache_key
            .as_deref()
            .expect("authorized cache key");
        let outcome = capture_from_authorized_cache_key(&identity, &profiles, cache_key)
            .expect("read exact hashed canonical cache entry");
        assert!(outcome.metrics.has_any());
        eprintln!("canonical cache metrics: {:#?}", outcome.metrics);
    }

    #[test]
    #[ignore = "requires a real article row plus a current same-account WeChat article session"]
    fn live_cached_account_session_reads_an_unopened_article() {
        let aid = std::env::var("WXMP_TEST_SESSION_ARTICLE_AID")
            .expect("set WXMP_TEST_SESSION_ARTICLE_AID to an article id");
        let article = db::get_article(&aid)
            .expect("read article database")
            .expect("article exists");
        let source_url = normalize_source_url(&article.link).expect("valid article URL");
        let mut identity = ArticleIdentity::from_article(&article, &source_url, None);
        identity.mid = None;
        identity.idx = None;

        let profiles_root = wechat_profiles_root().expect("WeChat profiles root");
        let mut profiles = fs::read_dir(profiles_root)
            .expect("read WeChat profiles")
            .filter_map(|entry| entry.ok())
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name == "multitab" || name.starts_with("multitab_"))
            })
            .map(|entry| (entry.path(), 0))
            .collect::<Vec<_>>();
        profiles.truncate(MAX_WECHAT_PROFILES);

        let outcome = capture_from_cached_account_session(&identity, &profiles)
            .expect("read via same-account WeChat session");
        assert_eq!(outcome.source_kind, LOCAL_SESSION_SOURCE_KIND);
        assert!(outcome.metrics.has_any());
        eprintln!(
            "live same-account WeChat session metrics: {:#?}",
            outcome.metrics
        );
    }

    #[test]
    #[ignore = "requires live Sogou and WeChat article endpoints; never opens WeChat UI"]
    fn live_sogou_backend_resolves_an_unopened_article() {
        init_live_test_logger();
        let aid = std::env::var("WXMP_TEST_SOGOU_ARTICLE_AID")
            .expect("set WXMP_TEST_SOGOU_ARTICLE_AID to a sogou article id");
        assert!(aid.starts_with("sogou:"));
        let article = db::get_article(&aid)
            .expect("read article database")
            .expect("article exists");
        let source_url = normalize_source_url(&article.link).expect("valid article URL");
        let publisher = db::get_account(&article.fakeid)
            .expect("read publisher")
            .map(|account| account.nickname);
        let mut identity = ArticleIdentity::from_article(&article, &source_url, publisher);

        let resolved = resolve_fresh_sogou_article(&mut identity)
            .expect("resolve exact article through the structured backend route");

        assert!(identity.mid.is_some());
        assert_eq!(resolved.authorized_url.scheme(), "https");
        assert_eq!(resolved.authorized_url.host_str(), Some("mp.weixin.qq.com"));
        eprintln!(
            "live Sogou backend identity: mid={} idx={} has_sn={} embedded_metrics={}",
            identity.mid.as_deref().unwrap_or_default(),
            identity.idx.as_deref().unwrap_or_default(),
            identity.sn.is_some(),
            resolved.embedded_metrics.is_some()
        );
    }

    #[test]
    #[ignore = "requires the live article database and a logged-in local WeChat; may open one owned article window"]
    fn live_captures_article_metrics_end_to_end() {
        init_live_test_logger();
        let aid = std::env::var("WXMP_TEST_METRICS_AID")
            .expect("set WXMP_TEST_METRICS_AID to an article id");
        let started = Instant::now();
        let snapshot = capture_and_store(&aid).expect("capture and store live article metrics");
        let has_any_metric = snapshot.read_count.is_some()
            || snapshot.like_count.is_some()
            || snapshot.recommend_count.is_some()
            || snapshot.share_count.is_some()
            || snapshot.comment_count.is_some()
            || snapshot.collect_count.is_some();

        assert!(has_any_metric, "live capture returned no metric values");
        eprintln!(
            "live metrics: elapsed_ms={} source={} method={} read={:?} like={:?} recommend={:?} share={:?} comment={:?} collect={:?}",
            started.elapsed().as_millis(),
            snapshot.source_kind,
            snapshot.capture_method,
            snapshot.read_count,
            snapshot.like_count,
            snapshot.recommend_count,
            snapshot.share_count,
            snapshot.comment_count,
            snapshot.collect_count
        );
    }

    #[test]
    #[ignore = "read-only diagnostic for recently changed local WeChat cache entries"]
    fn live_reports_recent_metrics_cache_shapes() {
        let modified_since = system_time_to_unix(SystemTime::now()).saturating_sub(5 * 60);
        let profiles = discover_wechat_profiles().expect("discover WeChat profiles");
        for (profile, _) in profiles {
            let cache_dir = profile.join("Cache").join("Cache_Data");
            for candidate in recent_cache_candidates_since(&cache_dir, Some(modified_since)) {
                let Ok(url) = read_cache_entry_url(&candidate) else {
                    continue;
                };
                if url.host_str() != Some("mp.weixin.qq.com")
                    || !(url.path().starts_with("/s") || url.path().contains("getappmsgext"))
                {
                    continue;
                }
                let bytes = fs::read(&candidate.path).expect("read recent cache entry");
                let body = String::from_utf8_lossy(&bytes);
                eprintln!(
                    "recent cache: path={} mid={:?} idx={:?} biz_present={} appmsgstat={} appmsgact={} bytes={}",
                    url.path(),
                    query_value(&url, &["mid", "appmsgid"]),
                    query_value(&url, &["idx", "itemidx"]),
                    query_value(&url, &["__biz"]).is_some(),
                    body.contains("appmsgstat"),
                    body.contains("appmsgact"),
                    bytes.len()
                );
            }
        }
    }

    #[test]
    #[ignore = "read-only diagnostic for a downloaded WeChat article page"]
    fn live_parses_downloaded_wechat_article_page() {
        let path = std::env::var("WXMP_TEST_WECHAT_PAGE").expect("set WXMP_TEST_WECHAT_PAGE");
        let page = fs::read_to_string(path).expect("read downloaded WeChat page");
        let metrics = parse_metrics_from_html(&page);
        eprintln!("downloaded page metrics: {metrics:#?}");
        eprintln!(
            "downloaded page fields: appmsg_token={} wxtoken={} biz={} mid={} idx={} sn={}",
            extract_js_string_value(&page, "appmsg_token").is_some_and(|value| !value.is_empty()),
            extract_js_string_value(&page, "wxtoken").is_some_and(|value| !value.is_empty()),
            extract_js_scalar_value(&page, "biz").is_some_and(|value| !value.is_empty()),
            extract_js_scalar_value(&page, "mid").is_some_and(|value| !value.is_empty()),
            extract_js_scalar_value(&page, "idx").is_some_and(|value| !value.is_empty()),
            extract_js_scalar_value(&page, "sn").is_some_and(|value| !value.is_empty())
        );
    }
}
