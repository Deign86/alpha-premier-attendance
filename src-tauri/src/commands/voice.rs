use crate::state::AppState;
use super::session::Admin;
use tauri::State;

#[tauri::command]
pub(crate) async fn tts_speak(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    text: String,
    options: Option<crate::tts::TtsSpeakOptions>,
) -> Result<crate::tts::TtsSpeakResult, String> {
    state.tts.speak(&text, options, &app).await
}

#[tauri::command]
pub(crate) async fn tts_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.tts.stop().await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn tts_status(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::tts::TtsStatusResponse, String> {
    Ok(state.tts.status(&app).await)
}

#[tauri::command]
pub(crate) async fn get_voicestudio_host(state: State<'_, AppState>, token: String) -> Result<String, String> {
    Admin::check(&state, &token).await?;
    Ok(crate::services::voice_pull::get_host(&state.db).await)
}

#[tauri::command]
pub(crate) async fn set_voicestudio_host(state: State<'_, AppState>, token: String, host: String) -> Result<String, String> {
    Admin::check(&state, &token).await?;
    let now = chrono::Utc::now().to_rfc3339();
    crate::services::voice_pull::set_host(&state.db, &host, &now).await
}

#[tauri::command]
pub(crate) async fn get_voicestudio_pin(state: State<'_, AppState>, token: String) -> Result<String, String> {
    Admin::check(&state, &token).await?;
    Ok(crate::services::voice_pull::get_pin(&state.db).await)
}

#[tauri::command]
pub(crate) async fn set_voicestudio_pin(state: State<'_, AppState>, token: String, pin: String) -> Result<(), String> {
    Admin::check(&state, &token).await?;
    let now = chrono::Utc::now().to_rfc3339();
    crate::services::voice_pull::set_pin(&state.db, &pin, &now).await
}

#[tauri::command]
pub(crate) async fn check_voicestudio(
    state: State<'_, AppState>,
    token: String,
    host: Option<String>,
    pin: Option<String>,
) -> Result<crate::services::voice_pull::VoiceConnectionStatus, String> {
    let admin = Admin::check(&state, &token).await?;
    check_voicestudio_impl(&state, &admin, host, pin).await
}

/// Probes what the admin typed (falling back to the saved settings) without
/// saving it: "Check" used to overwrite the worker's host and PIN (O8).
pub(crate) async fn check_voicestudio_impl(
    state: &AppState,
    _admin: &Admin,
    host: Option<String>,
    pin: Option<String>,
) -> Result<crate::services::voice_pull::VoiceConnectionStatus, String> {
    let host = match host {
        Some(raw) => crate::services::voice_pull::normalize_host(&raw),
        None => crate::services::voice_pull::get_host(&state.db).await,
    };
    let pin = match pin {
        Some(raw) => raw.trim().to_string(),
        None => crate::services::voice_pull::get_pin(&state.db).await,
    };
    Ok(crate::services::voice_pull::check_connection_to(&host, &pin).await)
}

#[tauri::command]
pub(crate) async fn voice_clip_states(
    state: State<'_, AppState>,
) -> Result<Vec<crate::services::voice_pull::VoiceClipState>, String> {
    crate::services::voice_pull::clip_states(&state.db, &state.data_dir).await
}

#[tauri::command]
pub(crate) async fn voice_regenerate(state: State<'_, AppState>, token: String, person_id: String) -> Result<String, String> {
    Admin::check(&state, &token).await?;
    crate::services::voice_pull::regenerate(&state.db, &person_id).await
}

#[tauri::command]
pub(crate) async fn voice_worker_status(
    state: State<'_, AppState>,
) -> Result<crate::services::voice_pull::VoiceWorkerStatus, String> {
    crate::services::voice_pull::worker_status(&state.db).await
}

#[tauri::command]
pub(crate) async fn voice_name_audio_url(
    state: State<'_, AppState>,
    person_id: String,
) -> Result<Option<String>, String> {
    let clean = person_id.trim();
    if clean.is_empty() || clean.contains('/') || clean.contains('\\') {
        return Ok(None);
    }
    let path = crate::services::voice_pull::clip_path(&state.data_dir, clean);
    if path.is_file() {
        Ok(Some(format!("asset://localhost/{}", path.to_string_lossy())))
    } else {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::test_support::*;


    #[tokio::test]
    async fn voicestudio_check_needs_admin_and_saves_nothing() {
        // O8: the VoiceStudio commands took no admin token, and "Check"
        // saved whatever host and PIN were typed before probing them.
        let (state, temp, token) = admin_test_state("voice-check").await;
        let saved_host = crate::services::voice_pull::get_host(&state.db).await;
        let saved_pin = crate::services::voice_pull::get_pin(&state.db).await;
        // A wrong token gets no `Admin`, and the check cannot be called without one.
        let refused = Admin::check(&state, "wrong-token").await;
        assert_eq!(refused.err().as_deref(), Some("ADMIN_AUTH_REQUIRED"));
        let probe = check_voicestudio_impl(&state, &admin(&state, &token).await, Some("http://127.0.0.1:9".into()), Some("9999".into())).await.unwrap();
        assert!(!probe.ok, "nothing listens on port 9");
        assert_eq!(crate::services::voice_pull::get_host(&state.db).await, saved_host, "Check must not save the typed host");
        assert_eq!(crate::services::voice_pull::get_pin(&state.db).await, saved_pin, "Check must not save the typed PIN");
        state.db.close().await;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
