use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

type HmacSha256 = Hmac<Sha256>;

const CODE_PREFIX: &str = "WXMP";
const ACTIVATION_SECRET: &str = env!("WXMP_ACTIVATION_SECRET");
const DEFAULT_SUPABASE_URL: &str = "https://mgfhqkixkjjwqwqrgvpg.supabase.co";
const DEFAULT_SUPABASE_PUBLISHABLE_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1nZmhxa2l4a2pqd3F3cXJndnBnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzYxNjg3ODYsImV4cCI6MjA1MTc0NDc4Nn0.KFMgbcZKiPqGPnNnrQjvIBVcKEKP8SPy-728FqJU2rI";
const LICENSE_FILE_NAME: &str = "license.json";
const OFFICIAL_DAYS: i64 = 365;
const TRIAL_DAYS: i64 = 7;
const SECONDS_PER_DAY: i64 = 86_400;

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LicenseKind {
    Trial,
    Official,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LicenseStatus {
    pub active: bool,
    pub kind: Option<LicenseKind>,
    pub activated_at: Option<i64>,
    pub expires_at: Option<i64>,
    pub days_remaining: Option<i64>,
    pub customer: Option<String>,
    pub license_id: Option<String>,
    pub account_id: Option<String>,
    pub current_account_id: Option<String>,
    pub message: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ActivationPayload {
    v: u8,
    kind: LicenseKind,
    account_id: String,
    issued_at: i64,
    #[serde(default)]
    customer: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct LicenseRecord {
    v: u8,
    code_hash: String,
    account_id: String,
    kind: LicenseKind,
    activated_at: i64,
    expires_at: i64,
    issued_at: i64,
    #[serde(default)]
    customer: Option<String>,
    #[serde(default)]
    trial_used: bool,
    #[serde(default)]
    signature: String,
}

#[derive(Deserialize, Debug, Clone)]
struct RemoteLicenseRow {
    id: String,
    account_id: String,
    kind: LicenseKind,
    expires_at_epoch: i64,
    #[serde(default)]
    customer: Option<String>,
}

pub fn status(current_account_id: Option<&str>) -> Result<LicenseStatus> {
    let now = current_unix_timestamp();
    let current_account_id = current_account_id.map(ToOwned::to_owned);
    match read_license() {
        Ok(Some(record)) => Ok(status_from_record(
            &record,
            now,
            current_account_id.as_deref(),
        )),
        Ok(None) => Ok(inactive_status(
            "尚未激活，请先登录 Lovstudio 账号，再输入对应账号的激活码或等待远程授权自动同步。",
            current_account_id,
        )),
        Err(e) => {
            log::warn!("invalid license file: {e:?}");
            Ok(inactive_status(
                "授权文件无效或已被修改，请重新激活。",
                current_account_id,
            ))
        }
    }
}

pub fn activate(code: &str, current_account_id: &str) -> Result<LicenseStatus> {
    let normalized_code = normalize_code(code)?;
    let current_account_id = normalize_account_id(current_account_id)?;
    let payload = parse_activation_code(&normalized_code)?;
    if normalize_account_id(&payload.account_id)? != current_account_id {
        return Err(anyhow!(
            "激活码绑定 Lovstudio 账号为 {}，当前 Lovstudio 账号为 {}，请切换到对应账号后再激活。",
            payload.account_id,
            current_account_id
        ));
    }

    let current = match read_license() {
        Ok(record) => record,
        Err(e) => {
            log::warn!("invalid license file ignored during activation: {e:?}");
            None
        }
    };
    let now = current_unix_timestamp();
    let next_code_hash = code_hash(&normalized_code);

    if let Some(record) = current.as_ref() {
        if record.code_hash == next_code_hash {
            return Ok(status_from_record(
                record,
                now,
                Some(current_account_id.as_str()),
            ));
        }

        if record.kind == LicenseKind::Official
            && record.expires_at > now
            && payload.kind == LicenseKind::Trial
            && record.account_id == current_account_id
        {
            return Err(anyhow!("当前正式授权仍有效，无需使用试用激活码。"));
        }

        if payload.kind == LicenseKind::Trial && record.trial_used {
            return Err(anyhow!("本机已使用过试用授权，请使用正式激活码。"));
        }
    }

    let duration_days = match payload.kind {
        LicenseKind::Trial => TRIAL_DAYS,
        LicenseKind::Official => OFFICIAL_DAYS,
    };
    let expires_at = now
        .checked_add(duration_days * SECONDS_PER_DAY)
        .ok_or_else(|| anyhow!("授权到期时间计算失败"))?;
    let trial_used = payload.kind == LicenseKind::Trial
        || current.as_ref().is_some_and(|record| record.trial_used);
    let record = LicenseRecord {
        v: 1,
        code_hash: next_code_hash,
        account_id: current_account_id.clone(),
        kind: payload.kind,
        activated_at: now,
        expires_at,
        issued_at: payload.issued_at,
        customer: payload.customer,
        trial_used,
        signature: String::new(),
    };

    write_license(&record)?;
    Ok(status_from_record(
        &record,
        now,
        Some(current_account_id.as_str()),
    ))
}

pub async fn sync_remote(current_account_id: &str) -> Result<LicenseStatus> {
    let current_account_id = normalize_account_id(current_account_id)?;
    let remote = fetch_remote_license(&current_account_id).await?;

    let Some(remote) = remote else {
        return status(Some(current_account_id.as_str()));
    };

    install_remote_license(remote, &current_account_id)
}

fn install_remote_license(
    remote: RemoteLicenseRow,
    current_account_id: &str,
) -> Result<LicenseStatus> {
    let remote_account_id = normalize_account_id(&remote.account_id)?;
    if remote_account_id != current_account_id {
        return Err(anyhow!("远程授权 Lovstudio 账号与当前账号不匹配。"));
    }

    let now = current_unix_timestamp();
    if remote.expires_at_epoch <= now {
        return status(Some(current_account_id));
    }

    let current = match read_license() {
        Ok(record) => record,
        Err(e) => {
            log::warn!("invalid license file ignored during remote sync: {e:?}");
            None
        }
    };

    if let Some(record) = current.as_ref() {
        let local_status = status_from_record(record, now, Some(current_account_id));

        if local_status.active {
            let remote_is_upgrade = remote.expires_at_epoch > record.expires_at
                || (remote.kind == LicenseKind::Official && record.kind == LicenseKind::Trial);
            let remote_is_downgrade =
                record.kind == LicenseKind::Official && remote.kind == LicenseKind::Trial;

            if !remote_is_upgrade || remote_is_downgrade {
                return Ok(local_status);
            }
        }
    }

    let trial_used = remote.kind == LicenseKind::Trial
        || current.as_ref().is_some_and(|record| record.trial_used);
    let source = format!(
        "remote:{}:{}:{}",
        remote.id, current_account_id, remote.expires_at_epoch
    );
    let record = LicenseRecord {
        v: 1,
        code_hash: code_hash(&source),
        account_id: current_account_id.to_string(),
        kind: remote.kind,
        activated_at: now,
        expires_at: remote.expires_at_epoch,
        issued_at: now,
        customer: remote
            .customer
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        trial_used,
        signature: String::new(),
    };

    write_license(&record)?;
    Ok(status_from_record(&record, now, Some(current_account_id)))
}

async fn fetch_remote_license(account_id: &str) -> Result<Option<RemoteLicenseRow>> {
    let url = supabase_url();
    let key = supabase_publishable_key();
    if url.trim().is_empty() || key.trim().is_empty() {
        return Err(anyhow!("未配置远程授权服务。"));
    }

    let endpoint = format!("{}/rest/v1/rpc/get_wxmp_license", url.trim_end_matches('/'));
    let response = reqwest::Client::new()
        .post(endpoint)
        .header("apikey", key.as_str())
        .bearer_auth(key.as_str())
        .header("Content-Type", "application/json")
        .json(&serde_json::json!({ "_account_id": account_id }))
        .send()
        .await
        .context("连接远程授权服务失败")?;

    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(anyhow!(
            "远程授权服务返回异常（{}）：{}",
            status.as_u16(),
            body
        ));
    }

    let rows: Vec<RemoteLicenseRow> =
        serde_json::from_str(&body).context("解析远程授权结果失败")?;
    Ok(rows.into_iter().next())
}

fn supabase_url() -> String {
    env::var("VITE_LOVSTUDIO_SUPABASE_URL")
        .or_else(|_| env::var("VITE_SUPABASE_URL"))
        .unwrap_or_else(|_| DEFAULT_SUPABASE_URL.to_string())
}

fn supabase_publishable_key() -> String {
    env::var("VITE_SUPABASE_PUBLISHABLE_KEY")
        .unwrap_or_else(|_| DEFAULT_SUPABASE_PUBLISHABLE_KEY.to_string())
}

fn parse_activation_code(code: &str) -> Result<ActivationPayload> {
    let parts: Vec<&str> = code.split('.').collect();
    if parts.len() != 4 || !parts[0].eq_ignore_ascii_case(CODE_PREFIX) {
        return Err(anyhow!("激活码格式不正确。"));
    }

    let kind_hint = match parts[1].to_ascii_uppercase().as_str() {
        "TRIAL" => LicenseKind::Trial,
        "OFFICIAL" => LicenseKind::Official,
        _ => return Err(anyhow!("激活码类型不正确。")),
    };
    let payload_b64 = parts[2];
    let signature = URL_SAFE_NO_PAD
        .decode(parts[3])
        .map_err(|_| anyhow!("激活码签名格式不正确。"))?;

    let mut mac = HmacSha256::new_from_slice(ACTIVATION_SECRET.as_bytes())
        .map_err(|_| anyhow!("激活码校验器初始化失败"))?;
    mac.update(payload_b64.as_bytes());
    mac.verify_slice(&signature)
        .map_err(|_| anyhow!("激活码无效或已被篡改。"))?;

    let payload_json = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .map_err(|_| anyhow!("激活码内容格式不正确。"))?;
    let payload: ActivationPayload =
        serde_json::from_slice(&payload_json).context("解析激活码内容失败")?;

    if payload.v != 1 {
        return Err(anyhow!("激活码版本不支持。"));
    }

    if normalize_account_id(&payload.account_id).is_err() {
        return Err(anyhow!("激活码缺少绑定账号 ID。"));
    }

    if payload.kind != kind_hint {
        return Err(anyhow!("激活码类型与内容不匹配。"));
    }

    Ok(payload)
}

fn status_from_record(
    record: &LicenseRecord,
    now: i64,
    current_account_id: Option<&str>,
) -> LicenseStatus {
    let not_expired = record.expires_at > now;
    let account_matches = current_account_id.is_some_and(|id| id == record.account_id);
    let active = not_expired && account_matches;
    let days_remaining = if not_expired {
        Some(((record.expires_at - now) + SECONDS_PER_DAY - 1) / SECONDS_PER_DAY)
    } else {
        Some(0)
    };
    let kind_label = match record.kind {
        LicenseKind::Trial => "试用授权",
        LicenseKind::Official => "正式授权",
    };
    let message = if !not_expired {
        format!("{kind_label}已过期，请输入新的正式激活码。")
    } else if current_account_id.is_none() {
        format!(
            "{kind_label}已绑定 Lovstudio 账号 {}，请先登录该账号。",
            record.account_id
        )
    } else if !account_matches {
        format!(
            "{kind_label}已绑定 Lovstudio 账号 {}，当前账号无权使用。",
            record.account_id
        )
    } else {
        format!(
            "{kind_label}有效，剩余 {} 天。",
            days_remaining.unwrap_or_default()
        )
    };

    LicenseStatus {
        active,
        kind: Some(record.kind),
        activated_at: Some(record.activated_at),
        expires_at: Some(record.expires_at),
        days_remaining,
        customer: record.customer.clone(),
        license_id: Some(short_license_id(&record.code_hash)),
        account_id: Some(record.account_id.clone()),
        current_account_id: current_account_id.map(ToOwned::to_owned),
        message,
    }
}

fn inactive_status(message: &str, current_account_id: Option<String>) -> LicenseStatus {
    LicenseStatus {
        active: false,
        kind: None,
        activated_at: None,
        expires_at: None,
        days_remaining: None,
        customer: None,
        license_id: None,
        account_id: None,
        current_account_id,
        message: message.to_string(),
    }
}

fn normalize_code(code: &str) -> Result<String> {
    let normalized = code.split_whitespace().collect::<String>();
    if normalized.is_empty() {
        return Err(anyhow!("请输入激活码。"));
    }
    Ok(normalized)
}

fn normalize_account_id(account_id: &str) -> Result<String> {
    let normalized = account_id.trim().to_string();
    if normalized.is_empty() {
        return Err(anyhow!(
            "请先登录 Lovstudio 账号，且该账号需要能识别到用户 ID。"
        ));
    }
    Ok(normalized)
}

fn read_license() -> Result<Option<LicenseRecord>> {
    let path = license_path()?;
    if !path.exists() {
        return Ok(None);
    }

    let data = fs::read_to_string(&path).with_context(|| format!("读取授权文件 {:?}", path))?;
    let record = serde_json::from_str(&data).with_context(|| format!("解析授权文件 {:?}", path))?;
    verify_license_record(&record)?;
    Ok(Some(record))
}

fn write_license(record: &LicenseRecord) -> Result<()> {
    let path = license_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("创建授权目录 {:?}", parent))?;
    }
    let mut signed_record = record.clone();
    signed_record.signature = sign_license_record(&signed_record)?;
    let json = serde_json::to_string_pretty(&signed_record)?;
    fs::write(&path, json).with_context(|| format!("写入授权文件 {:?}", path))?;
    Ok(())
}

fn license_path() -> Result<PathBuf> {
    let base = dirs::data_dir().context("no data dir")?;
    Ok(base.join("wxmp-cracker").join(LICENSE_FILE_NAME))
}

fn code_hash(code: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(code.as_bytes()))
}

fn short_license_id(code_hash: &str) -> String {
    code_hash.chars().take(12).collect()
}

fn verify_license_record(record: &LicenseRecord) -> Result<()> {
    if record.signature.trim().is_empty() {
        return Err(anyhow!("授权文件缺少签名，请重新激活。"));
    }

    let signature = URL_SAFE_NO_PAD
        .decode(&record.signature)
        .map_err(|_| anyhow!("授权文件签名格式不正确，请重新激活。"))?;
    let mac = license_record_mac(record)?;
    mac.verify_slice(&signature)
        .map_err(|_| anyhow!("授权文件已被修改，请重新激活。"))?;

    Ok(())
}

fn sign_license_record(record: &LicenseRecord) -> Result<String> {
    let bytes = license_record_mac(record)?.finalize().into_bytes();
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn license_record_mac(record: &LicenseRecord) -> Result<HmacSha256> {
    let body = serde_json::to_vec(&(
        record.v,
        &record.code_hash,
        &record.account_id,
        record.kind,
        record.activated_at,
        record.expires_at,
        record.issued_at,
        &record.customer,
        record.trial_used,
    ))?;
    let mut mac = HmacSha256::new_from_slice(ACTIVATION_SECRET.as_bytes())
        .map_err(|_| anyhow!("授权文件校验器初始化失败"))?;
    mac.update(b"license-record-v1:");
    mac.update(&body);
    Ok(mac)
}

fn current_unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}
