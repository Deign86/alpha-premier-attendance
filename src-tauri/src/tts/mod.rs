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
    active_process: Option<tokio::process::Child>,
}

impl TtsManager {
    pub fn new(config: TtsConfig) -> Self {
        Self {
            inner: Arc::new(Mutex::new(TtsManagerInner {
                active_process: None,
            })),
            audio_player: AudioPlayer::new(),
            config,
        }
    }

    /// Stops any currently playing audio or background speech process immediately.
    pub async fn stop(&self) {
        self.audio_player.stop().await;
        let mut inner = self.inner.lock().await;
        if let Some(mut child) = inner.active_process.take() {
            let _ = child.kill().await;
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
            inner.active_process.is_some()
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

        let try_piper = engine_choice == "auto" || engine_choice == "piper";
        let try_sapi = engine_choice == "auto" || engine_choice == "system" || engine_choice == "sapi";

        // 1. Attempt Piper TTS
        if try_piper {
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
                            .play_wav(&output_wav, volume, Some(output_wav.clone()))
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
                Ok(child) => {
                    let mut inner = self.inner.lock().await;
                    inner.active_process = Some(child);
                    let inner_clone = self.inner.clone();

                    tokio::spawn(async move {
                        let mut guard = inner_clone.lock().await;
                        if let Some(mut child_proc) = guard.active_process.take() {
                            drop(guard);
                            let _ = child_proc.wait().await;
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

