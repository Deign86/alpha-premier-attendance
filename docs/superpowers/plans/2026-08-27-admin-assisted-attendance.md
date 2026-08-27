# Admin-Assisted Attendance and Backdated Manual Entry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver end-to-end "Admin-Assisted Attendance" capabilities:
1. **Admin RFID Card (Same-Day Live Assist)** on the kiosk for employees who physically arrived but forgot their card.
2. **Backdated Manual Time-In (Past-Date Missed Attendance)** in the PIN-protected Admin panel for dates where no record exists.
3. **Card Registration Evolution** supporting both employee and dedicated admin-assist cards.
4. **Shared Audit-Trail Design** with visual badges, filter pills, and export visibility.

**Architecture:**
- **Shared Contracts (`@rfid-attendance/shared`)**: Expand `ScanSource` to include `'ADMIN_ASSISTED_SCAN'` and `'ADMIN_BACKDATED_ENTRY'`. Introduce `CardType` (`'EMPLOYEE' | 'ADMIN_ASSIST'`). Add error codes `ADMIN_CARD_REQUIRES_SELECTION`, `ATTENDANCE_ALREADY_EXISTS_FOR_DATE`, `BACKDATE_LIMIT_EXCEEDED`. Add audit fields `recordedBy`, `recordedReason`, `recordedAt` on attendance models.
- **Database (`src-tauri/db/migrations/0010_admin_assist_and_audit.sql`)**: Add `card_type` to `users`, add `recorded_by`, `recorded_reason`, `recorded_at` to `attendance`, and add SQLite database triggers forbidding admin cards from recording attendance for themselves.
- **Backend Services (`server/src` & `src-tauri/src`)**: Detect admin card tap and return assist mode; process assisted scans on behalf of selected active employees; create backdated past attendance with duplicate & locked cutoff validation.
- **Frontend Kiosk & Admin Panel (`client/src`)**: Kiosk Assisted Attendance modal with searchable active employee list, reason selection, and 25s cancel timeout. Admin panel "Add missed attendance" dialog, audit badging, override filter pills, and updated exports.

**Tech Stack:** TypeScript, React 18, Rust 2021, Tauri 2, SQLite / SQLx, Vitest, Testing Library.

---

### Task 1: Shared Domain Contracts, Error Codes, and Database Migration

**Files:**
- Modify: `shared/src/api-contracts.ts`
- Modify: `shared/src/api-contracts.test.ts`
- Modify: `server/src/errors.ts`
- Modify: `server/src/sheets.ts`
- Create: `src-tauri/db/migrations/0010_admin_assist_and_audit.sql`
- Modify: `src-tauri/src/state.rs` (if test assertions need migration version check)

- [x] **Step 1: Write failing shared contract tests**
  Add unit tests in `shared/src/api-contracts.test.ts` verifying:
  - `cardTypes` includes `'EMPLOYEE'` and `'ADMIN_ASSIST'`.
  - `scanSources` includes `'RFID'`, `'MANUAL_TEST'`, `'ADMIN_ASSISTED_SCAN'`, `'ADMIN_BACKDATED_ENTRY'`.
  - `scanErrorCodes` and `adminErrorCodes` include `ADMIN_CARD_REQUIRES_SELECTION`, `ATTENDANCE_ALREADY_EXISTS_FOR_DATE`, `BACKDATE_LIMIT_EXCEEDED`.
  - `AttendanceSummary` and `AttendanceListItem` include optional audit fields (`recordedBy`, `recordedReason`, `recordedAt`).
  - `SetupUser` and `SetupUpsertRequest` include `cardType`.

- [x] **Step 2: Run focused shared tests and confirm RED**
  CHECK: `npm test -w shared`
  EXPECT: FAIL on missing constants and types.

- [x] **Step 3: Implement shared contracts, error types, and SQLite migration 0010**
  1. Update `shared/src/api-contracts.ts` with `cardTypes`, new `scanSources`, error codes, and audit properties.
  2. Update `server/src/errors.ts` with the new error codes in `scanErrorCodeSet`.
  3. Update `server/src/sheets.ts` with `cardType` on `SheetUser`, audit fields on `SheetAttendance`, and values mapping.
  4. Create `src-tauri/db/migrations/0010_admin_assist_and_audit.sql` adding `card_type` to `users`, audit columns to `attendance`, and SQLite triggers preventing admin card attendance writes.

- [x] **Step 4: Run shared tests and Rust migration tests and confirm GREEN**
  CHECK: `npm test -w shared && cargo test --manifest-path src-tauri/Cargo.toml state::tests::migrations_create_required_indexes_and_queue`
  EXPECT: all tests pass.
  EVIDENCE: Migration compiles and applies; contract tests pass.

---

### Task 2: Card Registration Flow — Employee vs Admin RFID Card

**Files:**
- Modify: `server/src/setup.ts`
- Modify: `server/src/admin.ts`
- Modify: `server/test/setup.test.ts`
- Modify: `server/test/admin.test.ts`
- Modify: `src-tauri/src/lib.rs`
- Modify: `client/src/App.tsx`
- Modify: `client/src/App.test.tsx`
- Modify: `docs/card-registration.md`

- [x] **Step 1: Write failing card registration tests**
  1. In `server/test/setup.test.ts`: Test registering an `ADMIN_ASSIST` card without employee name, verifying it saves with `cardType: 'ADMIN_ASSIST'`, `status: 'ACTIVE'`, and appropriate default name/id.
  2. In `server/test/admin.test.ts`: Test that the same RFID cannot be registered as an employee if already assigned to an admin card, and test listing admin cards with `cardType`.
  3. In `client/src/App.test.tsx`: Test that `SetupDialog` renders "Register card as:" with "Employee card" and "Admin RFID card" options; switching to "Admin RFID card" reveals the label field and hides employee-only fields (department, daily rate, photo).

- [x] **Step 2: Run focused setup and client tests and confirm RED**
  CHECK: `npm test -w server -- test/setup.test.ts && npm test -w client -- App.test.tsx`
  EXPECT: FAIL because `cardType` handling is not implemented.

- [x] **Step 3: Implement card registration and admin user management**
  1. `server/src/setup.ts` & `server/src/admin.ts`: Support `cardType === 'ADMIN_ASSIST'`. Handle auto-generating `userId = 'ADMIN_CARD_' + uid` and default label if not supplied. Validate UID conflict across all cards.
  2. `src-tauri/src/lib.rs`: Update `admin_upsert_user` and `upsert_user_record` to persist `card_type`.
  3. `client/src/App.tsx`:
     - In `SetupDialog`, add segmented control `Register card as:` ("Employee card" / "Admin RFID card"). If "Admin RFID card" is selected, render UID and Card Label input; hide employee-specific inputs.
     - In `UserEditor` (Admin panel "Users and RFID"), display badge `<span className="badge badge-admin-card">Admin card</span>` and provide revocation action.
  4. Update `docs/card-registration.md` documenting both employee and admin card registration.

- [x] **Step 4: Run focused setup and client tests and confirm GREEN**
  CHECK: `npm test -w server -- test/setup.test.ts && npm test -w client -- App.test.tsx`
  EXPECT: all card registration tests pass.
  EVIDENCE: Tests pass showing radio switch, field toggling, and backend storage.

---

### Task 3: Backend Attendance Engine — Admin Assist & Backdated Attendance

**Files:**
- Modify: `server/src/attendance.ts`
- Modify: `server/src/admin.ts`
- Modify: `server/test/attendance.test.ts`
- Modify: `server/test/admin.test.ts`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing backend attendance tests**
  1. In `server/test/attendance.test.ts`:
     - Test tapping an `ADMIN_ASSIST` card without target returns `action: 'ADMIN_ASSIST'` and active employee candidates, without writing attendance.
     - Test tapping an `ADMIN_ASSIST` card with `targetUserId` writes `TIME_IN` or `TIME_OUT` for the target employee with `source: 'ADMIN_ASSISTED_SCAN'`, `recordedBy`, `recordedReason`, `recordedAt`.
     - Test that attempting to record attendance directly for the admin card or selecting an inactive target fails with appropriate error codes.
  2. In `server/test/admin.test.ts`:
     - Test adding missed backdated attendance for a past date creates the record with `source: 'ADMIN_BACKDATED_ENTRY'`.
     - Test that backdating for today or future date is rejected.
     - Test that backdating when an attendance row already exists for that user and date is rejected with `ATTENDANCE_ALREADY_EXISTS_FOR_DATE`.
     - Test that backdating inside a finalized cutoff is rejected with `BACKDATE_LIMIT_EXCEEDED`.
     - Test that backdated attendance without a reason is rejected.

- [x] **Step 2: Run focused server attendance tests and confirm RED**
  CHECK: `npm test -w server -- test/attendance.test.ts test/admin.test.ts`
  EXPECT: FAIL on unhandled admin assist and backdated endpoints.

- [x] **Step 3: Implement backend attendance logic in TypeScript and Rust**
  1. `server/src/attendance.ts`:
     - In `scan()`: Check `user.cardType === 'ADMIN_ASSIST'`. If `!request.targetUserId`, return `{ success: true, action: 'ADMIN_ASSIST', adminCard: { rfidUid, label: user.fullName }, activeEmployees }`.
     - If `request.targetUserId`, load target employee (verify `active === true` and `cardType !== 'ADMIN_ASSIST'`). Execute `TIME_IN` or `TIME_OUT` for target user for today with `source: 'ADMIN_ASSISTED_SCAN'` and audit metadata.
  2. `server/src/admin.ts`:
     - Add `createBackdatedAttendance(input)`: validate `attendanceDate < todayManila`, check no duplicate attendance row, check no overlap with `status === 'FINALIZED'` cutoffs, validate times and non-empty reason, save with `source: 'ADMIN_BACKDATED_ENTRY'`, run payroll if complete shift, log audit event.
  3. Mount Express routes in `server/src/app.ts` (`POST /api/admin/attendance/backdate`).
  4. Implement equivalent logic in `src-tauri/src/lib.rs` for `scan_rfid` and `admin_create_backdated_attendance`.

- [x] **Step 4: Run focused server and Rust tests and confirm GREEN**
  CHECK: `npm test -w server -- test/attendance.test.ts test/admin.test.ts && cargo test --manifest-path src-tauri/Cargo.toml`
  EXPECT: all tests pass.
  EVIDENCE: Both server and Tauri commands handle assist scans and backdated creations correctly.

---

### Task 4: Kiosk Assisted Attendance UI & Timeout

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/styles.css`
- Modify: `client/src/api.ts`
- Modify: `client/src/tauri-api.ts`
- Modify: `client/src/App.test.tsx`

- [x] **Step 1: Write failing kiosk assist UI tests**
  In `client/src/App.test.tsx`:
  - When scanning an Admin RFID card, kiosk enters Assisted Attendance mode and opens the modal.
  - Search input filters the active employee list.
  - Selecting an employee and confirming sends `submitScan` with `source: 'ADMIN_ASSISTED_SCAN'`, `targetUserId`, and reason.
  - Success renders employee photo and greeting.
  - If no interaction occurs within 25 seconds, the modal cancels and returns to the greeting screen.

- [x] **Step 2: Run focused client test and confirm RED**
  CHECK: `npm test -w client -- App.test.tsx`
  EXPECT: FAIL because Assisted Attendance modal and timeout are not present.

- [x] **Step 3: Implement Kiosk Assisted Attendance modal & timeout**
  1. In `client/src/App.tsx`:
     - Handle `response.action === 'ADMIN_ASSIST'` in `submit()`.
     - Create `AssistedAttendanceModal` with:
       * Admin card banner.
       * Searchable employee picker (search by name, department, ID).
       * Reason dropdown (default: `"Forgot RFID card"`).
       * "Confirm attendance" and "Cancel" buttons.
       * 25-second idle countdown timer returning to ready.
     - On confirmation, invoke `submitScan` with `{ rfidUid: adminCard.rfidUid, source: 'ADMIN_ASSISTED_SCAN', targetUserId, reason }`.
  2. In `client/src/styles.css`: Add styles for `assisted-attendance-modal`, employee search items, and badge styling.

- [x] **Step 4: Run focused client test and confirm GREEN**
  CHECK: `npm test -w client -- App.test.tsx`
  EXPECT: all kiosk assist tests pass.
  EVIDENCE: Kiosk assist flow, filtering, submit, and idle reset verified.

---

### Task 5: Admin Panel Backdated Attendance Action, Audit Badging & Filtering

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/api.ts`
- Modify: `client/src/tauri-api.ts`
- Modify: `client/src/styles.css`
- Modify: `client/src/App.test.tsx`

- [x] **Step 1: Write failing admin backdate and audit tests**
  In `client/src/App.test.tsx`:
  - "Add missed attendance" button opens dialog in "Attendance corrections" tab.
  - Form requires selecting an employee, past date, time-in, and reason.
  - Displays error when date is today or duplicate record exists.
  - Displays "Assisted" and "Backdated" badges on attendance rows with appropriate tooltips.
  - Filter pills for "Assisted" and "Backdated" filter the displayed rows.

- [x] **Step 2: Run focused client test and confirm RED**
  CHECK: `npm test -w client -- App.test.tsx`
  EXPECT: FAIL on missing button, modal, badges, and filters.

- [x] **Step 3: Implement Backdated dialog, audit badges, and filter pills**
  1. In `client/src/api.ts`: Add `createBackdatedAttendance(payload)`.
  2. In `client/src/App.tsx`:
     - Add `AddMissedAttendanceDialog` in `AdminAttendance`.
     - Enforce `max={yesterdayDate}` on date picker.
     - Render `Assisted` and `Backdated` badge pills in `AttendanceTable` and `AttendanceEditRow`.
     - Add `Assisted` and `Backdated` filter pills in `AdminAttendance` filter bar.
  3. In `client/src/styles.css`: Add styles for audit badges (`.badge-assisted`, `.badge-backdated`).

- [x] **Step 4: Run focused client test and confirm GREEN**
  CHECK: `npm test -w client -- App.test.tsx`
  EXPECT: all admin backdate and audit tests pass.
  EVIDENCE: Verification of dialog submission, error handling, badging, and filtering.

---

### Task 6: Reporting & Export Integration (CSV & XLSX)

**Files:**
- Modify: `client/src/App.tsx` (exportAttendanceCsv)
- Modify: `src-tauri/src/reporting/mod.rs`
- Modify: `client/src/App.test.tsx`
- Modify: `src-tauri/src/lib.rs`

- [x] **Step 1: Write failing export tests**
  1. In `client/src/App.test.tsx`: Test that CSV export includes `"Recorded via"`, `"Recorded by"`, and `"Reason"` columns with audit metadata.
  2. In `src-tauri/src/reporting/mod.rs`: Test that attendance export row includes source and audit notes.

- [x] **Step 2: Run focused tests and confirm RED**
  CHECK: `npm test -w client -- App.test.tsx`
  EXPECT: FAIL on missing audit columns in export.

- [x] **Step 3: Implement export enhancements**
  1. `client/src/App.tsx`: Update `exportAttendanceCsv` to include `"Recorded via"`, `"Recorded by"`, and `"Reason"` in headers and row formatting.
  2. `src-tauri/src/reporting/mod.rs`: Include audit details in workbook generation.

- [x] **Step 4: Run focused tests and confirm GREEN**
  CHECK: `npm test -w client -- App.test.tsx && cargo test --manifest-path src-tauri/Cargo.toml reporting::tests`
  EXPECT: all export tests pass.
  EVIDENCE: Exports contain readable audit columns.

---

### Task 7: Full Repository Verification

**Files:**
- Verify only; no planned production changes.

- [x] **Step 1: Run Oxlint**
  CHECK: `npm run lint:oxlint`
  EXPECT: 0 warnings and 0 errors across all files.

- [x] **Step 2: Run Typecheck**
  CHECK: `npm run typecheck`
  EXPECT: successful compilation across shared, client, and server workspaces.

- [x] **Step 3: Run Vitest Suite**
  CHECK: `npm test`
  EXPECT: all tests pass in shared, client, and server.

- [x] **Step 4: Run Rust Test Suite**
  CHECK: `cargo test --manifest-path src-tauri/Cargo.toml`
  EXPECT: 0 failures across all Rust tests.

- [x] **Step 5: Inspect Git Diff**
  CHECK: `git diff --check`
  EXPECT: clean diff adhering strictly to Ponytail (minimal diff) and Anti-Slop (explicit safety comments on any non-const assertions).
