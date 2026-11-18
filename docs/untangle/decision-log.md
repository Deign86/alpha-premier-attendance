# Alpha Premier Attendance: untangle round 1, decision log

Branch `refactor/untangle` (from main at `f77212b`), local commits only. Problem IDs are from `attendance-problems.md`.

## Fixes

- **`services/firebase.rs`: one Firebase client under the ID register, the backup and the account sign-in** (commit `62b5b4d`)
    - N2: `id_register.rs` was the Firebase client for three features (`Endpoints`, `ask`, `http`, `Answer`).
    - H22: Firebase's sign-in refusal codes were read twice with the same `split(' ')` trick. Now `sign_in_with_password` returns a typed `SignInRefusal`; `id_register` turns it into its sentences, `admin_account` into its `Refusal` codes.
    - N18: the fake Firebase for four test suites lived in `id_register`'s tests. It is now `firebase::fake`.
    - The two count requests (`count_interns`, `count_there`) are one `firebase::count`.
    - One log line changed: "id register unreachable" is now "firebase unreachable" (it was printed for the backup and the admin sign-in too).
- **`services/settings.rs`: one accessor for `app_settings` and one list of its keys** (commit `62b5b4d`)
    - H36: five independent accessors and four copies of `CREATE TABLE IF NOT EXISTS app_settings`. `voice_pull`, `id_register`, `cloud_mirror`, `admin_account`, the unlock guard and `dtr_sync` now all go through `settings::{get, put, delete, get_json, put_json, ensure_table}`.
    - H37: 15 setting keys were private constants in six files, two of them both called `PROBLEM_KEY`. They are `settings::key::*`.
    - N4: sign-in and backup code imported settings helpers from the voice-clip module.
    - S16: `admin_pin.rs` kept its own six settings helpers for one key.
    - Kept as it was: a failed read of the unlock guard is still an error (never "not locked"); every other read still treats a failed read as "nothing stored".
- **`admin_pin.rs` renamed `unlock_guard.rs`; isolated target renamed `unlock_guard_isolated`** (commit `62b5b4d`)
    - N3: the account sign-in imported its hash and wrong-tries guard from a module named for a removed feature.
    - H49 (this target only): the isolated test now includes `settings.rs` beside `unlock_guard.rs`; both say so in their header.
- **The backup no longer depends on the ID register, and the panel's status is put together in the command** (commit `62b5b4d`)
    - N5: `RegisterStatus` embedded `BackupStatus` and `id_register::status` called `cloud_mirror::status`, while `cloud_mirror` imported from `id_register`. Now `cloud_mirror` imports only `firebase` and `settings`; `lib.rs` builds `IdRegisterPanel { register (flattened), backup }`, the same JSON as before.
- **`services/users.rs`: user save and delete moved out of `lib.rs`** (commit `af6912b`)
    - N1: `id_register` and `cloud_mirror` called `crate::save_user`, `crate::SaveOrigin`, `crate::upsert_user_record`, `crate::delete_user_and_cascade`. Pure move, same signatures; the three private helpers only `save_user` uses and their unit tests moved with it.
- **Commands and code that nothing calls, deleted** (commit `1d5845a`)
    - S1: `admin_update_user`, an alias with no caller anywhere.
    - S2: `admin_unlock`, `admin_lock`, aliases of `setup_unlock` / `setup_lock`; two verify-skill docs that mentioned the alias were updated.
    - S3: `payroll_calculate_cutoff`; its one test now calls the same three functions directly.
    - S4 (part): `admin_retry_sync_item`.
    - S5 (part): `open_generated_artifact` and `admin_sync_now` with their `tauriApi` members. X24 (the 20-pass drain cap) went with `admin_sync_now`.
    - S8: `client/src/speech.ts` and its test file.
    - S9: `setSimulatedOffline`, `isSimulatedOffline`, `clearOfflineQueue`, `websocketUrl`; `sseUrl` replaced by `apiUrl`, which it only renamed.
    - S10: `AVAILABLE_VOICE_MODELS`.
    - S12: the `attendance-changed` event nobody listens for (two emits).
    - S13: `google_append_row`, `google_delete_row`, `google_format_sheet`.
    - S14: `voice_pull::check_connection`.
    - S15 / X29: `SHEETS_SCHEMA_VERSION`, `is_transient_google_error`, `scanner::SCAN_EVENT` deleted; `tab_name_overlaps_user` compiled for tests only; stale `#[allow(dead_code)]` taken off `DTR_LUNCH_OUT` / `DTR_LUNCH_IN` (they are used).
    - S17: release workflow comment about the Forgot-PIN email.
    - S18: `.gitignore` rule for the deleted `scripts/pin-reset-mailer`.
    - S19: `config.rs` doc saying "Forgot PIN?" sets a PIN.
    - S20: `cloud_mirror.rs` doc and test still naming `admin_pin_hash`.
    - S31: `employee_payroll` named in `lunch_break.rs` and `docs/testing/rust-test-parity.md`.
    - S33: `should_hide_on_close(tray_available)` had one caller passing `true`; it is `exit_requested()`.
- **Comments that only restate the code, removed** (commit `5303fb2`)
    - 31 lines in `services/users.rs`, `services/dtr_sync.rs`, `network.ts`, `tauri-api.ts`, `update-banner.tsx`, `voice-settings-panel.tsx`, `services/updateService.ts`. No code line changed.
- **The three Linux-only test failures fixed in the tests** (commit `8477664`)
    - `paths::db_path_override_treats_a_dot_extension_as_a_file`, `paths::db_path_override_treats_a_directory_by_appending_attendance_db`, `config::service_account_path_resolves_against_config_dir` used `D:/…` and `C:/…`, which are absolute only on Windows. They now build the outside path from the temp folder, absolute on every OS. Same assertions. No production bug: the path code is right on both systems.

## Tests removed (each with its reason)

- `lifecycle::default_close_behavior_hides_only_when_tray_is_available`: tested the `tray_available` parameter that S33 removed.
- The `is_transient_google_error` assertions at the top of `sync_retry::transient_classifier`: the function had no production caller and was deleted (S15). The rest of that test stays.
- `assert_eq!(SHEETS_SCHEMA_VERSION, 2)` in `sheets_sync::managed_tabs_have_stable_versioned_headers`: a constant compared with its own value, and the constant is gone.
- `client/src/speech.test.ts` (11 tests): tested `speech.ts`, which nothing imports (S8).
- `client/src/vite-config.test.ts` (1 test): asserted that a constant object has a string `target`; it is a string by construction, so the test could not fail.

## Not done this round

- **H48, backup on its own schedule**: `cloud_mirror::push` still runs inside `id_register::run_once` (every fourth pass, and on the panel's Check). Moving it would mean choosing whether signing the register out still stops the backup and when it runs; left as is on instruction. So `id_register` still depends on `cloud_mirror` one way.
- **S34, `endpoints: Option<&Endpoints>` parameter**: unchanged; it is how tests point at the fake.
- **X16, X17, X19, X20 (discarded errors in the three services)**: unchanged; fixing them changes behaviour.
- **H31, H34 (table list checked against the schema; backup exclusions)**: need a new test and a behaviour change to portable backups; not a move.
- **S4, `dtr_recon_get_latest_report` and `dtr_recon_run_manual`**: kept. No screen or script calls them, but they are the only reader of the weekly reconciliation report that still runs on schedule; deleting them leaves `dtr_recon::get_latest_report` dead too. Owner decides: give the report a screen, or remove the reconciliation.
- **S1 `admin_create_user`; S5 `admin_list_users`, `admin_list_attendance`, `get_health`**: kept, `scripts/*.mjs` call them.
- **S6, S26 to S30 (payroll profiles, employee-scope `else` arms)**: out of scope; need the production database checked first.
- **S7 (scanner stub)**: only the unreferenced `SCAN_EVENT` was deleted; `normalize`, `ScanParse`, `ScannerState` and the config fields stay.
- **S11 `resetDtrSyncGuardForTests`**: kept. Three test files call it 13 times to reset module-level state; removing it means the guard state stops being a module global (R7).
- **X29 `LanStartError::Config` / `NoLanIp`**: kept. Never constructed, but the comment says they are kept for the viewer's `config_invalid` / `no_lan_ip` contract; removing them cascades into `LanIssue`.
- **S21, S22 to S25, S36, `server/`**: out of scope.
- **R1, R2 (other than the users move), R3, R5, R7**: need the owner's decisions.
- **`users.rs` still calls `enqueue_sync_on` and `publish_attendance_change` in `lib.rs`**, and service tests still call `crate::scan_rfid_impl`: these go with the `lib.rs` split (R2).
- **Comment pass on `services/clonedBeaVoice.ts` (97 comment lines) and `sheets_sync.rs`**: read only in part; nothing removed there.
- **Weak assertion left in place**: `admin_account.rs` test line `kept.contains("pbkdf2") || kept.contains('$') || kept.len() > 100` can hardly fail; tightening it is a test change, not a removal.
- **Constant pins inside behaviour tests** (`PER_CALL_MAX_ATTEMPTS == 3`, backoff caps, `SHEETS_HTTP_TIMEOUT_SECS == 25`, the shared `'18:00'` / `'17:00'` pins): left; they sit inside tests that also check behaviour and read as policy pins, so not clear-cut.
- **`cargo clippy`**: not run; no workflow under `.github/workflows` runs it.

## For the owner

- `admin_sync_now` and `admin_retry_sync_item` are gone. Nothing in the app, scripts or docs called them, but they were the only manual "drain the Sheets queue" and "re-arm a DEAD queue row" commands. If IT used them through the debug MCP bridge, say so and they come back.
- The build cache: `src-tauri/target/debug/incremental` (4.9 GB of stale incremental data) was deleted to free disk for the test runs, and later runs used `CARGO_INCREMENTAL=0`. Nothing else in `target` was removed.

---

# Round 2, decision log

Branch `refactor/untangle-2` (from main at `21b9891`), local commits only, owner not consulted (asleep; instruction: finish without waiting). Problem IDs are from `problems.md`.

## Fixes

- **`http-api.ts`: the legacy server's HTTP calls behind the same interface as the desktop transport; `transport.ts` chooses once** (R5, adapter route)
    - N9: `api.ts` had 59 `runningInTauri()` branches, each with a native call and a `fetch` or a "desktop only" stub. Every function now has one body over `transport()`. `server/` is untouched.
    - H14 (second mapping): `loadConfig` mapped the config twice, once per transport.
    - H53 (part): `runningInTauri` was defined four times; `api.ts` and the three services import the one in `transport.ts`.
    - S35 (part): the third wrapping layer is thinner; most `api.ts` functions without their own error text are one line.
    - `api.ts` went from 61 `// SAFETY` casts to 10 (4 more are in `http-api.ts`), and from 1,288 lines to 929: a response type is now stated once, on the transport member.
- **`error-sentences.ts`: the one place an error code becomes a sentence** (R5)
    - H17: seven tables (`setupErrorFrom`, `accountMessages`, `userSaveMessages`, `attendanceSaveMessages`, the backdate ternary, `fileActionError`, the ID register panel's `problemText`) plus the payroll PDF, payslip, restore and payroll-profile `if`s are one table, grouped by the screen that shows the sentence.
    - H18: `ADMIN_AUTH_REQUIRED` still has its four sentences, one per screen, now side by side in that table. Not merged: merging changes what users read.
    - X14: the reset command's `INVALID_ACCOUNT` re-wording is a table entry (`accountReset`).
    - N11 (part): `id-register-panel.tsx` goes through `api.ts` (`idRegister`, `idRegisterProblem`).
- **Rust owns the intern pay rule on screen: every attendance row carries `arrivalStatus`, `minutesLate`, `graceUsed` and `payableTimeIn`** (R3)
    - H3: the admin attendance screen re-derived which late arrivals are clamped and which one took the week's grace (`manilaClockSeconds`, `clampedTimeLabel`, `isStrictlyPastQuarterHour`, `clampedTimeInIso`, `clampedGraceTimeInIds`, 160 lines). Deleted. The chip is shown when the row's `payableTimeIn` differs from its `timeIn`.
    - H4: the kiosk recomputed the arrival from a week of rows when the scan answer had no `arrivalStatus` (`evaluateKioskArrival`). Deleted; the kiosk says what the answer says.
    - H2: `evaluateArrivalWithBudget`, `evaluateAttendanceArrivals`, `evaluateArrivalFromTimestamp` deleted from `shared/`: after the client stopped using them nothing did (the server never imported them).
    - N17: the attendance screen no longer takes the user list to find the interns, and no longer threads `employeeType` through rows.
    - In Rust the clamp is one function, `intern_payroll::clamped_clock_in`, used by `calculate` (pricing) and by the new `payable_time_in` (what a screen is given). `get_attendance` now builds its rows with the same builder as `admin_attendance`, so both carry the four fields; the scan answer and the backdate answer carry them too. A late line of the cutoff breakdown carries `payableTimeIn` ("9:00 AM") when the day was paid from a clamped hour.
    - The two "load the earlier days of the week" effects (Live Attendance and Attendance corrections) are gone: up to six `get_attendance` calls each time the screen opened.
    - Boundary pin: `shared/arrival-fixtures.json`. `lib.rs::arrival_fields_match_the_fixture_the_client_renders` checks Rust produces each `expected` object; `client/src/arrival-fixtures.test.tsx` shows the same objects in the table and checks the time and the chip.
    - Left in `shared/` because `server/` uses them: `isNoGraceDate`, `hasWeeklyGrace`, `getManilaWeekStart`, `countWorkdays`, the two policy dates, `INTERN_DAILY_RATE_PHP`, `INTERN_LATE_DEDUCTION_PER_HOUR_PHP`, `INTERN_PAYROLL_PROFILE_ID`.
- **`lib.rs` split by area into `src-tauri/src/commands/`** (R2, commit `17d3d7a`, a pure move)
    - H50 (Rust half): `lib.rs` held every command of nine areas. It is now 399 lines: the module list and `run()`. The commands are in `commands/{kiosk, users, attendance, bathroom, payroll, exports, backup, lan, session, sync, voice, id_register}.rs`. `voice` and `id_register` are two areas the code has beyond the ten named in the plan.
    - H51: the 3,970-line test module moved with the code, each test to the module whose functions it calls; the fixtures several of them share are `commands/test_support.rs`.
    - N1 (rest): `services/users.rs` and the service tests import `commands::attendance::publish_attendance_change`, `commands::sync::enqueue_sync_on`, `commands::kiosk::scan_rfid_impl` by name instead of from the crate root.
    - Each module's `use super::…` lines name what it takes from the others, so the links between areas can be read at the top of each file.
    - A stray `#[tauri::command]` on `delete_cutoff_record` (never registered, takes `&AppState`) was removed.
- **One admin guard: `session::Admin::check`** (R2)
    - H42: 41 commands opened with a hand-written `if !admin_authorized … return Err("ADMIN_AUTH_REQUIRED")`, 8 used `require_admin`, and 3 returned another code. All 49 sites now call `Admin::check` (or `Admin::check_as` with the code they have always returned: `SETUP_AUTH_REQUIRED` twice, `ADMIN_SESSION_EXPIRED` once). `require_admin` is gone.
    - It cannot be forgotten silently: `commands::tests::every_command_checks_the_admin_session_or_is_listed_as_public` reads the command sources and fails for a command that neither checks nor is on the list of 27 public commands (checked by deleting one guard: the test failed and named the command).
- **One audit writer: `services/audit.rs`** (R2)
    - H47: 9 inline `INSERT INTO audit_logs` statements in the commands with four column lists, and 5 more in the services (`users.rs` 2, `dtr_recon.rs` 2, `sheets_sync.rs` 1). All 14 go through `audit::log`; the two left in the source are test seeds (`database.rs`, `cloud_mirror.rs`). The row written is the same: the columns a caller did not fill were NULL before and are NULL now; each caller keeps its own request-id format.
    - X15 (audit part): the dropped result is in one place, with the reason written beside it.
    - N3 (part): the account events are still logged by `audit_admin_pin_event`; it is renamed in the vocabulary step.
- **One "attendance changed" tail: `attendance::attendance_changed`** (R2)
    - H44: scan, correction, backdated entry and delete each sequenced the same steps by hand. They now fill one `AttendanceChange` and call one function, which queues the Sheets rows in the caller's transaction, commits, then tells LAN viewers, the app window and the audit log.
    - H46: the "flush `PendingSync` on the same transaction before commit" convention is inside that function.
    - The scan's inline DTR enqueue and inline LAN event are gone; it uses `enqueue_intern_dtr` and the same notice as the others, with the row attached.
    - The differences between the four were kept, each as a field of `AttendanceChange` (see "Calls made without the owner", 7). `each_admin_change_keeps_its_own_audit_row_and_a_delete_has_none` pins the audit ones.

## Tests removed in round 2 (each with its reason)

- `App.test.tsx` "marks the second grace-window arrival in the same week as late", "uses earlier week history to clamp an admin date-only 08:21 late arrival", "uses a strict hourly :15 boundary for intern attendance and weekly grace", "clamps all non-graced lates while preserving the first grace-window arrival", "resets the clamp and the grace at the Manila Monday week boundary": each tested the client's copy of the pay rule, which is deleted. The rule is tested where it lives: `intern_payroll.rs` (`payable_time_in_clamps_strictly_after_the_quarter_hour_under_the_first_policy_only` has the same boundary cases, the property test compares 20,000 days with the pricing) and the `lib.rs` weekly-grace tests.
- `App.test.tsx` "degrades to actual-only times on the live table when the week-history fetch fails": there is no week-history fetch any more.
- `App.test.tsx` "does not let a slow time-in announcement talk over the next person who already scanned": the wait it guarded (loading the week before announcing) is gone, so there is no slow announcement; the guard (`scanSeq`) was removed with it.
- `shared/api-contracts.test.ts`, the `evaluateAttendanceArrivals & grace period rules` block (8 tests) and "grants one graced arrival per week again from the resume date": tested the three deleted evaluators.

## Not done in round 2

- **N11, voice panel and voice services**: `voice-settings-panel.tsx`, `services/ttsService.ts` and `services/clonedBeaVoice.ts` still call `tauriApi` directly, and `App.tsx` / `update-banner.tsx` still import the scanner helpers and event listeners from `tauri-api.ts`. Their tests fake the desktop by spying on `tauriApi` while the page is in browser mode; behind a chosen transport those calls would go to the HTTP adapter and the tests would have to be rebuilt around a faked desktop flag, which changes which code paths they exercise.
- **S23, the four setup codes Rust never sends** (`SETUP_SESSION_EXPIRED`, `INVALID_SETUP_PIN`, `SETUP_DISABLED`, `SETUP_VALIDATION_ERROR`): kept in the setup table; `api.test.ts` asserts one of them and the legacy server does send them.
- **H8, cutoff period bounds from Rust**: not done. The payroll form computes the period synchronously while the month is picked, and in a browser tab there is no Rust to ask (the legacy server has no such route). Moving it means an asynchronous form (dates empty until an answer arrives) and a second implementation in `server/`: a behaviour change and a new route, not a move. `computeSemiMonthlyCutoff`, `cutoffFields`, `lastEndedCutoff` and the shared `countWorkdays` stay.
- **H5, H6, H7, H16 (rates, the 18:00 / 17:00 hours, `normalizeName`, the "5 minutes" / "7 days" / "15-minute" numbers in client text)**: unchanged. They are constants the legacy server also reads from `shared/`; sending them from Rust would leave browser mode without them.

## Calls made without the owner

1. **R5, the transport is chosen per call, in one function.** `transport()` in `transport.ts` checks for the desktop each time it is called. Choosing once at load would be the same in the app; the tests switch between desktop and browser inside one file.
2. **R5, browser mode only: two request bodies carry one more field.** `PATCH /api/admin/users/:id` and `PATCH /api/admin/payroll/cutoffs/:id` now send the id in the body as well as in the URL (the desktop payload, unchanged). `unlockSetup` and `unlockAdmin` in browser mode now return only the fields their type names instead of the server's whole body. The desktop app is unaffected.
3. **R5, `ADMIN_AUTH_REQUIRED` keeps four sentences.** One table, but a sentence per screen, because the instruction was to keep every sentence users see.
4. **R3, what the admin attendance screen shows differently.** Checked first: the client line the brief names (`isNoGraceDate` in `clampedGraceTimeInIds`) skipped the clamp for every date from 2026-10-01, and Rust's policies from that date (V2 and V3) have no clamp either, so for dates from 2026-11-16 the two already agreed; the Arrival badge on that screen already came from Rust. Example, 2026-11-18, scan 08:30, grace already used that week: before and after, "8:30 AM", no chip, badge "Late 30m". The real differences are in dates before 2026-10-01, where the clamp exists:
    - An afternoon arrival after :15. Example row: 2026-07-28, scan 13:22. Before: chip "2:00 PM" (tooltip "Actual scan: 1:22 PM"), CSV Time in `2026-07-28T14:00:00+08:00`. Now: "1:22 PM", no chip, CSV Time in `2026-07-28T13:22:00+08:00`. Rust prices an arrival at or after 12:00 as a half day from the actual time, never as a clamped late; the client clamped it.
    - Which arrival holds the week's grace. Before: the first 08:01 to 08:15 arrival among the rows the screen had loaded for the week. Now: the claim Rust stored (`payroll.grace_used`, else `intern_grace`). They differ only when the stored claim is not the week's first such arrival, for example after a correction or a backdated record; the chip then follows what was paid.
    - Cutoff breakdown, a late line. Before: the chip appeared when the printed time ("8:30 AM", no seconds) was past :15. Now it appears when Rust's payable time differs from the scan, so a scan at 09:15:30 now shows the chip "10:00 AM" (it was charged from 10:00 all along).
5. **R3, the Live Attendance table still shows the payable chip only when the roster loads** (that is, to an administrator), as before. `get_attendance` now carries the four fields for everyone who can call it; the screen keeps the old gate.
6. **R3, browser mode shows no arrival badge and no clamp chip.** The legacy server sends none of the four fields and the client no longer computes them. The kiosk greeting in browser mode no longer says on time / grace / late for the same reason. Not a change in the app.
7. **R2, differences between the four attendance tails: preserved, not decided.** Each is an explicit field of `AttendanceChange` and is listed in the table above that struct:
    - Scan does not re-queue the later days of the person's week on the DTR sheet (`requeue_later_week: false`); correction, backdate and delete do.
    - Correction and delete do not emit the `attendance-updated` window event (`window_event: None`); scan and backdate do.
    - Backdate takes a second sequence number for the window event (`own_sequence: true`), even when there is no window; scan reuses the LAN notice's number.
    - Delete writes no audit row (`audit: None`). Correction writes one without the person's id; backdate writes one with it; scan writes one with the card and the person.
    - Only the scan's LAN notice carries the row, the scan's request id and the scan's time; the others say only that the day changed.
    - Scan queues the DTR line only for sources `RFID` and `ADMIN_ASSISTED_SCAN`; the others have no such test.
    - Each caller still sends its own set of keys in the Attendance sheet row (H33): 10 from the scan, 5 from a correction, 10 from a backdate, 2 from a delete.
    - A failed commit in the scan still answers `INTERNAL_SERVER_ERROR` as a success-shaped JSON; the other three still return the database error text.
8. **R2, one small reordering inside the correction.** The lookup of the person for the DTR line (a `SELECT` on `users` in the same transaction) now runs before the Attendance row is queued instead of after it. It reads nothing the queue insert writes, so the result is the same.
9. **R2, "one JSON builder per record kind" is not a separate change.** The three shapes of a user object, the four of an attendance row and the five of a bathroom log entry differ in their keys today. Making one builder each without changing any JSON means one typed struct per shape; that is the typed-response step (R1) and is reported there.
10. **Disk.** During the R2 run the disk went below the limit with `target/debug/incremental` already empty. A command to delete this crate's test binaries left by older versions was refused by the permission system and nothing was deleted; the space came back without any action from this session, and the full suites ran afterwards.
