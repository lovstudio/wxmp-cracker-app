use std::sync::{atomic::AtomicBool, Mutex};

use serde::Serialize;

const DELTA_FEED_URL: &str =
    "https://github.com/lovstudio/wxmp-cracker-app/releases/latest/download/latest-deltas.json";

#[derive(Default)]
pub struct DeltaUpdaterState {
    checking: AtomicBool,
    pending: Mutex<Option<PendingDeltaUpdate>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaUpdateMetadata {
    pub version: String,
    pub from_version: String,
    pub size: u64,
}

#[derive(Clone)]
struct PendingDeltaUpdate {
    metadata: DeltaUpdateMetadata,
    url: String,
    sha256: String,
    signature: String,
    target: String,
}

#[cfg(not(target_os = "macos"))]
pub async fn check(
    _app: tauri::AppHandle,
    _state: &DeltaUpdaterState,
) -> Result<Option<DeltaUpdateMetadata>, String> {
    Ok(None)
}

#[cfg(not(target_os = "macos"))]
pub async fn install(_app: tauri::AppHandle, _state: &DeltaUpdaterState) -> Result<(), String> {
    Err("当前平台使用完整包更新。".to_string())
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::{
        fs,
        io::Cursor,
        os::unix::fs::{symlink, PermissionsExt},
        path::{Component, Path, PathBuf},
        process::Command,
        time::Duration,
    };

    use anyhow::{anyhow, bail, Context, Result};
    use base64::{engine::general_purpose::STANDARD, Engine};
    use flate2::read::GzDecoder;
    use minisign_verify::{PublicKey, Signature};
    use reqwest::Client;
    use semver::Version;
    use serde::Deserialize;
    use sha2::{Digest, Sha256};
    use tar::Archive;
    use tauri::{AppHandle, Manager};

    use super::{DeltaUpdateMetadata, DeltaUpdaterState, PendingDeltaUpdate, DELTA_FEED_URL};

    const UPDATE_PUBKEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDQxMjZCMkE0RjE4RjVFQjQKUldTMFhvL3hwTEltUWVyeEVXOHZ2N3JLVnpmMk54K2NOelJsV21LelMrUStLa3lIMjIyVmlvT2MK";
    const MAX_DELTA_BYTES: u64 = 80 * 1024 * 1024;

    #[derive(Deserialize)]
    struct DeltaFeed {
        schema: u8,
        version: String,
        deltas: Vec<DeltaOffer>,
    }

    #[derive(Clone, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DeltaOffer {
        from_version: String,
        target: String,
        url: String,
        size: u64,
        sha256: String,
        signature: String,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DeltaManifest {
        schema: u8,
        product: String,
        from_version: String,
        to_version: String,
        target: String,
        entries: Vec<DeltaEntry>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct DeltaEntry {
        path: String,
        op: String,
        kind: String,
        source_sha256: Option<String>,
        target_sha256: Option<String>,
        patch: Option<String>,
        file: Option<String>,
        mode: Option<u32>,
        source_link: Option<String>,
        link: Option<String>,
    }

    struct CheckGuard<'a>(&'a AtomicBool);

    impl Drop for CheckGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::Release);
        }
    }

    pub async fn check(
        app: AppHandle,
        state: &DeltaUpdaterState,
    ) -> Result<Option<DeltaUpdateMetadata>, String> {
        if state
            .checking
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err("更新检查正在进行。".to_string());
        }
        let _guard = CheckGuard(&state.checking);

        let result = check_inner(&app).await.map_err(|error| error.to_string())?;
        let metadata = result.as_ref().map(|update| update.metadata.clone());
        *state
            .pending
            .lock()
            .map_err(|_| "更新状态不可用。".to_string())? = result;
        Ok(metadata)
    }

    async fn check_inner(app: &AppHandle) -> Result<Option<PendingDeltaUpdate>> {
        let client = Client::builder().timeout(Duration::from_secs(20)).build()?;
        let Some(feed_bytes) = fetch_optional(&client, DELTA_FEED_URL).await? else {
            return Ok(None);
        };
        let signature_url = format!("{DELTA_FEED_URL}.sig");
        let Some(signature_bytes) = fetch_optional(&client, &signature_url).await? else {
            return Ok(None);
        };
        verify_signature(&feed_bytes, std::str::from_utf8(&signature_bytes)?)?;

        let feed: DeltaFeed = serde_json::from_slice(&feed_bytes)?;
        if feed.schema != 1 {
            return Ok(None);
        }

        let current_version = app.package_info().version.to_string();
        if Version::parse(&feed.version)? <= Version::parse(&current_version)? {
            return Ok(None);
        }
        let target = current_target();
        let Some(offer) = feed
            .deltas
            .into_iter()
            .find(|offer| offer.from_version == current_version && offer.target == target)
        else {
            return Ok(None);
        };
        if offer.size == 0 || offer.size > MAX_DELTA_BYTES || !is_sha256(&offer.sha256) {
            return Ok(None);
        }

        Ok(Some(PendingDeltaUpdate {
            metadata: DeltaUpdateMetadata {
                version: feed.version,
                from_version: current_version,
                size: offer.size,
            },
            url: offer.url,
            sha256: offer.sha256,
            signature: offer.signature,
            target: offer.target,
        }))
    }

    pub async fn install(app: AppHandle, state: &DeltaUpdaterState) -> Result<(), String> {
        let pending = state
            .pending
            .lock()
            .map_err(|_| "更新状态不可用。".to_string())?
            .take()
            .ok_or_else(|| "没有可安装的增量更新。".to_string())?;
        install_inner(&app, pending)
            .await
            .map_err(|error| error.to_string())
    }

    async fn install_inner(app: &AppHandle, pending: PendingDeltaUpdate) -> Result<()> {
        let client = Client::builder().timeout(Duration::from_secs(90)).build()?;
        let delta = fetch_required(&client, &pending.url).await?;
        if delta.len() as u64 != pending.metadata.size {
            bail!("增量包长度与已签名清单不一致");
        }
        if sha256(&delta) != pending.sha256 {
            bail!("增量包摘要校验失败");
        }
        verify_signature(&delta, &pending.signature)?;

        let cache_dir = app.path().app_cache_dir()?.join("delta-updates");
        fs::create_dir_all(&cache_dir)?;
        let install_dir = cache_dir.join(format!(
            "{}-{}",
            pending.metadata.version,
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&install_dir)?;
        let delta_path = install_dir.join("update.delta");
        fs::write(&delta_path, &delta)?;
        let payload_dir = install_dir.join("payload");
        extract_delta(&delta_path, &payload_dir)?;

        let manifest: DeltaManifest =
            serde_json::from_slice(&fs::read(payload_dir.join("manifest.json"))?)?;
        validate_manifest(&manifest, &pending)?;
        let installed_app = installed_app_path()?;
        verify_codesign(&installed_app)?;

        let staged_app = install_dir.join(
            installed_app
                .file_name()
                .ok_or_else(|| anyhow!("无法识别已安装应用名称"))?,
        );
        let ditto = Command::new("/usr/bin/ditto")
            .arg(&installed_app)
            .arg(&staged_app)
            .output()
            .context("无法创建增量更新副本")?;
        if !ditto.status.success() {
            bail!(
                "创建增量更新副本失败: {}",
                String::from_utf8_lossy(&ditto.stderr)
            );
        }

        apply_manifest(&staged_app, &payload_dir, &manifest)?;
        verify_codesign(&staged_app)?;
        hand_off_install(&installed_app, &staged_app, &install_dir)?;
        Ok(())
    }

    async fn fetch_optional(client: &Client, url: &str) -> Result<Option<Vec<u8>>> {
        let response = client.get(url).send().await?;
        if response.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }
        Ok(Some(response.error_for_status()?.bytes().await?.to_vec()))
    }

    async fn fetch_required(client: &Client, url: &str) -> Result<Vec<u8>> {
        Ok(client
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .bytes()
            .await?
            .to_vec())
    }

    fn verify_signature(bytes: &[u8], encoded_signature: &str) -> Result<()> {
        let decoded = STANDARD.decode(UPDATE_PUBKEY)?;
        let public_key = PublicKey::decode(std::str::from_utf8(&decoded)?)?;
        let signature = Signature::decode(encoded_signature)?;
        public_key.verify(bytes, &signature, false)?;
        Ok(())
    }

    fn current_target() -> String {
        if cfg!(target_arch = "aarch64") {
            "darwin-aarch64".to_string()
        } else {
            "darwin-x86_64".to_string()
        }
    }

    fn installed_app_path() -> Result<PathBuf> {
        let executable = std::env::current_exe()?;
        let app = executable
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .ok_or_else(|| anyhow!("无法定位应用包路径"))?;
        if app.extension().and_then(|value| value.to_str()) != Some("app") {
            bail!("增量更新仅适用于已安装的 macOS 应用包");
        }
        Ok(app.to_path_buf())
    }

    fn extract_delta(delta_path: &Path, destination: &Path) -> Result<()> {
        fs::create_dir_all(destination)?;
        let file = fs::File::open(delta_path)?;
        let mut archive = Archive::new(GzDecoder::new(file));
        for item in archive.entries()? {
            let mut entry = item?;
            let archive_path = entry.path()?;
            if archive_path == Path::new(".") {
                continue;
            }
            let relative = safe_relative(&archive_path)?;
            let path = destination.join(relative);
            if entry.header().entry_type().is_dir() {
                fs::create_dir_all(path)?;
                continue;
            }
            if !entry.header().entry_type().is_file() {
                bail!("增量包包含不受支持的条目");
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            entry.unpack(&path)?;
        }
        Ok(())
    }

    fn validate_manifest(manifest: &DeltaManifest, pending: &PendingDeltaUpdate) -> Result<()> {
        if manifest.schema != 1
            || manifest.product != "ai.lovstudio.wxmp-cracker"
            || manifest.from_version != pending.metadata.from_version
            || manifest.to_version != pending.metadata.version
            || manifest.target != pending.target
        {
            bail!("增量包与当前应用不匹配");
        }
        for entry in &manifest.entries {
            safe_relative(Path::new(&entry.path))?;
            match entry.op.as_str() {
                "patch"
                    if entry.kind == "file"
                        && entry.patch.is_some()
                        && entry.source_sha256.is_some()
                        && entry.target_sha256.is_some() => {}
                "add"
                    if entry.kind == "file"
                        && entry.file.is_some()
                        && entry.target_sha256.is_some() => {}
                "delete" if entry.source_sha256.is_some() || entry.kind == "symlink" => {}
                "symlink" if entry.kind == "symlink" && entry.link.is_some() => {}
                _ => bail!("增量包包含无效操作"),
            }
        }
        Ok(())
    }

    fn apply_manifest(app_dir: &Path, payload_dir: &Path, manifest: &DeltaManifest) -> Result<()> {
        for entry in &manifest.entries {
            let destination = app_dir.join(safe_relative(Path::new(&entry.path))?);
            match entry.op.as_str() {
                "patch" => {
                    let source = fs::read(&destination)
                        .with_context(|| format!("缺少增量更新源文件 {}", entry.path))?;
                    verify_hash(&source, entry.source_sha256.as_deref())?;
                    let patch_path = payload_path(payload_dir, entry.patch.as_deref(), "patches")?;
                    let patch = fs::read(patch_path)?;
                    let mut output = Vec::new();
                    qbsdiff::Bspatch::new(&patch)?.apply(&source, Cursor::new(&mut output))?;
                    verify_hash(&output, entry.target_sha256.as_deref())?;
                    atomic_write(&destination, &output, entry.mode)?;
                }
                "add" => {
                    let source_path = payload_path(payload_dir, entry.file.as_deref(), "files")?;
                    let source = fs::read(source_path)?;
                    verify_hash(&source, entry.target_sha256.as_deref())?;
                    remove_if_exists(&destination)?;
                    atomic_write(&destination, &source, entry.mode)?;
                }
                "delete" => {
                    if let Some(expected) = entry.source_sha256.as_deref() {
                        verify_hash(&fs::read(&destination)?, Some(expected))?;
                    }
                    remove_if_exists(&destination)?;
                }
                "symlink" => {
                    if let Some(expected) = entry.source_link.as_deref() {
                        let actual = fs::read_link(&destination)?;
                        if actual != Path::new(expected) {
                            bail!("符号链接源状态不匹配: {}", entry.path);
                        }
                    }
                    remove_if_exists(&destination)?;
                    if let Some(parent) = destination.parent() {
                        fs::create_dir_all(parent)?;
                    }
                    symlink(entry.link.as_deref().unwrap(), &destination)?;
                }
                _ => bail!("未知增量操作"),
            }
        }
        Ok(())
    }

    fn payload_path(root: &Path, value: Option<&str>, prefix: &str) -> Result<PathBuf> {
        let value = value.ok_or_else(|| anyhow!("增量包缺少文件引用"))?;
        let path = safe_relative(Path::new(value))?;
        if path
            .components()
            .next()
            .and_then(|component| match component {
                Component::Normal(value) => value.to_str(),
                _ => None,
            })
            != Some(prefix)
        {
            bail!("增量包文件引用越界");
        }
        Ok(root.join(path))
    }

    fn safe_relative(path: &Path) -> Result<PathBuf> {
        if path.as_os_str().is_empty() {
            bail!("增量包路径为空");
        }
        let mut relative = PathBuf::new();
        for component in path.components() {
            match component {
                Component::Normal(value) => relative.push(value),
                _ => bail!("增量包包含不安全路径"),
            }
        }
        Ok(relative)
    }

    fn atomic_write(path: &Path, bytes: &[u8], mode: Option<u32>) -> Result<()> {
        let parent = path.parent().ok_or_else(|| anyhow!("无效目标路径"))?;
        fs::create_dir_all(parent)?;
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file");
        let temporary = parent.join(format!(".{file_name}.delta"));
        fs::write(&temporary, bytes)?;
        if let Some(mode) = mode {
            fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
        }
        fs::rename(temporary, path)?;
        Ok(())
    }

    fn remove_if_exists(path: &Path) -> Result<()> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => fs::remove_dir_all(path)?,
            Ok(_) => fs::remove_file(path)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    fn verify_codesign(app: &Path) -> Result<()> {
        let result = Command::new("/usr/bin/codesign")
            .args(["--verify", "--deep", "--strict"])
            .arg(app)
            .output()?;
        if !result.status.success() {
            bail!(
                "应用签名校验失败: {}",
                String::from_utf8_lossy(&result.stderr)
            );
        }
        Ok(())
    }

    fn hand_off_install(installed_app: &Path, staged_app: &Path, install_dir: &Path) -> Result<()> {
        let handoff_id = chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default();
        let backup = installed_app.with_file_name(format!(
            "{}.backup-{}",
            installed_app
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            handoff_id
        ));
        let result = Command::new("/bin/sh")
            .arg("-c")
            .arg(
                r#"pid="$1"; staged="$2"; target="$3"; backup="$4"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
if [ -d "$target" ] && ! mv "$target" "$backup"; then exit 1; fi
if ! mv "$staged" "$target"; then
  if [ -d "$backup" ]; then mv "$backup" "$target"; fi
  exit 1
fi
open "$target"
"#,
            )
            .arg("wxmp-delta-install")
            .arg(std::process::id().to_string())
            .arg(staged_app)
            .arg(installed_app)
            .arg(backup)
            .current_dir(install_dir)
            .spawn()
            .context("无法启动增量更新安装助手")?;
        let _ = result;
        Ok(())
    }

    fn sha256(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn verify_hash(bytes: &[u8], expected: Option<&str>) -> Result<()> {
        let expected = expected.ok_or_else(|| anyhow!("增量包缺少摘要"))?;
        if !is_sha256(expected) || sha256(bytes) != expected {
            bail!("增量包文件摘要校验失败");
        }
        Ok(())
    }

    fn is_sha256(value: &str) -> bool {
        value.len() == 64 && value.bytes().all(|value| value.is_ascii_hexdigit())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn rejects_unsafe_delta_paths() {
            assert!(safe_relative(Path::new("../Contents/MacOS/微探")).is_err());
            assert!(safe_relative(Path::new("/Applications/微探.app")).is_err());
            assert!(safe_relative(Path::new("Contents/MacOS/微探")).is_ok());
        }

        #[test]
        fn applies_a_verified_binary_patch() {
            let source = b"before update";
            let target = b"after update with a little more data";
            let mut patch = Vec::new();
            qbsdiff::Bsdiff::new(source, target)
                .compare(Cursor::new(&mut patch))
                .unwrap();
            let mut output = Vec::new();
            qbsdiff::Bspatch::new(&patch)
                .unwrap()
                .apply(source, Cursor::new(&mut output))
                .unwrap();
            assert_eq!(output, target);
            assert!(is_sha256(&sha256(target)));
        }

        #[test]
        fn applies_the_release_bsdiff_format_when_available() {
            let directory = tempfile::tempdir().unwrap();
            let source_path = directory.path().join("source");
            let target_path = directory.path().join("target");
            let patch_path = directory.path().join("update.bsdiff");
            fs::write(&source_path, b"old application bytes").unwrap();
            fs::write(
                &target_path,
                b"new application bytes with a changed feature",
            )
            .unwrap();

            let Ok(result) = Command::new("bsdiff")
                .arg(&source_path)
                .arg(&target_path)
                .arg(&patch_path)
                .output()
            else {
                return;
            };
            assert!(result.status.success());

            let source = fs::read(source_path).unwrap();
            let patch = fs::read(patch_path).unwrap();
            let mut output = Vec::new();
            qbsdiff::Bspatch::new(&patch)
                .unwrap()
                .apply(&source, Cursor::new(&mut output))
                .unwrap();
            assert_eq!(output, fs::read(target_path).unwrap());
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::{check, install};
