# State machines

Every explicit and implicit state machine in the app, the rules they must keep, and the bugs found by checking which invalid states the code can actually reach. Written 2026-11-06 from a full-repo hunt; line numbers are from that commit.

**Labels.** *Fixed*: a regression test reached the invalid state on the old code and passes now. *Open*: confirmed, not fixed yet (reason given). *Decision*: confirmed, but the fix needs a product call. *Suspected*: plausible; the note says what would confirm it.

**Impact.** 1 money, payroll, data loss or security · 2 someone stuck or shown wrong data · 3 recoverable glitch · 4 cosmetic.

## Machines

### M1 Attendance day (one row per person per Manila date)

`src-tauri/src/lib.rs`: scan `scan_rfid_impl` :5372 (time-in INSERT :5529, time-out UPDATE :5573), admin correction :1531, admin delete :1935, backdated create :1695. Schema `UNIQUE(user_id, attendance_date)` in `src-tauri/db/migrations/0001_core.sql`.

States: NONE · WORKING (time_in set, time_out NULL) · COMPLETED · LATE_TIMEOUT (time-out at/after 18:00) · MISSED (time_in NULL, admin-made).

Invariants: a COMPLETED/LATE_TIMEOUT day has exactly one payroll row; a correction never overwrites a value it did not see; a day inside a FINALIZED cutoff does not change (only enforced for backdated create, see D2).

| From | Event | Guard | To | Side effects | Code |
| --- | --- | --- | --- | --- | --- |
| NONE | scan | active user, debounce passes | WORKING | queue Attendance + InternDtr UPSERT | lib.rs:5529 |
| WORKING | scan | 10 s debounce; `time_out IS NULL` and revision match | COMPLETED / LATE_TIMEOUT | payroll in the same tx | lib.rs:5573, :5772 |
| COMPLETED / LATE / MISSED | scan | — | rejected | — | lib.rs:5555, :5577 |
| any | admin correction | stored times equal the editor's expected times | by times set | payroll rebuilt in the same tx | lib.rs:1531, :1579 |
| any | admin delete | — | NONE | payroll + grace deleted in one tx; Sheets DELETEs queued | lib.rs:1935 |
| NONE (past) | backdated create | no FINALIZED cutoff covers the date | WORKING / COMPLETED / LATE | — | lib.rs:1793 |

Invalid states the variables allow: MISSED with a time-out (D4); WORKING forever after a time-in past 17:00 (D3); a day changed inside a FINALIZED cutoff (D2).

### M2 Scan debounce (in memory)

`src-tauri/src/state.rs:190`, `lib.rs:5487`. Per card: `fast` (500 ms, stamped before the write) and `slow` (10 s, stamped after a successful write). Cleared by restart. Admin-assisted scans key on the target's card.

### M3 Bathroom key (per gender)

`lib.rs`: scan `process_bathroom_scan` :1263, admin edit `bathroom_update_log_impl` :1086. Partial unique index allows one OUT row per gender (`0015_bathroom_guard_on_time_in.sql`).

States: FREE · OUT (row with `time_in IS NULL`) · RETURNED log rows.

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| FREE | scan / admin checkout | unique OUT index | OUT | lib.rs:1263 |
| OUT | scan / admin return | `time_in IS NULL` | RETURNED | lib.rs:1263 |
| any | admin edit | row `updated_at` = the one the dialog opened | OUT / RETURNED | lib.rs:1230 |

### M4 Payroll cutoff

`lib.rs`: generate :2591, finalize `payroll_finalize_cutoff_impl` :3202, delete :3243; frozen-days rule :5916.

States: DRAFT · FINALIZED (with snapshot). Invariants: never FINALIZED without a snapshot; **a day belongs to at most one FINALIZED cutoff per person** (now enforced, F1).

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| — | generate | person has no FINALIZED cutoff with the same dates | DRAFT (old drafts replaced) | lib.rs:2591 |
| DRAFT | finalize | `status='DRAFT'` and no overlapping FINALIZED cutoff | FINALIZED + snapshot (one tx) | lib.rs:3202, :3217 |
| any | delete | — | gone (snapshot + cutoff in one tx) | lib.rs:3243 |

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
| PENDING / RETRY / DEAD | admin retry | not SYNCED or PROCESSING | PENDING | lib.rs:4690 |

### M6 Shared sync guard

`src-tauri/src/state.rs:415` (acquire) / :449 (release): an `AtomicBool` plus a persisted owner row. Taken by the background tick (lib.rs:6256), Sync now (:4719), DTR sync (:4810) and nuke-and-resync (:4898).

### M7 DTR throttle and pending backfill

`sync_retry.rs:339` bucket (50 writes and 10 calls per 60 s window); `trim_to_throttle_window` :315; backfill `dtr_sync.rs:2779`; `dtr_pending` rows processed at :2827. A pending person is cleared only after a complete backfill.

### M8 DTR reconciliation run

`src-tauri/src/services/dtr_recon.rs`: scheduler :355, run :414, failure :730, boot reclaim :401, retry gap :391. States: RUNNING → COMPLETED | FAILED; `last_recon_week` set only on COMPLETED. Invariant: no run stays RUNNING once its process ended.

### M9 Restore request and backups

`src-tauri/src/database.rs`: `process_restore_request` :485, `restore_portable_backup` :621, `prune_backups` :375. Marker `restore.request` → startup restore → `restore.failed` or removed. Invariants: Failed means the live database is untouched; pruning keeps the newest 10 regular backups and the newest 10 pre-restore snapshots separately.

### M10 Admin session and setup unlock

Rust: one global session slot `state.rs:193`, unlock `lib.rs:3988`, check `lib.rs:5259`. Client: setup dialog `client/src/App.tsx:531` / close :569 (attempt counter :354), admin page unlock :3695.

States: locked · unlocking · unlocked(token, expiry). Invariant: closing setup leaves it locked, even if an unlock answers afterwards.

### M11 Kiosk scan pipeline (client)

`client/src/App.tsx`: `KioskState` :232 (ready · processing · success · error), refs `scanInFlightRef`, `resetTimer`, scan sequence :332, assisted confirm :866. Invariant: only the newest scan writes the screen, the voice and the reset timer.

### M12 Offline scan queue (browser / legacy server mode only)

`client/src/network.ts` (localStorage `alpha_premier_offline_scans`), replay `App.tsx:465`, `submitScan` `client/src/api.ts:249`. Item: queued → replaying → removed. Invariants: one replay pass at a time; a replay never re-queues; taps replay in order.

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

### Decision (confirmed, needs a product call)

| # | Impact | Bug | Options |
| --- | --- | --- | --- |
| D1 | 1 | Admin PIN unlock has no attempt limit (`lib.rs:3988`); config PINs can be 4 digits | lock after N wrong PINs for M minutes, persisted in `app_settings` |
| D2 | 2 | Attendance inside a FINALIZED cutoff can be edited or deleted (only backdated create checks), and deleting a user hard-deletes their FINALIZED cutoffs and snapshots | refuse, or allow with an audit note; keep or delete approved pay on user delete |
| D3 | 2 | Time-in after 17:00 cannot be closed at or after 18:00: payroll validation fails and the scan rolls back on every tap | refuse time-in after 17:00, or record LATE_TIMEOUT and leave payroll to the correction |
| D4 | 2 | No minimum time between time-in and time-out (a second tap after 10 s closes the day); admin clearing time-in makes MISSED and the scan then refuses the person | minimum minutes before a time-out; reject clearing time-in while a time-out exists |
| D5 | 2 | DTR kill switch drops new punches while paused, and on resume pushes payloads frozen at pause time | queue while paused (dispatch is already gated) or keep dropping |
| D6 | 1 (browser mode) | An offline-queued scan is recorded at replay time, not tap time (`ScanRequest` has no timestamp) | add `capturedAt` to the contract (server trusts the kiosk clock), or stop queueing attendance offline |

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
