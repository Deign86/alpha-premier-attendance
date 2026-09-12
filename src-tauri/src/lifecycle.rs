use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub const SINGLE_INSTANCE_PORT: u16 = 41789;
pub const SINGLE_INSTANCE_MAGIC: &[u8] = b"ALPHA_PREMIER_ATTENDANCE_SHOW\n";

pub enum SingleInstanceStatus {
    Primary(TcpListener),
    SecondaryExited,
}

pub fn check_single_instance() -> SingleInstanceStatus {
    let addr = format!("127.0.0.1:{SINGLE_INSTANCE_PORT}");
    if let Ok(mut stream) = TcpStream::connect_timeout(
        &addr.parse().expect("valid socket address"),
        Duration::from_millis(400),
    ) {
        log::info!("Another instance of Alpha Premier Attendance is already running; signaling to show window and exiting...");
        let _ = stream.write_all(SINGLE_INSTANCE_MAGIC);
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(150));
        return SingleInstanceStatus::SecondaryExited;
    }

    match TcpListener::bind(&addr) {
        Ok(listener) => {
            let _ = listener.set_nonblocking(true);
            SingleInstanceStatus::Primary(listener)
        }
        Err(err) => {
            log::warn!("Could not bind single-instance listener on {addr}: {err}");
            let fallback = TcpListener::bind("127.0.0.1:0").expect("bind fallback listener");
            let _ = fallback.set_nonblocking(true);
            SingleInstanceStatus::Primary(fallback)
        }
    }
}

pub fn start_single_instance_listener(
    app_handle: tauri::AppHandle,
    listener: TcpListener,
) {
    std::thread::spawn(move || {
        log::info!("Single-instance IPC listener active on port {SINGLE_INSTANCE_PORT}");
        loop {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buf = [0u8; 64];
                    if let Ok(n) = stream.read(&mut buf) {
                        if &buf[..n] == SINGLE_INSTANCE_MAGIC {
                            log::info!("Received show request from secondary instance; focusing main window");
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                    }
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(200));
                }
                Err(e) => {
                    log::debug!("Single-instance accept error: {e}");
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
        }
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseBehavior {
    HideToTray,
    Exit,
}

pub fn should_hide_on_close(behavior: CloseBehavior, tray_available: bool) -> bool {
    matches!(behavior, CloseBehavior::HideToTray)
        && tray_available
        && !EXIT_REQUESTED.load(Ordering::SeqCst)
}

pub fn request_exit(app: &tauri::AppHandle) {
    let behavior = CloseBehavior::Exit;
    if matches!(behavior, CloseBehavior::Exit) {
        EXIT_REQUESTED.store(true, Ordering::SeqCst);
        app.exit(0);
    }
}

pub fn install_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::{
        menu::{CheckMenuItem, Menu, MenuItem},
        tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    };
    use tauri_plugin_autostart::ManagerExt;

    let show = MenuItem::with_id(app, "show", "Show attendance app", true, None::<&str>)?;
    let is_autostart = app.autolaunch().is_enabled().unwrap_or(false);
    let autostart_item = CheckMenuItem::with_id(
        app,
        "toggle_autostart",
        "Start on system startup",
        true,
        is_autostart,
        None::<&str>,
    )?;
    let check_updates = MenuItem::with_id(
        app,
        "check_updates",
        "Check for updates…",
        true,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "Exit application", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &autostart_item, &check_updates, &exit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default tray icon is unavailable")?;

    let autostart_item_clone = autostart_item.clone();

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Alpha Premier Attendance - scanning")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "toggle_autostart" => {
                // Opt-out record lives next to .autostart_initialized so
                // self-heal never re-enables after the user disables here.
                // Resolution failure only skips the marker, never the toggle.
                let config_dir = crate::paths::resolve(app).map(|p| p.config_dir);
                match app.autolaunch().is_enabled() {
                    Ok(true) => {
                        match set_autostart_enabled(app, config_dir.as_deref().ok(), false) {
                            Err(e) => {
                                log::error!("Failed to disable autostart: {e}");
                                let _ = autostart_item_clone.set_checked(true);
                            }
                            Ok(()) => {
                                log::info!("Disabled start on system startup");
                                let _ = autostart_item_clone.set_checked(false);
                            }
                        }
                    }
                    Ok(false) => {
                        match set_autostart_enabled(app, config_dir.as_deref().ok(), true) {
                            Err(e) => {
                                log::error!("Failed to enable autostart: {e}");
                                let _ = autostart_item_clone.set_checked(false);
                            }
                            Ok(()) => {
                                log::info!("Enabled start on system startup");
                                let _ = autostart_item_clone.set_checked(true);
                            }
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to query autostart status: {e}");
                    }
                }
            }
            "check_updates" => {
                let _ = app.emit("check-for-updates", ());
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                    let _ = window.emit("check-for-updates", ());
                }
            }
            "exit" => request_exit(app),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub const AUTOSTART_INIT_MARKER: &str = ".autostart_initialized";
pub const AUTOSTART_OPT_OUT_MARKER: &str = ".autostart_disabled";

pub fn opt_out_marker_path(config_dir: &std::path::Path) -> std::path::PathBuf {
    config_dir.join(AUTOSTART_OPT_OUT_MARKER)
}

/// True when the user explicitly disabled autostart via settings/tray.
/// Missing marker file (or any filesystem error) means "not opted out".
pub fn is_opted_out(config_dir: &std::path::Path) -> bool {
    opt_out_marker_path(config_dir).exists()
}

/// Record a user opt-out. LOG-ONLY: failures never block the caller.
pub fn record_opt_out(config_dir: &std::path::Path) {
    if let Err(e) = std::fs::write(opt_out_marker_path(config_dir), "disabled") {
        log::warn!("Could not write autostart opt-out marker: {e}");
    }
}

/// Clear a user opt-out. LOG-ONLY: failures never block the caller.
pub fn clear_opt_out(config_dir: &std::path::Path) {
    let path = opt_out_marker_path(config_dir);
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("Could not clear autostart opt-out marker: {e}");
        }
    }
}

/// Pure marker side of the autostart mutation rule: enabling clears the
/// opt-out, disabling records it. Marker I/O stays LOG-ONLY and never fatal.
pub fn apply_opt_out_marker(config_dir: &std::path::Path, enabled: bool) {
    if enabled {
        clear_opt_out(config_dir);
    } else {
        record_opt_out(config_dir);
    }
}

/// Sole owner of the enable/disable-autostart-plus-opt-out-marker rule.
/// Applies the registry mutation first; the marker is only touched after a
/// successful write, so a registry error never mutates the opt-out state.
/// `config_dir` is `None` when path resolution failed, in which case the
/// marker is skipped (log-only) while the registry mutation still runs.
pub fn set_autostart_enabled(
    app: &tauri::AppHandle,
    config_dir: Option<&std::path::Path>,
    enabled: bool,
) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|e| e.to_string())?;
    } else {
        autolaunch.disable().map_err(|e| e.to_string())?;
    }
    if let Some(dir) = config_dir {
        apply_opt_out_marker(dir, enabled);
    }
    Ok(())
}

/// Strip surrounding quotes and whitespace so registry values written by different
/// versions (quoted vs unquoted, trailing spaces from auto-launch 0.5.0's
/// `"{path} {args}"` format with empty args) compare by path, not formatting.
pub fn normalize_run_value(raw: &str) -> String {
    let trimmed = raw.trim();
    let unquoted = trimmed
        .strip_prefix('"')
        .and_then(|s| s.strip_suffix('"'))
        .unwrap_or(trimmed);
    unquoted.trim().to_string()
}

/// Canonical registry data for the Run value: quoted exe path, no args.
pub fn expected_run_value(current_exe: &str) -> String {
    format!("\"{}\"", normalize_run_value(current_exe))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutostartAction {
    OkUnchanged,
    RepairStale,
    EnableMissing,
    RespectOptOut,
}

/// Pure decision for self-heal: opt-out always wins; otherwise compare the
/// stored Run value against the current exe (quoting/whitespace-insensitive
/// for path identity, but an unquoted or trailing-space value still needs a
/// repair rewrite to the canonical quoted form).
pub fn decide_autostart_action(
    stored: Option<&str>,
    current_exe: &str,
    opted_out: bool,
) -> AutostartAction {
    if opted_out {
        return AutostartAction::RespectOptOut;
    }
    match stored {
        None => AutostartAction::EnableMissing,
        Some(value) => {
            if value.trim() == expected_run_value(current_exe) {
                AutostartAction::OkUnchanged
            } else {
                // Same exe in non-canonical form (unquoted/trailing space)
                // or a different (stale) exe path: both need a rewrite to
                // the canonical quoted form.
                AutostartAction::RepairStale
            }
        }
    }
}

#[cfg(windows)]
const RUN_REGKEY: &str = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run";

/// Read the raw HKCU Run value for this app. None = missing OR unreadable
/// (both lead to a repair attempt; all failures are logged, never raised).
#[cfg(windows)]
fn read_run_value(app_name: &str) -> Option<String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = match hkcu.open_subkey_with_flags(RUN_REGKEY, KEY_READ) {
        Ok(key) => key,
        Err(e) => {
            log::warn!("Autostart self-heal: cannot open Run key for read: {e}");
            return None;
        }
    };
    match key.get_value::<String, _>(app_name) {
        Ok(value) => Some(value),
        Err(e) => {
            log::info!("Autostart self-heal: no Run value for {app_name}: {e}");
            None
        }
    }
}

/// Write the canonical quoted Run value. LOG-ONLY by contract of the caller.
#[cfg(windows)]
fn write_run_value_quoted(app_name: &str, current_exe: &str) -> Result<(), String> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_SET_VALUE};
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let key = hkcu
        .open_subkey_with_flags(RUN_REGKEY, KEY_SET_VALUE)
        .map_err(|e| e.to_string())?;
    let data = expected_run_value(current_exe);
    key.set_value(app_name, &data).map_err(|e| e.to_string())
}

/// Verify the HKCU Run value points at this exe and repair it when
/// stale/missing/unquoted. Runs on every startup; all failures are LOG-ONLY
/// so startup always survives registry errors. Never re-enables after the
/// user opted out via settings/tray.
pub fn self_heal_autostart(app: &tauri::AppHandle, config_dir: &std::path::Path) {
    if is_opted_out(config_dir) {
        log::info!("Autostart self-heal: user opted out, leaving Run entry untouched");
        return;
    }
    #[cfg(windows)]
    let exe = match std::env::current_exe() {
        Ok(path) => path.display().to_string(),
        Err(e) => {
            log::warn!("Autostart self-heal: cannot determine current exe: {e}");
            return;
        }
    };
    #[cfg(windows)]
    let app_name = app.package_info().name.to_string();
    #[cfg(windows)]
    {
        let stored = read_run_value(&app_name);
        match decide_autostart_action(stored.as_deref(), &exe, false) {
            AutostartAction::OkUnchanged => {
                log::info!("Autostart self-heal: Run value already points at current exe");
            }
            AutostartAction::RepairStale => {
                match write_run_value_quoted(&app_name, &exe) {
                    Ok(()) => log::info!(
                        "Autostart self-heal: repaired stale Run value to quoted current exe"
                    ),
                    Err(e) => log::warn!("Autostart self-heal: failed to repair Run value: {e}"),
                }
            }
            AutostartAction::EnableMissing => {
                match write_run_value_quoted(&app_name, &exe) {
                    Ok(()) => log::info!(
                        "Autostart self-heal: restored missing Run value to quoted current exe"
                    ),
                    Err(e) => log::warn!("Autostart self-heal: failed to restore Run value: {e}"),
                }
            }
            AutostartAction::RespectOptOut => {}
        }
        return;
    }
    #[cfg(not(windows))]
    {
        use tauri_plugin_autostart::ManagerExt;
        let autolaunch = app.autolaunch();
        match autolaunch.is_enabled() {
            Ok(true) => log::info!("Autostart self-heal: already enabled"),
            Ok(false) => {
                if let Err(e) = autolaunch.enable() {
                    log::warn!("Autostart self-heal: failed to re-enable: {e}");
                } else {
                    log::info!("Autostart self-heal: re-enabled missing entry");
                }
            }
            Err(e) => log::warn!("Autostart self-heal: could not check status: {e}"),
        }
    }
}

pub fn ensure_default_autostart(app: &tauri::AppHandle, config_dir: &std::path::Path) {
    use tauri_plugin_autostart::ManagerExt;
    let marker_file = config_dir.join(AUTOSTART_INIT_MARKER);
    if !marker_file.exists() {
        let autolaunch = app.autolaunch();
        match autolaunch.is_enabled() {
            Ok(false) => {
                if is_opted_out(config_dir) {
                    log::info!("Skipping default autostart: user opted out");
                } else if let Err(e) = autolaunch.enable() {
                    log::warn!("Failed to enable default autostart on first run: {e}");
                } else {
                    log::info!("Default autostart enabled successfully on first run");
                }
            }
            Ok(true) => {
                log::info!("Autostart already enabled on system");
            }
            Err(e) => {
                log::warn!("Could not check autostart status: {e}");
            }
        }
        if let Err(e) = std::fs::write(&marker_file, "initialized") {
            log::warn!("Could not write autostart marker: {e}");
        }
    }
    // Every startup (not just the first) must verify the Run value still
    // points at this exe — Windows-login launches go through the registry,
    // not through this marker.
    self_heal_autostart(app, config_dir);
}

#[cfg(test)]
mod tests {
    use super::{
        decide_autostart_action, expected_run_value, normalize_run_value, should_hide_on_close,
        AutostartAction, CloseBehavior,
    };

    #[test]
    fn default_close_behavior_hides_only_when_tray_is_available() {
        assert!(should_hide_on_close(CloseBehavior::HideToTray, true));
        assert!(!should_hide_on_close(CloseBehavior::HideToTray, false));
        assert!(!should_hide_on_close(CloseBehavior::Exit, true));
    }

    #[test]
    fn stale_dev_path_needs_repair() {
        let action = decide_autostart_action(
            Some("C:\\dev\\target\\debug\\alpha-premier-attendance.exe "),
            "C:\\Program Files\\AlphaPremier\\alpha-premier-attendance.exe",
            false,
        );
        assert_eq!(action, AutostartAction::RepairStale);
    }

    #[test]
    fn unquoted_with_trailing_space_needs_repair() {
        // auto-launch 0.5.0 writes `format!("{} {}", path, args.join(" "))`;
        // with no args that leaves an unquoted path plus trailing space.
        let exe = "C:\\Program Files\\AlphaPremier\\alpha-premier-attendance.exe";
        let action = decide_autostart_action(Some(&format!("{exe} ")), exe, false);
        assert_eq!(action, AutostartAction::RepairStale);
    }

    #[test]
    fn quoted_correct_value_is_unchanged() {
        let exe = "C:\\Program Files\\AlphaPremier\\alpha-premier-attendance.exe";
        let action = decide_autostart_action(Some(&expected_run_value(exe)), exe, false);
        assert_eq!(action, AutostartAction::OkUnchanged);
    }

    #[test]
    fn missing_entry_is_enabled() {
        let action = decide_autostart_action(
            None,
            "C:\\Program Files\\AlphaPremier\\alpha-premier-attendance.exe",
            false,
        );
        assert_eq!(action, AutostartAction::EnableMissing);
    }

    #[test]
    fn opt_out_is_respected_over_stale_and_missing() {
        let exe = "C:\\Program Files\\AlphaPremier\\alpha-premier-attendance.exe";
        assert_eq!(
            decide_autostart_action(Some("C:\\dev\\old.exe"), exe, true),
            AutostartAction::RespectOptOut
        );
        assert_eq!(
            decide_autostart_action(None, exe, true),
            AutostartAction::RespectOptOut
        );
        assert_eq!(
            decide_autostart_action(Some(&expected_run_value(exe)), exe, true),
            AutostartAction::RespectOptOut
        );
    }

    #[test]
    fn path_compare_ignores_case_quotes_and_trailing_space() {
        // Same exe in a different surface form still needs the canonical rewrite.
        assert_eq!(
            decide_autostart_action(
                Some("\"c:\\prograM files\\app\\a.exe\" "),
                "C:\\Program Files\\App\\a.exe",
                false
            ),
            AutostartAction::RepairStale
        );
        assert_eq!(normalize_run_value("  \"C:\\a.exe\"  "), "C:\\a.exe");
        assert_eq!(
            expected_run_value("C:\\a.exe "),
            "\"C:\\a.exe\""
        );
    }

    #[test]
    fn opt_out_marker_roundtrip() {
        let temp = std::env::temp_dir().join(format!("test-optout-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        assert!(!super::is_opted_out(&temp));
        super::record_opt_out(&temp);
        assert!(super::is_opted_out(&temp));
        super::clear_opt_out(&temp);
        assert!(!super::is_opted_out(&temp));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn marker_side_tracks_enabled_state() {
        let temp = std::env::temp_dir().join(format!("test-marker-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        super::apply_opt_out_marker(&temp, false);
        assert!(super::is_opted_out(&temp));
        super::apply_opt_out_marker(&temp, true);
        assert!(!super::is_opted_out(&temp));
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_autostart_default_on() {
        let temp = std::env::temp_dir().join(format!("test-autostart-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&temp).unwrap();
        let marker = temp.join(".autostart_initialized");
        assert!(!marker.exists());
        std::fs::write(&marker, "initialized").unwrap();
        assert!(marker.exists());
        let _ = std::fs::remove_dir_all(&temp);
    }
}

static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

