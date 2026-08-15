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
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
        Manager,
    };

    let show = MenuItem::with_id(app, "show", "Show attendance app", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, "exit", "Exit application", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &exit])?;
    let icon = app
        .default_window_icon()
        .cloned()
        .ok_or("default tray icon is unavailable")?;

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .tooltip("Alpha Premier Attendance - scanning")
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
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
use std::sync::atomic::{AtomicBool, Ordering};

static EXIT_REQUESTED: AtomicBool = AtomicBool::new(false);
