# State machines

Every explicit and implicit state machine in the app, the rules they must keep, and the bugs found by checking which invalid states the code can actually reach. Written 2026-11-06 from a full-repo hunt and updated the same day with the owner's decisions D1–D7; line numbers are from that commit.

**Labels.** *Fixed*: a regression test reached the invalid state on the old code and passes now. *Open*: confirmed, not fixed yet (reason given). *Decision*: confirmed, but the fix needs a product call. *Suspected*: plausible; the note says what would confirm it.

**Impact.** 1 money, payroll, data loss or security · 2 someone stuck or shown wrong data · 3 recoverable glitch · 4 cosmetic.

## Machines

### M1 Attendance day (one row per person per Manila date)

`src-tauri/src/lib.rs`: scan `scan_rfid_at` :5422 (time-in INSERT :5579, time-out UPDATE :5634), admin correction :1552, admin delete :1954, backdated create :1723, frozen-day check `day_in_finalized_cutoff` :1536. Schema `UNIQUE(user_id, attendance_date)` in `src-tauri/db/migrations/0001_core.sql`.

States: NONE · WORKING (time_in set, time_out NULL) · COMPLETED · LATE_TIMEOUT (time-out at/after 18:00) · MISSED (time_in NULL, admin-made).

Invariants: a COMPLETED day has exactly one payroll row (a LATE_TIMEOUT day has one unless the engine cannot price it, D3); a correction never overwrites a value it did not see; no admin create, edit or delete touches a day inside a FINALIZED cutoff (kiosk scans are not blocked); a time-out is at least 1 minute after the time-in; a day always keeps its time-in.

| From | Event | Guard | To | Side effects | Code |
| --- | --- | --- | --- | --- | --- |
| NONE | scan | active user, debounce passes | WORKING | queue Attendance + InternDtr UPSERT (even while DTR upload is off) | lib.rs:5579 |
| WORKING | scan < 1 min after time-in | — | WORKING (rejected as DUPLICATE_SCAN) | — | lib.rs:5614 |
| WORKING | scan | 10 s debounce; `time_out IS NULL` and revision match | COMPLETED / LATE_TIMEOUT | payroll in a savepoint of the same tx; a LATE_TIMEOUT the engine cannot price is kept without payroll | lib.rs:5634, :5648, :5855 |
| COMPLETED / LATE / MISSED | scan | — | rejected | — | lib.rs:5600, :5605 |
| any | admin correction | stored times equal the editor's expected times; neither the old nor the new date is in a FINALIZED cutoff; the result keeps a time-in | WORKING / COMPLETED / LATE | payroll rebuilt in the same tx | lib.rs:1552, :1600, :1627, :1647 |
| any | admin delete | date not in a FINALIZED cutoff | NONE | payroll + grace deleted in one tx; Sheets DELETEs queued | lib.rs:1954, :2008 |
| NONE (past) | backdated create | no FINALIZED cutoff covers the date | WORKING / COMPLETED / LATE | — | lib.rs:1812 |

Invalid states left: none reachable. MISSED could only come from a correction that cleared the time-in, which is now refused (D7); a MISSED row made before that can be fixed by entering a time-in, or deleted.

### M2 Scan debounce (in memory)

`src-tauri/src/state.rs:190`, `lib.rs:5536`. Per card: `fast` (500 ms, stamped before the write) and `slow` (10 s, stamped after a successful write). Cleared by restart. Admin-assisted scans key on the target's card.

### M3 Bathroom key (per gender)

`lib.rs`: scan `process_bathroom_scan` :1265, admin edit `bathroom_update_log_impl` :1088. Partial unique index allows one OUT row per gender (`0015_bathroom_guard_on_time_in.sql`).

States: FREE · OUT (row with `time_in IS NULL`) · RETURNED log rows.

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| FREE | scan / admin checkout | unique OUT index | OUT | lib.rs:1265 |
| OUT | scan / admin return | `time_in IS NULL` | RETURNED | lib.rs:1265 |
| any | admin edit | row `updated_at` = the one the dialog opened | OUT / RETURNED | lib.rs:1232 |

### M4 Payroll cutoff

`lib.rs`: generate :2620, finalize `payroll_finalize_cutoff_impl` :3231, delete :3272; frozen-days rule :5999; user delete keeps FINALIZED cutoffs :590.

States: DRAFT · FINALIZED (with snapshot). Invariants: never FINALIZED without a snapshot; **a day belongs to at most one FINALIZED cutoff per person** (F1); a FINALIZED cutoff and its snapshot outlive the person (D2).

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| — | generate | person has no FINALIZED cutoff with the same dates | DRAFT (old drafts replaced) | lib.rs:2620 |
| DRAFT | finalize | `status='DRAFT'` and no overlapping FINALIZED cutoff | FINALIZED + snapshot (one tx) | lib.rs:3231, :3246 |
| any | admin delete | — | gone (snapshot + cutoff in one tx) | lib.rs:3272 |
| DRAFT | user deleted | — | gone | lib.rs:590 |
| FINALIZED | user deleted | — | kept, with its snapshot | lib.rs:590 |

### M5 Sync queue row (`sync_queue`)

`src-tauri/src/services/sheets_sync.rs`: enqueue `requeue_sync_row` :2456, batch read :2586, claim :2687, done :2794, lease recovery :852. Backoff `sync_retry.rs:427`. One row per `table:row_id:op`.

States: PENDING · RETRY · PROCESSING · SYNCED · DEAD.

Invariants: the payload pushed is the payload claimed; per remote row the newest intent (UPSERT or DELETE) lands last.

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| any | enqueue same op | — | PENDING, new payload, attempts 0 | sheets_sync.rs:2456 |
| unapplied opposite op | enqueue | — | SYNCED, `last_error_code='SUPERSEDED'` | sheets_sync.rs:2473 |
| PENDING / RETRY | tick claims (reads payload in the same statement) | status still waiting | PROCESSING | sheets_sync.rs:2687 |
| PROCESSING | push ok | still PROCESSING | SYNCED | sheets_sync.rs:2794 |
| PROCESSING | transient error | — | RETRY (attempts unchanged) | sheets_sync.rs:2821 |
| PROCESSING | finite error | — | RETRY, or DEAD at 5 strikes | sync_retry.rs:427 |
| PROCESSING | lease older than 5 min | — | RETRY | sheets_sync.rs:852 |
| PENDING / RETRY / DEAD | admin retry | not SYNCED or PROCESSING | PENDING | lib.rs:4727 |

### M6 Shared sync guard

`src-tauri/src/state.rs:415` (acquire) / :449 (release): an `AtomicBool` plus a persisted owner row. Taken by the background tick (lib.rs:6339), Sync now (:4756), DTR sync (:4847) and nuke-and-resync (:4935).

### M7 DTR throttle and pending backfill

`sync_retry.rs:339` bucket (50 writes and 10 calls per 60 s window); `trim_to_throttle_window` :315; backfill `dtr_sync.rs:2779`; `dtr_pending` rows processed at :2827. A pending person is cleared only after a complete backfill. The per-PC upload switch only pauses dispatch: InternDtr rows are still queued (and updated) while it is off (`enqueue_intern_dtr` lib.rs:5337), so switching it back on pushes current data (D5).

### M8 DTR reconciliation run

`src-tauri/src/services/dtr_recon.rs`: scheduler :355, run :414, failure :730, boot reclaim :401, retry gap :391. States: RUNNING → COMPLETED | FAILED; `last_recon_week` set only on COMPLETED. Invariant: no run stays RUNNING once its process ended.

### M9 Restore request and backups

`src-tauri/src/database.rs`: `process_restore_request` :485, `restore_portable_backup` :621, `prune_backups` :375. Marker `restore.request` → startup restore → `restore.failed` or removed. Invariants: Failed means the live database is untouched; pruning keeps the newest 10 regular backups and the newest 10 pre-restore snapshots separately.

### M10 Admin session and setup unlock

Rust: one global session slot `state.rs:193`, unlock `lib.rs:4017`, check `lib.rs:5296`, wrong-PIN guard `services/admin_pin.rs:73` (stored in `app_settings`). Client: setup dialog `client/src/App.tsx:531` / close :569 (attempt counter :354), admin page unlock :3695.

States: locked · unlocking · unlocked(token, expiry) · PIN locked out (5 wrong PINs in a row → 5 minutes; survives a restart; admin cards still unlock; any success resets the count). Invariants: closing setup leaves it locked, even if an unlock answers afterwards; while locked out a PIN is never checked.

### M11 Kiosk scan pipeline (client)

`client/src/App.tsx`: `KioskState` :232 (ready · processing · success · error), refs `scanInFlightRef`, `resetTimer`, scan sequence :332, assisted confirm :866. Invariant: only the newest scan writes the screen, the voice and the reset timer.

### M12 Offline scan queue (drain-only)

Attendance is never saved offline any more (D6): `submitScan` (`client/src/api.ts:251`) rethrows a network failure, so the kiosk shows its "Can't reach the system" card and the person taps again. `client/src/network.ts` and the replay in `App.tsx:465` only drain items an older version saved (localStorage `alpha_premier_offline_scans`). Item: saved by an old version → replaying → removed. Invariants: nothing new is ever queued; one replay pass at a time; taps replay in order.

### M13 DTR sync progress → client guard

Backend emits `starting` · `syncing` · `completed` (`dtr_sync.rs:3383`); typed as `DtrSyncProgressStatus` in `client/src/tauri-api.ts`; mapped at `App.tsx:4167` onto `client/src/dtr-sync-guard.ts`.

Checked and sound: voice job queue (`voice_pull.rs`, conditional finishes plus a 30-minute reclaim), server `KeyedMutex`, `list-load.tsx`, the backup single-flight, and the update banner's check-versus-install guard.

## Issues by root cause

### Fixed (regression test fails on the old code, passes now)

| # | Impact | Root cause → bug | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | 1 | Finalize checked only `status='DRAFT'` → an overlapping custom range paid finalized days twice | finalize refuses an overlap with another FINALIZED cutoff for the person | `lib.rs` `finalize_refuses_overlapping_finalized_cutoff` |
| F2 | 1 | `expectedTimeOut: null` fell back to the fresh DB value → a stale WORKING draft erased a new time-out and its payroll | explicit null means "was empty" | `admin_update_partial_payload_coalesces` (step 6) |
| F3 | 1–2 | Claim used the batch snapshot → older payload pushed and the newer edit marked SYNCED; stale `attempts` sent a fresh row DEAD | claim `… RETURNING payload_json, attempts` | `sheets_sync` `sync_claim_pushes_the_payload_requeued_after_the_batch_read` |
| F4 | 2 | UPSERT and DELETE rows are independent → a DELETE could land before a retrying UPSERT and the row came back | enqueue retires the unapplied opposite op; admin retry skips SYNCED | `delete_supersedes_an_unapplied_upsert_and_the_reverse` |
| F5 | 1 | Restore swapped the DB first; a later config/data error said "nothing replaced" with the old `-wal` beside the new DB | data and config first, one rename last | `database` `failed_portable_restore_keeps_the_current_database` |
| F6 | 1 | One sorted prune list → 10 `pre-restore-*` snapshots made every new backup delete itself | each family keeps its own 10 | `prune_backups_never_deletes_the_new_backup_behind_safety_snapshots` |
| F7 | 2 | `GOOGLE_OAUTH_TRANSPORT` and DTR clear 429/5xx classified finite → rows DEAD after ~2.5 min offline | transient marker; clear goes through `dtr_call_with_retry` | `sync_retry` `transient_classifier` (the clear path has no URL seam; it reuses the tested helper) |
| F8 | 2 | Backfill asked the bucket for all writes at once → >50 days denied in every window, intern pending forever | write ≤50 per pass, stay incomplete | `oversized_backfill_is_trimmed_to_an_admissible_slice` |
| F9 | 1 | Setup closed mid-unlock reopened unlocked when the unlock answered | attempt counter; a stale unlock is locked | `App.test.tsx` "keeps setup closed and locked when it was closed while the unlock was still in flight" |
| F10 | 2 | Client cleared the sync guard on `done`/`complete`, backend sends `completed` → "Sync already running" until reload | typed status union | `database-panel.test.tsx` "clears the sync guard when the backend reports …" |
| F11 | 2 | Assisted confirm queued offline matched no branch → modal open, every scan blocked | offline branch closes the modal | `App.test.tsx` "closes the Assisted Attendance modal and shows Saved offline …" |
| F12 | 2 | `unlockAdmin` threw in browser mode → busy stuck, Unlock disabled | never throws | `api.test.ts` "reports an unreachable or garbled unlock …" |
| F13 | 2 | Bathroom log had no request id → an older date's slow answer showed under the newer date | newest load wins | `bathroom-key-log.test.tsx` "shows the date picked last …" |
| F14 | 1 (browser mode) | Replay re-queued on failure, had no single-flight, kept rejected items forever, ran only on `online` | single-flight, no re-queue, stop at first unreachable (keeps order), drop answered items, also at start | `App.test.tsx` "replays the offline queue without duplicating items …" |
| F15 | 3 | Slow time-in greeting resumed after the next scan → spoke over it and re-armed its reset | scan sequence check after the await | `App.test.tsx` "does not let a slow time-in announcement talk over …" |
| F16 | 1 (rare) | User delete ran each DELETE on its own with errors ignored → partial delete left the user with data gone | one transaction, every statement checked | `user_deletion_is_all_or_nothing` |
| F17 | 3 | Cutoff delete in two statements → FINALIZED cutoff without its snapshot | one transaction | `cutoff_delete_never_leaves_a_finalized_cutoff_without_its_snapshot` |
| F18 | 3 | Attendance delete read payroll/grace ids before its transaction → a time-out committing in between lost its Sheets DELETE | reads inside the transaction | structural (no seam for the interleaving); existing delete tests pass |
| F19 | 2 | Bathroom admin edit wrote unconditionally → a key returned while the dialog was open flipped back to OUT | optimistic `updated_at`; dialog sends `expectedUpdatedAt` | `bathroom_edit_rejects_dates_outside_log_date` (stale-save steps) |
| F20 | 3 | Nuke-and-resync skipped the sync guard → an in-flight push landed after the wipe | takes the guard | `nuke_and_resync_waits_for_a_running_sync` |
| F21 | 3 | `?` exits left recon runs RUNNING; failed scheduled runs retried every 30 s tick (≈720 FAILED rows + audits per Friday) | wrapper closes every failure once; boot reclaim; 30-min retry gap | `a_run_cut_off_by_closing_the_app_is_closed_as_failed_at_boot`, `scheduled_retries_wait_after_an_attempt`, `a_failed_run_is_recorded_once_and_never_left_running` |
| F22 | 1 | D1: admin PIN unlock had no attempt limit | 5 wrong PINs in a row lock PIN unlock for 5 min, stored in `app_settings`; admin cards still work | `admin_pin_lockout_after_five_wrong_pins_survives_a_restart`; `api.test.ts` "says PIN unlock is paused …" |
| F23 | 2 | D2: admin could edit, move into or delete a day inside a FINALIZED cutoff; user delete erased approved pay | refuse with ATTENDANCE_IN_FINALIZED_CUTOFF; user delete keeps FINALIZED cutoffs and snapshots | `finalized_cutoff_freezes_its_days_and_outlives_the_user`; `api.test.ts` "explains that a day in a finalized payroll cutoff …" |
| F24 | 2 | D3: time-in after 17:00 could never be timed out (payroll validation failed and rolled back every tap) | payroll in a savepoint; an unpriceable LATE_TIMEOUT is kept without payroll for the admin correction | `scan_records_unpriceable_time_out_as_late_without_payroll` |
| F25 | 2 | D4: a second tap 10 s after time-in closed the day | taps < 1 min after the stored time-in are DUPLICATE_SCAN | `scan_needs_a_minute_between_time_in_and_time_out` |
| F26 | 2 | D5: with DTR upload off, new punches were not queued, and on resume the stale queued payloads were pushed | queue while off; only dispatch pauses | `dtr_upload_off_keeps_queuing_and_resumes_with_current_data` |
| F27 | 1 | D6: a scan saved offline was recorded at replay time, not tap time | never save attendance offline; unreachable shows "Can't reach the system"; old saved items still drain | `App.test.tsx` "never saves attendance offline …", "keeps the Assisted Attendance modal open … unreachable"; `api.test.ts` "reports an unreachable service … saves nothing offline" |
| F28 | 2 | D7: clearing a day's time-in made it MISSED and the scan then refused the person | a correction must keep a time-in (ATTENDANCE_TIME_IN_REQUIRED); delete removes a day | `admin_update_keeps_a_time_in`; `api.test.ts` "explains that a correction must keep a time-in" |

### Decisions

All seven were decided on 2026-11-06 ("D1 yes, D2 refuse, D3 record, D4 1 min"; "d5 keep queuing, d6 and d7 as recommended") and are fixed as F22–F28.

### Open (confirmed, not fixed in this pass)

| # | Impact | Bug | Fix sketch |
| --- | --- | --- | --- |
| O1 | 2 | Stopping the LAN viewer leaves connected SSE clients streaming (`state.rs` stop only aborts the accept loop) | watch-channel shutdown + `with_graceful_shutdown` |
| O2 | 3 | Transient backoff never grows (attempts are not counted on the transient path, so 30–90 s forever, against the documented doubling) | separate strike column (migration) |
| O3 | 3 | `InternGrace` DELETE rows key on user id → several grace deletes for one person collapse to the last | put the grace id in the idempotency key |
| O4 | 3 | Attendance/payroll commit and their queue rows are separate writes → a crash in between never syncs the ops row (weekly recon heals the DTR sheet) | outbox: queue rows in the same transaction |
| O5 | 3 | Cutoff generate is not atomic; drafts deleted by regeneration are never sent to Sheets as deletes | one transaction; queue deletes |
| O6 | 3 | Browser-mode scan request has no timeout → kiosk can sit in "processing" | `AbortSignal.timeout` with the controller |
| O7 | 3 | Deactivating a user leaves their open day WORKING and a held bathroom key blocked | close or return on deactivate |
| O8 | 3 | VoiceStudio settings/regenerate commands have no admin-token check; "Check" saves the typed host and PIN | add `admin_authorized` |
| O9 | 3 | A LAN stop issued while the server is starting is overwritten | check a stop flag after bind |
| O10 | 3 | Legacy server: admin lock only expires the cookie; tokens stay valid | server-side revocation |
| O11 | 4 | Admin update/delete never publish to the LAN event bus (viewers stay stale until refresh); dev-only listener leaks under StrictMode | publish; `disposed` flag in listeners |

### Suspected

| # | Bug | What would confirm it |
| --- | --- | --- |
| S1 | Sync guard wedges up to 5 min if the release write fails (`sync_guard_write_row` ignores errors) | inject `SQLITE_BUSY` on release, then try Sync now |
| S2 | `ALPHA_PREMIER_RESTORE_FROM` is never cleared in-process → an in-app or updater relaunch restores the old backup again | check whether the updater relaunch inherits the app's environment |
| S3 | Reset-code attempt counter can lose updates under concurrent IPC calls (the UI serializes) | file-backed pool + `join_all` of wrong codes |
| S4 | Assisted modal's 25 s auto-cancel may stall because App re-renders every second with a new `onClose` | a fake-timer test passes; watch the countdown in the live webview (Tauri MCP) |
| S5 | Debounce is check-then-write; under DB lock contention a second tap >500 ms later records an instant time-out | hold a write tx open and fire two scans 600 ms apart |
| S6 | Moving `attendance_date` in a correction leaves the old date's DTR cells | check whether `dtr_recon` clears the old cells |
| S7 | `admin_authorized` clears the session on any token mismatch → a request still carrying the old token logs a re-unlocked admin out | race a request with the old token against a fresh unlock |
