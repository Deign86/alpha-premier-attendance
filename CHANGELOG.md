# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.65] - 2026-09-13

### Fixed
- **Intern cutoff gross compensation calculation**: `apply_intern_rules` now sets `employeeType: "INTERN"` so the cutoff engine's floored-at-zero rule applies directly; removed 3 command-layer substitutions (`gross = if is_intern { net.max(0) }`) in cutoff create, update, and generate commands.
- **Voice worker queue lease & clobber guard**: stranded `PROCESSING` voice jobs are now reclaimed after a 30-minute stale lease timeout; terminal `DONE` and `RETRY` writes now guard with `AND status = 'PROCESSING'` so in-flight pulls never clobber fresh re-queues.
- **Voice settings panel & error copy**: panel header pill and facts row now consistently derive state through `resolveTtsMode`; `announceScanError` routes real `UNKNOWN_RFID_CARD` and `USER_NOT_FOUND` codes to the shipped Bea sorry-clip (`sorry-card-not-recognized.mp3`), deleting dead codes.
- **Client live attendance & sync badge**: `LiveAttendance` replaces 4 loose state atoms with a single `LiveAttendanceState` discriminated union guarded against out-of-order responses; `DatabasePanel` distinguishes background poll ticks from manual sync completions so the `Syncing...` badge is not prematurely cleared.
- **DTR push plans & month block ranges**: TS `PushPlan` converted to a discriminated union (`write | in-sync | skip`), removing fragile string prefix comparisons; Rust `month_block_range` converted to `MonthBlock` tri-state (`Range | NoHeaders | NoMatch`), deleting redundant column A re-scans.
- **Autostart & sync queue retry**: `self_heal_autostart` feeds live opt-out status into `decide_autostart_action`; `admin_set_intern_dtr_sync` reports effective state; `requeue_sync_row` resets `attempts = 0` so retried dead rows receive a full retry budget.

## [0.1.64] - 2026-09-13

### Fixed
- **Packaged app: Users → Play did nothing.** The CSP had no `media-src`, so worker name clips served from `http://asset.localhost` were silently blocked by the webview in release builds (dev instances don't inject the CSP, which is why the same click worked under `tauri dev`). Added `media-src 'self' asset: http://asset.localhost data:`.
- **"Voices ready" pill touching the user count.** `.table-selection-count` / `.payroll-selection-count` are now flex rows with a 10px gap and wrap, so the chip no longer sits flush against "Total users: N".

## [0.1.63] - 2026-09-13

### Changed
- **DTR: the attendance DB is the single source of truth** (supersedes the 0.1.62 timestamp-wins guard): every write path (queue push, history backfill, manual sync, server CLI) now writes the DB-derived B:E row whenever it differs from the sheet — no stamp comparison, no `Stale` skip. Manual typing inside Intern DTR sheets is overwritten on the next sync for that person/day; when two devices push the same day, last writer wins. The per-device kill switch (0.1.62) still blocks all writes while OFF.

## [0.1.62] - 2026-09-12

### Added
- **Intern-DTR per-device kill switch**: Admin → Data toggle stored in local SQLite (`app_settings.intern_dtr_sync_enabled`, default ON), plus `INTERN_DTR_SYNC_ENABLED` for the server CLI and `ALPHA_PREMIER_DTR_SYNC_ENABLED` env override for the desktop app. While OFF, scans/corrections don't enqueue, manual sync refuses, and queued rows stay PENDING (never dropped) until re-enabled. New Tauri commands `admin_get_intern_dtr_sync` / `admin_set_intern_dtr_sync`.
- **DTR timestamp-wins guard**: every write path (queue push, history backfill, manual sync, server CLI) now compares live sheet B:E against local stamps — a local record with no clock-out never touches stamped rows, and a sheet stamp at/after the local (post-cap) stamp wins with a `Stale` skip (painted, logged, no write). A stale device can no longer rewind a newer push.

### Fixed
- **Ops-sheet sync starved to DEAD (all rows)**: `addBanding` sent an invalid `headerRowPosition` field, so every `reconcile format` pass returned `400 Unknown name "headerRowPosition"` (Google's `BandedRange` has no such field). Provisioning therefore returned no target and every due ops row failed 5× into DEAD — 803 rows across Users/Attendance/Payroll/PayrollCutoffs/InternGrace from 2026-09-08 onward. The request is now built by a pure `banding_request()` with a contract test asserting the field stays absent. DTR was unaffected (separate sheet, stayed SYNCED).
- **Sheet DELETE removed the wrong row**: the single-match delete path computed a 1-based key-column index while the multi-match path (`find_rows_to_delete`) computed 0-based, and both feed `deleteDimension.startIndex` — so any delete with exactly one match removed the row *below* the target. Unified on 0-based indices via `find_key_matches()` and pinned with a regression test.

## [0.1.61] - 2026-09-12

### Added
- **Embedded VoiceStudio auto-clone**: registration enqueues voice jobs (`voice_jobs`: PENDING → PROCESSING → DONE/RETRY, migration `0017_voice_jobs.sql`); the worker pulls Bea name-clip mp3s from the LAN VoiceStudio host (optional share PIN, backoff) and playback prefers worker clips with Piper fallback. New Tauri commands `voice_clip_states`, `voice_worker_status`, `voice_regenerate`, `voice_name_audio_url`; host/PIN UI with connection probe; roster-gated enqueue; delete cascade drops jobs + clips.
- **Voice regeneration progress loader**: Admin → Users and RFID Voice column now shows a staged loader (spinner + Queued… → Cloning… indeterminate bar, `role="status"`/`progressbar`) that polls (`pollVoiceClipReady`, 2s cadence, 120s cap, load-failure tolerant) until the new clip reads DONE, then reports `Voice clip ready` as the Bea chip flips live.

### Fixed
- **Display font weights**: three single-weight Orbitron `@font-face` blocks pointed at one variable font with no weight range, pinning every heading to the 400 instance — replaced with a single variable face (`font-weight: 400 900`); redundant binaries removed (bytes verified genuine via hash match).
- **Users table payroll column**: `Not applicable` broke mid-word — cell now reuses the single-line `user-status-cell` token like its neighbours.
- **Payroll grid headers**: 24-column headers wrapped mid-word (`STANDA RD`) with no row identity on scroll — headers are single-line with pinned checkbox/Employee #/name columns.
- **Voice worker pill**: `.lan-facts span` grid rule stacked the pill dot over its text — pill stays inline; retry copy aligned to `Retrying` (was `Waiting`, contradicting the header chip).
- **DTR sync dead-letter note**: `N failed item(s) need attention` had no inline remedy — added `Retry sync now` reusing the existing sync path.

## [0.1.60] - 2026-09-12

### Fixed
- **DTR Post-Cap Ordering Validation**: Inverted punched records where late-timeout auto-capping pulled clock-out before clock-in (e.g. 17:30 in, 18:00 out capped to 17:00) now consistently fail-closed and throw an inverted-time error in both TypeScript (`server/src/intern-dtr-sync.ts`) and Rust (`src-tauri/src/services/dtr_sync.rs`). Consolidated parsing, Manila normalization, auto-capping, and ordering validation under unified `normalizeRecord` / `normalize_record` helpers so row building and paint classification never disagree.
- **DTR Whitespace Parity**: Fixed edge-case whitespace timestamp handling in the TypeScript DTR synchronizer to match Rust (`!s.trim().is_empty()`), preventing empty strings or whitespace-only inputs from triggering spurious unparsable timestamp errors.
- **Payroll Half-Day Effective Window Consolidation**: Deduplicated the 4x copy-pasted early-morning-half-day noon window substitution rule into shared helpers `effectiveHalfDayTimeOut` (`server/src/lunch-break.ts`) and `early_half_day_noon_out` (`src-tauri/src/services/payroll.rs`). Preserved and locked intentional else-branch differences (employee whole-hour floor vs intern raw stamp passthrough) with mirrored test assertions.
- **Sync Health UI State Machine**: Replaced 3 disjoint boolean flags in `DatabasePanel` (`client/src/App.tsx`) with a strict `SyncHealthState` discriminated union (`loading | ready | refreshing | stale | error | syncing`). Cached health data is retained upon refresh failure with an explicit "showing last known data (error)" offline alert. Background visibility polling no longer overwrites an in-flight manual DTR sync badge.
- **Autostart Mutation Rule Consolidation**: Merged tray toggle and in-app settings commands under a single `set_autostart_enabled` lifecycle helper in `src-tauri/src/lifecycle.rs`. Registry writes are performed first, and opt-out markers are updated only upon success with non-fatal logging.


### Added
- **Late time-out auto-cap (no-overtime policy)**: time-outs at or after 18:00 Manila are capped to 17:00:00.000 same-day before DTR rendering/grouping and payroll math. 18:00+ renders `5:00:00 PM` on the DTR row, classifies/paints as `full`/`FullDay`, and computes full-day pay with `computedTimeOut` 17:00. Boundary: `18:00:00` caps, `17:59:59` does not cap. Half-day rules unchanged and apply post-cap. Both stacks agree on the hour-precision rule (hour ≥ 18 → 17:00): TS `capLateTimeoutOut` (`server/src/lunch-break.ts`, applied in `intern-dtr-sync.ts` `buildDtrRow`/`classifyRecordKind` via `capRecordOutIso`, `intern-payroll.ts`, `employee-payroll.ts`) and Rust `cap_late_timeout_out` (`src-tauri/src/services/payroll.rs`, applied in `dtr_sync.rs` `build_dtr_row`/`classify_record_row`, `intern_payroll.rs`, `employee_payroll.rs`; `dtr_recon.rs` inherits via those two functions; `cutoff_payroll.rs` takes aggregates, no change). Status-flag writers still stamp raw `LATE_TIMEOUT` at scan time — the cap applies at DTR-row/payroll-compute time. Minute-level note: shared `isLateTimeout` and the cap both trip at 18:00:00 — `isLateTimeout` truncates seconds, the cap truncates minutes — no practical gap. Thresholds unchanged.

### Fixed
- **Half-day pay fully decoupled from DTR display**: DTR sheet rows now carry actual stamps only (an 08:00–15:00 shift renders `[8:00 AM, '', '', 3:00 PM]`, never a fabricated 12:00 PM lunch pair), while half-day pay is computed from a payroll-only effective 08:00–12:00 window (`computedTimeOut`). Pay amounts and thresholds are unchanged; `classifyRecordKind` paint cutoffs (16:59 half-day) are intentionally untouched, so an 08:00–15:00 row may still paint `HalfDay` while showing actual end-stamps (cosmetic). Applies to both stacks: `server/src/employee-payroll.ts`, `server/src/intern-payroll.ts`, `server/src/intern-dtr-sync.ts` (incl. `isShortStint` parity) and Rust `dtr_sync.rs`, `intern_payroll.rs`, `employee_payroll.rs`, `dtr_recon.rs`.

## [0.1.58] - 2026-09-09

### Added
- **Realtime DTR Sync Status**: Admin Panel → Data and backup now shows a live sync-health card (overall Healthy/Syncing/Pending/Attention/Offline/Not synced badge, per-table pending rows, InternDtr waiting-tab names, last sync, dead-letter count, last error) polling every 5s while mounted; `admin_get_sync_status` extended with per-table breakdown, `dtrPending`, `lastSyncedAt`, and `lastError` (no migration).
- **Autostart Self-Heal**: every startup verifies the Windows Run value points at the current exe and repairs stale/missing/unquoted entries (quoted form); user opt-out via settings/tray always wins; all registry failures are log-only so startup never breaks. Fixes login-time blank-window/`ERR_CONNECTION_REFUSED` caused by stale entries launching old/dev binaries.
- **File Logging**: Tauri log plugin now writes a capped file target (current + 3 rotated × 5 MB) under the app log dir plus `log:default` capability, so Windows-login failures leave evidence.

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
