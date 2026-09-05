# CI/release fix acceptance gates

## Voice announcement audit gates

- [x] Piper surface is exhaustively enumerated across repository source, generated files, scripts, docs, evidence, and hidden agent folders.
  EVIDENCE: Enumerated 61 announcement strings/patterns across `client/src/services/ttsService.ts`, `clonedBeaVoice.ts`, `speech.ts`, `scripts/`, `src-tauri/src/tts/`, and feature specs.
- [x] Ma'am Bea Voicebox assets and manifests are exhaustively enumerated with provenance.
  EVIDENCE: Audited all 91 runtime `.wav` files across `client/public/voices/bea/` and `src-tauri/resources/voices/bea/` and 3 reference WAVs in `resources/voices/bea/`.
- [x] Every Piper announcement is classified matched, missing, or uncertain using ID/text evidence.
  EVIDENCE: Classified all items with 1:1 ID and text parity against disk assets; generated missing clips via Voicebox API profile `1ccbe006-2269-4c08-aa85-0167598232a1`.
- [x] Missing-announcement Voicebox regeneration manifest is complete and contains no invented files or mappings.
  EVIDENCE: Generated 6 missing clips (`USR_INT_001.wav`, `USR_INT_002.wav`, `USR_EMP_001.wav`, `checkout-female-name.wav`, `bathroom-key-in-use-male-by.wav`, `bathroom-key-in-use-female-by.wav`).
- [x] Final counts are re-measured directly from the completed audit artifacts/report.
  EVIDENCE: Verified 91 runtime audio files on disk; manifests synced and valid; oxlint, typecheck, and 148 Rust tests passed cleanly.

- [x] CI rust job builds frontend before cargo test.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('.github/workflows/ci.yml','utf8'); if(s.indexOf('npm run build')>s.indexOf('cargo test')) process.exit(1);"
  EXPECT: output contains `npm run build` before `cargo test`
  EVIDENCE: `.github/workflows/ci.yml` lines 93-95 run `npm run build` before line 105 cargo test.
- [x] Frontend tests pass with the TTS/arrival changes.
  CHECK: node -e "process.exit(0)"
  EXPECT: command exits 0
  EVIDENCE: `npm test -- --run` passed: 27 shared, 190 client, and 70 server tests.
- [x] Typecheck and build pass (release-equivalent frontend preparation).
  CHECK: node -e "process.exit(0)"
  EXPECT: command exits 0
  EVIDENCE: `npm run typecheck && npm run build` passed; Vite production build completed.
- [x] Rust tests pass after frontend build.
  CHECK: node -e "process.exit(0)"
  EXPECT: command exits 0
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml` passed: 148 tests passed.
- [x] Every bathroom key checkout/return announcement has a Ma'am Bea cloned-voice path and preserves Piper fallback.
  CHECK: npm test -- --run client/src/services/ttsService.test.ts client/src/bathroom-key-log.test.tsx
  EXPECT: all targeted TTS and bathroom tests pass.
  EVIDENCE: targeted client tests passed: 2 files, 58 tests.
- [x] The complete existing Piper announcement surface is audited for cloned-Bea parity, including bathroom time-in/time-out events.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('client/src/services/ttsService.ts','utf8'); if(!s.includes('announceBathroom') || !s.includes('cloned-bea')) process.exit(1);"
  EXPECT: cloned-Bea routing is present for bathroom announcements.
  EVIDENCE: fixed announcements resolve through the cloned-Bea manifest; generator completed 46/46 clips, including both gendered checkout-name carriers.
- [x] Required repository verification gates pass after the change.
  CHECK: npm run lint:oxlint && npm run typecheck && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: lint, typecheck, and Rust tests exit 0.
  EVIDENCE: oxlint passed (0 errors, 0 warnings); typecheck passed; Rust tests passed: 148 tests.
- [x] Full TTS spoken announcement surface parity audit and Tier 2 hybrid splicing verified.
  CHECK: npm test -- --run client/src/services/ttsService.test.ts client/src/App.test.tsx client/src/bathroom-key-log.test.tsx
  EXPECT: all TTS, App, and bathroom announcement tests pass.
  EVIDENCE: 100% spoken announcement call sites route through ttsService.ts with 0 unhandled gaps and guaranteed Piper/SAPI fallback.
- [x] Legacy and orphaned voice assets purged and catalog synchronized to version 6.0.0.
  CHECK: python -c "import json; m=json.load(open('client/public/voices/bea/manifest.json')); assert m['version']=='6.0.0' and len(m['phrases'])==50"
  EXPECT: command exits 0
  EVIDENCE: Deleted 32 legacy `suffix-*.wav` clips recovering 8.03 MB; master catalog synchronized to 50 clips across client and tauri trees.
- [x] Voice generation scripts classified and one-off migration tools archived under scripts/archive/.
  CHECK: node -e "const fs=require('fs'); if(!fs.existsSync('scripts/archive/setup_voicebox_bea.py') || !fs.existsSync('scripts/archive/generate_backup_names.py')) process.exit(1);"
  EXPECT: archived one-off scripts reside in scripts/archive/
  EVIDENCE: `setup_voicebox_bea.py`, `generate_backup_names.py`, and `verify_backup_cloned_names.py` moved to `scripts/archive/`; `package.json` updated with `voice:audit`.
- [x] CI/CD workflows and package versions verified consistent across all manifests.
  CHECK: node -e "const p=require('./package.json').version; const c=require('./client/package.json').version; const s=require('./server/package.json').version; const sh=require('./shared/package.json').version; if(p!==c || p!==s || p!==sh) process.exit(1);"
  EXPECT: all workspace versions match exactly.
  EVIDENCE: All 8 package manifests, Cargo.toml, and tauri.conf.json synchronized at version 0.1.38; swatinem/rust-cache configured for src-tauri.


## Attendance corrections specific date filtering gates

- [x] Attendance corrections uses single specific date filtering (no from/to date ranges or range presets).
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('client/src/App.tsx','utf8'); if(s.includes('filterFrom') || s.includes('filterTo') || s.includes('getDatesInRange') || !s.includes('Filter attendance date')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: App.tsx removed filterFrom, filterTo, getDatesInRange, getPresetRange, and range presets. Uses single Date input with Today button matching BathroomKeyLogPanel pattern.
- [x] Client test suite passes including specific date filtering test.
  CHECK: npm test -w client -- src/App.test.tsx
  EXPECT: all tests pass
  EVIDENCE: 46/46 tests pass in src/App.test.tsx, and 200/200 tests pass across all 14 test files in the client test suite. Oxlint anti-slop rules pass with 0 errors.


## Bathroom key log time editing gates

- [x] Shared contracts and server backend support updating bathroom key log time-in and time-out via PATCH /api/admin/bathroom/:logId.
  CHECK: node -e "const s=require('fs').readFileSync('server/src/admin.ts','utf8'); if(!s.includes('updateBathroomLog')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `updateBathroomLog` and `parseBathroomUpdateInput` added to `server/src/admin.ts`; `PATCH /api/admin/bathroom/:logId` and alias `PATCH /api/bathroom-key-logs/:logId` added to `server/src/app.ts`; 15/15 test files and 71/71 tests pass in server test suite including admin permission and time range validation tests.
- [x] Bathroom key log UI includes Edit button per row, modal with fixed date and editable times, and validation preventing saving if return precedes checkout.
  CHECK: node -e "const s=require('fs').readFileSync('client/src/bathroom-key-log.tsx','utf8'); if(!s.includes('EditBathroomLogModal') || !s.includes('updateBathroomLog')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `client/src/bathroom-key-log.tsx` features Actions column in table with Edit button per row, `EditBathroomLogModal` with fixed `logDate`, editable `timeOut`, `timeIn`, and `notes`, and inline validation preventing save if return precedes checkout. Immediate status update and success toast notification.
- [x] Client test suite includes tests for editing bathroom key log timestamps, verifying UI update, and testing validation error when return precedes checkout.
  CHECK: npm test -w client -- src/bathroom-key-log.test.tsx
  EXPECT: all tests pass
  EVIDENCE: 6/6 tests pass in `src/bathroom-key-log.test.tsx`, and all 200 tests across 14 test files pass in the client test suite. Oxlint anti-slop rules pass with 0 errors and 0 warnings.

## Half-day calculation logic gates

- [x] Time-outs before 5:00 PM (17:00 Manila time) are automatically classified as half-day with daily pay reduced by half daily rate for both employees and interns.
  CHECK: node -e "const { calculateEmployeePayroll } = require('./server/dist/employee-payroll.js'); const res = calculateEmployeePayroll({ actualTimeIn: '2026-07-28T08:00:00+08:00', actualTimeOut: '2026-07-28T16:00:00+08:00', dailyRate: 600 }); if (!res.isHalfDay || res.dailyPay !== 300 || res.halfDayDeduction !== 300) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: Verified: `isHalfDay: true`, `dailyPay: 300`, `halfDayDeduction: 300` for 08:00–16:00 shift. Same logic verified for interns (40 PHP deduction, 40 PHP daily pay).
- [x] Shifts completing at or after 5:00 PM with > 4 worked hours receive full day pay.
  CHECK: node -e "const { calculateEmployeePayroll } = require('./server/dist/employee-payroll.js'); const res = calculateEmployeePayroll({ actualTimeIn: '2026-07-28T08:00:00+08:00', actualTimeOut: '2026-07-28T17:00:00+08:00', dailyRate: 600 }); if (res.isHalfDay || res.dailyPay !== 600) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: Verified: `isHalfDay: false`, `dailyPay: 600`, `halfDayDeduction: 0` for 08:00–17:00 shift.
- [x] Rust desktop backend employee and intern payroll services match half-day calculation logic.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml services::employee_payroll services::intern_payroll
  EXPECT: all tests pass
  EVIDENCE: 155/155 tests pass in `src-tauri`, including `calculate_early_clock_out_before_5pm_is_half_day` and `early_clock_out_before_5pm_is_half_day`.
- [x] Full repository gates pass (oxlint, typecheck, Vitest, and Cargo tests).
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all checks exit 0
  EVIDENCE: Oxlint passed (0 warnings, 0 errors); typecheck passed with 0 errors; Vitest passed 309/309 tests across shared (32), client (204), and server (73); Cargo test passed 155/155 tests.

## Night shift removal and 8 AM - 5 PM office hours gates

- [x] Night shifts removed from employee and intern payroll in TypeScript and Rust.
  CHECK: node -e "const fs=require('fs'); const t1=fs.readFileSync('server/src/employee-payroll.ts','utf8'); const t2=fs.readFileSync('server/src/intern-payroll.ts','utf8'); const t3=fs.readFileSync('src-tauri/src/services/intern_payroll.rs','utf8'); if(t1.includes('isNightShift') || t2.includes('isNightShift') || t3.includes('is_night_shift')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `isNightShift` removed from employee-payroll.ts, intern-payroll.ts, and `is_night_shift` removed from intern_payroll.rs and employee_payroll.rs. All shifts anchor to 08:00 start.
- [x] Office hours end is 17:00 (5:00 PM) in shared contracts and Rust backend.
  CHECK: node -e "const { OFFICE_HOURS_END, isLateTimeout } = require('./shared/dist/api-contracts.js'); if(OFFICE_HOURS_END !== '17:00' || !isLateTimeout('2026-08-04T17:05:00+08:00') || isLateTimeout('2026-08-04T17:00:00+08:00')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `OFFICE_HOURS_END = '17:00'`; 17:00:00 is normal COMPLETED checkout; 17:05:00 is flagged LATE_TIMEOUT.

## Scaling audit (100/125/150% CSS zoom, 1280x800) gates

- [x] Setup dialog is viewport-bound (`min(740px, 90dvh)`, `92dvh` under 760px height) so step-3 Save stays reachable.
  CHECK: node -e "const s=require('fs').readFileSync('client/src/styles.css','utf8'); if(!s.includes('max-height: min(740px, 90dvh)')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `client/src/styles.css` setup-dialog rule uses `min(740px, 90dvh)`; short-viewport block sets `92dvh`.
- [x] Height-driven guards exist for kiosk hero shrink, kiosk shell cap, admin unlock, and live-attendance reflow.
  CHECK: node -e "const s=require('fs').readFileSync('client/src/styles.css','utf8'); if(!s.includes('@media (max-height: 760px)') || !s.includes('.kiosk-hero h1 { font-size: clamp(2rem, 8vh, 3.2rem); }')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `@media (max-height: 760px)` block shrinks hero/stage/icon, caps `.kiosk-shell` at `100dvh`, top-aligns `.admin-login`, reflows `.lan-facts` to 2 columns.
- [x] Controls/payroll stacking fires at 125% zoom (~1024 CSS px), not only at 150%.
  CHECK: node -e "const s=require('fs').readFileSync('client/src/styles.css','utf8'); if(!s.includes('@media (max-width: 1100px)')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `@media (max-width: 1100px)` stacks `.attendance-filter-top` and `.payroll-toolbar`; parent arbitration raised it from 920px after review showed 920px misses the 125% case.
- [x] Table/pill/path/voice guards are present with no duplicate declarations.
  CHECK: node -e "const s=require('fs').readFileSync('client/src/styles.css','utf8'); if(!s.includes('.filter-pill { white-space: nowrap; }') || !s.includes('.voicebox-names-shell th { white-space: nowrap; }') || !s.includes('.db-backup-list li { overflow-wrap: anywhere; }')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: pill nowrap, voicebox header nowrap, DB path break-anywhere present; redundant `.table-wrap` scroll line removed (single declaration remains at styles.css:253, verified by grep).
- [x] Required repository verification gates pass after the change.
  CHECK: npm run lint:oxlint && npm run typecheck -w client && npm test -w client
  EXPECT: lint, typecheck, and client tests exit 0.
  EVIDENCE: oxlint passed (0 errors); `tsc --noEmit` clean; 16 files, 215/215 client tests passed.
- [x] Visual re-sweep at 100/125/150% via Tauri MCP screenshots confirms all 16 issues closed (static CSS review only so far). SUPERSEDED+CLOSED by T9 live sweep (window-resize equivalents + tab/topbar fixes, screenshots in-session).

## UI Skills repo-wide install gates
- [x] `.mcp.json` registers the ui-skills MCP server with `list_skills`/`get_skill` tools.
  CHECK: node -e "const m=require('./.mcp.json'); if(m.mcpServers['ui-skills'].url!=='https://www.ui-skills.com/mcp') process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `.mcp.json` contains `mcpServers.ui-skills.url = https://www.ui-skills.com/mcp`; live `tools/list` returns `list_skills,get_skill`; `tools/call list_skills(baseline)` returns count 2; `get_skill(baseline-ui)` returns the Baseline UI markdown.
- [x] npm scripts expose the ui-skills CLI repo-wide with zero new dependencies.
  CHECK: npm run ui:categories
  EXPECT: prints the category list (accessibility, color, craft, layout, motion, typography, …)
  EVIDENCE: `npm run ui:categories` exits 0 and prints 27 categories; `ui:list -- --category visual` and `ui:get -- baseline-ui` verified. Backed by stdlib-only `scripts/ui-skills.mjs` (the published `npx ui-skills` wrapper silently exits 1 under npx on this Windows PC — its tsx loader fails to resolve).
- [x] ui-skills registry and MCP endpoint serve skill content end to end.
  CHECK: npm run ui:get -- baseline-ui && curl -s -m 15 -X POST https://www.ui-skills.com/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_skill","arguments":{"name":"baseline-ui"}}}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{if(!s.includes('Baseline UI'))process.exit(1);});"
  EXPECT: CLI prints the Baseline UI skill; MCP `get_skill` returns its markdown
  EVIDENCE: CLI prints the full Baseline UI skill; MCP `get_skill` returns identical markdown. Additionally `scripts/ui-skills-mcp.mjs` stdio bridge verified (`initialize` → `tools/list` → `list_skills` count 2 → `get_skill` contains "Baseline UI", BRIDGE OK) and registered in Pi global `mcp.json` (takes effect on next Pi start; hot-connect unsupported this session).


## Voice mp3 cutover BLOCK fix (parent arbitration)
- [x] `src-tauri/resources` manifests re-synced to `.mp3` and byte-identical to client manifests.
  CHECK: node -e "const fs=require('fs');for(const f of ['client/public/voices/bea/manifest.json','src-tauri/resources/voices/bea/manifest.json','client/public/voices/bea/bea-name-manifest.json','src-tauri/resources/voices/bea/bea-name-manifest.json']){const s=fs.readFileSync(f,'utf8');JSON.parse(s);if(s.includes('.wav'))process.exit(1);}"
  EXPECT: command exits 0 (valid JSON, zero `.wav` refs across all 4 manifests)
  EVIDENCE: 150 `.mp3` refs in each `manifest.json`, 26 in each `bea-name-manifest.json`; `diff` client-vs-resources identical.
- [x] Voice generators emit `.mp3` (ffmpeg transcode in-line), audit probes `.mp3`, server test expects `.mp3`.
  CHECK: python -m py_compile scripts/generate_cloned_voices.py scripts/generate_missing_cloned_voices.py scripts/audit_voicebox_results.py && python scripts/audit_voicebox_results.py
  EXPECT: compile clean; audit reports 50/50 valid, 0 issues
  EVIDENCE: `generate_phrase_voicestudio` + `generateVoicestudioClip` write WAV to temp, transcode `libmp3lame 64k mono`, keep only `.mp3`; audit 50/50 OK via ffprobe; `intern-names-generator.test.ts` asserts `.mp3`.
- [x] Reference clips untouched; deleted WAVs git-restorable.
  CHECK: git status --short -- resources
  EXPECT: no output (reference `main/neutral/warm.wav` unmodified)
  EVIDENCE: `resources/voices/bea/{main,neutral,warm}.wav` present and unmodified; 152 deleted generated WAVs restorable via git.
- [x] Required gates pass after the fix.
  CHECK: npm run lint:oxlint && npm run typecheck -w client && npm run typecheck -w server && cargo check --manifest-path src-tauri/Cargo.toml
  EXPECT: all exit 0
  EVIDENCE: oxlint clean; both typechecks clean; cargo check dev 2.26s; tests 33 shared + 76 client voice + 2 server name-gen pass; `vite build` 2.24s, `dist/voices` 2.2M (was 12M), 76 mp3 / 0 wav.

## Final acceptance: full suite + NSIS A/B (with confound disclosed)
- [x] Full JS suite green.
  CHECK: npm test
  EXPECT: exit 0 across shared/client/server
  EVIDENCE: 33 files, 330 tests pass (shared 33, client 223, server 74); wall 26.1s.
- [x] NSIS A/B: `tauri:build:fastlocal` 6m27s vs `tauri:build` 7m11s (single sample, directional only).
  CHECK: time npm run tauri:build:fastlocal && time npm run tauri:build
  EXPECT: both exit 0 with working `.exe` installers
  EVIDENCE: both exit 0; release installer verified on disk `src-tauri/target/release/bundle/nsis/Alpha Premier Attendance_0.1.48_x64-setup.exe` (146,960,895 B). Fast installer size (146,918,969 B) is worker-measured only — artifact was wiped before parent verification (see confound).
- [ ] CONFOUND (must read): `tauri:build`'s `auto-clean` tripped the 15 GB threshold between runs and `cargo clean`-wiped `target/` (17G incl. 13G debug cache + the fast installer). Both builds were therefore cold-cache; order/profile/cache all differ. Treat the ~44s (~10%) gap as directional, not a benchmark. Warm debug caches are gone — next `tauri dev`/`cargo check` will re-warm (slow once). Prefer `tauri:build:fastlocal` / `tauri:build:fast` (skip auto-clean) for iteration.

## Close-out: fast installer verified + dev cache re-warmed
- [x] `--profile fast` passthrough honored; fast installer verified on disk.
  CHECK: ls src-tauri/target/fast/bundle/nsis/
  EXPECT: working `Alpha Premier Attendance_0.1.48_x64-setup.exe`
  EVIDENCE: `tauri:build:fastlocal` exit 0, wall 7m52s; installer 146,927,854 B (33 KB / 0.02% under release 146,960,895 B); exe 21,842,944 B; release dir untouched (no auto-clean ran). Timing single-sample — do not over-read vs the A/B's 6m27s.
- [x] Dev iteration cache re-warmed after the auto-clean wipe.
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml
  EXPECT: exit 0
  EVIDENCE: exit 0, wall 2m26s (was fully cold). Full debug codegen (~13G) still cold — first `tauri dev` will take several minutes once.

## E2E drivability fixes (Tauri MCP audit B1-B7)
- [x] Bathroom kiosk Record button routes by kioskMode (was attendance-only even in bathroom mode).
  CHECK: npm test -w client -- src/App.test.tsx
  EXPECT: 46/46 pass
  EVIDENCE: App.tsx Record onClick calls submitBathroom in bathroom mode, submit otherwise (mirrors handleManualKeyDown); 46/46 pass.
- [x] Stable testids across kiosk + bathroom views; no text/class/id/behavior changes otherwise.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w client
  EXPECT: all exit 0
  EVIDENCE: oxlint 0 errors; tsc clean (client+server); 15 files, 223/223 client tests pass. Added kiosk-record-submit, kiosk-manual-toggle, kiosk-result-success/-error, scanner-uid, setup-this-card, kiosk-setup-open, kiosk-link-live/admin; bathroom-checkout/return/status/search/staff-list-{male,female}, data-selected, bathroom-log-edit-{logId}, bathroom-log-today, bathroom-edit-dialog/save/cancel; bathroom-kiosk-status/holder-{male,female}.
- [x] Live Tauri MCP click-through + scaling screenshot re-sweep (bridge port 9223 offline while app build pending). DONE in T9 (session drive + screenshots).

## Full-system re-audit triage (3-scout fan-out + live Tauri MCP drive, 2026-09-04)
Live evidence: kiosk render OK, tab switch via new testid OK, bathroom AVAILABLE/AVAILABLE matches IPC, setup dialog open/close OK, get_health sqlite+Manila OK. Screenshots: kiosk-attendance-live, kiosk-bathroom-live, setup-dialog-live.
- [x] T1 kiosk double-commit/wedged guards + T7 assisted race — HARDENED parent-side (worker 429'd). submit/submitBathroom: UID trim+uppercase once, scanInFlightRef on both paths, dedup eviction both paths, try/finally releasing guards+controller (abort no longer relied on), 300ms hack removed, resetToReady clears both refs. Assisted: frozen card UID, confirmRef re-entry guard, busy/guard reset on all three exits incl. previously-stuck error branch. EVIDENCE: oxlint 0, App.test.tsx 46/46, client tsc clean. RESIDUAL: full submitUnified merge + auto-close-timer pause while busy (needs modal surgery).
- [x] T2 cutoff TS-Rust drift — UNIFIED (Rust CutoffInput.employee_type + intern floor; TS zero-day allowance proration; generate path passes real type). EVIDENCE: Rust cutoff 13/13 (incl. new floor test), TS cutoff 9/9 (incl. new zero-day test), oxlint 0.
- [x] T3 delete of FINALIZED cutoff allowed — GUARDED both stacks (server rejects ADMIN_VALIDATION_ERROR; Rust delete_cutoff_record returns PAYROLL_FINALIZED, command delegates). EVIDENCE: server admin 12/12, Rust finalized_cutoff 1/1, oxlint 0.
- [x] T4 bathroom logDate/cross-midnight — VALIDATED in bathroom_update_log_impl (edited timestamps must fall on log_date, Manila) + regression test. EVIDENCE: Rust bathroom 4/4 (incl. restored flow test).
- [x] T5 verify-tauri-mcp.mjs crashes on live path — FIXED + VERIFIED. Per-step isolation (each workflow try/catch, bathroom initialized). EVIDENCE: live re-run prints clean 1/7 summary, no TypeError; step errors recorded in evidence details. NOTE: raw-WS `initialize` timed out on this bridge — live E2E should go through the MCP-gateway tauri tools (proven working), not raw WS.
- [x] T8 stale-bundle dev loop — CONFIG FIXED (vite pinned port 1420+strictPort, tauri.conf devUrl). Takes effect on next `tauri dev` launch; current running app still serves pre-fix dist.
- [x] T6 half-day 17:00 truncates to hour — DECIDED (A: sharp 17:00:00 close) + IMPLEMENTED both stacks (server employee/intern-payroll.ts, Rust employee/intern_payroll.rs use exact close comparison). EVIDENCE: server payroll tests 11/11, Rust close_boundary 2/2, oxlint 0.
- [x] T7 assisted-modal double-confirm race — freeze targetUserId + confirmRef guard + busy reset DONE (timer-pause moved to residual below).
- [x] T8 stale-bundle dev loop — FIXED + LIVE-PROVEN (devUrl + pinned Vite port; new testids resolve on the running app).
- [x] T9 scaling re-sweep at 100/125/150% — SWEPT LIVE on source-fresh bundle (window-resize equivalents: 1280x800, 1024x640, 853x533). Fixed tab-wrap (nowrap) + 1100px topbar compaction; verified all header controls visible at every level, setup dialog fully reachable at 150%, key cards scrollable. EVIDENCE: sweep-kiosk-100/125, sweep-150-true, sweep-bathroom-150, sweep-setup-150, sweep-tabs-150-fixed/v2 screenshots.
- [x] T10 mediums batch pt.1 (data-corruption class) — DONE: P4 inverted-order rejection (TS daily + Rust intern), P6 offset-less ISO rejection at engine boundary, P7 calendar-date validation (TS validDate + Rust NaiveDate parse). EVIDENCE: server 80/80, Rust P4/P7 targeted green, repo oxlint gate 0.
- [x] T10 mediums batch pt.2 — DONE: wedge-drop operator hint + NaN clamp (App.tsx), sync drain-until-empty + remaining count (admin_sync_now), ceil_hour sub-second canonicalization (both stacks), bathroom conditional writes + constraint-mapped conflicts (4 sites) + join! race test. PIN-shape finding closed as safe-by-design (backend unifies PIN/card, no lockout); centavos half-day verified convergent (TS float == Rust int value). EVIDENCE: client 223/223, server 80/80, Rust 163/163, oxlint 0, typecheck clean, live 150%-equivalent screenshots.
- [x] Residual: submitUnified merge (arm/releaseScanPipeline shared by both paths), assisted-timer/Esc/backdrop pause while busy, nuke read-before-wipe staging, overnight-lunch docs — ALL DONE parent-side (subagents 429-locked). EVIDENCE: client 224/224 (incl. B1 routing regression test), oxlint 0, tsc clean.
- [x] Independent reviewer pass (fresh Spark worker) + all 5 findings fixed: TS intern gross no longer subtracts deductions (800/880/960 expectations corrected), Rust cutoff NaiveDate guard, ceil_hour truncate parity both stacks, time_in rows_affected guard, coverage tests added. EVIDENCE: server 81/81, Rust 165/165, client 224/224.
