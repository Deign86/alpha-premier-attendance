# Handoff: dtr-sync-graceful → live Tauri MCP test session

## Where things stand
- Plan `.omo/plans/dtr-sync-graceful.md`: todos 1–11 DONE + verified, F1/F2/F4 APPROVE, **F3 (live QA) open**.
- This branch `feat/dtr-sync-graceful` = `main` + 11 atomic commits (`225eef7`..`02ee113`) + working-tree evidence/logs.
- F3 so far: suites green (shared 34, client 271, database-panel 22/22, verify:mcp 7/7), 3-surface guard+progress proven live, backup/restore 29/1436 verified. UNPROVEN live: Sheets B:E no-dupe counts + kill-mid-batch resume + `DTR_SYNC_IN_PROGRESS` race.

## Auth is ready (done this session)
- gcloud 585 installed per-user (`%LOCALAPPDATA%\Google\Cloud SDK`), logged in as owner, project `alpha-attendance-sheets-26`.
- SA key created (id `9f5ebd82…`, names only — never contents) at `%APPDATA%\com.alphapremier.attendance\attendance-sheets-key.json` (= `DEFAULT_SERVICE_ACCOUNT_FILENAME`, config.rs:153). Temp copy in `Temp\opencode\sa-key.json` (delete when done).
- Test sheet "Test DTR": ID `1SUisI6zcE1hD9RzEw-LniNIkouM4mh8JH3Vj0KJM5vI` (SA = Editor, link-sharing Viewer). Matches plan scratch ID.

## PROD-GUARDS (violate never)
1. Export `ALPHA_PREMIER_DTR_SHEET_ID=1SUisI6zcE1hD9RzEw-LniNIkouM4mh8JH3Vj0KJM5vI` in EVERY app-launch env — code default without it is the PROD sheet `1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE` (config.rs:148-177). Echo it from the launching shell.
2. First Sheets action = token + `spreadsheets.get` 200 on the scratch ID. No other spreadsheet, ever.
3. Stopped-app file-copy DB backup before seeding/draining; restore + count-verify after. NEVER the in-app restore-exit path (known CRITICAL PANIC at stdio.rs:1166).
4. Drive ONLY your own `npm run tauri:dev` instance. If port 9223 is owned by the installed app: report, don't kill/drive it.

## Launch recipe (learned the hard way)
- tauri.conf has NO `beforeDevCommand`; client `dev` is plain `vite` with no `--strictPort` — a stale 5173 makes vite shift to 5174 while `tauri dev` waits on 5173 for 180s then dies. So: free 5173/5174/3001 first (kill only vite/tauri processes from our runs), then `npm run dev`, poll `:5173` for HTTP 200 (60s deadline), then `npm run tauri:dev:fast` (no auto-clean), then poll bridge 9223 (180s). Never hand-launch sidecar vites. Every wait gets a deadline + heartbeat log lines.
- Prior 8h churn cause: orphaned vite + 180s-timeout loops + a false-negative sheet gate (checked wrong key filename).

## Known env faults (no surgery)
- `cargo test --lib` exits `0xc0000139` (gnu-ld SxS-manifest loader issue, pre-existing). Proof via exact-bytes harnesses + real SQLite proxy in `task-*.log`; CI/MSVC must run the real binaries.
- python3 absent (Store stub). node 22 + cargo present.

## Evidence map
- `.omo/evidence/dtr-sync-graceful/task-{1..11}-{happy,fail}.log` (+ `task-9-happy.png`), `f3-live*.log`, `f3-live-*.png`.
- Ledger: `.omo/start-work/ledger.jsonl`. Boulder: `.omo/boulder.json` (work `dtr-sync-graceful` still active).
- Suggested first command: `node scripts/doctor-tauri-mcp.mjs`, then the recipe above.
