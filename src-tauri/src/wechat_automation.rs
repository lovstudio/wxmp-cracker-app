#![cfg(target_os = "macos")]

use chrono::Datelike;
use core_foundation::{
    array::{CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex, CFArrayRef},
    base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef, TCFType},
    boolean::CFBoolean,
    dictionary::{CFDictionary, CFDictionaryRef},
    string::{CFString, CFStringGetTypeID, CFStringRef},
};
use core_graphics::{
    event::{
        CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGKeyCode, CGMouseButton,
        ScrollEventUnit,
    },
    event_source::{CGEventSource, CGEventSourceStateID},
    geometry::{CGPoint, CGRect},
    window::{
        create_image, kCGNullWindowID, kCGWindowImageBoundsIgnoreFraming,
        kCGWindowImageNominalResolution, kCGWindowImageShouldBeOpaque,
        kCGWindowListOptionIncludingWindow, kCGWindowListOptionOnScreenOnly,
    },
};
use foreign_types::ForeignType;
use objc2::{msg_send, runtime::AnyObject};
use objc2_app_kit::NSWorkspace;
use objc2_foundation::NSString;
use std::{
    collections::{BTreeMap, HashSet, VecDeque},
    ffi::c_void,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process::Command,
    ptr, thread,
    time::{Duration, Instant},
};

const WECHAT_BUNDLE_ID: &str = "com.tencent.xinWeChat";
const WECHAT_UI_BUNDLE_ID: &str = "com.tencent.flue.WeChatAppEx";
const MAX_AX_ELEMENTS: usize = 12_000;
const MAX_AX_DEPTH: usize = 20;
const MIN_STRONG_TITLE_PREFIX_CHARS: usize = 18;
const SEARCH_RESULTS_TIMEOUT: Duration = Duration::from_secs(10);
const SEARCH_SUGGESTION_TIMEOUT: Duration = Duration::from_millis(1_600);
const SEARCH_SUGGESTION_NO_WEB_AX_TIMEOUT: Duration = Duration::from_millis(320);
const AX_EXACT_RESULT_TIMEOUT: Duration = Duration::from_millis(900);
const AX_EXACT_RESULT_NO_WEB_AX_TIMEOUT: Duration = Duration::from_millis(180);
const FIRST_RESULT_POLL_INTERVAL: Duration = Duration::from_millis(70);
const FIRST_RESULT_REGION_X_RATIO: f64 = 0.04;
const FIRST_RESULT_REGION_Y_RATIO: f64 = 0.19;
const FIRST_RESULT_REGION_WIDTH_RATIO: f64 = 0.68;
const FIRST_RESULT_REGION_HEIGHT_RATIO: f64 = 0.10;
const FIRST_ARTICLE_REGION_Y_RATIO: f64 = 0.18;
const FIRST_ARTICLE_REGION_HEIGHT_RATIO: f64 = 0.62;
const ARTICLES_TAB_X_RATIO: f64 = 0.30;
// WeChat's local Search bundle defines the normalized global-entry order as
// AI Search, All, Official Accounts, Moments, ... . At the current fixed
// browser width the Official Accounts entry is centred at 28%. The target
// fakeid in the resulting batch remains the authoritative postcondition.
const ACCOUNT_TAB_X_RATIO: f64 = 0.28;
const ARTICLES_TAB_Y_RATIO: f64 = 0.15;
// Account search has a second fixed strip: All, Mini Programs, Official
// Accounts, Service Accounts, Channels. Selecting the third entry excludes
// similarly named video/mixed accounts before we open any profile.
const OFFICIAL_ACCOUNT_FILTER_X_RATIO: f64 = 0.23;
const OFFICIAL_ACCOUNT_FILTER_Y_RATIO: f64 = 0.205;
const SEARCH_VERTICAL_LEFT_X_RATIO: f64 = 0.035;
const ACCOUNT_RESULT_REGION_Y_RATIO: f64 = 0.23;
const ACCOUNT_RESULT_REGION_HEIGHT_RATIO: f64 = 0.60;
const FIRST_RESULT_MIN_INK_PER_MILLE: usize = 10;
const FIRST_RESULT_MIN_LIGHT_PER_MILLE: usize = 500;
const FIRST_RESULT_INK_CHANNEL_TOTAL_MAX: usize = 660;
const FIRST_RESULT_LIGHT_CHANNEL_TOTAL_MIN: usize = 720;
const FIRST_RESULT_CLICK_TARGET_TIMEOUT: Duration = Duration::from_millis(800);
const FIRST_RESULT_TRANSITION_TIMEOUT: Duration = Duration::from_millis(600);
const FIRST_RESULT_TRANSITION_DELTA_PER_MILLE: usize = 20;
const RESULT_CLICK_TRANSITION_TIMEOUT: Duration = Duration::from_millis(360);
const RESULT_CLICK_RETRIES: usize = 1;
const ACCOUNT_PROFILE_TIMEOUT: Duration = Duration::from_millis(900);
const ACCOUNT_SEARCH_TIMEOUT: Duration = Duration::from_secs(3);
const MAX_INDEXEDDB_APPEND_BYTES: u64 = 8 * 1024 * 1024;

type AXError = i32;
const AX_ERROR_SUCCESS: AXError = 0;

#[repr(C)]
struct __AXUIElement(c_void);
type AXUIElementRef = *mut __AXUIElement;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef)
        -> bool;
    fn AXUIElementCreateApplication(pid: i32) -> AXUIElementRef;
    fn AXUIElementCreateSystemWide() -> AXUIElementRef;
    fn AXUIElementCopyElementAtPosition(
        application: AXUIElementRef,
        x: f32,
        y: f32,
        element: *mut AXUIElementRef,
    ) -> AXError;
    fn AXUIElementCopyAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: *mut CFTypeRef,
    ) -> AXError;
    fn AXUIElementSetAttributeValue(
        element: AXUIElementRef,
        attribute: CFStringRef,
        value: CFTypeRef,
    ) -> AXError;
    fn AXUIElementPerformAction(element: AXUIElementRef, action: CFStringRef) -> AXError;
    fn AXValueGetType(value: *const c_void) -> u32;
    fn AXValueGetValue(value: *const c_void, value_type: u32, value_ptr: *mut c_void) -> bool;
    fn CFDictionaryGetValue(dictionary: CFDictionaryRef, key: *const c_void) -> *const c_void;
    fn CFNumberGetValue(number: *const c_void, number_type: u32, value_ptr: *mut c_void) -> bool;
    fn CGEventKeyboardSetUnicodeString(
        event: core_graphics::sys::CGEventRef,
        length: usize,
        string: *const u16,
    );
    fn CFBooleanGetValue(boolean: *const c_void) -> bool;
}

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    static kCGWindowBounds: CFStringRef;
    static kCGWindowLayer: CFStringRef;
    static kCGWindowIsOnscreen: CFStringRef;
    static kCGWindowNumber: CFStringRef;
    static kCGWindowOwnerName: CFStringRef;
    static kCGWindowOwnerPID: CFStringRef;
    static kCGWindowName: CFStringRef;
    fn CGWindowListCopyWindowInfo(option: u32, relative_to_window: u32) -> CFArrayRef;
    fn CGRectMakeWithDictionaryRepresentation(
        dictionary: CFDictionaryRef,
        rect: *mut CGRect,
    ) -> bool;
    fn CGSessionCopyCurrentDictionary() -> CFDictionaryRef;
}

struct AxElement(AXUIElementRef);

impl AxElement {
    unsafe fn from_create_rule(value: AXUIElementRef) -> Option<Self> {
        (!value.is_null()).then_some(Self(value))
    }

    unsafe fn from_borrowed(value: AXUIElementRef) -> Option<Self> {
        if value.is_null() {
            return None;
        }
        CFRetain(value as CFTypeRef);
        Some(Self(value))
    }
}

impl Clone for AxElement {
    fn clone(&self) -> Self {
        unsafe { CFRetain(self.0 as CFTypeRef) };
        Self(self.0)
    }
}

impl Drop for AxElement {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) };
    }
}

struct AxNode {
    element: AxElement,
    role: String,
    text: String,
}

struct WechatProcesses {
    main_pid: i32,
    ui_pids: Vec<i32>,
    previous_pid: i32,
}

pub struct WechatArticleSearchTarget<'a> {
    pub title: &'a str,
    pub publisher: Option<&'a str>,
    pub fakeid: &'a str,
    pub published_at: i64,
}

pub struct WechatArticleSearchSession {
    wechat_pid: i32,
    wechat_window_pids: Vec<i32>,
    previous_pid: i32,
    owned_window_ids: Vec<i32>,
    account_feed_window_id: Option<i32>,
    finished: bool,
}

impl WechatArticleSearchSession {
    /// Scrolls the already-open account profile to its current bottom. WeChat
    /// then requests the next account-feed page and writes another batch of
    /// article metrics to XWorker IndexedDB. This method never opens or
    /// searches for an individual article.
    pub fn load_next_account_feed_page(&mut self) -> Result<(), String> {
        let window_id = self
            .account_feed_window_id
            .ok_or_else(|| "当前微信会话不是公众号文章列表页".to_string())?;
        refresh_wechat_window_pids(self.wechat_pid, &mut self.wechat_window_pids);
        let window = wechat_web_windows(&self.wechat_window_pids, false)
            .into_iter()
            .find(|candidate| candidate.id == window_id)
            .ok_or_else(|| "微信公众号文章列表窗口已关闭".to_string())?;
        let verification_point = CGPoint::new(
            window.frame.origin.x + window.frame.size.width / 2.0,
            window.frame.origin.y + window.frame.size.height / 2.0,
        );
        if !wait_until_result_window_is_frontmost(
            &self.wechat_window_pids,
            window,
            verification_point,
            Duration::from_millis(700),
        ) {
            return Err("微信公众号文章列表窗口未处于可操作状态".to_string());
        }
        // A process-targeted wheel event reaches the account webview even when
        // Chromium keeps keyboard focus on a hidden search field. The large
        // bounded delta reaches the current bottom; the page's own
        // serverScrollToBottom handler requests exactly one next feed page.
        let scroll_point = CGPoint::new(
            window.frame.origin.x + window.frame.size.width * 0.62,
            window.frame.origin.y + window.frame.size.height * 0.82,
        );
        post_scroll_down_at(scroll_point, 80)?;
        log::info!(
            "[DEBUG][wechat_automation] account feed next page requested window_id={window_id}"
        );
        Ok(())
    }

    pub fn finish(mut self, close_owned_page: bool) {
        if close_owned_page {
            if self.owned_window_ids.is_empty() {
                log::info!(
                    "[DEBUG][wechat_automation] task page cleanup skipped reason=shared-window"
                );
            }
            for window_id in self.owned_window_ids.iter().rev().copied() {
                let closed = close_owned_wechat_window(&self.wechat_window_pids, window_id);
                log::info!(
                    "[DEBUG][wechat_automation] task page cleanup window_id={window_id} closed={closed}"
                );
            }
        }
        restore_previous_application(self.previous_pid, self.wechat_pid);
        self.finished = true;
    }
}

impl Drop for WechatArticleSearchSession {
    fn drop(&mut self) {
        if !self.finished {
            restore_previous_application(self.previous_pid, self.wechat_pid);
        }
    }
}

#[derive(Clone, Copy)]
struct WechatWebWindow {
    id: i32,
    owner_pid: i32,
    frame: CGRect,
    is_main_surface: bool,
    is_delegated_web_window: bool,
    is_on_screen: bool,
    is_account_search_surface: bool,
    is_other_search_surface: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccountIdentityObservation {
    Matched,
    Mismatched,
    Unobserved,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AccountSearchSurfaceObservation {
    Matched,
    Mismatched,
    Unobserved,
}

pub fn accessibility_trusted(prompt: bool) -> bool {
    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let value = if prompt {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
    unsafe { AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) }
}

pub fn interactive_session_available() -> bool {
    let dictionary = unsafe { CGSessionCopyCurrentDictionary() };
    if dictionary.is_null() {
        return true;
    }
    let key = CFString::from_static_string("CGSSessionScreenIsLocked");
    let value =
        unsafe { CFDictionaryGetValue(dictionary, key.as_concrete_TypeRef() as *const c_void) };
    let locked = !value.is_null() && unsafe { CFBooleanGetValue(value) };
    unsafe { CFRelease(dictionary as CFTypeRef) };
    !locked
}

/// Opens the target account feed through WeChat's own authenticated Search UI.
///
/// This is intentionally an AX/keyboard fallback instead of OCR. It is used
/// only when no matching account-feed snapshot exists locally. WeChat performs
/// the account search with its own logged-in native session; the caller then
/// reads all article rows and counters written by that one account page. The
/// account-scoped route never performs a second title search or opens an
/// individual article.
pub fn open_article_via_search(
    target: &WechatArticleSearchTarget<'_>,
) -> Result<WechatArticleSearchSession, String> {
    let operation_started = Instant::now();
    let title = target.title.trim();
    if title.is_empty() {
        return Err("文章标题为空，无法调用微信搜索".to_string());
    }
    let publisher = target
        .publisher
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let account_scoped = publisher.is_some() && !target.fakeid.trim().is_empty();
    let query = if account_scoped {
        publisher.expect("account-scoped route requires publisher")
    } else {
        title
    };
    log::info!(
        "wechat automatic article search started (query_chars={}, route={})",
        query.chars().count(),
        if account_scoped {
            "account-scoped"
        } else {
            "title-fallback"
        }
    );
    log::info!(
        "[DEBUG][wechat_automation] entry title_chars={} publisher_chars={} has_fakeid={} has_publish_date={} route={}",
        title.chars().count(),
        publisher.map(str::len).unwrap_or_default(),
        !target.fakeid.trim().is_empty(),
        target.published_at > 0,
        if account_scoped {
            "account-scoped"
        } else {
            "title-fallback"
        }
    );
    if !accessibility_trusted(false) {
        log::info!("requesting Accessibility permission for automatic WeChat search");
        let _ = accessibility_trusted(true);
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            if accessibility_trusted(false) {
                break;
            }
        }
        if !accessibility_trusted(false) {
            log::warn!("Accessibility permission was not granted before the request timed out");
            return Err(
                "自动检索需要微探的“辅助功能”权限；请在系统提示中允许微探后重新更新。".to_string(),
            );
        }
        log::info!("Accessibility permission granted; continuing the same capture request");
    }
    if !interactive_session_available() {
        log::warn!("[DEBUG][wechat_automation] blocked because the macOS session is locked");
        return Err("Mac 当前处于锁屏状态；解锁后可自动打开目标文章并获取互动数据。".to_string());
    }

    let processes = ensure_running_application_pids()?;
    let wechat_pid = processes.main_pid;
    let mut wechat_window_pids = processes.ui_pids.clone();
    wechat_window_pids.sort_unstable();
    wechat_window_pids.dedup();
    wechat_window_pids.retain(|pid| *pid != wechat_pid);
    // `wechat_web_windows` uses the final element to distinguish the main
    // client from delegated WeChatAppEx browser hosts.
    wechat_window_pids.push(wechat_pid);
    log::info!(
        "automatic WeChat search resolved processes (wechat_pid={wechat_pid}, ui_pids={:?}, previous_pid={})",
        processes.ui_pids,
        processes.previous_pid
    );
    let mut login_required =
        unsafe { AxElement::from_create_rule(AXUIElementCreateApplication(wechat_pid)) }
            .is_some_and(|app| wechat_login_required(&app));
    if !login_required {
        // QR/login content can live in WeChatAppEx rather than the main
        // process. Only accept explicit text markers from delegated hosts;
        // their compact utility windows are not login evidence by themselves.
        login_required = processes.ui_pids.iter().copied().any(|pid| {
            unsafe { AxElement::from_create_rule(AXUIElementCreateApplication(pid)) }
                .and_then(|app| collect_ax_nodes(&app).ok())
                .is_some_and(|nodes| wechat_login_text_markers(&nodes) >= 2)
        });
    }
    if login_required {
        // If an earlier interrupted attempt left WeChat's compact search
        // sheet over the login shell, dismiss only that sheet. Escape is a
        // no-op on the plain QR screen and never creates a window.
        let overlay_dismissed = post_key(wechat_pid, 53, CGEventFlags::empty()).is_ok();
        if overlay_dismissed {
            thread::sleep(Duration::from_millis(80));
        }
        log::warn!(
            "[DEBUG][wechat_automation] navigation blocked because WeChat is on the login screen overlay_dismissed={overlay_dismissed}"
        );
        return Err("本机微信当前停在二维码登录页；请先登录微信，再更新文章互动数据。".to_string());
    }
    // The public Cmd-F flow is the only path that consistently presents a
    // real search window in WeChat 4.x. Activate once before taking the
    // baseline so the later window diff is caused by this search, not by the
    // application activation itself.
    activate_wechat_for_keyboard_search(&processes);

    let baseline_web_windows = wechat_web_windows(&wechat_window_pids, false);
    let baseline_web_window_ids = baseline_web_windows
        .iter()
        .map(|window| window.id)
        .collect::<HashSet<_>>();
    let baseline_web_window_samples = baseline_web_windows
        .into_iter()
        .filter(|window| window.is_on_screen)
        .filter_map(|window| {
            first_result_render_sample(window)
                .ok()
                .map(|sample| (window.id, sample))
        })
        .collect::<BTreeMap<_, _>>();
    let mut task_window_ids = HashSet::new();
    let mut account_feed_window_id = None;
    let result = (|| -> Result<(), String> {
        let mut ax_apps = Vec::new();
        let mut web_accessibility_enabled = false;
        for pid in processes
            .ui_pids
            .iter()
            .copied()
            .chain(std::iter::once(wechat_pid))
        {
            if let Some(app) =
                unsafe { AxElement::from_create_rule(AXUIElementCreateApplication(pid)) }
            {
                web_accessibility_enabled |= enable_web_accessibility(&app, pid);
                let window_count = copy_element_array_attr(&app, "AXWindows").len();
                log::debug!("WeChat Accessibility candidate (pid={pid}, windows={window_count})");
                log::info!(
                    "[DEBUG][wechat_automation] AX candidate pid={pid} windows={window_count}"
                );
                ax_apps.push((pid, app));
            }
        }
        if ax_apps.is_empty() {
            return Err("无法连接本机微信的辅助功能界面".to_string());
        }
        if web_accessibility_enabled {
            // Chromium populates its AX web tree asynchronously after either
            // application-level accessibility attribute is enabled.
            thread::sleep(Duration::from_millis(80));
        }

        for (_, app) in &ax_apps {
            focus_main_wechat_window(app);
        }
        let (search_field, input_pid) = open_wechat_search(&ax_apps, wechat_pid)?;
        log::info!("WeChat search field resolved through Accessibility (owner_pid={input_pid})");
        set_text_value(&search_field, query, input_pid)?;
        log::info!(
            "[DEBUG][wechat_automation] query written owner_pid={input_pid} elapsed_ms={}",
            operation_started.elapsed().as_millis()
        );
        log::info!(
            "{} submitted to WeChat search",
            if account_scoped {
                "official account name"
            } else {
                "exact article title"
            }
        );

        let suggestion_timeout = if web_accessibility_enabled {
            SEARCH_SUGGESTION_TIMEOUT
        } else {
            SEARCH_SUGGESTION_NO_WEB_AX_TIMEOUT
        };
        let suggestion_deadline = Instant::now() + suggestion_timeout;
        let search_entry_pressed = loop {
            if press_web_search_entry_in_apps(&ax_apps, query)? {
                break true;
            }
            if Instant::now() >= suggestion_deadline {
                break false;
            }
            thread::sleep(Duration::from_millis(80));
        };
        if !search_entry_pressed {
            // WeChat 4.x keeps the live “搜一搜” row out of the AX tree until
            // keyboard selection moves off the search field.
            log::info!("web-search AX row not exposed; selecting WeChat's first search suggestion");
            post_key(input_pid, 125, CGEventFlags::empty())?; // Down Arrow
            thread::sleep(Duration::from_millis(180));
            post_key(input_pid, 36, CGEventFlags::empty())?;
            log::info!("[DEBUG][wechat_automation] web search invoked by Down+Enter fallback");
        } else {
            log::info!("WeChat web-search entry activated through Accessibility");
            log::info!("[DEBUG][wechat_automation] web search AX entry pressed");
        }

        if !account_scoped {
            // WeChat often exposes the exact result as a structured AXSheet row
            // before (or instead of) creating its Chromium search popup. Prefer
            // that semantic row over any pixel path. Resolve the row first, then
            // dispatch exactly one activation; never click inside this poll loop.
            let ax_result_timeout = if web_accessibility_enabled {
                AX_EXACT_RESULT_TIMEOUT
            } else {
                AX_EXACT_RESULT_NO_WEB_AX_TIMEOUT
            };
            let ax_result_deadline = Instant::now() + ax_result_timeout;
            let exact_ax_frame = loop {
                if let Some(frame) = exact_title_ax_candidate_frame(&ax_apps, target) {
                    break Some(frame);
                }
                if Instant::now() >= ax_result_deadline {
                    break None;
                }
                thread::sleep(Duration::from_millis(60));
            };
            if let Some(frame) = exact_ax_frame {
                log::info!(
                    "[DEBUG][wechat_automation] exact AX search result resolved x={} y={} width={} height={} elapsed_ms={}",
                    frame.origin.x.round(),
                    frame.origin.y.round(),
                    frame.size.width.round(),
                    frame.size.height.round(),
                    operation_started.elapsed().as_millis()
                );
                if click_exact_article_result_in_apps(&ax_apps, target, frame, Some(wechat_pid))? {
                    if let Some(window_id) = wait_for_single_new_wechat_web_window_id(
                        &wechat_window_pids,
                        &baseline_web_window_ids,
                        Duration::from_millis(700),
                    ) {
                        task_window_ids.insert(window_id);
                    }
                    log::info!(
                        "[DEBUG][wechat_automation] exact AX result activation dispatched owned_windows={} elapsed_ms={}",
                        task_window_ids.len(),
                        operation_started.elapsed().as_millis()
                    );
                    return Ok(());
                }
            }
        }

        let results_started = Instant::now();
        let deadline = Instant::now() + SEARCH_RESULTS_TIMEOUT;
        let mut result_window = None;
        let mut result_selected_at = None;
        let mut account_query_submitted = false;
        let mut semantic_attempts = 0_usize;
        let mut sheet_semantic_attempts = 0_usize;
        let sheet_semantic_delays = [180_u64, 520, 1_000, 1_800, 3_000, 4_600];
        while Instant::now() < deadline {
            if let Ok(current) = running_application_pids() {
                wechat_window_pids = current.ui_pids;
                wechat_window_pids.sort_unstable();
                wechat_window_pids.dedup();
                wechat_window_pids.retain(|pid| *pid != wechat_pid);
                wechat_window_pids.push(wechat_pid);
            }
            for pid in wechat_window_pids.iter().copied() {
                if ax_apps.iter().any(|(known_pid, _)| *known_pid == pid) {
                    continue;
                }
                if let Some(app) =
                    unsafe { AxElement::from_create_rule(AXUIElementCreateApplication(pid)) }
                {
                    web_accessibility_enabled |= enable_web_accessibility(&app, pid);
                    ax_apps.push((pid, app));
                }
            }

            if !account_scoped
                && sheet_semantic_attempts < sheet_semantic_delays.len()
                && results_started.elapsed()
                    >= Duration::from_millis(sheet_semantic_delays[sheet_semantic_attempts])
            {
                sheet_semantic_attempts += 1;
                if let Some(frame) = exact_title_ax_candidate_frame(&ax_apps, target) {
                    log::info!(
                        "[DEBUG][wechat_automation] exact AX sheet candidate resolved attempts={sheet_semantic_attempts} elapsed_ms={}",
                        results_started.elapsed().as_millis()
                    );
                    if click_exact_article_result_in_apps(
                        &ax_apps,
                        target,
                        frame,
                        Some(wechat_pid),
                    )? {
                        let (current_pids, new_window_id) = wait_for_dynamic_new_wechat_window_id(
                            wechat_pid,
                            &baseline_web_window_ids,
                            Duration::from_millis(900),
                        );
                        wechat_window_pids = current_pids;
                        if let Some(window_id) = new_window_id {
                            task_window_ids.insert(window_id);
                        }
                        log::info!(
                            "[DEBUG][wechat_automation] exact AX sheet result activated owned_window={} elapsed_ms={}",
                            !task_window_ids.is_empty(),
                            results_started.elapsed().as_millis()
                        );
                        return Ok(());
                    }
                }
            }

            if result_window.is_none() {
                result_window = preferred_wechat_result_window(
                    &wechat_window_pids,
                    &baseline_web_window_ids,
                    &baseline_web_window_samples,
                    account_scoped,
                    results_started.elapsed() >= Duration::from_secs(2),
                );
                if let Some(window) = result_window {
                    let newly_created = !baseline_web_window_ids.contains(&window.id);
                    let changed_by_search = baseline_web_window_samples
                        .get(&window.id)
                        .is_some_and(|before| {
                            first_result_render_sample(window)
                                .is_ok_and(|after| first_result_render_changed(*before, after))
                        });
                    // A reused browser popup is still ours to clean up when
                    // this search materially changed its surface. Do not claim
                    // an unchanged pre-existing article window selected only
                    // by the final timeout fallback.
                    let claimed_by_operation = newly_created || changed_by_search;
                    if claimed_by_operation {
                        task_window_ids.insert(window.id);
                    }
                    let owner_activated = activate_application(window.owner_pid).is_ok()
                        || activate_application_by_pid_with_system_events(window.owner_pid);
                    let apple_event_activated =
                        !owner_activated && activate_wechat_by_apple_event();
                    let raised =
                        focus_wechat_window_matching_frame(&wechat_window_pids, window.frame);
                    result_selected_at = Some(Instant::now());
                    log::info!(
                        "[DEBUG][wechat_automation] result window selected id={} owner_pid={} newly_created={newly_created} changed_by_search={changed_by_search} claimed_by_operation={claimed_by_operation} owner_activated={owner_activated} apple_event_activated={apple_event_activated} raised={raised} elapsed_ms={}",
                        window.id,
                        window.owner_pid,
                        results_started.elapsed().as_millis()
                    );
                }
            }

            let Some(mut window) = result_window else {
                thread::sleep(FIRST_RESULT_POLL_INTERVAL);
                continue;
            };
            if let Some(refreshed) = wechat_web_windows(&wechat_window_pids, false)
                .into_iter()
                .find(|candidate| candidate.id == window.id)
            {
                window = refreshed;
                result_window = Some(refreshed);
            }

            if account_scoped {
                let ready = first_result_visible_render_sample(&wechat_window_pids, window)
                    .is_ok_and(FirstResultRenderSample::ready);
                if !ready && !account_query_submitted {
                    let selected_long_enough = result_selected_at.is_some_and(|selected_at| {
                        selected_at.elapsed() >= Duration::from_millis(250)
                    });
                    if !selected_long_enough {
                        thread::sleep(FIRST_RESULT_POLL_INTERVAL);
                        continue;
                    }
                    submit_account_query_in_web_search(&wechat_window_pids, window, query)?;
                    account_query_submitted = true;
                    thread::sleep(Duration::from_millis(160));
                    continue;
                }
                if !ready {
                    thread::sleep(FIRST_RESULT_POLL_INTERVAL);
                    continue;
                }
                account_feed_window_id = Some(open_account_feed_from_search(
                    target,
                    wechat_pid,
                    &mut wechat_window_pids,
                    window,
                    &baseline_web_window_ids,
                    &mut task_window_ids,
                    operation_started,
                )?);
                return Ok(());
            }

            // If Chromium rejected both application-level AX switches, its
            // result DOM is structurally unavailable in this process. Keep a
            // single fast native-AX attempt, then use the bounded Articles
            // fallback instead of burning several seconds on identical polls.
            let semantic_delays: &[u64] = if web_accessibility_enabled {
                &[120, 420, 900, 1_500]
            } else {
                &[120]
            };
            let ready_for_attempt = semantic_attempts < semantic_delays.len()
                && result_selected_at.is_some_and(|selected_at| {
                    selected_at.elapsed()
                        >= Duration::from_millis(semantic_delays[semantic_attempts])
                });
            if ready_for_attempt {
                for pid in wechat_window_pids.iter().copied() {
                    if ax_apps.iter().any(|(known_pid, _)| *known_pid == pid) {
                        continue;
                    }
                    if let Some(app) =
                        unsafe { AxElement::from_create_rule(AXUIElementCreateApplication(pid)) }
                    {
                        web_accessibility_enabled |= enable_web_accessibility(&app, pid);
                        ax_apps.push((pid, app));
                    }
                }
                semantic_attempts += 1;
                if click_exact_article_result_in_apps(
                    &ax_apps,
                    target,
                    window.frame,
                    Some(window.owner_pid),
                )? || click_exact_article_result_by_point_scan(
                    target,
                    window.frame,
                    Some(window.owner_pid),
                )? {
                    let (current_pids, new_window_id) = wait_for_dynamic_new_wechat_window_id(
                        wechat_pid,
                        &baseline_web_window_ids,
                        Duration::from_millis(900),
                    );
                    wechat_window_pids = current_pids;
                    if let Some(window_id) = new_window_id {
                        task_window_ids.insert(window_id);
                    }
                    log::info!(
                        "[DEBUG][wechat_automation] exact semantic result activated attempts={semantic_attempts} elapsed_ms={}",
                        results_started.elapsed().as_millis()
                    );
                    return Ok(());
                }
                log::info!(
                    "[DEBUG][wechat_automation] exact semantic result pending attempts={semantic_attempts} elapsed_ms={}",
                    results_started.elapsed().as_millis()
                );
                if semantic_attempts == semantic_delays.len() {
                    break;
                }
            }
            thread::sleep(FIRST_RESULT_POLL_INTERVAL);
        }

        // Current WeChat 4.x builds expose only the Chromium window chrome to
        // macOS Accessibility, not the result-card DOM. The exact backend
        // identity and exact-title query have already constrained this search.
        // As a bounded fallback, switch once to the Articles vertical and
        // click only its first green article title. The caller still accepts
        // the operation only when the changed cache entry matches the target
        // `biz/mid/idx`; a wrong first result is therefore never persisted and
        // this function never starts a second search.
        if !account_scoped {
            if let Some(window) = result_window {
                let before_tab = first_result_visible_render_sample(&wechat_window_pids, window)
                    .map_err(|error| format!("微信文章搜索结果尚未完成渲染（{error}）"))?;
                let articles_selected =
                    press_articles_tab_by_point_probe(&wechat_window_pids, window, before_tab)?;
                log::info!(
                "[DEBUG][wechat_automation] guarded first-article fallback articles_selected={articles_selected} elapsed_ms={}",
                results_started.elapsed().as_millis()
            );
                if articles_selected {
                    let locator_deadline = Instant::now() + Duration::from_millis(1_500);
                    let first_article = loop {
                        if let Some(target) =
                            first_article_green_click_target(&wechat_window_pids, window)
                        {
                            break Some(target);
                        }
                        if Instant::now() >= locator_deadline {
                            break None;
                        }
                        thread::sleep(FIRST_RESULT_POLL_INTERVAL);
                    };
                    if let Some(target) = first_article {
                        log::info!(
                        "[DEBUG][wechat_automation] guarded first article resolved x={} y={} skipped_quick_answer={} screen_capture={} elapsed_ms={}",
                        target.point.x.round(),
                        target.point.y.round(),
                        target.skipped_quick_answer,
                        target.used_screen_capture,
                        results_started.elapsed().as_millis()
                    );
                        if wait_until_result_window_is_frontmost(
                            &wechat_window_pids,
                            window,
                            target.point,
                            FIRST_RESULT_CLICK_TARGET_TIMEOUT,
                        ) {
                            let before_article =
                                first_result_visible_render_sample(&wechat_window_pids, window)
                                    .map_err(|error| {
                                        format!("微信首篇文章点击前无法确认页面状态（{error}）")
                                    })?;
                            let windows_before_click = wechat_web_window_ids(&wechat_window_pids);
                            post_left_click(target.point, None)?;
                            let transitioned = wait_for_first_result_transition(
                                &wechat_window_pids,
                                window,
                                before_article,
                                &windows_before_click,
                                Duration::from_millis(900),
                            );
                            log::info!(
                            "[DEBUG][wechat_automation] guarded first article click transitioned={transitioned} elapsed_ms={}",
                            results_started.elapsed().as_millis()
                        );
                            if transitioned {
                                let (current_pids, new_window_id) =
                                    wait_for_dynamic_new_wechat_window_id(
                                        wechat_pid,
                                        &baseline_web_window_ids,
                                        Duration::from_millis(900),
                                    );
                                wechat_window_pids = current_pids;
                                if let Some(window_id) = new_window_id {
                                    task_window_ids.insert(window_id);
                                }
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }

        log_article_result_diagnostics(&ax_apps, query);
        Err(if account_scoped {
            "微信公众号搜索结果未在限定时间内完成渲染；本次未点击任何文章。".to_string()
        } else {
            "微信搜索结果已显示，但没有找到标题与公众号均匹配的文章；本次未点击任何结果。"
                .to_string()
        })
    })();

    match result {
        Ok(()) => {
            refresh_wechat_window_pids(wechat_pid, &mut wechat_window_pids);
            register_new_operation_windows(
                &wechat_window_pids,
                &baseline_web_window_ids,
                &mut task_window_ids,
            );
            let mut owned_window_ids = task_window_ids.into_iter().collect::<Vec<_>>();
            owned_window_ids.sort_unstable();
            log::info!(
                "[DEBUG][wechat_automation] click phase success elapsed_ms={} owned_windows={}",
                operation_started.elapsed().as_millis(),
                owned_window_ids.len()
            );
            Ok(WechatArticleSearchSession {
                wechat_pid,
                wechat_window_pids,
                previous_pid: processes.previous_pid,
                owned_window_ids,
                account_feed_window_id,
                finished: false,
            })
        }
        Err(error) => {
            let search_dismissed = post_key(wechat_pid, 53, CGEventFlags::empty()).is_ok();
            if search_dismissed {
                thread::sleep(Duration::from_millis(120));
            }
            log::info!(
                "[DEBUG][wechat_automation] failed search overlay cleanup dismissed={search_dismissed}"
            );
            refresh_wechat_window_pids(wechat_pid, &mut wechat_window_pids);
            register_new_operation_windows(
                &wechat_window_pids,
                &baseline_web_window_ids,
                &mut task_window_ids,
            );
            let mut owned_window_ids = task_window_ids.into_iter().collect::<Vec<_>>();
            owned_window_ids.sort_unstable();
            for window_id in owned_window_ids.into_iter().rev() {
                let closed = close_owned_wechat_window(&wechat_window_pids, window_id);
                log::info!(
                    "[DEBUG][wechat_automation] failed search cleanup window_id={window_id} closed={closed}"
                );
            }
            restore_previous_application(processes.previous_pid, wechat_pid);
            log::warn!("automatic WeChat article search failed: {error}");
            log::warn!(
                "[DEBUG][wechat_automation] exit failed elapsed_ms={} error={error}",
                operation_started.elapsed().as_millis()
            );
            Err(error)
        }
    }
}

fn running_application_pids() -> Result<WechatProcesses, String> {
    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let raw_workspace = &*workspace as *const _ as *mut AnyObject;
        let frontmost: *mut AnyObject = msg_send![raw_workspace, frontmostApplication];
        let previous_pid = if frontmost.is_null() {
            0
        } else {
            msg_send![frontmost, processIdentifier]
        };
        let apps: *mut AnyObject = msg_send![raw_workspace, runningApplications];
        if apps.is_null() {
            return Err("无法读取正在运行的应用列表".to_string());
        }
        let count: usize = msg_send![apps, count];
        let mut main_pid = None;
        let mut ui_pids = Vec::new();
        for index in 0..count {
            let app: *mut AnyObject = msg_send![apps, objectAtIndex: index];
            if app.is_null() {
                continue;
            }
            let bundle: *mut NSString = msg_send![app, bundleIdentifier];
            if bundle.is_null() {
                continue;
            }
            let bundle = (*bundle).to_string();
            let pid: i32 = msg_send![app, processIdentifier];
            if bundle == WECHAT_BUNDLE_ID {
                main_pid = Some(pid);
            } else if bundle == WECHAT_UI_BUNDLE_ID {
                ui_pids.push(pid);
            }
        }
        if let Some(main_pid) = main_pid {
            ui_pids.sort_unstable();
            ui_pids.dedup();
            return Ok(WechatProcesses {
                main_pid,
                ui_pids,
                previous_pid,
            });
        }
    }
    Err("本机微信未运行，请先登录微信".to_string())
}

fn ensure_running_application_pids() -> Result<WechatProcesses, String> {
    if let Ok(processes) = running_application_pids() {
        if !processes.ui_pids.is_empty() {
            return Ok(processes);
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(250));
            if let Ok(processes) = running_application_pids() {
                if !processes.ui_pids.is_empty() {
                    return Ok(processes);
                }
            }
        }
        return running_application_pids();
    }

    log::info!("WeChat is not running; launching it for automatic article search");
    let status = Command::new("/usr/bin/open")
        .args(["-b", WECHAT_BUNDLE_ID])
        .status()
        .map_err(|_| "本机微信未运行，且自动启动失败".to_string())?;
    if !status.success() {
        return Err("本机微信未运行，且自动启动失败".to_string());
    }

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(250));
        if let Ok(pids) = running_application_pids() {
            return Ok(pids);
        }
    }
    Err("已尝试自动启动本机微信，但微信未在 15 秒内就绪".to_string())
}

fn activate_application(pid: i32) -> Result<(), String> {
    unsafe {
        let workspace = NSWorkspace::sharedWorkspace();
        let raw_workspace = &*workspace as *const _ as *mut AnyObject;
        let apps: *mut AnyObject = msg_send![raw_workspace, runningApplications];
        if apps.is_null() {
            return Err("无法读取正在运行的应用列表".to_string());
        }
        let count: usize = msg_send![apps, count];
        for index in 0..count {
            let app: *mut AnyObject = msg_send![apps, objectAtIndex: index];
            if app.is_null() {
                continue;
            }
            let app_pid: i32 = msg_send![app, processIdentifier];
            if app_pid == pid {
                let _: bool = msg_send![app, unhide];
                let activated: bool = msg_send![app, activateWithOptions: 3usize];
                return activated
                    .then_some(())
                    .ok_or_else(|| "无法激活本机微信窗口".to_string());
            }
        }
    }
    Err("目标应用已退出".to_string())
}

fn focus_main_wechat_window(app: &AxElement) {
    let windows = copy_element_array_attr(app, "AXWindows");
    for (index, window) in windows.iter().enumerate() {
        let title = copy_string_attr(window, "AXTitle").unwrap_or_default();
        let frame = copy_ax_frame(window);
        log::info!(
            "[DEBUG][wechat_automation] AX window index={index} title={} x={} y={} width={} height={}",
            title.chars().take(80).collect::<String>(),
            frame.map(|value| value.origin.x.round()).unwrap_or(-1.0),
            frame.map(|value| value.origin.y.round()).unwrap_or(-1.0),
            frame.map(|value| value.size.width.round()).unwrap_or(-1.0),
            frame.map(|value| value.size.height.round()).unwrap_or(-1.0)
        );
    }
    // Prefer the actual chat window by title. AXMainWindow/AXFocusedWindow can
    // point at the last opened article browser, where Cmd-F means in-page
    // find instead of WeChat's global search.
    let main_window = windows
        .iter()
        .find_map(|window| {
            let title = normalized_text(&copy_string_attr(window, "AXTitle").unwrap_or_default());
            (title == "微信" || title.starts_with("微信") || title == "wechat" || title == "weixin")
                .then(|| window.clone())
        })
        .or_else(|| copy_element_attr(app, "AXMainWindow"))
        .or_else(|| copy_element_attr(app, "AXFocusedWindow"))
        .or_else(|| (windows.len() == 1).then(|| windows[0].clone()));
    let Some(main_window) = main_window else {
        log::debug!("WeChat main window was not separately exposed; using its active window");
        return;
    };

    let raise = CFString::from_static_string("AXRaise");
    let _ = unsafe { AXUIElementPerformAction(main_window.0, raise.as_concrete_TypeRef()) };
    let _ = set_boolean_attr(&main_window, "AXMain", true);
    let _ = set_boolean_attr(&main_window, "AXFocused", true);
    log::debug!("focused the WeChat main window before starting search");
}

fn open_wechat_search(
    apps: &[(i32, AxElement)],
    main_pid: i32,
) -> Result<(AxElement, i32), String> {
    let mut event_pids = Vec::with_capacity(apps.len() + 1);
    event_pids.push(main_pid);
    event_pids.extend(apps.iter().map(|(pid, _)| *pid));
    event_pids.sort_unstable();
    event_pids.dedup();
    event_pids.sort_by_key(|pid| (*pid != main_pid) as usize);

    for event_pid in event_pids {
        log::debug!("sending WeChat search shortcut to pid={event_pid}");
        log::info!("[DEBUG][wechat_automation] send Cmd-F pid={event_pid}");
        post_key(event_pid, 3, CGEventFlags::CGEventFlagCommand)?; // Cmd-F
        if let Some(field) = wait_for_search_text_field(apps, Duration::from_millis(1800)) {
            log::info!(
                "[DEBUG][wechat_automation] search input resolved owner_pid={}",
                field.1
            );
            return Ok(field);
        }
    }

    log_search_field_diagnostics(apps);
    Err("微信搜索界面已激活，但没有暴露可输入的搜索框".to_string())
}

fn wait_for_search_text_field(
    apps: &[(i32, AxElement)],
    timeout: Duration,
) -> Option<(AxElement, i32)> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        for (pid, app) in apps {
            if let Some(focused) = copy_element_attr(app, "AXFocusedUIElement") {
                let role = copy_string_attr(&focused, "AXRole").unwrap_or_default();
                if is_text_input_role(&role) {
                    return Some((focused, *pid));
                }
            }
        }
        for (pid, app) in apps {
            if let Some(field) = find_search_text_field(app) {
                let _ = set_boolean_attr(&field, "AXFocused", true);
                return Some((field, *pid));
            }
        }
        thread::sleep(Duration::from_millis(150));
    }
    None
}

fn find_search_text_field(app: &AxElement) -> Option<AxElement> {
    let nodes = collect_ax_nodes(app).ok()?;
    let mut inputs = nodes
        .iter()
        .filter(|node| is_text_input_role(&node.role))
        .map(|node| {
            let label = normalized_text(&node.text);
            let looks_like_search = label.contains("搜索")
                || label.contains("搜一搜")
                || label.contains("search")
                || label.contains("query");
            let role_rank = match node.role.as_str() {
                "AXTextField" | "AXComboBox" | "AXSearchField" => 0,
                _ => 1,
            };
            ((!looks_like_search) as usize, role_rank, node)
        })
        .collect::<Vec<_>>();
    inputs.sort_by_key(|(label_rank, role_rank, _)| (*label_rank, *role_rank));
    let (label_rank, role_rank, node) = inputs.first()?;
    if *label_rank == 0 || (*role_rank == 0 && inputs.len() <= 2) {
        Some(node.element.clone())
    } else {
        None
    }
}

fn wechat_login_required(app: &AxElement) -> bool {
    let Ok(nodes) = collect_ax_nodes(app) else {
        return false;
    };
    let text_markers = wechat_login_text_markers(&nodes);
    log::info!(
        "[DEBUG][wechat_automation] login readiness text_markers={text_markers} ax_nodes={}",
        nodes.len()
    );
    text_markers >= 2
}

fn wechat_login_text_markers(nodes: &[AxNode]) -> usize {
    let mut scan_to_login = false;
    let mut transfer_only = false;
    let mut qr_code = false;
    for node in nodes {
        let text = normalized_text(&node.text);
        scan_to_login |= text.contains("scantologin") || text.contains("扫码登录");
        transfer_only |= text.contains("transferfilesonly")
            || text.contains("仅传输文件")
            || text.contains("仅文件传输");
        qr_code |= text.contains("qrcode") || text.contains("二维码");
    }
    usize::from(scan_to_login) + usize::from(transfer_only) + usize::from(qr_code)
}

fn log_search_field_diagnostics(apps: &[(i32, AxElement)]) {
    for (pid, app) in apps {
        let focused_role = copy_element_attr(app, "AXFocusedUIElement")
            .and_then(|element| copy_string_attr(&element, "AXRole"))
            .unwrap_or_else(|| "none".to_string());
        let (node_count, input_count) = collect_ax_nodes(app)
            .map(|nodes| {
                let input_count = nodes
                    .iter()
                    .filter(|node| is_text_input_role(&node.role))
                    .count();
                (nodes.len(), input_count)
            })
            .unwrap_or_default();
        log::warn!(
            "WeChat search AX diagnostics (pid={pid}, focused_role={focused_role}, nodes={node_count}, text_inputs={input_count})"
        );
    }
}

fn is_text_input_role(role: &str) -> bool {
    matches!(
        role,
        "AXTextField" | "AXTextArea" | "AXComboBox" | "AXSearchField"
    )
}

fn set_text_value(element: &AxElement, text: &str, pid: i32) -> Result<(), String> {
    // Send real keyboard input first. Setting AXValue alone updates the text
    // visually in WeChat 4.x but does not dispatch the input/change events
    // that populate its live “搜一搜” suggestions.
    let _ = set_boolean_attr(element, "AXFocused", true);
    post_key(pid, 0, CGEventFlags::CGEventFlagCommand)?; // Cmd-A
    thread::sleep(Duration::from_millis(80));
    post_unicode(pid, text)?;
    thread::sleep(Duration::from_millis(120));
    if copy_string_attr(element, "AXValue")
        .is_some_and(|value| normalized_text(&value) == normalized_text(text))
    {
        log::info!("[DEBUG][wechat_automation] query input dispatched by keyboard events");
        return Ok(());
    }

    log::warn!(
        "[DEBUG][wechat_automation] keyboard query input was not reflected; using AXValue fallback"
    );
    let attribute = CFString::from_static_string("AXValue");
    let value = CFString::new(text);
    let error = unsafe {
        AXUIElementSetAttributeValue(
            element.0,
            attribute.as_concrete_TypeRef(),
            value.as_CFTypeRef(),
        )
    };
    if error == AX_ERROR_SUCCESS {
        return Ok(());
    }
    Err("微信搜索框未接受自动输入".to_string())
}

fn set_boolean_attr(element: &AxElement, attribute: &str, enabled: bool) -> bool {
    let attribute = CFString::new(attribute);
    let value = if enabled {
        CFBoolean::true_value()
    } else {
        CFBoolean::false_value()
    };
    unsafe {
        AXUIElementSetAttributeValue(
            element.0,
            attribute.as_concrete_TypeRef(),
            value.as_CFTypeRef(),
        ) == AX_ERROR_SUCCESS
    }
}

/// Ask Chromium-backed WeChat windows to expose their web accessibility tree.
///
/// WeChatAppEx does not advertise the result-card DOM by default. Chromium on
/// macOS supports these application-level AX switches specifically for
/// assistive clients. They affect only the current WeChat process lifetime and
/// do not modify the user's system Accessibility settings.
fn enable_web_accessibility(app: &AxElement, pid: i32) -> bool {
    let manual = set_boolean_attr(app, "AXManualAccessibility", true);
    let enhanced = set_boolean_attr(app, "AXEnhancedUserInterface", true);
    log::info!(
        "[DEBUG][wechat_automation] web accessibility pid={pid} manual={manual} enhanced={enhanced}"
    );
    manual || enhanced
}

fn post_key(pid: i32, keycode: CGKeyCode, flags: CGEventFlags) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建键盘事件".to_string())?;
    let down = CGEvent::new_keyboard_event(source.clone(), keycode, true)
        .map_err(|_| "无法创建按键事件".to_string())?;
    down.set_flags(flags);
    down.post_to_pid(pid);
    let up = CGEvent::new_keyboard_event(source, keycode, false)
        .map_err(|_| "无法创建按键事件".to_string())?;
    up.set_flags(flags);
    up.post_to_pid(pid);
    Ok(())
}

fn post_scroll_down_at(point: CGPoint, lines: i32) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建滚动事件".to_string())?;
    let event = CGEvent::new_scroll_event(source, ScrollEventUnit::LINE, 1, -lines.abs(), 0, 0)
        .map_err(|_| "无法创建滚动事件".to_string())?;
    event.set_location(point);
    event.post(CGEventTapLocation::HID);
    Ok(())
}

fn post_key_to_system(keycode: CGKeyCode, flags: CGEventFlags) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建键盘事件".to_string())?;
    let down = CGEvent::new_keyboard_event(source.clone(), keycode, true)
        .map_err(|_| "无法创建按键事件".to_string())?;
    down.set_flags(flags);
    down.post(CGEventTapLocation::HID);
    let up = CGEvent::new_keyboard_event(source, keycode, false)
        .map_err(|_| "无法创建按键事件".to_string())?;
    up.set_flags(flags);
    up.post(CGEventTapLocation::HID);
    Ok(())
}

fn post_unicode(pid: i32, text: &str) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建文字输入事件".to_string())?;
    let utf16 = text.encode_utf16().collect::<Vec<_>>();
    let down = CGEvent::new_keyboard_event(source.clone(), 0, true)
        .map_err(|_| "无法创建文字输入事件".to_string())?;
    let up = CGEvent::new_keyboard_event(source, 0, false)
        .map_err(|_| "无法创建文字输入事件".to_string())?;
    unsafe {
        CGEventKeyboardSetUnicodeString(down.as_ptr(), utf16.len(), utf16.as_ptr());
        CGEventKeyboardSetUnicodeString(up.as_ptr(), utf16.len(), utf16.as_ptr());
    }
    down.post_to_pid(pid);
    up.post_to_pid(pid);
    Ok(())
}

fn submit_account_query_in_web_search(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    query: &str,
) -> Result<(), String> {
    // The WeChat 4.x native search sheet sometimes opens the web Search page
    // without carrying its text across. The empty web input is autofocus, so
    // replace its value semantically through keyboard events instead of using
    // OCR or guessing a result card.
    // The initial Search landing page places its input in the centre block,
    // not in the compact header used by an already-populated results page.
    // This helper is called only while the results region is still blank, so
    // target that landing-page input and submit through its adjacent button.
    let input_point = CGPoint::new(
        window.frame.origin.x + window.frame.size.width * 0.5,
        window.frame.origin.y + window.frame.size.height * 0.40,
    );
    if !wait_until_result_window_is_frontmost(
        wechat_pids,
        window,
        input_point,
        FIRST_RESULT_CLICK_TARGET_TIMEOUT,
    ) {
        return Err("微信搜一搜网页未处于可输入状态".to_string());
    }
    post_left_click(input_point, None)?;
    thread::sleep(Duration::from_millis(100));
    paste_preserving_clipboard(query)?;
    let submit_point = CGPoint::new(
        window.frame.origin.x + window.frame.size.width * 0.79,
        window.frame.origin.y + window.frame.size.height * 0.40,
    );
    post_left_click(submit_point, None)?;
    log::info!(
        "[DEBUG][wechat_automation] account query submitted in web Search owner_pid={} query_chars={}",
        window.owner_pid,
        query.chars().count()
    );
    Ok(())
}

fn paste_preserving_clipboard(text: &str) -> Result<(), String> {
    const SCRIPT: &str = r#"on run argv
set savedClipboard to the clipboard as record
try
  set the clipboard to item 1 of argv
  tell application "System Events"
    keystroke "a" using command down
    keystroke "v" using command down
    delay 0.12
  end tell
  delay 0.12
on error errorMessage number errorNumber
  set the clipboard to savedClipboard
  error errorMessage number errorNumber
end try
set the clipboard to savedClipboard
end run"#;
    let status = Command::new("/usr/bin/osascript")
        .arg("-e")
        .arg(SCRIPT)
        .arg(text)
        .status()
        .map_err(|_| "无法调用 macOS 文字粘贴服务".to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "微信搜一搜网页未接受账号文字".to_string())
}

fn focus_wechat_window_matching_frame(wechat_pids: &[i32], expected: CGRect) -> bool {
    let Some((distance, frame, window)) = nearest_ax_wechat_window(wechat_pids, expected) else {
        log::info!("[DEBUG][wechat_automation] no AX web-window frame candidate");
        return false;
    };
    if distance > 80.0 {
        log::info!(
            "[DEBUG][wechat_automation] AX web-window frame mismatch distance={} width={} height={}",
            distance.round(),
            frame.size.width.round(),
            frame.size.height.round()
        );
        return false;
    }
    let raise = CFString::from_static_string("AXRaise");
    let unminimized = set_boolean_attr(&window, "AXMinimized", false);
    let raised = unsafe { AXUIElementPerformAction(window.0, raise.as_concrete_TypeRef()) }
        == AX_ERROR_SUCCESS;
    let main = set_boolean_attr(&window, "AXMain", true);
    let focused = set_boolean_attr(&window, "AXFocused", true);
    log::info!(
        "[DEBUG][wechat_automation] matched web window unminimized={unminimized} raised={raised} main={main} focused={focused} distance={}",
        distance.round()
    );
    unminimized || raised || main || focused
}

fn nearest_ax_wechat_window(
    wechat_pids: &[i32],
    expected: CGRect,
) -> Option<(f64, CGRect, AxElement)> {
    let mut candidates = Vec::new();
    for pid in wechat_pids {
        let Some(app) =
            (unsafe { AxElement::from_create_rule(AXUIElementCreateApplication(*pid)) })
        else {
            continue;
        };
        candidates.extend(
            copy_element_array_attr(&app, "AXWindows")
                .into_iter()
                .filter_map(|window| {
                    let frame = copy_ax_frame(&window)?;
                    if frame.size.width < 700.0 || frame.size.height < 500.0 {
                        return None;
                    }
                    let distance = (frame.origin.x - expected.origin.x).abs()
                        + (frame.origin.y - expected.origin.y).abs()
                        + (frame.size.width - expected.size.width).abs()
                        + (frame.size.height - expected.size.height).abs();
                    Some((distance, frame, window))
                }),
        );
    }
    candidates.sort_by(|left, right| left.0.total_cmp(&right.0));
    candidates.into_iter().next()
}

fn copy_ax_frame(element: &AxElement) -> Option<CGRect> {
    let position = copy_raw_attr(element, "AXPosition")?;
    let size = copy_raw_attr(element, "AXSize")?;
    let mut point = CGPoint::new(0.0, 0.0);
    let mut dimensions = core_graphics::geometry::CGSize::new(0.0, 0.0);
    let point_ok = unsafe {
        AXValueGetType(position as *const c_void) == 1
            && AXValueGetValue(
                position as *const c_void,
                1,
                &mut point as *mut CGPoint as *mut c_void,
            )
    };
    let size_ok = unsafe {
        AXValueGetType(size as *const c_void) == 2
            && AXValueGetValue(
                size as *const c_void,
                2,
                &mut dimensions as *mut core_graphics::geometry::CGSize as *mut c_void,
            )
    };
    unsafe {
        CFRelease(position);
        CFRelease(size);
    }
    (point_ok && size_ok).then(|| CGRect::new(&point, &dimensions))
}

fn preferred_wechat_result_window(
    wechat_pids: &[i32],
    baseline: &HashSet<i32>,
    baseline_samples: &BTreeMap<i32, FirstResultRenderSample>,
    prefer_delegated_web_window: bool,
    allow_unchanged_reused: bool,
) -> Option<WechatWebWindow> {
    let candidates = wechat_web_windows(wechat_pids, false);
    let new_candidates = candidates
        .iter()
        .copied()
        .filter(|window| !baseline.contains(&window.id))
        .collect::<Vec<_>>();
    if !new_candidates.is_empty() {
        return largest_frontmost_window(new_candidates, prefer_delegated_web_window);
    }
    let changed_candidates = candidates
        .iter()
        .copied()
        .filter(|window| {
            baseline_samples.get(&window.id).is_some_and(|before| {
                first_result_render_sample(*window)
                    .is_ok_and(|after| first_result_render_changed(*before, after))
            })
        })
        .collect::<Vec<_>>();
    if !changed_candidates.is_empty() {
        return largest_frontmost_window(changed_candidates, prefer_delegated_web_window);
    }
    allow_unchanged_reused
        .then(|| largest_frontmost_window(candidates, prefer_delegated_web_window))
        .flatten()
}

fn largest_frontmost_window(
    mut candidates: Vec<WechatWebWindow>,
    prefer_delegated_web_window: bool,
) -> Option<WechatWebWindow> {
    // Filter by the actual owner process before checking screenshots. The
    // WeChatAppEx mirror is frequently uncapturable until raised, while the
    // simultaneously-changing main WeChat window is capturable; sampling
    // first would therefore defeat the delegation preference.
    if prefer_delegated_web_window
        && candidates
            .iter()
            .any(|window| window.is_delegated_web_window)
    {
        candidates.retain(|window| window.is_delegated_web_window);
    }
    let usable = candidates
        .iter()
        .copied()
        .filter(|window| {
            first_result_render_sample(*window).is_ok_and(|sample| sample.light_per_mille() >= 200)
        })
        .collect::<Vec<_>>();
    // A reused WeChat browser popup can be minimized or live on another Space.
    // CoreGraphics cannot capture it until AX brings it forward, but its frame
    // and owner still identify the window. Keep it as a fallback candidate and
    // let `focus_wechat_window_matching_frame` unminimize it before sampling.
    let ranked = if usable.is_empty() {
        candidates
    } else {
        usable
    };
    let prefer_main_surface = ranked.iter().any(|window| window.is_main_surface);
    let prefer_on_screen = ranked.iter().any(|window| window.is_on_screen);
    let candidates = ranked
        .into_iter()
        .filter(|window| !prefer_main_surface || window.is_main_surface)
        .filter(|window| !prefer_on_screen || window.is_on_screen)
        .collect::<Vec<_>>();
    let largest_area = candidates
        .iter()
        .map(|window| window.frame.size.width * window.frame.size.height)
        .max_by(f64::total_cmp)?;
    // CGWindowList is ordered front-to-back. Preserve that order when several
    // WeChat article/search windows have the same dimensions, otherwise a
    // previous article page can win an arbitrary max-by tie.
    candidates.into_iter().find(|window| {
        let area = window.frame.size.width * window.frame.size.height;
        (area - largest_area).abs() < 1.0
    })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct FirstResultRenderSample {
    ink_pixels: usize,
    light_pixels: usize,
    total_pixels: usize,
    surface_signature: u64,
}

impl FirstResultRenderSample {
    fn ink_per_mille(self) -> usize {
        self.ink_pixels.saturating_mul(1_000) / self.total_pixels.max(1)
    }

    fn light_per_mille(self) -> usize {
        self.light_pixels.saturating_mul(1_000) / self.total_pixels.max(1)
    }

    fn ready(self) -> bool {
        self.ink_per_mille() >= FIRST_RESULT_MIN_INK_PER_MILLE
            && self.light_per_mille() >= FIRST_RESULT_MIN_LIGHT_PER_MILLE
    }
}

fn first_result_render_sample(
    window: WechatWebWindow,
) -> Result<FirstResultRenderSample, &'static str> {
    let region = first_result_capture_region(window.frame);
    let window_id = u32::try_from(window.id).map_err(|_| "invalid-window-id")?;
    let image = create_image(
        region,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming
            | kCGWindowImageShouldBeOpaque
            | kCGWindowImageNominalResolution,
    )
    .ok_or("window-image-unavailable")?;
    let data = image.data();
    first_result_pixel_sample(
        data.bytes(),
        image.width(),
        image.height(),
        image.bytes_per_row(),
        image.bits_per_component(),
        image.bits_per_pixel(),
    )
}

fn first_result_visible_render_sample(
    wechat_pids: &[i32],
    window: WechatWebWindow,
) -> Result<FirstResultRenderSample, &'static str> {
    let direct = first_result_render_sample(window);
    if direct
        .as_ref()
        .is_ok_and(|sample| sample.light_per_mille() >= 200)
    {
        return direct;
    }
    let region = first_result_capture_region(window.frame);
    let verification_point = CGPoint::new(
        region.origin.x + region.size.width * 0.5,
        region.origin.y + region.size.height * 0.5,
    );
    if !result_window_is_frontmost(wechat_pids, window, verification_point) {
        return direct;
    }
    let image = create_image(
        region,
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID,
        kCGWindowImageBoundsIgnoreFraming
            | kCGWindowImageShouldBeOpaque
            | kCGWindowImageNominalResolution,
    )
    .ok_or("screen-image-unavailable")?;
    let data = image.data();
    first_result_pixel_sample(
        data.bytes(),
        image.width(),
        image.height(),
        image.bytes_per_row(),
        image.bits_per_component(),
        image.bits_per_pixel(),
    )
}

fn first_result_capture_region(window: CGRect) -> CGRect {
    CGRect::new(
        &CGPoint::new(
            window.origin.x + window.size.width * FIRST_RESULT_REGION_X_RATIO,
            window.origin.y + window.size.height * FIRST_RESULT_REGION_Y_RATIO,
        ),
        &core_graphics::geometry::CGSize::new(
            window.size.width * FIRST_RESULT_REGION_WIDTH_RATIO,
            window.size.height * FIRST_RESULT_REGION_HEIGHT_RATIO,
        ),
    )
}

fn first_result_pixel_sample(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    bits_per_component: usize,
    bits_per_pixel: usize,
) -> Result<FirstResultRenderSample, &'static str> {
    if width == 0 || height == 0 {
        return Err("empty-window-image");
    }
    if bits_per_component != 8 || !matches!(bits_per_pixel, 24 | 32) {
        return Err("unsupported-window-image-format");
    }
    let bytes_per_pixel = bits_per_pixel / 8;
    let row_bytes = width
        .checked_mul(bytes_per_pixel)
        .ok_or("window-image-size-overflow")?;
    let required_bytes = bytes_per_row
        .checked_mul(height)
        .ok_or("window-image-size-overflow")?;
    if bytes_per_row < row_bytes || bytes.len() < required_bytes {
        return Err("truncated-window-image");
    }

    let mut ink_pixels = 0_usize;
    let mut light_pixels = 0_usize;
    let mut surface_signature = 0xcbf2_9ce4_8422_2325_u64;
    for row in 0..height {
        let row_start = row * bytes_per_row;
        for column in 0..width {
            let pixel_start = row_start + column * bytes_per_pixel;
            let pixel = &bytes[pixel_start..pixel_start + bytes_per_pixel];
            let channel_total = if bytes_per_pixel == 4 {
                let mut channels = [pixel[0], pixel[1], pixel[2], pixel[3]];
                channels.sort_unstable();
                usize::from(channels[0]) + usize::from(channels[1]) + usize::from(channels[2])
            } else {
                usize::from(pixel[0]) + usize::from(pixel[1]) + usize::from(pixel[2])
            };
            ink_pixels += usize::from(channel_total <= FIRST_RESULT_INK_CHANNEL_TOTAL_MAX);
            light_pixels += usize::from(channel_total >= FIRST_RESULT_LIGHT_CHANNEL_TOTAL_MIN);
            if row % 4 == 0 && column % 4 == 0 {
                for channel in pixel.iter().take(3) {
                    surface_signature ^= u64::from(channel >> 4);
                    surface_signature = surface_signature.wrapping_mul(0x100_0000_01b3);
                }
            }
        }
    }
    Ok(FirstResultRenderSample {
        ink_pixels,
        light_pixels,
        total_pixels: width * height,
        surface_signature,
    })
}

#[derive(Clone, Copy)]
struct FirstArticleGreenTarget {
    point: CGPoint,
    skipped_quick_answer: bool,
    used_screen_capture: bool,
}

fn first_article_green_click_target(
    wechat_pids: &[i32],
    window: WechatWebWindow,
) -> Option<FirstArticleGreenTarget> {
    green_click_target_in_region(
        wechat_pids,
        window,
        first_article_locator_region(window.frame),
        true,
    )
}

fn first_account_green_click_target(
    wechat_pids: &[i32],
    window: WechatWebWindow,
) -> Option<FirstArticleGreenTarget> {
    green_click_target_in_region(
        wechat_pids,
        window,
        account_result_locator_region(window.frame),
        false,
    )
}

fn green_click_target_in_region(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    region: CGRect,
    skip_quick_answer: bool,
) -> Option<FirstArticleGreenTarget> {
    let window_id = u32::try_from(window.id).ok()?;
    let direct_target = create_image(
        region,
        kCGWindowListOptionIncludingWindow,
        window_id,
        kCGWindowImageBoundsIgnoreFraming
            | kCGWindowImageShouldBeOpaque
            | kCGWindowImageNominalResolution,
    )
    .and_then(|image| {
        let data = image.data();
        green_result_pixel(
            data.bytes(),
            image.width(),
            image.height(),
            image.bytes_per_row(),
            image.bits_per_component(),
            image.bits_per_pixel(),
            skip_quick_answer,
        )
        .map(|(pixel_x, pixel_y, skipped_quick_answer)| {
            (
                pixel_x,
                pixel_y,
                skipped_quick_answer,
                image.width(),
                image.height(),
            )
        })
    });
    let (pixel_x, pixel_y, skipped_quick_answer, image_width, image_height, used_screen_capture) =
        if let Some((pixel_x, pixel_y, skipped_quick_answer, image_width, image_height)) =
            direct_target
        {
            (
                pixel_x,
                pixel_y,
                skipped_quick_answer,
                image_width,
                image_height,
                false,
            )
        } else {
            let verification_point = CGPoint::new(
                region.origin.x + region.size.width * 0.5,
                region.origin.y + region.size.height * 0.5,
            );
            if !result_window_is_frontmost(wechat_pids, window, verification_point) {
                return None;
            }
            let screen_image = create_image(
                region,
                kCGWindowListOptionOnScreenOnly,
                kCGNullWindowID,
                kCGWindowImageBoundsIgnoreFraming
                    | kCGWindowImageShouldBeOpaque
                    | kCGWindowImageNominalResolution,
            )?;
            let screen_data = screen_image.data();
            let (pixel_x, pixel_y, skipped_quick_answer) = green_result_pixel(
                screen_data.bytes(),
                screen_image.width(),
                screen_image.height(),
                screen_image.bytes_per_row(),
                screen_image.bits_per_component(),
                screen_image.bits_per_pixel(),
                skip_quick_answer,
            )?;
            (
                pixel_x,
                pixel_y,
                skipped_quick_answer,
                screen_image.width(),
                screen_image.height(),
                true,
            )
        };
    Some(FirstArticleGreenTarget {
        point: CGPoint::new(
            region.origin.x + (pixel_x as f64 + 0.5) / image_width as f64 * region.size.width,
            region.origin.y + (pixel_y as f64 + 0.5) / image_height as f64 * region.size.height,
        ),
        skipped_quick_answer,
        used_screen_capture,
    })
}

fn first_article_locator_region(window: CGRect) -> CGRect {
    CGRect::new(
        &CGPoint::new(
            window.origin.x + window.size.width * FIRST_RESULT_REGION_X_RATIO,
            window.origin.y + window.size.height * FIRST_ARTICLE_REGION_Y_RATIO,
        ),
        &core_graphics::geometry::CGSize::new(
            window.size.width * FIRST_RESULT_REGION_WIDTH_RATIO,
            window.size.height * FIRST_ARTICLE_REGION_HEIGHT_RATIO,
        ),
    )
}

fn account_result_locator_region(window: CGRect) -> CGRect {
    CGRect::new(
        &CGPoint::new(
            window.origin.x + window.size.width * FIRST_RESULT_REGION_X_RATIO,
            window.origin.y + window.size.height * ACCOUNT_RESULT_REGION_Y_RATIO,
        ),
        &core_graphics::geometry::CGSize::new(
            window.size.width * FIRST_RESULT_REGION_WIDTH_RATIO,
            window.size.height * ACCOUNT_RESULT_REGION_HEIGHT_RATIO,
        ),
    )
}

fn first_result_green_pixel(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    bits_per_component: usize,
    bits_per_pixel: usize,
) -> Option<(usize, usize, bool)> {
    green_result_pixel(
        bytes,
        width,
        height,
        bytes_per_row,
        bits_per_component,
        bits_per_pixel,
        true,
    )
}

#[cfg(test)]
fn first_green_result_pixel(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    bits_per_component: usize,
    bits_per_pixel: usize,
) -> Option<(usize, usize, bool)> {
    green_result_pixel(
        bytes,
        width,
        height,
        bytes_per_row,
        bits_per_component,
        bits_per_pixel,
        false,
    )
}

fn green_result_pixel(
    bytes: &[u8],
    width: usize,
    height: usize,
    bytes_per_row: usize,
    bits_per_component: usize,
    bits_per_pixel: usize,
    skip_quick_answer: bool,
) -> Option<(usize, usize, bool)> {
    if width == 0 || height == 0 || bits_per_component != 8 || !matches!(bits_per_pixel, 24 | 32) {
        return None;
    }
    let bytes_per_pixel = bits_per_pixel / 8;
    let required_bytes = bytes_per_row.checked_mul(height)?;
    if bytes_per_row < width.checked_mul(bytes_per_pixel)? || bytes.len() < required_bytes {
        return None;
    }
    let mut green_pixels = Vec::new();
    for row in 0..height {
        let row_start = row * bytes_per_row;
        for column in 0..width {
            let pixel_start = row_start + column * bytes_per_pixel;
            let pixel = &bytes[pixel_start..pixel_start + bytes_per_pixel];
            if pixel_is_wechat_green(pixel) {
                green_pixels.push((column, row));
            }
        }
    }
    if green_pixels.len() < 12 {
        return None;
    }
    let mut green_rows = vec![0_usize; height];
    for (_, row) in &green_pixels {
        green_rows[*row] += 1;
    }
    let merge_gap = (height / 40).clamp(3, 40);
    let mut clusters = Vec::<(usize, usize, usize)>::new();
    for (row, pixel_count) in green_rows.into_iter().enumerate() {
        if pixel_count == 0 {
            continue;
        }
        if let Some(cluster) = clusters.last_mut() {
            if row.saturating_sub(cluster.1) <= merge_gap {
                cluster.1 = row;
                cluster.2 += pixel_count;
                continue;
            }
        }
        clusters.push((row, row, pixel_count));
    }
    clusters.retain(|(_, _, pixel_count)| *pixel_count >= 12);
    let first = *clusters.first()?;
    let article_cluster = skip_quick_answer
        .then(|| {
            let quick_answer_gap = (height / 4).max(1);
            clusters
                .iter()
                .copied()
                .skip(1)
                .find(|candidate| candidate.0.saturating_sub(first.1) >= quick_answer_gap)
        })
        .flatten();
    let (target_start, target_end, _) = article_cluster.unwrap_or(first);
    let skipped_quick_answer = article_cluster.is_some();
    green_pixels.retain(|(_, row)| (*row >= target_start) && (*row <= target_end));
    green_pixels.sort_unstable_by_key(|(column, row)| (*column, *row));
    let (column, row) = green_pixels.get(green_pixels.len() / 2).copied()?;
    Some((column, row, skipped_quick_answer))
}

fn pixel_is_wechat_green(pixel: &[u8]) -> bool {
    let bgra_or_rgba = pixel.len() >= 3
        && pixel[1] >= 110
        && i16::from(pixel[1]) - i16::from(pixel[0]) >= 25
        && i16::from(pixel[1]) - i16::from(pixel[2]) >= 40;
    let argb = pixel.len() == 4
        && pixel[0] >= 220
        && pixel[2] >= 110
        && i16::from(pixel[2]) - i16::from(pixel[1]) >= 25
        && i16::from(pixel[2]) - i16::from(pixel[3]) >= 40;
    bgra_or_rgba || argb
}

fn activate_wechat_by_apple_event() -> bool {
    Command::new("/usr/bin/osascript")
        .args([
            "-e",
            "tell application id \"com.tencent.xinWeChat\" to activate",
        ])
        .status()
        .is_ok_and(|status| status.success())
}

fn wait_until_result_window_is_frontmost(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    point: CGPoint,
    timeout: Duration,
) -> bool {
    let quick_deadline = Instant::now() + Duration::from_millis(150);
    while Instant::now() < quick_deadline {
        if result_window_is_frontmost(wechat_pids, window, point) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }

    // AXRaise can focus the delegated WeChatAppEx window without moving the
    // owning WeChat application above the previously active app. Reassert the
    // process frontmost state once, then raise the exact popup again. This is
    // a bounded focus fallback only; it never repeats the search or click.
    let owner_activated = activate_application(window.owner_pid).is_ok()
        || activate_application_by_pid_with_system_events(window.owner_pid);
    let apple_event_activated = !owner_activated && activate_wechat_by_apple_event();
    let pid_activated = owner_activated
        || wechat_pids
            .iter()
            .copied()
            .filter(|pid| *pid != window.owner_pid)
            .any(activate_application_by_pid_with_system_events);
    let raised = focus_wechat_window_matching_frame(wechat_pids, window.frame);
    log::info!(
        "[DEBUG][wechat_automation] result window foreground fallback apple_event_activated={apple_event_activated} pid_activated={pid_activated} raised={raised}"
    );

    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if result_window_is_frontmost(wechat_pids, window, point) {
            return true;
        }
        thread::sleep(Duration::from_millis(50));
    }
    false
}

fn result_window_is_frontmost(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    point: CGPoint,
) -> bool {
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    let windows = unsafe { CGWindowListCopyWindowInfo(ON_SCREEN_ONLY | EXCLUDE_DESKTOP, 0) };
    if windows.is_null() {
        return false;
    }
    let count = unsafe { CFArrayGetCount(windows) };
    let mut result = false;
    for index in 0..count {
        let dictionary = unsafe { CFArrayGetValueAtIndex(windows, index) as CFDictionaryRef };
        if dictionary.is_null() {
            continue;
        }
        let layer = unsafe { CFDictionaryGetValue(dictionary, kCGWindowLayer as *const c_void) };
        let mut layer_number = -1_i32;
        if layer.is_null()
            || !unsafe {
                CFNumberGetValue(
                    layer,
                    3, // kCFNumberSInt32Type
                    &mut layer_number as *mut i32 as *mut c_void,
                )
            }
            || layer_number != 0
        {
            continue;
        }
        let owner_name =
            unsafe { CFDictionaryGetValue(dictionary, kCGWindowOwnerName as *const c_void) };
        if !owner_name.is_null()
            && unsafe { CFString::wrap_under_get_rule(owner_name as CFStringRef) }.to_string()
                == "Dock"
        {
            continue;
        }
        let bounds = unsafe { CFDictionaryGetValue(dictionary, kCGWindowBounds as *const c_void) };
        if bounds.is_null() {
            continue;
        }
        let mut frame = CGRect::new(
            &CGPoint::new(0.0, 0.0),
            &core_graphics::geometry::CGSize::new(0.0, 0.0),
        );
        if !unsafe { CGRectMakeWithDictionaryRepresentation(bounds as CFDictionaryRef, &mut frame) }
            || point.x < frame.origin.x
            || point.x > frame.origin.x + frame.size.width
            || point.y < frame.origin.y
            || point.y > frame.origin.y + frame.size.height
        {
            continue;
        }
        let owner = unsafe { CFDictionaryGetValue(dictionary, kCGWindowOwnerPID as *const c_void) };
        let number = unsafe { CFDictionaryGetValue(dictionary, kCGWindowNumber as *const c_void) };
        let mut owner_pid = 0_i32;
        let mut window_id = 0_i32;
        if !owner.is_null() {
            let _ =
                unsafe { CFNumberGetValue(owner, 3, &mut owner_pid as *mut i32 as *mut c_void) };
        }
        if !number.is_null() {
            let _ =
                unsafe { CFNumberGetValue(number, 3, &mut window_id as *mut i32 as *mut c_void) };
        }
        result = window_id == window.id
            || (wechat_pids.iter().any(|value| *value == owner_pid)
                && window_frame_distance(frame, window.frame) < 4.0);
        break;
    }
    unsafe { CFRelease(windows as CFTypeRef) };
    result
}

fn first_result_render_changed(
    before: FirstResultRenderSample,
    after: FirstResultRenderSample,
) -> bool {
    !after.ready()
        || before.surface_signature != after.surface_signature
        || before.ink_per_mille().abs_diff(after.ink_per_mille())
            >= FIRST_RESULT_TRANSITION_DELTA_PER_MILLE
        || before.light_per_mille().abs_diff(after.light_per_mille())
            >= FIRST_RESULT_TRANSITION_DELTA_PER_MILLE
}

fn wait_for_first_result_transition(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    before: FirstResultRenderSample,
    windows_before_click: &HashSet<i32>,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    let mut consecutive_changes = 0_usize;
    while Instant::now() < deadline {
        thread::sleep(FIRST_RESULT_POLL_INTERVAL);
        if wechat_web_windows(wechat_pids, false)
            .into_iter()
            .any(|candidate| {
                !windows_before_click.contains(&candidate.id)
                    && first_result_render_sample(candidate).is_ok()
            })
        {
            return true;
        }
        match first_result_visible_render_sample(wechat_pids, window) {
            Ok(after) if first_result_render_changed(before, after) => {
                consecutive_changes += 1;
                if consecutive_changes >= 2 {
                    return true;
                }
            }
            Ok(_) => consecutive_changes = 0,
            Err(_) => {
                if !wechat_web_window_ids(wechat_pids).contains(&window.id) {
                    return true;
                }
                consecutive_changes = 0;
            }
        }
    }
    false
}

fn wechat_web_window_ids(wechat_pids: &[i32]) -> HashSet<i32> {
    wechat_web_windows(wechat_pids, false)
        .into_iter()
        .map(|window| window.id)
        .collect()
}

fn cg_window_name_by_id(expected_window_id: i32) -> Option<String> {
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    let windows = unsafe { CGWindowListCopyWindowInfo(EXCLUDE_DESKTOP, 0) };
    if windows.is_null() {
        return None;
    }
    let count = unsafe { CFArrayGetCount(windows) };
    let mut result = None;
    for index in 0..count {
        let dictionary = unsafe { CFArrayGetValueAtIndex(windows, index) as CFDictionaryRef };
        if dictionary.is_null() {
            continue;
        }
        let number = unsafe { CFDictionaryGetValue(dictionary, kCGWindowNumber as *const c_void) };
        let mut window_id = 0_i32;
        if number.is_null()
            || !unsafe { CFNumberGetValue(number, 3, &mut window_id as *mut i32 as *mut c_void) }
            || window_id != expected_window_id
        {
            continue;
        }
        let name = unsafe { CFDictionaryGetValue(dictionary, kCGWindowName as *const c_void) };
        if !name.is_null() {
            result =
                Some(unsafe { CFString::wrap_under_get_rule(name as CFStringRef) }.to_string());
        }
        break;
    }
    unsafe { CFRelease(windows as CFTypeRef) };
    result
}

fn single_new_wechat_web_window_id(wechat_pids: &[i32], baseline: &HashSet<i32>) -> Option<i32> {
    let mut created = wechat_web_window_ids(wechat_pids)
        .into_iter()
        .filter(|window_id| !baseline.contains(window_id));
    let only = created.next()?;
    created.next().is_none().then_some(only)
}

fn wait_for_single_new_wechat_web_window_id(
    wechat_pids: &[i32],
    baseline: &HashSet<i32>,
    timeout: Duration,
) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(window_id) = single_new_wechat_web_window_id(wechat_pids, baseline) {
            return Some(window_id);
        }
        if Instant::now() >= deadline {
            return None;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn wait_for_dynamic_new_wechat_window_id(
    main_pid: i32,
    baseline: &HashSet<i32>,
    timeout: Duration,
) -> (Vec<i32>, Option<i32>) {
    let deadline = Instant::now() + timeout;
    let mut pids = vec![main_pid];
    loop {
        if let Ok(processes) = running_application_pids() {
            pids = processes.ui_pids;
            pids.sort_unstable();
            pids.dedup();
            pids.retain(|pid| *pid != main_pid);
            pids.push(main_pid);
        }
        if let Some(window_id) = single_new_wechat_web_window_id(&pids, baseline) {
            return (pids, Some(window_id));
        }
        if Instant::now() >= deadline {
            return (pids, None);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn close_owned_wechat_window(wechat_pids: &[i32], window_id: i32) -> bool {
    let windows = wechat_web_windows(wechat_pids, false);
    let Some(requested_window) = windows
        .iter()
        .copied()
        .find(|window| window.id == window_id)
    else {
        return true;
    };
    let window = if first_result_render_sample(requested_window).is_ok() {
        requested_window
    } else {
        windows
            .iter()
            .copied()
            .filter(|candidate| candidate.id != requested_window.id)
            .filter(|candidate| {
                window_frame_distance(candidate.frame, requested_window.frame) < 4.0
            })
            .find(|candidate| first_result_render_sample(*candidate).is_ok())
            .unwrap_or(requested_window)
    };
    if !window.is_on_screen
        && post_key(window.owner_pid, 13, CGEventFlags::CGEventFlagCommand).is_ok()
    {
        let deadline = Instant::now() + Duration::from_millis(900);
        while Instant::now() < deadline {
            thread::sleep(Duration::from_millis(70));
            if !wechat_web_window_ids(wechat_pids).contains(&window_id) {
                return true;
            }
        }
    }
    let before_close = first_result_visible_render_sample(wechat_pids, window).ok();
    let verification_point = CGPoint::new(
        window.frame.origin.x + window.frame.size.width * 0.5,
        window.frame.origin.y + window.frame.size.height * 0.35,
    );
    let mut owner_activated = false;
    if !result_window_is_frontmost(wechat_pids, window, verification_point) {
        owner_activated = activate_application(window.owner_pid).is_ok()
            || activate_application_by_pid_with_system_events(window.owner_pid);
        if !owner_activated {
            let _ = activate_wechat_by_apple_event();
        }
    }
    let raised = focus_wechat_window_matching_frame(wechat_pids, window.frame);
    if !raised
        && !owner_activated
        && !result_window_is_frontmost(wechat_pids, window, verification_point)
    {
        log::warn!(
            "[DEBUG][wechat_automation] task page cleanup skipped reason=window-focus-unconfirmed window_id={window_id}"
        );
        return false;
    }
    if !wait_until_result_window_is_frontmost(
        wechat_pids,
        window,
        verification_point,
        FIRST_RESULT_CLICK_TARGET_TIMEOUT,
    ) {
        log::warn!(
            "[DEBUG][wechat_automation] task page cleanup skipped reason=window-frontmost-unconfirmed window_id={window_id}"
        );
        return false;
    }
    if post_key_to_system(13, CGEventFlags::CGEventFlagCommand).is_err() {
        return false;
    }
    let deadline = Instant::now() + Duration::from_millis(900);
    let mut consecutive_surface_changes = 0_usize;
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(70));
        if !wechat_web_window_ids(wechat_pids).contains(&window_id) {
            return true;
        }
        if before_close.is_some_and(|before| {
            first_result_visible_render_sample(wechat_pids, window)
                .is_ok_and(|after| first_result_render_changed(before, after))
        }) {
            consecutive_surface_changes += 1;
            if consecutive_surface_changes >= 2 {
                return true;
            }
        } else {
            consecutive_surface_changes = 0;
        }
    }
    false
}

fn window_frame_distance(left: CGRect, right: CGRect) -> f64 {
    (left.origin.x - right.origin.x).abs()
        + (left.origin.y - right.origin.y).abs()
        + (left.size.width - right.size.width).abs()
        + (left.size.height - right.size.height).abs()
}

fn restore_previous_application(previous_pid: i32, wechat_pid: i32) {
    if previous_pid > 0 && previous_pid != wechat_pid {
        let restored = activate_application(previous_pid).is_ok()
            || activate_application_by_pid_with_system_events(previous_pid);
        log::info!(
            "[DEBUG][wechat_automation] previous application restore pid={previous_pid} restored={restored}"
        );
    }
}

fn activate_wechat_for_keyboard_search(processes: &WechatProcesses) {
    if activate_application(processes.main_pid).is_ok() {
        log::info!(
            "[DEBUG][wechat_automation] keyboard fallback activated main pid={} ",
            processes.main_pid
        );
        thread::sleep(Duration::from_millis(180));
        return;
    }

    let ui_activated = processes.ui_pids.iter().copied().any(|pid| {
        let activated = activate_application(pid).is_ok();
        log::info!(
            "[DEBUG][wechat_automation] keyboard fallback UI activation pid={pid} accepted={activated}"
        );
        activated
    });
    if !ui_activated {
        let open_succeeded = Command::new("/usr/bin/open")
            .args(["-b", WECHAT_BUNDLE_ID])
            .status()
            .is_ok_and(|status| status.success());
        log::info!(
            "[DEBUG][wechat_automation] keyboard fallback LaunchServices activation succeeded={open_succeeded}"
        );
        thread::sleep(Duration::from_millis(500));
    } else {
        thread::sleep(Duration::from_millis(180));
    }
}

fn activate_application_by_pid_with_system_events(pid: i32) -> bool {
    let script = format!(
        "tell application \"System Events\" to set frontmost of first process whose unix id is {pid} to true"
    );
    Command::new("/usr/bin/osascript")
        .args(["-e", &script])
        .status()
        .is_ok_and(|status| status.success())
}

fn wechat_web_windows(wechat_pids: &[i32], on_screen_only: bool) -> Vec<WechatWebWindow> {
    const ON_SCREEN_ONLY: u32 = 1 << 0;
    const EXCLUDE_DESKTOP: u32 = 1 << 4;
    let options = EXCLUDE_DESKTOP | if on_screen_only { ON_SCREEN_ONLY } else { 0 };
    let windows = unsafe { CGWindowListCopyWindowInfo(options, 0) };
    if windows.is_null() {
        return Vec::new();
    }
    let mut candidates = Vec::new();
    let main_pid = wechat_pids.last().copied();
    let count = unsafe { CFArrayGetCount(windows) };
    for index in 0..count {
        let dictionary = unsafe { CFArrayGetValueAtIndex(windows, index) as CFDictionaryRef };
        if dictionary.is_null() {
            continue;
        }
        let owner = unsafe { CFDictionaryGetValue(dictionary, kCGWindowOwnerPID as *const c_void) };
        let mut owner_pid = 0_i32;
        if owner.is_null()
            || !unsafe {
                CFNumberGetValue(
                    owner,
                    3, // kCFNumberSInt32Type
                    &mut owner_pid as *mut i32 as *mut c_void,
                )
            }
            || !wechat_pids.iter().any(|value| *value == owner_pid)
        {
            continue;
        }
        let name = unsafe { CFDictionaryGetValue(dictionary, kCGWindowName as *const c_void) };
        let name = if name.is_null() {
            String::new()
        } else {
            unsafe { CFString::wrap_under_get_rule(name as CFStringRef) }.to_string()
        };
        let normalized_name = normalized_text(&name);
        let is_search_surface = normalized_name.contains("search")
            || normalized_name.contains("搜索")
            || normalized_name.contains("搜一搜");
        let is_account_search_surface = is_search_surface
            && (normalized_name.contains("account") || normalized_name.contains("公众号"));
        let is_other_search_surface = is_search_surface && !is_account_search_surface;
        let bounds = unsafe { CFDictionaryGetValue(dictionary, kCGWindowBounds as *const c_void) };
        if bounds.is_null() {
            continue;
        }
        let mut frame = CGRect::new(
            &CGPoint::new(0.0, 0.0),
            &core_graphics::geometry::CGSize::new(0.0, 0.0),
        );
        if !unsafe { CGRectMakeWithDictionaryRepresentation(bounds as CFDictionaryRef, &mut frame) }
        {
            continue;
        }
        let exact_main_window_name = name == "WeChat (Window)";
        // WeChatAppEx exposes an empty CGWindow name while backgrounded, then
        // changes it to the page title after activation. Geometry and owner are
        // stable across both states, so do not require the name to stay empty.
        let app_ex_browser_shape =
            Some(owner_pid) != main_pid && frame.size.width >= 650.0 && frame.size.height >= 550.0;
        if (exact_main_window_name || app_ex_browser_shape)
            && frame.size.width >= 700.0
            && frame.size.height >= 500.0
        {
            let number =
                unsafe { CFDictionaryGetValue(dictionary, kCGWindowNumber as *const c_void) };
            let mut window_number = 0_i32;
            if !number.is_null() {
                let _ = unsafe {
                    CFNumberGetValue(number, 3, &mut window_number as *mut i32 as *mut c_void)
                };
            }
            if on_screen_only {
                log::info!(
                    "[DEBUG][wechat_automation] web window candidate order={index} id={window_number} x={} y={} width={} height={}",
                    frame.origin.x.round(),
                    frame.origin.y.round(),
                    frame.size.width.round(),
                    frame.size.height.round()
                );
            }
            let on_screen_value =
                unsafe { CFDictionaryGetValue(dictionary, kCGWindowIsOnscreen as *const c_void) };
            let is_on_screen =
                !on_screen_value.is_null() && unsafe { CFBooleanGetValue(on_screen_value) };
            candidates.push(WechatWebWindow {
                id: window_number,
                owner_pid,
                frame,
                is_main_surface: exact_main_window_name,
                is_delegated_web_window: Some(owner_pid) != main_pid,
                is_on_screen,
                is_account_search_surface,
                is_other_search_surface,
            });
        }
    }
    unsafe { CFRelease(windows as CFTypeRef) };
    candidates
}

fn post_left_click(point: CGPoint, target_pid: Option<i32>) -> Result<(), String> {
    let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
        .map_err(|_| "无法创建鼠标事件".to_string())?;
    let moved = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::MouseMoved,
        point,
        CGMouseButton::Left,
    )
    .map_err(|_| "无法创建鼠标移动事件".to_string())?;
    let down = CGEvent::new_mouse_event(
        source.clone(),
        CGEventType::LeftMouseDown,
        point,
        CGMouseButton::Left,
    )
    .map_err(|_| "无法创建鼠标按下事件".to_string())?;
    let up = CGEvent::new_mouse_event(source, CGEventType::LeftMouseUp, point, CGMouseButton::Left)
        .map_err(|_| "无法创建鼠标抬起事件".to_string())?;
    if let Some(pid) = target_pid {
        moved.post_to_pid(pid);
        down.post_to_pid(pid);
    } else {
        moved.post(CGEventTapLocation::HID);
        down.post(CGEventTapLocation::HID);
    }
    thread::sleep(Duration::from_millis(40));
    if let Some(pid) = target_pid {
        up.post_to_pid(pid);
    } else {
        up.post(CGEventTapLocation::HID);
    }
    Ok(())
}

fn press_articles_tab_by_point_probe(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    before: FirstResultRenderSample,
) -> Result<bool, String> {
    press_search_vertical_by_point_probe(
        wechat_pids,
        window,
        before,
        &["articles", "article", "文章"],
        ARTICLES_TAB_X_RATIO,
        "articles",
    )
}

fn press_account_tab_by_point_probe(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    before: FirstResultRenderSample,
) -> Result<bool, String> {
    normalize_search_vertical_strip_left(wechat_pids, window, before)?;
    if observe_account_search_surface(wechat_pids, window.frame, Duration::from_millis(80))
        == AccountSearchSurfaceObservation::Matched
    {
        return Ok(true);
    }
    let before_candidate = first_result_visible_render_sample(wechat_pids, window)
        .map_err(|error| format!("微信公众号分类栏尚未完成渲染（{error}）"))?;
    let windows_before_click = wechat_web_window_ids(wechat_pids);
    let point = CGPoint::new(
        window.frame.origin.x + window.frame.size.width * ACCOUNT_TAB_X_RATIO,
        window.frame.origin.y + window.frame.size.height * ARTICLES_TAB_Y_RATIO,
    );
    if !wait_until_result_window_is_frontmost(
        wechat_pids,
        window,
        point,
        FIRST_RESULT_CLICK_TARGET_TIMEOUT,
    ) {
        return Ok(false);
    }
    post_left_click(point, None)?;
    let transitioned = wait_for_first_result_transition(
        wechat_pids,
        window,
        before_candidate,
        &windows_before_click,
        Duration::from_millis(1_200),
    );
    let observation =
        observe_account_search_surface(wechat_pids, window.frame, Duration::from_millis(180));
    log::info!(
        "[DEBUG][wechat_automation] account tab selected x_ratio={ACCOUNT_TAB_X_RATIO:.2} transitioned={transitioned} semantic_observation={observation:?}"
    );
    // The embedded search page does not expose its DOM/title through macOS on
    // all builds. The exact fakeid batch check after opening the account is the
    // non-visual acknowledgement; this click is confined to the category bar.
    Ok(observation != AccountSearchSurfaceObservation::Mismatched)
}

fn press_official_account_filter_by_point_probe(
    wechat_pids: &[i32],
    window: WechatWebWindow,
) -> Result<bool, String> {
    for attempt in 0..2 {
        let before = first_result_visible_render_sample(wechat_pids, window)
            .map_err(|error| format!("微信公众号筛选栏尚未完成渲染（{error}）"))?;
        let windows_before_click = wechat_web_window_ids(wechat_pids);
        let point = CGPoint::new(
            window.frame.origin.x + window.frame.size.width * OFFICIAL_ACCOUNT_FILTER_X_RATIO,
            window.frame.origin.y + window.frame.size.height * OFFICIAL_ACCOUNT_FILTER_Y_RATIO,
        );
        if !wait_until_result_window_is_frontmost(
            wechat_pids,
            window,
            point,
            FIRST_RESULT_CLICK_TARGET_TIMEOUT,
        ) {
            return Ok(false);
        }
        post_left_click(point, None)?;
        let transitioned = wait_for_first_result_transition(
            wechat_pids,
            window,
            before,
            &windows_before_click,
            Duration::from_millis(1_200),
        );
        log::info!(
            "[DEBUG][wechat_automation] official-account filter attempt={} x_ratio={OFFICIAL_ACCOUNT_FILTER_X_RATIO:.2} y_ratio={OFFICIAL_ACCOUNT_FILTER_Y_RATIO:.3} transitioned={transitioned}",
            attempt + 1
        );
        if transitioned {
            return Ok(true);
        }
        thread::sleep(Duration::from_millis(140));
    }
    Ok(false)
}

fn normalize_search_vertical_strip_left(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    mut before: FirstResultRenderSample,
) -> Result<(), String> {
    let point = CGPoint::new(
        window.frame.origin.x + window.frame.size.width * SEARCH_VERTICAL_LEFT_X_RATIO,
        window.frame.origin.y + window.frame.size.height * ARTICLES_TAB_Y_RATIO,
    );
    for attempt in 0..4 {
        if !wait_until_result_window_is_frontmost(
            wechat_pids,
            window,
            point,
            FIRST_RESULT_CLICK_TARGET_TIMEOUT,
        ) {
            return Err("微信搜索分类栏未处于可操作状态。".to_string());
        }
        let windows_before_click = wechat_web_window_ids(wechat_pids);
        post_left_click(point, None)?;
        let transitioned = wait_for_first_result_transition(
            wechat_pids,
            window,
            before,
            &windows_before_click,
            RESULT_CLICK_TRANSITION_TIMEOUT,
        );
        log::info!(
            "[DEBUG][wechat_automation] search vertical strip normalize attempt={} transitioned={transitioned}",
            attempt + 1
        );
        if !transitioned {
            break;
        }
        before = first_result_visible_render_sample(wechat_pids, window)
            .map_err(|error| format!("微信搜索分类栏归一后无法确认页面状态（{error}）"))?;
    }
    Ok(())
}

fn observe_account_search_surface(
    wechat_pids: &[i32],
    frame: CGRect,
    timeout: Duration,
) -> AccountSearchSurfaceObservation {
    let deadline = Instant::now() + timeout;
    let mut observed_other = false;
    loop {
        // WeChat's browser often leaves the CoreGraphics window name empty,
        // while the matching AXWindow exposes the selected search vertical as
        // `Account`, `Moments`, and so on. Prefer that semantic title before
        // considering the lower-fidelity CGWindow name.
        if let Some((distance, _, ax_window)) = nearest_ax_wechat_window(wechat_pids, frame) {
            if distance < 4.0 {
                let title = copy_string_attr(&ax_window, "AXTitle").unwrap_or_default();
                let normalized = normalized_text(&title);
                if normalized.contains("account") || normalized.contains("公众号") {
                    return AccountSearchSurfaceObservation::Matched;
                }
                observed_other |= [
                    "all",
                    "moments",
                    "inquiries",
                    "underline",
                    "articles",
                    "article",
                    "video",
                    "news",
                    "全部",
                    "朋友圈",
                    "问一问",
                    "文章",
                    "视频",
                    "新闻",
                ]
                .iter()
                .any(|marker| normalized.contains(marker));
            }
        }
        for candidate in wechat_web_windows(wechat_pids, false) {
            if window_frame_distance(candidate.frame, frame) >= 4.0 {
                continue;
            }
            if candidate.is_account_search_surface {
                return AccountSearchSurfaceObservation::Matched;
            }
            observed_other |= candidate.is_other_search_surface;
        }
        if Instant::now() >= deadline {
            return if observed_other {
                AccountSearchSurfaceObservation::Mismatched
            } else {
                AccountSearchSurfaceObservation::Unobserved
            };
        }
        thread::sleep(Duration::from_millis(60));
    }
}

fn press_search_vertical_by_point_probe(
    wechat_pids: &[i32],
    window: WechatWebWindow,
    before: FirstResultRenderSample,
    labels: &[&str],
    fallback_x_ratio: f64,
    debug_name: &str,
) -> Result<bool, String> {
    let windows_before_click = wechat_web_window_ids(wechat_pids);
    let Some(system) = (unsafe { AxElement::from_create_rule(AXUIElementCreateSystemWide()) })
    else {
        return Ok(false);
    };
    let y = window.frame.origin.y + window.frame.size.height * 0.15;
    for x_ratio in [0.22_f64, 0.27, 0.32, 0.37, 0.42, 0.47, 0.52, 0.57, 0.62] {
        let point = CGPoint::new(window.frame.origin.x + window.frame.size.width * x_ratio, y);
        let mut raw_target: AXUIElementRef = ptr::null_mut();
        let error = unsafe {
            AXUIElementCopyElementAtPosition(
                system.0,
                point.x as f32,
                point.y as f32,
                &mut raw_target,
            )
        };
        let Some(mut element) = (error == AX_ERROR_SUCCESS)
            .then(|| unsafe { AxElement::from_create_rule(raw_target) })
            .flatten()
        else {
            continue;
        };
        for depth in 0..=3 {
            let role = copy_string_attr(&element, "AXRole").unwrap_or_default();
            let text = ["AXTitle", "AXDescription", "AXValue"]
                .into_iter()
                .filter_map(|attribute| copy_string_attr(&element, attribute))
                .collect::<Vec<_>>()
                .join(" ");
            let normalized = normalized_text(&text);
            if labels.iter().any(|label| normalized == *label) {
                if !wait_until_result_window_is_frontmost(
                    wechat_pids,
                    window,
                    point,
                    FIRST_RESULT_CLICK_TARGET_TIMEOUT,
                ) {
                    return Ok(false);
                }
                post_left_click(point, None)?;
                let transitioned = wait_for_first_result_transition(
                    wechat_pids,
                    window,
                    before,
                    &windows_before_click,
                    FIRST_RESULT_TRANSITION_TIMEOUT,
                );
                log::info!(
                    "[DEBUG][wechat_automation] {debug_name} tab point match role={role} depth={depth} x_ratio={x_ratio:.2} transitioned={transitioned}"
                );
                return Ok(transitioned);
            }
            let Some(parent) = copy_element_attr(&element, "AXParent") else {
                break;
            };
            element = parent;
        }
    }

    // WeChatAppEx does not expose Chromium DOM nodes through Accessibility on
    // current macOS builds. The article vertical is nevertheless a stable tab
    // in WeChat's own search layout. Use one geometry click only after the
    // result surface is rendered and frontmost, then require a material surface
    // transition as the acknowledgement. A failed acknowledgement stops the
    // operation; it never falls through to clicking a mixed global result.
    let point = CGPoint::new(
        window.frame.origin.x + window.frame.size.width * fallback_x_ratio,
        window.frame.origin.y + window.frame.size.height * ARTICLES_TAB_Y_RATIO,
    );
    if !wait_until_result_window_is_frontmost(
        wechat_pids,
        window,
        point,
        FIRST_RESULT_CLICK_TARGET_TIMEOUT,
    ) {
        return Ok(false);
    }
    post_left_click(point, None)?;
    let transitioned = wait_for_first_result_transition(
        wechat_pids,
        window,
        before,
        &windows_before_click,
        FIRST_RESULT_TRANSITION_TIMEOUT,
    );
    log::info!(
        "[DEBUG][wechat_automation] {debug_name} tab geometry fallback x_ratio={fallback_x_ratio:.2} y_ratio={ARTICLES_TAB_Y_RATIO:.2} transitioned={transitioned}"
    );
    Ok(transitioned)
}

fn account_indexeddb_log_snapshot() -> BTreeMap<PathBuf, u64> {
    let Some(home) = dirs::home_dir() else {
        return BTreeMap::new();
    };
    let root = home
        .join("Library")
        .join("Containers")
        .join("com.tencent.xinWeChat")
        .join("Data")
        .join("Documents")
        .join("app_data")
        .join("radium")
        .join("web")
        .join("profiles");
    let Ok(profiles) = fs::read_dir(root) else {
        return BTreeMap::new();
    };
    let mut snapshot = BTreeMap::new();
    for profile in profiles.flatten() {
        if !profile
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with("multitab_"))
        {
            continue;
        }
        let leveldb = profile
            .path()
            .join("IndexedDB")
            .join("https_mp.weixin.qq.com_0.indexeddb.leveldb");
        let Ok(entries) = fs::read_dir(leveldb) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("log") {
                continue;
            }
            if let Ok(metadata) = entry.metadata() {
                snapshot.insert(path, metadata.len());
            }
        }
    }
    snapshot
}

fn account_indexeddb_log_paths() -> Vec<PathBuf> {
    let mut paths = account_indexeddb_log_snapshot()
        .into_keys()
        .collect::<Vec<_>>();
    paths.sort();
    paths
}

fn read_log_append(path: &Path, previous_len: u64) -> Option<Vec<u8>> {
    let current_len = fs::metadata(path).ok()?.len();
    if current_len == previous_len {
        return None;
    }
    let start = if current_len < previous_len {
        current_len.saturating_sub(MAX_INDEXEDDB_APPEND_BYTES)
    } else {
        previous_len.max(current_len.saturating_sub(MAX_INDEXEDDB_APPEND_BYTES))
    };
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes =
        Vec::with_capacity((current_len - start).min(MAX_INDEXEDDB_APPEND_BYTES) as usize);
    file.take(MAX_INDEXEDDB_APPEND_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(bytes)
}

fn read_v8_varint(bytes: &[u8], cursor: &mut usize) -> Option<usize> {
    let mut value = 0_usize;
    let mut shift = 0_u32;
    for _ in 0..10 {
        let byte = *bytes.get(*cursor)?;
        *cursor += 1;
        value |= usize::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(value);
        }
        shift += 7;
    }
    None
}

fn extract_base64_bizuin_values(bytes: &[u8]) -> HashSet<String> {
    const MARKER: &[u8] = b"base64_bizuin";
    let mut values = HashSet::new();
    let mut search_from = 0_usize;
    while search_from + MARKER.len() <= bytes.len() {
        let Some(relative) = bytes[search_from..]
            .windows(MARKER.len())
            .position(|window| window == MARKER)
        else {
            break;
        };
        let marker_end = search_from + relative + MARKER.len();
        let mut cursor = marker_end;
        if bytes.get(cursor) != Some(&b'"') {
            search_from = marker_end;
            continue;
        }
        cursor += 1;
        let Some(length) = read_v8_varint(bytes, &mut cursor) else {
            search_from = marker_end;
            continue;
        };
        let Some(value_bytes) = bytes.get(cursor..cursor.saturating_add(length)) else {
            search_from = marker_end;
            continue;
        };
        if let Ok(value) = std::str::from_utf8(value_bytes) {
            if !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
            {
                values.insert(value.to_string());
            }
        }
        search_from = cursor.saturating_add(length);
    }
    values
}

fn observe_account_identity_since(
    baseline: &BTreeMap<PathBuf, u64>,
    expected_fakeid: &str,
    timeout: Duration,
) -> AccountIdentityObservation {
    let deadline = Instant::now() + timeout;
    let mut observed = HashSet::new();
    loop {
        for path in account_indexeddb_log_paths() {
            let previous_len = baseline.get(&path).copied().unwrap_or(0);
            if let Some(bytes) = read_log_append(&path, previous_len) {
                observed.extend(extract_base64_bizuin_values(&bytes));
            }
        }
        if observed.contains(expected_fakeid) {
            return AccountIdentityObservation::Matched;
        }
        if Instant::now() >= deadline {
            return if observed.is_empty() {
                AccountIdentityObservation::Unobserved
            } else {
                AccountIdentityObservation::Mismatched
            };
        }
        thread::sleep(Duration::from_millis(80));
    }
}

fn refresh_wechat_window_pids(main_pid: i32, pids: &mut Vec<i32>) {
    let Ok(processes) = running_application_pids() else {
        return;
    };
    *pids = processes.ui_pids;
    pids.sort_unstable();
    pids.dedup();
    pids.retain(|pid| *pid != main_pid);
    pids.push(main_pid);
}

fn register_new_operation_windows(
    pids: &[i32],
    baseline_window_ids: &HashSet<i32>,
    owned_window_ids: &mut HashSet<i32>,
) {
    owned_window_ids.extend(
        wechat_web_window_ids(pids)
            .into_iter()
            .filter(|window_id| !baseline_window_ids.contains(window_id)),
    );
}

fn navigation_window_after_click(
    pids: &[i32],
    previous: WechatWebWindow,
    windows_before_click: &HashSet<i32>,
) -> WechatWebWindow {
    let windows = wechat_web_windows(pids, false);
    windows
        .iter()
        .copied()
        .filter(|candidate| !windows_before_click.contains(&candidate.id))
        .max_by_key(|candidate| usize::from(candidate.is_on_screen))
        .or_else(|| {
            windows
                .iter()
                .copied()
                .find(|candidate| candidate.id == previous.id)
        })
        .unwrap_or(previous)
}

#[allow(clippy::too_many_arguments)]
fn open_account_feed_from_search(
    target: &WechatArticleSearchTarget<'_>,
    wechat_pid: i32,
    wechat_window_pids: &mut Vec<i32>,
    mut window: WechatWebWindow,
    baseline_window_ids: &HashSet<i32>,
    owned_window_ids: &mut HashSet<i32>,
    operation_started: Instant,
) -> Result<i32, String> {
    let before_account_tab = first_result_visible_render_sample(wechat_window_pids, window)
        .map_err(|error| format!("微信公众号搜索结果尚未完成渲染（{error}）"))?;
    if !press_account_tab_by_point_probe(wechat_window_pids, window, before_account_tab)? {
        return Err("微信搜索结果已显示，但无法切换到公众号结果。".to_string());
    }
    log::info!(
        "[DEBUG][wechat_automation] account vertical ready elapsed_ms={}",
        operation_started.elapsed().as_millis()
    );
    if !press_official_account_filter_by_point_probe(wechat_window_pids, window)? {
        return Err("已切换到账号结果，但无法确认“公众号”类型筛选。".to_string());
    }

    let locator_deadline = Instant::now() + ACCOUNT_SEARCH_TIMEOUT;
    let account_target = loop {
        if let Some(target) = first_account_green_click_target(wechat_window_pids, window) {
            break target;
        }
        if Instant::now() >= locator_deadline {
            return Err("已切换到公众号搜索结果，但没有找到可打开的公众号。".to_string());
        }
        thread::sleep(FIRST_RESULT_POLL_INTERVAL);
    };
    let identity_baseline = account_indexeddb_log_snapshot();
    let before_profile = first_result_visible_render_sample(wechat_window_pids, window)
        .map_err(|error| format!("打开公众号前无法确认页面状态（{error}）"))?;
    let windows_before_profile = wechat_web_window_ids(wechat_window_pids);
    if !wait_until_result_window_is_frontmost(
        wechat_window_pids,
        window,
        account_target.point,
        FIRST_RESULT_CLICK_TARGET_TIMEOUT,
    ) {
        return Err("微信公众号搜索窗口未处于可操作状态。".to_string());
    }
    post_left_click(account_target.point, None)?;
    if !wait_for_first_result_transition(
        wechat_window_pids,
        window,
        before_profile,
        &windows_before_profile,
        Duration::from_millis(1_200),
    ) {
        return Err("已定位目标公众号候选项，但微信没有确认打开公众号主页。".to_string());
    }
    let (current_pids, new_profile_window_id) = wait_for_dynamic_new_wechat_window_id(
        wechat_pid,
        &windows_before_profile,
        Duration::from_millis(1_500),
    );
    *wechat_window_pids = current_pids;
    register_new_operation_windows(wechat_window_pids, baseline_window_ids, owned_window_ids);
    window = new_profile_window_id
        .and_then(|window_id| {
            wechat_web_windows(wechat_window_pids, false)
                .into_iter()
                .find(|candidate| candidate.id == window_id)
        })
        .unwrap_or_else(|| {
            navigation_window_after_click(wechat_window_pids, window, &windows_before_profile)
        });
    let page_window_name = cg_window_name_by_id(window.id).unwrap_or_default();
    log::info!(
        "[DEBUG][wechat_automation] account profile window resolved window_id={} new_window={} title={} elapsed_ms={}",
        window.id,
        new_profile_window_id.is_some(),
        page_window_name,
        operation_started.elapsed().as_millis()
    );

    let identity_observation = observe_account_identity_since(
        &identity_baseline,
        target.fakeid.trim(),
        ACCOUNT_PROFILE_TIMEOUT,
    );
    log::info!(
        "[DEBUG][wechat_automation] account identity observation={identity_observation:?} elapsed_ms={}",
        operation_started.elapsed().as_millis()
    );
    if identity_observation == AccountIdentityObservation::Mismatched {
        return Err("微信打开的公众号与目标公众号 ID 不一致；本次未继续点击文章。".to_string());
    }
    log::info!(
        "[DEBUG][wechat_automation] account feed ready without title search window_id={} x={} y={} width={} height={} elapsed_ms={}",
        window.id,
        window.frame.origin.x.round(),
        window.frame.origin.y.round(),
        window.frame.size.width.round(),
        window.frame.size.height.round(),
        operation_started.elapsed().as_millis()
    );
    Ok(window.id)
}

#[derive(Clone, Copy, Debug)]
struct CandidateMetadata {
    publisher_match: bool,
    date_match: bool,
    publisher_penalty: usize,
    date_penalty: usize,
    context_chars: usize,
}

fn candidate_metadata(
    element: &AxElement,
    target: &WechatArticleSearchTarget<'_>,
) -> CandidateMetadata {
    let context = candidate_context_text(element);
    candidate_metadata_from_context(&context, target)
}

fn candidate_metadata_from_context(
    context: &str,
    target: &WechatArticleSearchTarget<'_>,
) -> CandidateMetadata {
    let context = normalized_text(context);
    let publisher = target
        .publisher
        .map(normalized_text)
        .filter(|value| !value.is_empty());
    let publisher_match = publisher
        .as_ref()
        .is_some_and(|value| context.contains(value));
    let date_keys = published_date_keys(target.published_at);
    let date_match = date_keys.iter().any(|value| context.contains(value));
    CandidateMetadata {
        publisher_match,
        date_match,
        publisher_penalty: usize::from(publisher.is_some() && !publisher_match),
        date_penalty: usize::from(!date_keys.is_empty() && !date_match),
        context_chars: context.chars().count(),
    }
}

fn published_date_keys(timestamp: i64) -> Vec<String> {
    let Some(value) = chrono::DateTime::from_timestamp(timestamp, 0) else {
        return Vec::new();
    };
    let date = value.with_timezone(&chrono::Local).date_naive();
    let mut keys = vec![
        format!("{:04}{:02}{:02}", date.year(), date.month(), date.day()),
        format!("{}年{}月{}日", date.year(), date.month(), date.day()),
        format!("{}月{}日", date.month(), date.day()),
    ];
    let today = chrono::Local::now().date_naive();
    let days_ago = today.signed_duration_since(date).num_days();
    if (0..=3_650).contains(&days_ago) {
        keys.extend([
            format!("{days_ago}daysago"),
            format!("{days_ago}dayago"),
            format!("{days_ago}天前"),
        ]);
        if days_ago == 0 {
            keys.extend(["today".to_string(), "今天".to_string()]);
        } else if days_ago == 1 {
            keys.extend(["yesterday".to_string(), "昨天".to_string()]);
        }
    }
    let months_ago = (today.year() - date.year()) * 12
        + i32::try_from(today.month()).unwrap_or_default()
        - i32::try_from(date.month()).unwrap_or_default();
    if (0..=120).contains(&months_ago) {
        keys.extend([
            format!("{months_ago}monthsago"),
            format!("{months_ago}monthago"),
            format!("{months_ago}个月前"),
        ]);
    }
    let years_ago = today.year() - date.year();
    if (0..=10).contains(&years_ago) {
        keys.extend([
            format!("{years_ago}yearsago"),
            format!("{years_ago}yearago"),
            format!("{years_ago}年前"),
        ]);
    }
    keys.into_iter()
        .map(|value| normalized_text(&value))
        .filter(|value| !value.is_empty())
        .collect()
}

fn candidate_context_text(element: &AxElement) -> String {
    let context_root = candidate_context_root(element);
    let mut queue = VecDeque::from([(context_root, 0_usize)]);
    let mut visited = HashSet::new();
    let mut text = String::new();
    while let Some((current, depth)) = queue.pop_front() {
        if visited.len() >= 240 || !visited.insert(current.0 as usize) {
            continue;
        }
        for attribute in ["AXTitle", "AXDescription", "AXValue"] {
            if let Some(value) = copy_string_attr(&current, attribute) {
                if !value.trim().is_empty() {
                    text.push(' ');
                    text.push_str(&value);
                }
            }
        }
        if depth < 6 {
            for child in copy_children(&current) {
                queue.push_back((child, depth + 1));
            }
        }
    }
    text
}

fn candidate_context_root(element: &AxElement) -> AxElement {
    let mut best = element.clone();
    let mut current = Some(element.clone());
    for _ in 0..8 {
        let Some(candidate) = current else {
            break;
        };
        let role = copy_string_attr(&candidate, "AXRole").unwrap_or_default();
        if let Some(frame) = copy_ax_frame(&candidate) {
            let card_sized = frame.size.width >= 180.0
                && (24.0..=240.0).contains(&frame.size.height)
                && matches!(
                    role.as_str(),
                    "AXLink"
                        | "AXButton"
                        | "AXMenuItem"
                        | "AXRow"
                        | "AXCell"
                        | "AXGroup"
                        | "AXHeading"
                );
            if card_sized {
                best = candidate.clone();
            }
            if frame.size.height > 240.0 {
                break;
            }
        }
        current = copy_element_attr(&candidate, "AXParent");
    }
    best
}

fn result_title_role_priority(role: &str) -> usize {
    match role {
        "AXHeading" => 0,
        "AXLink" | "AXButton" => 1,
        "AXRow" | "AXCell" => 2,
        "AXMenuItem" => 3,
        "AXStaticText" => 4,
        _ => 5,
    }
}

fn exact_title_ax_candidate_frame(
    apps: &[(i32, AxElement)],
    target: &WechatArticleSearchTarget<'_>,
) -> Option<CGRect> {
    let expected = normalized_text(target.title);
    let mut candidates = Vec::new();
    for (_, app) in apps {
        let Ok(nodes) = collect_ax_nodes(app) else {
            continue;
        };
        for node in nodes {
            if !is_article_result_role(&node.role) {
                continue;
            }
            let text = normalized_text(&node.text);
            if is_search_chrome_text(&text) {
                continue;
            }
            let Some(rank) = title_match_rank(&text, &expected) else {
                continue;
            };
            let Some(frame) = copy_ax_frame(&node.element) else {
                continue;
            };
            if frame.size.width < 80.0 || frame.size.height < 12.0 {
                continue;
            }
            let metadata = candidate_metadata(&node.element, target);
            log::info!(
                "[DEBUG][wechat_automation] AX title candidate role={} rank={rank} publisher_match={} date_match={} context_chars={} width={} height={}",
                node.role,
                metadata.publisher_match,
                metadata.date_match,
                metadata.context_chars,
                frame.size.width.round(),
                frame.size.height.round()
            );
            if target.publisher.is_some() && !metadata.publisher_match {
                continue;
            }
            if rank > 0 && !metadata.date_match {
                continue;
            }
            let extra_chars = text
                .chars()
                .count()
                .saturating_sub(expected.chars().count());
            candidates.push((
                rank,
                metadata.publisher_penalty,
                metadata.date_penalty,
                result_title_role_priority(&node.role),
                extra_chars,
                frame,
            ));
        }
    }
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| left.3.cmp(&right.3))
            .then_with(|| left.4.cmp(&right.4))
    });
    candidates.first().map(|candidate| candidate.5)
}

fn click_exact_article_result_in_apps(
    apps: &[(i32, AxElement)],
    target: &WechatArticleSearchTarget<'_>,
    window: CGRect,
    target_pid: Option<i32>,
) -> Result<bool, String> {
    let expected = normalized_text(target.title);
    let mut candidates = Vec::new();
    let mut has_quick_answer = false;
    for (_, app) in apps {
        let Ok(nodes) = collect_ax_nodes(app) else {
            continue;
        };
        has_quick_answer |= nodes.iter().any(|node| {
            let text = normalized_text(&node.text);
            text.contains("快速回答") || text.contains("quickanswer")
        });
        for node in nodes {
            if !is_article_result_role(&node.role) {
                continue;
            }
            let text = normalized_text(&node.text);
            if is_search_chrome_text(&text) {
                continue;
            }
            let Some(rank) = title_match_rank(&text, &expected) else {
                continue;
            };
            let Some(frame) = copy_ax_frame(&node.element) else {
                continue;
            };
            let center = CGPoint::new(
                frame.origin.x + frame.size.width * 0.5,
                frame.origin.y + frame.size.height * 0.5,
            );
            if center.x < window.origin.x
                || center.x > window.origin.x + window.size.width
                || center.y < window.origin.y
                || center.y > window.origin.y + window.size.height
            {
                continue;
            }
            let extra_chars = text
                .chars()
                .count()
                .saturating_sub(expected.chars().count());
            let metadata = candidate_metadata(&node.element, target);
            if target.publisher.is_some() && !metadata.publisher_match {
                continue;
            }
            if rank > 0 && !metadata.date_match {
                continue;
            }
            candidates.push((
                rank,
                metadata.publisher_penalty,
                metadata.date_penalty,
                result_title_role_priority(&node.role),
                extra_chars,
                center.y,
                node,
                center,
                metadata,
            ));
        }
    }
    let minimum_y =
        window.origin.y + window.size.height * if has_quick_answer { 0.34 } else { 0.12 };
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| left.3.cmp(&right.3))
            .then_with(|| left.4.cmp(&right.4))
            .then_with(|| left.5.total_cmp(&right.5))
    });
    let Some((rank, _, _, _, _, _, node, center, metadata)) = candidates
        .into_iter()
        .find(|candidate| candidate.5 >= minimum_y)
    else {
        log::info!(
            "[DEBUG][wechat_automation] exact-title AX card unavailable quick_answer={has_quick_answer}"
        );
        return Ok(false);
    };
    let (pressed, pointer_clicks, transitioned) =
        activate_exact_title_candidate(&node.element, center, target.title, target_pid)?;
    log::info!(
        "[DEBUG][wechat_automation] identity-ranked AX card role={} rank={rank} publisher_match={} date_match={} context_chars={} quick_answer={has_quick_answer} target_x={} target_y={} pressed={pressed} pointer_clicks={pointer_clicks} transitioned={transitioned}",
        node.role,
        metadata.publisher_match,
        metadata.date_match,
        metadata.context_chars,
        center.x.round(),
        center.y.round()
    );
    Ok(transitioned || pressed || pointer_clicks > 0)
}

fn click_exact_article_result_by_point_scan(
    search_target: &WechatArticleSearchTarget<'_>,
    window: CGRect,
    target_pid: Option<i32>,
) -> Result<bool, String> {
    let expected = normalized_text(search_target.title);
    let Some(system) = (unsafe { AxElement::from_create_rule(AXUIElementCreateSystemWide()) })
    else {
        return Ok(false);
    };
    let mut matches = Vec::new();
    let mut quick_answer = false;
    let mut seen = HashSet::new();
    for x_ratio in [0.24_f64, 0.32, 0.40, 0.50, 0.62] {
        let x = window.origin.x + window.size.width * x_ratio;
        for step in 8..=34 {
            let y_ratio = f64::from(step) * 0.02;
            let scan_point = CGPoint::new(x, window.origin.y + window.size.height * y_ratio);
            let mut raw_target: AXUIElementRef = ptr::null_mut();
            let error = unsafe {
                AXUIElementCopyElementAtPosition(
                    system.0,
                    scan_point.x as f32,
                    scan_point.y as f32,
                    &mut raw_target,
                )
            };
            let Some(element) = (error == AX_ERROR_SUCCESS)
                .then(|| unsafe { AxElement::from_create_rule(raw_target) })
                .flatten()
            else {
                continue;
            };
            let role = copy_string_attr(&element, "AXRole").unwrap_or_default();
            let text = ["AXTitle", "AXDescription", "AXValue"]
                .into_iter()
                .filter_map(|attribute| copy_string_attr(&element, attribute))
                .collect::<Vec<_>>()
                .join(" ");
            let normalized = normalized_text(&text);
            quick_answer |= normalized.contains("快速回答")
                || normalized.contains("quickanswer")
                || normalized.contains("展开全部");
            if is_article_result_role(&role) && !is_search_chrome_text(&normalized) {
                if let Some(rank) = title_match_rank(&normalized, &expected) {
                    if seen.insert(element.0 as usize) {
                        let text_chars = normalized.chars().count();
                        let extra_chars = text_chars.saturating_sub(expected.chars().count());
                        let click_point = copy_ax_frame(&element)
                            .map(|frame| {
                                CGPoint::new(
                                    frame.origin.x + frame.size.width * 0.5,
                                    frame.origin.y + frame.size.height * 0.5,
                                )
                            })
                            .filter(|point| {
                                point.x >= window.origin.x
                                    && point.x <= window.origin.x + window.size.width
                                    && point.y >= window.origin.y
                                    && point.y <= window.origin.y + window.size.height
                            })
                            .unwrap_or(scan_point);
                        let metadata = candidate_metadata(&element, search_target);
                        if search_target.publisher.is_some() && !metadata.publisher_match {
                            continue;
                        }
                        if rank > 0 && !metadata.date_match {
                            continue;
                        }
                        log::info!(
                            "[DEBUG][wechat_automation] AX point match role={role} rank={rank} publisher_match={} date_match={} x_ratio={x_ratio:.2} y_ratio={y_ratio:.2} text_chars={text_chars} extra_chars={extra_chars} click_x={} click_y={}",
                            metadata.publisher_match,
                            metadata.date_match,
                            click_point.x.round(),
                            click_point.y.round()
                        );
                        matches.push((
                            rank,
                            metadata.publisher_penalty,
                            metadata.date_penalty,
                            result_title_role_priority(&role),
                            extra_chars,
                            y_ratio,
                            x_ratio,
                            element,
                            click_point,
                            text_chars,
                            role,
                            metadata,
                        ));
                    }
                }
            }
        }
    }
    matches.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
            .then_with(|| left.3.cmp(&right.3))
            .then_with(|| left.4.cmp(&right.4))
            .then_with(|| left.5.total_cmp(&right.5))
    });
    let chosen_index = if quick_answer {
        matches
            .iter()
            .enumerate()
            .find(|(_, candidate)| candidate.5 >= 0.45)
            .map(|(index, _)| index)
    } else {
        matches
            .iter()
            .enumerate()
            .find(|(_, candidate)| (0.14..=0.58).contains(&candidate.5))
            .map(|(index, _)| index)
    };
    let Some(index) = chosen_index.or_else(|| (!matches.is_empty()).then_some(0)) else {
        log::info!(
            "[DEBUG][wechat_automation] AX point scan found no title match quick_answer={quick_answer}"
        );
        return Ok(false);
    };
    let (rank, _, _, _, extra_chars, y_ratio, x_ratio, element, point, text_chars, role, metadata) =
        matches.swap_remove(index);
    let (pressed, pointer_clicks, transitioned) =
        activate_exact_title_candidate(&element, point, search_target.title, target_pid)?;
    log::info!(
        "[DEBUG][wechat_automation] AX point scan clicked title role={role} rank={rank} publisher_match={} date_match={} context_chars={} x_ratio={x_ratio:.2} y_ratio={y_ratio:.2} text_chars={text_chars} extra_chars={extra_chars} quick_answer={quick_answer} pressed={pressed} pointer_clicks={pointer_clicks} transitioned={transitioned} matches={}",
        metadata.publisher_match,
        metadata.date_match,
        metadata.context_chars,
        matches.len() + 1
    );
    Ok(transitioned || pressed || pointer_clicks > 0)
}

fn activate_exact_title_candidate(
    element: &AxElement,
    point: CGPoint,
    title: &str,
    target_pid: Option<i32>,
) -> Result<(bool, usize, bool), String> {
    log_candidate_ancestor_diagnostics(element);
    let (action_element, action_point, action_role, action_depth) =
        actionable_ancestor(element, point);
    let action = CFString::from_static_string("AXPress");
    let pressed = unsafe {
        AXUIElementPerformAction(action_element.0, action.as_concrete_TypeRef()) == AX_ERROR_SUCCESS
    };
    log::info!(
        "[DEBUG][wechat_automation] result action target role={action_role} depth={action_depth} x={} y={} pressed={pressed}",
        action_point.x.round(),
        action_point.y.round()
    );
    if pressed && wait_for_title_to_leave_point(point, title, RESULT_CLICK_TRANSITION_TIMEOUT) {
        return Ok((true, 0, true));
    }

    let mut pointer_clicks = 0;
    for attempt in 1..=RESULT_CLICK_RETRIES {
        pointer_clicks += 1;
        post_left_click(action_point, target_pid)?;
        let transitioned =
            wait_for_title_to_leave_point(point, title, RESULT_CLICK_TRANSITION_TIMEOUT);
        log::info!(
            "[DEBUG][wechat_automation] result pointer click attempt={attempt} transitioned={transitioned}"
        );
        if transitioned {
            return Ok((pressed, pointer_clicks, true));
        }
    }

    Ok((pressed, pointer_clicks, false))
}

fn actionable_ancestor(
    element: &AxElement,
    fallback_point: CGPoint,
) -> (AxElement, CGPoint, String, usize) {
    let mut current = Some(element.clone());
    for depth in 0..7 {
        let Some(candidate) = current else {
            break;
        };
        let role = copy_string_attr(&candidate, "AXRole").unwrap_or_default();
        if matches!(
            role.as_str(),
            "AXLink" | "AXButton" | "AXMenuItem" | "AXRow" | "AXCell"
        ) {
            let point = copy_ax_frame(&candidate)
                .map(|frame| {
                    CGPoint::new(
                        frame.origin.x + frame.size.width * 0.5,
                        frame.origin.y + frame.size.height * 0.5,
                    )
                })
                .unwrap_or(fallback_point);
            return (candidate, point, role, depth);
        }
        current = copy_element_attr(&candidate, "AXParent");
    }
    let role = copy_string_attr(element, "AXRole").unwrap_or_default();
    (element.clone(), fallback_point, role, 0)
}

fn log_candidate_ancestor_diagnostics(element: &AxElement) {
    let mut current = Some(element.clone());
    for depth in 0..7 {
        let Some(candidate) = current else {
            break;
        };
        let role = copy_string_attr(&candidate, "AXRole").unwrap_or_default();
        let text_chars = ["AXTitle", "AXDescription", "AXValue"]
            .into_iter()
            .filter_map(|attribute| copy_string_attr(&candidate, attribute))
            .map(|value| normalized_text(&value).chars().count())
            .sum::<usize>();
        let frame = copy_ax_frame(&candidate);
        log::info!(
            "[DEBUG][wechat_automation] result ancestor depth={depth} role={role} text_chars={text_chars} x={} y={} width={} height={}",
            frame.map(|value| value.origin.x.round()).unwrap_or(-1.0),
            frame.map(|value| value.origin.y.round()).unwrap_or(-1.0),
            frame.map(|value| value.size.width.round()).unwrap_or(-1.0),
            frame.map(|value| value.size.height.round()).unwrap_or(-1.0)
        );
        current = copy_element_attr(&candidate, "AXParent");
    }
}

fn wait_for_title_to_leave_point(point: CGPoint, title: &str, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let mut consecutive_absences = 0_usize;
    while Instant::now() < deadline {
        thread::sleep(Duration::from_millis(120));
        if title_visible_at_point(point, title) {
            consecutive_absences = 0;
        } else {
            consecutive_absences += 1;
            if consecutive_absences >= 2 {
                return true;
            }
        }
    }
    false
}

fn title_visible_at_point(point: CGPoint, title: &str) -> bool {
    let Some(system) = (unsafe { AxElement::from_create_rule(AXUIElementCreateSystemWide()) })
    else {
        return false;
    };
    let mut raw_target: AXUIElementRef = ptr::null_mut();
    let error = unsafe {
        AXUIElementCopyElementAtPosition(system.0, point.x as f32, point.y as f32, &mut raw_target)
    };
    let Some(target) = (error == AX_ERROR_SUCCESS)
        .then(|| unsafe { AxElement::from_create_rule(raw_target) })
        .flatten()
    else {
        return false;
    };
    let expected = normalized_text(title);
    let text = ["AXTitle", "AXDescription", "AXValue"]
        .into_iter()
        .filter_map(|attribute| copy_string_attr(&target, attribute))
        .collect::<Vec<_>>()
        .join(" ");
    title_match_rank(&normalized_text(&text), &expected).is_some()
}

fn press_web_search_entry(app: &AxElement, query: &str) -> Result<bool, String> {
    let query_key = normalized_text(query);
    let strong_prefix = query_key
        .chars()
        .take(MIN_STRONG_TITLE_PREFIX_CHARS)
        .collect::<String>();
    let mut nodes = collect_ax_nodes(app)?;
    nodes.sort_by_key(|node| role_priority(&node.role));
    for node in &nodes {
        let key = normalized_text(&node.text);
        let contains_query =
            key.contains(&query_key) || (!strong_prefix.is_empty() && key.contains(&strong_prefix));
        let search_label = key.contains("搜一搜")
            || key.contains("searchtheweb")
            || key.contains("websearch")
            || key.contains("searchwechat")
            || (key.contains("搜索") && contains_query);
        if search_label {
            let pressed = press_element_or_parent(&node.element);
            log::info!(
                "[DEBUG][wechat_automation] web search candidate role={} text_chars={} pressed={pressed}",
                node.role,
                key.chars().count()
            );
            if pressed {
                log::debug!(
                    "pressed WeChat web-search Accessibility node (role={})",
                    node.role
                );
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn press_web_search_entry_by_point_scan(
    app: &AxElement,
    query: &str,
    target_pid: i32,
) -> Result<bool, String> {
    let query_key = normalized_text(query);
    let strong_prefix = query_key
        .chars()
        .take(MIN_STRONG_TITLE_PREFIX_CHARS)
        .collect::<String>();
    let sheet_frames = collect_ax_nodes(app)
        .unwrap_or_default()
        .into_iter()
        .filter(|node| node.role == "AXSheet")
        .filter_map(|node| copy_ax_frame(&node.element))
        .filter(|frame| frame.size.width >= 180.0 && frame.size.height >= 120.0)
        .collect::<Vec<_>>();
    if sheet_frames.is_empty() {
        return Ok(false);
    }
    let Some(system) = (unsafe { AxElement::from_create_rule(AXUIElementCreateSystemWide()) })
    else {
        return Ok(false);
    };

    for frame in sheet_frames {
        for y_step in 1..=18 {
            let y_ratio = f64::from(y_step) * 0.05;
            for x_ratio in [0.18_f64, 0.34, 0.50, 0.66, 0.82] {
                let point = CGPoint::new(
                    frame.origin.x + frame.size.width * x_ratio,
                    frame.origin.y + frame.size.height * y_ratio,
                );
                let mut raw_target: AXUIElementRef = ptr::null_mut();
                let error = unsafe {
                    AXUIElementCopyElementAtPosition(
                        system.0,
                        point.x as f32,
                        point.y as f32,
                        &mut raw_target,
                    )
                };
                let Some(mut element) = (error == AX_ERROR_SUCCESS)
                    .then(|| unsafe { AxElement::from_create_rule(raw_target) })
                    .flatten()
                else {
                    continue;
                };
                for depth in 0..=5 {
                    let role = copy_string_attr(&element, "AXRole").unwrap_or_default();
                    let text = ["AXTitle", "AXDescription", "AXValue"]
                        .into_iter()
                        .filter_map(|attribute| copy_string_attr(&element, attribute))
                        .collect::<Vec<_>>()
                        .join(" ");
                    let label = normalized_text(&text);
                    let explicit_web_search = label.contains("搜一搜")
                        || label.contains("searchtheweb")
                        || label.contains("websearch")
                        || label.contains("searchwechat");
                    let generic_search_with_query = if label == "search" || label == "搜索" {
                        let context = normalized_text(&candidate_context_text(&element));
                        !strong_prefix.is_empty() && context.contains(&strong_prefix)
                    } else {
                        false
                    };
                    if explicit_web_search || generic_search_with_query {
                        let pressed = press_element_or_parent(&element);
                        if !pressed {
                            post_left_click(point, Some(target_pid))?;
                        }
                        log::info!(
                            "[DEBUG][wechat_automation] web search point candidate role={role} depth={depth} explicit={explicit_web_search} pressed={pressed} x_ratio={x_ratio:.2} y_ratio={y_ratio:.2}"
                        );
                        return Ok(true);
                    }
                    let Some(parent) = copy_element_attr(&element, "AXParent") else {
                        break;
                    };
                    element = parent;
                }
            }
        }
    }
    Ok(false)
}

fn press_web_search_entry_in_apps(apps: &[(i32, AxElement)], query: &str) -> Result<bool, String> {
    for (pid, app) in apps {
        match press_web_search_entry(app, query) {
            Ok(true) => return Ok(true),
            Ok(false) | Err(_) => {}
        }
        match press_web_search_entry_by_point_scan(app, query, *pid) {
            Ok(true) => return Ok(true),
            Ok(false) | Err(_) => {}
        }
    }
    Ok(false)
}

fn log_article_result_diagnostics(apps: &[(i32, AxElement)], title: &str) {
    let expected = normalized_text(title);
    let prefix6 = expected.chars().take(6).collect::<String>();
    let prefix12 = expected.chars().take(12).collect::<String>();
    let prefix18 = expected
        .chars()
        .take(MIN_STRONG_TITLE_PREFIX_CHARS)
        .collect::<String>();
    for (pid, app) in apps {
        let Ok(nodes) = collect_ax_nodes(app) else {
            log::warn!("[DEBUG][wechat_automation] result diagnostics pid={pid} unavailable=true");
            continue;
        };
        let mut roles = BTreeMap::<String, usize>::new();
        let mut non_empty = 0_usize;
        let mut prefix6_hits = 0_usize;
        let mut prefix12_hits = 0_usize;
        let mut prefix18_hits = 0_usize;
        let mut search_chrome_hits = 0_usize;
        let mut best_prefix = 0_usize;
        for node in &nodes {
            *roles.entry(node.role.clone()).or_default() += 1;
            let text = normalized_text(&node.text);
            if text.is_empty() {
                continue;
            }
            non_empty += 1;
            prefix6_hits += usize::from(!prefix6.is_empty() && text.contains(&prefix6));
            prefix12_hits += usize::from(!prefix12.is_empty() && text.contains(&prefix12));
            prefix18_hits += usize::from(!prefix18.is_empty() && text.contains(&prefix18));
            search_chrome_hits += usize::from(is_search_chrome_text(&text));
            best_prefix = best_prefix.max(
                text.chars()
                    .zip(expected.chars())
                    .take_while(|(actual, expected)| actual == expected)
                    .count(),
            );
        }
        let role_summary = roles
            .into_iter()
            .filter(|(_, count)| *count > 0)
            .map(|(role, count)| format!("{role}:{count}"))
            .collect::<Vec<_>>()
            .join(",");
        log::warn!(
            "[DEBUG][wechat_automation] result diagnostics pid={pid} nodes={} non_empty={non_empty} prefix6_hits={prefix6_hits} prefix12_hits={prefix12_hits} prefix18_hits={prefix18_hits} best_prefix={best_prefix} search_chrome_hits={search_chrome_hits} roles={role_summary}",
            nodes.len()
        );
    }
}

fn collect_ax_nodes(root: &AxElement) -> Result<Vec<AxNode>, String> {
    let mut result = Vec::new();
    let mut queue = VecDeque::from([(root.clone(), 0_usize)]);
    let mut visited = HashSet::new();
    while let Some((element, depth)) = queue.pop_front() {
        if result.len() >= MAX_AX_ELEMENTS {
            break;
        }
        if !visited.insert(element.0 as usize) {
            continue;
        }
        let role = copy_string_attr(&element, "AXRole").unwrap_or_default();
        let text = [
            "AXTitle",
            "AXDescription",
            "AXValue",
            "AXPlaceholderValue",
            "AXHelp",
            "AXIdentifier",
        ]
        .into_iter()
        .filter_map(|attribute| copy_string_attr(&element, attribute))
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        result.push(AxNode {
            element: element.clone(),
            role,
            text,
        });
        if depth < MAX_AX_DEPTH {
            for child in copy_children(&element) {
                queue.push_back((child, depth + 1));
            }
        }
    }
    if result.len() == 1 {
        Err("微信没有向辅助功能接口暴露可操作的窗口内容".to_string())
    } else {
        Ok(result)
    }
}

fn press_element_or_parent(element: &AxElement) -> bool {
    let action = CFString::from_static_string("AXPress");
    let mut current = Some(element.clone());
    for _ in 0..7 {
        let Some(candidate) = current else {
            break;
        };
        if unsafe { AXUIElementPerformAction(candidate.0, action.as_concrete_TypeRef()) }
            == AX_ERROR_SUCCESS
        {
            return true;
        }
        current = copy_element_attr(&candidate, "AXParent");
    }
    false
}

fn copy_children(element: &AxElement) -> Vec<AxElement> {
    copy_element_array_attr(element, "AXChildren")
}

fn copy_element_array_attr(element: &AxElement, attribute: &str) -> Vec<AxElement> {
    let Some(value) = copy_raw_attr(element, attribute) else {
        return Vec::new();
    };
    if unsafe { CFGetTypeID(value) != CFArrayGetTypeID() } {
        unsafe { CFRelease(value) };
        return Vec::new();
    }
    let count = unsafe { CFArrayGetCount(value as _) };
    let mut children = Vec::with_capacity(count.max(0) as usize);
    for index in 0..count {
        let child = unsafe { CFArrayGetValueAtIndex(value as _, index) as AXUIElementRef };
        if let Some(child) = unsafe { AxElement::from_borrowed(child) } {
            children.push(child);
        }
    }
    unsafe { CFRelease(value) };
    children
}

fn copy_element_attr(element: &AxElement, attribute: &str) -> Option<AxElement> {
    let value = copy_raw_attr(element, attribute)?;
    unsafe { AxElement::from_create_rule(value as AXUIElementRef) }
}

fn copy_string_attr(element: &AxElement, attribute: &str) -> Option<String> {
    let value = copy_raw_attr(element, attribute)?;
    let is_string = unsafe { CFGetTypeID(value) == CFStringGetTypeID() };
    if !is_string {
        unsafe { CFRelease(value) };
        return None;
    }
    let string = unsafe { CFString::wrap_under_create_rule(value as CFStringRef) }.to_string();
    (!string.is_empty()).then_some(string)
}

fn copy_raw_attr(element: &AxElement, attribute: &str) -> Option<CFTypeRef> {
    let key = CFString::new(attribute);
    let mut value: CFTypeRef = ptr::null();
    let error =
        unsafe { AXUIElementCopyAttributeValue(element.0, key.as_concrete_TypeRef(), &mut value) };
    (error == AX_ERROR_SUCCESS && !value.is_null()).then_some(value)
}

fn normalized_text(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn title_match_rank(text: &str, expected: &str) -> Option<usize> {
    if text.contains(expected) {
        return Some(0);
    }
    let prefix = expected
        .chars()
        .take(MIN_STRONG_TITLE_PREFIX_CHARS)
        .collect::<String>();
    (prefix.chars().count() >= MIN_STRONG_TITLE_PREFIX_CHARS && text.contains(&prefix)).then_some(1)
}

fn is_article_result_role(role: &str) -> bool {
    matches!(
        role,
        "AXLink" | "AXButton" | "AXMenuItem" | "AXRow" | "AXCell" | "AXHeading" | "AXStaticText"
    )
}

fn is_search_chrome_text(text: &str) -> bool {
    text.contains("搜一搜")
        || text.starts_with("搜索")
        || text.contains("searchtheweb")
        || text.contains("websearch")
        || text.contains("searchwechat")
}

fn role_priority(role: &str) -> usize {
    match role {
        "AXLink" | "AXButton" | "AXMenuItem" => 0,
        "AXRow" | "AXCell" => 1,
        "AXHeading" | "AXGroup" => 2,
        _ => 3,
    }
}

#[cfg(test)]
mod tests {
    use core_foundation::{
        array::{CFArrayGetCount, CFArrayGetValueAtIndex},
        base::{CFRelease, CFTypeRef, TCFType},
        dictionary::CFDictionaryRef,
        string::{CFString, CFStringRef},
    };
    use core_graphics::geometry::{CGPoint, CGRect};
    use std::ffi::c_void;

    use super::{
        candidate_metadata_from_context, extract_base64_bizuin_values, first_green_result_pixel,
        first_result_green_pixel, first_result_pixel_sample, first_result_render_changed,
        is_article_result_role, is_search_chrome_text, normalized_text, published_date_keys,
        title_match_rank, WechatArticleSearchTarget,
    };

    #[test]
    #[ignore = "requires a running WeChat instance; read-only window diagnostics"]
    fn live_reports_wechat_web_window_surfaces() {
        let processes = super::running_application_pids().expect("running WeChat");
        let mut pids = processes.ui_pids.clone();
        pids.sort_unstable();
        pids.dedup();
        pids.retain(|pid| *pid != processes.main_pid);
        pids.push(processes.main_pid);
        for pid in &pids {
            let Some(app) = (unsafe {
                super::AxElement::from_create_rule(super::AXUIElementCreateApplication(*pid))
            }) else {
                continue;
            };
            let ax_windows = super::copy_element_array_attr(&app, "AXWindows");
            eprintln!("AX owner pid={} windows={}", pid, ax_windows.len());
            for (index, window) in ax_windows.iter().enumerate() {
                let title = super::copy_string_attr(window, "AXTitle").unwrap_or_default();
                let frame = super::copy_ax_frame(window);
                eprintln!(
                    "AX window index={} title_chars={} frame={:?}",
                    index,
                    title.chars().count(),
                    frame.map(|value| (
                        value.origin.x.round(),
                        value.origin.y.round(),
                        value.size.width.round(),
                        value.size.height.round()
                    ))
                );
            }
            if let Ok(expected_title) = std::env::var("WXMP_TEST_SEARCH_TITLE") {
                let expected = super::normalized_text(&expected_title);
                if let Ok(nodes) = super::collect_ax_nodes(&app) {
                    for node in nodes {
                        let text = super::normalized_text(&node.text);
                        let Some(rank) = super::title_match_rank(&text, &expected) else {
                            continue;
                        };
                        eprintln!(
                            "AX title match owner_pid={} role={} rank={} text_chars={} frame={:?}",
                            pid,
                            node.role,
                            rank,
                            text.chars().count(),
                            super::copy_ax_frame(&node.element).map(|value| (
                                value.origin.x.round(),
                                value.origin.y.round(),
                                value.size.width.round(),
                                value.size.height.round()
                            ))
                        );
                        super::log_candidate_ancestor_diagnostics(&node.element);
                    }
                }
            }
        }
        let windows = super::wechat_web_windows(&pids, false);

        eprintln!("wechat web windows: {}", windows.len());
        for window in windows {
            let sample = super::first_result_visible_render_sample(&pids, window);
            eprintln!(
                "window id={} main={} on_screen={} account_search={} other_search={} x={} y={} width={} height={} sample={:?}",
                window.id,
                window.is_main_surface,
                window.is_on_screen,
                window.is_account_search_surface,
                window.is_other_search_surface,
                window.frame.origin.x.round(),
                window.frame.origin.y.round(),
                window.frame.size.width.round(),
                window.frame.size.height.round(),
                sample.map(|value| (
                    value.ink_per_mille(),
                    value.light_per_mille(),
                    value.ready()
                ))
            );
        }

        const EXCLUDE_DESKTOP: u32 = 1 << 4;
        let raw_windows = unsafe { super::CGWindowListCopyWindowInfo(EXCLUDE_DESKTOP, 0) };
        if raw_windows.is_null() {
            return;
        }
        let count = unsafe { CFArrayGetCount(raw_windows) };
        for index in 0..count {
            let dictionary =
                unsafe { CFArrayGetValueAtIndex(raw_windows, index) as CFDictionaryRef };
            if dictionary.is_null() {
                continue;
            }
            let owner = unsafe {
                super::CFDictionaryGetValue(dictionary, super::kCGWindowOwnerPID as *const c_void)
            };
            let mut owner_pid = 0_i32;
            if owner.is_null()
                || !unsafe {
                    super::CFNumberGetValue(owner, 3, &mut owner_pid as *mut i32 as *mut c_void)
                }
                || !pids.contains(&owner_pid)
            {
                continue;
            }
            let layer = unsafe {
                super::CFDictionaryGetValue(dictionary, super::kCGWindowLayer as *const c_void)
            };
            let mut layer_number = -1_i32;
            if !layer.is_null() {
                let _ = unsafe {
                    super::CFNumberGetValue(layer, 3, &mut layer_number as *mut i32 as *mut c_void)
                };
            }
            let bounds = unsafe {
                super::CFDictionaryGetValue(dictionary, super::kCGWindowBounds as *const c_void)
            };
            let mut frame = CGRect::new(
                &CGPoint::new(0.0, 0.0),
                &core_graphics::geometry::CGSize::new(0.0, 0.0),
            );
            if bounds.is_null()
                || !unsafe {
                    super::CGRectMakeWithDictionaryRepresentation(
                        bounds as CFDictionaryRef,
                        &mut frame,
                    )
                }
            {
                continue;
            }
            let name = unsafe {
                super::CFDictionaryGetValue(dictionary, super::kCGWindowName as *const c_void)
            };
            let name_chars = if name.is_null() {
                0
            } else {
                unsafe { CFString::wrap_under_get_rule(name as CFStringRef) }
                    .to_string()
                    .chars()
                    .count()
            };
            let on_screen = unsafe {
                super::CFDictionaryGetValue(dictionary, super::kCGWindowIsOnscreen as *const c_void)
            };
            let on_screen = !on_screen.is_null() && unsafe { super::CFBooleanGetValue(on_screen) };
            eprintln!(
                "raw window owner_pid={} layer={} on_screen={} name_chars={} x={} y={} width={} height={}",
                owner_pid,
                layer_number,
                on_screen,
                name_chars,
                frame.origin.x.round(),
                frame.origin.y.round(),
                frame.size.width.round(),
                frame.size.height.round()
            );
        }
        unsafe { CFRelease(raw_windows as CFTypeRef) };
    }

    #[test]
    fn first_result_render_readiness_rejects_blank_loading_surface() {
        let pixels = vec![255_u8; 100 * 40 * 4];
        let sample =
            first_result_pixel_sample(&pixels, 100, 40, 400, 8, 32).expect("valid blank surface");

        assert!(!sample.ready());
        assert_eq!(sample.ink_per_mille(), 0);
        assert_eq!(sample.light_per_mille(), 1_000);
    }

    #[test]
    fn first_result_render_readiness_accepts_text_on_light_card() {
        let mut pixels = vec![255_u8; 100 * 40 * 4];
        for index in 0..80 {
            let offset = index * 4;
            pixels[offset..offset + 4].copy_from_slice(&[30, 150, 20, 255]);
        }
        let sample = first_result_pixel_sample(&pixels, 100, 40, 400, 8, 32)
            .expect("valid rendered surface");

        assert!(sample.ready());
        assert_eq!(sample.ink_per_mille(), 20);
        assert_eq!(sample.light_per_mille(), 980);
    }

    #[test]
    fn first_result_render_readiness_rejects_privacy_black_frame() {
        let pixels = vec![0_u8; 100 * 40 * 4];
        let sample =
            first_result_pixel_sample(&pixels, 100, 40, 400, 8, 32).expect("valid privacy surface");

        assert!(!sample.ready());
        assert_eq!(sample.ink_per_mille(), 1_000);
        assert_eq!(sample.light_per_mille(), 0);
    }

    #[test]
    fn first_result_transition_requires_a_material_surface_change() {
        let before = super::FirstResultRenderSample {
            ink_pixels: 140,
            light_pixels: 840,
            total_pixels: 1_000,
            surface_signature: 11,
        };
        let stable = super::FirstResultRenderSample {
            ink_pixels: 145,
            light_pixels: 835,
            total_pixels: 1_000,
            surface_signature: 11,
        };
        let navigated = super::FirstResultRenderSample {
            ink_pixels: 20,
            light_pixels: 970,
            total_pixels: 1_000,
            surface_signature: 22,
        };

        assert!(!first_result_render_changed(before, stable));
        assert!(first_result_render_changed(before, navigated));
    }

    #[test]
    fn first_result_green_link_locator_returns_an_actual_title_pixel() {
        let mut pixels = vec![255_u8; 100 * 40 * 4];
        for column in 20..40 {
            let offset = (6 * 100 + column) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[90, 195, 10, 255]);
        }

        let point =
            first_result_green_pixel(&pixels, 100, 40, 400, 8, 32).expect("green title pixel");
        assert!((20..40).contains(&point.0));
        assert_eq!(point.1, 6);
        assert!(!point.2);
    }

    #[test]
    fn first_result_green_link_locator_skips_a_tall_quick_answer_card() {
        let mut pixels = vec![255_u8; 100 * 120 * 4];
        for row in 5..8 {
            for column in 10..35 {
                let offset = (row * 100 + column) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[90, 195, 10, 255]);
            }
        }
        for row in 80..83 {
            for column in 45..75 {
                let offset = (row * 100 + column) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[90, 195, 10, 255]);
            }
        }

        let point = first_result_green_pixel(&pixels, 100, 120, 400, 8, 32)
            .expect("article title below quick answer");
        assert!((45..75).contains(&point.0));
        assert!((80..83).contains(&point.1));
        assert!(point.2);
    }

    #[test]
    fn account_result_green_locator_keeps_the_first_candidate() {
        let mut pixels = vec![255_u8; 100 * 120 * 4];
        for row in 5..8 {
            for column in 10..35 {
                let offset = (row * 100 + column) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[90, 195, 10, 255]);
            }
        }
        for row in 80..83 {
            for column in 45..75 {
                let offset = (row * 100 + column) * 4;
                pixels[offset..offset + 4].copy_from_slice(&[90, 195, 10, 255]);
            }
        }

        let point = first_green_result_pixel(&pixels, 100, 120, 400, 8, 32)
            .expect("first account candidate");
        assert!((10..35).contains(&point.0));
        assert!((5..8).contains(&point.1));
        assert!(!point.2);
    }

    #[test]
    fn indexeddb_parser_extracts_only_base64_bizuin_values() {
        let mut bytes = b"prefix base64_bizuin".to_vec();
        bytes.extend_from_slice(&[b'"', 16]);
        bytes.extend_from_slice(b"Mzg3NDc2MjQxMg==");
        bytes.extend_from_slice(b" suffix base64_bizuin\"\x05bad!? other");

        let values = extract_base64_bizuin_values(&bytes);
        assert_eq!(values.len(), 1);
        assert!(values.contains("Mzg3NDc2MjQxMg=="));
    }

    #[test]
    fn first_result_green_link_locator_rejects_gray_body_text() {
        let mut pixels = vec![255_u8; 100 * 40 * 4];
        for column in 20..40 {
            let offset = (6 * 100 + column) * 4;
            pixels[offset..offset + 4].copy_from_slice(&[120, 120, 120, 255]);
        }

        assert_eq!(first_result_green_pixel(&pixels, 100, 40, 400, 8, 32), None);
    }

    #[test]
    fn title_matching_ignores_punctuation_width_and_spacing() {
        assert_eq!(
            normalized_text("我在硅谷，聊了两小时：99% 都会犯错"),
            normalized_text("我在硅谷,聊了两小时:99%都会犯错")
        );
    }

    #[test]
    fn title_matching_accepts_a_strong_truncated_prefix() {
        let expected = normalized_text(
            "我在硅谷和一个辅导过数百位创始人的销售导师聊了两小时他说早期创始人都在犯错",
        );
        let truncated = normalized_text("我在硅谷和一个辅导过数百位创始人的销售导师…");

        assert_eq!(title_match_rank(&truncated, &expected), Some(1));
        assert_eq!(title_match_rank("我在硅谷", &expected), None);
    }

    #[test]
    fn article_result_matching_rejects_search_input_chrome() {
        assert!(!is_article_result_role("AXTextField"));
        assert!(is_article_result_role("AXStaticText"));
        assert!(is_article_result_role("AXHeading"));
        assert!(is_article_result_role("AXMenuItem"));
        assert!(is_search_chrome_text(&normalized_text(
            "搜一搜 上个周末，我们在博物馆玩 AI"
        )));
        assert!(!is_search_chrome_text(&normalized_text(
            "上个周末，我们在博物馆玩 AI"
        )));
    }

    #[test]
    fn result_metadata_uses_publisher_and_publish_date_as_identity_evidence() {
        let published_at = 1_785_545_698_i64;
        let date_key = published_date_keys(published_at)
            .into_iter()
            .next()
            .expect("publish date key");
        let target = WechatArticleSearchTarget {
            title: "上个周末，我们在博物馆玩 AI",
            publisher: Some("通往AGI之路"),
            fakeid: "MzkzMzQ5MDA5Ng==",
            published_at,
        };
        let matched = candidate_metadata_from_context(
            &format!("上个周末，我们在博物馆玩 AI 通往AGI之路 {date_key}"),
            &target,
        );
        let wrong_publisher = candidate_metadata_from_context(
            &format!("上个周末，我们在博物馆玩 AI 另一个公众号 {date_key}"),
            &target,
        );

        assert!(matched.publisher_match);
        assert!(matched.date_match);
        assert_eq!(matched.publisher_penalty, 0);
        assert_eq!(matched.date_penalty, 0);
        assert!(!wrong_publisher.publisher_match);
        assert_eq!(wrong_publisher.publisher_penalty, 1);
    }
}
