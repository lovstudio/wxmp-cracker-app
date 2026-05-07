use std::{collections::HashMap, env, fs, path::Path};

const DOTENV_FILES: [&str; 2] = ["../.env", "../.env.local"];
const FRONTEND_ENV_KEYS: [&str; 3] = [
    "VITE_LOVSTUDIO_SUPABASE_URL",
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
];

fn main() {
    println!("cargo:rerun-if-env-changed=WXMP_ACTIVATION_SECRET");
    println!("cargo:rerun-if-changed=../.activation-secret.local");
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

    let activation_secret = env::var("WXMP_ACTIVATION_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            fs::read_to_string("../.activation-secret.local")
                .ok()
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        })
        .expect(
            "WXMP_ACTIVATION_SECRET is required. Set the environment variable or create .activation-secret.local in the project root.",
        );

    println!("cargo:rustc-env=WXMP_ACTIVATION_SECRET={activation_secret}");
    tauri_build::build()
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
