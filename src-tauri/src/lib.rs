use tauri::{
    image::Image,
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    webview::PageLoadEvent,
    Manager,
};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

mod archive;
mod auth;
mod commands;
mod db;
mod github;
mod license;
mod sync;

const LOGIN_WINDOW_LABEL: &str = "wxmp-login";
const RELOAD_MENU_ITEM_ID: &str = "reload_app";
const RESTART_MENU_ITEM_ID: &str = "restart_app";

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

fn build_application_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(app)?;
    let reload = MenuItemBuilder::with_id(RELOAD_MENU_ITEM_ID, "重新载入")
        .accelerator("CmdOrCtrl+R")
        .build(app)?;
    let restart_label = format!("重新启动{}", app.package_info().name);
    let restart = MenuItemBuilder::with_id(RESTART_MENU_ITEM_ID, restart_label).build(app)?;

    #[cfg(target_os = "macos")]
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let insert_at = app_menu.items()?.len().saturating_sub(1);
        let separator = PredefinedMenuItem::separator(app)?;
        app_menu.insert_items(&[&restart, &separator], insert_at)?;
    }

    #[cfg(not(target_os = "macos"))]
    if let Some(MenuItemKind::Submenu(file_menu)) = menu.items()?.into_iter().find(|item| {
        matches!(item, MenuItemKind::Submenu(submenu) if submenu.text().as_deref() == Ok("File"))
    }) {
        let insert_at = file_menu.items()?.len().saturating_sub(1);
        let separator = PredefinedMenuItem::separator(app)?;
        file_menu.insert_items(&[&restart, &separator], insert_at)?;
    }

    let view_menu = menu.items()?.into_iter().find_map(|item| match item {
        MenuItemKind::Submenu(submenu)
            if matches!(submenu.text().as_deref(), Ok("View") | Ok("显示")) =>
        {
            Some(submenu)
        }
        _ => None,
    });

    if let Some(view_menu) = view_menu {
        let separator = PredefinedMenuItem::separator(app)?;
        view_menu.insert_items(&[&reload, &separator], 0)?;
    } else {
        let view_menu = SubmenuBuilder::new(app, "显示").item(&reload).build()?;
        let menu_items = menu.items()?;
        let insert_at = menu_items
            .iter()
            .position(|item| item.id().as_ref() == tauri::menu::WINDOW_SUBMENU_ID)
            .unwrap_or(menu_items.len());
        menu.insert(&view_menu, insert_at)?;
    }

    Ok(menu)
}

fn reload_focused_webview(app: &tauri::AppHandle) {
    let window = app
        .webview_windows()
        .into_values()
        .find(|window| window.is_focused().unwrap_or(false))
        .or_else(|| app.get_webview_window("main"));

    match window {
        Some(window) => {
            log::info!("reloading webview: {}", window.label());
            if let Err(error) = window.reload() {
                log::error!("failed to reload webview {}: {error}", window.label());
            }
        }
        None => log::warn!("reload requested without an available webview"),
    }
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(external_navigation_plugin())
        .menu(build_application_menu)
        .invoke_handler(tauri::generate_handler![
            greet,
            commands::auth_status,
            commands::open_login,
            commands::auth_logout,
            commands::license_status,
            commands::activate_license,
            commands::sync_remote_license,
            commands::list_accounts,
            commands::list_articles,
            commands::search_articles,
            commands::get_article,
            commands::cache_db_path,
            commands::article_local_file,
            commands::open_article_local_file,
            commands::reveal_article_local_file,
            commands::export_article_local,
            commands::resolve_wechat_image,
            commands::search_accounts,
            commands::fetch_account,
            commands::fetch_selected_account,
            commands::cancel_fetch_account,
            commands::fetch_article_content,
            commands::import_article_link,
            commands::github_oauth_start,
            commands::github_oauth_poll,
            commands::github_oauth_status,
            commands::github_oauth_logout,
            commands::github_list_repos,
            commands::github_create_repo,
            commands::github_sync_settings_get,
            commands::reveal_archive_folder,
            commands::github_sync_settings_set,
            commands::github_sync_articles,
            commands::archive_articles_local,
        ])
        .setup(|app| {
            commands::prewarm_wechat_search_client();
            commands::prewarm_wcx_fetch_daemon();
            setup_tray(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            RELOAD_MENU_ITEM_ID => reload_focused_webview(app),
            RESTART_MENU_ITEM_ID => {
                log::info!("application restart requested from menu");
                app.request_restart();
            }
            _ => {}
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
