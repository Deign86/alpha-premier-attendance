# Alpha Premier Attendance QA Findings

Date: 2026-08-04
Source prompt: `C:\Users\Deign\Downloads\alpha-premier-qa-prompt.md`
Test artifact: `C:\Users\Deign\Downloads\alpha-premier-attendance-portable-debug.exe`

## Executive Summary

The supplied QA prompt cannot be executed faithfully against the current command contracts: its synthetic scan payloads omit the required manual-test source, its setup user fields use the wrong names and enum casing, and its attendance edit values are not RFC3339 timestamps. A live MCP pass also found a blocking packaged-app runtime failure: the native window opens, but the WebView does not answer DOM/JavaScript requests and Tauri IPC commands are reported unsupported.

The TypeScript/shared/server test suites passed, but `cargo test --manifest-path src-tauri/Cargo.toml` exceeded the 120-second command timeout and the live Tauri UI pass is blocked by the WebView failure.

## Findings

### BUG-001: Portable app opens with an unresponsive WebView and no usable IPC

- Severity: Critical
- Confidence: 95
- Category: Packaged runtime / startup
- Evidence: Tauri MCP backend state identified `Alpha Premier Attendance` v0.1.0 in debug mode; the main window was visible at 1296x839, but `webview_dom_snapshot`, `webview_execute_js`, `webview_screenshot`, and console-log capture all timed out.
- Reproduction:
  1. Launch `alpha-premier-attendance-portable-debug.exe` from Downloads.
  2. Connect Tauri MCP on `127.0.0.1:9223`.
  3. Request a DOM snapshot or execute `document.body.innerText`.
  4. Invoke `get_health` or `get_config`.
- Actual: WebView requests time out after 2-5 seconds; IPC returns `Unsupported Tauri command: get_health` and `Unsupported Tauri command: get_config`; no IPC traffic is captured.
- Expected: The kiosk HTML loads, MCP can inspect it, and registered commands return JSON.
- Likely investigation: verify WebView2 availability and startup logs; confirm the binary launched is the Tauri desktop binary; inspect whether setup blocks before the webview is ready; add a startup readiness signal and a smoke test for `get_config`.
- Fix test: launch the packaged executable in CI/manual QA, wait for `document.readyState === 'complete'`, assert the kiosk heading exists, then invoke `get_health`.

### BUG-002: QA prompt scan examples omit `source: 'MANUAL_TEST'`

- Severity: Important
- Confidence: 100
- Category: QA prompt contract mismatch
- Evidence: `src-tauri/src/lib.rs:1051-1064` defaults source to `RFID`; non-manual RFID UIDs must be 4-64 ASCII hex characters. The prompt uses values such as `UID_TEST_001`, which contain underscores and are therefore rejected as `INVALID_SCAN_INPUT`.
- Reproduction: Invoke `scan_rfid` with `{ request: { rfidUid: 'UID_TEST_001' } }`.
- Actual: The UID fails RFID validation before user lookup.
- Expected: Synthetic prompt cards reach the registered-user flow.
- Fix: Change every synthetic invocation to `{ rfidUid: 'UID_TEST_001', source: 'MANUAL_TEST' }`, or use valid hex-only UIDs and register those values.

### BUG-003: Setup user payload in the prompt cannot create users

- Severity: Important
- Confidence: 100
- Category: QA prompt contract mismatch
- Evidence: `src-tauri/src/lib.rs:699-705` delegates setup to `admin_upsert_user`; `src-tauri/src/lib.rs:197-245` requires `userId`, `rfidUid`, `fullName`, status `ACTIVE|INACTIVE`, and employee type `INTERN|EMPLOYEE`. The prompt sends `name`, lowercase `employmentType`, lowercase values, and no `userId` or status.
- Reproduction: Run either Phase 1 `setup_upsert_user` payload unchanged.
- Actual: `ADMIN_VALIDATION_ERROR` or a failed insert.
- Expected: The two test users are created.
- Fix: Use explicit payloads with unique `userId`, `fullName`, `status: 'ACTIVE'`, `employeeType: 'EMPLOYEE'|'INTERN'`, `dailyRate`, and `payrollProfileId`.

### BUG-004: Duplicate-scan test uses an unregistered card and cannot verify deduplication

- Severity: Important
- Confidence: 100
- Category: QA test design
- Evidence: The prompt registers only `UID_TEST_001` and `UID_TEST_002`, but Phase 3.3 fires `UID_TEST_DUPE`. The backend looks up the user before a successful attendance write, so an unregistered duplicate produces rejection responses and zero records rather than a one-record deduplication case.
- Reproduction: Fire two `scan_rfid` calls for `UID_TEST_DUPE` without first registering the UID.
- Actual: `UNKNOWN_RFID_CARD`; no attendance row exists to count.
- Expected: One legitimate row and one duplicate rejection.
- Fix: Register `UID_TEST_DUPE` during setup, then assert one successful response, one `DUPLICATE_SCAN` response, and one attendance row.

### BUG-005: Manual attendance edit example uses invalid timestamp values

- Severity: Important
- Confidence: 100
- Category: QA prompt contract mismatch
- Evidence: `src-tauri/src/lib.rs:214-224` parses `timeIn` and `timeOut` using RFC3339; the prompt sends `'08:00'` and `'17:00'`.
- Reproduction: Call `adminUpdateAttendance(token, id, { timeIn: '08:00', timeOut: '17:00' })`.
- Actual: `ADMIN_VALIDATION_ERROR`.
- Expected: The attendance record is updated.
- Fix: Send full Manila timestamps such as `2026-08-04T08:00:00+08:00` and `2026-08-04T17:00:00+08:00`, plus the attendance date when moving dates.

### BUG-006: Photo limit is documented as 500 KB but implemented as 5 MB

- Severity: Important
- Confidence: 100
- Category: Product behavior / validation
- Evidence: README states 500 KB; `client/src/App.tsx:261` accepts files up to 5,000,000 bytes, `client/src/App.tsx:563-567` accepts compressed data up to approximately 4.5 MB, and `src-tauri/src/lib.rs:1325-1343` accepts 5 MB. The UI error text still says 500 KB.
- Reproduction: Upload a valid JPEG between 500 KB and 5 MB.
- Actual: The client and backend may accept it.
- Expected: Behavior must match the documented 500 KB limit, or the documentation/UI must be changed to 5 MB.
- Fix: Choose one canonical limit, expose it through shared configuration, enforce it in both client and Rust, and add boundary tests at limit-1, limit, and limit+1.

### BUG-007: `npm run tauri:dev` cannot select the desktop binary

- Severity: Important
- Confidence: 100
- Category: Developer/runtime launch configuration
- Evidence: `npm run tauri:dev` builds the client, then fails with `cargo run could not determine which binary to run`; Cargo lists `alpha-premier-attendance` and `migrate_from_sheets`.
- Reproduction: Run `npm run tauri:dev` from the repository root.
- Actual: The app does not launch unless the binary is selected explicitly.
- Expected: The documented development command launches the Tauri app.
- Fix: Add `default-run = "alpha-premier-attendance"` to `src-tauri/Cargo.toml`, or update the script to pass `--bin alpha-premier-attendance`, then add a launch smoke test.

## Prompt Corrections Required Before Full QA

1. Add `source: 'MANUAL_TEST'` to all synthetic scans.
2. Register `UID_TEST_DUPE` before testing duplicate behavior.
3. Replace setup fields with the current camelCase contract and uppercase enum values.
4. Use RFC3339 timestamps for manual attendance edits.
5. Replace the phrase “seeded test UIDs” with “test UIDs created during Phase 1”; the current migrations seed payroll profiles only.
6. Record the actual response body and error code for every IPC call, not only the visual result.
7. Treat the Tauri WebView readiness check as a gate: do not start Phases 1-7 if the kiosk DOM or `get_config` smoke call is unavailable.

## Systematic Fix Order

1. Fix the packaged startup/WebView path and add a Tauri smoke test for DOM readiness plus `get_config`.
2. Publish one shared IPC contract used by the prompt, `client/src/tauri-api.ts`, and Rust command tests.
3. Correct the QA fixtures and setup phase, including unique cleanup IDs and the manual-test source.
4. Resolve the photo-size decision and enforce it consistently.
5. Add end-to-end tests for scan lifecycle, duplicate concurrency, admin timestamp validation, photo boundaries, export generation, and finalization.
6. Re-run the complete QA prompt only after the Phase 0 gate passes.

## Live Tauri UI Session Findings (2026-08-04, second pass)

Second QA session against the running `tauri dev` app (bridge `127.0.0.1:9223`, SPA served at `http://127.0.0.1:1887/`). Default admin PIN `293906`. Live SQLite at `C:\Users\Deign\AppData\Local\com.alphapremier.attendance\attendance.db`.

### BUG-008 (P1): Payroll cutoff creation always fails in the Tauri app

- Severity: Critical
- Confidence: 98
- Category: Tauri payroll command contract
- Evidence: Filled the admin Payroll form (employee QA-EMP-001, cutoff 2026-08-01..2026-08-15, name "Ma'am Bea") and clicked Save. Console: `[ERROR][MCP][BRIDGE][UNHANDLED_REJECTION] Employee and valid cutoff dates are required.` No `payroll_cutoffs` row was created.
- Root cause: `PayrollForm` sends no `employeeName`/`dailyRate` (App.tsx:628,656). `cutoff_input` (lib.rs:597-619) falls back to `""`/`0.0`, and `calculate` (cutoff_payroll.rs:34) rejects with `Employee and valid cutoff dates are required.`
- Contrast: the retained web path (server/src/admin.ts:142-143) enriches the payload with `employeeName`/`dailyRate` server-side before calling `calculate`; the Tauri `payroll_create_cutoff` command (lib.rs:436) performs no DB user lookup.
- Fix: in `payroll_create_cutoff`, look up `full_name`/`daily_rate_centavos` from `users` when `employeeName`/`dailyRate` are absent (mirror the web path), or require and validate them client-side. Add a Rust integration test for a valid cutoff creation.

### BUG-009 (P2): Payroll Save button freezes permanently on error

- Severity: High
- Confidence: 97
- Category: UI error handling
- Evidence: After the failed save, the Save button stayed at `Saving... [disabled]` indefinitely (snapshot at 3+ minutes post-failure).
- Root cause: `save()` (App.tsx:656) has no `try/catch`/`finally`; a rejected promise skips `setSaving(false)`, leaving the button stuck.
- Fix: wrap the save in `try/finally` (or `.finally(() => setSaving(false))`), and surface the backend error message to the user instead of an unhandled rejection.

### BUG-010 (P3): Export CSV is broken in the Tauri app

- Severity: Medium
- Confidence: 95
- Category: Export wiring
- Evidence: App.tsx:659 renders Export CSV as a plain `<a href="/api/admin/payroll/export">`. The LAN router (lan_server.rs:49-55) exposes only `/attendance`, `/api/attendance/today`, `/api/events/attendance`, `/api/health` — there is no `/api/admin/*`. Live navigation to that URL returned the SPA `index.html` (200, `text/html`), not a CSV.
- Root cause: the anchor bypasses the Tauri command layer entirely. A working-but-unused path exists: `tauriApi.payrollExportCsv` (tauri-api.ts:30) → `payroll_export_csv` (lib.rs:570).
- Fix: replace the anchor with a button calling `payrollExportCsv`, or register a `GET /api/admin/payroll/export` handler on the LAN server (it is admin-protected data; prefer the invoke path). Export Excel and Register PDF already use `invoke` and generate correct artifacts.

### FINDING-011 (LAN): Dashboard is disabled out of the box; SPA live view works

- Severity: Medium (configuration/documentation gap)
- Confidence: 98
- Evidence: `LanConfig::load` (config.rs:55-58) returns defaults (`enabled: false`, port 4173) when no `config.toml` exists; the app config dir `C:\Users\Deign\AppData\Roaming\com.alphapremier.attendance` is empty, so `lan_server.rs:58` early-returns and the LAN server never binds. Port 4173 confirmed unreachable via `Invoke-WebRequest`. The SPA `/attendance` live view is served by the Tauri webview (port 1887 dev / custom protocol in prod), shows today's snapshot, and polls every five seconds.
- Fix: ship a default `config.toml` in the installer or document the required post-install copy step (README already documents it); add a startup log line indicating LAN disabled.

### VERIFIED-012: Manual UID attendance flow works end-to-end

- Severity: n/a (pass)
- Confidence: 97
- Evidence: (1) 18:46-18:47 manual scans of UID_TEST_001 reached the backend (`SCAN_RECEIVED` in audit_logs, source `MANUAL_TEST`) and were correctly rejected with `ATTENDANCE_ALREADY_COMPLETED` because QA-EMP-001 finished earlier. (2) Direct `invoke('scan_rfid', {request:{rfidUid:'UID_TEST_DUPE',source:'MANUAL_TEST'}})` returned `TIME_OUT` success and logged `SCAN_SUCCESS`; the OPEN attendance record flipped to `COMPLETED` with time_out `2026-08-04T18:55:12+08:00`; `ensure_payroll` auto-created a payroll row (base_pay 50000). (3) The 18:52/18:54 UI-button failures ("Unable to reach the attendance service") occurred only after a CDP-forced page reload disturbed the bridge; direct invoke and the pre-reload button path both worked, so this is a test-harness artifact, not an app defect.

### VERIFIED-013: Payroll auto-generation on scan TIME_OUT

- Severity: n/a (pass)
- Confidence: 95
- Evidence: both completed attendance rows (QA-EMP-001, QA-DUPE-003) have matching `payroll` rows with `late_hours = 0`, `base_pay_centavos = daily_pay_centavos = 50000`, `notes = ''`. The `payroll_cutoffs` table remains empty (0 rows) because admin cutoff creation is blocked by BUG-008.

### VERIFIED-014: UI/UX sweep — responsive, wording, admin tabs

- Severity: n/a (pass)
- Confidence: 96
- Evidence:
  - Mobile layout (CDP resize 390x844 → rendered 500x844): kiosk `/` shows 0px horizontal overflow (content 485px vs viewport 485px, `scrollWidth === clientWidth`), heading "Tap your card to begin" at 48px. Live view `/attendance` also 0px overflow (500px vs 500px) and shows the "No attendance has been recorded today" empty state. Admin grid, tables, and empty-state styles exist for all three tabs.
  - Wording: `grep Mam|Ma'am|morning|afternoon|evening` across all `*.tsx` returns **no matches** — there is no informal/incorrect greeting text anywhere in the client; no wording fix needed.
  - Admin tab structure confirmed in code (App.tsx:598,613): `Users and RFID` / `Attendance corrections` (AdminAttendance) / `Payroll` (PayrollWorkspace) — all three tabs present and wired.
  - Printer path present: `window.print()` on "Print payroll report" (App.tsx:659) with `print-hidden` / `payroll-print` classes for clean output; payslip per-record button in PayrollTable.

### VERIFIED-015: Post-reload admin SyntaxError is a test-harness artifact, not an app bug

- Severity: n/a (pass / triage)
- Confidence: 90
- Evidence: After a CDP-forced page reload, clicking "Unlock admin" produced `Uncaught (in promise) SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON` in the console. Root cause: the CDP-navigated page at `http://127.0.0.1:1887/` has **no** `__TAURI_INTERNALS__` (`{'hasInternals':false,'hasGlobalTauri':false}`), so `runningInTauri()` (api.ts:24) returns false and the client falls back to `fetch('/api/admin/unlock')` — a route the LAN router does not expose, so the SPA `index.html` is returned and JSON.parse fails. The genuine Tauri webview (verified via `tauri_webview_execute_js`: `{'hasCore':true,'hasInternals':true}`) keeps the IPC bridge intact, and the first-pass admin unlock through the same UI succeeded via `tauriApi.setupUnlock`. The web-fallback fetch path is only reachable when the SPA is served without Tauri injection (legacy web deployment), where `server/` provides the matching routes.
- Conclusion: no code change required for the Tauri app; do not treat this console error as a regression.

### VERIFIED-016: Payroll profiles load correctly in the Tauri app

- Severity: n/a (pass)
- Confidence: 96
- Evidence: `setup_unlock(293906)` succeeded and `payroll_list_profiles` returned both seeded profiles: `BEA_STANDARD` ("Ma'am Bea payroll calculation", SEMI_MONTHLY, 11 standard days, specialHolidayMultiplier 0.3, regularHolidayMultiplier 1, halfDayFraction 0.5) and `JEAN_TENURED` ("Ma'am Jean payroll calculation", SEMI_MONTHLY, 11 days, incentivesAllowance 6600, specialAllowance 150). Matches the migration seed data. The admin UI profile toggles render from these.
- Implication: the profile half of payroll is healthy; only cutoff creation (BUG-008) blocks the payroll workflow.

### VERIFIED-017: Photo upload works end-to-end in the Tauri app

- Severity: n/a (pass)
- Confidence: 97
- Evidence: `upload_photo(token, 'QA-EMP-001', <34-byte webp base64>)` returned `{success:true, photoUrl:'asset://localhost/C:/Users/Deign/AppData/Local/com.alphapremier.attendance/photos/QA-EMP-001.webp'}` and the file was written to disk (34 bytes, 2026-08-04 19:08:24). The `asset://` local URL is never served through the LAN dashboard, matching README security claims.
- Implication: photo upload plumbing works; the only photo issue remains the BUG-006 500 KB vs 5 MB limit mismatch.

## Verification Log

| Check | Result |
| --- | --- |
| `npm test` | PASS: shared 4, client 10, server 25 tests |
| `npm run typecheck` | PASS |
| `cargo test --manifest-path src-tauri/Cargo.toml` | TIMEOUT at 120 seconds; requires a longer isolated run |
| Portable debug build | PASS: built via `cargo build --manifest-path src-tauri/Cargo.toml --bin alpha-premier-attendance` |
| Copy to Downloads | PASS: 40,050,688-byte executable created |
| Tauri MCP backend connection | PASS: app identified as `com.alphapremier.attendance` |
| Tauri MCP DOM/JS/screenshot | BLOCKED: WebView request timeouts (first pass) |
| Tauri MCP IPC smoke | FAIL: registered commands reported unsupported (first pass) |
| Live Tauri UI session (second pass) | PASS: bridge connected, kiosk DOM inspectable, admin unlocked with PIN 293906, admin nav/Users tab working |
| Payroll form save (live) | FAIL: BUG-008/P1 `Employee and valid cutoff dates are required.` + BUG-009/P2 button freeze |
| Payroll Export CSV (live) | FAIL: BUG-010/P3 returns SPA index.html, no CSV |
| Payroll Export Excel + Register PDF (live) | PASS: generated artifacts (0-row) |
| Manual UID scan (live, direct invoke) | PASS: TIME_OUT recorded, SCAN_SUCCESS logged, payroll row auto-created |
| LAN dashboard (live) | DISABLED out of the box (FINDING-011): port 4173 unreachable, no config.toml |
| Mobile responsive sweep (live) | PASS: kiosk + live view 0px horizontal overflow at 500px viewport; empty states render (VERIFIED-014) |
| Wording sweep (code) | PASS: no greeting/informal text (Mam/Ma'am) in any client component (VERIFIED-014) |
| Post-reload admin unlock (live) | TRIAGED as harness artifact: CDP page lacks `__TAURI_INTERNALS__`, falls back to broken web fetch; genuine Tauri webview unlock works (VERIFIED-015) |
| Payroll profiles (live, direct invoke) | PASS: BEA_STANDARD + JEAN_TENURED returned, matches migrations (VERIFIED-016) |
| Photo upload (live, direct invoke) | PASS: 34-byte webp written to `photos/QA-EMP-001.webp`, asset:// URL returned (VERIFIED-017) |
| Live config (direct invoke) | PASS: `get_config` returns `lanEnabled:false, timezone:Asia/Manila` — FINDING-011 reconfirmed |

## Second-Pass Summary Table

| ID | Area | Verdict | Confidence |
| --- | --- | --- | --- |
| BUG-008 | Payroll cutoff creation always fails (missing employeeName/dailyRate; no DB lookup in Tauri command) | FAIL — Critical | 98 |
| BUG-009 | Payroll Save button freezes permanently (no try/finally) | FAIL — High | 97 |
| BUG-010 | Export CSV anchor returns SPA HTML (no LAN `/api/admin/*` route) | FAIL — Medium | 95 |
| FINDING-011 | LAN dashboard disabled out of the box (no config.toml) | GAP | 98 |
| VERIFIED-012 | Manual UID flow works end-to-end | PASS | 97 |
| VERIFIED-013 | Payroll auto-generation on scan TIME_OUT | PASS | 95 |
| VERIFIED-014 | UI/UX sweep: responsive, wording, admin tabs, printer path | PASS | 96 |
| VERIFIED-015 | Post-reload admin SyntaxError = harness artifact, not a bug | TRIAGE | 90 |
| VERIFIED-016 | Payroll profiles load correctly (BEA_STANDARD, JEAN_TENURED) | PASS | 96 |
| VERIFIED-017 | Photo upload works end-to-end (asset:// local storage) | PASS | 97 |
