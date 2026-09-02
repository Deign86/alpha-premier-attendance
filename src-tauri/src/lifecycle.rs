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
                let autolaunch = app.autolaunch();
                match autolaunch.is_enabled() {
                    Ok(true) => {
                        if let Err(e) = autolaunch.disable() {
                            log::error!("Failed to disable autostart: {e}");
                            let _ = autostart_item_clone.set_checked(true);
                        } else {
                            log::info!("Disabled start on system startup");
                            let _ = autostart_item_clone.set_checked(false);
                        }
                    }
                    Ok(false) => {
                        if let Err(e) = autolaunch.enable() {
                            log::error!("Failed to enable autostart: {e}");
                            let _ = autostart_item_clone.set_checked(false);
                        } else {
                            log::info!("Enabled start on system startup");
                            let _ = autostart_item_clone.set_checked(true);
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

#[cfg(test)]
mod tests {
    use super::{should_hide_on_close, CloseBehavior};

    #[test]
    fn default_close_behavior_hides_only_when_tray_is_available() {
        assert!(should_hide_on_close(CloseBehavior::HideToTray, true));
        assert!(!should_hide_on_close(CloseBehavior::HideToTray, false));
        assert!(!should_hide_on_close(CloseBehavior::Exit, true));
    }
}

static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);

