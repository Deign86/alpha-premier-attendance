use rodio::{Decoder, OutputStream, Sink};
use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::{mpsc, oneshot};

enum AudioCommand {
    Play {
        wav_path: PathBuf,
        volume: f32,
        rate: f32,
        cleanup_file: Option<PathBuf>,
        wait_for_completion: bool,
        response: oneshot::Sender<Result<(), String>>,
    },
    Stop,
    IsPlaying {
        response: oneshot::Sender<bool>,
    },
}

/// Manages local audio playback using a dedicated worker thread for Rodio streams.
///
/// Running Rodio's `OutputStream` on a dedicated OS thread ensures `Send + Sync`
/// compatibility across all platforms and keeps audio decoding off the main runtime threads.
#[derive(Clone)]
pub struct AudioPlayer {
    sender: Arc<std::sync::Mutex<Option<mpsc::UnboundedSender<AudioCommand>>>>,
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioPlayer {
    pub fn new() -> Self {
        Self {
            sender: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    fn get_or_init_sender(&self) -> Result<mpsc::UnboundedSender<AudioCommand>, String> {
        let mut guard = self
            .sender
            .lock()
            .map_err(|e| format!("Audio player mutex poisoned: {e}"))?;
        if let Some(tx) = &*guard {
            return Ok(tx.clone());
        }

        let (sender, mut receiver) = mpsc::unbounded_channel::<AudioCommand>();

        std::thread::Builder::new()
            .name("alpha-tts-audio-worker".into())
            .spawn(move || {
                let stream_res = OutputStream::try_default();
                let (_stream, stream_handle) = match stream_res {
                    Ok((s, h)) => (Some(s), Some(h)),
                    Err(err) => {
                        log::warn!("Could not initialize default audio output device: {err}");
                        (None, None)
                    }
                };

                let mut current_sink: Option<Arc<Sink>> = None;

                while let Some(cmd) = receiver.blocking_recv() {
                    match cmd {
                        AudioCommand::Stop => {
                            if let Some(sink) = current_sink.take() {
                                sink.stop();
                            }
                        }
                        AudioCommand::IsPlaying { response } => {
                            let playing = current_sink
                                .as_ref()
                                .map(|s| !s.empty())
                                .unwrap_or(false);
                            let _ = response.send(playing);
                        }
                        AudioCommand::Play {
                            wav_path,
                            volume,
                            rate,
                            cleanup_file,
                            wait_for_completion,
                            response,
                        } => {
                            // Stop existing playback first
                            if let Some(sink) = current_sink.take() {
                                sink.stop();
                            }

                            let handle = match &stream_handle {
                                Some(h) => h,
                                None => {
                                    let _ = response.send(Err(
                                        "No default audio output device available".into(),
                                    ));
                                    continue;
                                }
                            };

                            let file = match File::open(&wav_path) {
                                Ok(f) => f,
                                Err(err) => {
                                    let _ = response.send(Err(format!(
                                        "Failed to open audio file {}: {err}",
                                        wav_path.display()
                                    )));
                                    continue;
                                }
                            };

                            let source = match Decoder::new(BufReader::new(file)) {
                                Ok(s) => s,
                                Err(err) => {
                                    let _ = response.send(Err(format!(
                                        "Failed to decode audio file {}: {err}",
                                        wav_path.display()
                                    )));
                                    continue;
                                }
                            };

                            let sink = match Sink::try_new(handle) {
                                Ok(s) => Arc::new(s),
                                Err(err) => {
                                    let _ = response.send(Err(format!(
                                        "Failed to create audio sink: {err}"
                                    )));
                                    continue;
                                }
                            };

                            sink.set_volume(volume);
                            let speed = if rate.is_finite() {
                                rate.clamp(0.5, 2.0)
                            } else {
                                1.0
                            };
                            sink.set_speed(speed);
                            sink.append(source);
                            current_sink = Some(sink.clone());

                            let sink_for_monitor = sink.clone();
                            let file_to_clean = cleanup_file;

                            if wait_for_completion {
                                std::thread::spawn(move || {
                                    sink_for_monitor.sleep_until_end();
                                    if let Some(path) = file_to_clean {
                                        let _ = std::fs::remove_file(path);
                                    }
                                    let _ = response.send(Ok(()));
                                });
                            } else {
                                if let Some(path) = file_to_clean {
                                    std::thread::spawn(move || {
                                        sink_for_monitor.sleep_until_end();
                                        let _ = std::fs::remove_file(path);
                                    });
                                }
                                let _ = response.send(Ok(()));
                            }
                        }
                    }
                }
            })
            .map_err(|e| format!("Failed to spawn audio worker thread: {e}"))?;

        *guard = Some(sender.clone());
        Ok(sender)
    }

    /// Stops any currently playing audio immediately.
    pub async fn stop(&self) {
        let sender = {
            if let Ok(guard) = self.sender.lock() {
                guard.clone()
            } else {
                None
            }
        };
        if let Some(tx) = sender {
            let _ = tx.send(AudioCommand::Stop);
        }
    }

    /// Checks if audio is currently playing.
    pub async fn is_playing(&self) -> bool {
        let sender = {
            if let Ok(guard) = self.sender.lock() {
                guard.clone()
            } else {
                None
            }
        };
        if let Some(tx) = sender {
            let (resp_tx, resp_rx) = oneshot::channel();
            if tx.send(AudioCommand::IsPlaying { response: resp_tx }).is_err() {
                return false;
            }
            resp_rx.await.unwrap_or(false)
        } else {
            false
        }
    }

    /// Plays a WAV file from the filesystem on the audio worker thread.
    /// `rate` is the speech-rate multiplier (0.5-2.0, 1.0 = normal) applied
    /// via the Rodio sink so pre-rendered clips honor the TTS speed setting.
    pub async fn play_wav(
        &self,
        wav_path: &Path,
        volume: f32,
        rate: f32,
        cleanup_file: Option<PathBuf>,
        wait_for_completion: bool,
    ) -> Result<(), String> {
        let sender = self.get_or_init_sender()?;
        let (tx, rx) = oneshot::channel();
        sender
            .send(AudioCommand::Play {
                wav_path: wav_path.to_path_buf(),
                volume,
                rate,
                cleanup_file,
                wait_for_completion,
                response: tx,
            })
            .map_err(|e| format!("Audio worker channel closed: {e}"))?;

        rx.await
            .map_err(|_| "Audio worker failed to respond".to_string())?
    }
}
