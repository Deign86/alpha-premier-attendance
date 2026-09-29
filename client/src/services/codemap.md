# client/src/services/
## Responsibility
This folder is the client service layer for speech announcements and desktop release updates. It centralizes the TTS engine boundary and cloned audio catalog, plus update check/install behavior consumed by UI components.

## Design
- `ttsService.ts` holds typed TTS settings/mode normalization and persistence, phrase builders, announcement orchestration, playback interruption epochs, engine selection, and live Tauri speech/status calls.
- `clonedBeaVoice.ts` owns the fixed phrase manifest and per-person name profiles, optional runtime manifest loading, worker clip URL resolution, voice-slot selection, and cancellable HTML5/native clip playback with `.wav` fallback.
- Announcements use Bea static phrase carriers plus cloned or Piper-generated dynamic names when available; otherwise `speakText` routes to native Tauri TTS or cached audio/fallback behavior.
- `updateService.ts` wraps the Tauri updater/process plugins behind injectable `UpdaterClient`; discriminated `CheckUpdateResult`/`InstallUpdateResult` represent outcomes, while a localStorage flag suppresses automatic (not manual) checks.

## Flow
1. `App.tsx` or `VoiceSettingsPanel` calls an `announce*`, `testVoice`, `stopSpeech`, or settings API in `ttsService.ts`; settings load from localStorage with validation/defaults.
2. `announceAttendance`, `announceBathroom`, or `announceScanError` resolve the current TTS mode and phrase; cloned mode tries phrase/name cache clips in order, uses native Piper for a missing dynamic name, then falls back to complete `speakText` synthesis.
3. `clonedBeaVoice.ts` resolves static URLs from `CLONED_BEA_PHRASE_MANIFEST`, names from bundled/default or fetched manifest and (in Tauri) worker assets, then plays through `tauriApi.ttsSpeak` or HTML5 `Audio`; epoch changes cancel stale playback.
4. `UpdateBanner` calls `checkForUpdates(manual)`; results are mapped to availability, up-to-date, disabled, or error UI states, with background network failures suppressed.
5. On install, `downloadAndInstallUpdate` forwards download/install phases and byte progress to the caller, installs the `Update`, and calls updater client `relaunch`; failures return `{ ok: false, error }`.

## Integration
- Consumed by: `src/App.tsx` (`announceAttendance`, `announceBathroom`, `announceScanError`, `announceAdminAssist`, `loadNameManifest`, `pollVoiceClipReady`); `src/voice-settings-panel.tsx`; `src/update-banner.tsx`; `src/admin-updates-card.tsx`.
- Depends on: `@rfid-attendance/shared` TTS/voice/arrival contracts, `src/tauri-api.ts` (`ttsSpeak`, `ttsStop`, voice worker and VoiceStudio commands), and Tauri updater/process plugins.
- `ttsService.ts` → `clonedBeaVoice.ts`; the latter reads `/voices/bea/bea-name-manifest.json` and bundled `/voices/bea/...` assets and converts worker `asset://` paths with `convertFileSrc`.
- `update-banner.tsx` receives tray events from `listenForCheckForUpdates` in `src/tauri-api.ts`; `admin-updates-card.tsx` uses local update preference helpers and `getAutostartStatus`/`setAutostartStatus` from `src/api.ts`.
