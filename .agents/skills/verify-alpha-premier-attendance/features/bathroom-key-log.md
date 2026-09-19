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

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })` with arg keys
> exactly as in `client/src/tauri-api.ts`.

Preconditions:
- Desktop app is running and connected via Tauri MCP Bridge on port 9223.
- At least one active worker with an RFID UID exists.

- **Read Key Status**: `bathroom_get_status` (token optional/unused).
  *Observable result*: Returns `{ success, date, maleActive, femaleActive,
  maleLogs, femaleLogs, fetchedAt }` (live: female held by Melanie F. Garcia
  since 2026-09-16).

- **RFID Scan** (no token): `bathroom_scan_rfid` with `{ "rfidUid": "..." }`.
  *Observable result*: Gender is derived from the scanned user (non-FEMALE →
  MALE). Only the current holder's re-scan returns; any other scan while
  in-use returns `BATHROOM_KEY_IN_USE` naming the holder. Unknown UID errors
  without writing.

- **Explicit Checkout / Return** (admin token required; rejects inactive users
  and `ADMIN_ASSIST` cards): `bathroom_time_out` with
  `{ "token", "userId", "genderKey", "notes"? }`; `bathroom_time_in` with
  `{ "token", "logId", "notes"? }`.
  *Observable result*: Key holder changes. Second checkout of an in-use key
  returns `BATHROOM_KEY_ALREADY_CHECKED_OUT` (explicit path) — note the log
  tab's friendly-message check looks for `BATHROOM_KEY_ALREADY_IN_USE`, which
  matches neither; explicit conflicts fall through to the raw message.

- **Edit log** (admin token): `bathroom_update_log` with
  `{ "token", "logId", "request": { "timeOut"?, "timeIn"?, "notes"? } }`
  (RFC3339 `+08:00`, must fall on the log's Manila date). A return earlier
  than its checkout is rejected by backend (`Time-in (return) cannot precede
  time-out (checkout).`) and by the UI modal.

- **Capture Visual Proof** (`tauri_webview_screenshot`):
  ```
  tool: tauri_webview_screenshot, args: { "name": "bathroom_key_status" }
  ```
  Cover the kiosk mode tab (`kiosk-mode-bathroom`, cards
  `bathroom-kiosk-card-male/female`) AND the log tab
  (`bathroom-key-log-panel`, `bathroom-checkout-*/return-*`,
  `bathroom-log-edit-*`, `bathroom-edit-dialog/save`) — kiosk cards alone
  cannot prove ACTIONS/EDIT.

## Gotchas

- Desktop-only evidence: verify via Tauri IPC or the desktop webview only —
  browser/LAN checks cannot confirm the Tauri SQLite `bathroom_log`.
- A return (`time_in`) earlier than its checkout (`time_out`) is rejected by
  validation in both the UI modal and the backend. Edits must also fall on the
  log's Manila date.
- TTS chain is cloned carrier → worker/name clip → live Piper → configured
  engine. Kiosk-scan checkout additionally plays the fifteen-minute reminder;
  log-tab actions don't.
- Live-proved 2026-09-19: full MALE checkout → double-checkout rejection →
  return cycle (13 s duration), net-zero state change.
