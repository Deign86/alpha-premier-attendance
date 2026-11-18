use crate::state::AppState;
use tauri::State;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
/// Read-only status of the LAN attendance viewer for the Live Attendance panel.
pub(crate) async fn lan_status(
    state: State<'_, AppState>,
) -> Result<crate::lan_server::LanStatusResponse, String> {
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Start (or verify) the LAN attendance viewer from the Live Attendance panel.
/// The viewer binds to the office LAN IP so devices on the same Wi-Fi/LAN can
/// open it; it stays strictly read-only and never exposes admin or payroll.
pub(crate) async fn lan_start(
    state: State<'_, AppState>,
) -> Result<crate::lan_server::LanStatusResponse, String> {
    let lan = state.lan.clone();
    if !lan.enabled && !lan.allow_runtime_start {
        return Ok(crate::lan_server::build_lan_status(state.inner()).await);
    }
    if state.lan_runtime.phase().await != crate::state::LanPhase::Running {
        let _ = state.lan_runtime.start(state.inner()).await;
    }
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Stop the LAN attendance viewer. Attendance recording on the front-desk
/// laptop is unaffected; only the LAN viewer goes offline.
pub(crate) async fn lan_stop(
    state: State<'_, AppState>,
) -> Result<crate::lan_server::LanStatusResponse, String> {
    state.lan_runtime.stop().await;
    Ok(crate::lan_server::build_lan_status(state.inner()).await)
}

#[tauri::command]
/// Open the viewer URL in the system default browser (Windows-first office use).
pub(crate) async fn open_viewer_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    if url.is_empty() || (!url.starts_with("http://") && !url.starts_with("https://")) {
        return Err("Invalid viewer URL".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|error| {
        log::error!("open viewer URL failed: {error}");
        "OPEN_FAILED".to_string()
    })
}
