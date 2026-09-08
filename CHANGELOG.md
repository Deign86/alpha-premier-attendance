# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.57] - 2026-09-08

### Fixed
- **Kiosk Offline Queue Recovery**: Unconditionally schedule return-to-ready timers in `handleScanSubmit` on offline queues and network failures, preventing kiosk UI hangs.
- **Admin Session Duration**: Updated Tauri native `checkAdminSession()` to return ISO `expiresAt` rather than token string, fixing auto-lock timer `NaN` calculations.
- **Voice Playback Cancellation**: Added `activeAudioCancel` and monotonic `activePlaybackEpoch` to abort pending HTML5 `Audio` and multi-segment voice playback when speech is interrupted.
- **User Setup Profile Persistence**: Retained existing `payrollProfileId` during user updates in `SetupService.upsertUser`.
- **Attendance Concurrency**: Keyed presenter mutex serialization on employee `userId` rather than physical card UID.
- **Payroll Sheet Manual Adjustments**: Included `manual_adjustment_centavos` in consolidated payroll sheet projections so manual adjustments appear on exported sheets.
- **Individual Payslip Canonicalization**: Consolidated individual payslip generation around `EmployeePayslipData` to reflect actual working days and statutory deductions.
- **Google Sheets Sync Token Optimization**: Reused OAuth access tokens across batch operations in `run_once`, eliminating redundant JWT sign and network roundtrips.
- **Native Scanner Handle Cleanup**: Unified pause state into `ScannerStatus` and eliminated dead runtime scaffolding.
- **Test Suite Parallelism**: Acquired `dtr_env_test_guard` in `admin_update_partial_payload_coalesces` to prevent parallel environment variable race conditions.
- **Verification Tooling**: Enforced non-zero exit codes on failed workflow steps in `scripts/verify-tauri-mcp.mjs`.

---

## [0.1.56] - 2026-09-08

### Added
- **Manual Intern DTR Sync**: Added manual synchronization for active interns onto the human `INTERN DTR 2026` Google Spreadsheet.
- **Admin Sync UI Controls**:
  - Added **"Sync Interns to DTR"** bulk button in Admin Panel → Users header toolbar.
  - Added individual **"Sync DTR"** action button to intern rows in the Users table.
  - Added **"Sync Intern DTR now"** button in Admin Panel → Data & backup.
- **Auto-Enqueued DTR Pending**: Automatically enroll newly created or updated active interns into `dtr_pending` when saved through the Admin Panel.

### Fixed
- **Middle Initial DTR Tab Overlap Collision**: Fixed false-positive overlap matches in `tab_name_overlaps_user` (Rust) and `hasTabOverlap` (TypeScript) caused by single-character name tokens (e.g. `"C."` in `Maricon C. Danao` colliding with `"C."` in existing tab `Raineer C. Rosado`), which prevented tabs from being auto-provisioned.

---

## [0.1.55] - 2026-09-08

### Added
- **New Intern Voice Profile**: Pre-rendered and bundled Ma'am Bea cloned voice announcement (`APG-2026-116.mp3`) for newly registered intern Maricon C. Danao (spoken name: "Maricon Danao").
- **Automatic Phonics Normalization**: Added Philippine phonetics normalization (`normalizePronunciation`) in batch voice generation scripts to strip middle initial dots (e.g. "C.") and expand abbreviations (e.g. "Ma." -> "Maria").
- **Direct Backup Voice Loading**: Added `--backup <path>` and `--db <path>` flags to `generate_existing_intern_names.ts` to directly extract and discover personnel from `.apbackup` archives.

### Changed
- **VoiceStudio System Standardization**: Completely renamed and migrated all legacy `voicebox` filenames, scripts, manifests, and references across the codebase to `voicestudio`:
  - `scripts/audit_voicebox_results.py` -> `scripts/audit_voicestudio_results.py`
  - `scripts/archive/setup_voicebox_bea.py` -> `scripts/archive/setup_voicestudio_bea.py`
  - Removed duplicate `voicebox_profile_id` entries from `client/public/voices/bea/manifest.json` and `src-tauri/resources/voices/bea/manifest.json`.
  - Updated `package.json` `"voice:audit"` script command to point to `scripts/audit_voicestudio_results.py`.
  - Updated `.gitignore` pattern from `test_voicebox_*.wav` to `test_voicestudio_*.wav`.
  - Updated `ttsService.test.ts` suite to `'VoiceStudio runtime isolation'`.

### Verified
- `npm run voice:audit`: 50/50 announcement files verified valid (0 issues).
- `npm test`: All tests passed across client, server, and shared workspaces.
- `npm run typecheck`: Passed with zero errors.

---

## [0.1.54] - 2026-09-08

### Fixed
- **User Deletion Cascade**: Fixed issue where deleting a user could leave orphaned records across attendance, payroll, and reconciliation tables; added explicit confirmation dialog with permanent deletion warnings.
- **Relational Cleanup**: Admin deletion now cleans up cascading user records and ensures consistent DB state.

### Added
- **Admin User Photo Editing**: Added direct upload, preview, and removal of employee/intern ID photos directly within the admin `UserEditor` panel.
- Supported drag-and-drop and file picker photo uploads for existing user profiles.

---

## [0.1.53] - 2026-09-06

### Fixed
- **DTR Corrections**: Corrections can clear tap-outs; aligned CLI 4h parity and tab-metadata refresh.
- **Half-day Logic**: Noon arrival counts for payroll plus afternoon DTR row.
