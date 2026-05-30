use anyhow::{anyhow, Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "wxmp-cracker";
const KEYRING_USER: &str = "github-oauth-token";
const USER_AGENT: &str = "wxmp-cracker";
const DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const API_BASE: &str = "https://api.github.com";

// Compile-time client id. Set WXMP_GITHUB_CLIENT_ID at build time.
// Falls back to empty string in dev so cargo check passes without it.
const CLIENT_ID: &str = match option_env!("WXMP_GITHUB_CLIENT_ID") {
    Some(v) => v,
    None => "",
};

/// repo scope is required to create and push to private repos.
const SCOPES: &str = "repo";

fn client_id() -> Result<&'static str> {
    if CLIENT_ID.is_empty() {
        Err(anyhow!(
            "GitHub 集成尚未配置（缺少 WXMP_GITHUB_CLIENT_ID 编译时变量）。"
        ))
    } else {
        Ok(CLIENT_ID)
    }
}

fn entry() -> Result<Entry> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).context("打开系统 keychain 失败")
}

pub fn load_token() -> Result<Option<String>> {
    match entry()?.get_password() {
        Ok(t) if t.is_empty() => Ok(None),
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!(e)).context("读取 GitHub token 失败"),
    }
}

fn store_token(token: &str) -> Result<()> {
    entry()?
        .set_password(token)
        .context("写入 GitHub token 到 keychain 失败")
}

fn delete_token() -> Result<()> {
    match entry()?.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(anyhow!(e)).context("删除 GitHub token 失败"),
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct DeviceCodeStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: u64,
    pub interval: u64,
}

#[derive(Deserialize)]
struct DeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: u64,
}

#[derive(Deserialize)]
struct AccessTokenResponse {
    #[serde(default)]
    access_token: Option<String>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    error_description: Option<String>,
    #[serde(default)]
    interval: Option<u64>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DevicePollOutcome {
    /// authorization completed and token has been stored
    Authorized { login: String, avatar_url: String },
    /// keep polling
    Pending { interval: u64 },
    /// access denied or expired — caller must restart device flow
    Denied { message: String },
}

pub async fn device_start() -> Result<DeviceCodeStart> {
    let client_id = client_id()?;
    let resp = reqwest::Client::new()
        .post(DEVICE_CODE_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", USER_AGENT)
        .body(format!(
            "client_id={}&scope={}",
            urlencoding::encode(client_id),
            urlencoding::encode(SCOPES)
        ))
        .send()
        .await
        .context("请求 device code 失败")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("device code 请求失败 ({status}): {body}"));
    }

    let parsed: DeviceCodeResponse = resp.json().await.context("解析 device code 响应失败")?;
    Ok(DeviceCodeStart {
        device_code: parsed.device_code,
        user_code: parsed.user_code,
        verification_uri: parsed.verification_uri,
        expires_in: parsed.expires_in,
        interval: parsed.interval,
    })
}

pub async fn device_poll(device_code: &str) -> Result<DevicePollOutcome> {
    let client_id = client_id()?;
    let body = format!(
        "client_id={}&device_code={}&grant_type={}",
        urlencoding::encode(client_id),
        urlencoding::encode(device_code),
        urlencoding::encode("urn:ietf:params:oauth:grant-type:device_code"),
    );
    let resp = reqwest::Client::new()
        .post(ACCESS_TOKEN_URL)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", USER_AGENT)
        .body(body)
        .send()
        .await
        .context("轮询 access token 失败")?;

    let parsed: AccessTokenResponse = resp.json().await.context("解析 token 响应失败")?;

    if let Some(token) = parsed.access_token {
        store_token(&token)?;
        let user = fetch_user(&token).await?;
        return Ok(DevicePollOutcome::Authorized {
            login: user.login,
            avatar_url: user.avatar_url,
        });
    }

    match parsed.error.as_deref() {
        Some("authorization_pending") => Ok(DevicePollOutcome::Pending {
            interval: parsed.interval.unwrap_or(5),
        }),
        Some("slow_down") => Ok(DevicePollOutcome::Pending {
            interval: parsed.interval.unwrap_or(10),
        }),
        Some("expired_token") => Ok(DevicePollOutcome::Denied {
            message: "授权码已过期，请重新发起 GitHub 登录。".into(),
        }),
        Some("access_denied") => Ok(DevicePollOutcome::Denied {
            message: "用户在 GitHub 上拒绝了授权请求。".into(),
        }),
        Some(other) => Ok(DevicePollOutcome::Denied {
            message: parsed
                .error_description
                .unwrap_or_else(|| format!("GitHub 返回错误: {other}")),
        }),
        None => Err(anyhow!("GitHub 返回了无法识别的响应")),
    }
}

#[derive(Deserialize)]
struct UserInfo {
    login: String,
    #[serde(default)]
    avatar_url: String,
}

async fn fetch_user(token: &str) -> Result<UserInfo> {
    let resp = reqwest::Client::new()
        .get(format!("{API_BASE}/user"))
        .bearer_auth(token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .send()
        .await
        .context("获取 GitHub 用户信息失败")?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(anyhow!("GET /user 失败 ({status}): {body}"));
    }

    resp.json::<UserInfo>().await.context("解析用户信息失败")
}

#[derive(Serialize, Clone, Debug)]
pub struct OauthStatus {
    pub logged_in: bool,
    pub login: Option<String>,
    pub avatar_url: Option<String>,
}

pub async fn status() -> Result<OauthStatus> {
    let Some(token) = load_token()? else {
        return Ok(OauthStatus {
            logged_in: false,
            login: None,
            avatar_url: None,
        });
    };

    match fetch_user(&token).await {
        Ok(user) => Ok(OauthStatus {
            logged_in: true,
            login: Some(user.login),
            avatar_url: Some(user.avatar_url),
        }),
        Err(e) => {
            // Token invalid (revoked / expired) — drop it so user re-authenticates.
            log::warn!("github token invalid, dropping: {e:#}");
            let _ = delete_token();
            Ok(OauthStatus {
                logged_in: false,
                login: None,
                avatar_url: None,
            })
        }
    }
}

pub fn logout() -> Result<()> {
    delete_token()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct RepoBrief {
    pub full_name: String,
    pub name: String,
    pub owner: String,
    pub private: bool,
    pub default_branch: String,
    pub html_url: String,
}

#[derive(Deserialize)]
struct GhRepo {
    name: String,
    full_name: String,
    private: bool,
    #[serde(default)]
    default_branch: Option<String>,
    html_url: String,
    owner: GhOwner,
}

#[derive(Deserialize)]
struct GhOwner {
    login: String,
}

impl From<GhRepo> for RepoBrief {
    fn from(r: GhRepo) -> Self {
        Self {
            full_name: r.full_name,
            name: r.name,
            owner: r.owner.login,
            private: r.private,
            default_branch: r.default_branch.unwrap_or_else(|| "main".to_string()),
            html_url: r.html_url,
        }
    }
}

pub async fn list_repos() -> Result<Vec<RepoBrief>> {
    let token = load_token()?.ok_or_else(|| anyhow!("尚未连接 GitHub 账号"))?;
    let mut all = Vec::new();
    for page in 1..=5 {
        let resp = reqwest::Client::new()
            .get(format!(
                "{API_BASE}/user/repos?per_page=100&page={page}&sort=updated&affiliation=owner,collaborator"
            ))
            .bearer_auth(&token)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", USER_AGENT)
            .send()
            .await
            .context("拉取仓库列表失败")?;
        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(anyhow!("GET /user/repos 失败 ({status}): {body}"));
        }
        let page_items: Vec<GhRepo> = resp.json().await.context("解析仓库列表失败")?;
        if page_items.is_empty() {
            break;
        }
        let len = page_items.len();
        all.extend(page_items.into_iter().map(RepoBrief::from));
        if len < 100 {
            break;
        }
    }
    Ok(all)
}

#[derive(Serialize)]
struct CreateRepoBody<'a> {
    name: &'a str,
    description: &'a str,
    private: bool,
    auto_init: bool,
}

pub async fn create_repo(name: &str, private: bool) -> Result<RepoBrief> {
    let token = load_token()?.ok_or_else(|| anyhow!("尚未连接 GitHub 账号"))?;
    let body = CreateRepoBody {
        name,
        description: "微信公众号文章归档 · 由 wxmp-cracker 自动生成",
        private,
        auto_init: true,
    };
    let resp = reqwest::Client::new()
        .post(format!("{API_BASE}/user/repos"))
        .bearer_auth(&token)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", USER_AGENT)
        .json(&body)
        .send()
        .await
        .context("创建仓库失败")?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(anyhow!("POST /user/repos 失败 ({status}): {text}"));
    }
    let repo: GhRepo = resp.json().await.context("解析新仓库响应失败")?;
    Ok(repo.into())
}

