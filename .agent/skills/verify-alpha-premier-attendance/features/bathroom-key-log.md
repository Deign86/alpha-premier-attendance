# Bathroom Key Log & Kiosk

Gender-separated bathroom key checkout/return tracking. Two keys (MALE / FEMALE);
only one active holder per key. RFID scan toggles checkout/return; staff can also
act by user ID. TTS announces checkout/return events with the Ma'am Bea cloned
voice and Piper/SAPI fallback.

## Sub-features

- `BATHROOM-STATUS`: Current holders per key plus today's log (`bathroom_get_status`).
- `BATHROOM-SCAN`: RFID scan checkout/return toggle (`bathroom_scan_rfid` with `rfidUid`).
- `BATHROOM-ACTIONS`: Explicit checkout by user ID (`bathroom_time_out` with
  `userId`, `genderKey`) and return by log ID (`bathroom_time_in` with `logId`).
- `BATHROOM-EDIT`: Correct timestamps/notes (`bathroom_update_log` with `logId`, `request`).
- `BATHROOM-TTS`: Spoken checkout/return announcements via the cloned-Bea manifest.

## How to get to it (user POV)

- From the Kiosk view, open the Bathroom panel (kiosk cards
  `bathroom-kiosk-card-male` / `bathroom-kiosk-card-female`).
- Scan an RFID card on the bathroom reader, or pick a staff member and press
  Check Out / Check In.

## Driving it with Tauri MCP

Preconditions:
- Desktop app is running and connected via Tauri MCP Bridge on port 9223.
- At least one active worker with an RFID UID exists.

- **Read Key Status** (`tauri_ipc_execute_command`):
  ```
  tool: tauri_ipc_execute_command, args: { "command": "bathroom_get_status" }
  ```
  *Observable result*: Returns male/female active holders plus today's log rows.

- **RFID Scan Toggle** (`tauri_ipc_execute_command`):
  ```
  tool: tauri_ipc_execute_command, args: {
    "command": "bathroom_scan_rfid",
    "args": { "rfidUid": "EMP-001" }
  }
  ```
  *Observable result*: First scan checks the key out; scanning again (or by the
  holder) checks it back in.

- **Explicit Checkout / Return** (`tauri_ipc_execute_command`):
  ```
  tool: tauri_ipc_execute_command, args: {
    "command": "bathroom_time_out",
    "args": { "token": "<token>", "userId": "USER-001", "genderKey": "MALE" }
  }
  ```
  ```
  tool: tauri_ipc_execute_command, args: {
    "command": "bathroom_time_in",
    "args": { "token": "<token>", "logId": "LOG-001" }
  }
  ```
  *Observable result*: Key holder changes; second checkout of an in-use key is rejected.

- **Capture Visual Proof** (`tauri_webview_screenshot`):
  ```
  tool: tauri_webview_screenshot, args: { "name": "bathroom_key_status" }
  ```

## Gotchas

- Desktop-only evidence: the Express server keeps a separate in-memory bathroom
  store, so browser/LAN checks cannot confirm the Tauri SQLite `bathroom_log`.
  Verify via Tauri IPC or the desktop webview only.
- A return (`time_in`) earlier than its checkout (`time_out`) is rejected by
  validation in both the UI modal and the backend.
