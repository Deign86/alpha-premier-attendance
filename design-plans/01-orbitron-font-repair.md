# Plan 01 — Repair Orbitron display-font files (garbled section headings)

- Status: DONE 2026-09-12 (implemented this session; root cause corrected mid-work —
  see Evidence 4)
- Current commit: `1294222`
- Surface: every admin section heading (`Add user`, `Move the attendance database…`,
  `Generate cutoff payroll`, `Voice Announcements`, dialogs, badges)
- Owners: `client/src/styles.css` `@font-face` lines 1–23; consumers include
  `.admin-form h2` (:284), `.lan-panel-head h2` (:310), `.payroll-panel-heading h2`
  (:526–528), `.db-backup-list h3` (:354), `.edit-payroll-dialog h2` (:934)

## Evidence (do not re-audit; verify before edit)

1. `Get-FileHash client\src\fonts\Orbitron-*.woff2 -Algorithm MD5` → all three files
   hash `5D281085F7277A3EC9C7586DD2F24A13`, 11,800 bytes each, magic `wOF2` valid.
   Three weights serving one identical binary is a proven defect (weights 500/600/700
   all synthesize from the same file).
2. Tauri screenshots `01-app-overview`, `02-data-backup-sync-health`, `03-payroll`,
   `05-voice-announcements` (this session): Orbitron headings render mixed glyphs
   (e.g. `Add user`, `Move the attendance database to a new computer`) while the
   Poppins hero (`Manage attendance`) in the same frames renders clean — so the
   defect is font-specific, not a screenshot artifact.
3. No `DESIGN.md` or other design source governs this (checked repo root); the
   correction preserves the existing Orbitron identity, it does not redesign.

4. CORRECTION MID-WORK: the downloaded genuine Google file
   `yMJRMIlzdpvBhQQL_Qq7dy0.woff2` hashes EXACTLY `5D281085…` — the repo files
   were genuine, not corrupt. Orbitron v35 is a single VARIABLE font, so three
   identical files were expected. The real defect: three single-weight
   `@font-face` blocks with no `font-weight` range, forcing every heading onto
   the default 400 instance (+ synthetic bold). Fixed as one variable face
   (`font-weight: 400 900`), deleted the two redundant binaries, kept one copy
   as `Orbitron-variable.woff2` (same verified bytes).

## Implemented (replaces the Change section above)

1. `client/src/styles.css`: 3 `@font-face` blocks → 1 variable face.
2. `client/src/fonts/`: removed `-500`/`-600`/`-700`, kept verified bytes as
   `Orbitron-variable.woff2`; no other references existed (grep clean).
3. `npm run build -w client` exit 0 (11.93s).
4. Headful proof: screenshot `08-font-fix-proof` (Data & backup) — headings
   render in one uniform face with true weights; compare vs `02`.

## Checks

- `npm run build -w client` exits 0.
- Headful proof: `npm run tauri:dev` + `tauri_driver_session start` +
  `tauri_webview_screenshot` on Users/RFID and Data & backup — headings render in
  one uniform face at 100% zoom (compare against screenshots `01`/`02`).

## Risks

- If Google Fonts is unreachable, do NOT substitute another face; leave the plan
  open and report. No system-font fallback change without a new plan.
