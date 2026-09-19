# Admin Panel & Employee Roster Management

Administrative workspace for managing employee and intern profiles, RFID card mappings, photo uploads, and manual attendance correction with operator audit logging.

## Sub-features

- `ADMIN-AUTH`: Protected entry requiring the configured administrator PIN (`293906` — the `default_admin_pin` in `src-tauri/src/config.rs`; a config file can override it).
- `ADMIN-ROSTER`: Paginated table listing all employees and interns with filtering and search.
- `ADMIN-UPSERT`: Add new worker or edit details (name, employee ID, role, worker type, RFID UID, rate).
- `ADMIN-PHOTO`: Client-side validation and storage of profile photo (JPEG/PNG/WebP, capped at 500 KiB / 4096x4096px).
- `ADMIN-ATTENDANCE`: View daily time stamps and modify or delete erroneous scans with audit logging.

## How to get to it (user POV)

- From the Kiosk view, click the "Admin" button in the upper header.
- Enter the Admin PIN (`293906`) in the PIN modal and click "Unlock".
- The Admin workspace displays tabs for "Employees", "Attendance", "Payroll", and "Database".

## Driving it with Tauri MCP

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })` with arg keys
> exactly as in `client/src/tauri-api.ts`.

Preconditions:
- Desktop app is running and responsive on Tauri MCP bridge port 9223.
- Database contains active system configuration with admin PIN configured.

- **Authenticate Session**: Unlock admin panel with PIN (`setup_unlock` or the
  `admin_unlock` alias; args `{ "pin": "293906" }`).
  *Observable result*: Returns `{ "success": true, "token": "<session_token>",
  "expiresAt": "..." }` (~15 min fixed expiry, non-sliding). Failures are
  `INVALID_ADMIN_PIN` / `ADMIN_AUTH_REQUIRED` / `ADMIN_SESSION_EXPIRED` —
  never `UNAUTHORIZED`. Check liveness anytime with `admin_get_session`.

- **List Users**: Query employee and intern roster
  (`admin_list_users`, alias `admin_users`; args `{ "token": ... }`).
  *Observable result*: Returns `{ "success": true, "users": [ ... ] }` with
  keys `userId, rfidUid, fullName, employeeType (INTERN|EMPLOYEE — never
  REGULAR), gender (MALE|FEMALE|null — no OTHER), status, photoUrl`.

- **Create or Update Worker Profile**: `admin_upsert_user` with
  `{ "token": ..., "user": { "userId": "...", "fullName": "...",
  "rfidUid": "...", "employeeType": "EMPLOYEE", "status": "ACTIVE" } }`
  (`userId`, not `employeeId`; no `workerType`/`role`/`rate` keys).
  Delete via `admin_delete_user` (`{ "token", "userId" }`).
  *Observable result*: Worker is stored in SQLite and appears in the roster query.

- **Photos**: `upload_photo` (`{ "token", "userId", "base64Data" }`) stores
  `{user_id}.webp` (JPEG/PNG/WebP input, 500 KiB / 4096×4096 caps).

- **Attendance**: `admin_attendance` / `admin_list_attendance`
  (`{ "token", "date": "YYYY-MM-DD" }`); edits via `admin_update_attendance`
  (`{ "token", "attendanceId", "payload" }`), backfills via
  `admin_create_backdated_attendance` (`{ "token", "payload" }`), deletes via
  `admin_delete_attendance` (`{ "token", "attendanceId", "date" }`). Audit rows
  cover create/update/upsert and user delete — attendance delete writes
  sync-queue rows only, no audit row.

- **Capture Visual & DOM Proof**:
  ```
  tool: tauri_webview_screenshot, args: { "name": "admin_roster_table" }
  ```
  *Observable result*: Screenshot captured displaying the updated employee roster table.

## Gotchas

- Session tokens expire exactly 15 min after unlock (fixed, non-sliding).
  Re-authenticate on `ADMIN_SESSION_EXPIRED` / `ADMIN_AUTH_REQUIRED`.
- Gender is `MALE` / `FEMALE` / null only; worker type is `INTERN` /
  `EMPLOYEE` only. Any other value fails validation.

