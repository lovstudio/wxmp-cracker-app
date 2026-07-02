use anyhow::{anyhow, Context, Result};
use reqwest::header::{COOKIE, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};
use std::{
    fs, io,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::db::config_path;

const LOGIN_URL: &str = "https://mp.weixin.qq.com/";
const LOGIN_LABEL: &str = "wxmp-login";
const USER_AGENT_VALUE: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }

    let app_handle = app.clone();
    let win = WebviewWindowBuilder::new(
        app,
        LOGIN_LABEL,
        WebviewUrl::External(LOGIN_URL.parse().unwrap()),
    )
    .title("微信公众号登录 — 扫码后自动关闭")
    .inner_size(960.0, 720.0)
    .center()
    .resizable(true)
    .on_navigation(move |url| {
        // Stay inside mp.weixin.qq.com only. Block redirects to system browser.
        let host_ok = matches!(url.host_str(), Some(h) if h.ends_with("weixin.qq.com") || h.ends_with("qq.com"));

        // Detect token in URL query.
        if host_ok {
            if let Some(token) = url
                .query_pairs()
                .find(|(k, _)| k == "token")
                .map(|(_, v)| v.into_owned())
            {
                if !token.is_empty() {
                    let app2 = app_handle.clone();
                    // Defer cookie capture so the page settles.
                    tauri::async_runtime::spawn(async move {
                        // Give the page a beat to set all cookies.
                        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                        if let Err(e) = capture_and_persist(&app2, &token).await {
                            log::error!("login capture failed: {e:?}");
                            let _ = app2.emit("login://error", e.to_string());
                        }
                    });
                }
            }
        }

        host_ok
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

async fn capture_and_persist(app: &AppHandle, token: &str) -> Result<()> {
    let win = app
        .get_webview_window(LOGIN_LABEL)
        .ok_or_else(|| anyhow!("login window vanished"))?;

    // Tauri exposes cookies on the WebviewWindow via the underlying webview.
    // We grab all cookies for the mp.weixin.qq.com domain (incl. HttpOnly).
    let cookies = win.cookies().map_err(|e| anyhow!("cookies(): {e}"))?;

    // Build the standard "k=v; k=v" header value wcx expects.
    let mut pairs: Vec<String> = Vec::new();
    for c in cookies {
        let name = c.name().to_string();
        let value = c.value().to_string();
        if name.is_empty() {
            continue;
        }
        pairs.push(format!("{name}={value}"));
    }
    if pairs.is_empty() {
        return Err(anyhow!("no cookies captured"));
    }
    let cookie = pairs.join("; ");

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

    log::info!("login captured: token={} ({} cookies)", token, pairs.len());
    let _ = app.emit("login://success", &cfg);

    // Close the login window. Main UI will refetch status.
    let _ = win.close();
    Ok(())
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
