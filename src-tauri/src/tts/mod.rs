pub mod audio;
pub mod piper;
pub mod sanitizer;
pub mod windows_sapi;

use crate::config::TtsConfig;
use audio::AudioPlayer;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakOptions {
    pub engine: Option<String>,
    pub voice_model: Option<String>,
    pub rate: Option<f32>,
    pub volume: Option<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSpeakResult {
    pub success: bool,
    pub engine_used: String,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsStatusResponse {
    pub enabled: bool,
    pub engine: String,
    pub piper_available: bool,
    pub piper_path: Option<String>,
    pub voice_model_available: bool,
    pub voice_model_path: Option<String>,
    pub system_sapi_available: bool,
    pub is_speaking: bool,
}

#[derive(Clone)]
pub struct TtsManager {
    inner: Arc<Mutex<TtsManagerInner>>,
    audio_player: AudioPlayer,
    config: TtsConfig,
}

struct TtsManagerInner {
    active_cancel: Option<tokio::sync::oneshot::Sender<()>>,
}

impl TtsManager {
    pub fn new(config: TtsConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TtsManagerInner {
                active_cancel: None,
            })),
            audio_player: AudioPlayer::new(),
            config,
        }
    }

    /// Stops any currently playing audio or background speech process immediately.
    pub async fn stop(&self) {
        self.audio_player.stop().await;
        let mut inner = self.inner.lock().await;
        if let Some(cancel) = inner.active_cancel.take() {
            let _ = cancel.send(());
        }
    }

    /// Checks the live status of local TTS engines.
    pub async fn status(&self, app_handle: &tauri::AppHandle) -> TtsStatusResponse {
        let piper_binary = piper::find_piper_binary(app_handle, self.config.piper_path.as_deref());
        let piper_available = piper_binary.is_some();
        let piper_path = piper_binary.map(|p| p.to_string_lossy().into_owned());

        let model_name = self.config.voice_model.as_deref().unwrap_or(piper::DEFAULT_VOICE_MODEL);
        let voice_model = piper::find_voice_model(app_handle, model_name);
        let voice_model_available = voice_model.is_some();
        let voice_model_path = voice_model.map(|(p, _)| p.to_string_lossy().into_owned());

        let system_sapi_available = windows_sapi::is_sapi_available();
        let is_playing = self.audio_player.is_playing().await;
        let is_process_running = {
            let inner = self.inner.lock().await;
            inner.active_cancel.as_ref().map(|tx| !tx.is_closed()).unwrap_or(false)
        };

        TtsStatusResponse {
            enabled: self.config.enabled,
            engine: self.config.engine.clone(),
            piper_available,
            piper_path,
            voice_model_available,
            voice_model_path,
            system_sapi_available,
            is_speaking: is_playing || is_process_running,
        }
    }

    /// Synthesizes and plays the provided text using the configured or selected engine.
    ///
    /// Fallback flow:
    /// - If `Auto`: try Piper first; if Piper fails or is unavailable, try Windows SAPI; quietly fail if neither works.
    /// - If `Piper`: try Piper only.
    /// - If `System` / `Sapi`: try Windows SAPI only.
    /// - If `Disabled`: produce no speech.
    pub async fn speak(
        &self,
        text: &str,
        options: Option<TtsSpeakOptions>,
        app_handle: &tauri::AppHandle,
    ) -> Result<TtsSpeakResult, String> {
        let sanitized = sanitizer::sanitize_speech_text(text, 300);
        if sanitized.is_empty() {
            return Ok(TtsSpeakResult {
                success: true,
                engine_used: "none".into(),
                message: Some("Empty speech text".into()),
            });
        }

        let opts = options.unwrap_or_default();
        let engine_choice = opts
            .engine
            .as_deref()
            .unwrap_or(&self.config.engine)
            .to_ascii_lowercase();

        if engine_choice == "disabled" || (!self.config.enabled && opts.engine.is_none()) {
            return Ok(TtsSpeakResult {
                success: true,
                engine_used: "none".into(),
                message: Some("TTS is disabled".into()),
            });
        }

        // Stop any active speech before starting a new one
        self.stop().await;

        let rate = opts.rate.unwrap_or(self.config.rate);
        let volume = opts.volume.unwrap_or(self.config.volume);
        let requested_model = opts
            .voice_model
            .as_deref()
            .or(self.config.voice_model.as_deref())
            .unwrap_or(piper::DEFAULT_VOICE_MODEL);

        let try_cloned = engine_choice == "cloned-bea" || engine_choice == "auto";
        let try_piper = engine_choice == "auto" || engine_choice == "piper" || engine_choice == "cloned-bea";
        let try_sapi = engine_choice == "auto" || engine_choice == "system" || engine_choice == "sapi" || engine_choice == "cloned-bea";

        // 1. Attempt Cloned Bea audio playback
        if try_cloned {
            if let Some(cached_wav) = find_cloned_bea_wav(app_handle, &sanitized) {
                match self.audio_player.play_wav(&cached_wav, volume, None, true).await {
                    Ok(()) => {
                        return Ok(TtsSpeakResult {
                            success: true,
                            engine_used: "cloned-bea".into(),
                            message: None,
                        });
                    }
                    Err(audio_err) => {
                        log::warn!("Failed to play cloned-bea WAV audio: {audio_err}. Falling back to Piper/SAPI.");
                    }
                }
            } else {
                log::info!("Cloned-bea cache miss for '{sanitized}'. Falling back to Piper/SAPI.");
            }
        }

        // 2. Attempt Piper TTS
        if try_piper || try_cloned {
            let piper_bin = piper::find_piper_binary(app_handle, self.config.piper_path.as_deref());
            let model_info = piper::find_voice_model(app_handle, requested_model);

            if let (Some(piper_exe), Some((model_path, config_path))) = (piper_bin, model_info) {
                let temp_dir = app_handle
                    .path()
                    .app_cache_dir()
                    .unwrap_or_else(|_| std::env::temp_dir());
                let _ = std::fs::create_dir_all(&temp_dir);
                let output_wav = temp_dir.join(format!("tts_{}.wav", uuid::Uuid::new_v4()));

                match piper::synthesize_to_wav(
                    &piper_exe,
                    &model_path,
                    config_path.as_deref(),
                    &sanitized,
                    &output_wav,
                    Some(rate),
                )
                .await
                {
                    Ok(()) => {
                        match self
                            .audio_player
                            .play_wav(&output_wav, volume, Some(output_wav.clone()), true)
                            .await
                        {
                            Ok(()) => {
                                return Ok(TtsSpeakResult {
                                    success: true,
                                    engine_used: "piper".into(),
                                    message: None,
                                });
                            }
                            Err(audio_err) => {
                                log::warn!("Failed to play Piper WAV audio: {audio_err}");
                                let _ = std::fs::remove_file(&output_wav);
                            }
                        }
                    }
                    Err(synth_err) => {
                        log::warn!("Piper synthesis failed: {synth_err}");
                        let _ = std::fs::remove_file(&output_wav);
                    }
                }
            } else {
                log::info!("Piper binary or voice model '{requested_model}' not found on disk");
            }

            if engine_choice == "piper" {
                return Ok(TtsSpeakResult {
                    success: false,
                    engine_used: "none".into(),
                    message: Some("Piper TTS engine or voice model is unavailable".into()),
                });
            }
        }

        // 2. Attempt Windows SAPI Fallback
        if try_sapi && windows_sapi::is_sapi_available() {
            match windows_sapi::spawn_sapi_speech(
                &sanitized,
                Some(rate),
                Some(volume),
                opts.voice_model.as_deref(),
            )
            .await
            {
                Ok(mut child) => {
                    let (cancel_tx, mut cancel_rx) = tokio::sync::oneshot::channel::<()>();
                    {
                        let mut inner = self.inner.lock().await;
                        if let Some(prev) = inner.active_cancel.take() {
                            let _ = prev.send(());
                        }
                        inner.active_cancel = Some(cancel_tx);
                    }

                    tokio::spawn(async move {
                        tokio::select! {
                            _ = child.wait() => {},
                            _ = &mut cancel_rx => {
                                let _ = child.kill().await;
                            }
                        }
                    });

                    return Ok(TtsSpeakResult {
                        success: true,
                        engine_used: "system".into(),
                        message: None,
                    });
                }
                Err(sapi_err) => {
                    log::warn!("Windows SAPI fallback failed: {sapi_err}");
                }
            }
        }

        // 3. Graceful quiet fallback if neither engine is available
        log::info!("TTS announcement skipped: no active engine available for '{sanitized}'");
        Ok(TtsSpeakResult {
            success: false,
            engine_used: "none".into(),
            message: Some("No offline TTS engine is available on this system".into()),
        })
    }
}

fn get_cloned_bea_rel_path(phrase: &str) -> Option<std::path::PathBuf> {
    let trimmed = phrase.trim();

    // 1. Direct audio path resolution (/voices/bea/... or voices/bea/...)
    if let Some(rel) = trimmed.strip_prefix('/') {
        if rel.starts_with("voices/bea/") {
            return Some(std::path::PathBuf::from(rel));
        }
    }
    if trimmed.starts_with("voices/bea/") {
        return Some(std::path::PathBuf::from(trimmed));
    }

    // 2. Direct person ID resolution (e.g. APG-2026-102, USR_INT_001)
    if trimmed.starts_with("APG-") || trimmed.starts_with("USR_") {
        return Some(std::path::PathBuf::from(format!("voices/bea/names/{trimmed}.wav")));
    }

    let static_rel = match trimmed {
        // Hybrid Splicing Carrier Prefixes
        "Good morning," | "Good morning" => "voices/bea/attendance/good-morning.wav",
        "Good afternoon," | "Good afternoon" => "voices/bea/attendance/good-afternoon.wav",
        "Good evening," | "Good evening" => "voices/bea/attendance/good-evening.wav",
        "Goodbye," | "Goodbye" => "voices/bea/attendance/goodbye.wav",
        "Attendance recorded for" => "voices/bea/attendance/attendance-recorded-for.wav",
        "Thank you, and have a great day." => "voices/bea/attendance/thank-you-great-day.wav",

        // Hybrid Splicing Suffixes
        "Your time in has been recorded." => "voices/bea/attendance/time-in-standard.wav",
        "Your time in has been recorded. You are the first arrival today." => "voices/bea/attendance/time-in-first-arrival.wav",
        "Your time in has been recorded within the grace period." => "voices/bea/attendance/time-in-grace.wav",
        "Your time in has been recorded within the grace period. You are the first arrival today." => "voices/bea/attendance/time-in-grace-first-arrival.wav",
        "Your time in has been recorded. You made it within the grace period." => "voices/bea/attendance/time-in-grace.wav",
        "Your time in has been recorded. You made it within the grace period. You are the first arrival today." => "voices/bea/attendance/time-in-grace-first-arrival.wav",
        "Your time in has been recorded. You are late." => "voices/bea/attendance/time-in-late.wav",
        "Your time in has been recorded. You are late. You are the first arrival today." => "voices/bea/attendance/time-in-late-first-arrival.wav",
        "Your assisted time in has been recorded." => "voices/bea/attendance/time-in-assisted-standard.wav",
        "Your assisted time in has been recorded. You are the first arrival today." => "voices/bea/attendance/time-in-assisted-first-arrival.wav",
        "Your assisted time in has been recorded within the grace period." => "voices/bea/attendance/time-in-assisted-grace.wav",
        "Your assisted time in has been recorded within the grace period. You are the first arrival today." => "voices/bea/attendance/time-in-assisted-grace-first-arrival.wav",
        "Your assisted time in has been recorded. You made it within the grace period." => "voices/bea/attendance/time-in-assisted-grace.wav",
        "Your assisted time in has been recorded. You made it within the grace period. You are the first arrival today." => "voices/bea/attendance/time-in-assisted-grace-first-arrival.wav",
        "Your assisted time in has been recorded. You are late." => "voices/bea/attendance/time-in-assisted-late.wav",
        "Your assisted time in has been recorded. You are late. You are the first arrival today." => "voices/bea/attendance/time-in-assisted-late-first-arrival.wav",
        "Your time out has been recorded." => "voices/bea/attendance/time-out-standard.wav",
        "Your time out was recorded after office hours. Manual correction is required." => "voices/bea/attendance/time-out-late-timeout.wav",
        "Your assisted time out has been recorded." => "voices/bea/attendance/time-out-assisted-standard.wav",
        "Your assisted time out was recorded after office hours. Manual correction is required." => "voices/bea/attendance/time-out-assisted-late-timeout.wav",

        // Bathroom Key Management (Warm Tone)
        "Your bathroom key has been checked out. Please return it within fifteen minutes." => "voices/bea/bathroom/bathroom-key-checked-out-15min.wav",
        "Male bathroom key checked out." => "voices/bea/bathroom/checkout-male.wav",
        "Female bathroom key checked out." => "voices/bea/bathroom/checkout-female.wav",
        "Male bathroom key checked out for" => "voices/bea/bathroom/checkout-male-for.wav",
        "Female bathroom key checked out for" => "voices/bea/bathroom/checkout-female-for.wav",
        "Thank you," => "voices/bea/bathroom/thank-you.wav",
        "Male bathroom key returned." => "voices/bea/bathroom/return-male.wav",
        "Female bathroom key returned." => "voices/bea/bathroom/return-female.wav",

        // Admin Assist (Warm Tone)
        "Admin assist card recognized. Please select an employee." => "voices/bea/admin-assist/admin-assist-prompt.wav",

        // Scan Errors and Feedback (Neutral/Alert Tone)
        "Sorry, that card wasn't recognized. Please try scanning again." => "voices/bea/scan-error/sorry-card-not-recognized.wav",
        "The male bathroom key is currently in use." => "voices/bea/scan-error/bathroom-key-in-use-male.wav",
        "The female bathroom key is currently in use." => "voices/bea/scan-error/bathroom-key-in-use-female.wav",
        "The bathroom key is currently in use." => "voices/bea/scan-error/bathroom-key-in-use.wav",
        "This card is not registered." => "voices/bea/scan-error/card-not-registered.wav",
        "Employee record is inactive." => "voices/bea/scan-error/employee-record-inactive.wav",
        "Card scanned too recently. Please wait." => "voices/bea/scan-error/card-scanned-too-recently.wav",
        "Admin cards cannot check out bathroom keys." => "voices/bea/scan-error/admin-card-not-allowed.wav",
        "Admin card requires employee selection." => "voices/bea/scan-error/admin-card-requires-selection.wav",
        "Attendance is already completed for today." => "voices/bea/scan-error/attendance-already-completed.wav",
        "Attendance timed out after office hours and is pending manual correction." => "voices/bea/scan-error/attendance-timed-out-correction.wav",
        "Attendance service is temporarily unavailable." => "voices/bea/scan-error/service-unavailable.wav",
        "Attendance conflict. Please try again." => "voices/bea/scan-error/attendance-conflict.wav",
        "Scan could not be processed." => "voices/bea/scan-error/scan-generic-error.wav",

        // General / Test Voice
        "Voice announcements are working correctly." => "voices/bea/general/test-voice.wav",
        _ => return None,
    };

    Some(std::path::PathBuf::from(static_rel))
}

pub fn find_cloned_bea_wav(app_handle: &tauri::AppHandle, phrase: &str) -> Option<std::path::PathBuf> {
    let rel_path_buf = get_cloned_bea_rel_path(phrase)?;

    // 1. Check relative to client/public/, resources/, or src-tauri (dev mode from repo root or src-tauri)
    let dev_candidates = [
        std::path::PathBuf::from("client").join("public").join(&rel_path_buf),
        std::path::PathBuf::from("..").join("client").join("public").join(&rel_path_buf),
        std::path::PathBuf::from("public").join(&rel_path_buf),
        std::path::PathBuf::from("resources").join(&rel_path_buf),
        std::path::PathBuf::from("src-tauri").join("resources").join(&rel_path_buf),
        std::path::PathBuf::from("..").join("src-tauri").join("resources").join(&rel_path_buf),
    ];
    for candidate in dev_candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    // 2. Tauri resource directory (packaged builds)
    if let Ok(res_dir) = app_handle.path().resource_dir() {
        let res_candidates = [
            res_dir.join(&rel_path_buf),
            res_dir.join("resources").join(&rel_path_buf),
            res_dir.join("public").join(&rel_path_buf),
            res_dir.join("client").join("public").join(&rel_path_buf),
        ];
        for candidate in res_candidates {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    // 3. Current executable directory (portable mode)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(parent) = exe_path.parent() {
            let exe_candidates = [
                parent.join(&rel_path_buf),
                parent.join("resources").join(&rel_path_buf),
                parent.join("public").join(&rel_path_buf),
                parent.join("client").join("public").join(&rel_path_buf),
            ];
            for candidate in exe_candidates {
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_speak_options_deserializes_camel_case_json() {
        let json_data = r#"{"engine":"piper","voiceModel":"en_US-lessac-medium","rate":1.2,"volume":0.8}"#;
        let options: TtsSpeakOptions = serde_json::from_str(json_data).expect("deserialize options");
        assert_eq!(options.engine.as_deref(), Some("piper"));
        assert_eq!(options.voice_model.as_deref(), Some("en_US-lessac-medium"));
        assert_eq!(options.rate, Some(1.2));
        assert_eq!(options.volume, Some(0.8));
    }

    #[tokio::test]
    async fn manager_can_stop_without_active_playback() {
        let manager = TtsManager::new(TtsConfig::default());
        manager.stop().await;
        assert!(!manager.audio_player.is_playing().await);
    }
}

