use rodio::{Decoder, OutputStream, Sink};
use std::{
    fs::File,
    io::BufReader,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::sync::{mpsc, oneshot};

enum AudioCommand {
    Play {
        wav_path: PathBuf,
        volume: f32,
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
    sender: mpsc::UnboundedSender<AudioCommand>,
}

impl Default for AudioPlayer {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioPlayer {
    pub fn new() -> Self {
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

                            let reader = BufReader::new(file);
                            let decoder = match Decoder::new(reader) {
                                Ok(d) => d,
                                Err(err) => {
                                    let _ = response
                                        .send(Err(format!("Failed to decode WAV audio: {err}")));
                                    continue;
                                }
                            };

                            let sink = match Sink::try_new(handle) {
                                Ok(s) => s,
                                Err(err) => {
                                    let _ = response
                                        .send(Err(format!("Failed to create audio sink: {err}")));
                                    continue;
                                }
                            };

                            let clamped_volume = volume.clamp(0.0, 1.0);
                            sink.set_volume(clamped_volume);
                            sink.append(decoder);

                            let sink_arc = Arc::new(sink);
                            current_sink = Some(sink_arc.clone());

                            let file_to_clean = cleanup_file;
                            let sink_for_monitor = sink_arc.clone();

                            if wait_for_completion {
                                std::thread::spawn(move || {
                                    while !sink_for_monitor.empty() {
                                        std::thread::sleep(Duration::from_millis(25));
                                    }
                                    if let Some(path) = file_to_clean {
                                        let _ = std::fs::remove_file(path);
                                    }
                                    let _ = response.send(Ok(()));
                                });
                            } else {
                                std::thread::spawn(move || {
                                    while !sink_for_monitor.empty() {
                                        std::thread::sleep(Duration::from_millis(50));
                                    }
                                    if let Some(path) = file_to_clean {
                                        let _ = std::fs::remove_file(path);
                                    }
                                });
                                let _ = response.send(Ok(()));
                            }
                        }
                    }
                }
            })
            .expect("spawn audio worker thread");

        Self { sender }
    }

    /// Stops any currently playing audio immediately.
    pub async fn stop(&self) {
        let _ = self.sender.send(AudioCommand::Stop);
    }

    /// Checks if audio is currently playing.
    pub async fn is_playing(&self) -> bool {
        let (tx, rx) = oneshot::channel();
        if self.sender.send(AudioCommand::IsPlaying { response: tx }).is_err() {
            return false;
        }
        rx.await.unwrap_or(false)
    }

    /// Plays a WAV file from the filesystem on the audio worker thread.
    pub async fn play_wav(
        &self,
        wav_path: &Path,
        volume: f32,
        cleanup_file: Option<PathBuf>,
        wait_for_completion: bool,
    ) -> Result<(), String> {
        let (tx, rx) = oneshot::channel();
        self.sender
            .send(AudioCommand::Play {
                wav_path: wav_path.to_path_buf(),
                volume,
                cleanup_file,
                wait_for_completion,
                response: tx,
            })
            .map_err(|e| format!("Audio worker channel closed: {e}"))?;

        rx.await
            .map_err(|_| "Audio worker failed to respond".to_string())?
    }
}
