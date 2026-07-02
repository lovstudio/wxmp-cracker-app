use anyhow::{anyhow, Context, Result};
use reqwest::header::{COOKIE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{
    webview::{Cookie, PageLoadEvent},
    AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};

use crate::db::config_path;

const LOGIN_URL: &str = "https://mp.weixin.qq.com/";
const LOGIN_LABEL: &str = "wxmp-login";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const LOGIN_COOKIE_CAPTURE_ATTEMPTS: usize = 20;
const LOGIN_COOKIE_CAPTURE_DELAY_MS: u64 = 500;
const REQUIRED_LOGIN_COOKIE: &str = "slave_sid";

type LoginCaptureState = Arc<Mutex<Option<String>>>;

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LoginStatus {
    pub logged_in: bool,
    pub token: Option<String>,
    pub account: Option<LoginAccount>,
    pub last_login_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LoginAccount {
    pub nickname: Option<String>,
    pub username: Option<String>,
    pub avatar: Option<String>,
    pub alias: Option<String>,
    pub service_type: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct WcxConfig {
    pub token: String,
    pub cookie: String,
    #[serde(default)]
    pub account: Option<LoginAccount>,
    #[serde(default)]
    pub last_login_at: Option<i64>,
}

pub fn read_config() -> Option<WcxConfig> {
    let p = config_path().ok()?;
    let data = fs::read_to_string(&p).ok()?;
    serde_json::from_str(&data).ok()
}

pub fn write_config(cfg: &WcxConfig) -> Result<()> {
    let p = config_path()?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).ok();
    }
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&p, json).context("write wcx config.json")?;
    Ok(())
}

pub async fn current_status() -> LoginStatus {
    match read_config() {
        Some(mut c) => {
            let logged_in = !c.token.is_empty();
            let mut should_write = false;

            if logged_in && c.last_login_at.is_none() {
                c.last_login_at = config_modified_at();
                should_write = c.last_login_at.is_some();
            }

            if logged_in && c.account.is_none() {
                match fetch_login_account(&c).await {
                    Ok(account) => {
                        c.account = Some(account);
                        should_write = true;
                    }
                    Err(e) => log::warn!("failed to fetch login account info: {e:?}"),
                }
            }

            if should_write {
                if let Err(e) = write_config(&c) {
                    log::warn!("failed to cache login status info: {e:?}");
                }
            }

            LoginStatus {
                logged_in,
                token: Some(c.token),
                account: c.account,
                last_login_at: c.last_login_at,
            }
        }
        None => LoginStatus {
            logged_in: false,
            token: None,
            account: None,
            last_login_at: None,
        },
    }
}

/// Open the login webview and watch for a URL containing ?token=XXX. When the
/// host page is the mp.weixin.qq.com home with a token query param, we consider
/// the QR scan complete: extract token, dump cookies, write to wcx config, emit
/// `login://success` to the main webview, and close the login window.
pub fn open_login_window(app: &AppHandle) -> Result<()> {
    if let Some(existing) = app.get_webview_window(LOGIN_LABEL) {
        if let Ok(url) = LOGIN_URL.parse() {
            let _ = existing.navigate(url);
        }
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let app_handle = app.clone();
    let page_load_app_handle = app.clone();
    let capture_state: LoginCaptureState = Arc::new(Mutex::new(None));
    let navigation_capture_state = capture_state.clone();
    let page_load_capture_state = capture_state.clone();
    let win = WebviewWindowBuilder::new(
        app,
        LOGIN_LABEL,
        WebviewUrl::External(LOGIN_URL.parse().unwrap()),
    )
    .title("微信公众号登录 — 扫码后自动关闭")
    .inner_size(960.0, 720.0)
    .center()
    .resizable(true)
    .user_agent(USER_AGENT_VALUE)
    .on_navigation(move |url| {
        // Stay inside mp.weixin.qq.com only. Block redirects to system browser.
        let host_ok = is_allowed_login_url(url);

        // Detect token in URL query.
        if let Some(token) = login_token_from_url(url) {
            schedule_login_capture(&app_handle, token, &navigation_capture_state);
        }

        host_ok
    })
    .on_page_load(move |_window, payload| {
        if matches!(payload.event(), PageLoadEvent::Finished) {
            if let Some(token) = login_token_from_url(payload.url()) {
                schedule_login_capture(&page_load_app_handle, token, &page_load_capture_state);
            }
        }
    })
    .build()?;

    let _ = win.show();

    Ok(())
}

pub fn logout(app: &AppHandle) -> Result<()> {
    if let Some(existing) = app.get_webview_window(LOGIN_LABEL) {
        let _ = existing.close();
    }

    let p = config_path()?;
    match fs::remove_file(&p) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("remove {:?}", p)),
    }
}

fn is_allowed_login_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && matches!(url.host_str(), Some(h) if host_matches_domain(h, "qq.com"))
}

fn host_matches_domain(host: &str, domain: &str) -> bool {
    host == domain
        || host
            .strip_suffix(domain)
            .is_some_and(|prefix| prefix.ends_with('.'))
}

fn login_token_from_url(url: &Url) -> Option<String> {
    if !is_allowed_login_url(url) {
        return None;
    }

    url.query_pairs()
        .find(|(key, _)| key == "token")
        .map(|(_, value)| value.trim().to_string())
        .filter(|token| !token.is_empty())
}

fn schedule_login_capture(app: &AppHandle, token: String, state: &LoginCaptureState) {
    let should_capture = match state.lock() {
        Ok(mut active_token) => {
            if active_token.is_some() {
                false
            } else {
                *active_token = Some(token.clone());
                true
            }
        }
        Err(e) => {
            log::warn!("login capture state lock poisoned: {e}");
            false
        }
    };

    if !should_capture {
        return;
    }

    let app2 = app.clone();
    let state2 = state.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = capture_and_persist(&app2, &token).await {
            log::error!("login capture failed: {e:?}");
            reset_login_capture_state(&state2, &token);
            let _ = app2.emit("login://error", e.to_string());
        }
    });
}

fn reset_login_capture_state(state: &LoginCaptureState, token: &str) {
    if let Ok(mut active_token) = state.lock() {
        if active_token.as_deref() == Some(token) {
            *active_token = None;
        }
    }
}

async fn capture_and_persist(app: &AppHandle, token: &str) -> Result<()> {
    let win = app
        .get_webview_window(LOGIN_LABEL)
        .ok_or_else(|| anyhow!("login window vanished"))?;

    let (cookie, cookie_count) = capture_login_cookie_header(&win).await?;

    let mut cfg = WcxConfig {
        token: token.to_string(),
        cookie,
        account: None,
        last_login_at: current_unix_timestamp(),
    };

    match fetch_login_account(&cfg).await {
        Ok(account) => cfg.account = Some(account),
        Err(e) => log::warn!("login account info fetch failed: {e:?}"),
    }

    write_config(&cfg)?;

    log::info!("login captured: token={} ({} cookies)", token, cookie_count);
    let _ = app.emit("login://success", &cfg);

    // Close the login window. Main UI will refetch status.
    let _ = win.close();
    Ok(())
}

async fn capture_login_cookie_header(win: &tauri::WebviewWindow) -> Result<(String, usize)> {
    let login_url: Url = LOGIN_URL.parse().context("parse login URL")?;
    let mut last_error = None;

    for attempt in 1..=LOGIN_COOKIE_CAPTURE_ATTEMPTS {
        match read_login_cookie_header_once(win, login_url.clone()) {
            Ok(cookie) => return Ok(cookie),
            Err(e) => {
                last_error = Some(e);
            }
        }

        if attempt < LOGIN_COOKIE_CAPTURE_ATTEMPTS {
            tokio::time::sleep(std::time::Duration::from_millis(
                LOGIN_COOKIE_CAPTURE_DELAY_MS,
            ))
            .await;
        }
    }

    Err(last_error.unwrap_or_else(|| anyhow!("no cookies captured")))
}

fn read_login_cookie_header_once(
    win: &tauri::WebviewWindow,
    login_url: Url,
) -> Result<(String, usize)> {
    match win.cookies_for_url(login_url) {
        Ok(cookies) => match build_login_cookie_header(cookies) {
            Ok(cookie) => Ok(cookie),
            Err(scoped_error) => win
                .cookies()
                .map_err(|e| anyhow!("{scoped_error}; cookies(): {e}"))
                .and_then(build_login_cookie_header),
        },
        Err(scoped_error) => win
            .cookies()
            .map_err(|e| anyhow!("cookies_for_url(): {scoped_error}; cookies(): {e}"))
            .and_then(build_login_cookie_header),
    }
}

fn build_login_cookie_header(cookies: Vec<Cookie<'static>>) -> Result<(String, usize)> {
    let mut pairs: Vec<String> = Vec::new();
    let mut has_required_cookie = false;

    for c in cookies {
        let name = c.name().trim().to_string();
        let value = c.value().to_string();
        if name.is_empty() {
            continue;
        }
        if name == REQUIRED_LOGIN_COOKIE && !value.is_empty() {
            has_required_cookie = true;
        }
        pairs.push(format!("{name}={value}"));
    }

    if pairs.is_empty() {
        return Err(anyhow!("no cookies captured"));
    }
    if !has_required_cookie {
        return Err(anyhow!(
            "login cookies not ready: missing {REQUIRED_LOGIN_COOKIE}"
        ));
    }

    let cookie_count = pairs.len();
    Ok((pairs.join("; "), cookie_count))
}

async fn fetch_login_account(cfg: &WcxConfig) -> Result<LoginAccount> {
    let url = format!(
        "{LOGIN_URL}cgi-bin/home?t=home/index&lang=zh_CN&token={}",
        cfg.token
    );
    let html = reqwest::Client::new()
        .get(url)
        .header(USER_AGENT, USER_AGENT_VALUE)
        .header(REFERER, LOGIN_URL)
        .header(COOKIE, cfg.cookie.as_str())
        .send()
        .await
        .context("fetch mp.weixin.qq.com home")?
        .error_for_status()
        .context("mp.weixin.qq.com home returned error status")?
        .text()
        .await
        .context("read mp.weixin.qq.com home html")?;

    parse_login_account(&html).ok_or_else(|| anyhow!("login account fields not found"))
}

fn parse_login_account(html: &str) -> Option<LoginAccount> {
    let nickname = first_nonempty([
        extract_js_string_field(html, "real_nick_name"),
        extract_js_string_field(html, "nick_name"),
        extract_js_string_field(html, "nickname"),
    ]);
    let username = first_nonempty([
        extract_js_string_field(html, "user_name"),
        extract_js_string_field(html, "username"),
    ]);
    let avatar = first_nonempty([
        extract_js_string_field(html, "head_img"),
        extract_js_string_field(html, "head_url"),
    ]);
    let alias = first_nonempty([extract_js_string_field(html, "alias")]);
    let service_type = first_nonempty([
        extract_js_string_field(html, "serviceType"),
        extract_js_string_field(html, "service_type"),
    ]);

    let account = LoginAccount {
        nickname,
        username,
        avatar,
        alias,
        service_type,
    };

    if account.nickname.is_some()
        || account.username.is_some()
        || account.avatar.is_some()
        || account.alias.is_some()
        || account.service_type.is_some()
    {
        Some(account)
    } else {
        None
    }
}

fn first_nonempty<const N: usize>(values: [Option<String>; N]) -> Option<String> {
    values
        .into_iter()
        .flatten()
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
}

fn extract_js_string_field(source: &str, field: &str) -> Option<String> {
    let mut offset = 0;
    while let Some(found) = source[offset..].find(field) {
        let index = offset + found;
        offset = index + field.len();

        if is_identifier_byte(source.as_bytes().get(index.wrapping_sub(1)).copied())
            || is_identifier_byte(source.as_bytes().get(index + field.len()).copied())
        {
            continue;
        }

        let rest = source[index + field.len()..].trim_start();
        let rest = rest
            .strip_prefix('"')
            .or_else(|| rest.strip_prefix('\''))
            .unwrap_or(rest)
            .trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(quote) = rest.chars().next().filter(|c| *c == '"' || *c == '\'') else {
            continue;
        };
        return read_quoted_js_string(&rest[quote.len_utf8()..], quote).map(decode_html_entities);
    }
    None
}

fn is_identifier_byte(byte: Option<u8>) -> bool {
    matches!(byte, Some(b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'_'))
}

fn read_quoted_js_string(input: &str, quote: char) -> Option<String> {
    let mut out = String::new();
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch == quote {
            return Some(out);
        }
        if ch != '\\' {
            out.push(ch);
            continue;
        }

        match chars.next()? {
            '\\' => out.push('\\'),
            '"' => out.push('"'),
            '\'' => out.push('\''),
            'n' => out.push('\n'),
            'r' => out.push('\r'),
            't' => out.push('\t'),
            'u' => {
                let hex: String = chars.by_ref().take(4).collect();
                if hex.len() == 4 {
                    if let Ok(code) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(code) {
                            out.push(decoded);
                        }
                    }
                }
            }
            other => out.push(other),
        }
    }
    None
}

fn decode_html_entities(value: String) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

fn current_unix_timestamp() -> Option<i64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs() as i64)
}

fn config_modified_at() -> Option<i64> {
    config_path()
        .ok()?
        .metadata()
        .ok()?
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_secs() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_token_from_url_accepts_wechat_token() {
        let url: Url = "https://mp.weixin.qq.com/cgi-bin/home?t=home/index&token=12345&lang=zh_CN"
            .parse()
            .unwrap();

        assert_eq!(login_token_from_url(&url).as_deref(), Some("12345"));
    }

    #[test]
    fn login_token_from_url_rejects_external_hosts() {
        let url: Url = "https://example.com/callback?token=12345".parse().unwrap();

        assert_eq!(login_token_from_url(&url), None);
    }

    #[test]
    fn allowed_login_url_is_limited_to_wechat_hosts() {
        let mp_url: Url = "https://mp.weixin.qq.com/".parse().unwrap();
        let qq_url: Url = "https://res.wx.qq.com/a.js".parse().unwrap();
        let external_url: Url = "https://example.com/".parse().unwrap();
        let fake_qq_url: Url = "https://badqq.com/".parse().unwrap();

        assert!(is_allowed_login_url(&mp_url));
        assert!(is_allowed_login_url(&qq_url));
        assert!(!is_allowed_login_url(&external_url));
        assert!(!is_allowed_login_url(&fake_qq_url));
    }
}
