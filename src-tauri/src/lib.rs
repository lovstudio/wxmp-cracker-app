#[cfg(unix)]
use std::{
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItemBuilder, MenuItemKind, PredefinedMenuItem, SubmenuBuilder},
    tray::TrayIconBuilder,
    webview::PageLoadEvent,
    Manager, WebviewWindowBuilder,
};
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

mod acquisition;
mod archive;
mod auth;
mod commands;
mod db;
mod delta_updater;
mod feishu;
mod github;
mod license;
mod providers;
mod public_metrics;
mod sync;
#[cfg(target_os = "macos")]
mod wechat_account_feed;
#[cfg(target_os = "macos")]
mod wechat_automation;

const LOGIN_WINDOW_LABEL: &str = "wxmp-login";
const RELOAD_MENU_ITEM_ID: &str = "reload_app";
const RESTART_MENU_ITEM_ID: &str = "restart_app";
const DEV_SERVER_PORT: u16 = 4382;

/// Wry probes `com.apple.WebKit` during runtime construction. On current macOS
/// the framework is not registered until it has been loaded at least once, and
/// probing an unregistered bundle can trap inside CoreFoundation before Tauri
/// gets a chance to render an error. Register it explicitly before building the
/// Tauri runtime.
#[cfg(target_os = "macos")]
fn ensure_webkit_bundle_loaded() {
    use objc2_foundation::{ns_string, NSBundle};

    let Some(bundle) =
        NSBundle::bundleWithPath(ns_string!("/System/Library/Frameworks/WebKit.framework"))
    else {
        log::warn!("system WebKit framework bundle was not found");
        return;
    };

    if bundle.isLoaded() {
        return;
    }

    // `NSBundle::load` bridges to Apple's Objective-C API and is marked unsafe
    // by objc2. The path is a fixed, system-owned framework location.
    if !unsafe { bundle.load() } {
        log::warn!("failed to load system WebKit framework before Tauri startup");
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn check_delta_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, delta_updater::DeltaUpdaterState>,
) -> Result<Option<delta_updater::DeltaUpdateMetadata>, String> {
    delta_updater::check(app, state.inner()).await
}

#[tauri::command]
async fn install_delta_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, delta_updater::DeltaUpdaterState>,
) -> Result<(), String> {
    delta_updater::install(app, state.inner()).await
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
        matches!(item, MenuItemKind::Submenu(submenu) if matches!(submenu.text().as_deref(), Ok("File")))
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

#[cfg(unix)]
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn schedule_dev_restart() -> bool {
    let Some(repo_root) = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(Path::to_path_buf)
    else {
        log::error!("failed to resolve repository root for dev restart");
        return false;
    };

    let tauri_cli = repo_root
        .ancestors()
        .map(|ancestor| ancestor.join("node_modules/.bin/tauri"))
        .find(|candidate| candidate.is_file());
    let Some(tauri_cli) = tauri_cli else {
        log::error!(
            "dev restart skipped because no Tauri CLI was found from {} through its ancestors",
            repo_root.display()
        );
        return false;
    };

    let executable = match std::env::current_exe() {
        Ok(executable) => executable,
        Err(error) => {
            log::error!("failed to resolve current executable for dev restart: {error}");
            return false;
        }
    };

    let binary_log = std::env::temp_dir().join("wxmp-cracker-tauri-binary-restart.log");
    let dev_runner_log = std::env::temp_dir().join("wxmp-cracker-tauri-dev-restart.log");
    let executable_args = std::env::args_os()
        .skip(1)
        .map(|argument| shell_single_quote(argument.to_string_lossy().as_ref()))
        .collect::<Vec<_>>()
        .join(" ");
    let script = format!(
        "sleep 2; if /usr/bin/nc -z localhost {DEV_SERVER_PORT} >/dev/null 2>&1; then exec {} {} >> {} 2>&1; else cd {} && exec {} dev >> {} 2>&1; fi",
        shell_single_quote(executable.to_string_lossy().as_ref()),
        executable_args,
        shell_single_quote(binary_log.to_string_lossy().as_ref()),
        shell_single_quote(repo_root.to_string_lossy().as_ref()),
        shell_single_quote(tauri_cli.to_string_lossy().as_ref()),
        shell_single_quote(dev_runner_log.to_string_lossy().as_ref()),
    );

    let mut command = Command::new("sh");
    command
        .arg("-lc")
        .arg(script)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    command.process_group(0);

    match command.spawn() {
        Ok(_) => {
            log::info!(
                "dev restart scheduled, binary_log={}, dev_runner_log={}",
                binary_log.display(),
                dev_runner_log.display()
            );
            true
        }
        Err(error) => {
            log::error!("failed to schedule dev restart: {error}");
            false
        }
    }
}

#[cfg(not(unix))]
fn schedule_dev_restart() -> bool {
    false
}

fn restart_app(app: &tauri::AppHandle) {
    if tauri::is_dev() {
        if schedule_dev_restart() {
            app.exit(0);
        } else {
            log::error!("development restart was cancelled to keep the current app usable");
        }
        return;
    }

    app.request_restart();
}

#[cfg(target_os = "macos")]
fn show_main_window(app: &tauri::AppHandle) {
    if let Err(error) = app.show() {
        log::warn!("failed to reveal app after Dock activation: {error}");
    }

    let window = app.get_webview_window("main").or_else(|| {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|config| config.label == "main")?;

        match WebviewWindowBuilder::from_config(app, config).and_then(|builder| builder.build()) {
            Ok(window) => {
                log::info!("recreated main window after Dock activation");
                Some(window)
            }
            Err(error) => {
                log::error!("failed to recreate main window after Dock activation: {error}");
                None
            }
        }
    });

    let Some(window) = window else {
        log::warn!("Dock activation could not find or recreate the main window");
        return;
    };

    if let Err(error) = window.unminimize() {
        log::warn!("failed to unminimize main window after Dock activation: {error}");
    }
    if let Err(error) = window.show() {
        log::error!("failed to show main window after Dock activation: {error}");
        return;
    }
    if let Err(error) = window.set_focus() {
        log::warn!("failed to focus main window after Dock activation: {error}");
    }

    log::info!("main window restored after Dock activation");
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
    #[cfg(target_os = "macos")]
    ensure_webkit_bundle_loaded();

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
        .manage(delta_updater::DeltaUpdaterState::default())
        .plugin(external_navigation_plugin())
        .menu(build_application_menu)
        .invoke_handler(tauri::generate_handler![
            greet,
            check_delta_update,
            install_delta_update,
            commands::auth_status,
            commands::open_login,
            commands::auth_logout,
            commands::license_status,
            commands::activate_license,
            commands::sync_remote_license,
            commands::list_accounts,
            commands::list_articles,
            commands::list_article_tag_names,
            commands::list_article_management_rows,
            commands::search_articles,
            commands::get_article,
            acquisition::create_article_metrics_acquisition_job,
            acquisition::get_acquisition_job,
            acquisition::list_acquisition_attempts,
            acquisition::list_acquisition_providers,
            public_metrics::get_article_public_metrics,
            public_metrics::capture_article_public_metrics,
            commands::list_article_tags,
            commands::list_all_article_tags,
            commands::list_tag_articles,
            commands::create_article_tag,
            commands::create_and_assign_article_tag,
            commands::update_article_tag,
            commands::delete_article_tag,
            commands::set_article_tag,
            commands::cache_db_path,
            commands::article_local_file,
            commands::open_article_local_file,
            commands::reveal_article_local_file,
            commands::export_article_local,
            commands::export_articles_table,
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
            commands::feishu_settings_get,
            commands::feishu_configure_credentials,
            commands::feishu_settings_set,
            commands::feishu_disconnect,
            commands::feishu_list_spaces,
            commands::feishu_resolve_wiki_target,
            commands::feishu_sync_articles,
        ])
        .setup(|app| {
            commands::prewarm_wechat_search_client();
            commands::prewarm_wcx_daemon();
            setup_tray(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            RELOAD_MENU_ITEM_ID => reload_focused_webview(app),
            RESTART_MENU_ITEM_ID => {
                log::info!("application restart requested from menu");
                restart_app(app);
            }
            _ => {}
        })
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!("main webview finished loading");
                let _ = webview.window().show();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = event
            {
                log::info!("Dock activation requested, has_visible_windows={has_visible_windows}");
                show_main_window(app);
            }

            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
