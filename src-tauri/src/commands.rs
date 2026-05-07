use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
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

#[derive(Deserialize, Serialize)]
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
pub fn get_article(aid: String) -> Result<Option<ArticleDetail>, CmdError> {
    db::get_article(&aid).map_err(Into::into)
}

#[tauri::command]
pub fn cache_db_path() -> Result<String, CmdError> {
    db::cache_db_path()
        .map(|p| p.display().to_string())
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

    tauri::async_runtime::spawn_blocking(move || {
        let wcx = locate_wcx().map_err(|message| CmdError { message })?;
        let mut cmd = python_command_from_wcx(&wcx).map_err(|message| CmdError { message })?;
        cmd.arg("-c").arg(SEARCH_ACCOUNTS_PY).arg(&query);

        let output = cmd.output().map_err(|e| CmdError {
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
    })
    .await
    .map_err(|e| CmdError {
        message: format!("wcx search 任务失败: {e}"),
    })?
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
) -> Result<FetchAccountResult, CmdError> {
    if account.fakeid.trim().is_empty() || account.nickname.trim().is_empty() {
        return Err(CmdError {
            message: "请选择一个有效的公众号".to_string(),
        });
    }

    let limit = limit.unwrap_or(20).clamp(1, 500);

    tauri::async_runtime::spawn_blocking(move || {
        emit_fetch_progress(
            &app,
            fetch_progress(
                &account,
                "prepare",
                "running",
                "正在启动抓取任务",
                None,
                Some(limit),
                None,
            ),
        );

        let wcx = locate_wcx().map_err(|message| CmdError { message })?;
        let account_json = serde_json::to_string(&account).map_err(|e| CmdError {
            message: format!("序列化公众号选择失败: {e}"),
        })?;
        let mut cmd = python_command_from_wcx(&wcx).map_err(|message| CmdError { message })?;
        cmd.arg("-c")
            .arg(FETCH_SELECTED_ACCOUNT_PY)
            .arg(account_json)
            .arg(limit.to_string())
            .arg(if with_content { "1" } else { "0" });

        run_fetch_progress_command(&app, &account, cmd)
    })
    .await
    .map_err(|e| CmdError {
        message: format!("wcx 精确抓取任务失败: {e}"),
    })?
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
            let limit = db::article_fetch_limit(&article.aid, &article.fakeid)
                .map_err(CmdError::from)?
                .ok_or_else(|| CmdError {
                    message: "无法计算当前文章的补抓位置".to_string(),
                })?;
            run_wcx_fetch_content(&wcx, &article.fakeid, limit)?;
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

fn locate_wcx() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(bin) = env::var("WCX_BIN") {
        candidates.push(PathBuf::from(bin));
    }

    if let Some(home) = dirs::home_dir() {
        candidates.push(home.join(".local/bin/wcx"));
    }

    candidates.push(PathBuf::from("/opt/homebrew/bin/wcx"));
    candidates.push(PathBuf::from("/usr/local/bin/wcx"));
    candidates.push(PathBuf::from("wcx"));

    for candidate in candidates {
        if matches!(
            Command::new(&candidate).arg("--version").output(),
            Ok(output) if output.status.success()
        ) {
            return Ok(resolve_executable(&candidate).unwrap_or(candidate));
        }
    }

    Err("未找到 wcx，请先安装并确保 wcx 在 PATH 或 ~/.local/bin/wcx".to_string())
}

fn fetch_single_article_content(wcx: &Path, link: &str) -> Result<ArticleContentPayload, String> {
    let mut cmd = python_command_from_wcx(wcx)?;
    cmd.arg("-c").arg(FETCH_ARTICLE_PY).arg(link);

    let output = cmd
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

fn run_wcx_fetch_content(wcx: &Path, fakeid: &str, limit: u32) -> Result<(), CmdError> {
    let output = Command::new(wcx)
        .arg("fetch")
        .arg(fakeid)
        .arg("--limit")
        .arg(limit.to_string())
        .arg("--content")
        .output()
        .map_err(|e| CmdError {
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
        let line = line.map_err(|e| CmdError {
            message: format!("读取 wcx 抓取输出失败: {e}"),
        })?;
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

fn python_command_from_wcx(wcx: &Path) -> Result<Command, String> {
    let script = fs::read_to_string(wcx)
        .map_err(|e| format!("读取 wcx 启动脚本失败，无法定位 Python 环境: {e}"))?;
    let shebang = script
        .lines()
        .next()
        .and_then(|line| line.strip_prefix("#!"))
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "wcx 启动脚本缺少 Python shebang".to_string())?;

    let mut parts = shebang.split_whitespace();
    let program = parts
        .next()
        .ok_or_else(|| "wcx 启动脚本缺少 Python 可执行文件".to_string())?;
    let mut cmd = Command::new(program);
    for arg in parts {
        cmd.arg(arg);
    }
    Ok(cmd)
}

fn resolve_executable(candidate: &Path) -> Option<PathBuf> {
    if candidate.components().count() > 1 {
        return Some(candidate.to_path_buf());
    }

    let path = env::var_os("PATH")?;
    for dir in env::split_paths(&path) {
        let resolved = dir.join(candidate);
        if resolved.is_file() {
            return Some(resolved);
        }
    }
    None
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

const FETCH_ARTICLE_PY: &str = r#"
import json
import sys
from wcx.article import extract_content, fetch_article_html

html = fetch_article_html(sys.argv[1])
inner, md = extract_content(html)
print(json.dumps({"html": inner, "md": md}, ensure_ascii=False))
"#;

const SEARCH_ACCOUNTS_PY: &str = r#"
import json
import sys
from wcx import config, fetcher

try:
    creds = config.load_credentials()
    if not creds:
        raise RuntimeError("尚未登录，请先扫码登录")
    f = fetcher.Fetcher(creds.token, creds.cookie)
    results = [acc.to_dict() for acc in f.search_biz(sys.argv[1])]
    print(json.dumps(results, ensure_ascii=False))
except fetcher.AuthError as e:
    raise SystemExit(f"认证失败：{e}")
except fetcher.RateLimitError as e:
    raise SystemExit(f"触发风控：{e}")
except Exception as e:
    raise SystemExit(f"搜索公众号失败：{e}")
"#;

const FETCH_SELECTED_ACCOUNT_PY: &str = r#"
import json
import sys
import time
from wcx import article as article_mod
from wcx import cache, config, fetcher

PROGRESS_PREFIX = "__WXMP_FETCH_PROGRESS__"

def text(value):
    return value or ""

def emit(stage, status, message, current=None, total=None, title=None):
    print(PROGRESS_PREFIX + json.dumps({
        "fakeid": account.fakeid if "account" in globals() else "",
        "nickname": account.nickname if "account" in globals() else "",
        "stage": stage,
        "status": status,
        "message": message,
        "current": current,
        "total": total,
        "title": title,
    }, ensure_ascii=False), flush=True)

try:
    payload = json.loads(sys.argv[1])
    limit = int(sys.argv[2])
    with_content = sys.argv[3] == "1"
    creds = config.load_credentials()
    if not creds:
        raise RuntimeError("尚未登录，请先扫码登录")

    account = fetcher.Account(
        fakeid=text(payload.get("fakeid")).strip(),
        nickname=text(payload.get("nickname")).strip(),
        alias=text(payload.get("alias")).strip(),
        signature=text(payload.get("signature")).strip(),
        round_head_img=text(payload.get("avatar") or payload.get("round_head_img")).strip(),
    )
    if not account.fakeid or not account.nickname:
        raise RuntimeError("公众号选择缺少 fakeid 或昵称")

    emit("prepare", "done", f"已确认目标公众号：{account.nickname}")
    f = fetcher.Fetcher(creds.token, creds.cookie)
    count = 0
    content_count = 0
    article_total = limit
    with cache.connect() as conn:
        emit("account", "running", "正在写入账号信息")
        cache.upsert_account(conn, account.to_dict())
        emit("account", "done", "账号信息已写入本地缓存")

        def on_page(begin, fetched, total):
            global article_total
            article_total = min(total, limit) if limit else total
            emit(
                "articles",
                "running",
                f"已读取第 {begin // 5 + 1} 页文章索引，本页 {fetched} 篇",
                count,
                article_total,
            )

        emit("articles", "running", "正在请求公众号文章索引", 0, article_total)
        for art in f.iter_all_articles(account.fakeid, max_items=limit, page_size=5):
            cache.upsert_article(conn, art.to_dict())
            count += 1
            emit(
                "articles",
                "running",
                f"已写入 {count}/{article_total} 篇文章索引",
                count,
                article_total,
                art.title,
            )

        emit("articles", "done", f"文章索引已入库 {count} 篇", count, article_total)

        if with_content:
            rows = cache.list_articles(conn, account.fakeid, limit=limit)
            need = [r for r in rows if r["content_md"] is None]
            emit("content", "running", f"待抓取正文 {len(need)} 篇", 0, len(need))
            for row in need:
                try:
                    emit(
                        "content",
                        "running",
                        f"正在抓取正文 {content_count + 1}/{len(need)}",
                        content_count,
                        len(need),
                        row["title"],
                    )
                    html = article_mod.fetch_article_html(row["link"])
                    inner, md = article_mod.extract_content(html)
                    cache.set_article_content(conn, row["aid"], inner, md)
                    content_count += 1
                    emit(
                        "content",
                        "running",
                        f"正文已写入 {content_count}/{len(need)}",
                        content_count,
                        len(need),
                        row["title"],
                    )
                except Exception as e:
                    emit(
                        "content",
                        "warning",
                        f"正文抓取失败：{e}",
                        content_count,
                        len(need),
                        row["title"],
                    )
                    print(f"{row['title']}: {e}", file=sys.stderr)
                time.sleep(1.0)
            emit("content", "done", f"正文抓取完成 {content_count}/{len(need)} 篇", content_count, len(need))

    emit("complete", "done", f"已完成：文章索引 {count} 篇，正文 {content_count} 篇", count, count)
    print(json.dumps({
        "fakeid": account.fakeid,
        "nickname": account.nickname,
        "count": count,
        "content_count": content_count,
    }, ensure_ascii=False))
except fetcher.AuthError as e:
    raise SystemExit(f"认证失败：{e}")
except fetcher.RateLimitError as e:
    raise SystemExit(f"触发风控：{e}")
except Exception as e:
    raise SystemExit(f"抓取公众号失败：{e}")
"#;
