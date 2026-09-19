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

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })` with arg keys
> exactly as in `client/src/tauri-api.ts`.

Preconditions:
- App is running with debug assertions enabled (`npm run tauri:dev`).
- Tauri MCP Bridge WebSocket is listening on `ws://127.0.0.1:9223`.
- At least one active test worker exists in the SQLite database (e.g. `EMP-001` or seeded employee).

- **Verify Ready State**: Inspect scan status pill on the kiosk.
  ```
  tool: tauri_webview_find_element, args: { "selector": "[data-testid=\"scanner-uid\"]" }
  ```
  *Observable result*: Scanner pill (`.scanner-pill`) shows "Ready" (also
  "Scanning"/"Offline"/"Error"/"Connecting…") and the input is `readOnly`
  until Manual mode. There is no `.status-pill` selector.

- **Execute Hardware RFID Scan**: Trigger a simulated hardware scan event
  via `tauri_webview_execute_js` +
  `window.__TAURI__.core.invoke('scan_rfid', { request: { rfidUid, source } })`.
  Non-`MANUAL_TEST` UIDs must be 4–64 ASCII-hex chars (`src-tauri/src/lib.rs`
  scan validation) — `EMP-001` is rejected; use a seeded hex UID with
  `source: "RFID"`, or any ID with `source: "MANUAL_TEST"`.
  *Observable result*: Returns `{ "success": true, "action": "TIME_IN" |
  "TIME_OUT", "user": { "fullName": "..." }, "attendance": { ... } }`
  (field is `user`, not `employee`). Unknown UID returns
  `{ "success": false, "error": { "code": "UNKNOWN_RFID_CARD", ... } }`
  with no DB write (live-proved with `DEADBEEF01`).

- **Drive Manual UID Entry**: Toggle manual mode and enter UID.
  ```
  tool: tauri_webview_interact, args: { "selector": "[data-testid=\"kiosk-manual-toggle\"]", "action": "click" }
  ```
  Then type into `input#scanner-uid[aria-label="Manual card ID"]` and submit
  via `[data-testid="kiosk-record-submit"]` ("Record").
  *Observable result*: Input accepts keystrokes, submit records attendance and
  renders `[data-testid="kiosk-result-success"]` (or `kiosk-result-error`).
  Spoken phrase is `"[Greeting], [Name]. Your time in/out has been recorded…"`
  (grace/late/first-arrival variants in `client/src/services/ttsService.ts`),
  not `"Time in recorded for [Name]"`.

- **Capture Visual & DOM Proof**:
  ```
  tool: tauri_webview_screenshot, args: { "name": "kiosk_attendance_success" }
  ```
  *Observable result*: Screenshot captured showing worker card banner, name, status, and Manila timestamp.

## Gotchas

- Manual keyboard entry is disabled on the main scanner input to prevent accidental keystrokes from corrupting hardware card scans. Use the explicit manual entry mode toggle before typing.
- The scanner pauses in manual mode and on `/attendance` and admin screens (`scanner_pause`), not only while dialogs are open.
- `scan_rfid` takes a single `request` JSON value whose inner fields are camelCase (`request.rfidUid`), consistent with the camelCase wire convention — keep `{ "request": { "rfidUid": "..." } }` as-is.
- CUA boundary (live-proved 2026-09-19): OS-level clicks land on kiosk controls
  (foreground delivery), but keystrokes/typing do NOT reach WebView2 content —
  React state never commits, so CUA cannot complete text entry or PIN entry.
  Drive text-bearing steps via `core.invoke`; reserve CUA for clicks/decisions.

