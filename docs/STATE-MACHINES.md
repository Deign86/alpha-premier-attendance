# State machines

Every explicit and implicit state machine in the app, the rules they must keep, and the bugs found by checking which invalid states the code can actually reach. Written 2026-11-06 from a full-repo hunt and updated through 2026-11-07 with the owner's decisions (D1–D7) and the remaining fixes; line numbers are from that commit.

**Labels.** *Fixed*: a regression test reached the invalid state on the old code and passes now. *Suspected → verdict*: each suspicion was traced or tested until it was confirmed (then fixed the same way) or refuted.

**Impact.** 1 money, payroll, data loss or security · 2 someone stuck or shown wrong data · 3 recoverable glitch · 4 cosmetic.

## Machines

### M1 Attendance day (one row per person per Manila date)

`src-tauri/src/lib.rs`: scan `scan_rfid_at` :5596 (time-in INSERT :5762, time-out UPDATE :5825, one commit for the change and its sync rows :5915), admin correction :1601, admin delete :2028, backdated create :1795, frozen-day check `day_in_finalized_cutoff` :1585. Schema `UNIQUE(user_id, attendance_date)` in `src-tauri/db/migrations/0001_core.sql`.

States: NONE · WORKING (time_in set, time_out NULL) · COMPLETED · LATE_TIMEOUT (time-out at/after 18:00) · MISSED (legacy only; no path creates it any more).

Invariants: a COMPLETED day has exactly one payroll row (a LATE_TIMEOUT day too, unless the engine cannot price it); a correction never overwrites a value it did not see; a day always keeps its time-in; no admin create, edit or delete touches a day inside a FINALIZED cutoff (kiosk scans are not blocked); a time-out is at least 1 minute after the time-in; every change commits together with its Sheets/DTR sync rows.

| From | Event | Guard | To | Side effects | Code |
| --- | --- | --- | --- | --- | --- |
| NONE | scan | active user, debounce passes; a racing double tap is DUPLICATE_SCAN | WORKING | Attendance + InternDtr UPSERT queued in the same tx (even while DTR upload is off) | lib.rs:5762 |
| WORKING | scan < 1 min after time-in | — | WORKING (rejected as DUPLICATE_SCAN) | — | lib.rs:5805 |
| WORKING | scan | 10 s debounce; `time_out IS NULL` and revision match | COMPLETED / LATE_TIMEOUT | payroll in a savepoint; an unpriceable LATE_TIMEOUT is kept without payroll | lib.rs:5825, :5839, :6042 |
| COMPLETED / LATE / MISSED | scan | — | rejected | — | lib.rs:5791, :5796 |
| any | admin correction | expected times still match; neither old nor new date in a FINALIZED cutoff; keeps a time-in | WORKING / COMPLETED / LATE | payroll rebuilt; a moved day clears the old date's DTR cells | lib.rs:1649, :1676, :1696, :1779 |
| any | admin delete | date not in a FINALIZED cutoff | NONE | payroll + grace + sync DELETEs in one tx; LAN viewers told | lib.rs:2028, :2082 |
| NONE (past) | backdated create | no FINALIZED cutoff covers the date | WORKING / COMPLETED / LATE | — | lib.rs:1884 |

### M2 Scan debounce (in memory)

`src-tauri/src/state.rs:234`, `lib.rs:5711`. Per card: `fast` (500 ms, stamped before the write) and `slow` (10 s, stamped after a successful write). Cleared by restart; the 1-minute time-out minimum (M1) is checked against the stored time-in, so it survives restarts.

### M3 Bathroom key (per gender)

`lib.rs`: scan `process_bathroom_scan` :1314, admin edit `bathroom_update_log_impl` :1137. A partial unique index allows one OUT row per gender (`0015_bathroom_guard_on_time_in.sql`).

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| FREE | scan / admin checkout | unique OUT index | OUT | lib.rs:1314 |
| OUT | scan / admin return | `time_in IS NULL` | RETURNED | lib.rs:1314 |
| any | admin edit | row `updated_at` = the one the dialog opened | OUT / RETURNED | lib.rs:1281 |

### M4 Payroll cutoff

`lib.rs`: generate :2706 (one transaction from :2750), finalize `payroll_finalize_cutoff_impl` :3341, delete :3384; frozen-days rule :6186; user delete keeps FINALIZED cutoffs :629.

Invariants: never FINALIZED without a snapshot; a day belongs to at most one FINALIZED cutoff per person; a FINALIZED cutoff and its snapshot outlive the person; generation is all-or-nothing.

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| — | generate | person has no FINALIZED cutoff with the same dates | DRAFT; replaced drafts deleted locally and on the sheet | lib.rs:2706, :2750 |
| DRAFT | finalize | `status='DRAFT'` and no overlapping FINALIZED cutoff | FINALIZED + snapshot (one tx) | lib.rs:3341, :3356 |
| any | admin delete | — | gone (snapshot + cutoff in one tx) | lib.rs:3384 |
| DRAFT / FINALIZED | user deleted | — | DRAFT gone / FINALIZED kept | lib.rs:629 |

### M5 Sync queue row (`sync_queue`)

`src-tauri/src/services/sheets_sync.rs`: enqueue `requeue_sync_row` :2456 / `requeue_sync_row_on` :2480 (savepoint on the caller's transaction), supersede :2505, batch read :2622, claim :2723, done :2831, failure step :2858, lease recovery :852. Failure policy `sync_retry.rs` `next_failure_step` :480 over `calculate_retry_backoff` :427. Idempotency key `lib.rs` `sync_idempotency_key` :5459 (`table:row:op`, plus the grace id for InternGrace DELETEs).

States: PENDING · RETRY · PROCESSING · SYNCED · DEAD. Counters: `attempts` (finite budget, DEAD at 5) and `transient_strikes` (429/5xx/transport backoff, never DEAD).

| From | Event | Guard | To | Code |
| --- | --- | --- | --- | --- |
| any | enqueue same op (in the writer's transaction) | — | PENDING, new payload, counters 0 | sheets_sync.rs:2480 |
| unapplied opposite op | enqueue | — | SYNCED, `last_error_code='SUPERSEDED'` | sheets_sync.rs:2505 |
| PENDING / RETRY | tick claims and reads the payload in one statement | still waiting | PROCESSING | sheets_sync.rs:2723 |
| PROCESSING | push ok | still PROCESSING | SYNCED | sheets_sync.rs:2831 |
| PROCESSING | transient error | — | RETRY, strikes+1, 60 s doubling to 960 s | sheets_sync.rs:2858 |
| PROCESSING | finite error | — | RETRY, or DEAD at 5 attempts | sync_retry.rs:480 |
| PROCESSING | lease older than 5 min | — | RETRY | sheets_sync.rs:852 |
| PENDING / RETRY / DEAD | admin retry | not SYNCED or PROCESSING | PENDING | lib.rs:4841 |

### M6 Shared sync guard

`src-tauri/src/state.rs` acquire :465, release :507: an in-process `AtomicBool` plus a persisted owner row (a weak cross-process guard; the single-instance check can fall back to running). Taken by the background tick (lib.rs:6529), Sync now (:4870), DTR sync (:4961) and nuke-and-resync (:5049). The process remembers the row it last wrote (`OWN_GUARD_STARTED_AT` :458), so its own leftover from a failed release write is claimed instead of blocking syncs for 5 minutes.

### M7 DTR throttle, pending backfill and upload switch

`sync_retry.rs:339` bucket (50 writes and 10 calls per 60 s); `trim_to_throttle_window` :315; backfill `dtr_sync.rs:2779`; `dtr_pending` processed at :2827. A pending person is cleared only after a complete backfill. The per-PC upload switch only pauses dispatch: InternDtr rows are still queued and updated while it is off (`enqueue_intern_dtr` lib.rs:5507).

### M8 DTR reconciliation run

`src-tauri/src/services/dtr_recon.rs`: scheduler :355, run :414, failure :730, boot reclaim :401, scheduled-retry gap :391. States: RUNNING → COMPLETED | FAILED; `last_recon_week` set only on COMPLETED. No run stays RUNNING once its process ended; a failing scheduled run retries every 30 minutes, not every tick.

### M9 Restore request and backups

`src-tauri/src/database.rs`: `process_restore_request` :485 (the `ALPHA_PREMIER_RESTORE_FROM` variable is removed once read, :498), `restore_portable_backup` :625, `prune_backups` :375. Failed means the live database is untouched; pruning keeps the newest 10 regular backups and the newest 10 pre-restore snapshots separately; a relaunch never repeats an environment-requested restore.

### M10 Admin session, setup unlock and PIN reset

Rust: one global session slot `state.rs:237`, unlock `lib.rs:4131`, check `admin_authorized` :5419 (`require_admin` :5411), wrong-PIN guard `services/admin_pin.rs` :73/:81 (stored in `app_settings`), reset code `complete_reset` :296. Client: setup dialog `client/src/App.tsx:529` / close :567 (attempt counter :351), admin page unlock :3636.

States: locked · unlocking · unlocked(token, expiry) · PIN locked out (5 wrong PINs in a row → 5 minutes; survives a restart; admin cards still unlock; any success resets the count). Invariants: closing setup leaves it locked even if an unlock answers afterwards; while locked out a PIN is never checked; a stale or empty token is refused but never ends a live session (only expiry does); wrong-PIN and reset-code attempts are counted in single SQL statements, so concurrent guesses all count.

### M11 Kiosk scan pipeline (client)

`client/src/App.tsx`: `KioskState` :232 (ready · processing · success · error), scan sequence :326, assisted confirm :857 (stable `closeAssist` :345). Only the newest scan writes the screen, the voice and the reset timer; a request that never answers gives up after 15 s (`submitScan` `client/src/api.ts:258`).

### M12 Offline scan queue (drain-only)

Attendance is never saved offline: `submitScan` rethrows a network failure or timeout, so the kiosk shows its "Can't reach the system" card and the person taps again. `client/src/network.ts` and the replay in `App.tsx:463` only drain items an older version saved. Nothing new is queued; one replay pass at a time; taps replay in order.

### M13 DTR sync progress → client guard

The backend emits `starting` · `syncing` · `completed` (`dtr_sync.rs:3383`), typed as `DtrSyncProgressStatus` and mapped at `App.tsx:4100` onto `client/src/dtr-sync-guard.ts`. Native listeners attach through `detachWhenDone` (`client/src/tauri-api.ts:229`), so a cleanup that runs before a listener attached detaches it on arrival.

### M14 LAN viewer runtime

`src-tauri/src/state.rs` `LanRuntime` (start :130, finish :152, stop :197), `src-tauri/src/lan_server.rs` `bind_and_serve` :193 (graceful shutdown :216), SSE stream end :780; admin changes publish through `publish_attendance_change` (lib.rs:5437).

States: Stopped · Starting · Running(address, server) · Error(issue). When Stopped, nothing serves and no viewer receives events; a stop always wins over a start still binding.

| From | Event | Guard | To | Side effects |
| --- | --- | --- | --- | --- |
| Stopped / Error | start | not already Starting/Running | Starting → Running or Error | bind, spawn serve |
| Running | stop | — | Stopped | shutdown signal: accept loop ends, every open SSE stream ends, idle connections close; abort after 2 s as a backstop |
| Starting | stop | — | Stopped (generation bumped) | the start sees the old generation and shuts its new server down |
| Running | any attendance change (scan or admin) | — | Running | event to every open viewer, which refetches |

Checked and sound: the voice job queue (`voice_pull.rs`, conditional finishes plus a 30-minute reclaim), the legacy server's `KeyedMutex`, `list-load.tsx`, the backup single-flight, and the update banner's check-versus-install guard.

## Issues by root cause

### Fixed (regression test fails on the old code, passes now)

| # | Impact | Root cause → bug | Fix | Test |
| --- | --- | --- | --- | --- |
| F1 | 1 | Finalize checked only `status='DRAFT'` → an overlapping custom range paid finalized days twice | refuse an overlap with another FINALIZED cutoff | `finalize_refuses_overlapping_finalized_cutoff` |
| F2 | 1 | `expectedTimeOut: null` fell back to the fresh value → a stale draft erased a new time-out and its payroll | explicit null means "was empty" | `admin_update_partial_payload_coalesces` (step 6) |
| F3 | 1–2 | Claim used the batch snapshot → older payload pushed, newer edit marked SYNCED | claim `… RETURNING` | `sync_claim_pushes_the_payload_requeued_after_the_batch_read` |
| F4 | 2 | UPSERT/DELETE rows independent → a retrying UPSERT resurrected a deleted row | enqueue retires the unapplied opposite op | `delete_supersedes_an_unapplied_upsert_and_the_reverse` |
| F5 | 1 | Restore swapped the DB first; a later failing step still said "nothing replaced" | data and config first, one rename last | `failed_portable_restore_keeps_the_current_database` |
| F6 | 1 | One sorted prune list → 10 safety snapshots deleted every new backup | separate families | `prune_backups_never_deletes_the_new_backup_behind_safety_snapshots` |
| F7 | 2 | OAuth transport and DTR clear 429/5xx were finite → rows DEAD after ~2.5 min offline | transient | `transient_classifier` |
| F8 | 2 | Backfill asked the bucket for >50 writes at once → pending forever | ≤50 per pass | `oversized_backfill_is_trimmed_to_an_admissible_slice` |
| F9 | 1 | Setup closed mid-unlock reopened unlocked | attempt counter | `App.test.tsx` "keeps setup closed and locked …" |
| F10 | 2 | Client waited for `done`, backend sends `completed` → "Sync already running" forever | typed status union | `database-panel.test.tsx` "clears the sync guard …" |
| F11 | 2 | Assisted confirm queued offline left the modal open | superseded by F27 (nothing is queued offline) | `App.test.tsx` "keeps the Assisted Attendance modal open with a retry message …" |
| F12 | 2 | `unlockAdmin` threw in browser mode → busy stuck | never throws | `api.test.ts` "reports an unreachable or garbled unlock …" |
| F13 | 2 | Bathroom log showed an older date's slow answer | newest load wins | `bathroom-key-log.test.tsx` "shows the date picked last …" |
| F14 | 1 | Offline replay re-queued, overlapped, stranded items | single-flight drain, in order | `App.test.tsx` "drains scans an older version saved offline …" |
| F15 | 3 | Slow time-in greeting spoke over the next scan | scan sequence check | `App.test.tsx` "does not let a slow time-in announcement talk over …" |
| F16 | 1 | User delete partial on failure | one transaction | `user_deletion_is_all_or_nothing` |
| F17 | 3 | Cutoff delete in two statements | one transaction | `cutoff_delete_never_leaves_a_finalized_cutoff_without_its_snapshot` |
| F18 | 3 | Attendance delete read cascaded ids outside its transaction | reads inside | structural; delete tests pass |
| F19 | 2 | Bathroom admin edit undid a key return | optimistic `updated_at` | `bathroom_edit_rejects_dates_outside_log_date` |
| F20 | 3 | Nuke-and-resync skipped the sync guard | takes the guard | `nuke_and_resync_waits_for_a_running_sync` |
| F21 | 3 | Recon runs stuck RUNNING; failures logged every 30 s | close every failure; boot reclaim; 30-min gap | `a_run_cut_off_by_closing_the_app_is_closed_as_failed_at_boot`, `scheduled_retries_wait_after_an_attempt` |
| F22 | 1 | D1: unlimited PIN guesses | 5 wrong → 5 min lock, persisted | `admin_pin_lockout_after_five_wrong_pins_survives_a_restart` |
| F23 | 2 | D2: admin could change days in a FINALIZED cutoff; user delete erased approved pay | refused; FINALIZED kept | `finalized_cutoff_freezes_its_days_and_outlives_the_user` |
| F24 | 2 | D3: time-in after 17:00 could never be timed out | unpriceable LATE_TIMEOUT kept without payroll | `scan_records_unpriceable_time_out_as_late_without_payroll` |
| F25 | 2 | D4: a second tap 10 s after time-in closed the day | 1-minute minimum | `scan_needs_a_minute_between_time_in_and_time_out` |
| F26 | 2 | D5: punches made while DTR upload was off were dropped | queue while off | `dtr_upload_off_keeps_queuing_and_resumes_with_current_data` |
| F27 | 1 | D6: an offline-saved scan was recorded at replay time | never save attendance offline | `App.test.tsx` "never saves attendance offline …" |
| F28 | 2 | D7: clearing a time-in locked the person out | a correction keeps a time-in | `admin_update_keeps_a_time_in` |
| F29 | 2 | O1: stopping the LAN viewer left open viewers streaming | graceful shutdown ends every SSE stream | `lan_stop_disconnects_open_viewers` |
| F30 | 3 | O9: a stop during start was overwritten | stop generation | `stop_during_start_wins` |
| F31 | 3 | O2: transient backoff never grew (30–90 s forever) | own strike counter (migration 0022) | `transient_failures_back_off_with_their_own_strike_count` |
| F32 | 3 | O3: two grace deletes for one person shared a queue key | grace id in the key | `grace_deletes_for_one_person_do_not_collapse` |
| F33 | 3 | O4: data and its sync rows committed separately → a crash in between never synced | outbox: queue rows on the writer's transaction (a savepoint keeps fire-and-forget) | `queue_rows_commit_with_the_attendance_write` |
| F34 | 3 | O5: cutoff generate not atomic; replaced drafts stayed on the sheet | one transaction; replaced drafts deleted on the sheet | `cutoff_generate_is_all_or_nothing_and_deletes_replaced_drafts_on_the_sheet` |
| F35 | 3 | O6: browser-mode scan had no timeout → stuck in processing | 15 s limit, treated as unreachable | `api.test.ts` "gives up on a scan request that never answers …" |
| F36 | 3 | O7: deactivating someone left today's open day or a held key stuck | refused until timed out / key returned | `deactivation_refuses_while_a_day_or_key_is_open` |
| F37 | 3 | O8: VoiceStudio commands had no admin check; Check saved what was typed | `require_admin`; probe without saving | `voicestudio_check_needs_admin_and_saves_nothing`; `api.test.ts` "sends the admin session token …" |
| F38 | 3 | O10: legacy server lock only expired the cookie | server-side token revocation | `server/test/admin.test.ts` "revokes the session token on lock …" |
| F39 | 3 | O11: admin changes never reached LAN viewers; native listeners leaked on early cleanup (the admin card listener re-subscribes on every busy toggle, so not only in dev) | publish after admin commits; `detachWhenDone` | `admin_changes_reach_lan_viewers`; `App.test.tsx` "detaches the native card listener …" |

### Suspected → verdict

| # | Suspicion | Verdict | Evidence / fix |
| --- | --- | --- | --- |
| S1 | Sync guard wedges after a failed release write | **Confirmed**, fixed | a trigger-injected release failure made the next acquire fail; the own leftover is now claimed and foreign rows are still refused — `a_failed_release_write_does_not_wedge_the_sync_guard` |
| S2 | Restore env var survives into relaunches | **Confirmed**, fixed | Tauri `restart` spawns via std `Command` (inherits the environment; the updater relaunch uses it); removed once read — `restore_env_var_is_used_once_not_on_every_relaunch` |
| S3 | Reset-code attempts lost under concurrency | **Confirmed**, fixed (it was a bypass) | ten concurrent wrong codes, then the right code still worked; the attempt is now spent in one statement. The same race was found and fixed in the D1 wrong-PIN counter — `concurrent_wrong_reset_codes_still_spend_the_attempt_budget`, `concurrent_wrong_pins_still_reach_the_lockout` |
| S4 | Assisted modal's 25 s auto-cancel stalls | **Cause confirmed in code; not reproducible under Node** | the countdown effect depended on an inline `onClose` that changed on every 1 s clock render; Node's timer phase fires both intervals before React's render, while a browser runs the render first. Cause removed (stable `closeAssist`); real-timer guard test "counts the Assisted Attendance auto-cancel down in real time …" |
| S5 | Debounce check-then-write records an instant time-out | **Half refuted, half confirmed** | an instant time-out is impossible since D4 (stored time-in); a double tap racing the first commit showed "Unable to save" and is now DUPLICATE_SCAN — `double_tap_racing_the_first_commit_is_a_repeat_tap` |
| S6 | Moving a day leaves the old date's DTR cells | **Confirmed**, fixed | the UPSERT carries only the new date and the scheduled recon is report-only; the old date is now cleared and its week replanned — `moving_a_day_clears_the_old_date_on_the_dtr_sheet` |
| S7 | A stale token logs a live admin out | **Confirmed**, fixed | `admin_authorized` cleared the session on any mismatch (also on the empty token sent while locked); only expiry clears now — `admin_session_survives_a_request_with_a_stale_token` |

### Still open

| # | Impact | Bug | Note |
| --- | --- | --- | --- |
| O12 | 4 | The PIN-reset *daily* failure cap (`record_failure`, `admin_pin.rs`) is still read-then-write, so concurrent wrong codes can undercount it | each code's 5-attempt budget is atomic now (S3), so this only lets slightly more new codes be requested per day; the UI sends one request at a time |
