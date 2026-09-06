# Settings, TTS & LAN Diagnostics

Configuration workspace for speech synthesis engine selection, audio volume/rate adjustment, and local network synchronization diagnostics.

## Sub-features

- `SETTINGS-TTS-ENGINE`: Toggle between native Windows SAPI voice synthesizer and offline Piper neural TTS (`.onnx` models).
- `SETTINGS-TTS-TEST`: Live speech test with custom announcement strings and volume/pitch controls.
- `SETTINGS-LAN`: Start, stop, and monitor embedded Axum REST and Server-Sent Events (SSE) server for multi-device sync.
- `SETTINGS-OFFICE`: Company address and office display name configuration for exported documents.

## How to get to it (user POV)

- From the Kiosk or Admin workspace, click the "Settings" gear icon in the header.
- Select the "Voice & Audio" or "Network & Sync" tab.

## Driving it with Tauri MCP

Preconditions:
- Desktop app is running and connected via Tauri MCP Bridge on port 9223.

- **Check TTS Synthesizer Status**:
  ```
  tool: tauri_ipc_execute_command, args: { "command": "tts_status" }
  ```
  *Observable result*: Returns `{ "success": true, "engine": "piper" | "sapi", "available": true }`.

- **Execute Test Voice Synthesis**:
  ```
  tool: tauri_ipc_execute_command, args: {
      "command": "tts_speak",
      "args": {
        "text": "Time in recorded for Test Employee",
        "options": { "rate": 1.0, "volume": 0.8 }
      }
    }
  ```
  *Observable result*: Returns `{ "success": true, "played": true }` or status confirmation without crashing audio thread.

- **Inspect LAN Server Diagnostics**:
  ```
  tool: tauri_ipc_execute_command, args: { "command": "lan_status" }
  ```
  *Observable result*: Returns `{ "enabled": boolean, "port": 8080, "bindAddress": "..." }`.

- **Capture Visual Proof**:
  ```
  tool: tauri_webview_screenshot, args: { "name": "voice_settings_panel" }
  ```
  *Observable result*: Screenshot of the voice settings panel with slider controls and engine selectors.

## Gotchas

- If Piper ONNX voice model files are missing or unreadable, the system automatically falls back to Windows SAPI to prevent silent audio failures.
- LAN server bind address defaults to local subnet (`0.0.0.0` or detected LAN IP) on port 8080.

