# Settings, TTS & LAN Diagnostics

Configuration panel for speech synthesis engine selection, audio volume/rate adjustment, and local network synchronization.

## Sub-features

- **TTS Engine Switcher**: Toggle between native Windows SAPI voice synthesizer and offline Piper neural TTS (`.onnx` models).
- **Voice Test & Preview**: Live speech test with custom announcement strings and volume/pitch controls.
- **LAN Server Management**: Start, stop, and monitor embedded Axum REST and Server-Sent Events (SSE) server for multi-device sync.
- **Office Location Metadata**: Company address and office display name configuration for exported documents.

## How to get to it (user POV)

1. From the Kiosk or Admin workspace, click the "Settings" / gear icon.
2. Select the "Voice & Audio" or "Network & Sync" tab.

## Driving it with Tauri MCP

1. **Check TTS Status**:
   - Query engine status via `tts_status`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": { "command": "tts_status" }
     }
     ```
2. **Execute Test Voice Synthesis**:
   - Invoke `tts_speak`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "tts_speak",
         "payload": {
           "text": "Time in recorded for Test Employee",
           "options": { "rate": 1.0, "volume": 0.8 }
         }
       }
     }
     ```
3. **Toggle LAN Server**:
   - Start or stop LAN server via `lan_start` / `lan_stop`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": { "command": "lan_status" }
     }
     ```
4. **Capture Evidence**:
   - Verify `tts_speak` returns `{ "success": true }` with audio device confirmation.
   - Take a screenshot of the voice settings panel:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_screenshot",
       "Arguments": { "name": "voice_settings_panel" }
     }
     ```

## Gotchas

- If Piper ONNX voice model files are missing or unreadable, the system automatically falls back to Windows SAPI to prevent silent audio failures.
- LAN server bind address defaults to local subnet (`0.0.0.0` or detected LAN IP) on port 8080.
