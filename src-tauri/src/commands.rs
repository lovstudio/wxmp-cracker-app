use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::AppHandle;

use crate::auth;
use crate::db::{self, Account, ArticleDetail, ArticleSummary};

#[derive(Serialize)]
pub struct CmdError {
    pub message: String,
}

#[derive(Serialize)]
pub struct FetchAccountResult {
    pub stdout: String,
    pub stderr: String,
}

#[derive(Deserialize)]
struct ArticleContentPayload {
    html: String,
    md: String,
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
