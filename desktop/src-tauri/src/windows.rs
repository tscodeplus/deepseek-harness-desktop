//! Window family: splash, main WebUI window (declared in tauri.conf.json),
//! updater dialogs, and the error window. Theme chrome reactions live here
//! too.

use std::sync::Arc;

use tauri::webview::PageLoadEvent;
use tauri::WebviewUrl;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use crate::config::{config_path, DesktopConfig, ShellConfig};
use crate::i18n::tr;
use crate::sidecar::SidecarState;

pub const MAIN_LABEL: &str = "main";
pub const SPLASH_LABEL: &str = "splash";
pub const ERROR_LABEL: &str = "error";
pub const PROGRESS_LABEL: &str = "updater-progress";
pub const ABOUT_LABEL: &str = "about";

/// Upstream provenance shown in the About dialog — mirrors
/// `desktop/dsh-ref.json` (single-mode dependency following).
#[derive(serde::Deserialize)]
struct DshRef {
    #[serde(rename = "ref")]
    commit: String,
    #[serde(default)]
    tag: Option<String>,
    #[serde(default)]
    upstream_version: Option<String>,
}

fn dsh_ref() -> DshRef {
    serde_json::from_str(include_str!("../../dsh-ref.json"))
        .unwrap_or(DshRef {
            commit: String::new(),
            tag: None,
            upstream_version: None,
        })
}

/// How long the shell waits for the WebUI's own boot chain to settle (the
/// boot-watch init script normally signals in a couple of seconds) before
/// revealing the main window anyway. Fail-safe only: a hidden-webview stall,
/// a future dsh change that breaks detection, or a lost boot-settled POST
/// must never leave the user stuck on the splash forever.
const BOOT_SETTLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// Shell-owned pages (splash / error) are served by the shell's own control
/// service (ctl_server.rs) — they must render even when the sidecar or the
/// dsh web server is down, which is exactly when the error window appears.
fn shell_page_url(page: &str) -> WebviewUrl {
    WebviewUrl::External(
        format!("http://127.0.0.1:{}/pages/{page}", crate::ctl_server::port())
            .parse::<tauri::Url>()
            .expect("ctl page url"),
    )
}

/// WebUI URL for the main window. dsh is local-only, so this is always the
/// loopback web server. `cache_bust` appends a `_ts` query param so a
/// navigate after config changes isn't served from the webview cache.
pub fn webui_url(app: &AppHandle, cache_bust: bool) -> String {
    // dsh is local-only: always the loopback web server.
    let port = ShellConfig::load(app).server_port;
    let base = format!("http://127.0.0.1:{port}");
    if cache_bust {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        format!("{base}/?_ts={ts}")
    } else {
        base
    }
}

/// Main window — built in code (not tauri.conf.json). Hidden until the dsh
/// web server is ready AND the WebUI's own boot chain has settled: the
/// window is *created lazily* once the sidecar health poll succeeds
/// (reveal_main_window) so the WebView's first navigation never hits a
/// not-yet-listening server (an early load would leave the webview stuck on
/// the ERR_CONNECTION_REFUSED error page), and it stays hidden behind the
/// shell splash until boot-watch.js signals boot-settled (single-splash UX).
///
/// Immersive shell (mirrors the Electron frameless + titleBarOverlay look
/// used by OhMyAgent and anywhere-labs/deepseek-harness-desktop): no native
/// toolbar. On Windows/Linux the window is fully frameless and caption.js —
/// injected via initialization_script, WITHOUT touching upstream dsh source —
/// adds the overlay chrome the WebUI does not draw itself: an invisible
/// 44px drag region at the top (the page is pushed down by that inset) plus
/// floating minimize/maximize/close buttons driving the core window
/// commands. macOS keeps the native traffic lights via TitleBarStyle::Overlay.
pub fn create_main_window(app: &AppHandle) -> tauri::Result<()> {
    let url = WebviewUrl::External(
        webui_url(app, false)
            .parse::<tauri::Url>()
            .expect("static url"),
    );
    let mut builder = WebviewWindowBuilder::new(app, MAIN_LABEL, url)
        .title("DeepSeek Harness")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .visible(false)
        .background_color(tauri::window::Color::from((10, 10, 10)))
        .icon(window_icon())?;
    #[cfg(target_os = "macos")]
    {
        // hiddenInset-style: transparent title bar, content under it, native
        // traffic lights parked where the WebUI's sidebar clears them. dsh's
        // sidebar logo row starts at y=24 (measured in the web dist), so the
        // buttons sit at y=12 (up from 18) to leave a visible gap above the
        // logo — the same 16px left inset as OhMyAgent / anywhere-labs.
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 12.0));
    }
    #[cfg(not(target_os = "macos"))]
    {
        // Windows/Linux: frameless like OhMyAgent — caption.js (injected at
        // runtime, upstream untouched) provides the drag region and window
        // buttons.
        builder = builder
            .decorations(false)
            .initialization_script(include_str!("../caption.js"));
    }
    // Single-splash gate (all platforms): the window is created HIDDEN while
    // the WebUI runs its own boot chain, so its duplicate boot loading page
    // is never visible. boot-watch.js watches that page and POSTs
    // /_desktop/boot-settled to the shell control service once the boot
    // settled (or failed loudly); only then does the shell swap splash →
    // main window (see reveal_main_window / show_main_window). The config
    // rides in as a JSON init script — plain fetch to the ctl server, no
    // Tauri IPC / capability change needed on the remote 127.0.0.1 origin.
    let boot_watch_cfg = format!(
        "window.__DSHD_BOOT_WATCH__ = {};",
        serde_json::json!({
            "ctlPort": crate::ctl_server::port(),
            "token": crate::ctl_server::token().unwrap_or_default(),
        })
    );
    builder = builder
        .initialization_script(boot_watch_cfg)
        .initialization_script(include_str!("../boot-watch.js"));
    builder.build()?;
    Ok(())
}

/// 64×64 window icon — the Windows title bar / taskbar renders at 16-48px
/// (32-96px at high DPI), and the 32px source this replaced got upscaled on
/// 125%/150% displays. macOS ignores it (no title-bar icon there); the Dock
/// uses the packaged .icns.
fn window_icon() -> tauri::image::Image<'static> {
    // 128px render of the upstream whale SVG (icons/128x128.png, regenerated
    // via `tauri icon` from assets/icon-source.svg) — the old 64px source
    // looked soft in the taskbar on 125%/150% displays.
    tauri::image::Image::from_bytes(include_bytes!("../icons/128x128.png"))
        .expect("128x128.png embedded")
}

/// Splash shown while the sidecar boots dsh AND while the WebUI's own boot
/// chain settles inside the hidden main window. Branding mirrors the
/// top-left corner of https://www.deepseek.com/harness/ (dark): DeepSeek
/// wordmark + raised "Harness" pill on the page's dark background — see
/// pages/splash.html for the exact tokens and the platform split (Windows
/// shadow off, macOS native shadow).
///
/// Created hidden and shown on page-load-Finished: a visible window before the
/// webview paints shows the default white background for a frame (the
/// transparent layer does not apply until the HTML renders), which reads as a
/// white flash on startup.
pub fn create_splash(app: &AppHandle) -> tauri::Result<()> {
    if app.get_webview_window(SPLASH_LABEL).is_some() {
        return Ok(());
    }
    // The page is a static resource (pages/splash.html) loaded over the App
    // URL — data: URLs are unreliable on WKWebView (charset detection, and
    // plain-text rendering of the payload — wry dropped native data: URL
    // support in 0.37).
    let builder = WebviewWindowBuilder::new(app, SPLASH_LABEL, shell_page_url("splash.html"))
        .title("DeepSeek Harness")
        .inner_size(340.0, 240.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false);
    // Tauri/tao enables the undecorated-window shadow by default; on Windows
    // DWM paints that shadow as a subtle gray border around the transparent
    // splash. macOS keeps its native NSWindow shadow, which renders cleanly —
    // only Windows opts out.
    #[cfg(windows)]
    let builder = builder.shadow(false);
    builder
        .on_page_load(|win, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = win.show();
            }
        })
        .build()?;
    // Fallback reveal: on_page_load's Finished event rides WebView2's
    // NavigationCompleted, which is not reliable for data: URLs in a hidden
    // window — if it never fires, the splash would stay invisible forever.
    // Reveal after a short grace period instead (idempotent if the page-load
    // path already showed it; a no-op if the splash was already closed as the
    // main window appeared).
    {
        let app2 = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(400)).await;
            if let Some(splash) = app2.get_webview_window(SPLASH_LABEL) {
                let _ = splash.show();
            }
        });
    }
    Ok(())
}

/// Handle the main window once the sidecar answers /api/health. The window is
/// created lazily on first reveal (never at shell setup — see
/// create_main_window) so the first navigation lands on a live server. On
/// the first launch the window is created HIDDEN and only shown once the
/// WebUI boot chain settles (boot-watch.js → /_desktop/boot-settled →
/// show_main_window, with a watchdog fail-safe); on restart flows the
/// existing window is navigated and shown as before.
///
/// Creating a window requires the main thread; the show/focus half is
/// thread-safe and runs inline for the already-created case (restart flows).
pub fn reveal_main_window(app: &AppHandle) {
    if app.get_webview_window(MAIN_LABEL).is_none() {
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = create_main_window(&app2) {
                log::error!("windows: create_main_window failed: {e}");
                // The splash is the only thing on screen — a WebUI window
                // that cannot be created must not leave the user staring at
                // the splash forever.
                close_splash(&app2);
                let zh = crate::i18n::is_zh(&app2);
                let msg = crate::i18n::tr(
                    "窗口创建失败，请重启应用。",
                    "Failed to create the main window. Please restart the app.",
                    zh,
                );
                let _ = show_error_window(&app2, &msg);
                return;
            }
            // First launch: the window stays HIDDEN until the WebUI's boot
            // chain settles inside it (boot-watch.js → /_desktop/boot-settled
            // → show_main_window). The splash stays up meanwhile, so the
            // user only ever sees one loading screen — never the WebUI's
            // duplicate boot page. arm_boot_watchdog is the fail-safe.
            arm_boot_watchdog(&app2);
        });
        return;
    }
    let target = webui_url(app, true);
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let current = win
            .url()
            .map(|u| u.to_string())
            .unwrap_or_default()
            .split('?')
            .next()
            .unwrap_or_default()
            .to_string();
        let target_base = target.split('?').next().unwrap_or_default().to_string();
        if current != target_base {
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = app2.get_webview_window(MAIN_LABEL) {
                    if let Err(e) = win.navigate(target.parse().expect("webui url")) {
                        log::error!("windows: reveal_main_window navigate failed: {e}");
                    }
                }
            });
        }
    }
    show_main_window(app);
}

/// Fail-safe for the first-show boot gate: reveal the main window once the
/// splash has been up past BOOT_SETTLE_TIMEOUT without a boot-settled
/// signal. No-ops when the splash is already gone — that means either the
/// settled path ran (show_main_window closes it) or a crash / startup-timeout
/// path closed it and showed the error window; forcing the main window there
/// would surface a dead page over the error UI.
fn arm_boot_watchdog(app: &AppHandle) {
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(BOOT_SETTLE_TIMEOUT).await;
        if app2.get_webview_window(SPLASH_LABEL).is_some() {
            log::warn!("windows: WebUI boot settle timed out — revealing main window anyway");
            show_main_window(&app2);
        }
    });
}

/// Show + maximize + focus the main window, apply the current theme chrome
/// (DWM caption colors, background — needed on the freshly created window
/// since setup's apply_theme ran before it existed), then close the splash.
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        let cfg = DesktopConfig::load(&config_path(app));
        let _ = apply_theme(app, &cfg.theme);
        let _ = win.show();
        let _ = win.maximize();
        let _ = win.set_focus();
        // Splash's job is done; a leftover error window (service died, then
        // recovered via the restart button) is dismissed too.
        close_splash(app);
        if let Some(err_win) = app.get_webview_window(ERROR_LABEL) {
            let _ = err_win.close();
        }
    }
}

pub fn close_splash(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window(SPLASH_LABEL) {
        let _ = splash.close();
    }
}

/// Frameless error window with a message, a restart button and a dismiss
/// button. The runtime message and labels ride in via an initialization
/// script as JSON.
pub fn show_error_window(app: &AppHandle, message: &str) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(ERROR_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let zh = crate::i18n::is_zh(app);
    let title = crate::i18n::tr("服务异常", "Service Error", zh);
    let restart_label = crate::i18n::tr("重启服务", "Restart Service", zh);
    let ok_label = crate::i18n::tr("确定", "OK", zh);
    // The page is a static resource (pages/error.html); the runtime message
    // and labels ride in via an initialization script as JSON (rendered with
    // textContent — no HTML injection surface). data: URLs are unreliable on
    // WKWebView, so the page loads over the App URL instead.
    let payload = serde_json::json!({
        "title": title,
        "msg": message,
        "restart": restart_label,
        "ok": ok_label,
        "ctlPort": crate::ctl_server::port(),
        "ctlToken": crate::ctl_server::token(),
    });
    let init = format!("window.__DSHD_ERR__ = {};", payload);
    WebviewWindowBuilder::new(
        app,
        ERROR_LABEL,
        shell_page_url("error.html"),
    )
        .title("DeepSeek Harness")
        .inner_size(400.0, 250.0)
        .resizable(false)
        .decorations(false)
        .center()
        .initialization_script(init)
        .build()?;
    Ok(())
}

/// Updater dialogs pushed by the sidecar via POST /show-window.
/// `kind` selects the window label; an existing window is only shown again
/// (content updates come from the HTML's own polling of the control API).
///
/// The window loads http://127.0.0.1:{control_port}/_desktop/pages/updater/{kind}
/// (HTML cached by the sidecar's control server) instead of an embedded
/// data: URL.
pub fn show_dialog_window(
    app: &AppHandle,
    kind: &str,
    width: u32,
    height: u32,
    dark: bool,
) -> tauri::Result<()> {
    // Distinct labels per kind: a window is only *shown* if its label already
    // exists, so sharing one label (spinner + result) would freeze the dialog
    // on the first HTML forever.
    let label = match kind {
        "progress" => PROGRESS_LABEL,
        "spinner" => "updater-spinner",
        _ => "updater-dialog",
    };
    log::info!("windows: show_dialog_window kind={kind} → label={label}");
    // A result window replaces the transient spinner.
    if label != "updater-spinner" {
        if let Some(spin) = app.get_webview_window("updater-spinner") {
            let _ = spin.close();
        }
    }
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let state = app.state::<Arc<SidecarState>>();
    let port = state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst);
    let token = state.ctl_token.clone();
    let url = format!(
        "http://127.0.0.1:{port}/_desktop/pages/updater/{kind}?token={token}"
    );
    let zh = crate::i18n::is_zh(app);
    WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::External(url.parse().expect("updater page url")),
    )
    .title(crate::i18n::tr("DeepSeek Harness 更新", "DeepSeek Harness Update", zh))
    .inner_size(width as f64, height as f64)
    .resizable(false)
    .decorations(false)
    .background_color(tauri::window::Color::from((20, 20, 31)))
    .center()
    .build()?;
    let _ = dark;
    Ok(())
}

/// Close an updater dialog window by kind (label resolution mirrors
/// show_dialog_window). Called from the sidecar via the shell control
/// service (`POST /close-window`) when a dialog button asks to close.
pub fn close_dialog_window(app: &AppHandle, kind: &str) {
    let label = match kind {
        "progress" => PROGRESS_LABEL,
        "spinner" => "updater-spinner",
        "error" => ERROR_LABEL,
        "about" => ABOUT_LABEL,
        _ => "updater-dialog",
    };
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.close();
    }
}

/// Frameless About dialog: desktop version, upstream DeepSeek Harness
/// version + commit, plus the update-check and open-desktop-logs actions
/// that used to live in the tray menu. The page is served by the shell's
/// control service (`/pages/about.html`); runtime data rides in via an
/// initialization script as JSON and is rendered with textContent (no HTML
/// injection surface).
pub fn show_about_window(app: &AppHandle) -> tauri::Result<()> {
    if let Some(win) = app.get_webview_window(ABOUT_LABEL) {
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let zh = crate::i18n::is_zh(app);
    let labels = serde_json::json!({
        "title": tr("关于", "About", zh),
        "appName": "DeepSeek Harness Desktop",
        "desktopVersionLabel": tr("桌面端版本", "Desktop version", zh),
        "upstreamLabel": tr("上游 DeepSeek Harness", "Upstream DeepSeek Harness", zh),
        "upstreamVersionLabel": tr("版本", "Version", zh),
        "upstreamCommitLabel": tr("GitHub commit", "GitHub commit", zh),
        "checkUpdates": tr("检查更新", "Check for Updates", zh),
        "openLogs": tr("打开日志目录", "Open Log Folder", zh),
        "close": tr("关闭", "Close", zh),
        "checking": tr("正在检查更新…", "Checking for updates…", zh),
        "dshRepo": "https://github.com/deepseek-ai/deepseek-harness",
    });
    let ref_ = dsh_ref();
    let dark = match crate::config::DesktopConfig::load(&crate::config::config_path(app)).theme.as_str() {
        "light" => false,
        "dark" => true,
        _ => system_dark(),
    };
    let state = app.state::<Arc<SidecarState>>();
    let payload = serde_json::json!({
        "version": crate::config::ShellConfig::load(app).app_version,
        "upstreamVersion": ref_.upstream_version,
        "upstreamTag": ref_.tag,
        "upstreamCommit": ref_.commit,
        "ctlPort": crate::ctl_server::port(),
        "ctlToken": crate::ctl_server::token().unwrap_or_default(),
        "sidecarPort": state.sidecar_api_port.load(std::sync::atomic::Ordering::SeqCst),
        "sidecarToken": state.ctl_token.clone(),
        "dark": dark,
        "labels": labels,
    });
    let init = format!("window.__DSHD_ABOUT__ = {};", payload);
    WebviewWindowBuilder::new(app, ABOUT_LABEL, shell_page_url("about.html"))
        .title(tr("关于", "About", zh))
        .inner_size(440.0, 420.0)
        .resizable(false)
        .decorations(false)
        .background_color(tauri::window::Color::from(if dark { (20, 20, 31) } else { (250, 250, 252) }))
        .center()
        .initialization_script(init)
        .build()?;
    Ok(())
}

/// Apply the configured theme to the main window chrome: window background
/// (prevents white flash while the page paints) and, on Windows, the native
/// title-bar colors (DWM) so dark mode blends with the UI's dark background
/// instead of staying on the OS light caption.
pub fn apply_theme(app: &AppHandle, theme: &str) -> tauri::Result<()> {
    let dark = match theme {
        "light" => false,
        "dark" => true,
        _ => system_dark(),
    };
    let color = if dark {
        tauri::window::Color::from((10, 10, 10))
    } else {
        tauri::window::Color::from((255, 255, 255))
    };
    if let Some(win) = app.get_webview_window(MAIN_LABEL) {
        win.set_background_color(Some(color))?;
        #[cfg(windows)]
        set_caption_theme(&win, dark);
        // macOS: 'system' must NOT pin the window appearance. Pinning forced
        // the WKWebView's prefers-color-scheme to that pinned value (in the
        // old code "system" resolved to Light on macOS, so a dark OS showed
        // a light WebUI and matchMedia never tracked the OS). Passing None
        // sets NSAppearance to nil → the WebView follows the OS appearance
        // and its prefers-color-scheme updates live. Explicit light/dark
        // still pin the appearance so the title bar matches the choice.
        #[cfg(target_os = "macos")]
        {
            let forced = match theme {
                "light" => Some(tauri::Theme::Light),
                "dark" => Some(tauri::Theme::Dark),
                _ => None,
            };
            win.set_theme(forced)?;
        }
        // Other non-Windows platforms (Linux): pin the computed theme;
        // set_theme is a no-op there and the background color above is what
        // matters.
        #[cfg(all(not(windows), not(target_os = "macos")))]
        win.set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))?;
    }
    Ok(())
}

/// Windows 11 (22000+): paint the native title bar to match the UI theme —
/// dark mode gets the UI's `#0a0a0a` background + white text; light mode gets
/// the default Win11 light caption (fixed #F0F0F0 + black text — not
/// GetSysColor: with "accent color on title bars" enabled the system color is
/// the user's accent, which can be dark, and was observed leaving the caption
/// black-on-black). Windows 10 ignores the DWMWA_CAPTION_COLOR/TEXT_COLOR
/// attributes (returns an error we swallow); DWMWA_USE_IMMERSIVE_DARK_MODE
/// still works there so the caption at least follows the OS dark theme.
#[cfg(windows)]
fn set_caption_theme(win: &tauri::WebviewWindow, dark: bool) {
    use std::mem::size_of;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
    };

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0;
    unsafe {
        // COLORREF layout is 0x00BBGGRR.
        let bg: u32 = if dark {
            0x000A_0A0A
        } else {
            0x00F0_F0F0
        };
        let fg: u32 = if dark {
            0x00FF_FFFF
        } else {
            0x0000_0000
        };
        let dark_mode: i32 = i32::from(dark);
        // All three calls are best-effort; failures (e.g. Win10 attributes)
        // leave the system default in place.
        // windows-sys exports the attributes as i32; the DWM API wants u32.
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
            &dark_mode as *const i32 as *const _,
            size_of::<i32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_CAPTION_COLOR as u32,
            &bg as *const u32 as *const _,
            size_of::<u32>() as u32,
        );
        DwmSetWindowAttribute(
            hwnd,
            DWMWA_TEXT_COLOR as u32,
            &fg as *const u32 as *const _,
            size_of::<u32>() as u32,
        );
    }
}

/// OS-level dark preference: Windows reads AppsUseLightTheme from the
/// Personalize registry key (0 → dark); other platforms default to false.
#[cfg(windows)]
fn system_dark() -> bool {
    use windows_sys::Win32::System::Registry::{
        RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
    };

    let key: Vec<u16> = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let name: Vec<u16> = "AppsUseLightTheme"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut value: u32 = 0;
    let mut size: u32 = size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut value as *mut u32 as *mut _,
            &mut size,
        )
    };
    status == 0 && value == 0
}

/// OS-level dark preference: macOS reads the global interface style
/// (`defaults read -g AppleInterfaceStyle` → "Dark" when the OS is in dark
/// mode; works without any TCC permission and tracks Auto appearance). Other
/// non-Windows platforms default to false.
#[cfg(target_os = "macos")]
fn system_dark() -> bool {
    std::process::Command::new("defaults")
        .args(["read", "-g", "AppleInterfaceStyle"])
        .output()
        .map(|out| {
            String::from_utf8_lossy(&out.stdout)
                .trim()
                .eq_ignore_ascii_case("dark")
        })
        .unwrap_or(false)
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn system_dark() -> bool {
    false
}
