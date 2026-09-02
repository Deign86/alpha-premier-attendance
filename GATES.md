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


