# Alpha Premier Attendance: where the code gets "should these change together?" wrong

Read-only structural audit of `/home/claude/alpha-premier-attendance` at v0.2.54 (HEAD `f77212b`).
Nothing in the repo was changed, no cargo build or test was run. Every item below was checked in the code with grep or by reading the lines cited.

How to read the line numbers: `lib.rs` is `src-tauri/src/lib.rs` (10,770 lines; production code ends at 6782, the `mod tests` block is 6783 to 10770). `App.tsx`, `api.ts`, `tauri-api.ts` are under `client/src/`. Other Rust paths are under `src-tauri/src/`. "shared" is `shared/src/api-contracts.ts`.

Evidence from history: the repo has 48 commits (31 non-merge), so co-change numbers are small. What they do show:
- `lib.rs` + `services/id_register.rs` changed together in 5 of 6 id_register commits; `tauri-api.ts` + `lib.rs` in 5 of 5; `id-register-panel.tsx` + its test + `id_register.rs` in 5 of 5.
- `services/cloud_mirror.rs` has 4 commits and every one also touched `id_register.rs`, `id-register-panel.tsx`, and `docs/shared-backend.md`.
- `.github/workflows/release.yml` and `macos-build.yml` changed together in 4 of 5.
- One feature commit (`81f5d4f`, new interns from the ID register) touched 17 files: 2 workflows, `App.tsx`, `tauri-api.ts`, the panel and 2 tests, shared contracts, `lib.rs`, 3 services, 2 codemaps, 1 doc.

---

## 1. Hidden links (must change together, the code does not show it)

### 1a. The same rule written in Rust and in TypeScript

- **H1** `services/intern_payroll.rs:11,13` and `shared/src/api-contracts.ts:34,40`: the two policy dates `NO_GRACE_CUTOFF_DATE = 2026-10-01` and `WEEKLY_GRACE_RESUME_DATE = 2026-11-16` are separate constants in each language; a third copy of the first date is in a message at `server/src/sheets.ts:1296`. A policy date change must be made in all three.
- **H2** `services/intern_payroll.rs:43-110` (three policy versions, `policy_for_date`) and `shared/src/api-contracts.ts:36-43,61-86,156-228` (`isNoGraceDate`, `hasWeeklyGrace`, `evaluateArrivalWithBudget`, `evaluateAttendanceArrivals`, `evaluateArrivalFromTimestamp`): the weekly grace rule (one graced arrival per Manila week, 08:01 to 08:15) is implemented twice. Nothing ties them: the only cross-language pin (`shared/src/payroll-fixtures.pin.test.ts`, `src-tauri/tests/cutoff_freeze.rs`) is a hash of the Rust fixture file and does not run the TS functions.
- **H3** `App.tsx:8207-8363` (`manilaClockSeconds`, `clampedTimeLabel`, `isStrictlyPastQuarterHour`, `clampedTimeInIso`, `clampedGraceTimeInIds`): the admin attendance screen re-derives which late arrivals are clamped to the next hour and which one used the week's grace, from raw rows. This is a third copy of the pricing rule in `intern_payroll.rs`. It has already drifted: `App.tsx:8346` skips every date on or after 2026-10-01 with `isNoGraceDate`, while Rust and `shared:42` (`hasWeeklyGrace`) bring grace back from 2026-11-16.
- **H4** `App.tsx:198-234` (`evaluateKioskArrival`): when the scan answer has no `arrivalStatus` the kiosk recomputes the arrival by loading each day of the week and running the TS grace rule. Same rule as `lib.rs:6042` `attendance_arrival`, fourth place.
- **H5** `services/intern_payroll.rs:8,10` and `shared:486,487,494`: `INTERN_DAILY_RATE_PHP = 80`, the PHP 10 per late hour (Rust derives it as `80/8` at `intern_payroll.rs:249,356` and `lib.rs:3038,3151`; TS has a constant `INTERN_LATE_DEDUCTION_PER_HOUR_PHP = 10`), and `INTERN_PAYROLL_PROFILE_ID = "INTERN_STANDARD"` exist in both languages. `App.tsx:7360,7369` prints the TS values next to amounts Rust computed.
- **H6** `services/payroll.rs:12`, `services/office_hours.rs:15`, `shared:52`, `server/src/lunch-break.ts:22`: the 18:00 late time-out hour and 17:00 close are four constants (two of them in Rust itself; `office_hours.rs:12` has a comment pointing at the other one).
- **H7** `lib.rs:2780` `count_workdays` and `shared:107` `countWorkdays`; `lib.rs:6034` `manila_week_start` and `shared:87` `getManilaWeekStart`; `lib.rs:366` `normalize_name` and `shared:273` `normalizeName`: three helper rules implemented once per language.
- **H8** `App.tsx:6165-6215` (`computeSemiMonthlyCutoff`, `cutoffFields`, `lastEndedCutoff`): the client decides cutoff start, end and standard working days; Rust validates only that the dates parse (`lib.rs:2835-2841`) and recounts workdays itself (`lib.rs:2939`). The definition of a cutoff period lives only in the client.
- **H9** `App.tsx:1049-1064` (hex or decimal, 4 to 64 characters, expected length), `lib.rs:5628-5629` (hex, 4 to 64), `services/scanner.rs:107-141` (`normalize`, same rule, test-only, see S6), `server/src/rfid.ts:2-5`: the card ID format rule is written four times.
- **H10** `App.tsx:2625` `PHOTO_UPLOAD_MAX_BYTES = 500 * 1024` and `lib.rs:6357` `MAX_PHOTO_BYTES = 500 * 1024`: same limit, two constants.
- **H11** `App.tsx:1920` `USUAL_USER_ID = /^APG-\d{4}-\d{3}$/i` and `services/id_register.rs:297-304` `is_id_number` (APG, 4 digits, 3 to 6 digits): two definitions of an ID number, and they already differ on length.
- **H12** `services/id_register.rs:32` `WAITING_PREFIX = "PENDING-"` and `shared:953` `WAITING_FOR_CARD_PREFIX = 'PENDING-'` (used at `App.tsx:4033`).
- **H13** Scan duplicate windows: `App.tsx:265` 2000 ms, `lib.rs:5716` 500 ms, `lib.rs:5723,5736` 10 s, `lib.rs:5588` 60 s, `config.rs:233` `dedup_ms` 300 (never read, see S7). Keystroke gap: `App.tsx:1122` `interKeyTimeout = 250`, `config.rs:230` `idle_timeout_ms` 150 (never read), `lib.rs:34` hard-coded `rfidAutoSubmitDelayMs: 150`. These describe one behaviour (when is a tap one tap) and are tuned in five places.
- **H14** `lib.rs:34` (`get_config` hard-codes `rfidAutoSubmitDelayMs:150, resultResetDelayMs:4000, enableAdmin:true, enableCardSetup:true, "mode":"keyboard"`) and `api.ts:167-175` (`DEFAULT_CONFIG` with 150, 4000 and the opposite booleans): the same defaults in two files, with `api.ts:221-250` mapping them twice more (once per transport).
- **H15** `tts/sanitizer.rs:8` `sanitize_speech_text` and `client/src/services/ttsService.ts:224` `sanitizeTextForSpeech`: same control-character and whitespace rule in both languages.
- **H16** `api.ts:445,450` say "paused for 5 minutes" and "last 7 days" in message text; the numbers are `UNLOCK_LOCK_MINUTES = 5` (`services/admin_pin.rs:25`) and `OFFLINE_DAYS = 7` (`services/admin_account.rs:25`). `api.ts:503` assumes a 15-minute session; the real value is `admin_session_minutes` (`config.rs:42,77`).

### 1b. Error codes and message text as a wire contract nobody declares

- **H17** Rust commands return `Err(String)` codes typed nowhere (about 85 distinct `"UPPER_SNAKE"` literals in production `lib.rs`), and the client has six separate lookup tables for them: `api.ts:183-208` (`setupErrorFrom`), `:443-452` (`accountMessages`), `:534-537` (`userSaveMessages`), `:557-564` (`attendanceSaveMessages`), `:588-603` (a nested ternary of seven codes), `:781-787` (`fileActionError`), plus `id-register-panel.tsx:11-15`. Adding or renaming a code in Rust needs a manual search of these tables.
- **H18** `ADMIN_AUTH_REQUIRED` has four different sentences: `api.ts:561` and `:785` ("Administrator session expired. Unlock admin to continue."), `api.ts:597` ("Administrator authentication required."), `id-register-panel.tsx:13` ("The administrator session ended. Unlock Admin again.").
- **H19** `shared:739-755,857-866,874-878` (`scanErrorCodes`, `setupErrorCodes`, `adminErrorCodes`) do not match what Rust sends: Rust never emits `GOOGLE_SHEETS_UNAVAILABLE`, `RATE_LIMITED`, `CONFIGURATION_ERROR`, `SETUP_DISABLED`, `INVALID_SETUP_PIN`, `SETUP_SESSION_EXPIRED`, `SETUP_VALIDATION_ERROR`, and the lists lack codes Rust does emit (`USER_HAS_OPEN_DAY`, `ATTENDANCE_IN_FINALIZED_CUTOFF`, `ATTENDANCE_TIME_IN_REQUIRED`, all eight account codes). `server/src/setup.ts:6` declares its own `setupErrorCodes` again.
- **H20** Three error shapes coexist with no marker of which a command uses: bare code (`"USER_CONFLICT"`), `"CODE: sentence"` (the bathroom commands, `lib.rs:1076,1086,1090,1095,1112,1147,1191,1195,1226`, also `:4009,4018,5181,5309`, parsed by `api.ts:1220-1224` `bathroomError` and by `startsWith` at `api.ts:690,712,1078`), and a success-shaped JSON `{"success":false,"error":{code,message}}` returned as `Ok` (scan path, `lib.rs:5631-5720`). A plain sentence is a fourth (`lib.rs:4955`, `services/id_register.rs:34-37`).
- **H21** The client matches Rust message wording: `App.tsx:1821-1823` regex on "Time in/out recorded successfully." (text at `lib.rs:5992`); `App.tsx:4065-4113` `describeRestoreFailure` looks for substrings such as "not a valid", "integrity", "zip", "staging" in restore errors written in `database.rs`; `client/src/dtr-sync-guard.ts:176` looks for `DTR_SYNC_IN_PROGRESS` inside a sentence built at `services/sync_retry.rs:256`.
- **H22** Firebase refusal codes are interpreted twice with the same `code.split(' ').next()` trick: `services/id_register.rs:158-168` (`sign_in_refusal`, returns English sentences) and `services/admin_account.rs:136-150` (returns `Refusal` codes that `api.ts:443` turns into sentences). The same three sentences ("The email or password is not right.", "This account has been turned off…", "Too many tries…") are therefore in `id_register.rs:162-165` and `api.ts:447,448,451`.
- **H23** The kill-switch refusal "Intern DTR sync is disabled on this device (Admin → Data → DTR sync toggle)" and its check are written at `lib.rs:4953-4957` and again at `services/dtr_sync.rs:3180`.

### 1c. Response shapes built by hand

- **H24** 78 of the 90 commands return `serde_json::Value`; production `lib.rs` has 202 `serde_json::json!` calls with camelCase keys typed as string literals. The TS types in shared are attached with casts (`api.ts` has 61 `// SAFETY` comments and 56 `as` casts). A field rename in Rust compiles and typechecks on both sides.
- **H25** The user JSON object is built from a row three times with different field sets: `lib.rs:293-312` (`admin_users`, has `cardType`), `lib.rs:4275-4291` (`setup_lookup_card`, no `cardType`), `lib.rs:5990-6016` (scan answer). The users `SELECT` column list is repeated at `lib.rs:293,1973,4275,5636,5684`.
- **H26** The attendance row JSON is built at `lib.rs:252-268` (`get_attendance`), `lib.rs:929-965` (`attendance_rows_json`), `lib.rs:2110-2124` (backdate answer), `lib.rs:5993-6006` (scan answer), and as `LanAttendanceRow` at `lan_server.rs:713` and `lib.rs:5950-5959`.
- **H27** The bathroom log entry JSON is built five times: `lib.rs:1003-1010`, `:1031-1045`, `:1155-1170`, `:1236-1252`, and inside `process_bathroom_scan` (`lib.rs:1432-1680`).
- **H28** The DTR sync status type is declared in Rust (`lib.rs:4329-4416`, enums at `:4363,4374`), again as `NativeSyncStatusResponse` (`tauri-api.ts:16-64`), again as `DtrSyncHealthEvent` (`tauri-api.ts:184-192`, the `activity` union is typed out a second time), again as `DtrSyncHealth` and friends (`api.ts:878-910`), with a hand validator between the last two (`api.ts:916-1040`, 125 lines).
- **H29** `IdRegisterStatus` and its nested `backup` are declared at `services/id_register.rs:71-82` + `services/cloud_mirror.rs:62-73` and again at `shared:929-950`.

### 1d. Lists that must be extended together

- **H30** Adding a Tauri command means editing five places by hand: the function, `generate_handler!` (`lib.rs:6688-6779`), `tauri-api.ts:67-148`, a wrapper in `api.ts` (or a direct call), and usually a type in shared. History confirms it (`tauri-api.ts` and `lib.rs` co-change 5 of 5).
- **H31** Table lists that do not reference each other: `services/cloud_mirror.rs:32-42` (`TABLES`, what is backed up to Firebase), `lib.rs:664-766` (`delete_user_and_cascade`, nine tables deleted by name), `services/sheets_sync.rs:258-270` (`column_specs`), `:273-278` (`key_column_index`), `:442-…` (`sheet_headers`), `:2230-…` (resync queries), and the migrations. A new per-user table needs an entry in the first two or it is neither backed up nor cleaned up.
- **H32** Sheets sync table names are string literals with no shared definition: `"Users"`, `"Attendance"`, `"Payroll"`, `"PayrollCutoffs"`, `"InternGrace"`, `"PayrollProfiles"` appear 25 times in production `lib.rs` and 53 times in `services/sheets_sync.rs`; only `InternDtr` has a constant (`services/dtr_sync.rs:51`). Operations `"UPSERT"`/`"DELETE"` are literals too (29 uses in `lib.rs`).
- **H33** The sync payload for one table has no single shape: the `Attendance` UPSERT payload has 5 keys at `lib.rs:1875`, 10 keys at `lib.rs:2059-2070`, and a third form at `lib.rs:5892`; `sheets_sync.rs` reads them by key name.
- **H34** `database.rs:211-227` (`is_excluded_data_entry`, what a portable backup leaves out) does not know about the two files `services/cloud_mirror.rs:48,86` keeps in the same data folder (`attendance-before-firebase.db`, `cloud-backup.json`). Both are carried in every backup; `cloud-backup.json` is also what `rebuild_if_new` (`cloud_mirror.rs:361`) reads to decide whether a kiosk is new.
- **H35** `.github/workflows/release.yml:84-106,176-180` and `macos-build.yml:46-49` repeat the same secret names and env block three times; they must match `option_env!` in `services/id_register.rs:59-60` and `build.rs`.

### 1e. Settings, files and globals shared by modules that do not name each other

- **H36** `app_settings` has five independent accessors: `services/voice_pull.rs:138-176` (`store_setting`, `read_setting`, used by `id_register`, `cloud_mirror`, `admin_account`), `services/admin_pin.rs:114-164` (`ensure_settings_table`, `get_setting`, `put_setting`, `delete_setting`, `load_json`, `save_json`), `services/dtr_sync.rs:92-124` (inline SQL), `services/id_register.rs:128-130` (`forget`, inline DELETE), `services/cloud_mirror.rs:260` (inline DELETE). The `CREATE TABLE IF NOT EXISTS app_settings` statement is repeated at `admin_pin.rs:117`, `dtr_sync.rs:93`, `dtr_sync.rs:112` and in `db/migrations/0017_voice_jobs.sql:3`.
- **H37** The 15 setting keys are private string constants spread over six files (`voice_pull.rs:17-19`, `id_register.rs:24-29`, `cloud_mirror.rs:44-46`, `admin_pin.rs:21`, `admin_account.rs:23`, `dtr_sync.rs:78`), two of them both named `PROBLEM_KEY`. Tests reach them by literal: `lib.rs:8193` (`'admin_unlock_guard'`), `lib.rs:9378-9390` (`"id_register_refresh_token"`, `"id_register_email"`), `id_register.rs:782` (`LIKE 'id_register_%'`).
- **H38** `services/voice_pull.rs:241` `BUNDLED_NAME_MANIFEST` is a process global set once in the startup task (`lib.rs:6548`) and read by `save_user` (`lib.rs:599-601`). A user saved before that task runs, or in a test, silently sees no bundle.
- **H39** The photo path `data_dir/photos/{user_id}.webp` is assembled at `lib.rs:276`, `:524`, `:845`, `:6326`, and the folder name again at `database.rs:688`.
- **H40** The sync guard stores its owner and start time in the `sync_state` table's `last_synced_hash` and `last_synced_at` columns (`state.rs:421-449`), under a magic table and row name from `services/sync_retry.rs`. `cloud_mirror.rs:745` then has to list `sync_state` as "kept here".
- **H41** `config.rs:40` `admin_pin` and `:42` `admin_session_minutes` live in `LanConfig`; the admin sign-in rule therefore reads `state.lan.admin_pin` (`lib.rs:4158,4161,4212`). Google Sheets IDs and the service-account path live in `LanConfig` too (`config.rs:8-36`).

### 1f. Call orders and conventions callers have to know

- **H42** The admin guard is a line each command must remember: 41 commands open with `if !admin_authorized(&state, &token).await { return Err("ADMIN_AUTH_REQUIRED".into()); }`, 8 use `require_admin` (`lib.rs:5413`, same thing), 2 return `SETUP_AUTH_REQUIRED` and 1 `ADMIN_SESSION_EXPIRED` for the same check. Commands that change state and have no guard line: `lan_start` (`lib.rs:4118`), `lan_stop` (`:4134`), `autostart_set` (`:6370`), `setup_lock` (`:4249`). `bathroom_get_status` (`lib.rs:977-980`) accepts a token and ignores it (`_token`).
- **H43** The client carries the admin token in two unrelated ways for one Rust session slot (`state.rs:237`): a module global `nativeAdminToken` (`api.ts:133`, read 39 times as `nativeAdminToken ?? ''` and exported through `nativeAdminSessionToken()` to `voice-settings-panel.tsx:64,87` and `id-register-panel.tsx:35,49`), and an explicit `setupToken` React state (`App.tsx:541-549`) passed into `lookupSetupCard`, `upsertSetupUser`, `uploadSetupPhoto`. `unlockSetup` (`api.ts:294`) also overwrites the global, and `lockSetup` (`api.ts:336`) clears it and the Rust session, so closing the kiosk setup dialog ends an Admin panel session. `api.ts:188` documents the effect in an error message.
- **H44** "What must happen after an attendance row changes" is sequenced by hand in four places, each slightly different: scan (`lib.rs:5890-5980`), edit (`lib.rs:1866-1908`), backdate (`lib.rs:2040-2105`), delete (`lib.rs:2225-2270`). The steps are: price the day, flush pending sync rows, queue the `Attendance` row, queue the intern DTR row, re-queue later days of the week, publish to LAN viewers, emit the Tauri event, write the audit row. Differences found: scan inlines the DTR enqueue (`lib.rs:5897-5915`) instead of calling `enqueue_intern_dtr` (`lib.rs:5509`) and builds the LAN event inline (`lib.rs:5938-5960`) instead of `publish_attendance_change` (`lib.rs:5439`); edit and delete never emit `attendance-updated`; only scan and backdate do (`lib.rs:5971`, `:2092`); scan never calls `enqueue_later_weekly_intern_dtr`, the other three do (`lib.rs:1885,1902,2076,2244`).
- **H45** `sync_guard_try_acquire` / `sync_guard_release` (`state.rs:408-…`) must be paired by every caller: `lib.rs:6568-6582` (background loop), `:4872-4901` (`admin_sync_now`), `:4963-4980` (`admin_sync_intern_dtr`), `:5051-5058` (nuke). Each also has to remember `emit_dtr_sync_health` afterwards (the nuke path does not).
- **H46** `PendingSync` rows returned by `ensure_payroll_tx` must be passed to `flush_pending_sync` on the same transaction before commit (`lib.rs:6017-6033`, convention stated only in a comment).
- **H47** The audit log is written by 11 inline `INSERT INTO audit_logs` statements in production `lib.rs` (`:596,862,1907,2095,4255,5015,5060,5109,5627,5664,5979`) with four different column lists and three request-id formats (`uuid`, `admin-{uuid}`, `{prefix}-{uuid}`); 5 more in `database.rs`, `cloud_mirror.rs`, `dtr_recon.rs`, `sheets_sync.rs`.
- **H48** `services/id_register.rs:252-255`: the Firebase backup (`cloud_mirror::push`) runs only as a side step of the ID register pull, which runs every fourth 30-second pass (`lib.rs:6616`). Changing the register schedule or signing the register out (`id_register.rs:211-215`) changes or stops the backup; neither file's public surface says so.
- **H49** Isolated test targets `include!` production sources (`src-tauri/tests/*.rs`, 16 `include!` lines) and re-declare stand-ins for what those sources import: `tests/payroll_sheet_undertime.rs:8-36` and `tests/intern_payslips.rs:9-33` each carry their own `mod config { struct OfficeConfig … display_full … metadata_lines }`. A change to `OfficeConfig` or to any `use crate::…` line in `reporting/mod.rs`, `payroll.rs`, `lunch_break.rs`, `intern_payroll.rs`, `cutoff_payroll.rs`, `admin_pin.rs` must be mirrored there. `admin_pin.rs:8-9` states the constraint ("kept free of Tauri/AppState") only as a comment.

### 1g. A feature spread across giant files

- **H50** `lib.rs` production part (6,782 lines) holds every command for nine areas (kiosk scan, users, attendance edits, bathroom, payroll, exports, backup/restore, LAN, sign-in, sync status) plus startup; 144 `sqlx::query` calls are in it. `App.tsx` (9,713 lines) holds 40+ components for the same areas. Any feature change opens both.
- **H51** `lib.rs:6783-10770`: about 3,990 lines of tests for all areas in one module, sharing helpers from `services/id_register.rs` tests (`lib.rs:9336`).
- **H52** Admin unlock UI exists twice with separate state: kiosk setup dialog (`App.tsx:342,533-568,1758-1771,2007-2022`) and Admin panel (`App.tsx:3581,3644-3660,3831-3873`), each with its own `pin` state, its own card-or-typed handler and its own `AccountSignInPanel` mount.
- **H53** `'__TAURI_INTERNALS__' in window` is tested inline in 9 places outside `api.ts` (`App.tsx:311,3262,4406,4556`, `admin-updates-card.tsx:17`, `id-register-panel.tsx:24`, `tauri-api.ts:210`, `services/clonedBeaVoice.ts:399`, `services/ttsService.ts:969`) and `runningInTauri` is defined four times (`api.ts:132`, `services/updateService.ts:105`, `services/clonedBeaVoice.ts:243`, `services/ttsService.ts:75`).

---

## 2. Needless links (tied together, change for different reasons)

- **N1** Services import upward from the crate root: `services/id_register.rs:361,376` calls `crate::save_user` and `crate::SaveOrigin`; `services/cloud_mirror.rs` tests call `crate::upsert_user_record`, `crate::scan_rfid_impl`, `crate::delete_user_and_cascade`, `crate::admin_upsert_user_inner`; `id_register.rs` tests do the same. The user-save rule lives in `lib.rs`, so the lowest-level modules depend on the most volatile file.
- **N2** `services/id_register.rs` is the Firebase client for three features: `Endpoints` (`:41-52`) carries `send_code` (only `admin_account.rs:192` uses it) and `commit`/`names` (only `cloud_mirror.rs:221,246` use them); `ask`/`http`/`Answer` (`:91-126`) are imported by both. `ask` logs "id register unreachable" (`:102`) when the caller is the admin sign-in or the backup.
- **N3** `services/admin_account.rs:17` imports `hash_secret`, `verify_secret` and the wrong-tries guard from `services/admin_pin.rs`, a module named for the feature that was removed; the account refusal for the pause is the code `ADMIN_PIN_LOCKED` (`admin_account.rs:52`), and account events are logged by `audit_admin_pin_event` (`lib.rs:4219,4235,4254`).
- **N4** `services/voice_pull.rs:138,169` owns the general settings accessors that `id_register`, `cloud_mirror` and `admin_account` import (`id_register.rs:19`, `cloud_mirror.rs:26`, `admin_account.rs:18`). Sign-in and backup code depends on the voice-clip module.
- **N5** `services/id_register.rs:71-82,137-155`: `RegisterStatus` embeds `cloud_mirror::BackupStatus` and `status()` calls `cloud_mirror::status`, which rehashes every backed-up row (`cloud_mirror.rs:420-424` → `changes`). The ID register panel's status call is tied to the backup's cost and shape; `cloud_mirror.rs:25` in turn imports from `id_register` (a two-way dependency).
- **N6** `services/sheets_sync.rs` and `services/dtr_sync.rs` import each other: `dtr_sync.rs:39-44` takes Google error codes and per-call retry helpers from `sheets_sync`; `sheets_sync.rs:2421,2583,2597,2612,2649,2679,2694,2698,2738,2754,2775,2893` special-cases DTR rows inside the generic queue runner. Google error constants are split between `sheets_sync.rs:57-…` and `sync_retry.rs` (`GOOGLE_TRANSPORT_FAILED`).
- **N7** Every service takes the whole `AppState` (`state.rs:221-277`, 30 fields): `id_register::status/sign_in/run_once`, all of `cloud_mirror`, `sheets_sync::run_once`, `dtr_sync`, `dtr_recon`, `LanRuntime::start`. `cloud_mirror` uses two fields (`db`, `data_dir`). `AppState` itself mixes eight DTR health flags (`state.rs:251-274`) with scanner, TTS, LAN and session state.
- **N8** `AppState::new` (`state.rs:297`) takes nine positional arguments and `config::load_config` (`config.rs:553-565`) returns a six-element tuple that `run()` destructures and re-threads three times (`lib.rs:6451-6497`); adding a config section edits all of them.
- **N9** `api.ts` holds two transports in every function: 58 `runningInTauri()` branches, each with a native call and either an HTTP `fetch` to the legacy Node server or a "desktop only" stub. Only four HTTP routes exist in the shipped app (`lan_server.rs:154-157`: `/attendance`, `/api/attendance/today`, `/api/events/attendance`, `/api/health`); the 27 `/api/...` paths in `api.ts` are served only by `server/`, which `README.md:316` describes as legacy and not shipped. Desktop behaviour and the legacy web API change for different reasons but share every function body.
- **N10** `server/` (6,976 lines incl. `admin.ts` 978, `intern-dtr-sync.ts` 1,090, `sheets.ts` 1,324) is a second implementation of scan, setup, admin, bathroom, cutoff payroll and DTR sync, still with a shared `ADMIN_PIN` (`scripts/start-dev.mjs:47-53`). Shared contracts (`shared/src/api-contracts.ts`, 1,103 lines) are shaped by both back ends, which is where the unused codes in H19 come from.
- **N11** UI panels reach past `api.ts` into `tauri-api.ts`: `id-register-panel.tsx:5,48,…`, `voice-settings-panel.tsx:64,87`, `update-banner.tsx`, `services/ttsService.ts`, `services/clonedBeaVoice.ts`, `App.tsx:137-149`. There is no single place where a command's errors are turned into text, which is why H17 has seven tables.
- **N12** `lib.rs:133-162` `RegisterAsk` + `id_register_impl`: one function with a mode enum that four commands (`lib.rs:164-188`) each call with a fixed variant; the only shared code is the guard line and the trailing `status()` call.
- **N13** `services/sheets_sync.rs:2551` `run_once(state, endpoint)`: both callers pass `state.lan.sheets_sync_endpoint` (`lib.rs:4886,6567`), a value the function can already read from `state`.
- **N14** `lib.rs:3784-3803` `canonical_exports_path`/`canonical_data_path` and `paths::canonical_within` take three error-code strings as parameters so each caller can name its own codes; the client maps only two of them (`api.ts:783-784`).
- **N15** `lib.rs:341-365` `upsert_user_record` has 13 positional parameters; `save_user` (`lib.rs:419-618`) passes constants for three of them (`employee_type = "INTERN"` at `:478`, `daily_rate = None` at `:514`, profile `None` at `:580`).
- **N16** `lib.rs:5509-5542` `enqueue_intern_dtr` and `:5544` `enqueue_later_weekly_intern_dtr` take `employee_type` only to return early unless it is `INTERN`, and every caller must look it up first (`lib.rs:1880-1884,2073,2190-…`).
- **N17** `App.tsx:8308-8363` takes the whole user list only to build the set of intern IDs (`:8312-8316`), and `App.tsx:8494,8539` thread `employeeType` through attendance rows for the same test.
- **N18** `services/id_register.rs` `tests` module (`:407-…`) is the shared fake Firebase for four test suites (`admin_account.rs:207`, `cloud_mirror.rs:434`, `lib.rs:9336`, itself). Its `Fake` struct has fields that belong to the others (`written`, `stored`, `refuse_backup`, `refuse_reading_back`, `refuse_apart` for the backup; `people`, `members`, `reset_asked` for accounts).

---

## 3. Surplus

### 3a. Commands registered but never invoked by the client

Checked: name is in `generate_handler!` and no `invoke('name')` exists in `client/src` outside tests.

- **S1** `admin_create_user` (`lib.rs:632`), `admin_update_user` (`:641`): pass-through aliases of `admin_upsert_user`. `admin_update_user` has no caller anywhere; `admin_create_user` is called only by `scripts/audit-live-system.mjs:155`, with an argument name (`payload`) the command does not accept (`user`).
- **S2** `admin_unlock` (`lib.rs:4305`), `admin_lock` (`:4324`): aliases of `setup_unlock`/`setup_lock`. No client caller; `admin_unlock` is mentioned only in two skill docs.
- **S3** `payroll_calculate_cutoff` (`lib.rs:2274`): no caller in client, scripts or docs.
- **S4** `admin_retry_sync_item` (`lib.rs:4843`), `dtr_recon_get_latest_report` (`:4914`), `dtr_recon_run_manual` (`:4921`): no caller in client, scripts or docs.
- **S5** Registered, present in `tauri-api.ts`, but the `tauriApi` member is never called: `admin_list_users` (`lib.rs:316`, `tauri-api.ts:93`, alias of `admin_users`; scripts only), `admin_list_attendance` (`lib.rs:968`, `tauri-api.ts:97`, alias of `admin_attendance`; scripts only), `get_health` (`lib.rs:28`, `tauri-api.ts:69`; one script), `open_generated_artifact` (`lib.rs:5371`, `tauri-api.ts:116`; no caller), `admin_sync_now` (`lib.rs:4862`, `tauri-api.ts:118`; no caller; its name survives only as a guard owner string).
- **S6** Reachable only through client functions that nothing calls: `payroll_list_profiles` (`lib.rs:2289`), `payroll_upsert_profile` (`:2303`), `payroll_delete_profile` (`:2369`), `payroll_intern_report` (`:2658`) are wrapped by `api.ts:638 loadPayrollProfiles`, `:646 savePayrollProfile`, `:655 deletePayrollProfile`, `:717 loadInternPayrollReport`, none of which is imported anywhere (one test spies on `tauriApi.payrollProfiles`; `scripts/audit-live-system.mjs:309` calls `payroll_intern_report`).

### 3b. Dead or test-only code

- **S7** The "native scanner pipeline" is a shell. `services/scanner.rs:79-88` `start` only sets a status; nothing emits the `rfid-scan` event (`scanner.rs:17` `SCAN_EVENT`, `#[allow(dead_code)]`, no `emit` with it anywhere); `normalize` and `ScanParse` (`scanner.rs:90-141`) are used only by tests; `ScannerState::Scanning/Offline/Error` are never set. The client still subscribes (`tauri-api.ts:150`, `App.tsx:1173,3694`) and comments describe a pipeline (`lib.rs:6629-6631`, `App.tsx:264,1168-1170`). Config for it is parsed and never read: `config.rs:182-188` `ScannerMode` (one variant), `:213-224` `enter_suffix`, `idle_timeout_ms`, `dedup_ms`.
- **S8** `client/src/speech.ts` (128 lines): imported only by `speech.test.ts`.
- **S9** `client/src/network.ts`: `setSimulatedOffline` (`:12`), `isSimulatedOffline` (`:19`), `clearOfflineQueue` (`:68`), `websocketUrl` (`:100`) have no importer; `sseUrl` (`:96`) is a rename of `apiUrl`. Nothing writes the offline queue any more; `App.tsx:464-489` only drains what an older version left in `localStorage`.
- **S10** `client/src/services/ttsService.ts:103` `AVAILABLE_VOICE_MODELS`: no reference.
- **S11** `client/src/dtr-sync-guard.ts` `resetDtrSyncGuardForTests`: a test reset hook exported from the production module, referenced only from tests.
- **S12** `lib.rs:2093,5972`: the `attendance-changed` event is emitted next to `attendance-updated`; nothing listens for it (client, scripts).
- **S13** `services/sheets_sync.rs:1680` `google_append_row`, `:1820` `google_delete_row`, `:1992` `google_format_sheet`: `#[allow(dead_code)]`; the last two have no reference at all.
- **S14** `services/voice_pull.rs:321` `check_connection`: no caller (commands use `check_connection_to`, `lib.rs:130`).
- **S15** `services/sheets_sync.rs:38` `SHEETS_SCHEMA_VERSION`, `services/dtr_sync.rs:69,71` `DTR_LUNCH_OUT`/`DTR_LUNCH_IN`, `services/sync_retry.rs:41` `is_transient_google_error` ("staged API", tests only), `services/dtr_sync.rs:1796` `tab_name_overlaps_user` (test-only wrapper compiled into production), `lan_server.rs:105-108` `LanStartError::Config`/`NoLanIp` (never constructed): all kept alive with `#[allow(dead_code)]`.
- **S16** `services/admin_pin.rs:114-164`: after the PIN removal, `get_setting`/`put_setting`/`load_json`/`save_json`/`ensure_settings_table` serve one key (`admin_unlock_guard`) and duplicate `voice_pull`'s accessors (see H36).

### 3c. Leftovers of the removed shared PIN and its emailed reset

- **S17** `.github/workflows/release.yml:101`: comment "Baked in via option_env! for the Forgot-PIN email (services/admin_pin.rs)".
- **S18** `.gitignore:57-58`: ignore rule for `scripts/pin-reset-mailer/.clasp.json`; the folder is gone.
- **S19** `config.rs:37-38`: field doc says `None` means "Forgot PIN?" sets one.
- **S20** `services/cloud_mirror.rs:21-22`: module doc says settings "hold the admin PIN hash"; the test at `:482` still lists `"admin_pin_hash"`.
- **S21** `docs/user-manual/manual.html:179,328,650-690,1249,1407` and `docs/user-manual/img/admin-forgot-pin.png`: a whole "Forgot PIN, resetting by email" chapter and screenshot.
- **S22** Names that still say PIN for the card-or-config-value path: `tauri-api.ts:86` `setupUnlock(pin)`, `api.ts:293` `unlockSetup(pin)`, `:419` `unlockAdmin(pin)`, error codes `INVALID_ADMIN_PIN`/`INVALID_SETUP_PIN`/`ADMIN_PIN_LOCKED`, input id `admin-pin` (`App.tsx:1099,2020-2022`), state `adminPin` (`App.tsx:342`), `unlockSetupWithPinOrCard` (`App.tsx:533`), `unlockWithPinOrRfid` (`App.tsx:3644`), shared `adminErrorCodes` entry `INVALID_ADMIN_PIN` (`shared:875`).
- **S23** `api.ts:183-208` `setupErrorFrom` handles `SETUP_SESSION_EXPIRED`, `INVALID_SETUP_PIN`, `SETUP_DISABLED`, `SETUP_VALIDATION_ERROR`; it is called only in desktop branches (`api.ts:294,308,324,341,350`) and Rust never returns those four.
- **S24** `scripts/verify-tauri-mcp.mjs:295` and `scripts/audit-live-system.mjs:120` unlock with `ALPHA_PREMIER_ADMIN_PIN`, which now works only when IT has put `admin_pin` in `config.toml`. `GATES.md:2567` still has the open item to archive the Apps Script and delete the `ALPHA_PREMIER_PIN_RESET_URL` secret.
- **S25** `docs/hardware-verification.md:47,70` and `docs/deployment.md:67` describe `SETUP_ADMIN_PIN` / "PIN-protected" admin (the legacy server's model).

### 3d. Leftovers of the removed employee scope (migration `0019_intern_only_scope.sql`)

`save_user` rejects anything but `INTERN` (`lib.rs:474-478`) and the migration converted or removed employee rows, so no `EMPLOYEE` user can exist.

- **S26** `lib.rs:2921-3037,3150`: 13 `if is_intern { … } else { … }` branches in `payroll_generate_cutoff_impl`; the `else` arms (profile lookup, incentives, allowances, holiday multipliers, overtime) cannot run. Fallback profile `"BEA_STANDARD"` at `lib.rs:2933,3227,3337`.
- **S27** Payroll profiles as a feature: commands in S6, table `payroll_profiles`, `lib.rs:2289-2402`, sync table `PayrollProfiles`, shared `PayrollCalculationProfile` (`shared:498-…`), with no screen that reaches them.
- **S28** `payrollFrequencies = ['SEMI_MONTHLY']` (`shared:476`), bound as a constant at `lib.rs:2362,2508,2741,3244`, checked at `:2333`: a setting with one value. `EmployeeClassification = 'INTERN'` (`shared:496`) likewise, yet `App.tsx` has 14 `isIntern` tests (`:6878-7039`) plus `:1421-1423,5891,7357,7427,8314,8494,8539`.
- **S29** `lib.rs:5150` `worker_type != "INTERN"` → `INVALID_WORKER_TYPE`; client always sends `"intern"` (`App.tsx:6484`), `tauri-api.ts:70` carries the parameter.
- **S30** `lib.rs:325-329` `should_enqueue_voice_job(card_type, employee_type, status)`, `:606`, `:1890`, `:5522`, `:5897`: comparisons of `employee_type` with `"INTERN"` on a value that is always `INTERN`.
- **S31** `services/lunch_break.rs:7` and `docs/testing/rust-test-parity.md:15-16` name `employee_payroll`, a module that does not exist.

### 3e. Pass-through wrappers and one-value extension points

- **S32** `lib.rs:412-417` `admin_upsert_user_inner` (calls `save_user` with a fixed origin), `:4296` `setup_upsert_user` (calls `admin_upsert_user`), `:5590-5596` `scan_rfid_impl` (calls `scan_rfid_at` with `now`), `:6064-6078` `ensure_payroll` (one caller, `:6255`).
- **S33** `lifecycle.rs:76` `should_hide_on_close(tray_available)`: the only caller passes `true` (`lib.rs:6650`).
- **S34** `endpoints: Option<&Endpoints>` threaded through `lib.rs:143,205`, `id_register::sign_in/run_once`, `admin_account::open/send_reset`: production always passes `id_register::built_in().as_ref()` (7 call sites in `lib.rs`); the parameter exists for the test fake.
- **S35** `tauri-api.ts:67-148` is a one-line-per-command pass-through; `api.ts` wraps most of it again; `api.ts:796-808` wraps three of those a third time via `runFileAction`.
- **S36** Root clutter tracked in git: `AGENTS.md.bak`, `HANDOFF.md`, `HANDOFF-dtr-sync-graceful.md`, `LEAN-CTX.md`, and `build-cache/` (a vendored NSIS 3.11 tree and zip). `scripts/archive/` holds three superseded voice scripts.
- **S37** `get_health` returns `"service":"rfid-attendance-api"` and a `googleSheetsExport` field (`lib.rs:29`) that no client code reads (`NativeHealthResponse`, `tauri-api.ts:5-14`, is unused).

---

## 4. Special cases

### 4a. An `if` for one value, a parameter for one caller

- **X1** `lib.rs:5461-5475` `sync_idempotency_key`: one branch for `table_name == "InternGrace" && operation == "DELETE"`; `services/sheets_sync.rs:273-278` `key_column_index` has the matching one (`"InternGrace" => 1`).
- **X2** `lib.rs:5499` `if !persisted && table_name == DTR_TABLE_NAME` (also `sheets_sync.rs:2421`), and the ten other `== DTR_TABLE_NAME` tests in the generic queue runner (N6).
- **X3** `lib.rs:5628` `source == "MANUAL_TEST"` skips the card-format check.
- **X4** `lib.rs:419-423` `SaveOrigin::IdRegister`: `save_user` has one early return (`:559-565`) and one audit branch (`:591-594`) for this origin only.
- **X5** `lib.rs:4158,4212`: `admin_pin == Some("")` means "admin off" for card-typed and account unlock; `Some(value)` is IT's back door (`:4169`); `None` is normal. One optional string carries three meanings.
- **X6** `services/admin_account.rs:136-150`: branches on Firebase's `TOO_MANY_ATTEMPTS_TRY_LATER` and `USER_DISABLED` strings; `:194` on `RESET_PASSWORD_EXCEED_LIMIT`.
- **X7** `services/cloud_mirror.rs`: the `"private_"` prefix is tested with `starts_with`/`strip_prefix` at `:196,231,381,386,395` to route TIN and account-number columns.
- **X8** `services/id_register.rs:385-388`: `Err(error) if error == "ADMIN_VALIDATION_ERROR"` decides a card is permanently unusable by comparing an error string from `save_user`.
- **X9** `lib.rs:444-463,479-483,514-535`: `is_assist` special-cases inside `save_user` (generated ID `ADMIN_CARD_{uid}`, default name, department "Admin", no gender, no photo).
- **X10** `lib.rs:583`: `e.to_string().contains("UNIQUE")` → `USER_CONFLICT`; `lib.rs:879` `error.contains("FOREIGN KEY")`; `lib.rs:1146` SQLite codes `"2067"`/`"1555"` or text match.
- **X11** `App.tsx:1099`: three input ids (`scanner-uid`, `setup-card-uid`, `admin-pin`) are exempted by name from the "typing in a field" test in the global key handler.
- **X12** `App.tsx:1139-1148`: a lone `1` or `2` key within 200 ms switches kiosk mode, inside the card-read buffer logic.
- **X13** `services/sheets_sync.rs:45-52`: `processing_lease_timeout_secs` returns 300 in production and 2 under `#[cfg(test)]`.
- **X14** `api.ts:484`: `INVALID_ACCOUNT` from the reset command is re-worded to "Type your email address first."

### 4b. Swallowed errors

- **X15** Production `let _ =` counts by file: `lib.rs` 40, `lifecycle.rs` 22, `database.rs` 17, `tts/audio.rs` 10, `tts/mod.rs` 7, `dtr_sync.rs` 6, `state.rs` 5, `dtr_recon.rs` 4. In `lib.rs`, 16 are `let _ = sqlx::query(…)` (11 audit inserts, see H47; `:607` `dtr_pending`; `:852` `voice_jobs`; `:5099` `export_jobs`; `:6271`; `:6333`).
- **X16** `services/id_register.rs:129` (`forget`), `:134` (`note_problem`), `services/cloud_mirror.rs:216` (`problem`), `:260`: the write that records or clears "there is a problem" is itself discarded on failure.
- **X17** `lib.rs:155` `let _ = id_register::run_once(...)` in the Check command: the error is dropped because the service has already stored it as a setting (X16), so the result reaches the screen only through `status()`.
- **X18** `services/dtr_sync.rs:92,111` and `state.rs:434`: `let _ =` on `CREATE TABLE IF NOT EXISTS`; `dtr_sync.rs:101` `.unwrap_or(None)` turns a read failure into "enabled".
- **X19** `services/admin_account.rs:77` and `services/id_register.rs:326-330`: unreadable JSON in a setting becomes an empty map/set (`.ok()` + `unwrap_or_default`), so a corrupt `id_register_seen` forgets every deleted intern.
- **X20** `services/cloud_mirror.rs:420-424`: `status()` reports 0 of 0 records when `changes` fails.
- **X21** `lib.rs:4124` `let _ = state.lan_runtime.start(...)`; `lib.rs:5441-5456` `let _ = bus.sender.send(...)`; `lib.rs:2092-2093,5971-5972,4432,4823` `let _ = app.emit(...)`.
- **X22** Client: 72 bare `catch {` blocks outside tests (`api.ts` 22, `App.tsx` 16, `ttsService.ts` 7); `api.ts` returns a fixed sentence and drops the cause in most (`:397-409,675,1061,1067,1088`). `tauri-api.ts:216` and `:237` swallow listener setup failures.

### 4c. Retries and sleeps

- **X23** `lib.rs:6563` 5-second start delay and `:6627` 30-second loop sleep; `:6616` `pass % 4` for the register; all literals inside `run()`.
- **X24** `lib.rs:4885` `for _ in 0..20` drain cap in `admin_sync_now` (command is unused, S5).
- **X25** `lib.rs:4026` 400 ms sleep on a spawned thread before `app.restart()`.
- **X26** `services/dtr_sync.rs:2963,3280` and `services/dtr_recon.rs:519`: fixed 1000 ms pacing sleeps; `dtr_sync.rs:1537-1541` budgeted retry sleep; `dtr_sync.rs:3901,4002` 1 ms thread sleeps.
- **X27** `lifecycle.rs:24,64,68`: 150/200/500 ms sleeps in the single-instance socket loop.
- **X28** `api.ts:98-116` `pollVoiceClipReady`: 2 s polling for up to 120 s; `api.ts:256` 15 s scan timeout; `App.tsx:455` 1 s session-check interval.

### 4d. Test-only code and switches in production paths

- **X29** `#[allow(dead_code)]` in production sources: `lan_server.rs:105,107`; `sheets_sync.rs:37,1679,1819,1991`; `config.rs:179,202`; `scanner.rs:16,21,91,106`; `dtr_sync.rs:68,70,1795`; `sync_retry.rs:40` (15 sites; see S7, S13, S15).
- **X30** `config.rs:130-141` `DTR_ENV_TEST_LOCK` / `dtr_env_test_guard` (`#[cfg(test)]` in the config module, used from `dtr_sync` tests): tests share process environment variables with the code under test.
- **X31** `state.rs:451-…` `OWN_GUARD_STARTED_AT`: a process-global map keyed by the address of an `AtomicBool`, whose comment says it exists so parallel tests do not collide.
- **X32** `lib.rs:6436-6437`: `tauri_plugin_mcp_bridge` only under `debug_assertions`; `client/src/mcp-bridge-helper.ts` (197 lines) is imported by `main.tsx` in every build.
- **X33** No `#[ignore]`, `it.skip`, `describe.skip` or `.only` was found in Rust, client, shared or server tests.

---

## Candidate root fixes

Ordered by how many listed problems each removes. "Risk" is risk of changing behaviour. Test counts are grep counts of test attributes or `it(` calls, not a run.

### R1. Typed command boundary with one error enum (generate the TS side)

Give each command a `#[derive(Serialize)]` response struct and one `enum CommandError` serialised as `{code, message}`; generate TS types and the invoke table from Rust (for example `tauri-specta` or `ts-rs`), and map code to sentence in exactly one client table.

- Removes: H17, H18, H19, H20, H21 (the parts that match text), H24, H25, H26, H27, H28, H29, H30, S23, S35, X8, X10, X14, most of X22; makes S1 to S6 visible at compile time.
- Risk: medium. Wire shape changes for every command at once unless done area by area; user-facing sentences may change where four variants collapse into one.
- Covered by: `client/src/api.test.ts` (40 tests) and `App.test.tsx` (163) mock `tauriApi` with hand-written JSON, so they would not catch a Rust-side shape change; Rust `lib.rs` tests (70 test attributes) assert on `serde_json::Value` fields. No test today crosses the boundary; `scripts/verify-tauri-mcp.mjs` is the only end-to-end check and needs a running app.

### R2. Split `lib.rs` by area and put the session guard and the "attendance changed" tail in one place each

One module per area (`commands/kiosk.rs`, `users.rs`, `attendance.rs`, `bathroom.rs`, `payroll.rs`, `exports.rs`, `backup.rs`, `lan.rs`, `session.rs`, `sync.rs`), with: an `AdminToken` extractor (or a single `require_admin` call) so the guard cannot be forgotten; one `after_attendance_change(tx, change)` function owning pricing, queue rows, DTR, LAN publish, Tauri event and audit; one `audit(event, …)` helper; one `user_json`/`attendance_json`/`bathroom_json`. Move `save_user`, `upsert_user_record`, `delete_user_and_cascade` into a `users` service so `id_register` and `cloud_mirror` stop importing from the crate root.

- Removes: H42, H44, H45 (with a guard object that releases on drop), H46, H47, H50, H51, N1, N12, N15, N16, S12, S32, X1 to X4 (become local), X15 (audit part), X21.
- Risk: low for the move itself (mechanical), medium for unifying the four attendance tails because today they differ (edit and delete do not emit the Tauri event; scan skips `enqueue_later_weekly_intern_dtr`). Decide which differences are intended before merging them.
- Covered by: the `lib.rs` test module (scan, edit, backdate, delete, unlock, user save paths; 70 test attributes) plus `dtr_sync.rs` (74) and `sheets_sync.rs` (41) for the queue. These run only with `cargo test --lib`, which `docs/testing/rust-test-parity.md` says cannot start on some Windows developer machines, so CI is the safety net.

### R3. One owner for the intern pay rule; the client shows what Rust computed

Have Rust return, per attendance row, `arrivalStatus`, `graceUsed`, `payableTimeIn` and the policy version (the scan answer already carries `arrivalStatus`, `lib.rs:6001`), and return cutoff period bounds from a Rust function. Delete the client re-derivations and the TS evaluators once the legacy server is gone (R5), or generate the constants into shared from Rust.

- Removes: H1, H2, H3 (including the drift at `App.tsx:8346`), H4, H5, H6, H7, H8, H16, N17, S28 (client half).
- Risk: medium to high. This is payroll display; the admin attendance screen's clamp marks will change for dates from 2026-11-16 because the client copy is currently behind Rust. Needs the owner to confirm the Rust behaviour is the intended one.
- Covered by: Rust engine tests are strong (`intern_payroll.rs` 44, `cutoff_payroll.rs` 16, isolated targets `intern_payroll_isolated` 6, `payroll_hours_accuracy` 5, `cutoff_freeze` 2, golden fixture pinned on both sides). Client: `payroll.test.tsx` (64), `shared/api-contracts.test.ts` (30) test the TS copy against itself, not against Rust.

### R4. A `firebase` client module and a `settings` module under the three new services

`services/firebase.rs`: `Endpoints`, `http`, `ask`, `Answer`, `sign_in_with_password` (returning a typed refusal used by both `id_register` and `admin_account`), `count(collection, filter)`, and the test fake. `services/settings.rs`: `get/put/delete/get_json/put_json` and a single list of keys. Rename `admin_pin.rs` to what it is now (unlock guard + password hash). Give the backup its own schedule entry in the background loop instead of riding inside `id_register::run_once`, and split `RegisterStatus` from `BackupStatus` at the command level.

- Removes: H22, H31 (the `cloud_mirror` half, if `TABLES` is checked against the schema in a test), H34 (once backup exclusions reference the two file names), H36, H37, H48, N2, N3, N4, N5, N18, S16, S20, S34, X16, X17, X19.
- Risk: low. These three services were added in the last 60 commits, have their own tests, and the change is moving code plus two renames. The one behavioural choice is whether signing the register out should still stop the backup.
- Covered by: `id_register.rs` (7 tests), `cloud_mirror.rs` (10), `admin_account.rs` (5), `tests/admin_pin_isolated.rs` (3, must follow the rename because it `include!`s the file), `client/src/id-register-panel.test.tsx` (9), `account-sign-in.test.tsx` (7).

### R5. Decide the legacy web path: remove `server/` and the HTTP branches, or move them behind one adapter

`README.md:316` says the Node server is not shipped. Removing it and the `fetch` branches leaves `api.ts` with one transport; if browser development must stay, put the HTTP client in its own file implementing the same interface as `tauriApi`.

- Removes: N9, N10, N11 (with one error-mapping layer), H14 (second mapping), H19 (server-only codes), H53, S9, S25, S24 (dev PIN wiring), S22 partly, and about half of `api.ts` (58 branches).
- Risk: low for the desktop app (the branches are unreachable there). It ends browser-only development against `npm run dev` and deletes `server/test` (about 180 tests) unless the adapter route is taken.
- Covered by: `api.test.ts` exercises both branches by toggling `__TAURI_INTERNALS__`; those HTTP-branch tests go with the code.

### R6. Finish the two removals already decided (shared PIN, employee scope) and the scanner stub

Delete S1 to S6 commands and wrappers, S7 (or implement it), S8 to S15, S17 to S21, S26 to S31, S36; rename the `pin` vocabulary (S22) to "card or code".

- Removes: all of section 3 except S32 to S35, plus H9 (one copy of the card rule goes), H13 (unused config), X5 (if the config back door is given its own name), X24, X29.
- Risk: low for dead commands, scripts and docs. Medium for the `is_intern` `else` arms and payroll profiles: they are unreachable only as long as no `EMPLOYEE` row exists, so check the production database first; a finalized employee cutoff from before migration 0019 would still be read by `payroll_cutoff_json` (`lib.rs:2465,2486`).
- Covered by: for dead commands, nothing needs to cover them (some `lib.rs` tests call `admin_unlock`-style helpers directly and would be deleted with them); for payroll branches, `lib.rs:7586` has a test that still prices an employee input through `cutoff_payroll::calculate`.

### R7. Split `App.tsx` along the same areas as R2

Move `SetupDialog`, `LiveAttendance`/`LanViewerPanel`, `AdminPanel`, `DatabasePanel`, `UserEditor`, `PayrollWorkspace` + payroll tables, `AdminAttendance` into files; one `useAdminSession` hook owning the token (replacing the module global and `setupToken`); one unlock component used by both the kiosk dialog and the Admin panel; one `useCardReader` hook for the key handler.

- Removes: H43, H50 (client half), H52, X11, X12 (isolated in the hook), N11.
- Risk: low to medium. Mostly moves; the session change alters when the kiosk setup dialog and the Admin panel log each other out (H43), which should be decided on purpose.
- Covered by: `App.test.tsx` (163 tests) imports from `./App` and several other test files import `DatabasePanel`, `UserEditor`, `PayrollWorkspace`, `SystemPanel` from it (`database-panel.test.tsx` 68, `payroll.test.tsx` 64), so imports change but behaviour tests stay valid.
