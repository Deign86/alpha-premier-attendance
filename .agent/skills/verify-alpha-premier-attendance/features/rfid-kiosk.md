# RFID Kiosk & Attendance Scanning

The default full-screen kiosk view where employees and interns scan their RFID cards or enter their UID manually to record TIME IN and TIME OUT events with instant visual and local TTS voice feedback.

## Sub-features

- `KIOSK-SCAN`: Hardware RFID reader wedge input with automatic debounce, validation, and auto-submit.
- `KIOSK-MANUAL`: Explicit toggle button to enable keyboard typing of RFID UIDs when the card reader is inaccessible.
- `KIOSK-FEEDBACK`: Real-time display of employee name, photo, status (TIME IN / TIME OUT), timestamp in Manila time (`Asia/Manila`), and automatic card reset timer.
- `KIOSK-TTS`: Spoken audio feedback announcing "Time in recorded for [Name]" or "Time out recorded for [Name]" using local speech synthesis.

## How to get to it (user POV)

- Launch the desktop application. The kiosk view is the initial primary screen.
- If navigated away to Admin or Settings, click the "Back to Kiosk" or close button in the top navigation bar.

## Driving it with Tauri MCP

Preconditions:
- App is running with debug assertions enabled (`npm run tauri:dev`).
- Tauri MCP Bridge WebSocket is listening on `ws://127.0.0.1:9223`.
- At least one active test worker exists in the SQLite database (e.g. `EMP-001` or seeded employee).

- **Verify Ready State**: Inspect scan status pill on the kiosk.
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_find_element",
    "Arguments": { "selector": "[aria-label='Scanner card ID'], .status-pill" }
  }
  ```
  *Observable result*: Scanner status pill shows "Ready for scan" or "Listening" and input is locked against arbitrary keyboard spam.

- **Execute Hardware RFID Scan**: Trigger a simulated hardware scan event.
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "ipc_execute_command",
    "Arguments": {
      "command": "scan_rfid",
      "payload": {
        "request": { "rfidUid": "EMP-001", "source": "RFID" }
      }
    }
  }
  ```
  *Observable result*: Returns `{ "success": true, "action": "TIME_IN" | "TIME_OUT", "employee": { "fullName": "..." } }`.

- **Drive Manual UID Entry**: Toggle manual mode and enter UID.
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_interact",
    "Arguments": { "selector": "button:has-text('Manual entry')", "action": "click" }
  }
  ```
  Followed by typing:
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_interact",
    "Arguments": { "selector": "[aria-label='Manual card ID']", "action": "type", "value": "EMP-001\n" }
  }
  ```
  *Observable result*: Input field accepts keystrokes and submits upon Enter keypress, recording attendance.

- **Capture Visual & DOM Proof**:
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_screenshot",
    "Arguments": { "name": "kiosk_attendance_success" }
  }
  ```
  *Observable result*: Screenshot captured showing worker card banner, name, status, and Manila timestamp.

## Gotchas

- Manual keyboard entry is disabled on the main scanner input to prevent accidental keystrokes from corrupting hardware card scans. Use the explicit manual entry mode toggle before typing.
- The scanner status automatically pauses while dialogs or admin panels are active.

