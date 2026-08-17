# RFID Kiosk & Attendance Scanning

The default full-screen kiosk view where employees and interns scan their RFID cards or enter their UID to record TIME IN and TIME OUT events.

## Sub-features

- **Card Scanning**: Hardware RFID reader wedge input with automatic debounce, validation, and auto-submit.
- **Manual UID Fallback**: Explicit toggle button to enable keyboard typing of RFID UIDs when the card reader is inaccessible.
- **Live Attendance Feedback**: Real-time display of employee name, photo, status (TIME IN / TIME OUT), timestamp in Manila time (`Asia/Manila`), and automatic card reset timer.
- **TTS Voice Announcement**: Spoken feedback announcing "Time in recorded for [Name]" or "Time out recorded for [Name]" using local speech synthesis.

## How to get to it (user POV)

1. Launch the application. The kiosk view is the initial primary screen.
2. If navigated away to Admin or Settings, click the "Back to Kiosk" or close button in the top navigation bar.

## Driving it with Tauri MCP

1. **Verify Initial Kiosk State**:
   - Check that the scan status pill indicates "Ready for scan" or "Listening":
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_find_element",
       "Arguments": { "selector": ".kiosk-status" }
     }
     ```
2. **Drive a Card Scan via IPC Command**:
   - Invoke `scan_rfid` directly to simulate a hardware scan:
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
3. **Drive Manual UID Entry via UI**:
   - Click the "Manual Entry" toggle button.
   - Type the test RFID UID into the input field and press Enter:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_interact",
       "Arguments": { "selector": "input[placeholder*='Enter UID']", "action": "type", "value": "EMP-001\n" }
     }
     ```
4. **Capture Evidence**:
   - Verify that the card banner updates with the employee's name and action (`TIME_IN` or `TIME_OUT`).
   - Take a screenshot:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_screenshot",
       "Arguments": { "name": "kiosk_attendance_recorded" }
     }
     ```

## Gotchas

- Manual keyboard entry is disabled on the main scanner input to prevent accidental typing from corrupting hardware card scans. Use the explicit manual entry mode toggle before typing.
- The scanner status automatically pauses while dialogs or admin panels are active.
