# RFID Time In/Time Out Kiosk Implementation Plan

## Items to Confirm Before Deployment

- [ ] Confirm the exact RFID reader variation purchased: 125 kHz ID, 13.56 MHz IC, or true dual-frequency.
- [ ] Confirm the exact cards and tags being used.
- [ ] Plug the reader into the kiosk PC, open Notepad, and record the exact UID output for each card.
- [ ] Confirm the UID length and format, including whether it is decimal, hexadecimal, or alphanumeric.
- [ ] Confirm whether the reader automatically appends Enter, carriage return, or newline after a scan.
- [ ] Confirm the kiosk PC and whether the app will run only locally or be accessible over the private LAN.
- [ ] Confirm the spreadsheet tabs, exact headers, service-account Editor access, and the `Asia/Manila` workstation timezone before enrollment.

## 1. Overview

Build a single-screen attendance kiosk for an RFID reader that behaves as a USB HID keyboard wedge. The scanner types a UID into a focused input; the client submits after Enter or after a 150 ms idle fallback for readers that do not send Enter. The server resolves the card in Google Sheets, records one daily time-in and one daily time-out, and returns a typed result for the kiosk to display. A separately protected setup mode lets an authorized operator enroll an unknown card or reconfigure a known card without writing attendance.

The MVP is a React/Vite client, an Express/TypeScript server, and the official Google Sheets API authenticated with a service account. All timestamps and date boundaries use `Asia/Manila`. The system is intentionally small, auditable, and safe to operate on a Windows kiosk over a trusted LAN.

## 2. Scope and Assumptions

### In scope

- RFID scan capture from a keyboard-wedge reader, with a manual test source available to automated tests and controlled verification.
- User lookup from `Users`, daily attendance state in `Attendance`, and append-only operational events in `AuditLogs`.
- Exactly one open attendance row per user per Manila calendar day; a second valid scan closes it.
- Typed request/response contracts shared by client and server.
- Safe configuration endpoint for non-secret UI settings, health endpoint, rate limiting, cooldown feedback, and actionable error codes.
- Optional protected card setup mode, disabled by default, with a short-lived admin session for user enrollment and reconfiguration only.
- Windows local and LAN deployment documentation, Google Cloud setup, and hardware verification.

### Out of scope for the MVP

- Native USB/serial drivers, payroll exports, multi-tenant authorization, offline write queues, or a database migration.
- Editing users or attendance from the kiosk. Sheet administrators maintain roster rows directly.
- A public internet deployment. If remote access is later required, add an authenticated gateway and TLS.

### Assumptions

- Google Sheets is the system of record and has stable, exact header rows.
- A scanner emits printable UID characters as keyboard events and can be configured to send Enter; the 150 ms idle timer is the fallback.
- The kiosk has a persistent network connection to the server and Google APIs.
- A user's `status` is `ACTIVE` (case-normalized) when that user may scan.
- Setup mode is enabled only when `ENABLE_CARD_SETUP=true` and a non-empty `SETUP_ADMIN_PIN` is present. The setup session lasts `SETUP_SESSION_MINUTES` (default 15) and grants no attendance or sheet-admin privileges.
- Unknown cards remain rejected by the normal attendance route; enrollment requires an explicit PIN unlock and setup endpoint.

## 3. Architecture

```text
[USB RFID reader in HID mode]
          |
          v  keyboard events
[React/Vite kiosk]
  focused scan input, idle/Enter submit, cooldown and result UI
          |
          v  POST /api/attendance/scan (JSON)
[Express/TypeScript API]
  validation, rate limit, keyed lock, Sheets adapter, audit logging
  protected setup session and Users-only card setup routes
          |
          v  official Google Sheets API (service account)
[Google Spreadsheet]
  Users | Attendance | AuditLogs
```

The `shared` workspace owns the literal unions and request/response types. The server owns all Sheets reads/writes and never exposes credentials to the browser. The client only receives safe configuration and scan results. Per-user keyed locking serializes concurrent scans; after a write, a read-back check detects uncertain Google API outcomes before another mutation is attempted.

## 4. Google Sheets Schema

Create one spreadsheet with these exact tab names and header rows. Header spelling and order are part of the integration contract.

### `Users`

| Column | Required value | Notes |
| --- | --- | --- |
| `user_id` | yes | Stable employee identifier; unique. |
| `rfid_uid` | yes | Normalized UID; unique among active users. |
| `full_name` | yes | Display name returned to the kiosk. |
| `department` | no | Blank is returned as `null`. |
| `status` | yes | Use `ACTIVE` or `INACTIVE`; only `ACTIVE` can scan. |
| `created_at` | yes | ISO-8601 timestamp for roster audit. |

### `Attendance`

| Column | Required value | Notes |
| --- | --- | --- |
| `attendance_id` | yes | Server-generated unique ID. |
| `attendance_date` | yes | `YYYY-MM-DD` in `Asia/Manila`. |
| `user_id` | yes | Matches `Users.user_id`. |
| `rfid_uid` | yes | Normalized UID used for the scan. |
| `full_name` | yes | Snapshot of the roster name. |
| `department` | no | Snapshot; blank when absent. |
| `time_in` | yes | ISO-8601 timestamp with offset. |
| `time_out` | no | Blank until the closing scan. |
| `status` | yes | `OPEN` or `COMPLETED`. |
| `source` | yes | `RFID` in normal operation, `MANUAL_TEST` only for verification. |
| `notes` | no | Server note for exceptional/manual operations. |

### `AuditLogs`

| Column | Required value | Notes |
| --- | --- | --- |
| `log_id` | yes | Server-generated unique ID. |
| `timestamp` | yes | ISO-8601 timestamp with offset. |
| `event_type` | yes | Scan, rejection, or write outcome category. |
| `rfid_uid` | no | Redact or omit when the value is unavailable. |
| `user_id` | no | Present after user resolution. |
| `message` | yes | Concise operational detail; never include secrets. |
| `request_id` | yes | Correlates API response, server log, and sheet row. |

Keep row 1 frozen and avoid formulas in the data region. Do not reorder or rename headers without updating the adapter and tests together.

## 5. User Flow

1. The kiosk loads safe configuration and focuses the scan input.
2. A reader types a UID. The client normalizes display-safe whitespace but preserves the value needed for validation.
3. Enter submits immediately. If no Enter arrives, a 150 ms idle timer submits the buffered UID once.
4. The client disables duplicate submission for the configured 10-second cooldown and shows a neutral processing state.
5. The API validates the UID and source, resolves an active user, and evaluates that user's Manila-day attendance row.
6. The API returns `TIME_IN` for no row, or `TIME_OUT` for one open row. A completed row is rejected without mutation.
7. The kiosk shows the employee name, action, Manila-local time, and a clear success or error message, then returns focus to the input.
8. Every accepted or rejected attempt receives a `requestId`; operational events are appended to `AuditLogs`.
9. An operator can open setup mode only through the protected PIN flow. The kiosk sends the PIN to `/api/setup/unlock`, keeps the opaque token in memory, and must lock/clear it when finished or when it expires.
10. In setup mode, scanning an unknown card displays an enrollment form; scanning a known card loads its `Users` profile for reconfiguration. Neither setup action calls the attendance route or writes `Attendance`.

## 6. Time-In/Time-Out Decision Rules

- Normalize UID by trimming surrounding whitespace and applying one documented case policy (recommended: uppercase); reject empty, oversized, or invalid characters as `INVALID_SCAN_INPUT`.
- Look up `Users.rfid_uid`; unknown cards return `UNKNOWN_RFID_CARD`.
- A matching row whose `status` is not `ACTIVE` returns `INACTIVE_USER`.
- Compute `attendance_date` from the server clock in `Asia/Manila`, never from browser time.
- Under a per-user lock, find rows for that date. More than one row or conflicting values returns `ATTENDANCE_DATA_CONFLICT` and does not write.
- No row: append `OPEN` row with `time_in`; action is `TIME_IN`.
- One `OPEN` row: update only `time_out`, set `status` to `COMPLETED`; action is `TIME_OUT`.
- One `COMPLETED` row: return `ATTENDANCE_ALREADY_COMPLETED`; do not append another row.
- A repeated request within the kiosk/server cooldown returns `DUPLICATE_SCAN`; clients should honor `retryAfterSeconds`.
- If Google reports a timeout or ambiguous result, perform a read-back by `requestId`/attendance identity. Return `GOOGLE_SHEETS_UNAVAILABLE` or `ATTENDANCE_DATA_CONFLICT` as appropriate; never blindly retry a mutation.
- Setup requests use a separate short-lived session and Users-only mutation path. An unknown card may be enrolled only after successful PIN unlock; a known card may update its `user_id`, `full_name`, `department`, or `status` while retaining the scanned UID. Setup does not create, close, or alter Attendance rows.
- If the scanned UID is already assigned to a different `user_id`, return `USER_CONFLICT` and do not overwrite the existing roster row. Replacement cards require an explicit operator workflow (deactivate old UID, then enroll the new UID).

## 7. API Contract

Contracts live in `shared/src/api-contracts.ts` and are consumed by both workspaces.

### `GET /api/health`

Returns `HealthResponse` with `service: "rfid-attendance-api"`, an ISO timestamp, and `googleSheets: "connected"` only after a lightweight Sheets check succeeds. Non-2xx responses must still include a request/correlation ID in server logs.

### `GET /api/config`

Returns `SafeConfigResponse` only: `timezone`, `rfidAutoSubmitDelayMs` (150), `enableScanSounds`, and `resultResetDelayMs`. Never include service-account JSON, spreadsheet IDs, or arbitrary environment variables.

### `POST /api/attendance/scan`

Request body:

```json
{ "rfidUid": "04A1B2C3", "source": "RFID" }
```

Success (`200`) is `ScanSuccessResponse` with `requestId`, `action`, a user summary, and an attendance summary. Validation or business failures use `ScanErrorResponse` and one of the typed codes: `INVALID_SCAN_INPUT`, `UNKNOWN_RFID_CARD`, `INACTIVE_USER`, `DUPLICATE_SCAN`, `ATTENDANCE_ALREADY_COMPLETED`, `ATTENDANCE_DATA_CONFLICT`, `GOOGLE_SHEETS_UNAVAILABLE`, `RATE_LIMITED`, `INTERNAL_SERVER_ERROR`, or `CONFIGURATION_ERROR`. `RATE_LIMITED` may include `retryAfterSeconds`.

Reserve `GET /api/attendance/today` for a future authenticated operator view; it is not part of the kiosk MVP.

### Protected card setup contract

Setup endpoints are available only when `ENABLE_CARD_SETUP=true`. They are not an alternate attendance API.

- `POST /api/setup/unlock` accepts `{ "pin": "..." }` and returns `SetupUnlockResponse`: `{ "success": true, "setupToken": "<opaque-token>", "expiresAt": "<ISO timestamp>" }`. The token is short-lived and must be sent in `X-Setup-Token` for subsequent setup calls.
- `POST /api/setup/lock` invalidates the current setup session. The client must clear the token regardless of the response.
- `GET /api/setup/card?rfidUid=...` requires `X-Setup-Token` and returns `SetupLookupResponse`, with `user: null` for an unknown UID or the existing `SetupUser` for a known UID.
- `POST /api/setup/users` requires `X-Setup-Token` and accepts `SetupUpsertRequest`: `{ "rfidUid": "...", "userId": "...", "fullName": "...", "department": "...", "status": "ACTIVE" }`. It returns `SetupUpsertResponse` with `created: true` for enrollment and `created: false` for a reconfiguration.
- Setup failures use `SetupErrorResponse` codes: `SETUP_DISABLED`, `INVALID_SETUP_PIN`, `SETUP_AUTH_REQUIRED`, `SETUP_SESSION_EXPIRED`, `SETUP_VALIDATION_ERROR`, `USER_CONFLICT`, or `GOOGLE_SHEETS_UNAVAILABLE`.
- Unlock attempts are rate-limited. PINs, setup tokens, and full request bodies must not be logged. A setup token authorizes only these setup endpoints and never `POST /api/attendance/scan`.

## 8. Security and Data Handling

- Keep the service-account key and spreadsheet ID server-side. Load them from environment variables or a file with Windows ACLs that excludes normal kiosk users.
- Share only the target spreadsheet with the service account; do not grant project-wide or domain-wide delegation unless a later requirement proves it necessary.
- Validate request shape, UID length/charset, source enum, JSON size, and content type. Apply IP and UID rate limits plus the 10-second duplicate cooldown.
- Generate cryptographically strong request, attendance, and audit IDs. Do not trust client timestamps or user identity.
- Escape or prefix values that begin with `=`, `+`, `-`, or `@` before writing user-controlled text to Sheets to prevent formula injection; retain the canonical value in server-side logs only when needed.
- Avoid logging service-account tokens, private keys, full request bodies, or unnecessary personal data. Correlate diagnostics by `requestId`.
- Bind to localhost for single-PC use. For LAN use, bind to the Windows private interface, restrict inbound firewall rules to the private subnet, and place HTTPS/reverse proxy/authentication in front before any untrusted network exposure.
- Back up the spreadsheet and rotate service-account keys on a documented schedule. Revoke keys immediately after suspected disclosure.
- Keep `SETUP_ADMIN_PIN` server-side and out of browser bundles, Sheets, source control, and logs. Set `ENABLE_CARD_SETUP=false` in production unless enrollment/reconfiguration is actively being performed.
- Generate an opaque, unpredictable setup token after a correct PIN, enforce the `SETUP_SESSION_MINUTES` expiry server-side, and invalidate it on lock, expiry, process restart, or repeated failed authentication as policy requires.
- Scope setup writes to `Users` only. Never accept a client-supplied sheet/tab name, attendance row, timestamp, or service-account credential. Audit setup unlock, enrollment, reconfiguration, conflict, lock, and expiry events without recording the PIN/token.
- Treat a static PIN as a compensating control for a trusted kiosk, not identity proof. Keep the setup control out of the public kiosk flow and require an operator to remain physically present with the card.

## 9. Folder Structure

```text
.
|- client/
|  |- src/
|  |  |- App.tsx
|  |  |- api.ts
|  |  |- components/
|  |  |- hooks/useRfidScanner.ts
|  |  `- styles/
|- server/
|  |- src/
|  |  |- app.ts
|  |  |- config.ts
|  |  |- index.ts
|  |  |- routes/health.ts
|  |  |- routes/attendance.ts
|  |  |- routes/setup.ts
|  |  |- services/attendance-service.ts
|  |  |- services/setup-service.ts
|  |  |- services/sheets-service.ts
|  |  |- middleware/
|  |  `- tests/
|  `- scripts/validate-sheets.ts
|- shared/
|  `- src/api-contracts.ts
|- docs/
|  |- hardware-verification.md
|  |- google-sheets-setup.md
|  `- deployment.md
`- plan.md
```

Keep adapters and route handlers thin: decision rules belong in the attendance service, Google API details in the Sheets service, and browser behavior in the scanner hook/UI.

## 10. Implementation Phases

### Phase 1 - Workspace and contracts

**Objective:** Establish buildable client/server/shared workspaces and stable API types.

**Files:** `package.json`, `client/package.json`, `client/src/*`, `server/package.json`, `server/src/app.ts`, `shared/src/api-contracts.ts`, workspace TypeScript configs.

**Tasks:** Add workspace scripts and dependencies; define literal enums, request/response unions, and safe config types; create a minimal Express health route and Vite shell; fail fast on missing configuration.

**Definition of done:** `npm install`, `npm run typecheck`, and `npm run build` pass from the root; client and server start independently; no secret appears in browser output.

**Manual tests:** Open the kiosk, verify focus and safe config load; call `/api/health`; stop the Sheets credential and verify a clear configuration/health failure.

### Phase 2 - Google Sheets adapter and validation

**Objective:** Connect the service account to the three exact tabs with deterministic header validation.

**Files:** `server/src/services/sheets-service.ts`, `server/src/config.ts`, `server/scripts/validate-sheets.ts`, server tests, `docs/google-sheets-setup.md`.

**Tasks:** Authenticate with official Google Sheets API; read header rows; map rows to typed records; normalize UID/status; append/update rows by stable column indexes; add read-back helpers and bounded retries for reads only.

**Definition of done:** Validator rejects missing, duplicate, renamed, or reordered headers; a valid sheet reports all tabs and headers; writes never target a wrong tab or column.

**Manual tests:** Run `npm run validate:sheets -w server`; temporarily rename a header and confirm a `CONFIGURATION_ERROR`; restore it and append a safe test user/event.

### Phase 3 - Attendance decision engine and API

**Objective:** Implement one daily Time In/Out state machine with concurrency and uncertain-write protection.

**Files:** `server/src/services/attendance-service.ts`, `server/src/routes/attendance.ts`, `server/src/middleware/*`, server unit/integration tests.

**Tasks:** Validate input; resolve active user; compute Manila date; acquire keyed lock; evaluate zero/open/completed/conflict states; append or update exactly one row; read back after ambiguous writes; append audit events; map errors to typed HTTP responses.

**Definition of done:** Concurrent requests for one UID cannot create duplicate rows; a completed day never mutates; every response has a request ID; all contract error codes are covered by tests.

**Manual tests:** Scan a new card (Time In), scan it again (Time Out), scan a third time (already completed), use an inactive/unknown card, send malformed JSON, and simulate Sheets downtime.

### Phase 4 - Protected card setup

**Objective:** Add an explicitly unlocked, short-lived setup mode for safe card enrollment and known-card reconfiguration.

**Files:** `shared/src/api-contracts.ts`, `server/src/config.ts`, `server/src/setup.ts`, `server/src/app.ts`, setup tests, `client/src/App.tsx`, `client/src/api.ts`, `.env.example`.

**Tasks:** Parse `ENABLE_CARD_SETUP`, `SETUP_ADMIN_PIN`, and `SETUP_SESSION_MINUTES`; implement PIN unlock/lock and expiring opaque tokens; add the four setup routes and typed error responses; resolve unknown and known cards from `Users`; append/update only `Users`; reject UID/user conflicts; keep setup state out of normal scan state.

**Definition of done:** Setup is disabled by default and fails closed without a PIN; a correct PIN returns a token with expiry; lock and expiry invalidate it; an unknown card can be enrolled once; a known card can be reconfigured without changing `Attendance`; setup tokens cannot call attendance routes; PIN/token values never appear in logs or client bundles.

**Manual tests:** With setup disabled, verify unlock returns `SETUP_DISABLED`; enable it and unlock with a wrong/correct PIN; enroll an unknown card; look up and reconfigure that card; attempt a conflicting UID/user; wait for expiry; lock explicitly; verify all normal attendance scans remain unchanged.

### Phase 5 - Kiosk scanner UX

**Objective:** Make HID scanning reliable and understandable without operator controls.

**Files:** `client/src/hooks/useRfidScanner.ts`, `client/src/App.tsx`, `client/src/api.ts`, client components/styles, client tests.

**Tasks:** Keep a hidden/visible focused input; submit on Enter or once after 150 ms idle; clear after submit; show processing/success/error states; enforce 10-second cooldown and optional sound; restore focus after result reset; support `MANUAL_TEST` only in a non-production test affordance; expose setup mode only after PIN unlock and keep its token in memory.

**Definition of done:** Rapid scanner keystrokes produce one request; Enter plus idle cannot double-submit; text remains legible at the kiosk viewport; keyboard focus recovers after every outcome.

**Manual tests:** Use a real reader with and without Enter suffix, paste a UID, press keys slowly, unplug/replug the reader, and verify duplicate/cooldown messaging.

### Phase 6 - Security, operations, and deployment

**Objective:** Harden the service for a Windows workstation and private LAN.

**Files:** `server/src/config.ts`, rate-limit/security middleware, setup/attendance auth middleware, root scripts, `docs/deployment.md`, `.env.example` (without secrets), tests.

**Tasks:** Set CORS/origin policy, request limits, rate limiting (including PIN unlock), safe logging, ACL guidance, graceful shutdown, health checks, LAN bind/firewall instructions, setup-session invalidation on restart, and backup/key-rotation procedures.

**Definition of done:** `npm run lint`, `npm test`, and `npm run build` pass; secrets are excluded from git; localhost and LAN smoke tests succeed; deployment runbook is executable on a clean Windows machine.

**Manual tests:** Verify localhost access, an allowed LAN client, a blocked non-private client, rate-limit behavior, process restart recovery, and spreadsheet backup/restore drill.

### Phase 7 - Acceptance and handoff

**Objective:** Validate hardware, data integrity, and operator readiness before production use.

**Files:** `docs/hardware-verification.md`, `docs/google-sheets-setup.md`, `docs/deployment.md`, release checklist.

**Tasks:** Run the hardware matrix, validate exact headers and permissions, execute end-to-end day-boundary and failure tests, capture request IDs for evidence, and record rollback contacts.

**Definition of done:** All critical checklist items pass; no unresolved `ATTENDANCE_DATA_CONFLICT`; operators can identify and recover from each documented error.

**Manual tests:** Complete the hardware verification script on the production reader and perform a controlled Time In/Out with a disposable test user before enabling real cards.

## 11. Testing Checklist

- [ ] Shared typecheck/build and lint pass.
- [ ] Input validation covers empty, whitespace, overlong, malformed, and unsupported-source requests.
- [ ] Unknown and inactive UIDs return the correct code without an Attendance row.
- [ ] Setup disabled by default returns `SETUP_DISABLED`; production cannot enable setup without `SETUP_ADMIN_PIN`.
- [ ] Wrong setup PIN is rejected and rate-limited without disclosing whether a card or user exists.
- [ ] Correct PIN returns an opaque `setupToken` and `expiresAt`; token is accepted only through setup endpoints.
- [ ] `POST /api/setup/lock` invalidates the token; expiry and process restart invalidate it as well.
- [ ] Unknown-card setup creates exactly one `Users` row and no `Attendance` row.
- [ ] Known-card setup reconfiguration updates only `Users`; attendance history remains unchanged.
- [ ] UID/user conflicts return `USER_CONFLICT` without overwriting the existing user.
- [ ] Setup PIN, token, and sensitive setup payloads never appear in logs, browser bundles, or `/api/config`.
- [ ] First scan appends one `OPEN` row with Manila date/time.
- [ ] Second scan updates that row to `COMPLETED` with `time_out` only.
- [ ] Third scan returns `ATTENDANCE_ALREADY_COMPLETED` without another row.
- [ ] Duplicate requests within 10 seconds are rate-limited/cooldown protected.
- [ ] Concurrent scans for one UID are serialized; different UIDs can proceed independently.
- [ ] Ambiguous append/update outcomes trigger read-back and never blind duplicate writes.
- [ ] Duplicate/conflicting sheet rows fail closed with `ATTENDANCE_DATA_CONFLICT`.
- [ ] Sheets auth, permission, quota, and network failures map to actionable errors.
- [ ] AuditLogs receives accepted and rejected attempts with request IDs and no secrets.
- [ ] Enter and 150 ms idle fallback each submit exactly once.
- [ ] Kiosk focus, reset timing, sounds, and error states work at target resolution.
- [ ] Health/config endpoints expose only intended data.
- [ ] Localhost and private-LAN firewall/CORS behavior match deployment policy.
- [ ] Windows restart and backup/restore drills are documented and successful.

## 12. Google Cloud Setup

Use [docs/google-sheets-setup.md](docs/google-sheets-setup.md) as the executable runbook. In summary: create/select a Google Cloud project; enable Google Sheets API; create a service account and a JSON key; create the spreadsheet and exact tabs/headers; share the spreadsheet with the service-account email as Editor; provision `GOOGLE_SERVICE_ACCOUNT_JSON` (or a protected key path), `GOOGLE_SHEETS_SPREADSHEET_ID`, and `TIMEZONE=Asia/Manila`; run the validator before starting the kiosk.

Never commit the JSON key, spreadsheet ID, or `.env` file. Restrict the key file ACL to the service account runner and the designated administrator.

## 13. Local and LAN Deployment

Use [docs/deployment.md](docs/deployment.md) for Windows commands and firewall steps. Local mode binds the API to `127.0.0.1`; LAN mode binds to the private host address, serves the built client through the server or a controlled static host, and allows only the selected private subnet through Windows Defender Firewall. Verify `/api/health` from the kiosk and one approved LAN client, then run the hardware checklist. Do not expose the API directly to the public internet.

## 14. MVP Limitations

- Google Sheets latency, quotas, and manual edits can affect availability and consistency.
- There is no offline queue; a failed write is reported and must be retried after verification.
- One attendance record per user/day cannot represent split shifts, breaks, overnight shifts, or corrections.
- Roster changes require spreadsheet access; there is no admin UI or role model.
- HID input depends on reader configuration and browser focus; native reader health telemetry is unavailable.
- LAN mode assumes a trusted private network and does not provide end-user authentication.
- Card setup is protected by one server-side static PIN and short-lived in-memory sessions; it is not a full identity or role system.
- Enrollment/reconfiguration is intentionally limited to `Users`; replacement-card history, approvals, and self-service administration are not modeled.

## 15. Approved Expansion: Admin, Live Dashboard, and Scanner Focus

**Implementation status:** Complete in the current workspace. Verification is recorded by the passing root typecheck, lint, build, and test commands.

This section supersedes the original MVP limitations where they conflict with the approved implementation request.

### Product behavior

- `/` remains the RFID reader kiosk for the reader PC.
- `/attendance` is a public live dashboard for the viewing PC. It shows users who have scanned for the selected/current Manila date and refreshes from the shared API every five seconds.
- `/admin` is a PIN-protected management view for saved Users/RFIDs and attendance corrections.
- Google Sheets remains the shared source of truth, so a scan made on the reader PC is visible to the viewing PC through the API polling cycle.

### Admin rules

- Users can be listed, searched, created, and edited. RFID UID, full name, department, and active status are editable. Existing User IDs remain fixed so historical attendance links remain valid.
- Attendance can be listed for any date and edited by `attendanceId`. Time-in and time-out may be cleared or replaced. Status is derived as `COMPLETED` when both exist, `OPEN` when only time-in exists, and `INCOMPLETE` otherwise.
- Times are entered in `Asia/Manila`, must belong to the attendance date, and time-out cannot precede time-in. No user or attendance deletion is included.
- Mutations are protected by the admin session and use optimistic conflict checks so a newer scan/edit cannot be silently overwritten. All admin mutations are audit logged.

### Live refresh and failure behavior

- Polling runs immediately and every five seconds, pauses while the tab is hidden, and refreshes when the tab regains focus. Overlapping requests are prevented.
- The last successful dashboard data remains visible after a failed refresh with a stale/offline indicator.
- Admin authentication uses a signed, expiring, HTTP-only cookie backed by `ADMIN_SESSION_SECRET` so it works across Vercel function instances. Existing setup environment names remain compatibility aliases.

### Scanner focus acceptance

- On first load of `/`, the RFID input is focused automatically so a user can tap a card without clicking the field.
- Focus is restored after a scan result resets, after returning to the browser tab/window, and after closing scanner-side controls.
- Focus recovery must not steal focus from Manual UID, Admin, date, time, or other interactive controls.

### Verification additions

- Test public dashboard empty/data/stale states, five-second polling, hidden-tab pause, and two-browser propagation within five seconds.
- Test admin authentication, user/RFID uniqueness, immutable User IDs, attendance timestamp validation, status derivation, and optimistic conflicts.
- Test first-load RFID autofocus, focus recovery after scan/error, and no focus theft while editing another field.

## 16. Future Enhancements

- Add an authenticated operator dashboard and protected `GET /api/attendance/today` with filters/export.
- Move transactional attendance state to a database while retaining Sheets export/audit integration.
- Add offline-safe queueing with idempotency keys and reconciliation UI.
- Support breaks, split/overnight shifts, corrections, holidays, and payroll exports.
- Add card enrollment/deactivation workflow with role-based access and approval history.
- Replace the static setup PIN with named operator accounts, MFA or an identity-aware proxy, and durable session/revocation auditing.
- Add reader diagnostics, device health, kiosk watchdog, and Windows service packaging.
- Add TLS, identity-aware proxy, central secret storage, metrics, alerts, and immutable audit retention for broader deployments.

---

# Plan Update: Payroll, Enrollment Photos, and Kiosk UX

> **Status:** This block supersedes conflicting statements above and is part of the complete plan. Existing Phases 1–7 and Section 15 remain required; the new implementation order is Phase 8, Phase 9, then Phase 10.
>
> **Markers:** `[AMENDED]` changes existing behavior. `[NEW]` adds behavior.

## Updated Scope and Decisions [AMENDED]

- Add `INTERN`/`EMPLOYEE` classification, employee daily rates, enrollment photos, intern payroll, and employee payroll scaffolding.
- Use Vercel Blob for photos. `Users.photo_url` stores the returned HTTPS URL; migrated users may remain blank until enrollment.
- New enrollment defaults to `INTERN`; employee mode requires a positive `daily_rate` with at most two decimals and an uploaded photo.
- Authorized admin attendance corrections keep Payroll synchronized. Completing a corrected row creates payroll; changing a completed row back to open or deleting it removes payroll. Intern weeks are replayed chronologically so the single free late remains deterministic.
- Historical payroll is not created automatically. Provide a dry-run-first, explicit `--execute` backfill command.
- Employee late rules remain pending client input; preserve this exact source comment in the employee service:

```ts
// TODO: Employee late rules TBD by client
```

## Updated Google Sheets Schema [AMENDED]

`Users` must have this exact header row:

```text
user_id,rfid_uid,full_name,department,status,created_at,employee_type,daily_rate,photo_url
```

Existing blank `employee_type` values are migrated to `INTERN`. Intern `daily_rate` is blank; employee `daily_rate` is numeric and positive.

Add an `InternGrace` tab with:

```text
grace_id,user_id,week_start,attendance_id,used_at
```

There is at most one row for `(user_id, week_start)`. `week_start` is the Monday date in `Asia/Manila`, and `attendance_id` identifies the late that consumed grace.

Add a `Payroll` tab with:

```text
payroll_id,attendance_id,user_id,full_name,employee_type,attendance_date,actual_time_in,actual_time_out,computed_time_in,computed_time_out,grace_used,late_hours,late_deduction,base_pay,daily_pay,notes
```

`attendance_id` is unique. `actual_*` values always copy raw Attendance values. `grace_used` is `TRUE` only for the intern row that consumed weekly grace, `FALSE` for other intern rows, and blank for employees.

## Updated Payroll Rules [NEW]

Payroll is created only after attendance becomes `COMPLETED`; a `TIME_IN` never creates payroll, and an attendance left `OPEN` never creates payroll. Payroll creation is idempotent by `attendance_id`; a completed attendance missing payroll triggers recovery before the ordinary already-completed response.

For interns, official start is 8:00 AM Manila. `late_hours = Math.ceil((actual_time_in - official_start) / 1 hour)` when late, otherwise zero. The first late from Monday through Sunday claims `InternGrace`, keeps exact `computed_time_in`, and has zero deduction. Later lates snap `computed_time_in` to the next full hour and charge `late_hours * 10`. `computed_time_out` always equals the exact time-out. `base_pay = 80` and `daily_pay = Math.max(0, 80 - late_deduction)`.

For employees, preserve raw timestamps, round `computed_time_in` up to the next full hour when needed, round `computed_time_out` down to the current full hour, set deductions and late hours to zero, and set `base_pay` and `daily_pay` to the user’s daily rate. Employee deduction logic remains the TODO above.

Intern grace claims must be linked to the attendance row. If a Payroll write fails after Attendance completes, retrying finds the same grace claim and creates the missing row without charging the free late or duplicating payroll.

## Updated API and Data Contracts [AMENDED]

Extend `shared/src/api-contracts.ts` user summaries and setup/admin users with:

```ts
type EmployeeType = 'INTERN' | 'EMPLOYEE';

employeeType: EmployeeType;
dailyRate: number | null;
photoUrl: string | null;
```

`POST /api/attendance/scan` returns employee type and photo URL in its user payload. Add a typed `PAYROLL_GENERATION_FAILED` error for an Attendance completion whose Payroll row cannot be confirmed.

Extend protected setup/admin upserts with `employeeType`, `dailyRate`, and `photoUrl`. Creation defaults omitted type to `INTERN`; employee rows require a valid rate; new enrollment requires a photo; switching to intern clears the rate.

Add a protected Vercel Blob upload-token route authorized by the existing setup token or signed admin cookie. Restrict uploads to JPEG, PNG, or WebP, a server-generated user path, and a processed image no larger than 512×512 and 500 KB. Never expose Blob credentials or unrestricted upload tokens to the browser.

## Updated Folder Structure [AMENDED]

Add these focused modules to the existing flat server layout:

```text
server/src/employee-payroll.ts
server/src/intern-payroll.ts
server/src/payroll.ts
server/src/payroll-reconciliation.ts
server/src/photo-storage.ts
server/src/migrate-payroll-sheets.ts
server/src/backfill-payroll.ts
server/test/employee-payroll.test.ts
server/test/intern-payroll.test.ts
server/test/payroll.test.ts
server/test/payroll-reconciliation.test.ts
server/test/photo-storage.test.ts
client/src/components/EmployeeTypeToggle.tsx
client/src/components/PhotoEnrollmentField.tsx
client/src/components/ScanResult.tsx
client/src/hooks/useRfidScanner.ts
```

`intern-payroll.ts` and `employee-payroll.ts` are pure policy calculations. `payroll.ts` coordinates Sheets writes and idempotency. `payroll-reconciliation.ts` replays intern weeks after corrections. `photo-storage.ts` authorizes and validates Blob uploads. Existing route handlers remain thin.

## Phase 8 – Intern Payroll Foundation [NEW, PRIORITY 1]

- Extend Users types, adapters, validators, setup, admin, and in-memory fixtures.
- Add a backup-first schema migration that creates the two tabs and appends the three Users columns without reordering existing data.
- Implement `InternGrace` week calculation, unique claim, linked attendance ID, and reconciliation.
- Implement intern late, grace, deduction, floor-at-zero, and Payroll-row formulas.
- Invoke payroll only after successful time-out completion and add read-back/idempotent recovery.
- Synchronize payroll when authorized admin corrections complete, reopen, edit, or delete attendance.
- Add `npm run migrate:payroll -w server -- --dry-run|--execute`.
- Add `npm run backfill:payroll -w server -- --dry-run|--execute [--from YYYY-MM-DD --to YYYY-MM-DD]`; dry-run is the default and only completed rows without payroll are eligible.
- Mark backfilled values in `notes`; skip invalid historical rows with an operator-readable report.

Definition of done: time-in/open rows never create payroll; all intern examples pass; Monday resets grace in Manila; retries cannot duplicate payroll or consume grace twice; admin corrections replay the affected week deterministically.

## Phase 9 – UI/UX Overhaul [NEW, PRIORITY 2]

- Set minimum rendered body/control text to 18px and headings to 32px or larger across kiosk, setup, dashboard, and admin.
- Remove the visible RFID field from the kiosk ready screen. Keep a clipped, focusable DOM input; never use `display:none` or `disabled` while scanning.
- Restore focus after load, result reset, browser focus/visibility, and modal close, while never stealing focus from setup/admin/manual controls.
- Make `SCANNER READY` a large ambient status element.
- Add a stable scan result with prominent ID photo, full name, employee-type badge, action, and Manila timestamp. Use a fallback avatar for migrated users without photos.
- Replace employee-type select/text controls with an accessible large `INTERN ↔ EMPLOYEE` switch. Default new users to intern and reveal/require daily rate only for employees.
- Add photo selection, client resize/crop, preview, protected Blob upload, progress, retry, and validation states. Require photos for new enrollment.
- Add responsive visual tests at desktop and mobile sizes; assert no text overlap, clipping, or focus theft.

Definition of done: the reader works without clicking a visible input; all text meets the hard size requirement; scan results show photo/type/action/time; setup uses a toggle and cannot save an invalid employee profile.

## Phase 10 – Employee Payroll [NEW, PRIORITY 3]

- Implement employee hour ceiling/floor in `employee-payroll.ts` while preserving actual timestamps.
- Create idempotent employee Payroll rows with zero late hours/deductions and daily-rate pay.
- Preserve the exact `// TODO: Employee late rules TBD by client` comment.
- Extend correction synchronization and optional backfill to employees.
- Test exact-hour, partial-hour, timezone, missing-rate, retry, and correction behavior.

## Updated Testing Checklist [NEW]

- [ ] Schema validator requires all five tabs and exact headers.
- [ ] Migration dry-run is read-only; execute mode preserves existing rows.
- [ ] New users default to `INTERN`; employee mode requires a positive daily rate.
- [ ] Intern 7:50 AM and 8:00 AM are on time; first 8:17 AM late is free and claims grace.
- [ ] A later 8:17 AM late computes to 9:00 AM and deducts ₱10; deductions never make pay negative.
- [ ] Grace resets Monday Manila time and concurrent scans cannot create two grace claims.
- [ ] Payroll is absent for time-in/open attendance and unique after time-out.
- [ ] Partial Sheets failure and retry recover payroll without duplicate rows or incorrect deductions.
- [ ] Admin correction/deletion replays intern grace and synchronizes Payroll.
- [ ] Employee 7:50 AM rounds to 8:00 AM; 5:10 PM rounds to 5:00 PM; raw values remain unchanged.
- [ ] Employee pay equals daily rate and employee deductions remain zero pending client rules.
- [ ] Photos reject invalid formats/size, upload only with setup/admin authorization, and never expose Blob credentials.
- [ ] Scan response/result displays photo, name, type, action, and timestamp.
- [ ] RFID input is present but invisible, remains focused, and does not steal focus from interactive forms.
- [ ] Computed UI text is at least 18px; headings are at least 32px; desktop/mobile screenshots have no overlap.
- [ ] Existing root typecheck, lint, build, and all attendance/admin/dashboard tests remain green.

## Updated Rollout and Operations [AMENDED]

Back up the spreadsheet, run migration dry-run, review and execute migration, classify users, enter employee rates, provision `BLOB_READ_WRITE_TOKEN`, and test one disposable photo upload before enabling setup. Deploy in the exact order Phase 8, Phase 9, Phase 10. Run the intern and employee acceptance cases, then optionally execute the approved payroll backfill.

Update `docs/google-sheets-setup.md`, `docs/card-registration.md`, `docs/deployment.md`, and add `docs/payroll-operations.md`. Future work now includes payroll-period summaries, approval/disbursement, employee late rules, private photo delivery, and payroll exports; payroll generation itself is no longer an MVP limitation.

## Configurable Cutoff Payroll Profiles [CURRENT EXECUTION]

### Goal

Add administrator-managed, semi-monthly cutoff payroll without changing the existing attendance-linked `Payroll` rows. Employees are never seeded by the application. The administrator creates employees and assigns a reusable calculation profile.

### Temporary calculation profiles

- `JEAN_TENURED`: daily rate and cutoff defaults from the supplied Jean Ashley example, including PHP 6,600.00 incentives, PHP 150.00 special allowance, and configurable holiday multipliers.
- `BEA_STANDARD`: the same calculation formulas with allowance and manual-adjustment defaults of PHP 0.00 until Bea's policy is defined.
- Profiles are rule records, not employee records. Their labels, rates, and policies remain editable so future employee policies do not require code changes.

### Implementation

- Add integer-centavo money helpers and a pure cutoff calculator with explicit breakdown fields.
- Add `PayrollProfiles` and `PayrollCutoffs` Google Sheets tabs plus in-memory adapter support; preserve existing `Payroll`, `Attendance`, and `Users` behavior.
- Store the assigned profile on employee records and expose profile selection in the admin user editor.
- Add protected admin endpoints for profile CRUD, cutoff payroll CRUD/finalization, details, and CSV export.
- Add an Admin Payroll workspace with the required payroll columns, PHP formatting, expandable details, manual-adjustment reason, print view, and signature placeholder.
- Validate required employee/cutoff data, non-negative money/day values, approved working-day overages, adjustment reasons, and finalization state.
- Keep `netPay` equal to finalized gross after the supported attendance deductions; preserve the field for future statutory deductions.

### Acceptance tests

- Jean July 1-15, 2026 calculates PHP 7,755.00 basic pay, PHP 211.50 special holiday pay, PHP 7,966.50 total compensation, PHP 6,750.00 total allowance, PHP 14,716.50 gross before adjustment, and PHP 16,216.50 with an explicit PHP 1,500.00 adjustment.
- Bea profile calculates the same formulas with zero allowance defaults.
- Money serialization, profile assignment, validation, Sheets round-trips, admin endpoints, print data, and CSV export are covered.
- Existing attendance, intern, employee, setup, and admin tests remain green.
