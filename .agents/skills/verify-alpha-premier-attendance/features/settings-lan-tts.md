# Settings, TTS & LAN Diagnostics

Configuration workspace for speech synthesis engine selection, audio volume/rate adjustment, and local network synchronization diagnostics.

## Sub-features

- `SETTINGS-TTS-ENGINE`: Offline-first chain cloned-bea → Piper neural TTS (`.onnx` models) → Windows SAPI (engine from `tts.engine` config or per-call `options.engine`; default `cloned-bea`).
- `SETTINGS-TTS-TEST`: Fixed-sample Test Voice with volume/rate sliders (no engine dropdown, no pitch slider, no custom strings in the native panel).
- `SETTINGS-LAN`: Read-only Axum REST + SSE viewer (`lan_status`/`lan_start`/`lan_stop`), surfaced in the Admin Data tab's Live Attendance panel. Default port **4173**.
- `SETTINGS-OFFICE`: Company/office identity from `[office]` config.toml only (read-only in-app via `get_config`).

## How to get to it (user POV)

- Open `/admin` (PIN unlock) and pick the "Voice announcements" tab for voice,
  or the "Data and backup" tab's Live Attendance panel for the LAN viewer.
  There is no Settings gear icon and no "Voice & Audio" / "Network & Sync" tabs.

## Driving it with Tauri MCP

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })` with arg keys
> exactly as in `client/src/tauri-api.ts`.

Preconditions:
- Desktop app is running and connected via Tauri MCP Bridge on port 9223.

- **Check TTS Synthesizer Status**: `tts_status` (no args).
  *Observable result*: Returns `{ enabled, engine, piperAvailable, piperPath,
  voiceModelAvailable, voiceModelPath, systemSapiAvailable, isSpeaking }`
  (no `success`/`available` keys). Live: `enabled:true, engine:"cloned-bea"`.

- **Execute Test Voice Synthesis**: `tts_speak` with
  `{ "text": "...", "options": { "rate": 1.0, "volume": 0.8 } }`
  (`options` may also carry `engine`/`voiceModel`).
  *Observable result*: Returns `{ "success": true,
  "engineUsed": "cloned-bea"|"piper"|"system"|"none" }` (no `played` key).
  Audible on the machine's speakers.

- **Inspect LAN Server Diagnostics**: `lan_status` (no args).
  *Observable result*: 20+ keys incl. `success, state, port (4173 — never
  8080), bindAddress, viewerUrl (http://<lan-ip>:4173/attendance),
  lanIps, activeLanIp, guidance, connectedSseClients`. Bind is unset by
  default (wildcard-bind at runtime; shareable URL uses detected LAN IP).

- **Office identity**: `get_config` → `office.companyName` /
  `officeDisplayFull` (Tektite East Tower). Read-only; no setter exists.

- **Capture Visual Proof**:
  ```
  tool: tauri_webview_screenshot, args: { "name": "voice_settings_panel" }
  ```
  *Observable result*: Screenshot of the voice settings panel with slider controls and engine selectors.

## Gotchas

- Fallback chain is cloned carrier → worker/name clip → live Piper → configured
  engine (`auto`/`cloned-bea` falls back; `piper`-only and `system`-only do not).
  If Piper ONNX models are missing in `auto` mode, the system falls back to SAPI.
- LAN server bind address is unset by default (auto-detect); wildcard-bind at
  runtime on port 4173. Phones stuck on "Connecting…" need the Windows Firewall
  rule for TCP 4173 (the viewer panel prints the exact `netsh` command).

