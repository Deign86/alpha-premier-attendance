# Acceptance Gates: Ease Overtime Strictness Threshold to 6:00 PM (18:00)

## Core Gates

- [x] GATE-1: Update shared API contracts and Rust office hours service threshold to 18:00
  CHECK: npm run build -w shared
  EXPECT: build succeeded
  EVIDENCE: `OFFICE_HOURS_END = '18:00'` updated in `shared/src/api-contracts.ts` and `OFFICE_HOURS_END_HOUR = 18` in `src-tauri/src/services/office_hours.rs`. `npm run build -w shared` exited 0.

- [x] GATE-2: Ensure 5:05 PM (17:05) and up to 6:00 PM (18:00) time-outs complete normally without LATE_TIMEOUT or complaints for manual correction
  CHECK: npx vitest run shared/src/api-contracts.test.ts server/test/attendance.test.ts
  EXPECT: 2 passed
  EVIDENCE: `shared/src/api-contracts.test.ts` (7 tests) and `server/test/attendance.test.ts` (5 tests) passed, explicitly verifying 17:05 and 18:00 evaluate to `isLateTimeout = false` and produce `COMPLETED` shifts.

- [x] GATE-3: Ensure true overtime (strictly after 18:00) continues to be flagged as LATE_TIMEOUT pending manual correction
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml office_hours
  EXPECT: test result: ok
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml office_hours` passed 4 tests verifying `flags_time_outs_strictly_after_18_00_manila` (e.g. 18:01, 18:55, 23:59).

- [x] GATE-4: Pass full repository gates (lint:oxlint, typecheck, npm test, cargo test)
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all suites pass with 0 errors
  EVIDENCE: `lint:oxlint` 0 warnings/0 errors on 48 files; `typecheck` passed across shared, client, and server; `npm test` 28/28 test files passed (173 tests); `cargo test` 130 passed (0 failed).

