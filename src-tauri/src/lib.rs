use tauri::{image::Image, tray::TrayIconBuilder, webview::PageLoadEvent};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

mod auth;
mod commands;
mod db;

const LOGIN_WINDOW_LABEL: &str = "wxmp-login";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

/// Sends every external http(s) link to the system browser EXCEPT for the
/// login webview window, which legitimately needs to live on
/// mp.weixin.qq.com.
fn external_navigation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("external-navigation")
        .on_navigation(|webview, url| {
            if webview.label() == LOGIN_WINDOW_LABEL {
                // Login flow handles its own navigation guarding (in auth.rs).
                return true;
            }

            let is_internal_host = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("::1")
            );

            let is_internal = url.scheme() == "tauri" || is_internal_host;
            if is_internal {
                return true;
            }

            let is_external_link = matches!(url.scheme(), "http" | "https" | "mailto" | "tel");
            if is_external_link {
                log::info!("opening external link in system browser: {}", url);
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
                return false;
            }

            true
        })
        .build()
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let tray_icon_bytes = include_bytes!("../icons/tray-icon.png");
    log::info!("tray-icon.png embedded bytes: {}", tray_icon_bytes.len());

    let tray_icon = image::load_from_memory(tray_icon_bytes)
        .map(|img| {
            let rgba = img.to_rgba8();
            let (width, height) = rgba.dimensions();
            log::info!("tray icon decoded: {}x{}", width, height);
            Image::new_owned(rgba.into_raw(), width, height)
        })
        .expect("failed to decode tray-icon.png");

    TrayIconBuilder::with_id("main-tray")
        .icon(tray_icon)
        .icon_as_template(true)
        .tooltip("微信文章抓取")
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(external_navigation_plugin())
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::auth_status,
            commands::open_login,
            commands::list_accounts,
            commands::list_articles,
            commands::get_article,
            commands::cache_db_path,
            commands::fetch_account,
            commands::fetch_article_content,
        ])
        .setup(|app| {
            setup_tray(app)?;
            Ok(())
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!("main webview finished loading");
                let _ = webview.window().show();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
