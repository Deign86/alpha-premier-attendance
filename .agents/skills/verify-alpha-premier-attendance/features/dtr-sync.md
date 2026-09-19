# Intern DTR Sheets Sync (graceful)

Slow-but-sure attendance export to the `INTERN DTR 2026` Google Sheet: queue-backed, transient-only infinite retry, batched writes under quota, guarded manual runs, restart-safe resume. Added by the `dtr-sync-graceful` plan; live-proved 2026-09-19 on the scratch sheet.

## Sub-features

- `DTR-RETRY`: 429/5xx/timeout-after-connect/403-rateLimit rows RETRY forever (no attempts increment, capped backoff+jitter, Retry-After ≤ 15 s); corrupt/dailyLimit 4xx go DEAD with distinct codes after 5 strikes.
- `DTR-SKIP`: no-tab/no-month/no-date-row/empty-values → SYNCED-with-skip + `dtr_pending` note (never DEAD/RETRY), re-driven by the 30 s tick rescan and tab-create.
- `DTR-BATCH`: values-only `batchUpdate` coalescing (≤ 50 ranges or 2 MB per call, single spreadsheet; per-range isolation on 400) + DTR-only throttle (~50 writes/min token bucket, concurrency 1; ops path bypasses).
- `DTR-GUARD`: one in-progress guard (`admin_sync_now` + `admin_sync_intern_dtr` + per-row); second caller gets `DTR_SYNC_IN_PROGRESS` with owner/startedAt; Data/Users/per-row buttons disable with a shared progress bar.
- `DTR-RESUME`: 5-min PROCESSING lease recovery + idempotent same-range replay (kill-mid-batch resumes with zero dupes).
- `DTR-HEALTH`: `admin_get_sync_status` carries `throttledUntil`, `lastThrottleReason`, `inProgress{owner,startedAt}`, `leaseRecovered`, `oldestRetryableAgeSec`, `pendingAgeAlert`.

## How to get to it (user POV)

- Admin → Data and backup → "Sync Intern DTR now"; Users tab → "Sync Interns to DTR" (bulk) or per-row sync buttons; progress bar + disabled states while running.

## Driving it with Tauri MCP

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })`.

Preconditions:
- App launched with `ALPHA_PREMIER_DTR_SHEET_ID` pointing at the scratch sheet
  (`1SUisI6zcE1hD9RzEw-LniNIkouM4mh8JH3Vj0KJM5vI`). Without it the code default
  is the PROD sheet — verify `dtr=<id>` in the app log before any sync action.
- First Sheets action is always token + `spreadsheets.get` 200 on the scratch ID.
- Stopped-app file-copy DB backup before seeding/draining; never the in-app restore-exit path.

- **Health**: `admin_get_sync_status` (`{ "token" }`) → assert new fields parse.
- **Bulk**: `admin_sync_intern_dtr` (`{ "token" }`, optional `userId` for per-row).
  Long runs (30 s+) outlive the `execute_js` script budget — fire without
  awaiting and poll status until `inProgress` clears.
- **Race**: second concurrent sync must return `DTR_SYNC_IN_PROGRESS`.
- **No-dupe proof**: read back B:E per tab before/after rewrite runs — counts
  must be identical (live: 22 tabs, 254 rows, 958 cells × 3 runs).
- **Tab auto-create**: intern tabs duplicate from the live `TEMPLATE` tab; a
  sheet without one leaves rows `dtr_pending` forever (fallback GID fails closed).

## Gotchas

- The queue tick needs Sheets creds (`attendance-sheets-key.json` beside config);
  without an ops target, ops rows die `GOOGLE_SYNC_FAILED` while DTR continues.
- Quota pressure is self-inflicted: gate/seed/read scripts + app traffic share
  the same SA quota; transient 429s stretch runs (never DEAD).
- `tauri.conf.json` has no `beforeDevCommand`: free `:5173`/`:5174`/`:3001`
  first or vite shifts ports and `tauri dev` dies waiting. One `npm run dev`
  window, one `tauri:dev:fast` window, both visible.
