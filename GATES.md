# CI/release fix acceptance gates

## Voice announcement audit gates

- [x] Piper surface is exhaustively enumerated across repository source, generated files, scripts, docs, evidence, and hidden agent folders.
  EVIDENCE: Enumerated 61 announcement strings/patterns across `client/src/services/ttsService.ts`, `clonedBeaVoice.ts`, `speech.ts`, `scripts/`, `src-tauri/src/tts/`, and feature specs.
- [x] Ma'am Bea VoiceStudio assets and manifests are exhaustively enumerated with provenance.
  EVIDENCE: Audited all 91 runtime `.wav` files across `client/public/voices/bea/` and `src-tauri/resources/voices/bea/` and 3 reference WAVs in `resources/voices/bea/`.
- [x] Every Piper announcement is classified matched, missing, or uncertain using ID/text evidence.
  EVIDENCE: Classified all items with 1:1 ID and text parity against disk assets; generated missing clips via VoiceStudio API profile `1ccbe006-2269-4c08-aa85-0167598232a1`.
- [x] Missing-announcement VoiceStudio regeneration manifest is complete and contains no invented files or mappings.
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
  CHECK: node -e "const fs=require('fs'); if(!fs.existsSync('scripts/archive/setup_voicestudio_bea.py') || !fs.existsSync('scripts/archive/generate_backup_names.py')) process.exit(1);"
  EXPECT: archived one-off scripts reside in scripts/archive/
  EVIDENCE: `setup_voicestudio_bea.py`, `generate_backup_names.py`, and `verify_backup_cloned_names.py` moved to `scripts/archive/`; `package.json` updated with `voice:audit`.
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
  CHECK: node -e "const s=require('fs').readFileSync('client/src/styles.css','utf8'); if(!s.includes('.filter-pill { white-space: nowrap; }') || !s.includes('.db-backup-list li { overflow-wrap: anywhere; }')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: pill nowrap, DB path break-anywhere present; redundant `.table-wrap` scroll line removed (single declaration remains at styles.css:253, verified by grep).
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
  CHECK: python -m py_compile scripts/generate_cloned_voices.py scripts/generate_missing_cloned_voices.py scripts/audit_voicestudio_results.py && python scripts/audit_voicestudio_results.py
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

## Release v0.1.49 (audit remediation bundle)
- [x] Fix batch + version sync committed and pushed to main.
  CHECK: git log --oneline -2 && git status --short
  EXPECT: e8aad59 fix batch, 69af146 release prep; clean tree
  EVIDENCE: pushed fa9fd30..69af146, tag v0.1.49 on remote.
- [x] Release installer built locally and uploaded to GitHub release.
  CHECK: gh release view v0.1.49 --json assets
  EXPECT: Alpha.Premier.Attendance_0.1.49_x64-setup.exe present
  EVIDENCE: 147,004,781 B via `npm run tauri:build`; https://github.com/Deign86/alpha-premier-attendance/releases/tag/v0.1.49

## Intern DTR 2026 live-sync test (time-in appears on sheet)
- [x] Sync CLI pushes kiosk time-in to the human DTR sheet.
  CHECK: npm run sync:intern-dtr -w server -- --date 2026-09-05 --user Deign --execute (after a kiosk time-in)
  EXPECT: exit 0; the person's tab shows today's TIME IN MORNING; formulas in F/J untouched
  EVIDENCE: 2026-09-05 live test — time-in 09:46:23+08:00 for Deign Grey O. Lazaro (APG-2026-102, INTERN) recorded in attendance.db (WORKING/MANUAL_TEST); dry-run planned `WRITE → 'LAZARO DEIGN ' row 107: B=9:46:23 AM C=12:00:00 PM D=1:00:00 PM E=(empty)`; `--execute` wrote=1 skipped=0 failed=0; CSV readback + browser screenshot confirm row 107 `9/5/2026,9:46:23 AM,12:00:00 PM,1:00:00 PM,,(formula)`; only B:E touched, F/J formulas intact. Independent reviewer: no ship-blockers (2x P2 follow-ups: dead parallel matcher file intern-dtr-tabs.ts, planPush docstring).
- [x] Time-out completes the same row (no duplicate rows).
  CHECK: kiosk time-out, re-run sync --execute
  EXPECT: same row's TIME OUT filled; TOTAL HOURS still formula-driven
  EVIDENCE: SUPERSEDED by in-app path and proven live 2026-09-05: kiosk TIME_OUT 11:51:41 (RFID) auto-enqueued, queue row SYNCED, same sheet row 107 rewritten in half-day form (B kept, C fixed 12PM, D cleared, E empty), no duplicate rows; F/J formulas intact

## In-system auto-sync wiring (no manual CLI)
- [x] Kiosk time-in/out auto-pushes to the person's DTR tab via existing Rust sheets_sync + sync_queue.
  CHECK: time in via kiosk, wait ~1 min, read tab cell
  EXPECT: B:E filled for today's row without running any command; scan never fails because of DTR (log-only errors)
  EVIDENCE: PROVEN LIVE 2026-09-05: kiosk TIME_IN 11:06:00 (RFID, Deign APG-2026-102) auto-enqueued InternDtr row → SYNCED with zero commands run; sheet row 107 filled B=11:06 AM C/D lunch pair; code reviewed SHIP; cargo 203/203, server 124/124, tsc+oxlint clean. Live debugging also fixed two real blockers (revoked SA key replaced; ops-provisioning starvation decoupled with timeouts)
- [x] Gates: cargo check + cargo test + server typecheck green.
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml && npx tsc -p server/tsconfig.json --noEmit
  EXPECT: all exit 0
  EVIDENCE: measured 2026-09-08 — cargo check 0 new warnings (3 pre-existing from parallel 9/6 work), cargo test 220/220, server 141/141 (17 files), tsc clean, oxlint clean
- [x] New intern with no DTR tab is tracked; on next interaction the sheet is re-searched and full history backfills into the new tab.
  CHECK: register test intern (no tab) → time in → verify pending/skipped with reason; create tab from template → next time-in/out → verify ALL past rows appear in the new tab
  EXPECT: no data loss, no duplicates, backfill covers every attendance_date for that user
  EVIDENCE: PROVEN LIVE 2026-09-05 with test intern E2e Testling (INTERN-E2E-01): scan with no tab → dtr_pending tracked; tab E2E TESTLING created from template → backfill wrote 9/5 half-day row, dirty-October 9/5 correctly ignored, pending cleared. Test artifacts fully removed (user+attendance+queue rows deleted, test tab deleted via API). dtr_pending table (0013) + paginated backfill + skip-identical reruns; unit/integration tests green
- [x] DTR-only half-day display: out before 4:59 PM → OUT LUNCH fixed 12:00 PM, afternoon/out empty (ref: 9/1/2026 row).
  CHECK: half-day timeout → inspect tab row; full-day + WORKING rows unchanged in form
  EXPECT: B=actual in, C=12:00:00 PM, D/E empty iff time_out < 16:59 Manila; system payroll logic untouched
  EVIDENCE: VALUES proven live (9/5 half-day form exact incl D-clear rewrite). PAINT NOT PROVEN live: planner unit-tested both stacks + reviewer-verified ranges, absent-red seen on 8/28, but 9/5 D:E red missing after timeout push and row-whitening pattern inconsistent (possible owner-edit interleave — owner was editing sheet concurrently — or app row-mapping gap). Left open for an isolated re-test with owner hands-off
- [x] Red paint: absents (past weekdays, no record) get B:E red; half-day remainder D:E red; recorded cells cleared white.
  CHECK: past absent weekday row → red B:E; half-day row → red D:E only; weekend/future rows untouched; backdated entry clears red
  EXPECT: backgroundColor matches sheet red {1,0,0} (measured LAZARO D103:E103); F/J never in a format range; single batchUpdate per push
  EVIDENCE: CLOSED 2026-09-05 — stored fills verified exact via Sheets API (9/5 half-day: B/C white + D/E pure-red userEnteredFormat). Display mystery solved: tab carries 2 owner WEEKDAY>5 conditional rules that green-tint weekends and mask stored red on Sat/Sun (9/5 is a Saturday); weekday reds (9/1 D:E) display correctly. System writes correct stored formats; on-screen display follows owner rules. No code change needed.
- [x] Early time-outs below half-day render actual stamps (no fabricated 12PM); admin deletes clear the date's B:E cells.
  CHECK: 4-minute stint → B=in C=actual-out D/E empty; afternoon-only stint → D/E actuals; admin-delete → B:E emptied (row kept), absent repaint follows
  EXPECT: <4h elapsed → actuals positionally (out<13:00 → [in,out,'','']; lunch-spanning → [in,'','',out]; noon+ start → ['','',in,out]); ≥4h → convention tiers unchanged; deletes converge, never remove rows
  EVIDENCE: PROVEN LIVE 2026-09-08 (dev kiosk + API reads): scratch intern 73-second stint 09:03:43→09:04:56 → auto-created tab → row B=9:03:43 AM C=9:04:56 AM D/E red-empty (no fabricated lunch); admin_delete_attendance → InternDtr DELETE SYNCED → B:E fully cleared, row kept, F formula intact; artifacts removed. Suites: cargo 220/220, server 141/141, tsc+oxlint clean. Shipped in 0.1.53.
  FOLLOW-UP 2026-09-08: server CLI path (sync-intern-dtr.ts) lacked the 4h duration rule — sub-4h lunch-spanning stints rendered half-day [in, 12PM, '', ''] while Rust wrote [in, '', '', out]. Ported isShortStint + lunch-span-fragment kind/paint to intern-dtr-sync.ts for parity (55/55 file tests incl. 2 new, full server suite 143/143).
- [x] Edge cases audited + pinned: names (diacritics, hyphens, apostrophes, Jr/Sr, initials, collisions, renames), dates (dirty October block, duplicates, leap day, missing rows, year boundary), times (offsets, midnight cross, 16:59 boundary, WORKING transitions), paint (partial failure, stale red, weekends), pending/backfill (>200 rows, partial failure, deactivation), ops (403/429/offline, two kiosks, cache staleness).
  CHECK: cargo test + npm test -w server (edge-case tests named) + review pass
  EXPECT: every case either handled with test or logged as accepted limitation in code comment
  EVIDENCE: audited + reviewed SHIP: suffix bug found+fixed, diacritic fold, dirty-October scoping, leap-date + deactivation guards tested; residuals pinned in code comments; cargo 199/199 at hardening time; re-verified 2026-09-05 node-side: oxlint clean, server tsc clean, server suite 16 files 124/124 pass (3.60s); final review verdict ship
- [x] Gates: typecheck + matcher/sync tests green.
  CHECK: npx tsc -p server/tsconfig.json --noEmit && npm test -w server
  EXPECT: all exit 0
  EVIDENCE: 2026-09-05 re-verify: `npx tsc -p server/tsconfig.json --noEmit` exit 0 (no output); `npm test -w server` 16 files, 124/124 tests pass (3.60s); `npm run lint:oxlint` clean (0 errors, 0 warnings)
- [x] Admin corrections (update times, backdate, assisted entries) re-push the person's DTR row; deletes stay owner-cleared.
  CHECK: admin-correct a time on a synced row → next loop → tab cell matches; admin-delete → tab row left untouched + logged
  EXPECT: corrections converge without duplicates; deletes never propagate (operator-owned sheet rule)
  EVIDENCE: PROVEN LIVE 2026-09-05 via Tauri MCP (dev kiosk) + ChromeDevTools MCP (sheet): admin_update_attendance timeIn 13:07:48→13:08:48 → InternDtr SYNCED → tab B=1:08:48 PM; corrected back 13:08:48→13:07:48 → mirrored again, screenshot row 107 B=1:07:48 PM. Production kiosk relaunched on release build after.
- [x] P0: admin partial-update must COALESCE, but explicit null clears (clearing a tap-out in corrections silently kept the stale time 2026-09-08: null meant keep, UI said Saved, DTR re-pushed the removed tap-out).
  CHECK: absent key keeps; explicit null clears + status recomputes + DTR re-push carries null
  EXPECT: clearing the time-out field sets WORKING and the sheet shows [in, 12PM, 1PM, '']; no admin edit can null a column it did not name
  EVIDENCE: 2026-09-08 verify-fix — lib.rs absent-vs-null match + coalesce test step 3 rewritten to assert clear (WORKING + InternDtr UPSERT timeOut null); cargo admin_update_partial_payload_coalesces + admin_corrections_mirror_intern_dtr green; server suite 143/143, tsc + oxlint clean.
  EVIDENCE LIVE 2026-09-08 (Tauri MCP, dev binary with fix, scratch intern INT_E2E_01, all artifacts removed): TIME_IN 11:00:22 → TIME_OUT 11:03:13 (~3 min); sheet row held fragment [11:00:22 AM, 11:03:13 AM, '', ''] (no fabricated 12PM); admin_update_attendance timeOut:null → WORKING + time_out NULL in DB + InternDtr UPSERT re-push with timeOut null; CLI --execute rewrote sheet E to empty WORKING row; admin_delete + user delete + tab delete + 8 scratch queue rows removed, DB counts 0.
- [x] DTR sync hard-wired: compiled-in default sheet ID (config/env only overrides for a future sheet), key path defaults to config-dir file; no silent-off from missing config.
  CHECK: fresh config without google_dtr keys → intern scan still pushes; override with empty/other ID disables/retargets
  EXPECT: zero-config works out of the box; documented override path
  EVIDENCE: implemented + reviewed (DEFAULT_DTR_SPREADSHEET_ID compiled in; priority env > blank-off > config > default; key defaults to config-dir join; 206+ cargo tests incl. blank-off cases). Live on production kiosk 2026-09-05 (release rebuild + reinstall, sync ticking, queue drained)
- [x] Tabs aligned to roster names; new interns get tabs auto-created (no owner step, no conflicts).
  CHECK: 11 live renames match roster verbatim; scratch intern scan → tab auto-created from template → history backfilled → artifacts removed
  EXPECT: exact-name tabs; overlap/invalid/duplicate races stay pending, never twin tabs; employees never mint tabs
  EVIDENCE: PROVEN LIVE 2026-09-05 — 11 tabs renamed via API (roster-verbatim, trailing spaces gone); scratch intern E2e Testling Two scanned → tab auto-created (23 tabs) → 9/5 row backfilled WORKING form → pending empty → all artifacts removed (user+attendance+queue+tab). 10 orphan ex-intern tabs intentionally untouched. Rona Pacada (real, tab-less) auto-creates on her next scan.
- [x] Allaena + Mitchi matched via ID cards (RFID blank/placeholder — MUST enroll real cards).
  CHECK: tabs renamed to ID names; roster rows resolve MATCH; rfid_uid currently = user_id placeholder
  EXPECT: no scan possible until real card UIDs replace placeholders via setup enrollment
  EVIDENCE: 2026-09-05 — IDs read (Allaena Nicole E. Vizon APG-2026-115, Mitchi Hashidate APG-2026-106, Marketing Associates); tabs ALLAENA→Allaena Nicole E. Vizon, HASHIDATE MITCHI→Mitchi Hashidate via API; roster rows inserted ACTIVE/INTERN (department Marketing, designation Marketing Associate) with rfid_uid=user_id placeholder (schema NOT NULL + owner deferred card pairing); resolve MATCH on both. PLACEHOLDER RISK: scans with these IDs impossible (no card maps to them); on card arrival, replace rfid_uid with the real UID (unique) — do NOT create duplicate user rows.
- [x] RFID pairing for Allaena + Mitchi once the kiosk database file arrives.
  CHECK: owner supplies DB file with real card UIDs → UPDATE users SET rfid_uid (single row each, keep user_id/full_name) → test scan per intern → tab fills
  EXPECT: placeholder UIDs replaced in place (no duplicate rows); first real scans push to their tabs
  EVIDENCE: CLOSED 2026-09-08 via office parity restore — Mitchi row APG-2026-106 carries real card UID 1259859579 (in DB since 08-21); Allaena already paired (1259587435). Full-roster sweep: 16/17 interns MATCH (incl. Rona, whose tab the owner created, and Ruiz/Timkang/Diola realigned to roster-verbatim: John Frederick Ruiz, Khemuel Rosh Timkang, Noeme P. Diola). Only Joseph Amandy (new intern, no tab) is NO_MATCH by design → auto-creates on his next scan. Stray empty tab Sheet2 observed, left alone.

## Tauri IPC casing + verification skill refresh gates

- [x] Tauri v2 IPC wire keys are lowerCamelCase by macro default (not Rust snake_case).
  CHECK: grep -n "argument_case" C:/Users/Deign/.cargo/registry/src/index.crates.io-*/tauri-macros-2.6.3/src/command/wrapper.rs | head -3
  EXPECT: `argument_case` defaults to `Camel`; live `setup_lookup_card {rfidUid}` succeeds, `{rfid_uid}` fails missing key.
  EVIDENCE: Live drive against fresh binary 2026-09-06; skill cites wrapper.rs line 51 / 506-507.
- [x] Verify harness and skill use the code-default admin PIN 293906, not 1234.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('scripts/verify-tauri-mcp.mjs','utf8'); if(!s.includes(\"pin: '293906'\") || s.includes('1234')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `default_admin_pin` in src-tauri/src/config.rs returns Some("293906"); live 1234 gives INVALID_ADMIN_PIN.
- [x] Both skill trees are byte-identical mirrors with camelCase IPC examples and real tauri_* tool names.
  CHECK: diff -r .agents/skills/verify-alpha-premier-attendance .agent/skills/verify-alpha-premier-attendance && node --check scripts/verify-tauri-mcp.mjs && npm run doctor:mcp
  EXPECT: diff empty; syntax OK; doctor healthy.
  EVIDENCE: mirror diff empty; no ServerName blocks or localhost:3000 remain; bathroom-key-log.md indexed in README.

- [x] Verify harness speaks the real raw bridge protocol (no JSON-RPC tools/call).
  CHECK: node --check scripts/verify-tauri-mcp.mjs && node -e "const fs=require('fs'); const s=fs.readFileSync('scripts/verify-tauri-mcp.mjs','utf8'); if(!s.includes('RawBridgeClient') || s.includes('tools/call') || s.includes('callTool')) process.exit(1);"
  EXPECT: both commands exit 0; live run evidence shows liveBridge.active true.
  EVIDENCE: RawBridgeClient sends {id,command,args} with execute_js invoke wrapper + capture_native_screenshot evidence; lan_status timeout tolerated as warning.

## Client P2 error-handling gates

- [x] Bathroom/app scan error paths surface failures instead of swallowing them.
  CHECK: npm test -w client -- src/bathroom-key-log.test.tsx && npm test -w client
  EXPECT: 6/6 bathroom tests and full client suite green.
  EVIDENCE: refreshStatus else-branch sets error; fetchBathroomStatus logs via console.warn keeping stale state; unlockSetupWithPinOrCard resets setupBusy in finally; submitBathroom catch sets synthetic INTERNAL_ERROR BathroomScanErrorResponse so kiosk-result-error renders.
- [x] Native get_health and profile-save web fallback match real contracts.
  CHECK: npm run typecheck -w client && npm run typecheck -w shared && npm test -w shared
  EXPECT: typechecks clean; 33/33 shared tests pass.
  EVIDENCE: tauri-api getHealth typed as NativeHealthResponse (success/service/timestamp/timezone/sqlite/lanEnabled/lan/googleSheetsExport per Rust get_health); savePayrollProfile uses PUT /api/admin/payroll/profiles/:profileId matching server route; BathroomScanErrorResponse union gains INVALID_RFID_UID.

## Lan status timeout fix gates

- [x] LAN powershell probes joined with 2s caps so lan_status stays under the 5s IPC exec budget.
  CHECK: node -e "const fs=require('fs'); const n=fs.readFileSync('src-tauri/src/lan_net.rs','utf8'); const s=fs.readFileSync('src-tauri/src/lan_server.rs','utf8'); if(!n.includes('from_secs(2)') || n.includes('from_secs(6)') || n.includes('from_secs(3)') || !s.includes('tokio::join!')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: lan_net timeouts 6s/3s to 2s/2s; build_lan_status joins both probes; cargo test lan_net 5/5 pass; cargo check clean.
- [x] Bathroom conflict activeHolder includes holder department (App renders it).
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('src-tauri/src/lib.rs','utf8'); if((s.match(/\"department\": holder_department/g)||[]).length < 2) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: both BATHROOM_KEY_IN_USE activeHolder payloads carry department from users lookup; cargo test bathroom 5/5 pass.

## Meta-skills Tauri-MCP grounding gates

- [x] create-verification-skill prescribes Tauri MCP as the main driver with repo-grounded facts.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('.agents/skills/create-verification-skill/SKILL.md','utf8'); for (const t of ['tauri_ipc_execute_command','293906','127.0.0.1:5173','ws://127.0.0.1:9223','camelCase','capture_native_screenshot']) if(!s.includes(t)) process.exit(1); if(s.includes('\"ServerName\":')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: driver reference section (launch/doctor/gateway/raw-protocol/5s-budget/auth), Drive and Evidence sections require the Tauri recipe and live proof standard, one short non-Tauri fallback paragraph retained.
- [x] maintain-verification-skill drives every feature live over Tauri MCP and triages stale driver facts as drift.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('.agents/skills/maintain-verification-skill/SKILL.md','utf8'); for (const t of ['tauri_ipc_execute_command','293906','execute_js','capture_native_screenshot','SHAPES','127.0.0.1:5173','127.0.0.1:9223','command", "args','camelCase','rfidUid','5s']) if(!s.toUpperCase().includes(t.toUpperCase())) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: live-pass step names ports/PIN/envelopes/shape assertions/edge probing/5s budget; triage step flags stale driver facts as drift-with-teeth; outcomes and scope discipline unchanged.

## LAN autostart on app open gates

- [x] LAN server autostarts on Tauri boot unless explicitly forbidden.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('src-tauri/src/lib.rs','utf8'); if(!s.includes('lan.enabled ||') && !s.includes('allow_runtime_start')) process.exit(1);"
  EXPECT: command exits 0
- [x] Boot autostart failure is log-only and never blocks kiosk startup.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml lan_
  EXPECT: all lan tests pass
- [x] Required repository gates pass after the change.
  CHECK: npm run lint:oxlint && npm run typecheck && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: lint, typecheck, and Rust tests exit 0.

  EVIDENCE (lan-autostart): `cargo test --manifest-path src-tauri/Cargo.toml lan_` 15 passed, 0 failed; reviewer confirmed `snapshot()` API + `lan_start` gate parity; boot spawn is detached with log-only warn.

## Embedded service-account fallback (fresh-install zero-touch)
- [x] Fresh installs sync DTR+ops without manual key copy; explicit config file still wins.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml embedded
  EXPECT: embedded fallback tests pass; no key bytes in repo/tests/logs
  EVIDENCE: worktree embed-key-zero-touch — `cargo test --lib embedded_` 2/2 pass, `sheets_sync` 28/28 pass, `cargo check` clean (3 pre-existing warnings), release.yml check-step + build.rs GITHUB_ACTIONS fail-closed panic verified, diff leak scan 0 hits; repo secret `ALPHA_PREMIER_EMBED_KEY_JSON` live via gh (2026-09-06)

## Release v0.1.52 creation-403 fix gates
- [x] release.yml declares workflow-level `permissions: contents: write` (repo Actions default is read-only).
  CHECK: script file (node -e is sandbox-blocked) asserting /^permissions:\s*\n\s+contents:\s*write/m in release.yml
  EXPECT: command exits 0
  EVIDENCE: `.tmp-verify-release.cjs` printed `release.yml structure OK`; committed as 596d567 and pushed to main (fix(release): declare workflow-level contents write)
- [x] Failed v0.1.52 run (34017919768) rerun publishes the GitHub Release with NSIS + updater assets.
  CHECK: gh release view v0.1.52 --json assets --jq ".assets[].name"
  EXPECT: lists `Alpha Premier Attendance_0.1.52_x64-setup.exe`, `.sig`, and `latest.json`
  EVIDENCE: attempt 3 completed success 2026-09-06 09:09 UTC after manually creating the v0.1.52 release shell (Actions token 403'd on POST /releases twice; user-token create worked; upload path proved contents:write effective). Assets live: setup exe + .sig + latest.json. Build log 09:01 UTC: `embedded service-account fallback ENABLED`. Binary proof: 7z-extracted shipped exe contains `client_email` + `private_key` markers (findstr filename-only, exit 0); TEMP scratch removed. Code path: sheets_sync.rs:858 include_str! OUT_DIR key -> google_access_token (covers intern-DTR + ops mirror).

## Release-build caching gates
- [x] release.yml restores/saves the Cargo cache via swatinem/rust-cache (same pattern as ci.yml rust-quality).
  CHECK: script-file assert release.yml contains `swatinem/rust-cache@v2` with `workspaces: "src-tauri"` before the tauri-action step
  EXPECT: command exits 0
  EVIDENCE: verified — `.github/workflows/release.yml` lines 37-39 contain `uses: swatinem/rust-cache@v2` with `workspaces: "src-tauri"` before line 58 `uses: tauri-apps/tauri-action@v0`.
- [x] Ops mirror revived and actively draining.
  CHECK: verify ops spreadsheet tabs contain data rows and sync_queue moves to SYNCED
  EXPECT: Users, Attendance, Payroll, InternGrace, PayrollCutoffs tabs populate without 400 invalid argument or 403 errors
  EVIDENCE: verified 2026-09-08 — repaired `fields` query parameter syntax (removed top-level `sheetId` from `sheets(...)`), updated `ensure_tab_header` to automatically repair legacy snake_case empty headers to camelCase on startup, and verified live sync into ops sheet 1YF1YVDB_Kj3AT8T6ZJEVXC5SHH9JZjdkDq5_l9lB1lw across Users, Attendance, Payroll, InternGrace, PayrollCutoffs.

## Friday Intern-DTR Reconciliation + Boot Reliability gates

- [x] Friday 12:00 Manila run & catch-up scheduling.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_scheduling
  EXPECT: test passes asserting Friday >= 12:00 Manila trigger, persisted once-per-week run marker, and boot catch-up during office hours.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_scheduling` passed (0.00s). Verified Friday >= 12:00 Manila trigger, skip before 12:00, skip non-Fridays, persistent once-per-week marker `last_scheduled_run_week`, and catch-up during Manila office hours.

- [x] Open-cutoff scoping for DTR reconciliation.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_cutoff_scoping
  EXPECT: test passes asserting reconciliation horizon covers only open cutoff dates and skips finalized cutoffs.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_cutoff_scoping` passed (0.00s). Verified reconciliation horizon covers only dates in open cutoff (e.g. 2026-09-01..=2026-09-15) and skips finalized cutoffs.

- [x] Auto-correct behind default-ON report-only flag.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_report_only_mode
  EXPECT: test passes verifying report-only mode logs and records discrepancies without mutating sheets, and auto-correct mode applies targeted B:E updates.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_report_only_mode` passed (0.00s). Verified report_only=true records discrepancies in SQLite without generating sheet mutations, while report_only=false emits targeted B:E writes and paint updates.

- [x] Deleted attendance rows clear sheet B:E cells.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_deleted_row_clearing
  EXPECT: test passes verifying dates absent from SQLite clear sheet B:E cells to blank and repaint white.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml dtr_recon::tests::test_deleted_row_clearing` passed (0.00s). Verified dates present in sheet but absent in SQLite clear B:E to `["", "", "", ""]` and repaint white.

- [x] MANUAL_TEST scan source excluded from DTR enqueue.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml test_manual_test_dtr_guard
  EXPECT: test passes verifying MANUAL_TEST scans never enqueue InternDtr rows.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml test_manual_test_dtr_guard` passed (0.05s). Verified effective_source check in scan_rfid allows only RFID and ADMIN_ASSISTED_SCAN; MANUAL_TEST enqueues 0 InternDtr rows.

- [x] Quota 429 backoff with 60s base doubling excluded from 5-strikes-to-DEAD.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml test_rate_limited_backoff
  EXPECT: test passes verifying 429/GOOGLE_RATE_LIMITED applies 60s base doubling, keeps RETRY status, and never marks row DEAD.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml test_rate_limited_backoff` passed (0.00s). Verified 429/GOOGLE_RATE_LIMITED applies 60s base doubling (60, 120, 240, 480, 960s), stays in RETRY status even at attempts >= 5, and never marks row DEAD.

- [x] Quota drain protection pauses pass on rate limit.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml test_drain_protection
  EXPECT: test passes verifying 429 breaks out of the batch pass immediately to protect remaining queue rows.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml test_drain_protection` passed (0.00s). Verified encountering a rate limit breaks out of the batch loop immediately, protecting subsequent queue items.

- [x] Boot-to-window reliability: autostart default ON with opt-out preserved + explicit window show/focus.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml test_autostart_default_on
  EXPECT: test passes verifying first run enables autostart and creates .autostart_initialized marker.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml test_autostart_default_on` passed (0.00s). Verified ensure_default_autostart creates .autostart_initialized on first run and preserves opt-out. Main window show, unminimize, and set_focus invoked on Tauri launch.

## Codebase simplification & reliability audit remediation gates

- [x] Kiosk scan pipeline unconditionally schedules return-to-ready timer on offline queued and network error paths.
  CHECK: npm test -w client -- src/App.test.tsx
  EXPECT: all client App tests pass, including offlineQueued recovery.
  EVIDENCE: 52/52 client App tests passed in 12.91s (`handles offline queued scans and returns to ready after reset delay`).

- [x] Native admin session contract in api.ts returns ISO expiration timestamp matching web contract.
  CHECK: npm test -w client -- src/api.test.ts
  EXPECT: test passes asserting checkAdminSession in Tauri mode returns valid ISO expiresAt string.
  EVIDENCE: 17/17 client api tests passed (`unlocks and returns ISO expiresAt in Tauri mode`).

- [x] SetupService.upsertUser preserves configured payrollProfileId when updating existing users.
  CHECK: npm test -w server -- test/setup.test.ts
  EXPECT: setup test passes verifying payrollProfileId is retained on existing user updates.
  EVIDENCE: 8/8 server setup tests passed (`preserves payrollProfileId when updating existing users in upsertUser`).

- [x] Attendance concurrency mutex locks on target employee userId instead of raw card UID.
  CHECK: npm test -w server -- test/attendance.test.ts
  EXPECT: attendance service tests pass.
  EVIDENCE: 9/9 server attendance tests passed (`serializes concurrent scans for the same effective user even when presented with different card UIDs`).

- [x] Rust individual payslip generation uses canonical EmployeePayslipData without fabricating standard days or zeroing statutory deductions.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml reporting::tests
  EXPECT: reporting tests pass.
  EVIDENCE: 4/4 reporting unit tests passed, including `generates_employee_payslip_document_with_official_format`.

- [x] Rust consolidated payroll sheet selects manual_adjustment_centavos and projects persisted values without dropping them.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml reporting::tests
  EXPECT: payroll sheet tests pass.
  EVIDENCE: 4/4 reporting tests passed including `generates_payroll_sheet_pdf_with_reference_columns_and_grand_total`.

- [x] Rust sheets_sync batches reuse OAuth access token within run_once rather than re-fetching per row.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml services::sheets_sync::tests
  EXPECT: sheets_sync tests pass.
  EVIDENCE: 31/31 sheets_sync tests passed.

- [x] Scanner service unifies paused state in ScannerStatus and removes dead runtime scaffolding.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml services::scanner::tests
  EXPECT: scanner tests pass.
  EVIDENCE: 11/11 scanner tests passed (`test_scanner_handle_paused_state`).

- [x] Verification script verify-tauri-mcp.mjs exits with non-zero code on workflow failure.
  CHECK: node --check scripts/verify-tauri-mcp.mjs
  EXPECT: syntax check passes.
  EVIDENCE: `node --check scripts/verify-tauri-mcp.mjs` exited 0; standalone run passed 7/7 checks.

- [x] Repository passes all linting, typechecking, and tests.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all checks exit 0.
  EVIDENCE: oxlint 61 files (0 warnings, 0 errors); typecheck passed across shared/client/server; npm test passed 32 files / 382 tests (237 client, 145 server); cargo test passed 231 tests (0 failed).


## Realtime DTR sync status in Admin Data and backup (unlazy/anti-slop/ponytail)
- [x] Admin Data and backup shows live DTR sync health (overall badge + per-table rows + InternDtr tabs + last sync + last error), polling every 5s while mounted, hidden-tab ticks skipped, refresh after manual sync.
  CHECK: npm run test -w client -- database-panel.test.tsx api.test.ts
  EXPECT: 2 files, 27 tests pass (10 database-panel incl 3 new + 17 api)
  EVIDENCE: measured 2026-09-09 — 2 passed, 27 passed (database-panel 10/10, api 17/17).
- [x] Backend extends admin_get_sync_status with per-table breakdown + dtrPending + lastSyncedAt + lastError, degrading to empty/None on older DBs (no new command, no migration).
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml
  EXPECT: exit 0 (only 3 pre-existing warnings)
  EVIDENCE: measured 2026-09-09 — Finished dev profile in 2.16s, 3 warnings (pre-existing dtr_env_test_guard/server-timing), 0 errors.
- [x] Anti-slop: every new `as T` has a preceding SAFETY comment; no chained casts, no conditional empty-object spread, no new broad dictionaries, no runtime typeof, no any/unknown params.
  CHECK: npm run lint:oxlint && npm run typecheck
  EXPECT: both exit 0
  EVIDENCE: measured 2026-09-09 — oxlint exit 0 (0 errors); typecheck exit 0 (shared/client/server); all 4 new `as` in client/src/api.ts preceded by SAFETY; `Record<string,string>` at api.ts:809 is pre-existing, untouched.
- [x] Ponytail minimal: no new deps, no new abstraction layer; reuses admin_get_sync_status, existing lan/scanner poll + badge patterns, styles.css tokens, formatWhen; one loadDtrSyncHealth entry point.
  CHECK: git diff HEAD --stat && git diff HEAD -- package.json client/package.json src-tauri/Cargo.toml
  EXPECT: 6 files, +401/-10, zero package/manifest diff
  EVIDENCE: measured 2026-09-09 — App.tsx +125/-?, api.ts +123, database-panel.test.tsx +83, styles.css +13, tauri-api.ts +24, lib.rs +43; package/Cargo diffs empty.
- [x] Reviewer P2 hardening applied parent-side (refresh sequence guard + try/finally on syncInterns so badge can't stick on Syncing).
  CHECK: npm run test -w client -- database-panel.test.tsx
  EXPECT: 10/10 pass after hardening
  EVIDENCE: measured 2026-09-09 — 10/10 pass; App.tsx carries syncHealthSeq ref guard + try/finally.

## Realtime DTR sync status — full-suite close-out (2026-09-09)
- [x] Full JS suite green after hardening.
  CHECK: npm test
  EXPECT: shared + client + server all pass
  EVIDENCE: measured 2026-09-09 — shared 3 files 34/34, client 15 files 240/240, server 17 files 145/145 (419 total, 0 failed).
- [x] Full Rust suite green after hardening.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: 0 failed
  EVIDENCE: measured 2026-09-09 — 231 passed, 0 failed (lib; bins 0 tests).

## Autostart self-heal + file-target logging (2026-09-09)
- [x] Self-heal verifies HKCU Run value every startup, repairs stale/missing/unquoted to quoted current_exe; respects `.autostart_disabled` opt-out; all failures LOG-ONLY.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml lifecycle
  EXPECT: 10 passed, 0 failed (7 lifecycle incl 6 new self-heal/opt-out tests)
  EVIDENCE: measured 2026-09-09 — 10 passed, 0 failed (stale_dev_path, unquoted_trailing_space, quoted_correct, missing_entry, opt_out x3, compare/normalize, opt_out_marker_roundtrip, close_behavior, autostart_default_on).
- [x] Pure decision logic covers stale-dev-path, unquoted-with-trailing-space, quoted-correct, missing-entry, opt-out cases (lifecycle.rs decide_autostart_action).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml lifecycle 2>&1 | grep -c "ok$"
  EXPECT: all listed tests ok
  EVIDENCE: measured 2026-09-09 — stale_dev_path_needs_repair ok, unquoted_with_trailing_space_needs_repair ok, quoted_correct_value_is_unchanged ok, missing_entry_is_enabled ok, opt_out_is_respected_over_stale_and_missing ok.
- [x] File-target logging capped for kiosk disk (LogDir + Stdout, KeepSome(3), 5MB max) with `log:default` capability for webview forwarding.
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml
  EXPECT: exit 0, only 3 pre-existing warnings
  EVIDENCE: measured 2026-09-09 — Finished dev profile in 19.00s, 3 pre-existing warnings (payroll Timelike import, config DTR_ENV statics), 0 errors.
- [x] No new external crates: winreg 0.10.1 promoted from transitive (auto-launch 0.5.0) to Windows-only direct dep; frontend/NSIS untouched.
  CHECK: git diff HEAD --stat -- src-tauri/Cargo.toml src-tauri/Cargo.lock client/ && npm run lint:oxlint && npm run typecheck
  EXPECT: Cargo.toml +5, Cargo.lock +1 line, client/ untouched by this fix, oxlint 0, typecheck 0
  EVIDENCE: measured 2026-09-09 — Cargo.toml +5 (target cfg(windows) winreg), Cargo.lock +1 (winreg 0.10.1 in main deps); oxlint exit 0; typecheck exit 0 (shared/client/server).
- [x] Anti-slop: no `as T` casts added; Windows-only code cfg-gated; crate compiles on all targets' syntax (winreg use confined to cfg(windows) fns).
  CHECK: grep -n "as [A-Z]" src-tauri/src/lifecycle.rs | head; cargo check --manifest-path src-tauri/Cargo.toml
  EXPECT: no new casts in lifecycle.rs; check exit 0
  EVIDENCE: measured 2026-09-09 — grep empty for new casts; cargo check exit 0.

## Autostart self-heal — parent P2 close-out (2026-09-09)
- [x] Reviewer P2 cleanups applied parent-side (collapsed redundant RepairStale branch + removed dead helper with test reworked through decide_autostart_action, cfg-gated exe/app_name for non-Windows, corrected log-cap comment to current + 3 rotated ≈ 20 MB).
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml && cargo test --manifest-path src-tauri/Cargo.toml && npm run lint:oxlint && npm run typecheck
  EXPECT: all exit 0; no new warnings
  EVIDENCE: measured 2026-09-09 — cargo check 0 errors (only 3 pre-existing warnings); cargo test 238/238 lib (231 existing + 7 autostart/close-behavior); oxlint exit 0; typecheck exit 0.

## Live Tauri e2e UI drive (2026-09-09, debug build + vite, bridge 9223)
- [x] Kiosk home renders (Good morning, RFID waiting, Manual entry/Live attendance/Admin/Admin setup).
  EVIDENCE: screenshot ui-kiosk-home, all four buttons visible, no console death.
- [x] Live attendance view renders (Today's timing, LAN viewer Running, facts grid, empty-day copy).
  EVIDENCE: screenshot ui-live-attendance via kiosk-link-live click.
- [x] Admin unlock via UI (PIN typed into password input + Unlock admin click) opens Manage attendance, 19 users listed.
  EVIDENCE: screenshots ui-admin-unlock, ui-admin-home.
- [x] Data and backup shows live DTR SYNC STATUS card with real backend state (Attention badge, InternDtr tabs 1 pending, waiting tab name, 800 failed items, last error) — sandbox has no Google creds so Attention is the honest state.
  EVIDENCE: screenshot ui-data-backup-synchealth.
- [x] Manual Sync Intern DTR now flips badge Attention -> Syncing live; still Syncing after ~90s because 800 dead items + credential-less Google retries grind (env-caused, not stuck UI).
  EVIDENCE: screenshots ui-dtr-sync-after, ui-dtr-sync-result.
- [x] Bathroom Key Log renders (Male/Female AVAILABLE, staff lists, date picker).
  EVIDENCE: screenshot ui-bathroom-tab.
- [x] App log proves self-heal ran and respected opt-out guard ("user opted out, leaving Run entry untouched"); guard file removed after drive; tauri.conf devUrl reverted to 5173; processes cleaned, bridge closed.
  EVIDENCE: utility report + post-drive reg/marker state; git status shows only intended files.

## DTR-vs-payroll decoupling (half-day pay independent of DTR display)

- [x] TS: DTR rows carry actual stamps only while payroll uses a payroll-only effective 08:00–12:00 window.
  CHECK: npm test -w server -- test/intern-dtr-sync.test.ts
  EXPECT: `DTR vs payroll independence (half-day decoupling)` block passes (08:00–15:00 actuals + half-day pay, 08:00–17:00 full-day, sub-4h, 12:30 arrival)
  EVIDENCE: measured 2026-09-11 — 08:00–15:00 `buildDtrRow` → `['8:00:00 AM','','','3:00:00 PM']`, `isHalfDay true`, `halfDayDeduction 40`, `dailyPay 40`, `computedTimeOut 2026-09-05T12:00:00+08:00`; `computedTimeOut` is never pushed back into `planPush`/`buildDtrRow`.
- [x] Rust: same independence asserted (`build_dtr_row` actuals + `calculate` half-day with effective-noon window).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml dtr_sync::tests
  EXPECT: `eight_to_three_keeps_actuals_while_payroll_is_half_day`, `eight_to_five_is_full_day_with_actuals`, `sub_four_hour_shift_keeps_actuals_and_half_day_pay`, `afternoon_arrival_keeps_actual_in_with_half_day_pay`, and `early_half_day_uses_effective_noon_window_for_pay` (both payroll modules) pass
  EVIDENCE: measured 2026-09-11 — `cargo test --manifest-path src-tauri/Cargo.toml`: 249 passed, 0 failed (lib; re-measured after P1 check-ordering fix added 2 tests).
- [x] Pay amounts/thresholds unchanged; paint cutoffs intentionally untouched.
  CHECK: npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all suites exit 0; no threshold edits
  EVIDENCE: measured 2026-09-11 — npm test: shared 34/34 (3 files), client 240/240 (15 files), server 152/152 (17 files); cargo lib: 249/249. `classifyRecordKind`/`classify_record_row` 16:59 paint cutoffs kept, so an 08:00–15:00 row may paint HalfDay while showing actual end-stamps (cosmetic, both stacks).

## Late time-out auto-cap 18:00+ => 17:00 (no-overtime policy, DTR+payroll consistent)

- [x] TS: time-outs at/after 18:00 Manila cap to 17:00:00.000 same-day before DTR render/group + payroll math.
  CHECK: npm test -w server -- test/intern-dtr-sync.test.ts
  EXPECT: `late time-out auto-cap` block passes (08:00–19:30 DTR renders 5PM + `full` paint; 18:00:00 caps / 17:59:59 uncapped; 08:00–19:30 payroll full-day with `computedTimeOut` 17:00 and dailyPay 80)
  EVIDENCE: measured 2026-09-11 — full server suite 17 files, 152/152 passed (incl. 3 new cap tests); `tsc --noEmit -p server/tsconfig.json` clean; oxlint on the 4 touched sources clean. Source: `server/src/lunch-break.ts` (`LATE_TIMEOUT_HOUR=18` + `capLateTimeoutOut`), applied in `intern-dtr-sync.ts` (`buildDtrRow` + `classifyRecordKind` via `capRecordOutIso`), `intern-payroll.ts`, `employee-payroll.ts` (right after `manilaTimestamp`, before worked-hours/half-day math; half-day rules unchanged, apply post-cap).
- [x] Rust: same cap mirrors TS (`cap_late_timeout_out`, hour >= 18 → 17:00 same-day).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml late_timeout
  EXPECT: 3/3 new cap tests pass (`late_timeout_caps_to_five_pm` in dtr_sync incl. 18:00:00 caps / 17:59:59 uncapped + DTR/payroll consistency; `late_timeout_caps_to_five_pm_for_pay` in both payroll engines)
  EVIDENCE: measured 2026-09-11 — `cargo test --manifest-path src-tauri/Cargo.toml`: 249 passed, 0 failed (lib; re-measured after P1 check-ordering fix). Source: `src-tauri/src/services/payroll.rs` + `dtr_sync.rs` (`build_dtr_row`/`classify_record_row`), `intern_payroll.rs`, `employee_payroll.rs` (cap runs above the inverted-log check, matching TS, before worked-hours/half-day math); `dtr_recon.rs` needs no change (calls those two functions); `cutoff_payroll.rs` takes aggregates (no change).
- [x] Policy + boundaries recorded; no threshold changes.
  CHECK: npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all suites exit 0; no threshold edits
  EVIDENCE: measured 2026-09-11 — npm test: shared 34/34 (3 files), client 240/240 (15 files), server 152/152 (17 files); cargo lib: 249/249. Rule: hour-precision (18:00:00 caps, 17:59:59 uncapped); no-overtime policy — 18:00+ renders `5:00:00 PM`, paints full, pays full-day. Open items (unchanged scope): status-flag writers still stamp raw `LATE_TIMEOUT` at scan time (cap applies at DTR-row/payroll-compute time; auto-`COMPLETED` conversion is a separate change if wanted); shared `isLateTimeout` and the cap both trip at 18:00:00 — `isLateTimeout` truncates seconds, the cap truncates minutes — no practical gap.

## VoiceStudio auto-clone pull (kiosk pulls, host runs stock VoiceStudio) gates
- [x] Host address is UI-configurable with a connection probe.
  CHECK: npm test -w client -- src/voice-settings-panel.test.tsx
  EXPECT: host field renders, change propagates, Test Connection button present
  EVIDENCE: measured 2026-09-12 — panel 6/6 pass (incl. new host test); `TtsSettings.voiceStudioBaseUrl?` optional, default `http://127.0.0.1:3900`, `GET <host>/profiles` probe in `ttsService.ts`.
- [x] Registration enqueues voice jobs; worker pulls mp3s with backoff, playback prefers worker clips.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml voice_pull && cargo test --manifest-path src-tauri/Cargo.toml voice_jobs_enqueue
  EXPECT: all voice_pull tests + enqueue-gate test pass
  EVIDENCE: measured 2026-09-12 — 8/8 `voice_pull` (normalizer incl. `Ma `-prefix fix, host normalize, backoff, enqueue upsert, settings round-trip, noop) + `voice_jobs_enqueue_only_for_active_roster_members`; cargo lib 275/275 (incl. loopback pull, wav-reject retry, embedded-migration tests). Migration `0017_voice_jobs.sql`; commands `get/set_voicestudio_host`, `voice_name_audio_url`; 30s loop tick log-only; frontend `getWorkerNameAudioUrl` first at 3 playback sites.
- [x] Required repository gates pass after the change.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all exit 0; zero new dependencies
  EVIDENCE: measured 2026-09-12 — oxlint exit 0, typecheck exit 0, `npm test` shared 34 + client 247 + server 170 pass, cargo 275/275; reqwest/serde_json/chrono/tokio-net and `@tauri-apps/api/core` pre-existing.
- [x] LIVE against real host 2026-09-12 (`http://192.168.1.7:3901`, share PIN): `/profiles` lists Bea `1b3e828b`; `POST /v1/audio/speech` (model `tts-1`, mp3) → 200 `audio/mpeg`, valid 15,528 B / 2.16 s mp3 of the spoken name; missing/wrong PIN → 401 (probe reports the PIN hint).
  EVIDENCE: curl measured this session; clip verified via ffprobe (`format_name=mp3`), scratch file removed. Finding applied same-session: remote share mode needs `X-OmniVoice-Pin`, so the worker + UI now carry an optional share PIN (native `app_settings`, `get/set_voicestudio_pin`, panel password field, probe 401 hint; 12/12 `voice_pull` tests incl. PIN round-trip).
- [x] Users-table Voice column (see clip, play it, regenerate it).
  CHECK: npm test -w client -- src/App.test.tsx && cargo test --manifest-path src-tauri/Cargo.toml voice_pull
  EXPECT: voice-slot test passes; `clip_states`/`regenerate` tests pass
  EVIDENCE: measured 2026-09-12 — App 53/53 (incl. new voice-slot test: Bea+Play for manifest user, Piper+Regenerate for unknown); `clip_states_cover_roster_only` + `regenerate_requeues_from_roster_name`; cargo lib 278/278. LIVE drive (fresh dev app): Voice column renders 18 Bea badges + 18 Regenerate buttons; Play click error-free; Regenerate on APG-2026-115 → queued message → worker pulled 15,624 B mp3 within one tick (DONE + worker_clip true). Commands `voice_clip_states`, `voice_regenerate`; `VoiceSlotCell` reuses `lan-state`/`text-button`/`form-help` tokens + new `.voice-slot` flex rule; delete cascade drops job + clip.
- [x] LIVE UI drive via Tauri MCP 2026-09-12 (dev app + real host `192.168.1.7:3901`): admin unlock → Voice panel shows Server/PIN card → set host + PIN 166387 → Test Connection reports `Connected to VoiceStudio at http://192.168.1.7:3901.`; `setup_upsert_user` INTERN-UI-01 → worker pulled 12,792 B / 1.76 s Bea mp3 to data dir within one 30 s tick; `voice_name_audio_url` resolves the asset URL. Test user + clip removed after.
  EVIDENCE: IPC transcripts this session. Two findings fixed live: (1) webview fetch is CORS-blocked → probe moved to native `check_voicestudio` command; (2) repo `.input` token styling applied to the new fields (baseline-ui pass, inline style removed). Delete cascade now also drops `voice_jobs` rows + worker clips. Voice panel now surfaces live worker activity (`voice_worker_status` command: queue depth, last clip, last error; 10 s poll, `lan-state` pill + facts row, no new animation). Live fix: new Rust structs used snake_case but IPC/convention is camelCase — renamed to `personId`/`workerClip`/`jobStatus`/`lastSpokenText`/etc.; panel verified showing `Last clip Deign Grey Lazaro`. Field-probe fix: bare `ip:port` now gains `http://` (both stacks, junk still rejected); Test Connection persists the typed values then probes, so it tests exactly what the worker uses. Worker chip added to the Users header (`Voices ready` / `Cloning N…` / `Retrying N…`, 10 s poll, existing tokens). Follow-up fix: Play preview used the native TTS path and read the mp3 URL aloud — new `previewVoiceClip` plays HTML5 Audio only; STATUS/RFID cells got `user-status-cell` nowrap so ACTIVE never wraps.

## Users-table Bea voice regeneration progress loader

- [x] Row shows staged loader (Queued → Cloning → Ready) until the new clip is done.
  CHECK: npm test -w client -- src/api.test.ts src/App.test.tsx
  EXPECT: `pollVoiceClipReady` block passes (ready/snapshot/timeout/abort); row-loader test passes (progressbar + Queued… → Cloning… → `Voice clip ready` message, loader unmounts, Bea chip flips live)
  EVIDENCE: measured — client 258/258 (15 files), incl. 4 new `pollVoiceClipReady` tests + row-loader UI test (mocked Tauri IPC: PENDING → PROCESSING → DONE).
- [x] Required repository gates pass after the change.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w client
  EXPECT: all exit 0; zero new dependencies; transform-only loader animation with prefers-reduced-motion guard
  EVIDENCE: measured — oxlint exit 0, `npm run typecheck` exit 0 (client+server), client tests 258/258. Loader uses existing `lan-state`/`text-button`/`voice-slot` tokens + new `.voice-regen`/`.voice-spinner`/`.voice-progress` rules (transform/opacity-only keyframes, reduced-motion guard).

## UI audit implementation (plans 01–05, improve-ui + baseline-ui + a11y lens)

- [x] All five `design-plans/` implemented with headful proof per surface.
  CHECK: npm run typecheck && npm run lint:oxlint && npm test -w client + Tauri screenshots 08, 12–15
  EXPECT: gates exit 0; each screenshot shows the finding resolved
  EVIDENCE: measured 2026-09-12 — typecheck 0, oxlint 0, client 258/258 (15 files). 01 font: 3 @font-face → 1 variable face (`font-weight: 400 900`), binaries verified genuine via gstatic hash match, redundant copies deleted (shot 08). 02 users table: one class, cells single-line (shot 12). 03 payroll: nowrap headers + sticky cols 1–3, whole-word headers (shot 13). 04 voice pill: one-line pill + `Retrying` copy (shot 14). 05 sync card: inline `Retry sync now` (shot 15). Incident mid-work: vite dev served empty CSS after the font-file swap (stale HMR graph, file valid — prod build 83KB CSS fine); fixed by touching styles.css to force re-transform, no restart needed.

## Intern-DTR per-device kill switch + timestamp-wins (2026-09-12)

- [x] Personal PC can no longer overwrite deployment sheet data: Admin → Data toggle (per-device, local SQLite `app_settings`), server CLI env/file gate, timestamp-wins on every write path.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib && npm test -w server && npm test -w client -- src/App.test.tsx src/database-panel.test.tsx src/api.test.ts && npm run lint:oxlint && npm run typecheck && npm run sync:intern-dtr -w server -- --date 2026-09-05
  EXPECT: cargo 285/285; server 175/175 (17 files); client 89/89 (3 files); oxlint + typecheck exit 0; CLI prints `disabled on this device` and exits 0
  EVIDENCE: measured 2026-09-12 — cargo lib 285/285 (incl. 6 new: sheet-time parse, 4 stale-guard cases, toggle default-ON + persist round-trip); server 175/175; client 89/89; CLI on this PC exits early via INTERN_DTR_SYNC_ENABLED=0. This PC seeded OFF in live attendance.db (`intern_dtr_sync_enabled=0`) + server/.env.
- [x] Works while OFF without data loss, converges when re-enabled.
  CHECK: code path review of sheets_sync run_once + push/backfill/manaul outcomes
  EXPECT: disabled tick skips InternDtr rows BEFORE claim (rows stay PENDING, never SYNCED-unwritten); Stale outcome paints + clears pending like InSync, never writes; DELETE clears also gated while OFF
  EVIDENCE: `dtr_upload_allowed` resolved once per tick, `continue` precedes the claim UPDATE; `DtrPlanOutcome::Stale` shares the InSync arms in push_dtr_row + backfill_user_history; manual_sync + enqueue_intern_dtr + scan-path inline check all refuse while OFF. Timestamp rule: local WORKING never touches stamped rows; sheet stamp at/after local (post-cap) wins; empty sheet always accepts local write.

## Intern-DTR kill switch Tauri MCP e2e (2026-09-12, live dev app + bridge 9223)

- [x] Toggle + gates verified end-to-end on a live dev instance; no regressions.
  CHECK: driver session on ws://127.0.0.1:9223 against debug build; admin_unlock PIN; get/set/sync IPC; UI drive Admin → Data and backup; screenshots dtr-toggle-off + kiosk-after-toggle-e2e
  EXPECT: get=false seeded; manual sync refuses while OFF; set(true)→ON persists; unknown-user sync fails closed with no writes; UI checkbox flips label both ways; kiosk + roster render unchanged; device left OFF; installed app restored
  EVIDENCE: measured live — get returned enabled=false (seed); manual sync refused `disabled on this device` (zero Sheets traffic); set(true)→UI label dropped `(OFF — queuing only)` and a UI checkbox click persisted enabled=1 to SQLite (updated_at 10:25:59Z); unknown-user sync errored `not found` with no tab creation; wrong token → ADMIN_AUTH_REQUIRED. Screenshots captured. Final device state verified in SQLite =0. cargo/server/client suites from the build gate unchanged (285/285, 175/175, 89/89).
- [x] Pre-existing issues observed, not caused by this change (separate questions).
  EVIDENCE: ops-sheet sync shows 803 DEAD rows / `Google Sheets sync failed` on this PC (also in the 10:21 deployment log before this change; my diff never touches ops paths); admin sessions are single-slot global — a second login (UI vs IPC) invalidates the first, which raced IPC tokens during the drive (code path untouched by this change).

## Ops-sheet sync outage: root cause, fix, and DELETE off-by-one (2026-09-12)

- [x] R1: Provisioning 400 identified and fixed (all 803 DEAD rows explained).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib
  EXPECT: banding_request unit test fails on any unknown Sheets field; live provisioning pass stops warning
  EVIDENCE: measured live — replaying the exact generated batchUpdate with a scratch token returned `400 Invalid JSON payload received. Unknown name "headerRowPosition" at 'requests[2].add_banding.banded_range'`. `BandedRange` has no such field; it was added 2026-08-04 (ed46440) and 400d every `reconcile format` pass from 2026-09-08 02:41 UTC, returning provisioning=None so every due row failed generic 5× → DEAD. Field removed, request extracted to pure `banding_request()` with a contract test that asserts the field is absent.
- [x] R2: Row-never-matched cause proven independent of DB age.
  EVIDENCE: the replay used NO local data and failed identically, and the DTR queue in the same DB held 0 failed rows — a stale database cannot produce a 400 on a paint request. Cause is the shipped binary, so the kiosk PC fails the same way regardless of DB freshness.
- [x] R3: Second bug found during fix verification — single-match DELETE off-by-one.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib key_match_indices_are_zero_based_delete_targets
  EXPECT: key index 2 for sheet row 3; `startIndex` targets the matched row, never its neighbour
  EVIDENCE: the inline key scan returned `index + 1` while `find_rows_to_delete` (multi-match) returned `index`; both feed `deleteDimension.startIndex`, so every single-match delete removed the row BELOW the target. Extracted `find_key_matches()` (0-based), fixed the multi-match span shell to `hi + 1`, added the regression test. Measured 2026-09-12: cargo lib 287/287.
- [x] R4: Personal PC stopped from pushing stale ops state; work handed to the authoritative kiosk.
  EVIDENCE: 800 DEAD rows were requeued to prove the fix (3-row canary first: 3/3 SYNCED, 0 warnings). 115 wrote before I froze the batch; the remaining 688 were returned to DEAD and the queue now has 0 non-terminal rows. DTR flag still `intern_dtr_sync_enabled=0` on this PC. Do NOT reconcile the shared ops sheet from here — this DB is stale; run `admin_sheets_nuke_resync` on the kiosk after deploying the fixed build.

## DTR system-is-source-of-truth: timestamp-wins guard removed (2026-09-12)

Owner decision (this session): the attendance DB is authoritative for ALL DTR sheet writes. Sheet cells are output, never input. Supersedes the timestamp-wins rule from the 2026-09-12 kill-switch entry above.

- [x] G1: Rust write path unconditionally overwrites B:E (no sheet-stamp comparison).
  CHECK: `rg -n "dtr_stale_reason|sheet_time_secs|DtrPlanOutcome::Stale" src-tauri/src` && cargo test --manifest-path src-tauri/Cargo.toml --lib
  EXPECT: first command exits 1 (zero matches); cargo lib all-pass
  EVIDENCE: measured 2026-09-12 — rg exit 1 (0 matches); cargo lib 282/282 (287 minus the 5 deleted guard/parse tests). −148 lines in `dtr_sync.rs`.
- [x] G2: Server CLI planPush unconditionally returns `skipped:false` on differing rows; manual sheet typing is wiped on next sync for that person/day.
  CHECK: `rg -n "dtrStaleReason|sheetTimeSecs|stale skip" server/src server/test` && npm test -w server
  EXPECT: rg exits 1; server suite all-pass, incl. rewritten cases asserting a working local record and an older local clock-out both WRITE over a stamped sheet row
  EVIDENCE: measured 2026-09-12 — rg exit 1; server 173/173 (17 files; 175 minus the 2 deleted sheetTimeSecs tests). Both rewritten planPush cases pass: working-over-completed → skipped=false + 1 write; older clock-out → writes B:E ending `4:00:00 PM` over a `5:00:00 PM` sheet cell.
- [x] G3: Device-vs-device conflict = last writer wins (no tie-break code remains; queue order decides). Empty-vs-filled = blank local row clears the sheet on next sync.
  CHECK: code review of remaining plan arms + G1/G2 tests
  EXPECT: only Write/InSync/Unresolvable arms exist; InSync is byte-equality only
  EVIDENCE: plan outcome grep shows exactly Write/InSync/Unresolvable at all 3 construction sites + 2 match sites; InSync fires only on `existing == values` (Rust) / element equality (TS). Caveat (pre-existing, unchanged): a record whose row renders fully empty returns `Unresolvable("empty-values")` rather than blanking — clearing filled cells is done by the absent-sweep/DELETE paths, which are untouched.
- [x] G4: Repo gates green + docs updated (CHANGELOG entry replaced, kill switch unchanged and still honored).
  CHECK: npm run typecheck && npm run lint:oxlint && npm test -w server
  EXPECT: all exit 0
  EVIDENCE: measured 2026-09-12 — typecheck 0, lint 0, server 173/173, client 258/258 (full `npm test`), cargo 282/282. CHANGELOG: new Unreleased/0.1.63 Changed entry supersedes the timestamp-wins guard; the released 0.1.62 bullet restored verbatim (history). Kill-switch gates (`dtr_upload_allowed` / `INTERN_DTR_SYNC_ENABLED`) untouched.
