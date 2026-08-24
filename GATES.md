# Acceptance Gates: Photo Drag and Drop & Name Capitalization / Normalization

## Core Gates

- [x] GATE-1: Add `normalizeName` to `@rfid-attendance/shared` with comprehensive test coverage
  CHECK: npm test -w shared
  EXPECT: test passed
  EVIDENCE: `normalizeName` added to `shared/src/api-contracts.ts`; `shared/src/api-contracts.test.ts` (11 tests, 21 tests total in shared workspace) passed, verifying whitespace trimming/collapsing and title capitalization on lower, upper, hyphenated, apostrophe, and period-separated names.

- [x] GATE-2: Support drag and drop for photo upload in `CardRegistrationDialog` dropzone
  CHECK: npm test -w client
  EXPECT: test passed
  EVIDENCE: Added dragenter, dragover, dragleave, drop handlers and `.photo-dropzone.is-dragging` CSS style in `client/src/App.tsx` and `client/src/styles.css`; verified in `client/src/App.test.tsx` (drag and drop test passes).

- [x] GATE-3: Enforce name capitalization and normalization across client forms and backend endpoints
  CHECK: npm test -w client && npm test -w server && cargo test --manifest-path src-tauri/Cargo.toml test_normalize_name
  EXPECT: all tests pass
  EVIDENCE: Client forms normalize on blur and submit in `SetupDialog` and `UserRegistration`; server normalizes in `server/src/setup.ts` and `server/src/admin.ts`; Rust backend normalizes in `src-tauri/src/lib.rs` (`admin_upsert_user`). Verified by tests across client (103 tests), server (57 tests), and cargo (132 tests).

- [x] GATE-4: Pass full repository gates (lint:oxlint, typecheck, npm test, cargo test)
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all suites pass with 0 errors
  EVIDENCE: `npm run lint:oxlint` passed (0 warnings, 0 errors across 48 files); `npm run typecheck` passed across shared, client, and server; `npm test` passed (28 test files, 181 tests passed); `cargo test` passed (132 passed, 0 failed).

