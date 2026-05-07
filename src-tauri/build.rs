fn main() {
    println!("cargo:rerun-if-env-changed=WXMP_ACTIVATION_SECRET");
    println!("cargo:rerun-if-changed=../.activation-secret.local");

    let activation_secret = std::env::var("WXMP_ACTIVATION_SECRET")
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .or_else(|| {
            std::fs::read_to_string("../.activation-secret.local")
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
