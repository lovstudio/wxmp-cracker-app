use anyhow::{anyhow, bail, Context, Result};
use chrono::{DateTime, Utc};
use keyring::Entry;
use reqwest::blocking::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter};

use crate::{archive, db};

const API_BASE: &str = "https://open.feishu.cn/open-apis";
const SETTINGS_FILE: &str = "feishu-integration.json";
const KEYRING_SERVICE: &str = "wxmp-cracker";
const KEYRING_USER: &str = "feishu-app-secret";
const SYNC_PROGRESS_EVENT: &str = "feishu-sync://progress";
const MAX_PAGES: usize = 40;
const MAX_BLOCKS_PER_DOCUMENT: usize = 900;
const BLOCK_BATCH_SIZE: usize = 50;
const TEXT_RUN_CHAR_LIMIT: usize = 1_500;

static STATE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static SYNC_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct PersistedState {
    #[serde(default)]
    app_id: Option<String>,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    auto_sync: bool,
    #[serde(default)]
    space_id: Option<String>,
    #[serde(default)]
    space_name: Option<String>,
    #[serde(default)]
    parent_node_token: Option<String>,
    #[serde(default)]
    parent_node_title: Option<String>,
    #[serde(default)]
    account_fakeids: Vec<String>,
    #[serde(default)]
    last_synced_at: Option<i64>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default)]
    records: HashMap<String, SyncRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct SyncRecord {
    aid: String,
    fakeid: String,
    space_id: String,
    node_token: String,
    document_id: String,
    content_hash: String,
    synced_at: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct SettingsView {
    pub app_id: Option<String>,
    pub has_app_secret: bool,
    pub enabled: bool,
    pub auto_sync: bool,
    pub space_id: Option<String>,
    pub space_name: Option<String>,
    pub parent_node_token: Option<String>,
    pub parent_node_title: Option<String>,
    pub account_fakeids: Vec<String>,
    pub last_synced_at: Option<i64>,
    pub last_error: Option<String>,
    pub synced_article_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
pub struct SettingsInput {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub auto_sync: bool,
    #[serde(default)]
    pub space_id: Option<String>,
    #[serde(default)]
    pub space_name: Option<String>,
    #[serde(default)]
    pub parent_node_token: Option<String>,
    #[serde(default)]
    pub parent_node_title: Option<String>,
    #[serde(default)]
    pub account_fakeids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SpaceBrief {
    pub space_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub space_type: Option<String>,
    #[serde(default)]
    pub visibility: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WikiNodeBrief {
    pub space_id: String,
    pub node_token: String,
    pub obj_token: String,
    pub obj_type: String,
    #[serde(default)]
    pub parent_node_token: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub has_child: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct SyncOptions {
    #[serde(default)]
    pub account_fakeid: Option<String>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct SyncSummary {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub failed: usize,
    pub total: usize,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum SyncProgress {
    Start {
        total: usize,
    },
    Article {
        current: usize,
        total: usize,
        title: String,
    },
    Done {
        created: usize,
        updated: usize,
        skipped: usize,
        failed: usize,
    },
}

struct FeishuClient {
    http: Client,
    token: String,
}

impl FeishuClient {
    fn new(token: String) -> Result<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(35))
            .redirect(reqwest::redirect::Policy::limited(4))
            .user_agent("wxmp-cracker/feishu-integration")
            .build()
            .context("初始化飞书请求失败")?;
        Ok(Self { http, token })
    }

    fn get(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.http.get(url).bearer_auth(&self.token)
    }

    fn post(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.http.post(url).bearer_auth(&self.token)
    }

    fn delete(&self, url: impl reqwest::IntoUrl) -> RequestBuilder {
        self.http.delete(url).bearer_auth(&self.token)
    }

    fn send(&self, request: RequestBuilder, action: &str) -> Result<Value> {
        send_json(request, action)
    }

    fn send_write(&self, request: RequestBuilder, action: &str) -> Result<Value> {
        let value = send_json(request, action)?;
        // Wiki/Docx writes are limited to three requests per second per app.
        thread::sleep(Duration::from_millis(360));
        Ok(value)
    }
}

pub fn settings() -> Result<SettingsView> {
    let state = load_state()?;
    settings_view(&state)
}

pub fn configure_credentials(app_id: &str, app_secret: &str) -> Result<SettingsView> {
    let app_id = normalize_required(app_id, "App ID")?;
    let app_secret = normalize_required(app_secret, "App Secret")?;

    // Validate first so an accidental typo never replaces working credentials.
    tenant_access_token(&app_id, &app_secret)?;
    store_secret(&app_secret)?;

    update_state(|state| {
        if state.app_id.as_deref() != Some(app_id.as_str()) {
            state.records.clear();
            state.space_id = None;
            state.space_name = None;
            state.parent_node_token = None;
            state.parent_node_title = None;
            state.enabled = false;
        }
        state.app_id = Some(app_id);
        state.last_error = None;
        Ok(())
    })?;
    settings()
}

pub fn save_settings(input: SettingsInput) -> Result<SettingsView> {
    let known_accounts = db::list_accounts()?
        .into_iter()
        .map(|account| account.fakeid)
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let account_fakeids = input
        .account_fakeids
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| known_accounts.contains(value) && seen.insert(value.clone()))
        .collect::<Vec<_>>();
    let space_id = normalize_optional(input.space_id);
    let space_name = normalize_optional(input.space_name);
    let parent_node_token = normalize_optional(input.parent_node_token);
    let parent_node_title = normalize_optional(input.parent_node_title);

    if input.enabled {
        let state = load_state()?;
        credentials(&state)?;
        if space_id.is_none() {
            bail!("请先选择要同步到的飞书知识库");
        }
        if account_fakeids.is_empty() {
            bail!("请至少选择一个要同步的公众号");
        }
    }

    update_state(|state| {
        let target_changed =
            state.space_id != space_id || state.parent_node_token != parent_node_token;
        if target_changed {
            state.records.clear();
        }
        state.enabled = input.enabled;
        state.auto_sync = input.auto_sync;
        state.space_id = space_id;
        state.space_name = space_name;
        state.parent_node_token = parent_node_token;
        state.parent_node_title = parent_node_title;
        state.account_fakeids = account_fakeids;
        state.last_error = None;
        Ok(())
    })?;
    settings()
}

pub fn disconnect() -> Result<SettingsView> {
    delete_secret()?;
    save_state(&PersistedState::default())?;
    settings()
}

pub fn list_spaces() -> Result<Vec<SpaceBrief>> {
    let state = load_state()?;
    let (app_id, secret) = credentials(&state)?;
    let client = FeishuClient::new(tenant_access_token(&app_id, &secret)?)?;
    let mut spaces = Vec::new();
    let mut page_token: Option<String> = None;

    for _ in 0..MAX_PAGES {
        let mut url = format!("{API_BASE}/wiki/v2/spaces?page_size=50");
        if let Some(token) = page_token.as_deref() {
            url.push_str("&page_token=");
            url.push_str(&urlencoding::encode(token));
        }
        let value = client.send(client.get(url), "读取飞书知识库列表")?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        let mut page = serde_json::from_value::<Vec<SpaceBrief>>(
            data.get("items").cloned().unwrap_or_else(|| json!([])),
        )
        .context("解析飞书知识库列表失败")?;
        spaces.append(&mut page);
        if !data
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            break;
        }
        page_token = data
            .get("page_token")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if page_token.is_none() {
            break;
        }
    }

    spaces.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(spaces)
}

pub fn resolve_wiki_target(input: &str) -> Result<WikiNodeBrief> {
    let state = load_state()?;
    let (app_id, secret) = credentials(&state)?;
    let token = extract_wiki_token(input)?;
    let client = FeishuClient::new(tenant_access_token(&app_id, &secret)?)?;
    let url = format!(
        "{API_BASE}/wiki/v2/spaces/get_node?token={}",
        urlencoding::encode(&token)
    );
    let value = client.send(client.get(url), "识别飞书知识库页面")?;
    serde_json::from_value(
        value
            .pointer("/data/node")
            .cloned()
            .ok_or_else(|| anyhow!("飞书未返回知识库页面信息"))?,
    )
    .context("解析飞书知识库页面失败")
}

pub fn sync_articles(app: &AppHandle, options: SyncOptions) -> Result<SyncSummary> {
    let _sync_guard = SYNC_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = load_state()?;
    let (app_id, secret) = credentials(&state)?;
    if !state.enabled {
        bail!("飞书同步尚未启用");
    }
    let space_id = state
        .space_id
        .clone()
        .ok_or_else(|| anyhow!("请先选择要同步到的飞书知识库"))?;

    let selected_fakeids = selected_fakeids(&state, options.account_fakeid.as_deref())?;
    let mut candidates = Vec::new();
    for fakeid in selected_fakeids {
        let account =
            db::get_account(&fakeid)?.ok_or_else(|| anyhow!("找不到已选择的公众号：{fakeid}"))?;
        for article in db::list_articles_with_content(Some(&fakeid))? {
            candidates.push((account.clone(), article));
        }
    }
    candidates.sort_by_key(|(_, article)| article.create_time);

    let mut summary = SyncSummary {
        total: candidates.len(),
        ..SyncSummary::default()
    };
    emit_progress(
        app,
        SyncProgress::Start {
            total: summary.total,
        },
    );

    if candidates.is_empty() {
        mark_sync_success(None)?;
        emit_progress(
            app,
            SyncProgress::Done {
                created: 0,
                updated: 0,
                skipped: 0,
                failed: 0,
            },
        );
        return Ok(summary);
    }

    let client = FeishuClient::new(tenant_access_token(&app_id, &secret)?)?;
    for (index, (account, article)) in candidates.iter().enumerate() {
        emit_progress(
            app,
            SyncProgress::Article {
                current: index + 1,
                total: summary.total,
                title: article.title.clone(),
            },
        );
        match sync_article(
            &client,
            &space_id,
            state.parent_node_token.as_deref(),
            account,
            article,
            options.force,
        ) {
            Ok(SyncArticleOutcome::Created) => summary.created += 1,
            Ok(SyncArticleOutcome::Updated) => summary.updated += 1,
            Ok(SyncArticleOutcome::Skipped) => summary.skipped += 1,
            Err(error) => {
                summary.failed += 1;
                let message = format!("{}：{error:#}", article.title);
                summary.last_error = Some(message.clone());
                mark_sync_error(&message)?;
            }
        }
    }

    if summary.failed == 0 {
        mark_sync_success(None)?;
    }
    emit_progress(
        app,
        SyncProgress::Done {
            created: summary.created,
            updated: summary.updated,
            skipped: summary.skipped,
            failed: summary.failed,
        },
    );
    Ok(summary)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SyncArticleOutcome {
    Created,
    Updated,
    Skipped,
}

fn sync_article(
    client: &FeishuClient,
    space_id: &str,
    parent_node_token: Option<&str>,
    account: &db::Account,
    article: &db::ArticleDetail,
    force: bool,
) -> Result<SyncArticleOutcome> {
    let content_hash = article_content_hash(account, article);
    let existing = load_state()?.records.get(&article.aid).cloned();
    if !force
        && existing
            .as_ref()
            .is_some_and(|record| record.content_hash == content_hash)
    {
        return Ok(SyncArticleOutcome::Skipped);
    }

    let (record, created) = if let Some(record) = existing {
        update_wiki_title(client, &record.space_id, &record.node_token, &article.title)?;
        (record, false)
    } else {
        let node = create_wiki_node(
            client,
            space_id,
            parent_node_token,
            truncate_chars(&article.title, 120),
        )?;
        let record = SyncRecord {
            aid: article.aid.clone(),
            fakeid: article.fakeid.clone(),
            space_id: node.space_id.clone(),
            node_token: node.node_token,
            document_id: node.obj_token,
            content_hash: String::new(),
            synced_at: now_timestamp(),
        };
        // Persist immediately so a retry updates this node if writing blocks fails.
        store_record(record.clone())?;
        (record, true)
    };

    replace_document_content(
        client,
        &record.document_id,
        article_blocks(account, article),
    )?;
    let mut completed = record;
    completed.content_hash = content_hash;
    completed.synced_at = now_timestamp();
    store_record(completed)?;
    Ok(if created {
        SyncArticleOutcome::Created
    } else {
        SyncArticleOutcome::Updated
    })
}

fn create_wiki_node(
    client: &FeishuClient,
    space_id: &str,
    parent_node_token: Option<&str>,
    title: String,
) -> Result<WikiNodeBrief> {
    let mut body = json!({
        "obj_type": "docx",
        "node_type": "origin",
        "title": title,
    });
    if let Some(parent) = parent_node_token {
        body["parent_node_token"] = Value::String(parent.to_string());
    }
    let url = format!("{API_BASE}/wiki/v2/spaces/{space_id}/nodes");
    let value = client.send_write(client.post(url).json(&body), "在飞书知识库中创建文章页面")?;
    serde_json::from_value(
        value
            .pointer("/data/node")
            .cloned()
            .ok_or_else(|| anyhow!("飞书未返回新建页面信息"))?,
    )
    .context("解析飞书新建页面失败")
}

fn update_wiki_title(
    client: &FeishuClient,
    space_id: &str,
    node_token: &str,
    title: &str,
) -> Result<()> {
    let url = format!("{API_BASE}/wiki/v2/spaces/{space_id}/nodes/{node_token}/update_title");
    client.send_write(
        client
            .post(url)
            .json(&json!({ "title": truncate_chars(title, 120) })),
        "更新飞书文章页面标题",
    )?;
    Ok(())
}

fn replace_document_content(
    client: &FeishuClient,
    document_id: &str,
    blocks: Vec<Value>,
) -> Result<()> {
    let child_count = document_child_count(client, document_id)?;
    if child_count > 0 {
        let url = format!(
            "{API_BASE}/docx/v1/documents/{document_id}/blocks/{document_id}/children/batch_delete"
        );
        client.send_write(
            client.delete(url).json(&json!({
                "start_index": 0,
                "end_index": child_count,
            })),
            "清理飞书文章页面旧内容",
        )?;
    }

    let url = format!("{API_BASE}/docx/v1/documents/{document_id}/blocks/{document_id}/children");
    for chunk in blocks.chunks(BLOCK_BATCH_SIZE) {
        client.send_write(
            client.post(&url).json(&json!({
                "children": chunk,
            })),
            "写入飞书文章页面内容",
        )?;
    }
    Ok(())
}

fn document_child_count(client: &FeishuClient, document_id: &str) -> Result<usize> {
    let mut total = 0;
    let mut page_token: Option<String> = None;
    for _ in 0..MAX_PAGES {
        let mut url = format!(
            "{API_BASE}/docx/v1/documents/{document_id}/blocks/{document_id}/children?page_size=500"
        );
        if let Some(token) = page_token.as_deref() {
            url.push_str("&page_token=");
            url.push_str(&urlencoding::encode(token));
        }
        let value = client.send(client.get(url), "读取飞书文章页面内容")?;
        let data = value.get("data").cloned().unwrap_or(Value::Null);
        total += data
            .get("items")
            .and_then(Value::as_array)
            .map(Vec::len)
            .unwrap_or(0);
        if !data
            .get("has_more")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            break;
        }
        page_token = data
            .get("page_token")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned);
        if page_token.is_none() {
            break;
        }
    }
    Ok(total)
}

fn article_blocks(account: &db::Account, article: &db::ArticleDetail) -> Vec<Value> {
    let mut blocks = vec![heading_block(2, "文章信息")];
    blocks.push(field_block("公众号", &account.nickname));
    if let Some(author) = article
        .author
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        blocks.push(field_block("作者", author));
    }
    blocks.push(field_block(
        "发布时间",
        &format_timestamp(article.create_time),
    ));
    blocks.push(link_field_block("原文链接", &article.link));
    blocks.push(field_block("文章 ID", &article.aid));
    if let Some(digest) = article
        .digest
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        blocks.push(field_block("摘要", digest));
    }
    blocks.push(heading_block(2, "正文"));
    blocks.extend(markdown_blocks(
        article.content_md.as_deref().unwrap_or_default(),
    ));
    blocks.push(text_block(vec![text_run(
        "由微探自动同步",
        Some(json!({ "italic": true })),
    )]));

    if blocks.len() > MAX_BLOCKS_PER_DOCUMENT {
        blocks.truncate(MAX_BLOCKS_PER_DOCUMENT - 1);
        blocks.push(text_block(vec![text_run(
            "正文过长，已达到飞书单文档块数量上限；完整内容仍保存在微探本地缓存中。",
            Some(json!({ "italic": true })),
        )]));
    }
    blocks
}

fn markdown_blocks(markdown: &str) -> Vec<Value> {
    let mut blocks = Vec::new();
    let mut paragraph = Vec::new();
    let mut code = Vec::new();
    let mut in_code = false;

    let flush_paragraph = |paragraph: &mut Vec<String>, blocks: &mut Vec<Value>| {
        if paragraph.is_empty() {
            return;
        }
        let joined = paragraph.join("\n");
        for chunk in split_chars(&joined, TEXT_RUN_CHAR_LIMIT) {
            blocks.push(text_block(vec![text_run(&chunk, None)]));
        }
        paragraph.clear();
    };
    let flush_code = |code: &mut Vec<String>, blocks: &mut Vec<Value>| {
        if code.is_empty() {
            return;
        }
        let joined = code.join("\n");
        for chunk in split_chars(&joined, TEXT_RUN_CHAR_LIMIT) {
            blocks.push(text_block(vec![text_run(
                &chunk,
                Some(json!({ "inline_code": true })),
            )]));
        }
        code.clear();
    };

    for line in markdown.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            if in_code {
                flush_code(&mut code, &mut blocks);
                in_code = false;
            } else {
                flush_paragraph(&mut paragraph, &mut blocks);
                in_code = true;
            }
            continue;
        }
        if in_code {
            code.push(line.to_string());
            continue;
        }
        if trimmed.is_empty() {
            flush_paragraph(&mut paragraph, &mut blocks);
            continue;
        }
        if let Some((level, title)) = markdown_heading(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(heading_block(level, title));
            continue;
        }
        if let Some(item) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(list_block("bullet", 12, item));
            continue;
        }
        if let Some(item) = ordered_list_item(trimmed) {
            flush_paragraph(&mut paragraph, &mut blocks);
            blocks.push(list_block("ordered", 13, item));
            continue;
        }
        paragraph.push(trimmed.to_string());
    }
    flush_paragraph(&mut paragraph, &mut blocks);
    flush_code(&mut code, &mut blocks);
    if blocks.is_empty() {
        blocks.push(text_block(vec![text_run(
            "正文尚未提供 Markdown 内容。",
            None,
        )]));
    }
    blocks
}

fn markdown_heading(line: &str) -> Option<(usize, &str)> {
    let hashes = line
        .chars()
        .take_while(|character| *character == '#')
        .count();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let title = line.get(hashes..)?.trim();
    (!title.is_empty()).then_some((hashes, title))
}

fn ordered_list_item(line: &str) -> Option<&str> {
    let (prefix, rest) = line.split_once(". ")?;
    (!prefix.is_empty() && prefix.bytes().all(|byte| byte.is_ascii_digit())).then_some(rest)
}

fn heading_block(level: usize, content: &str) -> Value {
    let level = level.clamp(1, 6);
    let key = format!("heading{level}");
    let mut block = serde_json::Map::new();
    block.insert("block_type".to_string(), json!(level + 2));
    block.insert(
        key,
        json!({ "elements": [text_run(&truncate_chars(content, 1_000), None)] }),
    );
    Value::Object(block)
}

fn list_block(kind: &str, block_type: usize, content: &str) -> Value {
    let mut block = serde_json::Map::new();
    block.insert("block_type".to_string(), json!(block_type));
    block.insert(
        kind.to_string(),
        json!({ "elements": [text_run(&truncate_chars(content, TEXT_RUN_CHAR_LIMIT), None)] }),
    );
    Value::Object(block)
}

fn field_block(label: &str, value: &str) -> Value {
    text_block(vec![
        text_run(&format!("{label}："), Some(json!({ "bold": true }))),
        text_run(&truncate_chars(value, TEXT_RUN_CHAR_LIMIT), None),
    ])
}

fn link_field_block(label: &str, url: &str) -> Value {
    text_block(vec![
        text_run(&format!("{label}："), Some(json!({ "bold": true }))),
        text_run(
            &truncate_chars(url, TEXT_RUN_CHAR_LIMIT),
            Some(json!({ "link": { "url": url } })),
        ),
    ])
}

fn text_block(elements: Vec<Value>) -> Value {
    json!({
        "block_type": 2,
        "text": { "elements": elements },
    })
}

fn text_run(content: &str, style: Option<Value>) -> Value {
    let mut run = json!({ "content": content });
    if let Some(style) = style {
        run["text_element_style"] = style;
    }
    json!({ "text_run": run })
}

fn article_content_hash(account: &db::Account, article: &db::ArticleDetail) -> String {
    archive::sha256_hex(
        &json!({
            "account": account.nickname,
            "title": article.title,
            "link": article.link,
            "digest": article.digest,
            "author": article.author,
            "create_time": article.create_time,
            "content_md": article.content_md,
        })
        .to_string(),
    )
}

fn selected_fakeids(state: &PersistedState, requested: Option<&str>) -> Result<Vec<String>> {
    if state.account_fakeids.is_empty() {
        bail!("请至少选择一个要同步的公众号");
    }
    if let Some(requested) = requested.map(str::trim).filter(|value| !value.is_empty()) {
        if state
            .account_fakeids
            .iter()
            .any(|fakeid| fakeid == requested)
        {
            return Ok(vec![requested.to_string()]);
        }
        return Ok(Vec::new());
    }
    Ok(state.account_fakeids.clone())
}

fn settings_view(state: &PersistedState) -> Result<SettingsView> {
    Ok(SettingsView {
        app_id: state.app_id.clone(),
        has_app_secret: load_secret()?.is_some(),
        enabled: state.enabled,
        auto_sync: state.auto_sync,
        space_id: state.space_id.clone(),
        space_name: state.space_name.clone(),
        parent_node_token: state.parent_node_token.clone(),
        parent_node_title: state.parent_node_title.clone(),
        account_fakeids: state.account_fakeids.clone(),
        last_synced_at: state.last_synced_at,
        last_error: state.last_error.clone(),
        synced_article_count: state
            .records
            .values()
            .filter(|record| !record.content_hash.is_empty())
            .count(),
    })
}

fn credentials(state: &PersistedState) -> Result<(String, String)> {
    let app_id = state
        .app_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("请先配置飞书 App ID"))?;
    let secret = load_secret()?.ok_or_else(|| anyhow!("请先配置飞书 App Secret"))?;
    Ok((app_id, secret))
}

fn tenant_access_token(app_id: &str, app_secret: &str) -> Result<String> {
    let http = Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("wxmp-cracker/feishu-integration")
        .build()
        .context("初始化飞书鉴权请求失败")?;
    let value = send_json(
        http.post(format!("{API_BASE}/auth/v3/tenant_access_token/internal"))
            .json(&json!({ "app_id": app_id, "app_secret": app_secret })),
        "验证飞书应用凭证",
    )?;
    value
        .get("tenant_access_token")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("飞书未返回 tenant_access_token"))
}

fn send_json(request: RequestBuilder, action: &str) -> Result<Value> {
    let response = request
        .send()
        .with_context(|| format!("{action}失败，请检查网络"))?;
    let status = response.status();
    let request_id = response
        .headers()
        .get("x-tt-logid")
        .and_then(|value| value.to_str().ok())
        .map(ToOwned::to_owned);
    let body = response.text().context("读取飞书响应失败")?;
    let value: Value = serde_json::from_str(&body)
        .with_context(|| format!("{action}返回了无法解析的响应（HTTP {status}）"))?;
    let code = value.get("code").and_then(Value::as_i64).unwrap_or(0);
    if !status.is_success() || code != 0 {
        let message = value
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("未知错误");
        let request_id = request_id
            .map(|value| format!("，Log ID: {value}"))
            .unwrap_or_default();
        bail!("{action}失败（HTTP {status}，code {code}）：{message}{request_id}");
    }
    Ok(value)
}

fn state_path() -> Result<PathBuf> {
    Ok(archive::data_root()?.join(SETTINGS_FILE))
}

fn load_state() -> Result<PersistedState> {
    let _guard = STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    load_state_unlocked()
}

fn load_state_unlocked() -> Result<PersistedState> {
    let path = state_path()?;
    if !path.exists() {
        return Ok(PersistedState::default());
    }
    let raw = fs::read_to_string(&path).with_context(|| format!("读取 {path:?}"))?;
    serde_json::from_str(&raw).with_context(|| format!("解析 {path:?}"))
}

fn save_state(state: &PersistedState) -> Result<()> {
    let _guard = STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    save_state_unlocked(state)
}

fn save_state_unlocked(state: &PersistedState) -> Result<()> {
    let path = state_path()?;
    let parent = path.parent().context("飞书设置路径缺少父目录")?;
    fs::create_dir_all(parent).with_context(|| format!("创建 {parent:?}"))?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_string_pretty(state)?)
        .with_context(|| format!("写入 {temporary:?}"))?;
    fs::rename(&temporary, &path).with_context(|| format!("保存 {path:?}"))?;
    Ok(())
}

fn update_state(update: impl FnOnce(&mut PersistedState) -> Result<()>) -> Result<()> {
    let _guard = STATE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut state = load_state_unlocked()?;
    update(&mut state)?;
    save_state_unlocked(&state)
}

fn store_record(record: SyncRecord) -> Result<()> {
    update_state(|state| {
        state.records.insert(record.aid.clone(), record);
        Ok(())
    })
}

fn mark_sync_success(error: Option<String>) -> Result<()> {
    update_state(|state| {
        state.last_synced_at = Some(now_timestamp());
        state.last_error = error;
        Ok(())
    })
}

fn mark_sync_error(error: &str) -> Result<()> {
    update_state(|state| {
        state.last_error = Some(error.to_string());
        Ok(())
    })
}

fn secret_entry() -> Result<Entry> {
    Entry::new(KEYRING_SERVICE, KEYRING_USER).context("打开系统钥匙串失败")
}

fn load_secret() -> Result<Option<String>> {
    match secret_entry()?.get_password() {
        Ok(value) if value.trim().is_empty() => Ok(None),
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow!(error)).context("读取飞书 App Secret 失败"),
    }
}

fn store_secret(secret: &str) -> Result<()> {
    secret_entry()?
        .set_password(secret)
        .context("将飞书 App Secret 写入系统钥匙串失败")
}

fn delete_secret() -> Result<()> {
    match secret_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!(error)).context("删除飞书 App Secret 失败"),
    }
}

fn normalize_required(value: &str, label: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{label} 不能为空");
    }
    if value.chars().count() > 256 {
        bail!("{label} 长度异常");
    }
    Ok(value.to_string())
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn extract_wiki_token(input: &str) -> Result<String> {
    let input = input.trim();
    if input.is_empty() {
        bail!("请输入飞书知识库页面链接或 Wiki Token");
    }
    let candidate = input
        .split("/wiki/")
        .nth(1)
        .unwrap_or(input)
        .split(['?', '#', '/'])
        .next()
        .unwrap_or_default()
        .trim();
    if candidate.is_empty()
        || candidate.chars().count() > 200
        || !candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        bail!("无法从输入中识别有效的飞书 Wiki Token");
    }
    Ok(candidate.to_string())
}

fn format_timestamp(timestamp: i64) -> String {
    DateTime::<Utc>::from_timestamp(timestamp, 0)
        .map(|value| value.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_else(|| timestamp.to_string())
}

fn split_chars(value: &str, limit: usize) -> Vec<String> {
    if value.is_empty() {
        return Vec::new();
    }
    let chars = value.chars().collect::<Vec<_>>();
    chars
        .chunks(limit)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect()
}

fn truncate_chars(value: &str, limit: usize) -> String {
    let mut chars = value.chars();
    let mut output = chars.by_ref().take(limit).collect::<String>();
    if chars.next().is_some() {
        output.push('…');
    }
    output
}

fn now_timestamp() -> i64 {
    Utc::now().timestamp()
}

fn emit_progress(app: &AppHandle, progress: SyncProgress) {
    let _ = app.emit(SYNC_PROGRESS_EVENT, progress);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account() -> db::Account {
        db::Account {
            fakeid: "account-1".into(),
            nickname: "手工川".into(),
            alias: None,
            signature: None,
            avatar: None,
            article_count: 1,
        }
    }

    fn article(markdown: &str) -> db::ArticleDetail {
        db::ArticleDetail {
            aid: "article-1".into(),
            fakeid: "account-1".into(),
            title: "一篇测试文章".into(),
            link: "https://mp.weixin.qq.com/s/test".into(),
            digest: Some("摘要".into()),
            cover: None,
            author: Some("作者".into()),
            create_time: 1_700_000_000,
            has_content: true,
            article_type: None,
            copyright_type: None,
            content_html: None,
            content_md: Some(markdown.into()),
        }
    }

    #[test]
    fn extracts_wiki_tokens_from_urls_and_raw_values() {
        assert_eq!(
            extract_wiki_token("https://example.feishu.cn/wiki/wikcnABC123?from=copy").unwrap(),
            "wikcnABC123"
        );
        assert_eq!(extract_wiki_token("wikcnABC123").unwrap(), "wikcnABC123");
        assert!(extract_wiki_token("https://example.feishu.cn/docx/doccn123").is_err());
    }

    #[test]
    fn markdown_is_converted_to_readable_docx_blocks() {
        let blocks = article_blocks(
            &account(),
            &article("# 章节\n\n第一段\n\n- 要点\n1. 步骤\n```rs\nfn main() {}\n```"),
        );
        assert_eq!(blocks[0]["block_type"], 4);
        assert!(blocks.iter().any(|block| block["block_type"] == 3));
        assert!(blocks.iter().any(|block| block["block_type"] == 12));
        assert!(blocks.iter().any(|block| block["block_type"] == 13));
        let body = serde_json::to_string(&blocks).unwrap();
        assert!(body.contains("https://mp.weixin.qq.com/s/test"));
        assert!(body.contains("fn main() {}"));
    }

    #[test]
    fn content_hash_changes_with_article_or_account_metadata() {
        let first = article_content_hash(&account(), &article("正文"));
        let second = article_content_hash(&account(), &article("更新后的正文"));
        let mut renamed = account();
        renamed.nickname = "新名称".into();
        let third = article_content_hash(&renamed, &article("正文"));
        assert_ne!(first, second);
        assert_ne!(first, third);
    }

    #[test]
    fn long_text_is_split_below_feishu_run_limit() {
        let content = "长".repeat(TEXT_RUN_CHAR_LIMIT * 2 + 7);
        let blocks = markdown_blocks(&content);
        assert_eq!(blocks.len(), 3);
        for block in blocks {
            let text = block["text"]["elements"][0]["text_run"]["content"]
                .as_str()
                .unwrap();
            assert!(text.chars().count() <= TEXT_RUN_CHAR_LIMIT);
        }
    }
}
