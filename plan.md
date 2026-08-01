# Alpha Premier Attendance Tauri v2 Implementation Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute this plan task by task. Every phase must leave the application buildable and testable.

**Goal:** Replace the Vercel/Express web deployment with a Windows-first Tauri v2 application whose SQLite database is authoritative, whose Rust core owns all writes, and whose embedded private-LAN dashboard lets a boss view live attendance from another office PC without installing Tauri.

**Architecture:** The front-desk Windows laptop is the only machine connected to the RFID reader and the only attendance writer. Tauri embeds the React kiosk, Rust services, SQLite, an Axum read-only LAN server, and an asynchronous Google Sheets export worker.

**Tech Stack:** Tauri v2, Rust, Tokio, Axum, SQLx, SQLite, `tauri-plugin-sql`, `rdev`, `google-sheets4`, `yup-oauth2`, `chrono-tz`, `image`, React, Vite, TypeScript, NSIS.

---

## 1. Scope and Locked Decisions

- Preserve every existing attendance, payroll, setup, admin, photo, audit, migration, and Google Sheets behavior.
- Store all operational data in SQLite first; Google Sheets is an optional write-only export and backup target.
- Run the RFID reader only on the front-desk Windows laptop.
- Run one embedded Axum server in the Tauri process for read-only LAN viewing.
- Serve the boss dashboard at `http://FRONTDESK-LAPTOP-IP:4173/attendance`.
- Use SSE as the primary live update channel and five-second polling as the disconnect fallback.
- Keep all admin, payroll, setup, user, photo, correction, backup, and sync mutations inside Tauri IPC.
- Bind the LAN server only to a configured private address. Reject public addresses and reject `0.0.0.0` unless explicitly enabled with an allowed subnet.
- Use NSIS for the Windows installer.
- During the parallel pay period, Tauri is the only writer; the old web app is read-only.
- Defer auto-update, public hosting, remote access, multi-writer operation, statutory deductions, approval workflows, and browser admin.

## 2. Architecture Overview

```text
[USB RFID reader: HID keyboard wedge]
                   |
                   v
[Front-desk Windows laptop]
  focused input + rdev global input fallback
                   |
                   v
[Tauri v2 Rust core]
  RFID deduplication, attendance, payroll,
  admin, setup, photo, audit, configuration
                   |
                   v
[SQLite primary store]
  attendance + payroll + grace + audit + queue
         |                         |
         |                         v
         |              [Tokio Sheets sync worker]
         |                         |
         |                         v
         |                [Optional Google Sheets export]
         |
         +-----------------------+
         |                       |
         v                       v
[Local Tauri event bus]   [Embedded Axum LAN server]
         |                 read-only SQLx queries
         |                 JSON snapshot + SSE
         v                       |
[Kiosk/admin Tauri windows]      v
                         [Boss PC browser]
                         http://FRONTDESK-IP:4173/attendance
```

The Rust core is in-process; Express is removed from the desktop runtime. Every accepted or rejected scan is validated, keyed-locked, audited, and committed in SQLite before the command returns. After commit, the event bus notifies local Tauri windows and connected LAN browsers. A LAN server failure, disconnected viewer, or Sheets outage never rolls back a committed local scan.

### 2.1 LAN server lifecycle

1. Load `config.toml`, resolve `appLocalDataDir`, open SQLite, and apply migrations.
2. Start RFID, Tauri commands, and local windows.
3. If LAN mode is enabled, validate the private bind address, port, and subnet policy.
4. Start Axum on a supervised Tokio task with graceful cancellation.
5. Retry binding every 30 seconds if the interface is unavailable or the port is occupied.
6. Report LAN status locally without blocking attendance.
7. Shut down SSE streams and the listener when Tauri exits.

### 2.2 LAN routes

| Route | Purpose | Access |
| --- | --- | --- |
| `GET /attendance` | Browser-safe read-only dashboard | Viewer session when enabled |
| `GET /api/attendance/today?date=YYYY-MM-DD` | Selected Manila-date snapshot | Viewer session when enabled |
| `GET /api/events/attendance` | Server-Sent Events stream | Viewer session when enabled |
| `GET /api/health` | Minimal local/LAN health | Allowed private subnet |
| `GET /login` | Optional viewer login page | Allowed private subnet |
| `POST /api/viewer/session` | Create opaque viewer session | Rate-limited password check |
| `POST /api/viewer/logout` | Invalidate viewer session | Viewer session |

No `/admin`, `/setup`, `/payroll`, `/api/admin/*`, `/api/setup/*`, photo mutation, user mutation, attendance correction, or sync mutation route is exposed by Axum. Unknown paths return 404 and unsupported methods return 405.

## 3. Technology Decisions

- Tauri v2 with `tauri-plugin-sql` registered for SQLite integration, but no raw SQL capability granted to the webview.
- SQLx `SqlitePool` is the application database API; use `query!` and `query_file!` for every query.
- `sqlx::migrate!()` applies numbered migrations at startup. Commit SQLx offline metadata and run `cargo sqlx prepare --check` in CI.
- SQLite uses WAL, foreign keys, a five-second busy timeout, and a bounded pool.
- `rdev` captures arbitrary global HID keyboard events on Windows; the global-shortcut plugin is not sufficient for a UID stream.
- Axum provides the embedded HTTP server; `tower-http` supplies timeout, request limits, and security headers.
- `tokio::sync::broadcast` carries post-commit attendance events to SSE clients.
- `rust-embed` embeds the separate LAN viewer bundle so production does not depend on a writable web directory.
- `google-sheets4` and `yup-oauth2` implement the write-only export worker.
- The `image` crate validates and transcodes JPEG/PNG/WebP photos to local WebP files.
- `chrono-tz` enforces `Asia/Manila` for all calendar calculations.

## 4. SQLite Schema and Migrations

Migrations live in `src-tauri/db/migrations/` and are numbered `0001_core.sql`, `0002_sync_queue.sql`, and `0003_seed_profiles.sql`. Monetary columns store integer centavos; DTOs and Sheets exports convert to PHP decimal numbers.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  user_id TEXT PRIMARY KEY NOT NULL,
  rfid_uid TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  department TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at TEXT NOT NULL,
  employee_type TEXT NOT NULL DEFAULT 'INTERN' CHECK (employee_type IN ('INTERN','EMPLOYEE')),
  daily_rate_centavos INTEGER,
  payroll_profile_id TEXT,
  photo_url TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at TEXT NOT NULL,
  CHECK ((employee_type = 'INTERN' AND daily_rate_centavos IS NULL) OR
         (employee_type = 'EMPLOYEE' AND daily_rate_centavos > 0))
) STRICT;

CREATE TABLE attendance (
  attendance_id TEXT PRIMARY KEY NOT NULL,
  attendance_date TEXT NOT NULL,
  user_id TEXT NOT NULL,
  rfid_uid TEXT NOT NULL,
  full_name TEXT NOT NULL,
  department TEXT,
  time_in TEXT,
  time_out TEXT,
  status TEXT NOT NULL CHECK (status IN ('OPEN','COMPLETED','INCOMPLETE')),
  source TEXT NOT NULL CHECK (source IN ('RFID','MANUAL_TEST')),
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'OPEN' AND time_in IS NOT NULL AND time_out IS NULL) OR
         (status = 'COMPLETED' AND time_in IS NOT NULL AND time_out IS NOT NULL) OR
         (status = 'INCOMPLETE' AND time_in IS NULL AND time_out IS NULL))
) STRICT;

CREATE UNIQUE INDEX ux_attendance_user_date ON attendance(user_id, attendance_date);
CREATE INDEX ix_attendance_date_status ON attendance(attendance_date, status);

CREATE TABLE audit_logs (
  log_id TEXT PRIMARY KEY NOT NULL,
  timestamp TEXT NOT NULL,
  event_type TEXT NOT NULL,
  rfid_uid TEXT,
  user_id TEXT,
  message TEXT NOT NULL,
  request_id TEXT NOT NULL
) STRICT;
CREATE INDEX ix_audit_request ON audit_logs(request_id);
CREATE INDEX ix_audit_timestamp ON audit_logs(timestamp);

CREATE TABLE intern_grace (
  grace_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  week_start TEXT NOT NULL,
  attendance_id TEXT NOT NULL UNIQUE,
  used_at TEXT NOT NULL,
  FOREIGN KEY (attendance_id) REFERENCES attendance(attendance_id) ON DELETE CASCADE
) STRICT;
CREATE UNIQUE INDEX ux_grace_user_week ON intern_grace(user_id, week_start);

CREATE TABLE payroll (
  payroll_id TEXT PRIMARY KEY NOT NULL,
  attendance_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  employee_type TEXT NOT NULL CHECK (employee_type IN ('INTERN','EMPLOYEE')),
  attendance_date TEXT NOT NULL,
  actual_time_in TEXT NOT NULL,
  actual_time_out TEXT NOT NULL,
  computed_time_in TEXT NOT NULL,
  computed_time_out TEXT NOT NULL,
  grace_used INTEGER CHECK (grace_used IS NULL OR grace_used IN (0,1)),
  late_hours INTEGER NOT NULL CHECK (late_hours >= 0),
  late_deduction_centavos INTEGER NOT NULL CHECK (late_deduction_centavos >= 0),
  base_pay_centavos INTEGER NOT NULL CHECK (base_pay_centavos >= 0),
  daily_pay_centavos INTEGER NOT NULL CHECK (daily_pay_centavos >= 0),
  notes TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (attendance_id) REFERENCES attendance(attendance_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX ix_payroll_attendance ON payroll(attendance_id);

CREATE TABLE payroll_profiles (
  profile_id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  payroll_frequency TEXT NOT NULL CHECK (payroll_frequency = 'SEMI_MONTHLY'),
  standard_working_days_per_cutoff REAL NOT NULL,
  incentives_allowance_centavos INTEGER NOT NULL,
  special_allowance_centavos INTEGER NOT NULL,
  special_holiday_multiplier REAL NOT NULL,
  regular_holiday_multiplier REAL NOT NULL,
  half_day_fraction REAL NOT NULL,
  overtime_rate_centavos INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE payroll_cutoffs (
  payroll_id TEXT PRIMARY KEY NOT NULL,
  employee_id TEXT NOT NULL,
  employee_name TEXT NOT NULL,
  payroll_profile_id TEXT NOT NULL,
  payroll_cutoff_label TEXT NOT NULL,
  cutoff_start TEXT NOT NULL,
  cutoff_end TEXT NOT NULL,
  payroll_frequency TEXT NOT NULL CHECK (payroll_frequency = 'SEMI_MONTHLY'),
  daily_rate_centavos INTEGER NOT NULL,
  standard_working_days REAL NOT NULL,
  actual_working_days REAL NOT NULL,
  basic_pay_centavos INTEGER NOT NULL,
  special_holiday_days REAL NOT NULL,
  special_holiday_multiplier REAL NOT NULL,
  special_holiday_pay_centavos INTEGER NOT NULL,
  regular_holiday_days REAL NOT NULL,
  regular_holiday_multiplier REAL NOT NULL,
  regular_holiday_pay_centavos INTEGER NOT NULL,
  incentives_allowance_centavos INTEGER NOT NULL,
  special_allowance_centavos INTEGER NOT NULL,
  total_compensation_centavos INTEGER NOT NULL,
  total_allowance_centavos INTEGER NOT NULL,
  late_units REAL NOT NULL,
  late_deduction_centavos INTEGER NOT NULL,
  half_day_count REAL NOT NULL,
  half_day_deduction_centavos INTEGER NOT NULL,
  absent_days REAL NOT NULL,
  absence_deduction_centavos INTEGER NOT NULL,
  overtime_hours REAL NOT NULL,
  overtime_rate_centavos INTEGER NOT NULL,
  overtime_pay_centavos INTEGER NOT NULL,
  manual_adjustment_centavos INTEGER NOT NULL DEFAULT 0,
  adjustment_reason TEXT,
  gross_compensation_centavos INTEGER NOT NULL,
  net_pay_centavos INTEGER NOT NULL,
  signature_placeholder TEXT NOT NULL DEFAULT '',
  calculation_breakdown TEXT NOT NULL CHECK (json_valid(calculation_breakdown)),
  approved_working_day_overage INTEGER NOT NULL CHECK (approved_working_day_overage IN (0,1)),
  status TEXT NOT NULL CHECK (status IN ('DRAFT','FINALIZED')),
  finalized_at TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (cutoff_start <= cutoff_end),
  CHECK (manual_adjustment_centavos = 0 OR length(trim(adjustment_reason)) > 0),
  CHECK (actual_working_days <= standard_working_days OR approved_working_day_overage = 1)
) STRICT;
CREATE UNIQUE INDEX ux_cutoff_employee_period ON payroll_cutoffs(employee_id, cutoff_start, cutoff_end);

CREATE TABLE sync_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('UPSERT','DELETE')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  last_error TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RETRY','PROCESSING','DEAD')),
  next_attempt_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  locked_at TEXT
) STRICT;
CREATE INDEX ix_sync_ready ON sync_queue(status, next_attempt_at, id);

CREATE TABLE sync_state (
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  last_synced_hash TEXT NOT NULL,
  sheet_row_number INTEGER,
  last_synced_at TEXT NOT NULL,
  PRIMARY KEY (table_name, row_id)
) STRICT;
```

Seed `JEAN_TENURED` with PHP 6,600 incentives, PHP 150 special allowance, 11 standard days, 0.3 special-holiday multiplier, 1.0 regular-holiday multiplier, 0.5 half-day fraction, and zero overtime. Seed `BEA_STANDARD` with the same formulas and zero allowances.

## 5. Tauri Command and LAN Contract Surface

Preserve the existing shared request/response shapes for scans, setup, users, attendance, payroll profiles, and cutoff payroll. Replace `fetch('/api/...')` with `invoke()` in `client/src/tauri-api.ts`.

Required Tauri commands include `get_config`, `get_health`, `scan_rfid`, `get_attendance`, `setup_unlock`, `setup_lock`, `setup_lookup_card`, `setup_upsert_user`, `upload_photo`, `admin_unlock`, `admin_get_session`, `admin_lock`, `admin_list_users`, `admin_create_user`, `admin_update_user`, `admin_delete_user`, `admin_list_attendance`, `admin_update_attendance`, `admin_delete_attendance`, `payroll_list_profiles`, `payroll_upsert_profile`, `payroll_list_cutoffs`, `payroll_create_cutoff`, `payroll_update_cutoff`, `payroll_finalize_cutoff`, `payroll_export_csv`, `admin_get_sync_status`, `admin_retry_sync_item`, and `admin_sync_now`.

Use an internal `AppError` enum with serialized public error codes. Keep the existing scan/setup/admin error codes; local database failures map to the existing typed internal/configuration responses. LAN errors are separate and never returned by local scan commands.

The LAN server adds these explicit DTOs:

```ts
export type LanAttendanceSnapshotResponse = {
  success: true;
  serverInstanceId: string;
  snapshotVersion: number;
  date: string;
  attendance: AttendanceListItem[];
  fetchedAt: string;
};

export type LanAttendanceEvent =
  | { type: 'attendance-updated'; eventId: string; serverInstanceId: string; sequence: number; occurredAt: string; requestId: string; attendanceDate: string; cause: 'TIME_IN' | 'TIME_OUT' | 'ADMIN_CORRECTION' | 'ADMIN_DELETE' | 'PAYROLL_RECONCILIATION'; mutation: 'upsert' | 'delete' | 'refetch'; attendanceId: string; attendance: AttendanceListItem | null }
  | { type: 'connection-status'; eventId: string; serverInstanceId: string; sequence: number; occurredAt: string; status: 'connected'; connectionId: string }
  | { type: 'stale-data'; eventId: string; serverInstanceId: string; sequence: number; occurredAt: string; reason: 'event-gap' | 'database-read-failed' | 'server-restarted'; shouldRefetch: true };

export type LanHealthResponse = {
  success: true;
  service: 'alpha-premier-attendance-lan';
  status: 'healthy' | 'degraded';
  serverInstanceId: string;
  timestamp: string;
  timezone: 'Asia/Manila';
  sqlite: 'connected' | 'unavailable';
  lan: { bindAddress: string; port: number; viewerMode: 'read-only'; connectedSseClients: number; uptimeSeconds: number };
  googleSheetsExport: 'connected' | 'offline' | 'disabled';
};
```

## 6. RFID Input and Live Event Mechanics

Extract the current inline scanner into `client/src/hooks/useRfidScanner.ts`. Preserve Enter detection, 150 ms idle fallback, 75 ms rapid-character detection, 4-64 hexadecimal validation, focus recovery, manual-mode protection, and the ten-second cooldown.

The Windows `rdev` listener runs on a dedicated thread. Both focused and global paths feed one coordinator. Coalesce identical normalized UIDs for 500 ms and return one shared result; the physical ten-second cooldown remains separate. Never log incomplete global keyboard buffers.

After a successful SQLite commit:

1. Emit a local Tauri event for kiosk/admin windows.
2. Publish an `attendance-updated` message to a `tokio::sync::broadcast` channel.
3. Let Axum convert the message to named SSE with `id`, `event`, `retry: 2000`, and JSON `data` fields.
4. Send a 15-second SSE keep-alive comment.

If a viewer disconnects, broadcasts lag, or no viewers are connected, the scan remains successful. A lagged SSE client receives `stale-data` and refetches the full snapshot.

The LAN browser fetches its initial snapshot, opens `EventSource`, applies matching-date upserts/deletes, refetches on `refetch` or `stale-data`, reconnects automatically, and starts five-second polling when SSE is unavailable. It keeps the last successful rows visible and marks the view stale after 15 seconds and offline after 30 seconds or three failed polls.

## 7. Attendance, Payroll, and Reconciliation Rules

Port the current rules as pure Rust functions and preserve the exact employee comment:

```rust
// TODO: Employee late rules TBD by client
```

- Compute the attendance date only from the Rust clock in `Asia/Manila`.
- Use one row per `(user_id, attendance_date)`: no row means Time In, open means Time Out, completed means already complete, inconsistent data means conflict.
- Intern official start is 08:00 Manila; late hours are ceiling hours; the first Monday-Sunday late claims one `intern_grace` row; later lates round computed Time In up and charge PHP 10 per late hour; daily pay floors at zero from PHP 80.
- Employee raw timestamps remain unchanged; computed Time In rounds up and computed Time Out rounds down; late hours and deductions remain zero pending client rules; base and daily pay use the employee daily rate.
- Payroll writes are idempotent by `attendance_id` and occur only after completed attendance.
- Admin corrections use expected timestamps/revisions and deterministically replay affected intern weeks.
- `JEAN_TENURED`, `BEA_STANDARD`, manual adjustments, approvals, finalization, CSV export, and PHP centavo rounding remain unchanged.

## 8. Google Sheets Sync

Sheets remains write-only from SQLite. Preserve these tabs and headers: `Users`, `Attendance`, `AuditLogs`, `InternGrace`, `Payroll`, `PayrollProfiles`, and `PayrollCutoffs`.

Every domain mutation, audit row, payroll row, grace claim, profile update, cutoff update, and delete is enqueued in the same SQLite transaction. A Tokio worker polls every 30 seconds, processes ordered batches of 100, retries with exponential backoff up to five attempts, and dead-letters failed items. SQLite wins conflicts: compare canonical row hashes, record a conflict audit, and overwrite the remote row. Dead-letter counts are visible locally; they are never exposed through the boss dashboard.

## 9. Photos, Sessions, and Security

Store photos under `{appLocalDataDir}/photos/{user_id}.webp`. Accept only JPEG/PNG/WebP, decoded input at most 500 KB, dimensions at most 512x512, and valid magic bytes. Transcode atomically to WebP and return a scoped `asset://` URL to Tauri windows. Do not expose the local photo directory through Axum.

Use in-memory `State<Mutex<AdminSession>>` for admin access and opaque expiring setup tokens for setup mode. Store Argon2id PIN hashes and the Google service-account secret in ACL-protected `config.toml`/config files. Never expose these values to the LAN browser.

LAN configuration is explicit:

```toml
[lan]
enabled = true
bind_address = "192.168.1.50"
port = 4173
allow_wildcard_bind = false
allowed_subnets = ["192.168.1.0/24"]
auth_mode = "password"
viewer_password_hash = "$argon2id$v=19$..."
viewer_session_minutes = 480
sse_keep_alive_seconds = 15
poll_fallback_seconds = 5
```

Reject public unicast binds. Reject wildcard binds unless explicitly enabled and constrained by `allowed_subnets`. Support `auth_mode = "none"` only when the operator explicitly chooses it. Password mode uses a rate-limited login and an opaque in-memory HttpOnly/SameSite viewer cookie. This HTTP gate is access control for a trusted LAN, not transport encryption.

Require a Windows Defender Firewall inbound rule for TCP 4173 on the Private profile and office subnet only. Do not create a public-profile rule, router port forward, UPnP mapping, public DNS record, or cloud tunnel.

## 10. Folder Structure

```text
client/src/
|- App.tsx
|- tauri-api.ts
|- hooks/useRfidScanner.ts
|- components/PhotoEnrollmentField.tsx
|- components/AttendanceTable.tsx
`- lan/
   |- main.tsx
   |- LanAttendanceApp.tsx
   |- lan-api.ts
   |- useAttendanceEvents.ts
   `- lan-styles.css

shared/src/
|- api-contracts.ts
`- lan-contracts.test.ts

src-tauri/
|- Cargo.toml
|- tauri.conf.json
|- capabilities/desktop.json
|- db/migrations/{0001_core.sql,0002_sync_queue.sql,0003_seed_profiles.sql}
`- src/
   |- main.rs
   |- lib.rs
   |- config.rs
   |- error.rs
   |- state.rs
   |- commands/{system,attendance,setup,admin,payroll,photo,sync}.rs
   |- models/{api,lan,attendance,payroll,sync}.rs
   |- services/{attendance,payroll,intern_payroll,employee_payroll,payroll_reconciliation,sheets_sync,photo_storage,attendance_notifications}.rs
   `- lan_server/{mod,routes,sse,auth,state,middleware,static_assets}.rs

docs/
|- lan-dashboard-deployment.md
|- lan-dashboard-troubleshooting.md
|- hardware-verification.md
|- payroll-operations.md
`- migration-cutover.md
```

The LAN viewer is a separate browser bundle and reuses `AttendanceListItem` and the shared LAN contracts. It never imports Tauri APIs.

## 11. Implementation Phases

### Phase 1 - Tauri scaffold, SQLite, migrations, and health

**Files:** Tauri crate, config/state/error modules, migrations, build scripts.

**Tasks:** Scaffold Tauri v2, register plugins, open SQLite, apply SQLx migrations, seed profiles, load config, and implement `get_health`/`get_config`.

**Definition of done:** `npm run tauri:dev`, `cargo test`, `cargo sqlx prepare --check`, and client builds pass; startup fails safely on invalid config/migrations.

**Manual tests:** Launch offline, restart with an existing database, and verify local health.

### Phase 2 - Atomic attendance state machine

**Files:** Attendance commands/service/repositories and integration tests.

**Tasks:** Port normalization, Manila dates, keyed locks, cooldown, conflict handling, audit IDs, and transactional scan writes.

**Definition of done:** Concurrent scans cannot duplicate rows; every accepted/rejected scan is audited; Sheets is not consulted.

**Manual tests:** Active, unknown, inactive, duplicate, completed, malformed, and Manila-midnight scans.

### Phase 3 - Intern payroll and grace

**Files:** `intern_payroll.rs`, payroll/grace repositories, reconciliation tests.

**Tasks:** Port weekly grace, late rounding, PHP 10 deductions, floor-at-zero, idempotent payroll, and atomic completion.

**Definition of done:** Existing intern tests and retry/concurrency tests pass.

**Manual tests:** First and later weekly lates, week reset, and payroll recovery.

### Phase 4 - Employee payroll and cutoff profiles

**Files:** Employee/cutoff services, payroll commands, CSV exporter.

**Tasks:** Preserve raw timestamps and the exact TODO comment; port both profiles, centavo arithmetic, finalization, adjustments, and CSV export.

**Definition of done:** Existing employee, cutoff, Jean, Bea, validation, and CSV tests pass.

**Manual tests:** Create/edit/finalize/export representative employee payroll.

### Phase 5 - Admin commands and reconciliation

**Files:** Admin services/commands/repositories and tests.

**Tasks:** Port user CRUD, attendance corrections, optimistic revisions, profile/cutoff CRUD, and deterministic intern-week replay.

**Definition of done:** Stale edits conflict; corrections synchronize payroll and grace; deleting users preserves history.

**Manual tests:** Edit users, correct/reopen/delete attendance, and replay a week.

### Phase 6 - Setup mode and photo authorization

**Files:** Setup/session/photo commands and tests.

**Tasks:** Port PIN unlock, opaque expiry tokens, enrollment/reconfiguration, local photo validation, and scoped asset URLs.

**Definition of done:** Setup is disabled by default; tokens expire/lock; normal scans cannot enroll; photos meet every limit.

**Manual tests:** Wrong/correct PIN, expiry, enrollment, reconfiguration, conflicts, and invalid photos.

### Phase 7 - Global RFID fallback

**Files:** `src-tauri/src/rfid/*`, scanner hook, parser/deduper tests.

**Tasks:** Add Windows `rdev`, Enter/idle buffering, focus-independent delivery, shared-result deduplication, and shutdown handling.

**Definition of done:** Focused and unfocused scans process once; human typing is discarded; hook failure does not stop focused scanning.

**Manual tests:** Real reader with/without Enter, minimized window, reconnect, and rapid typing.

### Phase 8 - Sheets async export

**Files:** Sync queue/service, Sheets adapter, status commands, tests.

**Tasks:** Add durable queue, exact header validation, batch worker, retry/dead-letter, hash conflicts, and operator status.

**Definition of done:** Offline scans queue locally and drain after reconnection within 30 seconds; SQLite wins conflicts.

**Manual tests:** Disconnect network, mutate Sheets externally, restore network, and inspect dead letters.

### Phase 9 - Client IPC migration

**Files:** `client/src/tauri-api.ts`, `App.tsx`, extracted components/hooks, invoke mocks.

**Tasks:** Replace every fetch call, preserve `/`, `/attendance`, `/admin`, preserve five-second local dashboard fallback, and keep setup/admin UX unchanged.

**Definition of done:** No application fetches `/api`; all client tests use mocked `invoke`; kiosk/admin workflows pass.

**Manual tests:** Run every kiosk, setup, admin, live, photo, payroll, print, and export workflow.

### Phase 10 - Browser-safe LAN viewer bundle

**Files:** `client/src/lan/*`, Vite multi-entry configuration, shared contracts.

**Tasks:** Build `/attendance` as a separate browser bundle using fetch/EventSource, snapshot rendering, incremental events, reconnect, polling, stale/offline states, and no Tauri imports.

**Definition of done:** Bundle contains no admin mutation UI or Tauri API dependency.

**Manual tests:** Open the bundle in a normal browser with the Axum server.

### Phase 11 - LAN Live Attendance Dashboard

**Objective:** Run the private read-only browser dashboard from the front-desk Tauri process.

**Files:** `src-tauri/src/lan_server/{mod,routes,sse,auth,state,middleware,static_assets}.rs`, `attendance_notifications.rs`, LAN DTOs, viewer client, docs, tests.

**Tasks:**

- Implement private-address validation, subnet filtering, optional password sessions, and response hardening.
- Implement `GET /attendance`, snapshot JSON, health JSON, and SSE.
- Publish post-commit events to both Tauri and SSE consumers.
- Add 15-second SSE keep-alives, lag-to-stale conversion, automatic reconnect, and five-second polling fallback.
- Supervise LAN startup/retry/shutdown without affecting RFID.
- Document DHCP reservation, firewall, connectivity, and latency verification.

**Definition of done:**

- [ ] Front-desk scan appears on boss PC within two seconds while connected.
- [ ] Browser reconnects after temporary network loss.
- [ ] Dashboard shows stale/offline state when laptop is unreachable.
- [ ] Unauthorized/public-network access is blocked.
- [ ] No admin/setup/payroll mutation route is reachable through Axum.
- [ ] Scanning continues when dashboard is offline or LAN server is stopped.
- [ ] Three simultaneous viewers receive consistent updates.

**Manual tests:** Real two-PC office test, disconnect/reconnect, wrong password, blocked subnet, Public firewall profile, server restart, port collision, and offline Sheets.

### Phase 12 - Windows NSIS packaging

**Files:** Tauri bundle config, icons, installer docs, firewall instructions.

**Tasks:** Build per-machine NSIS, preserve app data on upgrade, package the embedded viewer, document Private-profile firewall configuration, and never silently open a public port.

**Definition of done:** Clean install, upgrade, uninstall/data retention, offline launch, and viewer URL all work.

**Manual tests:** Windows 10/11 clean VM and the real front-desk laptop.

### Phase 13 - Acceptance, cutover, and handoff

**Files:** Migration, deployment, hardware, payroll, LAN troubleshooting, and operator documents.

**Tasks:** Execute migration, run one Tauri-primary pay period, compare Sheets, perform restore drills, collect LAN latency evidence, and retire the web writer.

**Definition of done:** All Section 12 acceptance checks pass and operator sign-off is recorded.

**Manual tests:** Full real-reader, two-PC, offline, recovery, payroll, photo, and backup/restore runbook.

## 12. Testing Strategy and Acceptance Checklist

### Automated tests

- [ ] Rust unit tests cover UID normalization, Manila dates, RFID parser timing, deduplication, intern payroll, employee payroll, cutoff payroll, centavo rounding, PIN/session expiry, photo validation, IP/subnet validation, and SSE serialization.
- [ ] `sqlx::test` integration tests use isolated migrated SQLite databases for attendance concurrency, payroll idempotency, grace reconciliation, optimistic conflicts, queue recovery, and delete cascades.
- [ ] `tauri::test` verifies command registration, DTO casing, authorization, and error serialization.
- [ ] Axum router tests verify all required routes, read-only methods, subnet denial, auth, headers, snapshot data, health, and missing admin paths.
- [ ] SSE tests verify connection status, attendance events, keep-alive, event gaps, stale-data, multiple clients, shutdown, and broadcast failure isolation.
- [ ] Client tests mock `invoke`, `fetch`, `EventSource`, visibility changes, polling, reconnect, stale/offline states, and asset URLs.

### Hardware and office acceptance

- [ ] Reader appears as Windows HID and emits the expected UID/Enter behavior.
- [ ] Focused and unfocused scans each process once.
- [ ] Time In, Time Out, cooldown, unknown/inactive, and payroll outcomes are correct.
- [ ] Boss browser opens the LAN URL without Tauri installation.
- [ ] A scan reaches the boss browser within two seconds for ten consecutive scans.
- [ ] SSE reconnects and polling fallback work after network interruption.
- [ ] Dashboard retains rows and marks stale/offline when the laptop is unreachable.
- [ ] Attendance continues while no viewer is connected.
- [ ] Public profile and non-office subnet access are blocked.
- [ ] Google and public internet disconnection do not stop local attendance or LAN viewing.
- [ ] Admin/setup/payroll are inaccessible from the LAN browser.
- [ ] SQLite/photo backup and restore succeed on a second Windows machine.

## 13. Migration, Deployment, and Future Work

### 13.1 Sheets migration

Export all seven tabs to CSV, run `npm run migrate:from-sheets -- --dry-run`, review duplicate IDs, dates, timestamps, payroll relationships, and photo URLs, then run `--execute`. Verify row counts, stable IDs, payroll calculations, photo conversions, and canonical hashes. The migration is transactional and never mutates Sheets.

### 13.2 Office deployment

Give the front-desk laptop a DHCP reservation such as `192.168.1.50`. Set Windows Network Profile to Private. Configure `allowed_subnets = ["192.168.1.0/24"]`. Allow TCP 4173 with a Private-profile, office-subnet-only Defender Firewall rule. From the boss PC run:

```powershell
Test-NetConnection -ComputerName 192.168.1.50 -Port 4173
Invoke-RestMethod http://192.168.1.50:4173/api/health
```

Then open `http://192.168.1.50:4173/attendance`. Verify one `text/event-stream` request and measure scan-to-display latency. Do not use router forwarding, UPnP, public DNS, or cloud tunnels.

### 13.3 Parallel cutover

Tauri is the only live writer for one pay period. Keep the old Vercel application read-only for comparison. Confirm zero unexplained discrepancies, zero dead-letter sync items, successful SQLite/photo restore, LAN latency evidence, and operator approval before disabling the web writer and revoking its credentials.

### 13.4 Explicit non-goals

- Public internet hosting and remote access outside the office LAN.
- Multi-writer or multi-master attendance deployment.
- Sharing SQLite over SMB.
- Browser-based admin, payroll editing, setup, photo enrollment, or attendance corrections.
- Auto-updater, statutory deductions, payroll approval workflow, and employee late rules.
- LAN delivery of photos, RFID UIDs, secrets, logs, or backups.

Future multi-PC work must use one authenticated Rust host with TLS and role-based APIs; it must not create independent SQLite writers. The front-desk laptop remains the single source of truth until that separate design is approved.
