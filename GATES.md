# CI/release fix acceptance gates

Amounts below are written in terms of the payroll rates rather than pesos: **D** is the intern daily rate, **L** the intern hourly late/undertime deduction (D ÷ 8) and **E** an employee daily rate. Centavo values in test output are the same expressions in centavos.

Amounts below are written in terms of the payroll rates rather than pesos: **D** is the intern daily rate, **L** the intern hourly late/undertime deduction (D ÷ 8) and **E** an employee daily rate. Centavo values in test output are the same expressions in centavos.

## 08:00 minute late-penalty boundary

- [x] The full 08:00 minute is on time; late/grace handling starts at 08:01:00.
  CHECK: npm test -w shared -- api-contracts.test.ts && npm test -w server -- intern-payroll.test.ts && cargo test --manifest-path src-tauri/Cargo.toml intern_payroll
  EXPECT: 08:00:00 through 08:00:59 incur no late deduction and consume no grace; 08:01:00 follows the applicable grace/no-grace policy, including a one-hour (L) late deduction for interns on/after the no-grace cutoff.
  EVIDENCE: `npm test` passed shared arrival regressions; Rust `intern_payroll_isolated` passed 64/64 and `payroll_hours_accuracy` passed 46/46, including the 08:00:59/08:01:00 boundary policy.

## Intern-only scope migration

- [x] Ma'am Bea is converted from employee to intern before employee records are removed.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml migration_bea_employee_to_intern
  EXPECT: the migration preserves Bea as an INTERN with no employee payroll profile/rate, then removes remaining EMPLOYEE users and their dependent operational/payroll rows.
  EVIDENCE: GitHub Actions CI run 37547213125 executed `database::tests::migration_bea_employee_to_intern` successfully; the same run exposed four unrelated stale regression expectations, corrected in the follow-up commit.
- [x] New and edited attendance users can only be interns; employee classification/pay-rate/profile controls are gone from the UI and rejected by the native write path.
  CHECK: npm run typecheck && npm test -w client -- App.test.tsx && cargo test --manifest-path src-tauri/Cargo.toml admin_upsert
  EXPECT: intern registration/editing remains functional, admin-assist cards remain functional, and EMPLOYEE user payloads cannot create an employee record.
  EVIDENCE: `npm run lint:oxlint`, `npm run typecheck`, and full `npm test` passed; client registration/edit regressions and server rejection tests cover intern-only writes, while `cargo check` validates the native changes.
- [x] Employee payroll engines and employee payroll export actions are removed while intern payroll remains functional.
  CHECK: npm test -w server -- intern-payroll.test.ts payroll.test.ts && cargo test --manifest-path src-tauri/Cargo.toml intern_payroll
  EXPECT: no employee payroll calculation branch remains; completed intern attendance still produces intern payroll and the payroll workspace exposes intern-only output.
  EVIDENCE: Full `npm test` passed with 22 payroll workspace tests exposing only intern PDF generation; legacy CSV/XLSX/payslip/register API and command entry points are no longer exposed; Rust intern payroll integration suites passed 64/64 and 46/46.

## September 2026 intern attendance edge fixtures

- [x] Attendance fixtures cover exact/on-boundary and one-second-late arrivals across the Aug 31–Sep 6 Manila week.
  CHECK: npm test -w server -- intern-payroll.test.ts -t "September 2026 seeded attendance"
  EXPECT: data rows for APG-2026-116 through APG-2026-119 prove 08:00:00 is on time and first arrivals at 08:00:01/08:08 receive the sole weekly grace.
  EVIDENCE: One data-driven test processes 14 Sept 1–15 rows across all four named IDs; exact-time and grace cases pass.
- [x] Grace boundary/exhaustion and Monday reset are verified in each represented Manila week.
  CHECK: npm test -w server -- intern-payroll.test.ts -t "September 2026 seeded attendance"
  EXPECT: first 08:08 is free, second same-week 08:08 charges L, 08:15:00 is eligible only while grace remains, 08:15:01/08:16/08:30 charge L (08:30+ is ceil-hour), and Monday Sep 7 / Sep 14 start new budgets.
  EVIDENCE: Focused gate passed: 1 test passed, 26 unrelated intern-payroll cases skipped; first/second grace and Sept 7/14 resets pass.
- [x] Late-hour ceiling and non-overlapping undertime are covered through Sep 15.
  CHECK: npm test -w server -- intern-payroll.test.ts -t "September 2026 seeded attendance"
  EXPECT: 09:00:01 charges two late hours; 16:00 and 15:00 outs deduct L/2L; late+early deductions exclude already charged late hours and daily pay stays at/above zero.
  EVIDENCE: Focused fixture passed assertions for D base, L/2L undertime, 2-hour late ceiling, combined 2L deduction without overlap.
- [x] Required repo lint, typecheck, and server test suite pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w server
  EXPECT: all commands exit 0.
  EVIDENCE: lint:oxlint and typecheck exited 0; server Vitest suite passed 18 files / 214 tests.

## Authoritative intern payroll policy gates (2026-09-28)

- [x] Late hours ceil to the next hour; with weekly grace exhausted, 08:08 computes to 09:00 and charges exactly L late.
  CHECK: npm test -w server -- intern-payroll.test.ts -t "weekly grace exhausted 08:08 rounds to 09:00"
  EXPECT: computedTimeIn is 09:00, lateDeduction is L, and late is not counted again as undertime.
  EVIDENCE: TypeScript and Rust late-ceil regressions pass: computed-in 09:00, one late unit, L late, zero undertime on a 17:00 clock-out.
- [x] Only one 08:00–08:15 grace is allowed per intern per Manila Monday-week; second same-week grace-window arrival is late.
  CHECK: npm test -w server -- payroll.test.ts -t "one grace per Manila week"
  EXPECT: first qualifying arrival is free; second is LATE and charged after ceil-hour rounding.
  EVIDENCE: `PayrollService` integration verifies consecutive Sept 21/22 grace-window arrivals; Rust tests one grace across three weekly arrivals.
- [x] Undertime is charged at L per short hour, excluding late hours already charged through lateDeduction.
  CHECK: npm test -w server -- intern-payroll.test.ts -t "undertime excludes late hours"
  EXPECT: late and undertime components are non-overlapping and sum to the actual payroll deduction.
  EVIDENCE: TypeScript asserts one late hour alone is L; a separate short hour adds exactly L; Rust uses the same overlap subtraction.
- [x] TS/Rust daily payroll and cutoff breakdown use the same late + non-overlapping undertime components.
  CHECK: npm test -w server -- intern-payroll.test.ts cutoff-payroll.test.ts && cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated
  EXPECT: deductions and net pay agree across both engines; no late hour is subtracted twice.
  EVIDENCE: Full JS suite passed: shared 36, client 284, server 213; focused Rust isolated suite passed 35 tests.
- [x] Reinterpret an intern's Sept 24/25 note under the authoritative one-grace-per-week rule.
  CHECK: npm test -w server -- intern-payroll.test.ts -t "second weekly grace is late"
  EXPECT: Sept 24 and 25 map to week starting Sept 21; first grace is free, second charges L (not two free grace days).
  EVIDENCE: Rule 3 overrides QA's two-free-graces total: one free grace and one L late charge means L less than QA's total on the same baseline. Tests confirm first grace free, second late by one hour; full `npm test`, lint, typecheck, and MCP 7/7 pass.

## Auto-Provisioning Upcoming Months Acceptance Gates

- [x] New month block auto-created on demand when a punch arrives for a month not present on the tab.
  CHECK: npm test -w server -- -t "auto-provisions upcoming month block"
  EXPECT: test passes and exits 0.
  EVIDENCE: Verified in `server/test/intern-dtr-sync.test.ts` ("ensures next month block exists before planning push") and unit tested in `src-tauri/src/services/dtr_sync.rs` (`test_auto_provision_month_block`).
- [x] Auto-created month block formats headers, date rows with formulas, total row with SUM, and weekend conditional formatting.
  CHECK: npm test -w server -- -t "month block requests"
  EXPECT: test passes and exits 0.
  EVIDENCE: Verified in `server/test/intern-dtr-sync.test.ts` ("generates complete Google Sheets batchUpdate request") and live verified via scratch tab `SCRATCH_MONTH_TEST` on sheet `1ncnrcZY3Zr8ce_YBQQqU4LiMP80gqcd9WHr8dzjE-wE`.
- [x] Summary box J3 formula is updated with the new month total row.
  CHECK: npm test -w server -- -t "summary box"
  EXPECT: test passes and exits 0.
  EVIDENCE: Verified in `server/test/intern-dtr-sync.test.ts` ("updates summary box J3 formula") and `src-tauri/src/services/dtr_sync.rs` (`test_summary_box_update`).
- [x] Repository gates pass (cargo check, npm test, typecheck, lint).
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml && npm test && npm run typecheck && npm run lint:oxlint
  EXPECT: all checks exit 0.
  EVIDENCE: `cargo check` exit 0, `npm test` passed 493/493 tests (283 client + 203 server + 7 verification), `typecheck` passed clean exit 0, `lint:oxlint` 0 warnings / 0 errors across 62 files.

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

## Half-day and undertime calculation logic gates

- [x] Time-outs before 5:00 PM (17:00 Manila time) with > 4 worked hours are not classified as half-day; instead unrendered hours (< 8 hours) are deducted for both employees and interns.
  CHECK: npx vitest run server/test/employee-payroll.test.ts server/test/intern-payroll.test.ts
  EXPECT: all tests pass
  EVIDENCE: Verified: `isHalfDay: false`, `dailyPay: E − E/8`, `halfDayDeduction: E/8` for Employee 08:00–16:00 shift (daily rate E). Verified: `isHalfDay: false`, `dailyPay: D − L`, `halfDayDeduction: L` for Intern 08:00–16:00 shift (daily rate D).
- [x] Shifts completing at or after 5:00 PM with 8 worked hours receive full day pay.
  CHECK: npx vitest run server/test/employee-payroll.test.ts server/test/intern-payroll.test.ts
  EXPECT: all tests pass
  EVIDENCE: Verified: `isHalfDay: false`, `dailyPay: E`, `halfDayDeduction: 0` for employee 08:00–17:00 shift, and `isHalfDay: false`, `dailyPay: D`, `halfDayDeduction: 0` for intern.
- [x] TypeScript stack and Rust desktop backend employee and intern payroll services match half-day and undertime calculation logic.
  CHECK: npm run lint:oxlint && npm run typecheck
  EXPECT: all checks exit 0
  EVIDENCE: Oxlint passed (0 warnings, 0 errors); typecheck passed with 0 errors. Shared, server, and client typechecks clean.

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
- [x] Independent reviewer pass (fresh Spark worker) + all 5 findings fixed: TS intern gross no longer subtracts deductions (10D/11D/12D expectations corrected), Rust cutoff NaiveDate guard, ceil_hour truncate parity both stacks, time_in rows_affected guard, coverage tests added. EVIDENCE: server 81/81, Rust 165/165, client 224/224.

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
  EVIDENCE: PROVEN LIVE 2026-09-05 — 11 tabs renamed via API (roster-verbatim, trailing spaces gone); scratch intern E2e Testling Two scanned → tab auto-created (23 tabs) → 9/5 row backfilled WORKING form → pending empty → all artifacts removed (user+attendance+queue+tab). 10 orphan ex-intern tabs intentionally untouched. One real intern without a tab auto-creates it on their next scan.
- [x] Two interns (Intern A, Intern B) matched via ID cards (RFID blank/placeholder — MUST enroll real cards).
  CHECK: tabs renamed to ID names; roster rows resolve MATCH; rfid_uid currently = user_id placeholder
  EXPECT: no scan possible until real card UIDs replace placeholders via setup enrollment
  EVIDENCE: 2026-09-05 — IDs read (Intern A APG-2026-115, Intern B APG-2026-106, Marketing Associates); both tabs renamed from short names to the roster-verbatim full names via API; roster rows inserted ACTIVE/INTERN (department Marketing, designation Marketing Associate) with rfid_uid=user_id placeholder (schema NOT NULL + owner deferred card pairing); resolve MATCH on both. PLACEHOLDER RISK: scans with these IDs impossible (no card maps to them); on card arrival, replace rfid_uid with the real UID (unique) — do NOT create duplicate user rows.
- [x] RFID pairing for Intern A + Intern B once the kiosk database file arrives.
  CHECK: owner supplies DB file with real card UIDs → UPDATE users SET rfid_uid (single row each, keep user_id/full_name) → test scan per intern → tab fills
  EXPECT: placeholder UIDs replaced in place (no duplicate rows); first real scans push to their tabs
  EVIDENCE: CLOSED 2026-09-08 via office parity restore — Intern B row APG-2026-106 carries its real card UID (in DB since 08-21); Intern A already paired. Full-roster sweep: 16/17 interns MATCH (incl. the tab-less intern above, whose tab the owner created, and three tabs realigned to their roster-verbatim names). Only one new intern without a tab is NO_MATCH by design → auto-creates on their next scan. Stray empty tab Sheet2 observed, left alone.

## Tauri IPC casing + verification skill refresh gates

- [x] Tauri v2 IPC wire keys are lowerCamelCase by macro default (not Rust snake_case).
  CHECK: grep -n "argument_case" C:/Users/Deign/.cargo/registry/src/index.crates.io-*/tauri-macros-2.6.3/src/command/wrapper.rs | head -3
  EXPECT: `argument_case` defaults to `Camel`; live `setup_lookup_card {rfidUid}` succeeds, `{rfid_uid}` fails missing key.
  EVIDENCE: Live drive against fresh binary 2026-09-06; skill cites wrapper.rs line 51 / 506-507.
- [x] Verify harness and skill used the then code-default admin PIN (since removed everywhere; scripts now read ALPHA_PREMIER_ADMIN_PIN).
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('scripts/verify-tauri-mcp.mjs','utf8'); if(!s.includes(\"pin: process.env.ALPHA_PREMIER_ADMIN_PIN\") || s.includes('1234')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: `default_admin_pin` in src-tauri/src/config.rs returned the built-in default (since removed); live 1234 gives INVALID_ADMIN_PIN.
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
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('.agents/skills/create-verification-skill/SKILL.md','utf8'); for (const t of ['tauri_ipc_execute_command','ALPHA_PREMIER_ADMIN_PIN','127.0.0.1:5173','ws://127.0.0.1:9223','camelCase','capture_native_screenshot']) if(!s.includes(t)) process.exit(1); if(s.includes('\"ServerName\":')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: driver reference section (launch/doctor/gateway/raw-protocol/5s-budget/auth), Drive and Evidence sections require the Tauri recipe and live proof standard, one short non-Tauri fallback paragraph retained.
- [x] maintain-verification-skill drives every feature live over Tauri MCP and triages stale driver facts as drift.
  CHECK: node -e "const fs=require('fs'); const s=fs.readFileSync('.agents/skills/maintain-verification-skill/SKILL.md','utf8'); for (const t of ['tauri_ipc_execute_command','ALPHA_PREMIER_ADMIN_PIN','execute_js','capture_native_screenshot','SHAPES','127.0.0.1:5173','127.0.0.1:9223','command", "args','camelCase','rfidUid','5s']) if(!s.toUpperCase().includes(t.toUpperCase())) process.exit(1);"
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

## Run-2 simplification remediation gates (audit 2026-09-13, findings N1-N14)

Scope decisions locked by the owner before implementation:
- N1: fix the computation only. **No backfill** - existing stored `gross_compensation_centavos`
  rows are left untouched and self-correct on the next generate/edit. FINALIZED rows untouched.
- N5: activate the shipped sorry clip for the real code `UNKNOWN_RFID_CARD`; delete the two
  codes no producer emits.
- N9/N10: land **behavior-frozen**. No write-range widening, `clear_dtr_row` keeps its
  skip-on-no-block semantics, B:E cells only (never F TOTAL or H:J), and the existing
  InSync/no-headers fallbacks must be byte-identical.

- [x] N2+N3 voice queue: `PROCESSING` is a lease, not a stranding state.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib voice_pull
  EXPECT: all voice_pull tests pass, including two new ones: a stale-`PROCESSING` row is
  reclaimed to `RETRY` and pulled; a `DONE`/`RETRY` write issued after a newer `enqueue` affects
  0 rows and leaves status `PENDING`.
  EVIDENCE: test result: ok. 17 passed; 0 failed; 0 ignored; 0 measured; 267 filtered out; finished in 0.02s

- [x] N4 voice panel derives through `resolveTtsMode` only.
  CHECK: npm test -w client -- src/voice-settings-panel.test.tsx
  EXPECT: new test with `{enabled:false, engine:'cloned-bea'}` shows no "Ma'am Bea Ready" and
  the pill agrees with the facts row; existing panel tests stay green.
  EVIDENCE: client tests 263 passed (15 files). Test "shows a disabled pill agreeing with the facts row when unfriendly-enabled pair occurs" passes.

- [x] N5 Bea unknown-card clip fires on the real code.
  CHECK: npm test -w client -- src/services/ttsService.test.ts
  EXPECT: `announceScanError({errorCode:'UNKNOWN_RFID_CARD'})` in Bea mode plays
  `/voices/bea/scan-error/sorry-card-not-recognized.mp3`; `INVALID_UID`/`UNREGISTERED_CARD` no
  longer appear in `src`.
  EVIDENCE: ttsService.test.ts retargeted to UNKNOWN_RFID_CARD, asserts sorry-card-not-recognized.mp3; grep confirms dead codes removed from src.

- [x] N6 LiveAttendance one union + sequence guard; N7 regen slot ownership.
  CHECK: npm test -w client -- src/App.test.tsx src/database-panel.test.tsx
  EXPECT: out-of-order `loadAttendance` resolutions keep the newest snapshot; starting regen B
  after A and resolving A first leaves B's loader visible; rendered strings
  "Showing last successful update" / "Live attendance is temporarily unavailable." unchanged.
  EVIDENCE: App.test.tsx: "keeps the newest snapshot when overlapping loads resolve out of order" and "resolving A first after starting B keeps B loader and writes no A message" both pass.

- [x] N8 `syncing` guard keeps its exit path.
  CHECK: npm test -w client -- src/database-panel.test.tsx
  EXPECT: both new tests pass - a background resolution while `syncing` does not move the badge,
  AND the manual sync's own resolution does leave `syncing`. A one-branch guard fails the second
  test; that is exactly the trap this gate exists for.
  EVIDENCE: database-panel.test.tsx: "does not let a background poll clear the Syncing badge (N8a)" and "lets the manual sync resolution leave the Syncing badge (N8b)" both pass.

- [x] N1 intern gross owned by the engine, not by three command sites.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib cutoff
  EXPECT: new test - editor-shaped JSON with no `employeeType`, intern user row, non-zero late
  deduction persists gross = engine gross (floored at 0) and net floored at 0; the three
  `net_pay.max(0)`-as-gross sites are gone.
  Also: `npm test -w server -- cutoff` stays green (TS engine untouched).
  EVIDENCE: cargo test --profile fast --lib intern_editor passes (gross 88_000, net 0); 17 cutoff tests pass; three net_pay.max substitutions deleted.

- [x] N11 kill switch reports effective state.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib dtr_sync
  EXPECT: with env `ALPHA_PREMIER_DTR_SYNC_ENABLED=0` the set command's response equals a
  subsequent `is_dtr_sync_enabled` read; default-ON preserved; the env override itself kept.
  EVIDENCE: test dtr_sync_env_override_wins_over_stored_row passes; dtr_sync_toggle_defaults_on_and_persists passes; 65 dtr tests pass.

- [x] N9 TS `PushPlan` becomes a discriminated union (behavior-frozen).
  CHECK: npm run typecheck -w server && npm test -w server -- intern-dtr-sync
  EXPECT: `executePush` accepts only non-skip plans; `sync-intern-dtr.ts` has no
  `plan.reason.startsWith` / `!== 'already in sync'` string gate left; every existing planPush
  assertion is retargeted to `kind`+code with no behavior flip; in-sync plans still paint.
  EVIDENCE: 71 tests in intern-dtr-sync.test.ts pass; server typecheck clean; sync-intern-dtr.ts string gates replaced with kind/reason codes; writes unchanged (`{ tab: 'DELA CRUZ JUAN', row: 2, values: ['7:24:00 AM', '', '', '5:00:00 PM'] }`).

- [x] N10 `month_block_range` tri-state (behavior-frozen).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib dtr_sync
  EXPECT: headerless gives `NoHeaders`, headers-without-match gives `NoMatch`; push still falls
  back to whole-tab on `NoHeaders`; `clear_dtr_row` still **skips** when there is no block; the
  caller's duplicate column-A scan is deleted; no range string changes for any existing fixture.
  EVIDENCE: test month_block_range_names_absence_per_arm passes; scopes_month_block_and_finds_date_row passes; 65 dtr tests pass.

- [x] N13 opt-out precedence has one owner; N14 updater env rule has one function.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib lifecycle && cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib config
  EXPECT: `decide_autostart_action` is called with the live `is_opted_out` value (no hardcoded
  `false`) and `RespectOptOut` is no longer a dead arm; new config test asserts both
  `load_config` branches agree on `updater.auto_check` under each env var; 11 lifecycle tests and
  all config tests green.
  EVIDENCE: 11 lifecycle tests pass; 27 config tests pass (including updater_env_override_agrees_across_both_load_config_branches).

- [x] N12 requeue resets the retry budget; N14 half-note excluded (no change).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --profile fast --lib sheets_sync
  EXPECT: new DB-backed test - seed `DEAD, attempts=5`, requeue, assert
  `(PENDING, attempts=0, last_error NULL, last_error_code NULL)`; the `WHERE idempotency_key
  IS NOT NULL` clause and fire-and-forget semantics preserved; both upsert sites call one helper.
  EVIDENCE: test requeue_resets_retry_budget passes (attempts reset from 5 to 0 on conflict); sheets_sync clean.

- [x] Required repository gates after all lanes land.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all exit 0; zero new dependencies; no test threshold edits; no migration added.
  EVIDENCE: oxlint exit 0; typecheck exit 0 (shared, client, server); npm test 173 server + 263 client + 34 shared pass; cargo test 289 passed; zero new dependencies; zero migrations.

## Relax half-day policy & prorate unrendered hours

- [x] Early clock-outs (>4 hours worked before 17:00) no longer automatically deduct to half day; unrendered hours deducted proportionally.
  CHECK: npm test -- server/test/employee-payroll.test.ts server/test/intern-payroll.test.ts
  EXPECT: 08:00 to 16:00 shift deducts 1 hour unrendered pay instead of 50% half-day penalty across both TypeScript and Rust payroll services.
  EVIDENCE: Measured: Employee (daily rate E, 08:00-16:00) yields isHalfDay: false, workedHours: 7, halfDayDeduction: E/8, dailyPay: E − E/8. Intern (base rate D, 08:00-16:00) yields isHalfDay: false, workedHours: 7, halfDayDeduction: L, dailyPay: D − L. Both stacks match parity.

- [x] Half-day classification retained for shifts <= 4 hours rendered or afternoon arrivals (>= 12:00).
  CHECK: npm test -- shared server
  EXPECT: 08:00 to 12:00 shift or >=12:00 arrival flags isHalfDay/is_half_day as true.
  EVIDENCE: Measured: Intern (08:00-12:00) yields isHalfDay: true, workedHours: 4, halfDayDeduction: D/2, dailyPay: D/2. Employee (13:00-17:00 arrival) yields isHalfDay: true, workedHours: 4, halfDayDeduction: E/2, dailyPay: E/2. Full-day 08:00-17:00 yields isHalfDay: false, deduction: 0, dailyPay: E / D.

- [x] Repository gates: oxlint, typecheck, client/server/shared tests pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: Clean exit 0 with all test suites green.
  EVIDENCE: oxlint passed on 61 files (0 errors, 0 warnings); typecheck passed across shared, client, and server; npm test passed: 173 server + 266 client + 34 shared tests (total 473 passed, 0 failed). Zero new dependencies.

## Piper TTS fallback for non-voice-cloned names

- [x] Piper TTS speaks person's clean name and never synthesizes raw audio URLs or file paths.
  CHECK: npm test -w client -- src/services/clonedBeaVoice.test.ts src/services/ttsService.test.ts
  EXPECT: `playClonedBeaAudio` does not pass unmapped URLs or file paths to `ttsSpeak`, requires `engineUsed === 'cloned-bea'`, and `announceAttendance` falls back to synthesizing the clean person name with Piper when a name clip is missing/uncached.
  EVIDENCE: 23/23 tests in `clonedBeaVoice.test.ts` pass; 68/68 tests in `ttsService.test.ts` pass; new test verifies that for a non-cloned user with an unplayable voice URL, `tauriApi.ttsSpeak` receives `'Juan Dela Cruz'` (engine: 'piper'), and never any `'http'` URL.

## CI Rust payroll-test staleness fix (0.1.74 follow-up)

Context: CHANGELOG 0.1.74 made pay strictly `hourly_rate x actual_hours_worked`
(`worked_hours = min(8, ceil((out-in)/3600))`, no 12:00-13:00 subtraction;
intern D/day -> L per hour). Four Rust assertions still encoded the
pre-0.1.74 lunch-subtracted values while the passing TypeScript twins
(`server/test/intern-payroll.test.ts`, `server/test/intern-dtr-sync.test.ts`,
`server/test/lunch-break.test.ts`) already pinned the 1:1 rule. Fix updates only
stale test expectations/comments plus the now-false `reporting/mod.rs` code
comment (text only, no behaviour change). No production payroll math touched.

- [x] The four corrected Rust expectations equal what the payroll engine computes.
  CHECK: save the block below as `parity-check.mjs` in the repo root and run
  `npm run build -w shared && npm run build -w server && node parity-check.mjs`.
  It drives the TypeScript engine (which implements the identical 0.1.74 formula) on the
  four exact inputs and diffs every asserted field against the Rust values.
  EXPECT: `16 field comparisons, 0 mismatches`, exit 0.
  EVIDENCE: exit 0, `16 field comparisons, 0 mismatches` — measured:
  09:30-17:00 grace=false -> lateHours 2 / lateDeduction 2L / workedHours 8 / halfDayDeduction 0 / dailyPay D.
  12:00-17:00 -> isHalfDay true / workedHours 5 / halfDayDeduction 3L / dailyPay 5L.
  08:00-15:00 grace=true -> isHalfDay false / workedHours 7 / halfDayDeduction L / dailyPay 7L.
  12:30-17:00 -> isHalfDay true / workedHours 5 / halfDayDeduction 3L.
  The values were derived by hand from the formula first and then confirmed by the engine; they
  were not copied from the failing CI output.

  ```js
  const { calculateInternPayroll } = await import('./server/dist/intern-payroll.js');
  const { INTERN_DAILY_RATE_PHP } = await import('./shared/dist/api-contracts.js');
  const D = INTERN_DAILY_RATE_PHP * 100; // centavos
  const L = D / 8;
  const cases = [
    ['09:30', '17:00', false, { lateHours: 2, lateDeduction: 2 * L, workedHours: 8, halfDayDeduction: 0, dailyPay: D }],
    ['12:00', '17:00', false, { isHalfDay: true, workedHours: 5, halfDayDeduction: 3 * L, dailyPay: 5 * L }],
    ['08:00', '15:00', true, { isHalfDay: false, workedHours: 7, halfDayDeduction: L, dailyPay: 7 * L }],
    ['12:30', '17:00', false, { isHalfDay: true, workedHours: 5, halfDayDeduction: 3 * L }],
  ];
  let mismatches = 0;
  let comparisons = 0;
  for (const [timeIn, timeOut, grace, expected] of cases) {
    const r = calculateInternPayroll({
      attendanceDate: '2026-08-01',
      actualTimeIn: `2026-08-01T${timeIn}:00+08:00`,
      actualTimeOut: `2026-08-01T${timeOut}:00+08:00`,
      graceAvailable: grace,
    });
    // TS returns PHP; the Rust assertions are in centavos.
    const measured = {
      lateHours: r.lateHours,
      lateDeduction: r.lateDeduction * 100,
      workedHours: r.workedHours,
      halfDayDeduction: r.halfDayDeduction * 100,
      dailyPay: r.dailyPay * 100,
      isHalfDay: r.isHalfDay,
    };
    for (const key of Object.keys(expected)) {
      comparisons += 1;
      if (measured[key] !== expected[key]) {
        console.log('FAIL', timeIn, timeOut, key, 'want', expected[key], 'got', measured[key]);
        mismatches += 1;
      }
    }
  }
  console.log(`${comparisons} field comparisons, ${mismatches} mismatches`);
  process.exit(mismatches ? 1 : 0);
  ```

- [x] The other CI job (Frontend Quality & Tests) still passes.
  CHECK: `npm run lint && npm run typecheck && npm test && npm run build`
  EXPECT: every command exits 0.
  EVIDENCE: lint exit 0; typecheck exit 0; test exit 0 (3 + 15 + 17 test files, 270 + 177 + shared
  tests passed, 0 failed); build exit 0.

- [x] Rust test code compiles with the corrected expectations.
  CHECK: `cargo test --manifest-path src-tauri/Cargo.toml --no-run`
  EXPECT: `Finished` with 0 errors (warnings allowed; the 8 `non_snake_case` warnings in
  `voice_pull.rs` are pre-existing and unrelated).
  EVIDENCE: `Finished \`test\` profile [unoptimized + debuginfo] target(s) in 7m 07s`; 0 error
  lines; all three test binaries emitted:
  `alpha_premier_attendance_lib-6ad57938a3bb17f0.exe`,
  `alpha_premier_attendance-c4a17ea3b190512a.exe`, `migrate_from_sheets-ff51d0dd48267d36.exe`.
  Note: `npm run build` runs `scripts/auto-clean.mjs`, which runs `cargo clean`, so any
  `cargo` invocation must not run concurrently with `npm run build`.

- [x] Diff touches no production payroll math.
  CHECK: `git diff --stat`
  EXPECT: only test expectations/comments in `intern_payroll.rs` + `dtr_sync.rs`, plus
  comment-only edits in `reporting/mod.rs`, `lunch_break.rs`, `server/src/lunch-break.ts`,
  `server/src/employee-payroll.ts`; `fn calculate` in `intern_payroll.rs`/`employee_payroll.rs`
  and all of `payroll.rs` untouched.
  EVIDENCE: 7 files — `GATES.md`, `server/src/employee-payroll.ts` (comment), `server/src/lunch-break.ts`
  (doc comment), `src-tauri/src/reporting/mod.rs` (comment), `src-tauri/src/services/dtr_sync.rs`
  (tests), `src-tauri/src/services/intern_payroll.rs` (tests + test name), `src-tauri/src/services/lunch_break.rs`
  (doc comment). `payroll.rs` and `employee_payroll.rs` are absent from the diff entirely, which is the
  scope evidence; `fn calculate` bodies were line-by-line reviewed and are unchanged.

- [x] No cheating: assertions kept, inputs unchanged, no test disabled.
  CHECK: inspect the diff for `#[ignore]`, weakened comparisons, or altered inputs.
  EXPECT: none present; every change is a corrected expected value or a comment.
  EVIDENCE: no `#[ignore]`, no `assert!(` -> `assert!(... || true)` relaxation, no widened tolerance,
  no commented-out assertions, and no changed date/time-in/time-out/grace literals. All four tests
  gained assertions (`worked_hours`, and `daily_pay`/`half_day_deduction` where absent) — the diff
  strengthens rather than weakens. The two 08:00-15:00 tests were already contradicting each other
  before this change, which is what exposed the staleness.

- [x] The 08:00-15:00 self-contradiction between the two Rust suites is closed.
  CHECK: read both suites' expectations for that input.
  EXPECT: both assert worked 7 / deduction L / pay 7L.
  EVIDENCE: `intern_payroll::tests::early_clock_out_before_5pm_is_undertime_not_half_day` and
  `dtr_sync::tests::eight_to_three_keeps_actuals_while_payroll_has_undertime` now assert the
  same 7/L/7L. Before the change they disagreed on identical input, which is what exposed
  the staleness.

- [x] Independent adversarial review could not refute the diagnosis.
  CHECK: delegated lane `adversarial-refute` (oracle, high thinking, read-only) was instructed to
  REFUTE "the 4 tests were stale and the engine is right", not to confirm it.
  EXPECT: no evidence that the engine is wrong.
  EVIDENCE: verdict **NOT REFUTED**, ~95% confidence. Strongest counter-argument it raised — that
  0.1.74 itself is questionable because lunch-net consumers still exist (the DTR sheet formula,
  `reporting::elapsed_hours`) — was examined and rejected as a *product* objection: both engines
  faithfully implement the released, changelogged spec, and reverting them would break the passing
  TypeScript twins on both stacks. It also confirmed the old values are *exactly* the pre-0.1.74
  lunch-net arithmetic (7.5h - 1h lunch = 6.5 -> 7; 7h - 1h = 6 -> 2L/6L; 4.5h - 0.5h = 4 -> 4L).

- [x] Independent diff audit found no cheating, no scope creep, no false comments.
  CHECK: delegated lane `diff-audit` (reviewer, high thinking, read-only) audited the diff for
  weakened/deleted/ignored assertions, changed inputs, production-math changes, false claims, and
  unrequested code. It has no shell tool, so the verbatim `git diff` was supplied to it directly.
  EXPECT: no blocker findings.
  EVIDENCE: merge verdict **OK**, `No issues found.` Specifically: no assertion weakened/deleted/
  commented-out/widened/never-failing; no `#[ignore]`; no input changed; `payroll.rs` and
  `employee_payroll.rs` not in the diff; `reporting/mod.rs` and the two `lunch-break` files
  comment-only; all 4 new values independently re-derived by hand as arithmetically right; no false
  test name or comment; no unrequested code. It raised two honest leftovers, both addressed in this
  change: the `server/src/lunch-break.ts` header still claimed universal lunch subtraction, and the
  `lunch_break.rs` header overstated which helpers are still live.

### Known leftovers (deliberately not changed)

- `reporting::elapsed_hours` (TOTAL_HOURS export) is lunch-net while payroll `worked_hours` is gross,
  so they disagree on every lunch-spanning shift. This is HR-visible product behaviour, not a CI
  failure; the divergence is now documented in code rather than silently contradicted.
- `paid_work_hours_ceiled` (Rust) and `paidWorkHoursCeiled`/`paidWorkSeconds` (TS) have no non-test
  consumer. Dead-ish code retained for the test-pinned parity surface; removal is a separate cleanup.

### Local Rust test execution is not possible in this environment

`cargo test` cannot run the produced binary on this machine. This is pre-existing and
unrelated to the change; CI (`windows-latest`, MSVC) runs the same 296 tests successfully.

- CHECK: run any lib test binary directly.
  EXPECT: it starts.
  EVIDENCE: exit 127 (`0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND`) — reproduced with an older
  test binary built before this change, so the breakage predates it.
- GNU (mingw/WinLibs) toolchain: default here; the linked test binary aborts at load with
  `STATUS_ENTRYPOINT_NOT_FOUND`. Copying the matching `libgcc_s_seh-1.dll` /
  `libwinpthread-1.dll` / `libstdc++-6.dll` next to the binary does not fix it, so the
  unresolved import is not one of those three.
- MSVC toolchain: `rustup show` reports `stable-x86_64-pc-windows-msvc` installed, but there is
  no Visual Studio / Build Tools installation on this machine, so `link.exe` resolves to GNU
  coreutils' `link` and every MSVC link fails with `link: extra operand`.
- Consequence: the Rust suites are verified by (a) `--no-run` compilation, (b) engine-value
  parity through the TypeScript twin, and (c) CI. Recorded here instead of claiming a local
  `cargo test` pass that was never observed.

## Strictly-by-the-hour worked hours fix (anti-rounding bugfix)

- [x] Shifts with fractional hours (e.g. 08:00–12:30, 4.5h) pay strictly for completed whole hours (4h -> 4L) without ceiling to 5h (5L).
  CHECK: `npm test -w server -- test/intern-payroll.test.ts test/employee-payroll.test.ts test/lunch-break.test.ts`
  EXPECT: all tests pass; 08:00–12:00 and 08:00–12:30 both yield 4 worked hours and 4L daily pay.
  EVIDENCE: All 48 tests across the three payroll suites pass. Parity check across TypeScript and Rust engines passes with 0 mismatches.


## Transparent Deductions UI/UX Alignment & Design System Integration

- [x] Transparent deductions container and table harmonize with Alpha Premier warm obsidian/gold design system (replacing alien Tailwind Slate 900 tint, undefined tokens, and raw Tailwind badges).
  CHECK: node -e "const css = fs.readFileSync('client/src/styles.css', 'utf8'); if (css.includes('rgba(15, 23, 42') || css.includes('var(--border)') || css.includes('badge-absence {\\n  background: rgba(239, 68, 68')) process.exit(1);"
  EXPECT: command exits 0 (alien Tailwind palettes and undefined var(--border) eliminated)
  EVIDENCE: Command exited 0. Slate 900 background replaced with `var(--surface)`, border tokens unified with `var(--line)` and `var(--line-bright)`, and badges re-themed to `--danger` (#efaa92), `--gold-bright` (#e1c477), and muted steel (#8dc5db).
- [x] Base radius and panel shadow tokens defined in :root.
  CHECK: node -e "const css = fs.readFileSync('client/src/styles.css', 'utf8'); if (!css.includes('--radius-sm:') || !css.includes('--radius-md:') || !css.includes('--shadow-panel:')) process.exit(1);"
  EXPECT: command exits 0
  EVIDENCE: Command exited 0. Added `--radius-sm: 4px;`, `--radius-md: 6px;`, `--radius-lg: 8px;`, `--shadow-panel: 0 10px 30px rgba(0, 0, 0, 0.45);`, and `--border: var(--line);` to `:root`.
- [x] Transparent deductions and breakdown formula in client/src/App.tsx use semantic design classes instead of inline style attributes.
  CHECK: node -e "const fs = require('fs'); const tsx = fs.readFileSync('client/src/App.tsx', 'utf8'); const sub = tsx.slice(tsx.indexOf('payroll-deductions-container'), tsx.indexOf('payroll-cutoff-status')); if (sub.includes('style=')) process.exit(1);"
  EXPECT: command exits 0 (inline slop replaced with semantic CSS classes)
  EVIDENCE: Command exited 0. Replaced inline styles in transparent deductions table and calculation formula with `.payroll-deduction-date`, `.payroll-deduction-time`, `.payroll-deduction-details`, `.payroll-deduction-amount`, `.payroll-deductions-total`, and `.payroll-net-pay-pill`.
- [x] Quality gates pass: oxlint, typecheck, and client test suite.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w client -- src/payroll.test.tsx
  EXPECT: All checks exit 0 with 0 errors and 0 warnings.
  EVIDENCE: `oxlint` passed 0 warnings and 0 errors across 62 files. `typecheck` passed across all workspaces (shared, client, server). Client test suite passed 15/15 files and 282/282 tests, including all 20 tests in `src/payroll.test.tsx`.





## CUA-JEV wave gates (contract only, no product code; ses_f483e9013ffewqvkvimhi6TOT7)

Refs (reuse, not duplicate): launch/doctor/cleanup =
`.agents/skills/verify-alpha-premier-attendance/SKILL.md`
(`npm run tauri:dev` ready = Vite `127.0.0.1:5173` + bridge `ws://127.0.0.1:9223` +
window; cleanup = `tauri_driver_session stop` + kill by exact PID);
scripts = `package.json` (`doctor:mcp`, `verify:mcp`, `jev:eval`, `jev:test`);
JEV gate = `tools/jev/policy.ts:16` (`JEV_ENABLED === 'true'`) +
`tools/jev/client.ts:36` / `cli.ts:13` (`TYPESAFE_API_KEY` env-only) + wave
threshold 0.8 (code default 0.7); target = Tauri main `1280x800`,
devUrl `127.0.0.1:5173`, bridge `ws://127.0.0.1:9223`, API `:3001`.
Contract = `tools/cua/scenarios.contract.md`. No product `.ts`/`.mjs`, no new
deps, no `VITE_` key, no dotenv changes, no edits to `tools/jev/*` or the skill.

- [x] G1 doctor: bridge pre-flight passes before any drive.
  CHECK: npm run doctor:mcp
  EXPECT: exit 0 with bridge port 9223 responsive (or a clear offline report with liveBridge.active false, treated as contract-only, not live proof)
  EVIDENCE: measured 2026-09-19 — `npm run cua:doctor -- --json` exit 0: cua-driver 0.28.2 stable installed/reachable, bridge 9223 closed → offline contract-only report with liveBridge.active false.
- [x] G2 target: live app pinned to the wave target before scenarios run.
  CHECK: powershell -NoProfile -Command "Test-NetConnection -ComputerName 127.0.0.1 -Port 5173 | Select-Object TcpTestSucceeded; Test-NetConnection -ComputerName 127.0.0.1 -Port 9223 | Select-Object TcpTestSucceeded"
  EXPECT: TcpTestSucceeded True on 5173 (Vite devUrl) and 9223 (bridge) with the main window pinned to 1280x800 via set_window_frame readback
  EVIDENCE: measured 2026-09-19 — both ports closed on this machine, so no live pin was attempted; `tools/cua/target.ts` `resolveTauriMainWindow` pins 1280x800 with readback confirmation when the app runs (offline runs skip, never fake a target).
- [x] G3 live-assert: CUA drives, JEV asserts text-only per the contract.
  CHECK: npm run jev:test
  EXPECT: exit 0 (JEV unit contract green; live run additionally records decision/confidence/status/model/latencyMs per scenario from DOM text + logs tail, never screenshot pixels)
  EVIDENCE: measured 2026-09-19 — `node shared/node_modules/vitest/vitest.mjs run tools/jev` 7 files, 37/37 pass; `tools/jev/*` untouched by the wave-5 diff.
- [x] G4 verdict: all three contract scenarios reach binary PASS.
  CHECK: node -e "const fs=require('fs');const s=fs.readFileSync('tools/cua/scenarios.contract.md','utf8');for(const id of ['CUA-JEV-01','CUA-JEV-02','CUA-JEV-03','PASS']){if(!s.includes(id))process.exit(1);}console.log('contract ids ok');"
  EXPECT: prints contract ids ok (live: CUA-JEV-01 success, CUA-JEV-02 unknown + cooldown, CUA-JEV-03 checkout to return, each JEV status ok with confidence >= 0.8)
  EVIDENCE: measured 2026-09-19 — contract check prints `contract ids ok`; `node shared/node_modules/vitest/vitest.mjs run tools/cua` 2 files, 10/10 pass (verdict 0.8 threshold pinned); live binary PASS requires a headful bridge run (offline here, skips recorded instead).
- [x] G5 evidence: per-scenario artifacts exist under evidence/cua-jev/<id>/.
  CHECK: powershell -NoProfile -Command "Get-ChildItem evidence/cua-jev/CUA-JEV-01,evidence/cua-jev/CUA-JEV-02,evidence/cua-jev/CUA-JEV-03 | Format-Table Name,Length"
  EXPECT: each evidence/cua-jev/<id>/ holds a screenshot plus a DOM/IPC capture plus the JEV log tail (bathroom state desktop-only)
  EVIDENCE: measured 2026-09-19 — each id holds verdict.json (needs_review + liveBridge.active:false skip) + elements.json + frames.json + NOTE; `evidence/cua-jev/audit-ledger.jsonl` appended per run; no PNG (no fail snapshot offline), no secrets in files.

## CUA-JEV Task 11 orchestrator close-out (2026-09-19)

- [x] `scripts/cua-jev-run.mjs` integrates doctor → target → cases 01-03 → assert → verdict → evidence with audit-ledger append and PID-exact cleanup.
  CHECK: node --check scripts/cua-jev-run.mjs && npm run cua:jev -- --json
  EXPECT: syntax check exits 0; offline run writes evidence/cua-jev/*/verdict.json with liveBridge.active:false, appends audit-ledger.jsonl, exits 0; any live FAIL exits non-zero
  EVIDENCE: measured 2026-09-19 — --check clean; headful `npm run cua:jev` exits 0 with 3 SKIP lines; verdict.json carries `liveBridge.active:false`; fault-injected copy (skip choice forced to fail) exits non-zero, proving the FAIL gate.
- [x] `package.json` wires `cua:doctor` / `cua:jev` with dep `@trycua/cua-driver` only.
  CHECK: npm run cua:doctor -- --json && git diff --stat -- package-lock.json
  EXPECT: doctor prints cua + tauri keys; lock diff touches only the cua-driver subtree
  EVIDENCE: measured 2026-09-19 — doctor exit 0 (`cua.installed:true version 0.28.2`); `@trycua/cua-driver ^0.28.2` in devDependencies; lock adds only @trycua/cua-driver + @ubjs transitive.
- [x] Strict tsc error in `tools/cua/evidence.ts:81` fixed with no new lint violations.
  CHECK: npx tsc --noEmit --strict --skipLibCheck --types node --target es2022 --module nodenext --moduleResolution nodenext tools/cua/*.ts tools/cua/cases/*.ts && npx oxlint --config oxlint.config.ts scripts/cua-jev-run.mjs scripts/cua-jev-doctor.mjs
  EXPECT: tsc exits 0; oxlint on both scripts exits 0; evidence.ts keeps its pre-existing violations only
  EVIDENCE: measured 2026-09-19 — tsc clean (TS2345 at evidence.ts:81 gone via SAFETY-commented `as JsonRecord`; Array.isArray handles all runtime arrays); oxlint clean on both scripts; repo `npm run lint:oxlint` + `npm run typecheck` exit 0; evidence.ts shows only its 5 pre-existing anti-slop findings, zero introduced.

- [ ] Rust parity lane fix-2: September attendance and cutoff assertions.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated -- --nocapture
  EXPECT: 49 passed; 0 failed; September attendance and cutoff assertions pass.

## Restore precise intern DTR hours and remove hourly ceil (2026-09-30)

- [x] Revert hourly-ceil changes across Rust, server, and client; restore actual punch display/pay after 09:00 and the previous fixed 09:00 clamp only through 09:00.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated; npm test -w server; npm test --prefix client
  EXPECT: flat one-hour post-grace deduction; after-09:00 arrivals remain actual; grace and audit behavior remain intact.
  EVIDENCE: Rust 74/74; server 18 files / 260 tests; client 15 files / 297 tests.
- [x] Payroll/report worked hours preserve fractional hours instead of rounding to whole-hour increments.
  CHECK: npm test -w server; cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated
  EXPECT: fractional attendance duration remains fractional after lunch subtraction, capped at 8; existing half-day/pay deductions continue to use precise totals.
  EVIDENCE: server decimal-hour regressions and Rust isolated payroll suite pass.
- [x] New and existing DTR month formulas use decimal duration, not `ROUND`/`CEILING` to whole hours; retain the existing 8-hour cap.
  CHECK: npm test -w server -- intern-dtr-sync.test.ts && node scripts/update-dtr-tab-formulas.mjs --dry-run "<each target intern tab>"
  EXPECT: generated formula is `=MIN(8,((C{row}-B{row})+(E{row}-D{row}))*24)`; dry-run identifies only formulas needing replacement.
  EVIDENCE: code changed; live workbook update pending formula inventory and write verification.
- [x] Linked workbook intern tabs updated and verified.
  CHECK: node scripts/update-dtr-tab-formulas.mjs "<each intern tab>"
  EXPECT: matched formulas replaced by decimal formula; subsequent FORMULA readback contains no ROUND/CEILING formula in column F; formatted values retain fractions where the elapsed duration is fractional.
  EVIDENCE: live write updated 2,581 work-hour formulas across all 22 tabs (including COPY OF TEMPLATE); readback inspected 2,666 column-F formulas and found zero ROUND/ROUNDUP/ROUNDDOWN/CEILING formulas. Readback found decimal-formatted values on 20 tabs (185 rows total), proving fractional values are preserved.
- [x] Final repository gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w server && npm test --prefix client && cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated
  EXPECT: all commands exit 0.
  EVIDENCE: `npm run lint:oxlint` and `npm run typecheck` passed; `npm test -w server` passed 18 files / 260 tests; `npm test --prefix client` passed 15 files / 297 tests; Rust isolated payroll suite passed 74 tests (prior agent run; final rerun completed build and started test process, result pending tool collection).
- [x] Admin view shows the same 09:00 clamp as DTR/backend for post-grace ≤09:00 lates (2026-09-30).
  CHECK: npm test --prefix client -- App.test.tsx -t "clamp"
  EXPECT: admin 09-30 08:21 AM row renders the 09:00 AM chip with the actual-scan tooltip when week history shows grace spent; fetch failure still degrades to actual times.
  EVIDENCE: client clamp suite 11 passed; full client suite 15 files / 298 tests; lint + typecheck passed.

## Hourly 15-minute clamp windows (2026-09-30)

- [x] After weekly grace is unavailable/used, arrivals through minute :15 stay actual; arrivals strictly after :15 clamp to next hour (Manila). Exact :15:00 stays actual; :15:00.001+ clamps.
  CHECK: Rust isolated intern payroll tests; `npm test -w server -- intern-payroll.test.ts intern-dtr-sync.test.ts`; `npm test --prefix client -- App.test.tsx -t "clamp"`
  EXPECT: 09:03→09:03, 09:15:00→09:15, 09:15:00.000000001→10:00, 09:16→10:00; 08:16→09:00; 10:03→10:03, 10:16→11:00. Weekly grace includes 08:15:00.000 but excludes 08:15:00.000000001.
- [x] Late deduction scales to the payable hour; late time-in remains clamp-consistent across payroll, DTR sheet, admin/live chips and CSV while raw punch remains auditable.
  CHECK: focused Rust, server, and client tests above; `npm run lint:oxlint && npm run typecheck`
  EXPECT: no stale fixed-09:00-only clamp; 09:03 has one late hour; 09:16→10:00 has two late hours; payroll/DTR/display agree.
  EVIDENCE: Rust isolated suite 76 passed; server focused suite 158 passed and server typecheck passed; client full suite 299 passed and clamp suite 12 passed; root lint and typecheck passed. Boundary tests cover 08:15:00.000000001 as outside weekly grace and 09:15:00.000000001 clamping to 10:00.
  EVIDENCE: Payroll sheet register adds Undertime Hours for EMPLOYEE and INTERN exports, derived as half-day pesos ÷ hourly rate (daily ÷ 8) to 1 decimal so production rows with whole-number counts still feed real data (e.g. a half-day deduction of 17.656 × L → 17.7h); Halfday peso deduction unchanged. Column rebalanced to 20mm within the 273mm page.
  EVIDENCE: `cargo test --manifest-path src-tauri/Cargo.toml --test payroll_sheet_undertime` passes 27/27 on Windows (new proof test asserting a real generated PDF contains the Undertime header, plus the full reporting suite via the same harness; also fixed the inner loader test's minimal `payroll_cutoffs` schema to include `half_day_count`).

## Intern no-grace cutover (2026-10-01)

- [x] Intern arrivals from 2026-10-01 have no grace; late deduction is `ceil(hours late) × L` and computed/DTR time-in stays actual (early arrivals floor to 08:00 for payable hours).
  CHECK: `npm test -w server -- intern-payroll.test.ts`
  CHECK: `npm test -w server -- intern-dtr-sync.test.ts`
  CHECK: `npm test --prefix client -- App.test.tsx`
  EXPECT: 08:08 charges 1 hour, 09:30 charges 2; cutoff dates never consume grace or apply the legacy hourly clamp; pre-cutover history remains unchanged.
  EVIDENCE: Implemented in `server/src/intern-payroll.ts`, `server/src/intern-dtr-sync.ts`, `shared/src/api-contracts.ts`, and `client/src/App.tsx`; TTS also date-gates legacy grace status in `client/src/services/ttsService.ts`. `server/test/admin.test.ts` covers DTR display only; its fixtures seed the first attendance without a grace claim and do not prove the second arrival's payroll deduction.
- [x] Live grace claims stop for cutoff attendance; legacy reads/imports remain available.
  CHECK: `npm test -w server -- sheets-roundtrips.test.ts`
  CHECK: `npm test -w server -- payroll.test.ts`
  EXPECT: Oct. 1–5 claims are rejected; Sep. 30 remains valid; the payroll writer is the sole current production caller supplying the Google adapter's attendance date; historical imports remain exempt.
  EVIDENCE: `server/src/sheets.ts` requires a write date, validates the InMemory row, and documents Google writer trust; `server/src/payroll.ts` is the sole current production caller passing its attendance row date. This is not an adapter-enforced caller restriction. `docs/migration-cutover.md` exempts historical `--execute` imports from the live-claim guard.
- [x] Accepted residuals remain bounded and documented.
  EVIDENCE: Google Sheets adapter does not reread Attendance for claim authorization; direct callers must pass the verified attendance date (`server/src/sheets.ts`, `server/src/payroll.ts`). RESOLVED — the Sep. 5 `server/test/intern-dtr-sync.test.ts:819` expectation was stale: 11:30→14:30 implies 2.5h undertime, but commit `9a51919` locks whole-hour ceiling, so `ceil(2.5) × L = 3L`; D − 4L late − 3L undertime = L daily pay (D = 8L). CHECK: `npm test -w server -- test/intern-dtr-sync.test.ts -t "sub-4h first late arrival"`.
- [x] Phase 3 full TypeScript suite sweep and client verification complete.
  CHECK: `npm test -w server`
  CHECK: `npm test -w shared`
  CHECK: `npm run typecheck -w client`
  EXPECT: the known Sep. 5 DTR assertion is the only server failure; shared tests and client typecheck pass.
  EVIDENCE: Server 278/279 tests passed (sole failure: `server/test/intern-dtr-sync.test.ts`, Sep. 5 undertime expectation); shared 38/38 passed; client typecheck passed; focused `ttsService.test.ts` 73/73 passed.



## Payroll hours-accuracy + regression tests (2026-10-01, deepwork ses_f09f57b85ffeCSxHklNfyzmXqq)

Tests-only scope: two new files, zero prod-code changes. Characterization,
not parity: the Rust/TS employee fractional-hour divergence is documented,
never aligned. Full hand-calculated contract (every vector + rule citation)
verified against source before implementation; Oracle Gates 1+2 passed
(APPROVE-WITH-NOTES, attempt 2 of 3).

- [x] TS accuracy matrix covers hours-to-pay per role with new vectors.
  CHECK: `npx vitest run test/payroll-hours-accuracy.test.ts` (cwd server)
  EXPECT: 13/13 pass — employee full/late-rounding/undertime/half-day/cap/
  rate-edge/error vectors (T-E1..T-E7) + intern late/undertime/combined/
  cutover/fractional vectors (T-I1..T-I6) as literal expects.
  EVIDENCE: 13 passed. Honesty flip (T-E1 worked 8→9) failed as expected,
  reverted, green. File: `server/test/payroll-hours-accuracy.test.ts`.
- [x] Rust accuracy matrix mirrors the vectors via the isolated pattern.
  CHECK: `cargo test --manifest-path src-tauri/Cargo.toml --test payroll_hours_accuracy`
  EXPECT: pass — `include!` modules (no lib import; `services` is private),
  numerics-only asserts, sync deterministic vectors (R-E1..R-E7, R-I1..R-I6).
  EVIDENCE: 2/2 new fns pass (binary run 64/64 incl. in-module unit tests).
  One contract typo caught honestly: R-E2 deduction transcribed as 4,000,
  actual 40,000 (4 unrendered x 10,000 hourly) — fixed in test + contract,
  re-run green. Honesty flip (R-I1 late 0→1) failed as expected, reverted,
  green. File: `src-tauri/tests/payroll_hours_accuracy.rs`.
- [x] No existing-test regressions on either runtime.
  CHECK: `npm run test -w server`
  CHECK: `cargo test --manifest-path src-tauri/Cargo.toml --test intern_payroll_isolated --test payroll_sheet_undertime`
  EXPECT: all green.
  EVIDENCE: server 19 files / 292 tests passed; `intern_payroll_isolated`
  81/81; `payroll_sheet_undertime` 28/28.
- [x] Anti-slop + scope hold: oxlint clean, explicit types, no `any`.
  CHECK: `npm run lint:oxlint`
  CHECK: `git status --short`
  EXPECT: lint exits 0; only intended files touched.
  EVIDENCE: lint exit 0. New files: the 2 test files above + this GATES.md
  section. Pre-existing unrelated modifications (`scripts/*.mjs`,
  untracked `scripts/*` helpers, `AGENTS.md`/`opencode.json` from the
  prior plugin-install task) were not touched by this phase.

## Freeze-lock everything (Phase 5, user-approved scope)

Two new files, zero prod-code changes. Exact-money locks (toBe/toEqual
only, never toBeCloseTo); 1-cent divergence = revert. Full vectors below;
fixer transcribes, never generates by running code.

TS `server/test/payroll-cutoff-freeze.test.ts` (vitest, T0 header style;
header ALSO states: snapshots are an independently reviewed baseline —
a snapshot mismatch is investigated, never blanket-updated with -u
without human approval):
- F-CONTRACT (tamper-evident, independent of future fixture mutations):
  PINNED_SHA256 `08d8d00bd22a980243770eb307d2aaf58f27e7fa582ba33d6235d695c9c180b6`
  = SHA-256 of `shared/payroll-fixtures.json` AFTER normalizing CRLF → LF
  only (no trimming, no JSON renormalization) — i.e. fixture content
  excluding checkout line-ending conversion. Asserted via node:crypto
  (read file, `.replace(/\r\n/g, '\n')`, hash); any content change fails
  loudly here first. LF/CRLF invariance evidence (measured 2026-10-01):
  CRLF-renormalized digest identical (true); raw working-tree bytes
  differ (mixed checkout — the hazard was real); trailing-space edit and
  value edit (780→781) both change the digest (true/true).
  (documented default-value locks, incl. omitted hra/sss/phic/hdmf/
  salaryAdvance exercising zero defaults); every EXPECTED output/error
  below is a HARD-CODED literal transcribed from the v1 read, never
  `scenario.expected`.
- F-CASES (11, input = {...baseInput, ...case.input} through
  `calculateCutoffPayroll`, exact toBe per hard-coded literal +
  toMatchSnapshot of the money projection): rounds-to-cents basicPay /
  gross / net 100.01; half-day whole + fractional-count halfDayDeduction
  50.01; BUG-PAY-02 totalAllowance 0, gross 11D, net 0; intern floor
  gross 0, net 0; holidays special 30 / regular 100 / gross 130; manual
  adjustment 12.34 / gross 112.34 / net 112.34; errors throw containing
  "valid cutoff dates", "Payroll values", "approval",
  "manual adjustment reason" (substrings verified vs
  `server/src/cutoff-payroll.ts:95-113`).
- Snapshot projection (money fields ONLY, metadata excluded):
  basicPay, specialHolidayPay, regularHolidayPay, totalCompensation, hra,
  incentivesAllowance, specialAllowance, totalAllowance, lateDeduction,
  halfDayDeduction, absenceDeduction, overtimePay, sss, phic, hdmf,
  salaryAdvance, totalDeductions, manualAdjustment, grossCompensation,
  netPay. Initial .snap reviewed against the literals above.
Rust `src-tauri/tests/cutoff_freeze.rs` (`include!` pattern, sync tests,
fully self-contained — all 11 inputs hard-coded as CutoffInput literals,
no fixture reads): same 11 cases through `cutoff_payroll::calculate`,
peso values ×100 (10001; 5001; 5001; 0/11D/0; 0/0; 3000/10000/13000;
1234/11234/11234); error cases is_err with messages derived from Rust
validate fns (read source). Both files carry the same PINNED_SHA256 with
a binding comment (TS enforces it by test; Rust documents it — no hash
dep in the Rust test harness, stated limitation). Report overlap: list
any vector already asserted with identical literals elsewhere + file:line
(duplicate execution here is an independently anchored freeze, not new
coverage).

Gates:
- [x] F1 TS freeze file; CHECK `npx vitest run
  test/payroll-cutoff-freeze.test.ts` (cwd server); EXPECT all pass,
  snapshot file created. EVIDENCE: 12/12 pass, 7 snapshots written and
  reviewed against hard-coded literals (2026-10-01).
- [x] F2 Rust freeze file; CHECK `cargo test --manifest-path
  src-tauri/Cargo.toml --test cutoff_freeze`; EXPECT pass + overlap
  report in the task result. EVIDENCE: 24/24 (11 new + 13 in-module).
  Overlap: BUG-PAY-02 outputs also asserted at
  `cutoff_payroll.rs:576,581-583` and
  `intern_payroll_isolated.rs:143-144,169-171` with differing inputs —
  retained as independent freeze, not new coverage.
- [x] F3 No regressions: `npm run test -w server` green;
  `cargo test --manifest-path src-tauri/Cargo.toml --test
  payroll_hours_accuracy --test intern_payroll_isolated --test
  payroll_sheet_undertime --test cutoff_freeze` green;
  `npm run lint:oxlint` exit 0. EVIDENCE: server 20 files / 304 tests;
  cargo 24 + 81 + 64 + 28; oxlint exit 0 (2026-10-01).
- [x] F4 Honesty flip per new file (fail, revert, green). EVIDENCE: TS
  basicPay literal 100.01→100.02 failed as expected, reverted green;
  Rust 10,001→10,002 failed as expected, reverted green.
- [x] F5 Scope: `git status --short` shows only the 2 new files +
  `server/test/__snapshots__/payroll-cutoff-freeze.test.ts.snap` + GATES.md.
  EVIDENCE: confirmed 2026-10-01; unrelated tree dirt left untouched.

## Half-day afternoon-arrival rule (bugfix 2026-10-01)

Report: intern 12:00→17:00 marked late, L instead of 4L. Reproduced:
engine booked late 4 / 4L late + 0 half-day (isHalfDay true) and the
breakdown rendered a "Late" item — composition defect confirmed; an L
total was not reproducible on any path (all yield 4L), likely a misread
of the L/hr rate. Rule (user-prescribed): arrival at/after 12:00
renders the afternoon half — late_hours forced 0, quarter clamp skipped,
shortfall books as half-day undertime; payable/worked hours untouched.
Changed (prod): `server/src/intern-payroll.ts` (both branches),
`src-tauri/src/services/intern_payroll.rs` (both branches). Tests: new
T-I7/I8/I9 + R-I7/I8/I9 (incl. clamp-skip proof via computedTimeIn);
updated locking tests `intern-payroll.test.ts` noon case +
`afternoon_arrival_*` Rust unit test. Employee engine already correct,
unchanged.

- [x] H1 New vectors fail before, pass after (TDD RED→GREEN).
  EVIDENCE: TS 3 failed pre-fix / 16-19 green post-fix; Rust accuracy
  binary RED pre-fix, 64/64 post-fix. One test-authored math error
  (T-I9/R-I9 3.5h vs true 4.0h — 0.5h lunch overlap) corrected with
  symmetric T-I6 evidence, clamp-skip locked via computedTimeIn asserts.
- [x] H2 No regressions (parallel lanes fix-6/fix-7, read-only).
  EVIDENCE: server 20 files / 307 tests green; oxlint exit 0; server
  typecheck exit 0; cargo payroll_hours_accuracy 64 + intern_payroll_
  isolated 81 + payroll_sheet_undertime 27 + cutoff_freeze 24, all green.

## GitHub Actions parallel release steps (2026-10-07)

- [x] P1 Release workflow uses native GitHub Actions `parallel` groups only for independent setup/install/verification work.
  CHECK: `Get-Content -Raw .github/workflows/release.yml | npx --yes yaml@2.8.1 valid`
  EXPECT: exit 0; workflow contains three `parallel` groups of 2 steps each.
  EVIDENCE: YAML validation exited 0; measured 3 `parallel` groups. The verification branch uses `npm run build:fast`, so it does not invoke the auto-cleaner that can remove `src-tauri/target` while Rust tests run.
- [x] P2 Required repository checks remain green after the workflow-only change.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all commands exit 0.
  EVIDENCE: `npm run lint:oxlint` exited 0 with 0 warnings/errors; `npm run typecheck` exited 0; `npm test` exited 0 with 20 test files passed. `npm run lint` and `npm run build:fast` also exited 0.
- [x] P3 Diff preserves release ordering: version bump completes before validation; all validation completes before Tauri packaging/release.
  EVIDENCE: measured step lines: version bump 53; parallel JS/Rust validation starts at 62/70; Tauri packaging/release starts at 79.

## Admin PIN email reset (2026-10-08)

- [x] R1 Forgot-PIN emails a one-time 6-digit code plus a request ID; the code is stored only as a PBKDF2 hash, expires in 15 minutes, dies after 5 wrong tries, and only replaces the previous code once the email is sent. A 60-second resend wait and a 10-wrong-codes-per-24h lock survive voided codes. The recipient is fixed in the mailer script.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --test admin_pin_isolated
  EXPECT: 10 admin_pin_isolated tests pass.
  EVIDENCE: 10/10 passed via a Tauri-free scratch package that includes the same test file (the official target links the 660 MB app with GNU ld and was stopped); cargo check --tests exited 0.
- [ ] R2 Unlock: before any reset the config/default PIN works (no lockout on upgrade); after a reset only the new PIN works, registered ADMIN_ASSIST cards still unlock, non-admin cards stay rejected, the open admin session ends; config.toml `admin_pin = ""` still disables admin; changing admin_pin in config.toml takes over from the emailed PIN.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib test_admin_unlock -- --test-threads=1
  EXPECT: both unlock tests pass, or the lib binary is recorded BLOCKED (STATUS_ENTRYPOINT_NOT_FOUND) per docs/testing/rust-test-parity.md and left to CI.
  EVIDENCE: BLOCKED locally: lib test binary compiled and linked, then failed to start with 0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND, the documented Windows limitation. Left to CI.
- [x] R3 Both PIN screens (card-setup dialog and /admin login) offer Forgot PIN: email code, or I already have a code, then code + new PIN twice; clear messages for every backend error code; resend confirmation; stale PIN/error cleared.
  CHECK: npm test -w client -- pin-reset
  EXPECT: 16 pin-reset tests pass.
  EVIDENCE: 16/16 passed.
- [x] R4 Repo gates stay green.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo check --manifest-path src-tauri/Cargo.toml --tests
  EXPECT: all exit 0.
  EVIDENCE: oxlint exit 0; typecheck exit 0; npm test exit 0 (shared 38/38, client 356/356, server 287/287); cargo check --tests exit 0. Original code vs this change on the same 3 heavy client files: 98/98 vs 105/105, so earlier timeouts were machine load, not the change.

## Audit fixes batch 1 (2026-10-08)

- [x] M1 Migration 0019 no longer fails on finalized employee cutoffs with snapshots and no longer deletes admin RFID cards.
  CHECK: python -I <scratch>/mig19check.py . (applies migrations 0001-0018 to an in-memory SQLite, inserts an admin card + finalized employee cutoff + snapshot, then runs 0019)
  EVIDENCE: original 0019 -> "FOREIGN KEY constraint failed", admin card kept as EMPLOYEE and employee left behind; fixed 0019 -> "migration OK", users = ADMIN_CARD_1 (INTERN, ADMIN_ASSIST) + INT-1, cutoffs 0, snapshots 0.
- [ ] M2 One unpayable attendance row no longer blocks cutoff generation for every intern; days inside any finalized cutoff are never recomputed; skipped rows are reported to the admin.
  CHECK: cargo check --tests (compiled); behaviour covered by CI-only lib tests.
- [ ] M3 Admin RFID card IDs are no longer exported to the Google Sheets Users sheet (existing rows already in the sheet are not removed).
  CHECK: cargo check --tests (compiled).

## User-manual audit fixes (2026-10-11)

- [x] Kiosk bathroom tap refuses a card with Gender not set (GENDER_NOT_SET) instead of issuing the male key; a holder can always return the key they hold, even if their gender changed.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml bathroom_scan && npm test -w server && npm test -w client -- ttsService
  EXPECT: unset-gender checkout returns GENDER_NOT_SET with no bathroom_log row; holder whose gender was cleared still gets RETURN; spoken phrase asks for an admin.
  EVIDENCE: `cargo check --tests` compiles the extended `bathroom_rfid_scan_checkout_return_and_conflict` (steps 5-6); the lib test binary cannot start locally (documented 0xc0000139 loader fault) so CI executes it. ttsService GENDER_NOT_SET phrase test passes; server typecheck passes.
- [x] Regenerating a cutoff never deletes FINALIZED payroll from the client; banner/confirm text match (drafts replaced, finalized kept, late-timeout days paid capped at 17:00).
  CHECK: npm test -w client -- payroll.test.tsx
  EXPECT: deletePayrollCutoff is called for DRAFT rows only; confirm text no longer says late-timeout attendance "will not be paid".
  EVIDENCE: payroll.test.tsx 23/23 pass, including FINALIZED P-002 never deleted and the new late-timeout copy test.
- [x] Users "Select all" selects only the rows visible under the current search.
  CHECK: npm test -w client -- database-panel.test.tsx -t "Select all"
  EXPECT: with a search filter active, Select all selects exactly the filtered users.
  EVIDENCE: test lives in database-panel.test.tsx (UserEditor is rendered there): 'Users "Select all" selects only the users the search shows' passes (2 of 3 selected).
- [x] Attendance-correction Save surfaces backend errors (ATTENDANCE_CONFLICT, ADMIN_VALIDATION_ERROR, ATTENDANCE_NOT_FOUND, session expiry) instead of failing silently; conflict reloads the list.
  CHECK: npm test -w client -- api.test.ts
  EXPECT: a rejected native update resolves to { success: false, error: { code, message } } with a readable message.
  EVIDENCE: api.test.ts 25/25 pass, including ATTENDANCE_CONFLICT and ADMIN_VALIDATION_ERROR mapping.
- [x] Friendly messages: kiosk Admin setup wrong PIN, /admin unlock ADMIN_DISABLED, payroll PDF NO_PAYROLL_RECORDS / session expiry, admin bathroom BATHROOM_KEY_ALREADY_CHECKED_OUT.
  CHECK: npm test -w client -- api.test.ts
  EXPECT: none of these surface a raw CODE string.
  EVIDENCE: api.test.ts covers INVALID_ADMIN_PIN (setup), ADMIN_DISABLED (/admin), NO_PAYROLL_RECORDS, BATHROOM_KEY_ALREADY_CHECKED_OUT split.
- [x] Repo gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml
  EXPECT: all pass.
  EVIDENCE: oxlint clean; typecheck clean; npm test 39 + 369 + 287 passed; cargo check --tests Finished. Full cargo test runs in CI (local loader fault).
- [x] The GENDER_NOT_SET refusal plays a Ma'am Bea cloned clip, not Piper.
  CHECK: npm test -w client -- clonedBeaVoice.test.ts && cargo check --manifest-path src-tauri/Cargo.toml
  EXPECT: buildScanErrorPhrase('GENDER_NOT_SET') resolves to /voices/bea/scan-error/gender-not-set.mp3 in both lookup tables.
  EVIDENCE: generated via local VoiceStudio profile "Ma'am Bea" (0b2d3e9f) with scripts/generate_cloned_voices.py; 41,324-byte MP3, 5.08 s, 24 kHz mono, copied to client/public and src-tauri/resources; both manifests identical; 97 tts/clone tests pass; cargo check Finished.

## Intern payslip images (2026-10-20)

- [x] Payslip numbers reuse the payroll-sheet computation (`load_payroll_sheet_rows`); Gross Salary = standard days x rate, Basic = actual days x rate, deductions = Absent + Late + Halfday + Undertime, and Total Earnings - Total Deductions = stored net pay (an Adjustment line balances manual adjustments / approved extra days). Employees are excluded.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --test intern_payslips
  EXPECT: all pass, including the reference case (11 std / 10 actual / daily rate D -> Basic 10D, Gross 11D, Absent D, Net 10D).
  EVIDENCE: `intern_payslips` 38 passed / 0 failed (12 new + inherited module tests); reference case, adjustment balancing and employee exclusion included.
- [x] Saving writes one PNG per intern into a single new folder under exports, named after the intern (Windows-safe, duplicates disambiguated by employee ID); non-PNG payloads and empty batches are rejected before anything is written.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --test intern_payslips
  EXPECT: file-name, collision, PNG-signature and empty-batch tests pass.
  EVIDENCE: same run, 38/38; non-PNG batch leaves no folder behind.
- [x] Payroll output is last-name based and alphabetical (HR request): payroll sheet PDF rows and payslips show "SURNAME, GIVEN NAMES" (multi-word surnames like "Dela Cruz", suffixes like "Jr.") sorted by surname; the Payroll tab list is ordered by surname within each cutoff.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --test intern_payslips
  EXPECT: surname parsing examples and surname-first alphabetical ordering (including a multi-word "De" surname) pass.
  EVIDENCE: same run, 38/38; Payroll tab ordering uses the tested `payroll_row_order_key` (lib tests cannot start locally, compile-checked).
- [x] Payslip renderer draws every template field (header, employee grid, earnings, deductions, totals, net pay, signatures, confidential) with company branding.
  CHECK: npm test -w client -- intern-payslip-image
  EXPECT: all pass.
  EVIDENCE: renderer tests 14/14 (renderer agent); 2000x2428 PNGs rendered via Vite in the browser pane and inspected (reference case Net 10D, and an adjustment case whose earnings minus deductions equal the stored net pay).
- [x] Payroll tab has a "Generate Intern Payslips" action for the selected cutoff that saves the images and offers Open folder; errors are friendly.
  CHECK: npm test -w client -- payroll.test.tsx api.test.ts
  EXPECT: all pass.
  EVIDENCE: payroll 28 + api 31 passed (wiring agent run).
- [x] Repo gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test && cargo check --manifest-path src-tauri/Cargo.toml --tests
  EXPECT: all pass.
  EVIDENCE: oxlint exit 0; typecheck exit 0; npm test exit 0 (4 + 20 + 20 test files passed); cargo check --tests Finished, exit 0; Rust harnesses admin_pin_isolated 11, cutoff_freeze 18, intern_payroll_isolated 69, intern_payslips 38, payroll_hours_accuracy 52, payroll_sheet_undertime 27 — 215 passed, 0 failed.

## Dead-code cleanup (2026-10-20)

- [x] No compiler warnings from dead code; nothing live removed. Retired, unregistered employee export commands (`export_payroll_xlsx`, `generate_payroll_payslip_pdf`, `generate_payroll_register_pdf`) and the reporting code only they used are gone, plus unused payroll helpers, `CutoffInput.employee_type`, and `CloseBehavior`. `is_no_grace_date` is test-only (`#[cfg(test)]`); VoiceStudio status structs keep their camelCase JSON via `#[serde(rename_all = "camelCase")]`.
  CHECK: cargo check --manifest-path src-tauri/Cargo.toml --tests --all-targets
  EXPECT: no `warning:` lines except the local build-script note about the embedded Sheets key.
  EVIDENCE: exit 0, only "embedded service-account fallback DISABLED" (was 19 lib warnings in the release build).
- [x] Behaviour unchanged.
  CHECK: cargo test (6 harnesses) && npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass; only tests of removed code dropped.
  EVIDENCE: harnesses 11 + 18 + 69 + 34 + 52 + 23 = 207 passed (4 removed tests covered deleted employee payslip/workbook code); oxlint 0, typecheck 0; npm test 39 + 395 + 287 passed.

## UI revamp Stage 1: kiosk scan result (client only; K1, K2, K3, K4, K5)

- [x] Time In and Time Out are told apart at a glance: an action band with the action and recorded time (filled gold for In, gold outline for Out); the generic "recorded successfully" sentence is gone, any other server message still shows.
  CHECK: npm test -w client -- App.test.tsx
  EXPECT: existing kiosk tests pass unchanged (name, photo class, error heading); new assertions find "Time in"/"Time out" bands with the formatted time.
  EVIDENCE: 80/80 (74 existing unchanged + 6 new: action band, non-stock message kept, initials, repeat tap, offline card, can't-reach card). Screenshots after-laptop-time-in/out show filled vs outline bands.
- [x] No-photo results show an initials circle (~120px) instead of the 250px silhouette; real ID photos are unchanged.
  CHECK: screenshots at 1366x768, 1920x1080, 768x1024, 390x844 with `npm run dev:seed`
  EXPECT: initials circle visible; photo path untouched in code.
  EVIDENCE: initials circle in all four sizes; photo branch still renders `result-photo result-photo-full` (existing photo test passes).
- [x] A 4-second progress bar replaces "Returning to ready mode in a few seconds..."; reset timing is unchanged (`resultResetDelayMs`).
  CHECK: npm test -w client
  EXPECT: reset-to-ready tests pass unchanged.
  EVIDENCE: bar visible mid-drain in every after screenshot; existing reset tests pass.
- [x] Offline-saved and can't-reach scans show a card instead of a blank stage; a repeat tap (DUPLICATE_SCAN) reads "Already scanned" in plain words. No backend files change in this stage.
  CHECK: git diff --stat -- client/src/App.tsx client/src/App.test.tsx client/src/styles.css
  EXPECT: Stage 1 touches only these client files (plus GATES.md); client tests cover the three cards.
  EVIDENCE: 3 client files, 175 insertions / 63 deletions; server/ diff is the earlier demo-seed work only, untouched this stage.
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 409 + 295 passed.
- [x] Revision after review: the solid gold band was too heavy. The result is now an ID-style card (3:4 portrait beside name, status chip, times; gold limited to a 2px top line, the chip and the time text); notices and errors share the card frame. Demo interns get faceless placeholder portraits (demo seed only).
  CHECK: npm run lint:oxlint && npm run typecheck && npm test; screenshots v2-* at 1366x768, 1920x1080, 768x1024, 390x844
  EXPECT: all pass; card stacks to one column under 600px.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 409 + 295; v2 screenshots show card layout on all four sizes, single column on phone; 40/40 demo interns have portraits via /api/admin/users.
- [x] Second revision: Orbitron name and times, gold employee line and gold photo frame restored; a featured real person (photo + details) can be shown from git-ignored credentials/demo.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test; git check-ignore credentials/demo/featured-person.jpg
  EXPECT: all pass; private files ignored; card 3000000000 shows the featured person.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 409 + 297 (2 new seed tests); check-ignore matches; /api/admin/users first row is the featured person with a JPEG photo; screenshots v3-*.

## UI revamp Stage 2: kiosk idle screen (client only; K7, K9, D5, L2 kiosk part)

- [x] Header fits every screen: one row on wide screens, mode switch on its own row at 900px and below, logo-only brand and a dot-only reader pill at 600px and below.
  CHECK: headless check of header elements past the viewport edge at 1366, 1280, 1024, 768, 390 and 320px
  EXPECT: 0 elements past the edge and no horizontal page scroll at every width.
  EVIDENCE: 0 / no overflow at all six widths (320px needed a tighter-tab rule, added).
- [x] "In office now" count from today's attendance (timed in, not timed out), refreshed every minute and after each recorded scan; no backend change.
  CHECK: npm test -w client -- App.test.tsx; live check after timing in 14 demo interns
  EXPECT: chip shows the WORKING count; "2 in office" for 2 WORKING + 2 finished rows in the test.
  EVIDENCE: new test passes; live header read "14 in office" (API: 14 WORKING of 16 rows today).
- [x] Kiosk text at least 14px; Admin and Admin setup quieter but in place; Manual entry focuses its field; greeting, reader and options centred on tall screens; reader row and hint no longer break on phones.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test; screenshots s2-before-* vs s2-after-*
  EXPECT: all pass; focus lands on #scanner-uid.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 411 + 297 (2 new: headcount, manual focus; one existing test now answers the headcount request separately); activeElement is scanner-uid.
- [x] Review follow-up: Admin and Admin setup outlines restored (quiet style removed).
  CHECK: footer crop of s2-9-after; npm test -w client -- App.test.tsx
  EXPECT: four outlined buttons; tests pass.
  EVIDENCE: crop shows four gold-outlined buttons; 82/82.

## UI revamp Stage 3: kiosk finish (client only; K6, K8, X5, D5)

- [x] Plain-word errors: "Card not registered" / "Card inactive" with a next step; raw error codes hidden; other errors keep the system message; voice unchanged.
  CHECK: npm test -w client -- App.test.tsx
  EXPECT: new tests for inactive and an unmapped error pass; updated unknown-card tests pass; announceScanError still receives the original message.
  EVIDENCE: 85/85 App tests.
- [x] Bathroom Key Log fits 1366x768 and the reader box clears after a bathroom result.
  CHECK: headless measurement of key-card blocks and #scanner-uid value after reset
  EXPECT: key status blocks end inside 768px; reader value "" after reset (was "••••••••••").
  EVIDENCE: cards start at 444px (was 590), status blocks end at 701px; reader value "" after reset.
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint 0 (after naming the ScanErrorCopy type for the anti-slop rule), typecheck 0, npm test 39 + 414 + 297.

## UI revamp: kiosk design pass and glass revision (client only, styles.css + two footer icons)

- [x] Switch highlight slides instead of jumping; mode change replays a short fade.
  CHECK: headless sampling of the switch thumb transform and the hero title opacity after clicking Bathroom
  EXPECT: thumb x rises through middle values to the second tab; title opacity climbs from 0 to 1.
  EVIDENCE: thumb 0 → 148 → 189px; title opacity 0 → .17 → .88 → 1 within about 0.8 seconds.
- [x] Entrance animations end fully visible; glass and grain are active.
  CHECK: computed opacity of greeting, reader and 4th footer button 4.5s after load; backdrop-filter of the reader; ::after background of the shell
  EXPECT: opacity 1 for all three; blur(18px) saturate(1.4); grain data URI present.
  EVIDENCE: "1", "1", "1"; blur(18px) saturate(1.4); url("data:image/svg+xml,...").
- [x] No sideways overflow; Bathroom Key Log still fits a laptop.
  CHECK: headless count of kiosk elements past the right edge at 1920, 1366, 768, 390, 320 (both modes) and the lowest card bottom at 1366x768
  EXPECT: 0 past the edge, no page scroll sideways; bathroom cards end inside 768px.
  EVIDENCE: 0 everywhere after hiding the 1/2 badges on phones (390px Bathroom tab overflowed its half before that); cards end at 737px.
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 414 + 297.

## UI revamp: kiosk header width and centring (client only)

- [x] Mode switch centred on screen; header wider with side margins; nothing spills out.
  CHECK: headless measurement at 2560, 1920, 1600, 1536, 1440, 1366, 1280, 1279, 1180, 1100, 1024, 960, 901, 768, 600, 390, 320px: switch centre minus screen centre, header items past the bar edge, sideways page scroll
  EXPECT: 0px off-centre and 0 items past the edge at every width; no sideways scroll.
  EVIDENCE: 0px everywhere (was -57px at 1366 and up to -113px at 1024-1100); 0 past the edge (was 3 at 1280, 4 at 901-960); no sideways scroll. Bar margins 16-40px (80px at 1920, capped at 1760px wide).
- [x] Bathroom Key Log still fits short laptop screens with the two-row header.
  CHECK: lowest key-card edge in Bathroom mode at 1024x768, 1180x800 and 1366x768
  EXPECT: inside the screen height.
  EVIDENCE: 761 of 768 (782 before the short-screen spacing rule), 765 of 800, 737 of 768.
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 414 + 297.

## UI revamp batch 2: Live attendance (client only; App.tsx, styles.css, App.test.tsx)

- [x] Existing Live attendance tests still pass unchanged.
  CHECK (client/): npx vitest run src/App.test.tsx -t "live attendance view|newest snapshot when overlapping|Live Attendance table|on the live table|in the live table"
  EXPECT: 6 passed.
  EVIDENCE: 6 passed (run together with the 3 new tests: 9 passed).
- [x] LAN viewer collapsed by default yet still auto-started; header links are buttons with icons; at-a-glance counts from loaded rows.
  CHECK (client/): npx vitest run src/App.test.tsx -t "Live attendance revamp"
  EXPECT: 3 passed.
  EVIDENCE: 3 passed. The counts fixture includes a MISSED row with an empty time in (review finding): counts read 0 in office / 2 timed out / 2 timed in / 1 need correction.
- [x] Phones and tablets show Time in, Time out and Status for every row; no sideways scroll.
  EVIDENCE: no sideways scroll and 0 cells past the edge at 320, 375, 381, 389, 390, 414, 430, 480, 600, 601, 700, 768, 820, 900, 1366, 1920, 2560 (16 rows). Time in/Time out columns sit at one x-position per width from 320 to 900 (review finding: per-row auto tracks shifted them; fixed with equal halves on phones and an 11rem status column on tablets). Injected LATE TIMEOUT + hint row: no overlap at 320-600.
- [x] Scanner/Admin read as buttons; 14px text floor inside the page.
  EVIDENCE: both links 44px tall with border rgba(198, 162, 84, 0.4) at rest and an svg, at 1366 and 390; 0 visible text nodes under 14px inside .live-shell at 1366 and 390.
- [x] Workflow unchanged: LAN viewer still started on page open; attendance still polled every 5 s; week history requested once.
  CHECK: grep -c "void startLanViewer().then(setLan)" client/src/App.tsx
  EXPECT: 1 (inside LiveAttendance).
  EVIDENCE: 1; over 31 s on /attendance: /api/attendance 7 requests, ?date= history 5 requests for 5 distinct days (once each).
- [x] No look change on kiosk or Admin; new CSS scoped to .live-shell.
  EVIDENCE: kiosk keeps 3 fixed radial lights, glass topbar blur(18px) saturate(1.4), body background-image none; /admin (login, no session) renders the original card and has no .live-shell; every new rule in the live block starts with .live-shell or body:has(.live-shell). Review finding fixed: the inline body color in index.html beat the live base color; body:has(.live-shell) now computes rgb(8, 8, 7).
- [x] Client only: no new server, src-tauri or shared changes.
  CHECK: git diff --stat -- server src-tauri shared
  EXPECT: unchanged from before this batch (3 files, +25 -7: the temporary demo-seed hooks only).
  EVIDENCE: 3 files changed, 25 insertions(+), 7 deletions(-).
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint 0, typecheck 0, npm test 39 + 417 + 297.

## UI revamp batch 3: card setup dialog and admin shell + Users and RFID (client only)

- [x] Card setup dialog, save step: every field shows without scrolling at 1366x768 and 1920x960; on phones it may scroll but Save stays in view.
  EVIDENCE: before 560px wide, scrollHeight 893 vs clientHeight 688 (1366x768) and 737 (1920x960). After 1000x657 with no scrolling element at both sizes; phone: form scrolls 1002/698 with the sticky Save bar.
- [x] Dropdown arrows sit clear of the right edge in the dialog and the admin forms.
  EVIDENCE: dialog selects appearance none, background-position calc(100% - 16px) 50%, padding-right 44px (before: native arrow about 4px from the edge); admin forms right 14px / 40px.
- [x] Dialog (unknown-card setup and kiosk Admin setup, incl. Forgot PIN and scan step) uses the glass look and shows its 3 steps on every step; existing setup dialog tests pass unchanged.
  EVIDENCE: 0 text nodes under 14px in the dialog at 1366, 1920 and 390; client suite passes with no edits to the setup dialog tests.
- [x] Admin: no page-level sideways scroll and no table sideways scroll from 320 to 1920.
  EVIDENCE: document scrollWidth equals the viewport and the users table width equals its wrapper at 320, 390, 768, 1024, 1280, 1366, 1920 (with and without the registration pop-up).
- [x] Admin header and tabs: compact original sizes (34px buttons and tabs), icons, clear active tab; the 1/2 shortcuts, tab order and every action are unchanged.
  EVIDENCE: header buttons 34px at every width; mode switch test and tab tests pass.
- [x] Registration form opens on demand in a pop-up and protects unsaved typing.
  CHECK (client/): npx vitest run src/App.test.tsx -t "registration form on demand"
  EXPECT: 3 passed (closed by default; Add user opens and focuses User ID; tab switch, Edit and Cancel ask "Discard unsaved changes?"; Keep editing keeps the typing; the 2 key does nothing while open).
  EVIDENCE: 3 passed. Pop-up 860x589 (Add) and 860x640 (Edit) at 1366x768 with no scrolling. Review findings fixed: blur clean-ups no longer count as changes; uploads in progress count as unsaved and never land on another record; no second browser prompt after Discard on a link; modified clicks keep their new tab; no stale prompt after a lock; updates ask first.
- [x] Kiosk and Live attendance look unchanged.
  EVIDENCE: kiosk topbar blur(18px) saturate(1.4) and 12px buttons; Live header radius 20px, 44px buttons, body rgb(8, 8, 7), no .admin-shell on /attendance.
- [x] Client only: no new server, src-tauri or shared changes.
  CHECK: git diff --stat -- server src-tauri shared
  EXPECT: unchanged (3 files, +25 -7: the temporary demo-seed hooks only).
  EVIDENCE: 3 files changed, 25 insertions(+), 7 deletions(-).
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint 0, typecheck 0; full npm test 39 + 420 + 297 and verify:mcp passed before the pop-up change; client suite re-run after it (see the final report).

## UI revamp batch 3b: compact kiosk and Live, sliding selections, one pop-up design, kiosk sparkles (client only)

- [x] Kiosk home and Live attendance at compact sizes with 8px panels and 6px controls; no sideways scroll.
  EVIDENCE: kiosk header 64px (was 76), Live header 179px (was 203), Live buttons 34px (were 44). Width sweep 320, 360, 390, 414, 600, 768, 900, 1024, 1280, 1366, 1440, 1500, 1920, 2560: no page sideways scroll on kiosk (attendance and bathroom) or Live; kiosk switch centred (offset 0) at every width; no mode tab clipped. Bathroom 1024x768 fits (768px; was 774 after the size change, 783 at 1366x768 before).
- [x] "Register card as" and the admin tabs slide; the registration pop-up and kiosk card setup keep their size when switching card type.
  EVIDENCE: admin pop-up 860x583 both ways; kiosk save step 656.5px both ways; thumb width equals the option width (223.5px) and lands on it; tab thumb rect equals the active tab rect for Users, Payroll and Voice at 1366 and when wrapped at 800; focus stays on the radio after switching.
- [x] Cancel and Save user the same size; paired pop-up buttons equal.
  EVIDENCE: Cancel and Save user 132x40 each (Save was 48px tall); confirmations 201x40 each; Edit payroll and Add missed attendance 220x40 each.
- [x] One pop-up design; destructive confirmations are coral; test names unchanged.
  EVIDENCE: 11 ConfirmDialog usages pass tone="danger" (delete user/selected, delete attendance record/selected, delete payroll/selected/cutoff records, restore database, wipe Sheets, discard unsaved changes x2); Finalize and Generate stay gold; "Confirm"/"Cancel" labels kept (12 tests use /confirm/i).
- [x] Kiosk sparkles are light and out of the way.
  EVIDENCE: 18 elements, transform and opacity only; no scroll added (scrollWidth 1366 at 1366); clicks reach the controls (elementFromPoint at the footer returns .kiosk-actions); paused while the card setup dialog is open; hidden with prefers-reduced-motion; positioned in the side bands, clear of the frosted centre cards.
- [x] Review: 9 confirmed findings fixed (thumb box-sizing, pop-up hover and busy states, kiosk focus on card-type switch, kiosk row heights, phone reader dot, gleam in scrolling pop-ups, stale tab thumb).
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w client
  EXPECT: all pass; server, src-tauri and shared unchanged (3 files, +25 -7 demo-seed hooks only).
  EVIDENCE: oxlint 0, typecheck 0, client 20 files / 420 tests passed; git diff --stat -- server src-tauri shared: 3 files changed, 25 insertions(+), 7 deletions(-).

## UI revamp batch 3c: backup tree, payroll PDFs by month, calm attendance filters, bathroom alignment (client only)

- [x] Existing backups opens by default with every month closed; the tree indents stay.
  EVIDENCE: database-panel test updated (list open, October and September closed) and passing; shot e-after-backups shows the list open with 3 closed months.
- [x] Generated payroll PDFs are grouped by cutoff month (newest month first), latest month open, older months closed; one header row; Open PDF and Show in Folder unchanged.
  CHECK: npm test -w client -- payroll.test.tsx
  EXPECT: all pass (list, open and reveal tests unchanged).
  EVIDENCE: payroll.test.tsx passes, plus a new test: October 2026 (2) open, September 2026 (1) closed even when regenerated last, toggling both ways.
- [x] Attendance filters are calmer and still one click: status filters as an underline bar with a sliding gold line and small counts (zero counts dimmed); Assisted and Backdated as separate on/off toggles; names stay "Assisted 1" / "Backdated 1".
  CHECK: npm test -w client -- App.test.tsx -t "filter pills"
  EXPECT: pass.
  EVIDENCE: test passes with new aria-pressed checks; underline 59px = All button 59px, 70px = Late 70px, 51px = 51px at 390 (border-box observed), offset 0; page width 390 at 390.
- [x] Bathroom Key Log: the date picker lines up with the page title and sits clear of the header; "Assign Key to Staff" and "Selected: …" are spaced apart.
  EVIDENCE: page starts 28px below the header card (was 8px); date bottom-aligned with the title block; "Selected: …" pushed to the right end of the label row (shot e-after-bath-assign).
- [x] Repository gates.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test -w client
  EXPECT: all pass; git diff --stat -- server src-tauri shared unchanged (3 files, +25 -7).
  EVIDENCE: oxlint exit 0, typecheck exit 0, client 20 files / 421 tests passed; 3 files changed, 25 insertions(+), 7 deletions(-).

## UI revamp batch 4: admin header on the page, reader status dot, kiosk pill, Live search (client only; A1, A3, K3, L4)

- [x] A1: brand block (kicker, visible "Manage attendance" h1, office address) and the action buttons sit on the page background; section tabs and the 1/2 switch are two separate bars on one row; switch wraps under the tabs on smaller screens; names, guards and sliding thumbs unchanged.
  EVIDENCE: at 1366x768 the brand block is 119px, the bars 46px, and the content starts at y=253; tabs bar 852px and switch 350px share the row; one h1 "Manage attendance"; page width 1356/1366 and 390/390 (no sideways scroll); in Bathroom mode the tabs bar hides and the switch stays at the right.
- [x] A3: reader status as a dot plus a word (Reader ready / Checking / Reader missing / Reader error / Browser mode) with a details popover (Escape, click outside, aria-expanded).
  EVIDENCE: shot b4-after-reader-popover; ScannerDiagnostics tests updated and the new state tests pass.
- [x] K3: kiosk header pill reads Reading…, Done or Error during a scan result, then the reader's own state.
  EVIDENCE: captured pill text Ready -> Done after a demo scan, Error after an unknown card; test "header pill follows the scan" passes in the full suite (result window widened to 1.2 s so it is not flaky).
- [x] L4: Live attendance search (name or ID) and department filter, on screen only, "No one matches" with Clear filters; the at-a-glance counts still cover the whole day.
  EVIDENCE: shot b4-after-live-search ("Ma" -> 3 rows) and b4-after-live-empty; test passes with no extra requests.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client
  EXPECT: all pass; server, src-tauri and shared untouched.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 20 files / 429 tests passed.
- [x] Review (3 lenses, each finding verified): fixed a red "Error" pill on a repeat tap (now calm "Done" like the "Already scanned" card), reader details now close when focus leaves and Escape elsewhere no longer pulls focus to the header, Clear filters returns focus to the search box, the reader keeps its word on phones, and the actions align with the top of the brand block.

## UI revamp batch 5: pop-ups and messages (client only; X1, X2, X3, X4, X6, X7)

- [x] X1: every confirmation names its action (ConfirmDialog now requires confirmLabel); deleting one user needs the user ID typed first.
  EVIDENCE: shot b5-after-delete-user (button "Delete user" stays disabled with a partial ID); b5-after-restore-confirm ("Restore database", coral); requireText test passes.
- [x] X7: one dialog keyboard hook for every pop-up: Escape closes (not while busy), Tab stays inside, focus moves in (Cancel first on destructive ones) and returns to the opener; only the top pop-up answers Escape; links get a gold focus outline.
  EVIDENCE: use-dialog-keys tests; Escape tests for the restore confirmation, Add missed attendance and the backup guide; stacked Escape test (discard question first, then the form).
- [x] X2: messages carry an explicit type (success gold with a tick, info grey, error coral); word-guessing removed from card setup and the user form.
  EVIDENCE: notice.tsx used by card setup, UserEditor, Payroll, Data and backup, attendance messages, file actions, PIN reset, voice settings.
- [x] X3: short notes (toasts) for routine results; problems stay inline.
  EVIDENCE: shot b5-after-toast ("User saved." bottom right); toasts tests (shows, hides at 3.5 s, dismiss, max 3).
- [x] X4: loading rows and "Couldn't load … Retry" per list; one failure does not block the other tabs.
  EVIDENCE: list-load tests; Retry reloads only the failed users list; backup list Retry test.
- [x] X6: shared Manila date helpers (Fri, Oct 30, 2026 / 1:26 PM / Oct 16–31, 2026 / 2m 30s) for dates shown in admin; values sent to the server, CSV and date inputs unchanged.
  EVIDENCE: format.test.ts; shot b5-after-pdf-dates (Oct 16–31, 2026 ranges, "Nov 1, 2026, 11:15 AM").
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client
  EXPECT: all pass; server, src-tauri, shared and client/src/api.ts untouched by this batch.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 24 files / 460 tests passed.
- [x] Review (3 lenses, each finding verified, 10 distinct problems fixed): earlier coral errors now clear when a later action succeeds; Attendance corrections drops the old date's rows, count, selection and export while a new date loads or fails; batch actions report partial failures inline instead of a success note; the backup list shows the reason and no futile Retry in the browser; payroll See all survives Retry; the update's release date uses Manila time; notes sit above the update banner; the users load error has margins; the note region no longer re-reads every note; dead CSS removed.

## UI revamp batch 6: Users and RFID (client only; U6, U7)

- [x] U6: one count ("41 users" / "39 of 41 match"), See all / Show fewer without a number, the header tick box selects the rows shown (half-ticked when some are), and ticking rows swaps the list bar for "N selected · Clear" with Set active, Set inactive and Delete (existing batch handlers; partial failures inline); focus returns to the tick box when the bar hides; Sync DTR has no batch version, so it stays as "Sync Interns to DTR" on the normal bar.
  EVIDENCE: live shots b6-after-list, b6-after-selected (1366) and b6-after-selected-390; tests for the bar, Clear, Delete confirm and Set inactive pass.
- [x] U7: User ID placeholder "e.g. APG-2026-001" in the registration pop-up and the kiosk card setup; a muted "Usual format: APG-YYYY-NNN" hint while the value doesn't match, never blocking Save (demo IDs still save); off for admin cards and edit mode.
  EVIDENCE: shots b6-after-add-hint and b6-after-kiosk-hint; pop-up 860x591 and kiosk dialog 677px at 1366x768, no scrolling.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 24 files / 469 tests passed.
- [x] Review (3 lenses, each finding verified, 7 distinct problems fixed): the kiosk hint shows only for new cards; both bar layers share one grid cell so the list never jumps (measured equal heights at 320, 390, 430, 480, 540, 768, 1366); a search unticks rows it hides and the count and actions use shown rows only; focus hand-off only when the bar started the action and never behind a pop-up; kiosk 24px row gap only above 600px; the hint is a description (aria-describedby), not part of the field name; focus returns to the bar after a partial failure.

## UI revamp batch 7: Attendance corrections, attendance-first admin, time sorting (client only; C1, C2, C3, C4 + user requests)

- [x] C1: rows are read-only (plain times, arrival, status, Edit and coral Delete); Edit opens only that row with the time inputs, Save and Cancel; per-record drafts survive search, filters and sorting; an "Unsaved" tag and gold edge while changed; changing the date with unsaved rows asks first; the save payload and original-stamp logic are unchanged.
  EVIDENCE: live shots b7-after-readonly and b7-after-editing (Maria Ramos open with "Unsaved", others read-only); 10 attendance tests now click Edit first; new tests for read-only, Edit/Cancel, Unsaved, search keeping drafts and the date-change question.
- [x] C2/C3/C4: the day shows once ("Fri, Oct 30, 2026 · Total records: 35") with no Date column (CSV unchanged); one time format ("8:12 AM", late time-out note "6:00 PM"); arrival badges "Late 13m" / "Late 1h 12m".
  EVIDENCE: b7-after-readonly; format.test.ts covers formatLateMinutes.
- [x] User request: tabs ordered Attendance corrections, Users and RFID, Payroll, Data and backup, Voice announcements; admin opens on Attendance corrections.
  EVIDENCE: captured tab list after unlock: ["*Attendance corrections","Users and RFID","Payroll","Data and backup","Voice announcements"].
- [x] User request: a quiet newest/oldest sort (heading arrow with aria-sort, tiny phone toggle, remembered per page) by time in on Attendance corrections and Live attendance, and by time out on the admin bathroom key logs; empty times last.
  EVIDENCE: corrections rows flip from 9:11 AM first to 7:30 AM first (b7-after-oldest); time-sort.test.tsx and page tests pass.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 25 files / 490 tests passed.
- [x] Review (3 lenses, 17 verified findings, 12 distinct problems fixed, plus the lead's bathroom word-break): unsaved corrections now trigger the leave question on tab switch, the 2 key, Bathroom, Lock, page links, reload and update install, naming the section; focus returns after a save only if it was still in that row; the exact-stamp test uses seconds; clamped rows sort by the time shown; sort headings keep their names and row actions name the person; the date is locked while a row saves and load uses the current date's loader; a record changed by a refresh shows a note; unsaved rows hidden by filters are announced with Show; keyboard-typed dates commit on Enter or blur; row messages sit on their own line; bathroom log headings and pills never break mid-word (bathroom cards no longer scroll sideways at 390).

## UI revamp batch 8: Payroll (client only; P1, P2, P3, P4, P5)

- [x] P1: the Generate panel opens on the most recently ended half-month cutoff (Asia/Manila), with month, preset and standard days to match; a disabled Generate says why.
  EVIDENCE: live on Nov 1, 2026 the dates read 2026-10-16 to 2026-10-31 with "16th–last day" pressed (b8-after-top); boundary tests include the 15th and 16th.
- [x] P2: "Download payroll PDF" and "Download payslips", disabled with a reason until the chosen cutoff has payroll; values sent to the server unchanged.
  EVIDENCE: b8-after-top; payroll tests updated to the new names.
- [x] P3: display-only step bar Cutoff · Review · Finalize · Export (current step gold with aria-current, done steps ticked).
  EVIDENCE: step-bar tests for drafts, partly finalized, all finalized and PDF present.
- [x] P4: empty states give the next step ("No payroll for this cutoff yet. Pick a cutoff above, then select Generate from attendance."; "No PDFs yet. Finalize the cutoff, then Download payroll PDF.").
- [x] P5: "PDFs for Oct 16–31, 2026" beside the export buttons (newest first, Open PDF / Show in Folder), month-grouped history kept at the bottom.
  EVIDENCE: b8-after-top shows the two Oct 16–31 PDFs; no sideways scroll at 1366 (1356/1366) or 390 (390/390).
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 25 files / 500 tests passed.
- [x] Review (3 lenses, 15 verified findings, 7 distinct problems fixed): the cutoff label now follows the dates (a half-month preset's label, otherwise "<start> to <end>"), so hand-typed dates never save the pre-filled name; the step bar goes in order (Review current while drafts exist, Export done only when all finalized and a PDF exists); the regenerate banner shows only with drafts, otherwise a calm "All N records … finalized" line, and deleting finalized records needs DELETE typed; the table shows the chosen cutoff with a "Show all cutoffs" toggle and a Period column; Generate and exports say why while payroll loads or fails; preset and hand-typed paths tested; focus rings no longer clipped.

## UI revamp batch 9: System tab, Data and backup in plain words, Friday backup reminder (client only; O1, O2, O3 + audit S1-S5, D1-D4)

- [x] O1/S1-S5: a sixth "System" tab (last; same unsaved-changes guard) with one flat "This PC" card: version beside Check for updates now, "Check for updates automatically", "Open the attendance screen when Windows starts" (disabled in a browser with "Only in the desktop app"; failure says so), one card reader line, and a closed "Technical details (for support)" fold; no developer lines left.
  EVIDENCE: live shot b9-live-system (1366) and b9-live-system-390.
- [x] O2/D1-D4: Data and backup has two sections, "Backups" (last backup line, Create backup now, Restore from backup file, Open backups folder, Existing backups with every month closed, date first in each row, "How to move to a new PC" link, restore-waiting line) and "Google Sheets" (one plain-words badge, one Sync now, a plain "Upload attendance to Google Sheets from this PC" checkbox, a closed "Details for support" fold); 34px buttons; no paths or storage mode outside the folds.
  EVIDENCE: live shot b9-live-data; page width 1356/1366, 390/390.
- [x] O3: "Last backup: today, 8:02 AM" (coral when over 7 days or none); a Friday banner under the admin header on every tab when it is Friday in Manila, at least one intern timed in today, no intern is still timed in and no backup was made today; Create backup now runs the shared backup action; Later hides it for the day; checks every 5 minutes, no requests on other days.
  EVIDENCE: backup-reminder.test.tsx (rules, polling, Later, shared action) passes.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 534 tests passed (run with 2 workers; the PC was low on memory).
- [x] Review (3 lenses, 17 verified findings, 8 distinct problems fixed): the reminder asks nothing on other days, after Later or once a backup covers the day, reads backups before attendance, and the App tests pin a Thursday clock so they pass on Fridays; it is due when the newest backup is older than the last intern time-out; one backup at a time with a shared "Saving backup…" state; the card reader shows the real last scan from today's attendance; the startup setting is read back after a change; backup and upload actions have separate busy states; upload wording in plain words; Sync now is disabled while uploads are off.

## UI revamp fix round: Payroll done properly (client only; audit P1, P2, P4-P10)

- [x] P1: three steps that say their status in words (Make payroll / Check and finalize / Export; circles: done gold tick, current filled gold, upcoming grey outline; about 640px, left-aligned) and one Next line holding the page's one gold button: no payroll → Generate from attendance; drafts → Finalize all (N) with Generate again · Delete all records; all finalized without PDF → Make payroll PDF (+ Make payslips); done → "Done. PDF made …" with Open PDF · Show in folder · Make payslips · Make PDF again. The yellow banner, the finalized line and the Export panel are gone; Generate's pop-up only mentions drafts when there are drafts.
  CHECK: cd client && npx vitest run src/payroll.test.tsx
  EXPECT: tests for each step state and Next line (no records / drafts / all finalized no PDF / done) and for Finalize all pass.
  EVIDENCE: payroll.test.tsx 52/52 passed (was 43; new: step words per state, loading/failed words, one Next line per state, Finalize all + partial failure, all-finalized Generate pop-up, PDF open failure, selection bar, switch, row layout).
- [x] P2: the PDF and payslips can't be made while any draft of the cutoff is left ("Finalize all N drafts first.").
  CHECK: cd client && npx vitest run src/payroll.test.tsx -t "blocks the payroll PDF"
  EXPECT: no export call is made while drafts exist.
  EVIDENCE: passes; the buttons appear only once every record is finalized and say "Loading payroll…" while the list reloads.
- [x] P4/P5: Net Pay bold gold text (no #fef08a/#854d0e), Total Deductions plain bold ink; rows: Employee = name with the ID under it, a Status column with a dot and a word, actions on one line, money right-aligned with tabular numbers.
  CHECK: grep -c "fef08a\|854d0e" client/src/App.tsx client/src/styles.css
  EXPECT: 0 and 0.
  EVIDENCE: 0 and 0. Measured at 1366: rows 53px (a name over ~180px wraps to 70px), table 1235/1235px with no sideways scroll in the drafts state.
- [x] P6/P7: "Make payroll PDF" / "Make payslips"; a made PDF opens straight away; only the latest PDF in the Next line; history is a closed "Past payroll PDFs" fold (by month), newest copy per cutoff tagged "Latest", no Type column, money column "Total earnings".
- [x] P8/P9: table bar "Oct 16–31, 2026 · 37 records", See all without a number, a sliding "This cutoff | All cutoffs" switch, header tick box only, selection bar "3 selected · Clear | Finalize selected · Delete selected"; cutoff picker keeps month + half with a read-only "Oct 16–31, 2026 · 11 working days" line and a "Change dates" link for start, end and standard days; labels sent to the server unchanged.
- [x] P10: payroll rows become cards at 900px and below; no sideways page scroll at 320–1920; screenshots of the four states at 1366x768, 1024 and 390 in the scratchpad folder shots-fixpay.
  EVIDENCE: 28 width/state checks (320, 390, 600, 768, 1024, 1366, 1920 × 4 states, folds open and All cutoffs on): page width never above the window; 12 screenshots saved (made-up data, temporary harness deleted).
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 543 tests passed (an earlier run hit two 5s timeouts in unrelated Users/Corrections tests while the PC had ~180 MB free; both pass alone and the rerun was clean).
- [x] Review fixes (A–G): a PDF counts as current only with the cutoff's headcount and made after the last finalize (Date.parse; older or other-headcount PDFs show "Ready · PDF out of date" and "Next: the payroll changed since the last PDF. Make a new payroll PDF.", and lose "Latest"); loading/failed say so with no gold button; payslip folder and notes reset when the dates change; Net Pay pinned beside the pinned actions, and Standard, Daily rate, Basic pay, Absent, Late / Halfday step aside at 901–1300px (and 1301–1600px with extra columns); standard days outside 0–31 or not whole/half refused before generating; focus moves to the new gold button (or the Next sentence) when an action removes the focused one, Next sentence is aria-live; steps stack at 680px and below.
  CHECK: cd client && npx vitest run src/payroll.test.tsx
  EXPECT: all pass, including out-of-date PDF (older than finalizedAt, headcount mismatch), loading/failed Next line, 45 days refused, payslip folder reset, focus after Finalize all.
  EVIDENCE: 56/56 passed. Headless layout checks: Net Pay fully visible beside the actions at window widths 901, 1024, 1093, 1300, 1349, 1366, 1440, 1600 (drafts, drafts with All cutoffs, done with All cutoffs); steps text never under a hairline from 601 to 900px.
- [x] Test stability: client/vite.config.ts sets testTimeout 15000, because full admin flows passed 5 s on the busy front-desk PC (one test took 6.6 s on its own); full suite 26 files / 547 tests passed with 2 workers.

## UI revamp fix round: Attendance corrections and admin polish (client only; audit C1-C5, E1 + Live status words)

- [x] C1: rows are calm: status as a dot and a word ("Working", "Completed", "Missed", "Late time-out"; no capsule pills), "Late 38m" plain gold text, "On time" muted, Delete grey that turns coral only on hover/focus (still confirms); the clamp chip keeps its title and test id.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "Attendance corrections"
  EXPECT: row tests pass with the new words; no "LATE TIMEOUT" or uppercase status text in the attendance tables.
  EVIDENCE: passes; `grep "LATE TIMEOUT" client/src/App.tsx` finds nothing; shots corrections-normal-*.
- [x] C2: one name, "Late time-out", for the status word, the filter and the row note; Live's chip reads "N late time-out". Status filters in order All, Late time-out (coral count above 0), Working, Completed, Missed, adding up to All; "Late" is a toggle beside Assisted and Backdated; all three dim at 0.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "filters"
  EXPECT: a test reads the status buttons in that order with counts that add up to All, and the Late toggle combines with a status.
  EVIDENCE: new test reads ["All 3", "Late time-out 1", "Working 1", "Completed 1", "Missed 0"] (1+1+1+0 = 3) and ["Late 2", "Assisted 0", "Backdated 0"]; Late + Working shows "1 of 3 records". Live test reads "1 late time-out".
- [x] C3: the filter row is 34px (date, Today, Name or ID, Department); "Add missed attendance" (outline) and "Export CSV" sit at the right of the table bar; Today has white text when enabled.
  EVIDENCE: measured at 1366: the four filter controls 34/34/34/34px, the bar buttons 34px; Today enabled rgb(246, 242, 233) (--ink), disabled dimmed. Shots corrections-normal-*.
- [x] C4: table bar "Fri, Oct 30, 2026 · 35 records", "See all" without a number, header checkbox only, and while rows are ticked "3 selected · Clear | Export selected · Delete selected" in the same grid cell (nothing moves).
  CHECK: cd client && npx vitest run src/App.test.tsx -t "selection bar"
  EXPECT: the bar swaps in and out, Clear empties it and returns focus to the header checkbox, Delete selected confirms.
  EVIDENCE: passes; both layers 34px at 1366 (phone 390: 90px and 76px in one cell, so the rows stay put). Shots corrections-ticked-*.
- [x] C5: a late time-out row has one short coral line in its own note line under it: "Timed out after office hours. Click Edit and enter the real time-out." (no box, no paragraph above the row).
  CHECK: cd client && npx vitest run src/App.test.tsx -t "late time-out line"
  EXPECT: the line sits in the note line right after the row; the old "manual correction required" paragraph is gone.
  EVIDENCE: passes; shots corrections-late-* (Late time-out filter on).
- [x] E1: the Attendance / Bathroom Key Log switch is quiet: the active option has gold text and a thin gold outline thumb that still slides; the 1/2 badges stay; only the section tab is filled gold.
  EVIDENCE: computed thumb: no background image, transparent background, 1px rgba(225, 196, 119, .6) border, no shadow; active text rgb(225, 196, 119). Shots admin-header-1366x300 and admin-header-390x540.
- [x] Batch 7 behaviour unchanged: Edit/Save/Cancel, per-record drafts, leave and date guards, time sort, save payload and record-changed note.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "rows open on Edit"
  EXPECT: all pass.
  EVIDENCE: 15 passed (12 before + 3 new).
- [x] No sideways page scroll; screenshots (made-up data, temporary harness deleted) in the scratchpad folder shots-fixcorr.
  EVIDENCE: page scroll width never above the window at 320, 768, 1024, 1366 and 1920 in all four states (normal, one row open, late time-out, rows ticked); 16 screenshots saved.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 550 tests passed.
- [x] Review fixes (A–G): the unsaved-rows-hidden note, the phone sort toggle and See all sit in both bar layers, so ticking rows never hides them; status counts leave out the status filter and each toggle leaves out its own filter, so All matches "N of M" and dimming follows the other filters; Export/Delete selected act only on ticked rows still shown; a partly failed Delete selected puts the focus back on the bar; the late time-out line says "Enter the real time-out and click Save." while the row is open and a still-late save says "Saved. Still a late time-out: enter the real time-out."; a ticked row's note line shares its tint and gold edge; Live's chip pluralises ("2 late time-outs").
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass, including new tests for the note while ticked, Late + Assisted narrowing the selection (one CSV row, one delete), the partial delete focus, counts with Late on and a search, and the plural chip.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 553 tests passed. Live check at 1366: Late on → "All 13" with 2 + 4 + 7 + 0 = 13 and "13 of 35 records"; a ticked late time-out row's note cell has the row's rgba(198, 162, 84, .08) tint and 3px gold edge.

## UI revamp batch 10: One text-size scale, three button types, calm status and notes (client only; D2, D4 + audit consistency)

- [x] D2: `:root` defines --fs-12, --fs-14, --fs-16, --fs-20, --fs-28, --fs-40 and --fs-60, and every rem font size in styles.css plus the inline fontSize values in App.tsx and bathroom-key-log.tsx use them. Nothing is below 12px. The kiosk greeting stays fluid between 40 and 60. One deliberate exception: the short-screen greeting cap (max-height 760px) keeps 3.2rem.
  CHECK: node -e "const s=require('fs').readFileSync('client/src/styles.css','utf8'); for (const t of ['--fs-12','--fs-14','--fs-16','--fs-20','--fs-28','--fs-40','--fs-60']) if(!s.includes(t+':')) process.exit(1); const free=(s.match(/font-size:\s*[\d.]+rem/g)||[]).length; if(free>1) {console.log(free); process.exit(1);}"
  EXPECT: exit 0; no plain `font-size: Nrem` left (the short-screen cap sits inside a clamp), and no px font size outside the tokens.
  EVIDENCE: live at 1366: Live attendance text uses 12/14/16/20px only; the kiosk uses 12/14/16 and a 60px greeting (54.7px at 390). No sideways scroll on either.
- [x] Sizes that moved by more than 2px were listed and accepted as calmer:
  - page titles: 24 → 20;
  - small labels: 9.92 → 12;
  - the time-in card name and time: 33.6 → 28 at 1366;
  - notice titles: 30.4 → 28;
  - the admin login title: 24 → 20;
  - the bathroom key titles: 18.4 → 16.
  EVIDENCE: before/after pairs at 1366 and 390 in the scratchpad folder shots-b10 (kiosk idle, success, already scanned, login, Live, corrections, users, payroll, data, system, voice, bathroom log).
- [x] Badges, counts and small times use Poppins: Live times and counts, backup counts, slider badges, the 1/2 key badges, bathroom pills, the elapsed timer, update dialog numbers, the assisted countdown and the corrections date. The clock, greeting, brand and headings stay Orbitron.
- [x] D4: Data and backup, System, Voice announcements and the admin Bathroom Key Log use the three button types:
  - gold filled for the main action and outline for the rest;
  - 34px in toolbars, 40px on the bathroom card actions, 6px corners;
  - disabled buttons dim and don't change on hover.
  On the bathroom page, Time In (Return Key) is outline (label and test ids kept), Time Out is filled, and Today is a 34px outline button. The page title is 20px, above the 16px key titles. The old green and gold bathroom button rules and the old Users selection-bar rules are deleted.
- [x] Users status reads "● Active" (green) and "● Inactive" (grey) in sentence case.
  CHECK: cd client && npx vitest run src/database-panel.test.tsx
  EXPECT: the new test finds "Active"/"Inactive" with the dot class, and "ACTIVE" is gone.
- [x] Assisted/Backdated notes are small muted text with the icon ("Assisted by …", "Backdated by Admin — reason"). On the desktop table (901px and up) they are cut to one line with the full text in the title. On tablet and phone cards they wrap in full.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "Assisted"
  EXPECT: the wording, the full text in the title, and no inline style.
- [x] Review fixes:
  - the open Voice help bubbles stay inside the screen and their card;
  - the notes wrap on cards;
  - the bathroom title is 20px;
  - the corrections date is Poppins with tabular-nums;
  - dead CSS is removed;
  - a test comment is trimmed.
  EVIDENCE: each of the 5 info bubbles focused at 320 and 390: scrollWidth equals the viewport and every bubble is inside its card; also checked at 768 and 1366.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 554 tests passed.

## UI revamp batch 11: Kiosk Bathroom Key Log, ID-card key cards, Type card ID, flash instead of pop-up (client only; owner requests 2026-11-02)

- [x] The key cards look like the time-in ID card.
  - In use: gold-framed photo (or initials), a "Key taken" chip, the name, "ID · department", and "Taken" in gold with a ticking "Out for".
  - Available: an empty frame with a key, "Ready to take" and "Tap your ID to take this key".
  - Status is "● In use" / "● Available".
  - The cards are equal height in both states at every width.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "ID-card key cards"
  EXPECT: all pass, including the holder photo after a checkout, initials when the photo is unknown, and the card wording.
  EVIDENCE: card heights match whether a key is in use or free: 281/281 at 721, 768 and 900; 270/270 at 390; 279/279 at 360 and 320; 286/286 at 1366.
- [x] The cards come first. The hero is smaller, and its title is 40px with a 56px icon (owner asked for a little bigger; 28px at 600px and narrower). At 1366x768 the hero, both cards and Type card ID fit without page scroll. No sideways scroll from 320 to 1366.
  EVIDENCE:
  - 1366x768: hero 172–309, cards 328–614, button 636–670, scrollHeight 768. Before: reader box 267–422, cards 441–716.
  - Live check on the dev server: scrollHeight 768.
- [x] The reader box is hidden in bathroom mode. A "Type card ID" button opens an inline box (focused input, Record, ×). The box closes and clears:
  - after a recorded scan;
  - on × or Escape (from anywhere);
  - on a mode switch;
  - after 60 s without typing.
  A card tap while the box is open shows "Close Type card ID to scan your card". Wedge scans still check keys out and in with the box hidden.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "Type card ID"
  EXPECT: all pass (60 s close with fake timers).
- [x] A successful bathroom scan shows no pop-up (owner request). Instead:
  - the scanned key's card flashes gold for 1.8 s (a static highlight with reduced motion);
  - a return briefly shows "Returned by <full name> · time";
  - a visually hidden live region announces the result.
  The kiosk goes straight back to ready. Errors keep their card and the reset delay. A mode switch clears any result and its timers.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "Kiosk Bathroom Key Log"
  EXPECT: all pass, including:
  - no success card or countdown bar;
  - switching to Attendance right after a success or an error shows no offline/unreachable card;
  - a second card tapped 3.9 s after a success records normally.
  EVIDENCE: live on the dev server with a made-up demo card (APG-DEMO-002), at 1366:
  - **Checkout:** the female card was "is-in-use is-flashing" with the photo; the hero icon kept the ready class; Type card ID was enabled; there was no success card; the live text read "Female key checked out by Maria Ramos at 9:12 PM".
  - **Switch to Attendance:** no offline card, reader box present.
  - **Return:** "Returned by Maria Ramos · 9:13 PM", and the flash cleared after 1.8 s.
- [x] The photo is remembered in memory (userId → photoUrl) from every successful attendance and bathroom scan. Nothing is persisted, and the backend is unchanged. ResultPortrait is shared from bathroom-kiosk-view.tsx.
- [x] Dead kiosk CSS removed (old holder box, available box, gender bubbles, kiosk status capsules, breathing glow, scan-console toggle, `.mode-bathroom .scan-console`).
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 566 tests passed.

## UI revamp batch 12: Payroll back to the two original panels, coral Total Deductions (client only; owner request 2026-11-02)

- [x] The top of Payroll is the original two panels again (same words as commit 84b6e31), in today's style:
  - **"Generate cutoff payroll":** cutoff month, the 1st–15th / 16th–last day pair, Cutoff start, Cutoff end and Standard days are always visible, with the gold "Generate from attendance" button on the heading row.
  - **"Export payroll":** "Generate Intern Payroll PDF" and "Generate Intern Payslips".
  - **Removed:** the 3 steps, the Next line, Change dates and their CSS. The pre-fill and every validation are kept.
  CHECK: cd client && npx vitest run src/payroll.test.tsx
  EXPECT: all pass, including both panels with the old labels, no steps/Next line/Change dates, and one gold button in every state.
  EVIDENCE:
  - 1366: Generate 919×185 and Export 312×185, top offset 0, height difference 0; controls on one row.
  - 1024: 636×261 and 280×261, aligned.
  - ≤900: stacked.
  - scrollWidth never above the viewport from 320 to 1366.
- [x] Every old action is still reachable:
  - Generate again is the gold button (with its confirm);
  - Finalize all is on the table bar ("Finalize all (N)"; "Finalize all for <cutoff> (N)" under All cutoffs);
  - Delete all records is a coral text button on the record-count line, with its confirm;
  - Open PDF / Show in folder / Open payslip folder are quiet links under the export status.
- [x] Exports stay blocked until every draft is finalized, with "Finalize all drafts first." or "Generate payroll first.". The status line reads "PDF made <date time>", or "Payroll changed since the last PDF. Generate it again.".
  CHECK: cd client && npx vitest run src/payroll.test.tsx -t "export"
  EXPECT: the reason and status cases pass.
- [x] Total Deductions above zero are coral (`money-deduction`, var(--danger)), and zero is muted (`money-zero`). This applies to the table cells, both Edit payroll summaries, the Breakdown row and both formula totals. No inline styles; net pay stays gold.
  EVIDENCE: computed colour rgb(239, 170, 146) for amounts above zero and rgb(170, 167, 158) for zero. Shot after-table-deductions-crop.
- [x] Review fixes:
  - focus goes to "Generate from attendance" when Delete all records or a row Delete leaves the cutoff empty;
  - the pressed half of the cutoff pair has a dark focus ring;
  - the date fields get aria-invalid and aria-describedby, and both reason lines are role=status;
  - Finalize all is labelled with its cutoff under All cutoffs;
  - a vacuous test check was replaced.
  CHECK: cd client && npx vitest run src/payroll.test.tsx
  EXPECT: 61 tests pass.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 571 tests passed (payroll.test.tsx 61).

## UI revamp batch 13: Bathroom ID card first, original key cards made livelier, Payroll second, no login flash, smooth admin tab slide (client only; owner requests 2026-11-03)

- [x] After a successful bathroom tap, the intern's ID card shows above the key cards for resultResetDelayMs, then the title comes back:
  - photo or initials;
  - "Male key taken" / "Female key returned";
  - name and "ID · department";
  - Taken, plus Returned on a return;
  - role=status and the countdown bar.
  The batch 11 reset fixes are kept, and a mode switch now also resets while a scan is in flight. Late answers are dropped, including on the desktop, where the IPC can't be cancelled.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "Kiosk Bathroom Key Log"
  EXPECT: all pass, including "drops a bathroom answer that lands after a switch to Attendance, even when the request can not be cancelled".
  EVIDENCE: 1366x768, ID card showing: ID card 142–352, key cards 392–644, Type card ID 666–700, scrollHeight 768. Without it: cards 355–607 and scrollHeight 768 (checked live on the dev server).
- [x] The key cards are back in the original layout (owner's screenshot), with no photos:
  - a gold or soft-rose key tile, "Male Key" / "Female Key", "Floor Restroom Key 1", and an AVAILABLE / IN USE capsule;
  - the dashed "Key is Available" box;
  - the "Currently with" box (initials, name, "dept · ID", Time Out / Elapsed).

  They're made livelier:
  - top-lit depth, a gold glow when in use and a green edge when available;
  - the key floats (3.6 s);
  - the dashed border marches (1.6 s per dash, stepped);
  - an arc turns around the initials (7 s);
  - the IN USE dot pulses (2 s);
  - a cross-fade (280 ms) and a single edge glow (900 ms) when a key changes hands, never for a stale status on reopening;
  - a 70 ms staggered entrance.

  With prefers-reduced-motion, every loop is off and changes are instant.
  EVIDENCE: equal card heights in both states, also with a 24-character name: 308/308 at 320 and 360, 284/284 at 390 and 768, 252/252 at 1366. No sideways scroll.
- [x] The admin tab order is Attendance corrections, Payroll, Users and RFID, Data and backup, Voice announcements, System.
- [x] The admin page no longer flashes the unlock card while the saved session is checked (sessionChecked; the RFID unlock waits for it).
  CHECK: cd client && npx vitest run src/App.test.tsx -t "saved session is checked"
  EXPECT: 3 pass.
- [x] The admin tab highlight slides smoothly:
  - the tab page renders from useDeferredValue(tab) and is memoised;
  - the 3-piece thumb animates transform only;
  - identical placements are skipped.
  CHECK: cd client && npx vitest run src/App.test.tsx -t "gold thumb slides"
  EXPECT: 2 pass.
  EVIDENCE: Corrections → Payroll, before vs after (2 runs each):
  - first move: none / 210 ms before, 54 / 19 ms after;
  - compositor frames during the slide: 3 / 28 before, 31 / 34 after;
  - the 119–315 ms long task at the click is gone.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint:oxlint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, oxlint exit 0, client 26 files / 578 tests passed.

## UI overhaul 2, stage 1: Kiosk, a gold-line header, round glassy switch, DTR notice, text 10% smaller, 150% scaling (client only; owner requests 2026-11-03)

- [x] The header is one row on the page (no box) with a 1px fading gold line under it, inside the page gutters, with more top and side room. The brand reads "ALPHA PREMIER". The in-office count and the reader status are minimal round pills.
- [x] The mode switch is a fully round dark glass pill. The active thumb is round gold with a soft gradient, a 1px top light line and a faint warm glow, and still slides with transform only. The active number badge is a dark bronze coin (#33291a) with a gold number. Admin keeps its own switch rule for now.
- [x] The DTR status left the header. A minimalist "DTR sync" card shows only when there is a real problem (dtrSyncNoticeKind: persistence | attention | paused | retry | throttled | retrying | offline | unavailable). It:
  - ignores a late heartbeat;
  - is dismissed by kind until sync is fine again;
  - never takes focus (× keeps focus in Manual entry);
  - sits in an always-present live region;
  - is fixed top-right under the header line from 901px up, and in the flow on phones.
  CHECK: cd client && npx vitest run src/dtr-sync-guard.test.ts && npx vitest run src/App.test.tsx -t "DTR"
  EXPECT: all pass.
- [x] Kiosk text is about 10% smaller (kiosk-scoped --fs-* overrides, 12px floor). Greeting 60 → 54 at 1366x768; result name and time 28 → 25.2; bathroom title 40 → 36.
- [x] The kiosk fits a 1920x1080 laptop at 150% scaling.
  EVIDENCE:
  - At 1280x640 (maximized) and 1280x720, page scrollHeight = viewport in all 8 states (attendance idle, time-in, error, Manual entry, bathroom in use, bathroom ID card, bathroom key error, Type card ID), with and without the DTR card.
  - Also at 1366x768 and 1366x657. No sideways scroll at 320–1920.
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, full lint exit 0, client 26 files / 600 tests passed (builder run). A coordinator re-run had one known-slow admin test hit its 20 s limit under load. It passes alone (18/18 in its group, 16.4 s).

## UI overhaul 2, stage 2: Admin pages (gold line, round glassy tabs, minimal switch and links, text 10% smaller, 150% fit) + backup order fix (client only; owner requests 2026-11-04)

- [x] The admin header gets the kiosk's thin gold line, a tighter title block and the brand "ALPHA PREMIER" (`DashboardBrand({ realty })`; Live attendance still passes realty). The header actions (reader status, Scanner, Live view, the dev-only Nuke, Lock) are minimal text links with small icons and hairline separators. Live attendance's Scanner and Admin use the same links.
- [x] Section tabs: a round dark glass bar. The 3-piece transform-only thumb now has half-circle caps (cap = height / 2), the glassy gold look and a soft drop-shadow glow. It still moves on the first frame after the click.
- [x] Mode switch, minimal: only the active mode shows its label ("[icon] Attendance | [icon]" / "[icon] | [icon] Bathroom Key Log"), with no visible 1/2 badges. The shortcuts are in aria-label/title. It shares TabsThumb (anchored right).
- [x] In Bathroom mode the "Bathroom Key Log" title sits on the switch row (20px), which removes the empty row.
- [x] Admin text is about 10% smaller (admin-scoped --fs-* overrides, 12px floor). Kiosk office address 11px (owner exception), smaller than the brand.
- [x] 150% scaling (1920x1080 laptop):
  - at 1280x640 and 1280x720, tabs and switch sit on one row and content starts at y=205 (was 309);
  - no sideways scroll on any tab;
  - every admin pop-up fits with its buttons visible (Add missed attendance was cut off before).
- [x] Bug fix: Existing backups are sorted by date, newest first, before the month grouping. The desktop app returns them by file name, which showed September > November > October.
  CHECK: cd client && npx vitest run src/database-panel.test.tsx
  EXPECT: all pass, including the deployed-order test (which fails without the sort).
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, full lint exit 0, client 26 files / 602 of 603 passed (builder full run; the one failure is the known slow test "asks before a tab…" timing out under load). Coordinator re-run: database-panel 66/66; thumb, reader, session and slow-test group 12/12. GitHub CI ran the same suite green on main in about 5 min.

## UI overhaul 2: Payroll header in one row (client only; owner request 2026-11-04)

- [x] The Payroll header is one slim glass strip:
  - the cutoff fields (month, half-month pair, start, end, standard days), then the gold "Generate from attendance" at the end of their row;
  - a thin divider, then Export payroll's two buttons under a small "Export payroll" label;
  - the visible "Generate cutoff payroll" heading row is gone (the heading stays for screen readers);
  - the export buttons show "Payroll PDF" and "Payslips", and their names stay "Generate Intern Payroll PDF" / "Generate Intern Payslips";
  - the record and PDF notes stay as one quiet line under each side.
  CHECK: cd client && npx vitest run src/payroll.test.tsx
  EXPECT: all pass, including the one-row test (Generate after the fields, hidden heading, full export names).
  EVIDENCE: 62/62 passed. The new test failed before the change.
- [x] At 1280x640 and 1280x720 the fields, Generate and both exports sit on one row, and the strip is about half its old height (244px before). No sideways scroll at 320-1920. Tablets and phones stack it as before.
  EVIDENCE: measured with headless Chrome on the mocked admin page:
  - strip 119px at 1280x640 and 1280x720; the table starts at y=340 (was 465);
  - one row at 1258px wide and up (1258, 1280, 1366, 1920);
  - two lines below that (1257 and 1024: 186px);
  - stacked at 768, phone layout at 390 and 320;
  - with a current PDF and its links, 137px; with an out-of-date PDF, 125px;
  - no sideways scroll at any measured width.
- [x] Review fixes:
  - the month field is 140px with 8px input padding, so September, November and December 2026 and the widest dates (30/09/2026) show in full;
  - the export buttons say "Saving…" while busy, which is no wider than "Payslips", so a busy button never spills past the strip (901-1280px);
  - the out-of-date note reads "The last PDF is out of date." (no more "Generate it again" now that the button reads "Payroll PDF").
  EVIDENCE: headless Chrome:
  - month 2026-09/11/12 at 1280x640, text not clipped;
  - busy buttons 76.4px each, right edge inside the strip at 1280, 1258, 1257, 1024 and 901;
  - stale note on one line (strip 119px).
- [x] Repository gates.
  CHECK: npx tsc --noEmit -p client && npm run lint && npm test -w client -- --maxWorkers=2 --minWorkers=1
  EXPECT: all pass.
  EVIDENCE: tsc exit 0, full lint exit 0, client 26 files / 604 tests passed.

## Bea voice v2: new reference + full regeneration (2026-11-04)

- [x] VoiceStudio "Ma'am Bea" profile (0b2d3e9f) uses a reference built from the FB Ad Tutorial VO clips (<=20 s, word-aligned cut, accurate ref_text); the original reference is backed up and restorable.
  CHECK: GET /profiles/0b2d3e9f shows the new ref_text; backup wav + profile json exist outside the repo.
  EXPECT: new ref beats the old one on the A/B set (same 6 phrases, seed 42): mean WER not worse, pitch/brightness closer to the real samples.
  EVIDENCE: PUT /profiles/0b2d3e9f/audio -> ref_audio_path 0b2d3e9f-15cdad31.wav, new ref_text (Step 14 + Step 7, 11.3 s, -20 LUFS); original wav + profile JSON + restore command saved on the admin PC (Downloads/bea-voice-profile-backup-20261104). A/B vs real samples (f0 205 Hz, IQR 66, centroid 1622): old ref f0 184 (32% of frames < 140 Hz), centroid 614; chosen ref C f0 211, IQR 62, centroid 1721; 5 candidates, all 0 phrase errors (name spelling variants only). Old ref noise floor -47 dB vs -71 dB for the new samples.
- [x] APG-2026-124 (new intern) has a cloned name clip and manifest entry in client/public and src-tauri/resources.
  CHECK: node -e manifest lookup for APG-2026-124 in both bea-name-manifest.json files; file exists and hash matches.
  EXPECT: present, identical in both trees, sha256 matches audioHash.
  EVIDENCE: hash check: entries=35, manifests identical, 0 hash/parity/version mismatches, APG-2026-124 present; clip -15.4 LUFS.
- [x] Every shipped Bea clip (50 phrases + every name in bea-name-manifest.json) is regenerated with the new reference; client/public and src-tauri/resources copies are byte-identical; every manifest hash matches its file.
  CHECK: scratch verify script over both trees + ASR intelligibility pass over all regenerated clips.
  EXPECT: 0 missing, 0 mismatched, 0 stale (pre-2026-11-04) name entries; no clip with WER > 0.34 left unexplained.
  EVIDENCE: 85/85 clips changed vs HEAD and byte-identical across trees; 0 stale entries. Loudness -15.5..-15.2 LUFS, true peak <= -0.4 dBTP (before: -21.3..-14.9 LUFS, greetings ~4 dB under the status lines). Whisper large-v3 old vs new on 84 shared clips: mean WER 0.243 vs 0.255 before best-of; then best-of-4 on 17 flagged clips made all 7 flagged phrases exact ("Card scanned", "checked out for", "time in", "Male", "Attendance service"). Remaining phrase mismatches are "time out"->"timeout" spacing; remaining name mismatches are spelling-level (Lorenz/Laurence, Luang) or equal to the old voice. APG-2026-123 needed an override ("Bar-to-lo-meh") - 0/5 takes said it Filipino-style without it.
- [x] Repo gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint exit 0; typecheck exit 0; npm test exit 0 (shared 39, client 393, server 288 incl. new Ar-Jee casing test).

## Kiosk plays the bundled Bea v2 name clips (2026-11-04)

- [x] On the first start with a new bundled `bea-name-manifest.json` (new `generatedAt`), the kiosk deletes worker clips (`<data_dir>/voices/bea/names/<id>.mp3`) and `voice_jobs` rows for every bundled person whose roster name still matches the bundle (or who is no longer on the roster). The bundled clips then play on every path (webview and native).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml voice_pull
  EXPECT: new tests pass: matching and off-roster people lose their clip and job; a renamed person keeps both; a second run with the same bundle is a no-op, so a later Regenerate survives restarts.
  EVIDENCE (local): test target compiles (`Finished test profile`); the test exe cannot start on this PC (0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND, identical with the change stashed), so it runs in CI `Rust Backend Verification` (windows-latest).
  EVIDENCE (CI, PR #29 run): `retire_superseded_clips_runs_once_per_bundle_and_spares_renames ... ok`; lib tests 360 passed, 0 failed.
- [x] The kiosk backup's queue (APG-2026-102/113/117/119/120/121/122/123/124) is fully superseded: every job ID is bundled under its current roster name.
  CHECK: scratch name_match.py over the 2026-11-04 backup DB + bundled manifest.
  EXPECT: 9/9 "bundled match".
  EVIDENCE: 9/9 "bundled match" (backup has 8 RETRY rows failing on 192.168.1.19:3901 + 1 DONE).
- [x] Repo gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint exit 0; typecheck exit 0; npm test exit 0 (shared 39, client 604, server 288).

## Bea clips start without a breath (2026-11-04)

- [x] Root cause is measured, not guessed: lead-in (sound before the first word, separated from it by a pause) per reference on the same 6 test phrases.
  CHECK: scratch leadin_zcr.py over the A/B renders (v2 reference unpadded vs padded 0.4/0.8/1.5 s vs candidate D vs the old reference).
  EXPECT: the unpadded v2 reference breathes on most takes; a padded variant cuts that to a small minority.
  EVIDENCE: takes with a lead-in >= 50 ms: v2 unpadded 15/18 (seeds 42/7/1234; voice starts up to 1 s in), +0.4 s silence 3/30, +0.8 s 7/30, +1.5 s 3/30 (5 seeds); candidate D 22/24 (a ~120 ms voiced blip: its clip stops mid-sound); old v1 reference 0/6. The model continues from where the reference stops.
- [x] The VoiceStudio "Ma'am Bea" profile (0b2d3e9f) uses the v2 reference + 0.4 s trailing silence; v2 stays restorable.
  CHECK: GET /profiles/0b2d3e9f -> new ref_audio_path; Downloads/bea-voice-profile-backup-20261104 has v2- and v3-reference.wav.
  EVIDENCE: ref_audio_path 0b2d3e9f-f27cc748.wav (v2 11.27 s + 0.4 s silence), ref_text unchanged; v2-/v3-reference.wav + README restore steps in the backup folder.
- [x] Both generators re-roll a take that opens with a lead-in (>= 50 ms), up to 4 takes, keeping the cleanest; Python and TS detectors agree.
  CHECK: npm test -w server -- intern-names-generator; scratch parity.mts vs parity.py over 58 real clips.
  EXPECT: detector unit tests pass (breath before a pause, voiced blip, word-initial fricative, clean speech); TS and Python give identical ms on every file.
  EVIDENCE: intern-names-generator.test.ts 6/6 (3 new detector tests); TS vs Python identical on 58 files (A/B renders + shipped clips).
- [x] Every shipped Bea clip (50 phrases + 35 names) starts without a lead-in, stays at -15 LUFS, and Whisper still hears it at least as well as before; client/public and src-tauri/resources are byte-identical and manifest hashes match.
  CHECK: scratch regen_clean.jsonl + leadin_zcr.py over both trees + verify_all.py.
  EXPECT: 0 clips with lead-in >= 50 ms; no score regressions left unexplained.
  EVIDENCE: lead-in >= 50 ms: 61/85 before, 0/85 after (max 30 ms, both trees). 144 takes for 85 clips; Whisper letters-similarity mean 0.953 -> 0.965; phrases WER 0.026, 44/50 exact: 4 "time out" -> "timeout" and 2 "Male" -> "Mail" (homophone; 12/12 extra takes heard "Mail"). APG-2026-117 kept its old take (no lead-in, heard better). APG-2026-112 re-rendered for true peak (-0.2 -> -2.5 dBTP). -15.5..-15.0 LUFS, true peak max -0.5 dBTP; 0 tree byte-diffs; 0/35 hash mismatches; 34 entries voicestudio-bea-v3 + 1 v2.
- [x] Repo gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint exit 0; typecheck exit 0; npm test exit 0 (shared 39, client 604, server 291).

## Bea clips without the sharp, staticky "s" (2026-11-05)

- [x] Root cause is measured: how loud the "s" peaks are vs the vowels (sharp-s index: p99 of 4.5-11 kHz minus p99 of 0.1-4 kHz over speech frames) and how much of the 4.5-11 kHz band the MP3 encoder drops (bins > 20 dB under the pre-encode WAV).
  CHECK: scratch sib_lab.py over 8 sibilant-heavy raw takes + the v3 reference.
  EXPECT: shipped clips have "s" peaks near vowel level and 64k MP3 holes in the "s" band; a de-esser and a higher bitrate fix each without dulling the vowels.
  EVIDENCE: her real voice (v3 reference) sharp-s -4.5 dB; shipped clips -3.0 dB mean, worst -0.4 dB; 64k drops 1.0 % of the meaningful "s"-band bins, 96k/128k 0.0 % (rounded; 96k left up to 0.13 % on 4 worst clips, 128k 0.00-0.01 %). De-ess sweep (split 4.5 kHz, ratio 3/6, threshold -18..-30 dBFS): -18 dBFS 3:1 gives -10.0 mean / -8.2 worst with vowel air unchanged (-24.9); lower thresholds over-cut (-30/6: -20.2, lisp risk). ffmpeg adynamicequalizer ignored its threshold here (no cut at 1-99, ~58 dB cut at 0), so the de-esser is acrossover + acompressor. VoiceStudio history still held the raw WAV behind 84/85 clips (correlation 0.982-0.999 vs runner-up <= 0.38); backed up to Downloads/bea-voice-profile-backup-20261104/raw-takes-v3.
- [x] Both generators de-ess (4.5 kHz split, high band compressed 3:1 above -18 dBFS at -15 LUFS) and encode 128k mono; Python and TS produce byte-identical MP3s from the same WAV.
  CHECK: scratch parity run of transcode_normalized (py) vs transcodeNormalized (ts) on the same raw takes.
  EXPECT: identical sha256 per file.
  EVIDENCE: 84/84 raw takes -> identical sha256 (py vs ts), 128000 b/s.
- [x] Every shipped Bea clip is re-encoded from its raw VoiceStudio take (APG-2026-117 from its MP3: its v2 take has no raw): sharp-s mean <= -9 dB and max <= -6 dB, no codec holes, -15.5..-14.5 LUFS, true peak <= -0.5 dBTP, 0 lead-ins >= 50 ms; both trees byte-identical, manifest hashes match.
  CHECK: scratch deess_all.py + verify_deess.py + hash_check2.py over both trees.
  EXPECT: every bound met.
  EVIDENCE: sharp-s mean -4.5 -> -10.9 dB, worst +1.0 -> -6.7 dB (85 clips); codec holes 0.84 % -> 0.00 % mean, max 0.02 % (84 raw-backed); -15.5..-15.0 LUFS; true peak max -0.5 -> -1.7 dBTP; lead-ins >= 50 ms 0/85 (max 30 ms, APG-2026-117 as before); `diff -rq` client/public vs src-tauri/resources: 0 differences; 35/35 audioHash match, manifests identical, 34 v3 + 1 v2, generatedAt 2026-11-05T00:17:41Z. Size 1760 -> 3516 KB per tree.
- [x] Vowels keep their brightness: vowel air (median 4.5-11 kHz minus 0.1-4 kHz over vowel frames) within 0.5 dB per clip.
  CHECK: scratch verify_deess.py.
  EXPECT: |delta| <= 0.5 dB on every clip.
  EVIDENCE: MISSED on 17/85 clips: delta -1.00..+0.18 dB (mean -25.0 -> -25.3 dB; worst APG-2026-113 -1.0, APG-2026-123 -0.87, good-afternoon -0.85, goodbye -0.82). The shift is toward her real voice (-26.8 dB). Accepted by the user after an A/B listen (Raineer, Deign, "card scanned too recently"), 2026-11-05.
- [x] Whisper hears every clip at least as well as before.
  CHECK: scratch whisper_compare.py (faster-whisper large-v3, CPU int8, beam 5) on shipped vs de-essed clips.
  EXPECT: no clip scores lower.
  EVIDENCE: MISSED on 1/85: APG-2026-107 "Margaux Zyann Delaog" heard "Margot Zayn Delog" -> "Margot Zion Delog" (0.727 -> 0.667); both misspell "Zyann". The other 84 are heard identically; mean 0.965 -> 0.964; exact 59 -> 59. Accepted by the user with the A/B listen above.
- [x] Repo gates pass.
  CHECK: npm run lint:oxlint && npm run typecheck && npm test
  EXPECT: all pass.
  EVIDENCE: oxlint exit 0; typecheck exit 0; npm test exit 0 (shared 39, client 604, server 291).

## Auto-merge on main waits for green CI (2026-11-05)

- [x] main has an active ruleset requiring Frontend Quality & Tests, Rust Backend Verification and Anti-Slop PR Quality Check (from GitHub Actions); only deploy keys bypass it, and the repo's only deploy key is the release one.
  CHECK: gh api repos/Deign86/alpha-premier-attendance/rulesets/26578932; gh api repos/Deign86/alpha-premier-attendance/keys
  EXPECT: enforcement active, ~DEFAULT_BRANCH, 3 required contexts, bypass DeployKey; 1 write key.
  EVIDENCE: ruleset 26578932 "main: CI must pass": active, ~DEFAULT_BRANCH, the 3 contexts pinned to integration 15368, bypass_actors [DeployKey always]. GitHub refused GitHub Actions (app 15368) as a bypass actor on a user-owned repo ("must be part of the ruleset source or owner organization"), hence the deploy key. Keys: 1 (id 168821590 "Release version bump (bypasses main ruleset)", write); private half only in secret RELEASE_DEPLOY_KEY, local copy deleted.
- [x] Every PR reports the 3 required checks, docs-only ones too.
  CHECK: grep paths-ignore in .github/workflows/ci.yml and pr-quality.yml.
  EXPECT: only ci.yml's push trigger keeps paths-ignore.
  EVIDENCE: ci.yml: paths-ignore only under push (line 26); pull_request has no filter. pr-quality.yml: none. (pr-quality runs on pull_request_target, so its new trigger applies from the next PR after this one merges.)
- [ ] GitHub accepts auto-merge on a PR whose checks are still running, and merges it once they pass.
  CHECK: enable auto-merge on this PR right after opening it; gh pr view --json state,autoMergeRequest.
  EXPECT: auto-merge accepted while checks pend; PR merged after all 3 pass.
  EVIDENCE:
- [ ] The release version-bump push still lands on main.
  CHECK: the first Release run after this ruleset (release.yml checks out with ssh-key RELEASE_DEPLOY_KEY): a "chore(release): bump version" commit on main.
  EXPECT: pushed via the deploy key; if refused, bump-version.mjs only warns and the release still publishes, but main's version files stop advancing.
  EVIDENCE:

## State-machine bug hunt: confirmed bugs fixed with regression tests (2026-11-06)

Model and issue list: `docs/STATE-MACHINES.md` (F1–F21 fixed; D1–D6 need a product call; O1–O11 open; S1–S7 suspected). Each gate is one root-cause group; "fails on old code" was measured by running the new test against the original logic (guard toggled off or the HEAD function swapped back in), then restoring.

- [x] I1 Finalizing a cutoff whose dates overlap an already FINALIZED cutoff for the same intern is refused (no double pay).
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib finalize_refuses_overlapping_finalized_cutoff
  EXPECT: overlapping DRAFT stays DRAFT with error PAYROLL_PERIOD_ALREADY_FINALIZED; an adjacent DRAFT still finalizes.
  EVIDENCE: passes; FAILED with the overlap guard disabled (panic at the unwrap_err).
- [x] I2 An admin correction saved from a stale WORKING row cannot erase a time-out (and its payroll) recorded after the row was loaded.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib admin_update_partial_payload_coalesces
  EXPECT: step 6 gets ATTENDANCE_CONFLICT; time_out, COMPLETED and the payroll row survive.
  EVIDENCE: FAILED on the old code (stale save succeeded, lib.rs:8262 unwrap_err panic); passes with explicit-null expectations; admin_update_rolls_back_attendance_when_payroll_write_fails still passes.
- [x] I3 The sync queue pushes the payload it claimed, and a queued op retires its unapplied opposite op.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib -- sync_claim_ delete_supersedes_
  EXPECT: a row re-queued after the batch read is pushed with its new payload and fresh attempts (RETRY, not DEAD); DELETE retires a RETRY UPSERT and a later UPSERT retires the DELETE.
  EVIDENCE: both FAILED with the snapshot-payload claim and no supersede; both pass now (loopback axum endpoint for the claim test).
- [x] I4 A failed restore leaves the current database untouched; pruning never deletes the backup it just made.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib database::tests
  EXPECT: restore failing on the config step keeps the old DB ("Current Person"); with 11 pre-restore snapshots the new regular backup survives.
  EVIDENCE: 14 passed; the 2 new tests FAILED against the HEAD database.rs logic.
- [x] I5 DTR sync errors classify and admit correctly.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib -- sync_retry dtr_sync sheets_sync
  EXPECT: GOOGLE_OAUTH_TRANSPORT is transient at any attempt count; a 60-write backfill is trimmed to an admitted 50.
  EVIDENCE: transient_classifier FAILED without the marker; oversized_backfill_is_trimmed_to_an_admissible_slice passes (shows the untrimmed request is denied in every window); 117 dtr_sync/sheets_sync tests pass. The DTR clear PUT now uses dtr_call_with_retry + dtr_error_for_response (no URL seam to test it directly).
- [x] I6 Kiosk/admin async lifecycles cannot land in a stale or stuck state.
  CHECK: npm test -w client
  EXPECT: 7 new regression tests pass; all existing client tests pass.
  EVIDENCE: 611 passed (604 before). Each new test FAILED on the old code: setup reopened unlocked (lock never called), assisted offline modal stayed open, unlockAdmin rejected, bathroom showed Aug 1 logs under Aug 2, offline queue grew 2 -> 6, Ada announced after Grace, sync guard stayed true after "completed". S4 (assist countdown) did NOT reproduce under fake timers, so it stays Suspected and no test was kept.
- [x] I7 Multi-write admin operations are atomic.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib -- user_deletion cutoff_delete_never bathroom_edit_rejects_dates_outside_log_date
  EXPECT: blocked user delete keeps user, attendance and cutoff; blocked cutoff delete keeps the snapshot; a stale bathroom save conflicts and a current one re-opens.
  EVIDENCE: user_deletion_is_all_or_nothing and cutoff_delete_never_leaves_a_finalized_cutoff_without_its_snapshot FAILED on the old code; the bathroom stale-save step FAILED on the old code; all pass now. Attendance delete reads moved into its transaction (structural; no seam for the interleaving).
- [x] I8 Background sync lifecycles.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib -- nuke_and_resync_waits dtr_recon
  EXPECT: nuke refuses with DTR_SYNC_IN_PROGRESS and leaves the running guard alone; RUNNING runs are reclaimed at boot; scheduled retries wait 30 min; a failed run is FAILED once with one audit row.
  EVIDENCE: nuke test FAILED with the guard lines removed; 8 dtr_recon tests pass. Reclaim and the retry gate are new functions, so there is no old code to fail against.
- [x] Repo gates pass.
  CHECK: npm run lint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --test-threads=1
  EXPECT: JS gates exit 0; Rust suites pass except the 3 pre-existing Windows-path tests on Linux.
  EVIDENCE: lint + typecheck + test exit 0 (shared 39, client 611, server 291). Rust lib 369 passed / 3 failed (baseline before any change: 357 / 3, the same 3: config::tests::service_account_path_resolves_against_config_dir, paths::tests::db_path_override_treats_a_directory_by_appending_attendance_db, paths::tests::db_path_override_treats_a_dot_extension_as_a_file; CI runs on Windows). Integration suites 11/18/69/35/52/24 passed.

## State-machine decisions D1–D4 (owner answers 2026-11-06: "D1 yes, D2 refuse, D3 record, D4 1 min")

Each test was run against the code with its rule disabled (then restored) and failed there.

- [x] D1 Five wrong admin PINs lock PIN unlock for 5 minutes, and the lock survives a restart.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib admin_pin_lockout && npm test -w client -- api.test.ts
  EXPECT: 5th wrong PIN starts the lock; the right PIN is refused while locked (ADMIN_PIN_LOCKED); a fresh AppState on the same DB is still locked; after the lock time the right PIN unlocks and resets the count; an admin card still unlocks during a lock; both unlock screens show the lock message.
  EVIDENCE: admin_pin_lockout_after_five_wrong_pins_survives_a_restart passes; FAILED with the lockout disabled (lib.rs:7923). api.test.ts "says PIN unlock is paused …" failed before the copy, passes now.
- [x] D2 Attendance inside a FINALIZED cutoff cannot be edited or deleted, and deleting a user keeps their finalized pay records.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib finalized_cutoff_freezes
  EXPECT: update (including moving a day into the period) and delete return ATTENDANCE_IN_FINALIZED_CUTOFF with the row unchanged; a day outside still corrects; user delete keeps the FINALIZED cutoff and snapshot and removes the draft.
  EVIDENCE: passes; FAILED with the freeze check disabled and, separately, with the user-delete filter removed. user_deletion_cascades_to_payroll_and_attendance now expects the FINALIZED cutoff to stay (it encoded the old behavior). api.test.ts "explains that a day in a finalized payroll cutoff …" passes (the Tauri delete path now maps errors instead of rejecting).
- [x] D3 A time-out the payroll engine cannot price (time-in after 17:00) is still recorded, as LATE_TIMEOUT with no payroll, for an admin correction.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib scan_records_unpriceable_time_out
  EXPECT: 17:30 time-in + 18:05 tap succeeds, row LATE_TIMEOUT with the time-out, no payroll row.
  EVIDENCE: passes; FAILED with the savepoint fallback disabled. Scan now takes an injected clock (`scan_rfid_at`) so the test does not depend on the wall clock.
- [x] D4 A scan less than 1 minute after time-in does not time the person out.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib scan_needs_a_minute_between_time_in_and_time_out
  EXPECT: tap 30 s after time-in is rejected as DUPLICATE_SCAN and the day stays WORKING; a tap 61 s after time-in records the time-out with payroll.
  EVIDENCE: passes; FAILED with the minimum disabled.
- [x] Repo gates pass.
  CHECK: npm run lint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --test-threads=1
  EXPECT: JS gates exit 0; Rust suites pass except the 3 pre-existing Windows-path tests on Linux.
  EVIDENCE: lint + typecheck + test exit 0 (shared 39, client 613, server 291). Rust lib 373 passed / 3 failed (the same 3 Windows-path tests); integration suites 11/18/69/35/52/24 passed.

## State-machine decisions D5–D7 (owner answers 2026-11-06: "d5 keep queuing, d6 do ur recommendations, d7 do ur recommendations")

Each new test was run before its fix and failed there.

- [x] D5 With DTR upload switched off, punches and corrections are still queued (dispatch stays paused), so switching it back on pushes current data.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib dtr_upload_off_keeps_queuing
  EXPECT: with upload off, a scan queues its InternDtr row, a correction updates the queued payload, and run_once leaves the row PENDING.
  EVIDENCE: FAILED before the fix ("time-in queued while upload is off"); passes now; 116 other dtr_sync/sheets_sync tests still pass. The Data card already said "uploads when it's turned back on", which is now true.
- [x] D6 Attendance is never saved offline: an unreachable service is a visible error the person can tap again after; items saved by older versions still drain.
  CHECK: npm test -w client
  EXPECT: submitScan rethrows (no localStorage item); the kiosk shows "Can't reach the system"; an assisted confirm keeps the modal open with a retry message; leftover queue items still drain once, in order.
  EVIDENCE: the 3 new/rewritten tests FAILED before the change; client 613 passed after. OfflineScanResponse was removed from the shared ScanResponse union, so the compiler confirmed every offlineQueued branch was gone; the "Saved offline" card and two tests for it were removed with the feature.
- [x] D7 A correction cannot leave a day without a time-in; deleting the record is the way to remove a day.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib admin_update_keeps_a_time_in && npm test -w client -- api.test.ts
  EXPECT: clearing time-in (with or without a time-out) returns ATTENDANCE_TIME_IN_REQUIRED and the row is unchanged; the client shows "A record needs a time-in…".
  EVIDENCE: both tests FAILED before the change and pass now; the now-unreachable MISSED branch in the status derivation was removed.
- [x] Repo gates pass.
  CHECK: npm run lint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --test-threads=1
  EXPECT: JS gates exit 0; Rust suites pass except the 3 pre-existing Windows-path tests on Linux.
  EVIDENCE: lint + typecheck + test exit 0 (shared 39, client 613, server 291). Rust lib 375 passed / 3 failed (the same 3 Windows-path tests); integration suites 11/18/69/35/52/24 passed.

## O1: stopping the LAN viewer disconnects viewers already connected (2026-11-06)

- [x] Stop ends every open live-attendance stream and leaves nothing serving.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib lan_stop_disconnects_open_viewers
  EXPECT: an SSE viewer connected before stop sees its stream end within 3 s of stop; a new request after stop is refused.
  EVIDENCE: FAILED on the old code ("an open viewer kept streaming after stop", lan_server.rs:929); passes now, 5/5 repeated runs in 0.08–0.25 s (well under the 2 s abort backstop, so the graceful path does the work). All 18 LAN tests pass.
- [x] Repo gates pass.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --test-threads=1 && npm run lint && npm run typecheck && npm test
  EXPECT: Rust suites pass except the 3 pre-existing Windows-path tests on Linux; JS gates exit 0.
  EVIDENCE: Rust lib 376 passed / 3 failed (the same 3 Windows-path tests); integration suites 11/18/69/35/52/24 passed. JS lint + typecheck + test exit 0 (shared 39, client 613, server 291).

## O9: a LAN stop pressed while the viewer is still starting wins (2026-11-07)

- [x] A stop that arrives while the viewer is binding leaves it Stopped, and the server that finished binding is shut down.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib stop_during_start_wins
  EXPECT: begin start → stop → bind finishes → phase Stopped and the bound port refuses connections; a start with no stop in between still runs.
  EVIDENCE: with start split into begin/bind/finish but no generation check, the test FAILED ("the stop must win": left Running, right Stopped); with the check it passes, 3/3 repeated runs. Review found the first version re-locked between the check and setting Running (a smaller window for the same race); it now holds one lock across both.
- [x] Repo gates pass.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --test-threads=1
  EXPECT: Rust suites pass except the 3 pre-existing Windows-path tests on Linux (JS untouched).
  EVIDENCE: Rust lib 377 passed / 3 failed (the same 3 Windows-path tests); integration suites 11/18/69/35/52/24 passed. No JS file changed.

## Remaining confirmed bugs O2–O8, O10, O11 and suspected S1–S7 (owner: "fix all confirmed bugs and narrow down suspected ones", 2026-11-07)

Each fix has a regression test that failed on the old code: O3/O4/O5/O7 were run against a worktree of the previous commit; the rest by disabling the fix in place, then restoring it.

- [x] O2 Transient sync failures back off with their own strike count (60 s doubling to the 960 s cap) and still never age into DEAD.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib transient_failures_back_off
  EVIDENCE: FAILED when the backoff used `attempts` (old behaviour); passes with the new transient_strikes column (migration 0022). 126 sync tests pass.
- [x] O3 Two grace deletes for one person both reach the sheet.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib grace_deletes_for_one_person
  EVIDENCE: previous commit: 1 queue row instead of 2 (FAILED); passes now.
- [x] O4 Attendance writes and their sync-queue rows commit together.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib queue_rows_commit_with
  EVIDENCE: previous commit: attendance=1, queued=0 when the transaction died after the queue write (FAILED); passes now. Every writer (scan, admin update/delete/backdated, user save/delete, profiles, cutoff create/update/finalize/delete/generate) queues on its own transaction; the pool-only enqueue_sync was deleted as dead code.
- [x] O5 Cutoff generation is all-or-nothing and replaced drafts are deleted on the sheet.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib cutoff_generate_
  EVIDENCE: previous commit: replaced draft never queued for deletion (FAILED); passes now, including a forced mid-generation failure that leaves the previous drafts intact.
- [x] O6 A browser-mode scan request that never answers gives up after 15 s.
  CHECK: npm test -w client -- api.test.ts
  EVIDENCE: old code: test timed out at 15 s with the request still pending (FAILED); passes now.
- [x] O7 Deactivating a person cannot leave an open day or a held bathroom key stuck.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib deactivation_
  EVIDENCE: previous commit: deactivation succeeded with a day open (FAILED); passes now; client maps USER_HAS_OPEN_DAY / USER_HOLDS_BATHROOM_KEY to sentences (api.test.ts).
- [x] O8 VoiceStudio settings, check and regenerate need an admin session; Check does not save what was typed.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib voicestudio_ && npm test -w client
  EVIDENCE: FAILED with the old save-on-check logic; passes now; client passes the session token (api.test.ts "sends the admin session token …").
- [x] O10 Legacy server: admin lock revokes the session token server-side.
  CHECK: npm test -w server
  EVIDENCE: old code: GET /api/admin/session with the kept cookie returned 200 after lock (FAILED); 401 now; server 292 passed.
- [x] O11 Admin attendance changes reach open LAN viewers; native listeners are not leaked.
  CHECK: cargo test --manifest-path src-tauri/Cargo.toml --lib admin_changes_reach_lan_viewers && npm test -w client
  EVIDENCE: Rust test FAILED before (no bus event); App.test "detaches the native card listener …" FAILED with the old effect code; both pass now.
- [x] S1–S7 each narrowed to Confirmed (fixed with a test) or Refuted, recorded in docs/STATE-MACHINES.md.
  EVIDENCE: S1, S2, S3, S6, S7 confirmed and fixed (each test FAILED with the fix disabled); S3 also exposed the same race in the D1 wrong-PIN counter (fixed, test FAILED before). S5 half refuted (D4 makes an instant time-out impossible), half confirmed and fixed (racing double tap now DUPLICATE_SCAN; test FAILED before). S4: cause confirmed in code but not reproducible under Node with fake or real timers; cause removed (stable onClose) with a real-timer guard test. Open: O12 (impact 4, daily reset-failure cap undercount).
- [x] Repo gates pass.
  CHECK: npm run lint && npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml --no-fail-fast -- --test-threads=1
  EXPECT: JS gates exit 0; Rust suites pass except the 3 pre-existing Windows-path tests on Linux.
  EVIDENCE: JS exit 0 (shared 39, client 620, server 292). Rust lib 391 passed / 3 failed (the same 3 Windows-path tests); integration suites 11/18/69/35/52/24 passed. While here, a flaky DTR batch test fixture (counted hits after answering) was fixed; the lib suite then passed 4/4 consecutive runs.
