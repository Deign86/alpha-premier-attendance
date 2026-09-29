# src-tauri/src/tts/

## Responsibility
- Offline text-to-speech and cached cloned-voice playback for attendance announcements, admin feedback, and other kiosk messages.

## Design
- `TtsManager` owns configured engine selection, cancellation epochs, and `AudioPlayer`; `sanitizer` bounds/cleans speech input and `paths` locates packaged or app-data assets.
- Engine adapters cover Piper model synthesis, Windows SAPI process speech, and cached cloned-Bea WAV/MP3 clips; playback is serialized and cancellable.
- `TtsSpeakOptions`, result, and status structs are serde camelCase IPC contracts; manager does not persist state beyond config and active playback.

## Flow
- Frontend calls `tts_speak` in `lib.rs` → manager sanitizes text and resolves requested/default engine → cached cloned clip is attempted first, then Piper synthesis, then SAPI where the engine plan allows.
- Piper writes a temporary WAV in the app cache and `AudioPlayer` plays/removes it; SAPI is launched as a cancellable child process; a newer request or `tts_stop` aborts active output.
- `tts_status` probes binary/model/SAPI availability and playback state; invalid/empty input and unavailable engines return structured status rather than disrupting kiosk operation.

## Integration
- `AppState` owns `Arc<TtsManager>` initialized from `TtsConfig`; Tauri commands `tts_speak`, `tts_stop`, and `tts_status` are the frontend boundary.
- `services::voice_pull` stores user name clips in app data and exposes their asset URLs; `find_cloned_bea_wav` resolves those and bundled phrase assets before synthesized fallback.
- Cargo dependencies supply rodio playback, Tokio process control, and serde contracts; Piper binaries, voice models, and speech clips are discovered from app/resource paths.
