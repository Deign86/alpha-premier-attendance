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

## Verification Log

| Check | Result |
| --- | --- |
| `npm test` | PASS: shared 4, client 10, server 25 tests |
| `npm run typecheck` | PASS |
| `cargo test --manifest-path src-tauri/Cargo.toml` | TIMEOUT at 120 seconds; requires a longer isolated run |
| Portable debug build | PASS: built via `cargo build --manifest-path src-tauri/Cargo.toml --bin alpha-premier-attendance` |
| Copy to Downloads | PASS: 40,050,688-byte executable created |
| Tauri MCP backend connection | PASS: app identified as `com.alphapremier.attendance` |
| Tauri MCP DOM/JS/screenshot | BLOCKED: WebView request timeouts |
| Tauri MCP IPC smoke | FAIL: registered commands reported unsupported |
