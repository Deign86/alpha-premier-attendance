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
