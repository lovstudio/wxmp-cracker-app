//! GitHub archive sync: render articles to markdown, download referenced
//! images, then commit & push the local mirror via gix.
//!
//! All operations are synchronous (gix is sync). Long-running work is meant
//! to be invoked from `spawn_blocking` in the Tauri command layer.

use crate::archive::{
    archive_dir, ensure_repo_configured, load_index, load_settings, publish_date, repo_local_path,
    repos_root, save_index, save_settings, sha256_hex, title_slug, IndexAccount, IndexArticle,
    IndexFile,
};
use crate::db::{self, Account, ArticleDetail};
use crate::github;
use anyhow::{anyhow, Context, Result};
use base64::Engine as _;
use chrono::Utc;
use include_dir::{include_dir, Dir};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::{AppHandle, Emitter};

/// Astro + Pagefind + RSS site template, written to the archive repo on first sync.
static ARCHIVE_TEMPLATE: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/templates/archive-repo");

pub const SYNC_PROGRESS_EVENT: &str = "github-sync://progress";

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum SyncProgress {
    Start { total_candidates: usize },
    Prepare { message: String },
    Render { current: usize, total: usize, title: String },
    Image { current: usize, total: usize, url: String },
    Commit { changed: usize },
    Push { message: String },
    Done { pushed: usize, skipped: usize, message: String },
}

fn emit(app: &AppHandle, evt: SyncProgress) {
    let _ = app.emit(SYNC_PROGRESS_EVENT, evt);
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct SyncOptions {
    /// If set, only sync articles from this fakeid. Otherwise sync everything in cache.
    #[serde(default)]
    pub account_fakeid: Option<String>,
    /// Force re-rendering even if content hash matches (for repair).
    #[serde(default)]
    pub force: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct SyncSummary {
    pub pushed: usize,
    pub skipped: usize,
    pub repo_html_url: Option<String>,
    pub commit_message: Option<String>,
}

// --- entry point ----------------------------------------------------------

pub fn sync_articles(app: &AppHandle, opts: SyncOptions) -> Result<SyncSummary> {
    let mut settings = load_settings()?;
    let repo_full_name = ensure_repo_configured(&settings)?.to_string();
    let token = github::load_token()?
        .ok_or_else(|| anyhow!("尚未连接 GitHub 账号，请先在 GitHub 同步页登录。"))?;

    emit(
        app,
        SyncProgress::Prepare {
            message: format!("正在准备 {} 的本地副本…", repo_full_name),
        },
    );

    let repo_dir = ensure_repo_cloned(&repo_full_name, &settings.branch, &token)?;
    seed_template_if_empty(&repo_dir)?;

    let outcome = render_into_dir(&repo_dir, &opts, settings.sync_images, app)?;
    let pushed = outcome.rendered;
    let skipped = outcome.skipped;
    let accounts_seen = outcome.accounts_seen;

    if pushed == 0 {
        emit(
            app,
            SyncProgress::Done {
                pushed: 0,
                skipped,
                message: "没有新增内容，跳过提交。".into(),
            },
        );
        settings.last_synced_at = Some(Utc::now().timestamp());
        settings.last_error = None;
        save_settings(&settings)?;
        return Ok(SyncSummary {
            pushed: 0,
            skipped,
            repo_html_url: Some(format!("https://github.com/{}", repo_full_name)),
            commit_message: None,
        });
    }

    let commit_msg = format!(
        "sync: {} articles ({} accounts) · {}",
        pushed,
        accounts_seen.len(),
        Utc::now().format("%Y-%m-%d %H:%M UTC")
    );

    emit(app, SyncProgress::Commit { changed: pushed });
    commit_and_push(&repo_dir, &repo_full_name, &settings.branch, &token, &commit_msg, app)?;

    settings.last_synced_at = Some(Utc::now().timestamp());
    settings.last_error = None;
    save_settings(&settings)?;

    emit(
        app,
        SyncProgress::Done {
            pushed,
            skipped,
            message: format!("已推送 {pushed} 篇文章。"),
        },
    );

    Ok(SyncSummary {
        pushed,
        skipped,
        repo_html_url: Some(format!("https://github.com/{}", repo_full_name)),
        commit_message: Some(commit_msg),
    })
}

// --- local archive --------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
pub struct LocalArchiveSummary {
    pub rendered: usize,
    pub skipped: usize,
    pub accounts: usize,
    pub archive_dir: String,
}

/// Render every cached article (with content) to the local-only markdown
/// archive. No GitHub binding, token, or network required — this is the
/// baseline on-disk mirror that GitHub sync optionally pushes on top of.
pub fn archive_local(app: &AppHandle, opts: SyncOptions) -> Result<LocalArchiveSummary> {
    let settings = load_settings()?;
    let dir = archive_dir()?;
    fs::create_dir_all(&dir).with_context(|| format!("mkdir {:?}", dir))?;

    let outcome = render_into_dir(&dir, &opts, settings.sync_images, app)?;

    emit(
        app,
        SyncProgress::Done {
            pushed: outcome.rendered,
            skipped: outcome.skipped,
            message: format!("已导出 {} 篇文章到本地归档。", outcome.rendered),
        },
    );

    Ok(LocalArchiveSummary {
        rendered: outcome.rendered,
        skipped: outcome.skipped,
        accounts: outcome.accounts_seen.len(),
        archive_dir: dir.display().to_string(),
    })
}

struct RenderOutcome {
    rendered: usize,
    skipped: usize,
    accounts_seen: HashSet<String>,
}

/// Render cached articles into `target_dir`, refreshing its index, per-account
/// profiles and README. Pure filesystem work — shared by GitHub sync and the
/// local archive so both produce an identical `accounts/<slug>/articles` tree.
fn render_into_dir(
    target_dir: &Path,
    opts: &SyncOptions,
    sync_images: bool,
    app: &AppHandle,
) -> Result<RenderOutcome> {
    let mut index = load_index(target_dir)?;

    let candidates = db::list_articles_with_content(opts.account_fakeid.as_deref())?;
    emit(
        app,
        SyncProgress::Start {
            total_candidates: candidates.len(),
        },
    );

    let mut accounts_seen: HashSet<String> = HashSet::new();
    let mut rendered = 0usize;
    let mut skipped = 0usize;
    let total = candidates.len();

    for (i, article) in candidates.iter().enumerate() {
        let Some(content_md) = article.content_md.as_deref() else {
            skipped += 1;
            continue;
        };

        let account = db::get_account(&article.fakeid)?
            .unwrap_or_else(|| fallback_account(&article.fakeid));
        let nickname = account.nickname.clone();
        let account_slug = title_slug(&nickname, 40);

        emit(
            app,
            SyncProgress::Render {
                current: i + 1,
                total,
                title: article.title.clone(),
            },
        );

        let body_hash = sha256_hex(content_md);
        if !opts.force {
            if let Some(prev) = index.articles.get(&article.aid) {
                if prev.content_hash == body_hash {
                    skipped += 1;
                    continue;
                }
            }
        }

        let (markdown_path, processed_body) = render_article(
            target_dir,
            &account_slug,
            &nickname,
            article,
            content_md,
            sync_images,
            app,
        )?;

        // Rehash after image rewrites so future runs match.
        let final_hash = sha256_hex(&processed_body);

        index.articles.insert(
            article.aid.clone(),
            IndexArticle {
                aid: article.aid.clone(),
                fakeid: article.fakeid.clone(),
                nickname: nickname.clone(),
                title: article.title.clone(),
                link: article.link.clone(),
                digest: article.digest.clone(),
                author: article.author.clone(),
                create_time: article.create_time,
                publish_date: publish_date(article.create_time),
                markdown_path: markdown_path.clone(),
                content_hash: final_hash,
            },
        );
        accounts_seen.insert(article.fakeid.clone());
        rendered += 1;
    }

    // Refresh account summaries for everything we touched.
    let now_iso = Utc::now().to_rfc3339();
    for fakeid in &accounts_seen {
        if let Some(acc) = db::get_account(fakeid)? {
            let account_slug = title_slug(&acc.nickname, 40);
            write_account_profile(target_dir, &account_slug, &acc)?;
            index.accounts.insert(
                fakeid.clone(),
                IndexAccount {
                    fakeid: acc.fakeid,
                    nickname: acc.nickname,
                    alias: acc.alias,
                    signature: acc.signature,
                    avatar: acc.avatar,
                    article_count: acc.article_count,
                    last_synced_at: now_iso.clone(),
                },
            );
        }
    }

    save_index(target_dir, &index)?;
    ensure_readme(target_dir, &index)?;

    Ok(RenderOutcome {
        rendered,
        skipped,
        accounts_seen,
    })
}

fn fallback_account(fakeid: &str) -> Account {
    Account {
        fakeid: fakeid.to_string(),
        nickname: format!("unknown-{}", fakeid),
        alias: None,
        signature: None,
        avatar: None,
        article_count: 0,
    }
}

// --- markdown rendering ---------------------------------------------------

fn render_article(
    repo_dir: &Path,
    account_slug: &str,
    nickname: &str,
    article: &ArticleDetail,
    content_md: &str,
    sync_images: bool,
    app: &AppHandle,
) -> Result<(String, String)> {
    let date = publish_date(article.create_time);
    let title_part = title_slug(&article.title, 60);
    let file_name = format!("{date}-{title_part}-{}.md", short_hash(&article.aid));
    let articles_dir = PathBuf::from("accounts")
        .join(account_slug)
        .join("articles");
    fs::create_dir_all(repo_dir.join(&articles_dir))
        .with_context(|| format!("mkdir {:?}", articles_dir))?;

    let relative_path = articles_dir.join(&file_name);
    let absolute = repo_dir.join(&relative_path);

    let mut body = content_md.to_string();
    if sync_images {
        body = rewrite_and_download_images(
            repo_dir,
            account_slug,
            &article.aid,
            &body,
            &relative_path,
            app,
        )?;
    }

    let frontmatter = build_frontmatter(article, nickname);
    let rendered = format!("{frontmatter}\n\n# {}\n\n{}\n", article.title, body.trim());

    fs::write(&absolute, &rendered).with_context(|| format!("write {:?}", absolute))?;

    Ok((relative_path.to_string_lossy().to_string(), rendered))
}

fn build_frontmatter(article: &ArticleDetail, nickname: &str) -> String {
    let mut out = String::from("---\n");
    out.push_str(&format!("title: {}\n", yaml_quote(&article.title)));
    out.push_str(&format!("account: {}\n", yaml_quote(nickname)));
    out.push_str(&format!("fakeid: {}\n", yaml_quote(&article.fakeid)));
    out.push_str(&format!("aid: {}\n", yaml_quote(&article.aid)));
    if let Some(author) = article.author.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("author: {}\n", yaml_quote(author)));
    }
    out.push_str(&format!("publish_time: {}\n", article.create_time));
    out.push_str(&format!(
        "publish_date: {}\n",
        publish_date(article.create_time)
    ));
    out.push_str(&format!("link: {}\n", yaml_quote(&article.link)));
    if let Some(digest) = article.digest.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("digest: {}\n", yaml_quote(digest)));
    }
    if let Some(cover) = article.cover.as_deref().filter(|s| !s.is_empty()) {
        out.push_str(&format!("cover: {}\n", yaml_quote(cover)));
    }
    out.push_str("---");
    out
}

fn yaml_quote(s: &str) -> String {
    let escaped = s.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{}\"", escaped)
}

fn short_hash(s: &str) -> String {
    sha256_hex(s).chars().take(8).collect()
}

// --- image download / rewrite --------------------------------------------

fn image_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // Match Markdown image syntax: ![alt](url) — capture URL group.
        Regex::new(r"!\[([^\]]*)\]\(([^)]+)\)").expect("compile image regex")
    })
}

fn rewrite_and_download_images(
    repo_dir: &Path,
    account_slug: &str,
    aid: &str,
    body: &str,
    markdown_relative: &Path,
    app: &AppHandle,
) -> Result<String> {
    let re = image_regex();

    // First, collect all unique URLs.
    let urls: Vec<(String, String)> = re
        .captures_iter(body)
        .map(|cap| (cap[1].to_string(), cap[2].to_string()))
        .filter(|(_, url)| is_remote_image(url))
        .collect();

    if urls.is_empty() {
        return Ok(body.to_string());
    }

    let assets_rel = PathBuf::from("assets").join(account_slug).join(aid);
    let assets_abs = repo_dir.join(&assets_rel);
    fs::create_dir_all(&assets_abs).with_context(|| format!("mkdir {:?}", assets_abs))?;

    // Map url -> local relative path (relative to markdown file).
    let mut mapping: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let total = urls.len();

    for (idx, (_alt, url)) in urls.iter().enumerate() {
        if mapping.contains_key(url) {
            continue;
        }
        emit(
            app,
            SyncProgress::Image {
                current: idx + 1,
                total,
                url: url.clone(),
            },
        );
        let url_normalized = normalize_wechat_url(url);
        match download_image(&url_normalized, &assets_abs, idx) {
            Ok(file_name) => {
                let abs_target = assets_abs.join(&file_name);
                let rel = relativize(markdown_relative, &assets_rel.join(&file_name), repo_dir);
                mapping.insert(url.clone(), rel);
                log::debug!("image saved: {:?}", abs_target);
            }
            Err(e) => {
                log::warn!("failed to download image {url}: {e:#}");
                // Keep original URL on failure.
                mapping.insert(url.clone(), url.clone());
            }
        }
    }

    // Second pass: rewrite the body.
    let rewritten = re.replace_all(body, |caps: &regex::Captures| {
        let alt = &caps[1];
        let original = &caps[2];
        let replaced = mapping.get(original).cloned().unwrap_or_else(|| original.to_string());
        format!("![{alt}]({replaced})")
    });
    Ok(rewritten.into_owned())
}

fn is_remote_image(url: &str) -> bool {
    url.starts_with("http://") || url.starts_with("https://")
}

fn normalize_wechat_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("http://mmbiz.qpic.cn") {
        return format!("https://mmbiz.qpic.cn{rest}");
    }
    url.to_string()
}

fn download_image(url: &str, dir: &Path, idx: usize) -> Result<String> {
    let resp = reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 wxmp-cracker")
        .timeout(std::time::Duration::from_secs(20))
        .build()?
        .get(url)
        .header("Referer", "https://mp.weixin.qq.com/")
        .send()
        .with_context(|| format!("GET {url}"))?;
    if !resp.status().is_success() {
        return Err(anyhow!("HTTP {} fetching {url}", resp.status()));
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let ext = if content_type.contains("jpeg") || content_type.contains("jpg") {
        "jpg"
    } else if content_type.contains("png") {
        "png"
    } else if content_type.contains("gif") {
        "gif"
    } else if content_type.contains("webp") {
        "webp"
    } else if content_type.contains("svg") {
        "svg"
    } else {
        // fall back to URL hint
        url_extension_hint(url).unwrap_or("bin")
    };
    let bytes = resp.bytes().with_context(|| format!("read body {url}"))?;
    let name = format!("img-{:03}.{ext}", idx + 1);
    let path = dir.join(&name);
    fs::write(&path, &bytes).with_context(|| format!("write {:?}", path))?;
    Ok(name)
}

fn url_extension_hint(url: &str) -> Option<&'static str> {
    let lower = url.to_lowercase();
    if lower.contains("wx_fmt=jpeg") || lower.contains("wx_fmt=jpg") {
        Some("jpg")
    } else if lower.contains("wx_fmt=png") {
        Some("png")
    } else if lower.contains("wx_fmt=gif") {
        Some("gif")
    } else if lower.contains("wx_fmt=webp") {
        Some("webp")
    } else {
        None
    }
}

/// Compute a relative path from `markdown_relative` to `target_relative` within repo.
fn relativize(markdown_rel: &Path, target_rel: &Path, _repo_root: &Path) -> String {
    let depth = markdown_rel.parent().map(|p| p.components().count()).unwrap_or(0);
    let mut up = String::new();
    for _ in 0..depth {
        up.push_str("../");
    }
    format!("{up}{}", target_rel.to_string_lossy())
}

// --- account profile + readme --------------------------------------------

fn write_account_profile(repo_dir: &Path, account_slug: &str, acc: &Account) -> Result<()> {
    let dir = repo_dir.join("accounts").join(account_slug);
    fs::create_dir_all(&dir).with_context(|| format!("mkdir {:?}", dir))?;
    let body = serde_json::to_string_pretty(&serde_json::json!({
        "fakeid": acc.fakeid,
        "nickname": acc.nickname,
        "alias": acc.alias,
        "signature": acc.signature,
        "avatar": acc.avatar,
        "article_count": acc.article_count,
    }))?;
    fs::write(dir.join("profile.json"), body)?;
    Ok(())
}

fn ensure_readme(repo_dir: &Path, index: &IndexFile) -> Result<()> {
    let path = repo_dir.join("README.md");
    let body = format!(
        "# 微信公众号归档\n\n\
         由 [wxmp-cracker](https://github.com/markshawn2020/wxmp-cracker-app) 自动同步。\n\n\
         - 公众号数: **{}**\n\
         - 文章数: **{}**\n\
         - 最近同步: {}\n\n\
         ## 公众号列表\n\n{}\n",
        index.accounts.len(),
        index.articles.len(),
        index.generated_at,
        index
            .accounts
            .values()
            .map(|a| format!(
                "- **{}** ({} 篇) · fakeid `{}`",
                a.nickname, a.article_count, a.fakeid
            ))
            .collect::<Vec<_>>()
            .join("\n")
    );
    fs::write(&path, body).with_context(|| format!("write {:?}", path))?;
    Ok(())
}

// --- git plumbing ---------------------------------------------------------

fn ensure_repo_cloned(full_name: &str, branch: &str, token: &str) -> Result<PathBuf> {
    fs::create_dir_all(repos_root()?)?;
    let local = repo_local_path(full_name)?;

    if local.join(".git").exists() {
        pull_latest(&local, full_name, branch, token)?;
        return Ok(local);
    }

    if local.exists() {
        // Directory exists but isn't a git repo — purge it.
        fs::remove_dir_all(&local).with_context(|| format!("rm stale {:?}", local))?;
    }
    if let Some(parent) = local.parent() {
        fs::create_dir_all(parent).with_context(|| format!("mkdir {:?}", parent))?;
    }

    // Initialize an empty repo locally, then fetch with an in-memory auth
    // header so the token never lands in .git/config.
    let local_str = local.to_str().context("repo path non-utf8")?;
    log::info!("init local repo at {:?}", local);
    run_git_anywhere(&["init", "-b", branch, local_str])?;

    let clean_url = format!("https://github.com/{full_name}.git");
    run_git(&local, &["remote", "add", "origin", &clean_url])?;

    fetch_with_token(&local, full_name, branch, token).context("初次 fetch 失败")?;

    // Try to check out the fetched branch — repo may be empty (no commits yet).
    let fetch_head = local.join(".git").join("FETCH_HEAD");
    if fetch_head.exists() {
        let _ = run_git(&local, &["checkout", "-B", branch, "FETCH_HEAD"]);
    }
    Ok(local)
}

fn pull_latest(local: &Path, full_name: &str, branch: &str, token: &str) -> Result<()> {
    // Best-effort fetch & fast-forward. Don't fail the whole sync if offline.
    if let Err(e) = fetch_with_token(local, full_name, branch, token) {
        log::warn!("git fetch failed (continuing): {e}");
        return Ok(());
    }
    let _ = run_git(local, &["reset", "--hard", "FETCH_HEAD"]);
    Ok(())
}

/// Run a git fetch / push against an authed URL without ever writing the
/// token into `.git/config`. We pass `http.extraheader` only for this call.
fn fetch_with_token(local: &Path, full_name: &str, branch: &str, token: &str) -> Result<()> {
    let auth = format!(
        "AUTHORIZATION: basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!("x-access-token:{token}").as_bytes())
    );
    let url = format!("https://github.com/{full_name}.git");
    let output = std::process::Command::new("git")
        .args([
            "-c",
            &format!("http.extraheader={auth}"),
            "fetch",
            "--depth",
            "50",
            url.as_str(),
            branch,
        ])
        .current_dir(local)
        .output()
        .context("启动 git fetch 失败")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("git fetch 失败: {}", stderr.trim()));
    }
    Ok(())
}

fn run_git_anywhere(args: &[&str]) -> Result<()> {
    let output = std::process::Command::new("git")
        .args(args)
        .output()
        .with_context(|| format!("启动 git {args:?} 失败"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("git {:?} 失败: {}", args, stderr.trim()));
    }
    Ok(())
}

fn commit_and_push(
    local: &Path,
    full_name: &str,
    branch: &str,
    token: &str,
    message: &str,
    app: &AppHandle,
) -> Result<()> {
    // gix's high-level commit/push API is still in flux. We shell out to git for
    // this stage — much smaller code surface, and `git` ships on every dev box.
    // The auth happens via a one-shot HTTPS URL passed to `git push`.
    run_git(local, &["add", "-A"])?;
    let status = run_git_output(local, &["status", "--porcelain"])?;
    if status.trim().is_empty() {
        return Ok(());
    }
    run_git(
        local,
        &[
            "-c",
            "user.email=wxmp-cracker@lovstudio.local",
            "-c",
            "user.name=wxmp-cracker",
            "commit",
            "-m",
            message,
        ],
    )?;

    emit(
        app,
        SyncProgress::Push {
            message: format!("正在推送到 {full_name} ({branch})…"),
        },
    );

    let auth = format!(
        "AUTHORIZATION: basic {}",
        base64::engine::general_purpose::STANDARD
            .encode(format!("x-access-token:{token}").as_bytes())
    );
    let url = format!("https://github.com/{full_name}.git");
    let output = std::process::Command::new("git")
        .args([
            "-c",
            &format!("http.extraheader={auth}"),
            "push",
            url.as_str(),
            &format!("HEAD:{branch}"),
        ])
        .current_dir(local)
        .output()
        .context("启动 git push 失败")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("git push 失败: {}", stderr.trim()));
    }
    Ok(())
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<()> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("spawn git {args:?}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("git {:?} 失败: {}", args, stderr));
    }
    Ok(())
}

fn run_git_output(cwd: &Path, args: &[&str]) -> Result<String> {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .with_context(|| format!("spawn git {args:?}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("git {:?} 失败: {}", args, stderr));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

/// On first sync, drop the Astro + Pagefind + RSS site template into the
/// repo. Only writes files that don't already exist — so user-edited files
/// (e.g. customized astro.config.mjs) are never overwritten.
fn seed_template_if_empty(repo_dir: &Path) -> Result<()> {
    extract_template_dir(&ARCHIVE_TEMPLATE, repo_dir)?;
    Ok(())
}

fn extract_template_dir(dir: &Dir<'_>, target_root: &Path) -> Result<()> {
    for entry in dir.entries() {
        let rel = entry.path();
        let dest = target_root.join(rel);
        match entry {
            include_dir::DirEntry::Dir(d) => {
                fs::create_dir_all(&dest).with_context(|| format!("mkdir {:?}", dest))?;
                extract_template_dir(d, target_root)?;
            }
            include_dir::DirEntry::File(f) => {
                // Don't clobber existing files — the repo README is also
                // overwritten elsewhere, that's intentional. Everything else
                // sticks to first-write-wins so user edits survive.
                if dest.exists() {
                    continue;
                }
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).with_context(|| format!("mkdir {:?}", parent))?;
                }
                fs::write(&dest, f.contents()).with_context(|| format!("write {:?}", dest))?;
            }
        }
    }
    Ok(())
}
