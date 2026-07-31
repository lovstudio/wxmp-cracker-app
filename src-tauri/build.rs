use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
};

const DOTENV_FILES: [&str; 2] = ["../.env", "../.env.local"];
const ACTIVATION_SECRET_FILE: &str = ".activation-secret.local";
const FRONTEND_ENV_KEYS: [&str; 3] = [
    "VITE_LOVSTUDIO_SUPABASE_URL",
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
];

fn main() {
    let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri must live inside the project root");
    let primary_worktree_root = resolve_primary_worktree_root(project_root);
    let activation_secret_paths =
        activation_secret_paths(project_root, primary_worktree_root.as_deref());

    println!("cargo:rerun-if-env-changed=WXMP_ACTIVATION_SECRET");
    println!("cargo:rerun-if-env-changed=WXMP_GITHUB_CLIENT_ID");
    for path in &activation_secret_paths {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    for path in DOTENV_FILES {
        println!("cargo:rerun-if-changed={path}");
    }
    for key in FRONTEND_ENV_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let frontend_env = load_dotenv_files(&DOTENV_FILES);
    for key in FRONTEND_ENV_KEYS {
        if let Some(value) = env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| frontend_env.get(key).cloned())
        {
            println!("cargo:rustc-env={key}={value}");
        }
    }

    // GitHub OAuth Client ID — optional at build time. If absent, the
    // GitHub-sync UI surfaces a friendly error when the user tries to log in.
    if let Some(client_id) = env::var("WXMP_GITHUB_CLIENT_ID")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| frontend_env.get("WXMP_GITHUB_CLIENT_ID").cloned())
    {
        println!("cargo:rustc-env=WXMP_GITHUB_CLIENT_ID={client_id}");
    }

    let activation_secret = env::var("WXMP_ACTIVATION_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| read_first_non_empty(&activation_secret_paths))
        .expect(
            "WXMP_ACTIVATION_SECRET is required. Set the environment variable or create \
             .activation-secret.local in this worktree or the primary repository worktree.",
        );

    println!("cargo:rustc-env=WXMP_ACTIVATION_SECRET={activation_secret}");
    link_shared_sidecar_if_missing(project_root, primary_worktree_root.as_deref());
    tauri_build::build()
}

fn activation_secret_paths(
    project_root: &Path,
    primary_worktree_root: Option<&Path>,
) -> Vec<PathBuf> {
    let local_path = project_root.join(ACTIVATION_SECRET_FILE);
    let mut paths = vec![local_path.clone()];

    if let Some(primary_root) = primary_worktree_root {
        let shared_path = primary_root.join(ACTIVATION_SECRET_FILE);
        if shared_path != local_path {
            paths.push(shared_path);
        }
    }

    paths
}

fn read_first_non_empty(paths: &[PathBuf]) -> Option<String> {
    paths.iter().find_map(|path| {
        fs::read_to_string(path)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    })
}

fn resolve_primary_worktree_root(project_root: &Path) -> Option<PathBuf> {
    let git_file = project_root.join(".git");
    if !git_file.is_file() {
        return None;
    }

    let git_file_contents = fs::read_to_string(git_file).ok()?;
    let git_dir_value = git_file_contents
        .lines()
        .find_map(|line| line.trim().strip_prefix("gitdir:"))?
        .trim();
    let git_dir = resolve_path(project_root, Path::new(git_dir_value));

    let common_dir_value = fs::read_to_string(git_dir.join("commondir")).ok()?;
    let common_git_dir = resolve_path(&git_dir, Path::new(common_dir_value.trim()));
    common_git_dir.parent().map(Path::to_path_buf)
}

fn resolve_path(base: &Path, path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };

    fs::canonicalize(&joined).unwrap_or(joined)
}

fn link_shared_sidecar_if_missing(project_root: &Path, primary_worktree_root: Option<&Path>) {
    let Some(primary_root) = primary_worktree_root else {
        return;
    };
    if primary_root == project_root {
        return;
    }

    let Ok(target) = env::var("TARGET") else {
        return;
    };
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let file_name = format!("wcx-{target}{extension}");
    let local_path = project_root
        .join("src-tauri")
        .join("binaries")
        .join(&file_name);
    if fs::symlink_metadata(&local_path).is_ok() {
        return;
    }

    let shared_path = primary_root
        .join("src-tauri")
        .join("binaries")
        .join(file_name);
    let Ok(metadata) = fs::metadata(&shared_path) else {
        return;
    };
    if !metadata.is_file() || metadata.len() == 0 {
        return;
    }

    println!("cargo:rerun-if-changed={}", shared_path.display());
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).expect("failed to create the local sidecar directory");
    }
    link_or_copy_file(&shared_path, &local_path)
        .expect("failed to reuse the wcx sidecar from the primary repository worktree");
}

#[cfg(unix)]
fn link_or_copy_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, destination)
        .or_else(|_| fs::copy(source, destination).map(|_| ()))
}

#[cfg(windows)]
fn link_or_copy_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::hard_link(source, destination).or_else(|_| fs::copy(source, destination).map(|_| ()))
}

fn load_dotenv_files(paths: &[&str]) -> HashMap<String, String> {
    let mut values = HashMap::new();

    for path in paths {
        let Ok(contents) = fs::read_to_string(Path::new(path)) else {
            continue;
        };

        for line in contents.lines() {
            if let Some((key, value)) = parse_dotenv_line(line) {
                values.insert(key, value);
            }
        }
    }

    values
}

fn parse_dotenv_line(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }

    let line = line.strip_prefix("export ").unwrap_or(line);
    let (key, value) = line.split_once('=')?;
    let key = key.trim();
    if key.is_empty() {
        return None;
    }

    Some((key.to_string(), parse_dotenv_value(value)))
}

fn parse_dotenv_value(value: &str) -> String {
    let value = value.trim();
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return value[1..value.len() - 1].to_string();
        }
    }

    value.to_string()
}
