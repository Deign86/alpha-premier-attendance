# Acceptance Gates: Admin-Assisted Attendance & Backdated Manual Entry

## Core Gates

- [x] GATE-1: Add `CardType`, expanded `ScanSource`, new error codes, and audit fields to `@rfid-attendance/shared` with test coverage
  CHECK: npm test -w shared
  EXPECT: all tests pass
  EVIDENCE: `shared/src/api-contracts.ts` and `shared/src/api-contracts.test.ts` updated with `cardTypes`, `scanSources` (`ADMIN_ASSISTED_SCAN`, `ADMIN_BACKDATED_ENTRY`), error codes (`ADMIN_CARD_REQUIRES_SELECTION`, `ATTENDANCE_ALREADY_EXISTS_FOR_DATE`, `BACKDATE_LIMIT_EXCEEDED`), and audit fields (`recordedBy`, `recordedReason`, `recordedAt`).

- [x] GATE-2: SQLite migration 0010 with schema-level triggers forbidding attendance writes for admin cards
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml state::tests::migrations_create_required_indexes_and_queue
  EXPECT: test passed
  EVIDENCE: `src-tauri/db/migrations/0010_admin_assist_and_audit.sql` applies cleanly; `card_type` on `users`, audit columns on `attendance`, and `trg_prevent_admin_card_attendance` triggers verified.

- [x] GATE-3: Support Employee card vs. Admin RFID card in `SetupDialog`, `UserEditor`, and backend endpoints
  CHECK: npm test -w server -- test/setup.test.ts && npm test -w client -- App.test.tsx
  EXPECT: all tests pass
  EVIDENCE: `SetupDialog` renders radio toggle switching between Employee card and Admin RFID card; backend endpoints accept `cardType` without requiring employee name for admin cards; `docs/card-registration.md` updated.

- [x] GATE-4: Feature A — Admin RFID live assist on kiosk with active employee selection, reason confirmation, and 25s idle timeout
  CHECK: npm test -w server -- test/attendance.test.ts && npm test -w client -- App.test.tsx
  EXPECT: all tests pass
  EVIDENCE: Kiosk detects admin RFID card tap and opens Assisted Attendance modal; employee selection and reason confirmation records attendance on behalf of employee with `ADMIN_ASSISTED_SCAN` and audit metadata; 25s timeout resets kiosk.

- [x] GATE-5: Feature B — Backdated manual attendance action in Admin panel with duplicate, cutoff, and reason validation
  CHECK: npm test -w server -- test/admin.test.ts && npm test -w client -- App.test.tsx
  EXPECT: all tests pass
  EVIDENCE: Admin panel attendance tab provides "Add missed attendance" dialog; validates past date, rejects duplicate rows, rejects finalized cutoff dates, and requires reason; persists with `ADMIN_BACKDATED_ENTRY`.

- [x] GATE-6: Shared audit-trail visual badges, filter pills, and export columns in CSV and XLSX
  CHECK: npm test -w client -- App.test.tsx && cargo test --manifest-path src-tauri/Cargo.toml reporting::tests
  EXPECT: all tests pass
  EVIDENCE: Badges `Assisted` and `Backdated` render in Live Attendance and Admin tables; filter pills filter records by override type; CSV and XLSX exports include audit columns.

- [x] GATE-7: Pass full repository gates (lint:oxlint, typecheck, npm test, cargo test)
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all suites pass with 0 errors
  EVIDENCE: `npm run lint:oxlint` passes with 0 warnings/errors; `npm run typecheck` passes across shared, client, server; `npm test` passes across all workspaces (200 tests); `cargo test` passes (138 tests, 0 failed).
