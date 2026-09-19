# Payroll Audit Bug Fixes — Handoff

## Branch
`fix/payroll-audit-bugs` — 1 commit (`846bb56`) on top of `main`.

## What's Done

### Committed (3 files, compiles clean)
All changes are in `src-tauri/src/` (Rust only). `cargo check --lib --tests` passes (0 errors, 9 pre-existing warnings).

| Bug | Status | Files Changed |
|-----|--------|---------------|
| **B1** LATE_TIMEOUT clock-out drops entire day | ✅ Fixed | `lib.rs` (5 hunks) |
| **B2** Intern late deduction double-counted | ✅ Fixed | `lib.rs` (6 hunks), `reporting/mod.rs` (1 hunk) |
| **B5** Stale lunch_break.rs doc comments | ✅ Fixed | `services/lunch_break.rs` (comments only) |

### B1 Details (LATE_TIMEOUT)
- `reconcile_attendance_payroll_range`: SELECT and DELETE queries now include `status IN ('COMPLETED', 'LATE_TIMEOUT')` instead of just `'COMPLETED'`
- Scan path (`scan_rfid_impl`): `ensure_payroll` now runs for LATE_TIMEOUT too
- Backdate path (`admin_create_backdated_attendance_impl`): same
- Update path (`admin_update_attendance_impl`): same (was a gap not in original scope — worker caught it)
- 2 regression tests added (backdate + reconcile for LATE_TIMEOUT)
- The payroll engine already caps time_out to 17:00 via `OFFICE_CLOSE_HOUR`, so pay computes correctly

### B2 Details (Intern Late Double-Count)
- `payroll_intern_report` (lib.rs): `total_deductions = half_day_deduction + absence_deduction` (was `+ late_deduction`); JSON outputs `"lateDeduction": 0.0`
- `load_payroll_sheet_rows` (reporting/mod.rs): `effective_late_deduction = 0` for INTERN in gross recompute
- `payroll_generate_cutoff_impl` (lib.rs): intern late amount set to `0.0`
- `apply_intern_rules` (lib.rs): intern `lateDeduction = 0.0` (lateUnits preserved for display)
- Tests updated: `applies_fixed_intern_rules_to_intern_cutoff_input` and `intern_editor_json_flows_through_one_discriminator_to_floored_gross`

### B5 Details (Stale Comments)
- `lunch_break.rs`: Doc comments corrected to state lunch IS subtracted from paid hours (was claiming the opposite)

## What's Left To Do

### 1. Run Full Test Suite
```bash
# JS tests (should pass — no TS changes)
npm test

# Rust tests — CANNOT run locally due to DLL mismatch, CI will run them
# If you want to try locally:
# PATH="C:\Users\APG\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.MSVCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin;%PATH%" cargo test --manifest-path src-tauri/Cargo.toml
```

### 2. Fix Remaining Stale Comments (Optional, Low Priority)
The B5 worker flagged 2 more files with the same stale "lunch not subtracted" comments:
- `reporting/mod.rs:796-804` — says "payroll worked_hours is gross elapsed time ceiled to the hour with no lunch subtraction" (false)
- `intern_payroll.rs:118-120` — says "the 12:00–13:00 lunch hour is no longer subtracted from paid hours" (false)

### 3. Fix Printed Register Column (Optional, Cosmetic)
B2 worker flagged: `load_payroll_sheet_rows` still puts the raw late_deduction in `PayrollSheetRow.late_deduction_centavos`, so the PDF sheet shows Late ₱10 + Halfday ₱10 while only ₱10 is subtracted from gross. One-line fix: use `effective_late_deduction` for the row field too (reporting/mod.rs around L2306).

### 4. Push, PR, Merge
```bash
# Push the branch
git push -u origin fix/payroll-audit-bugs

# Create PR via GitHub CLI
gh pr create --base main --head fix/payroll-audit-bugs \
  --title "fix: payroll audit bugs — LATE_TIMEOUT, intern late double-count, stale comments" \
  --body "## Fixes
- **B1**: LATE_TIMEOUT clock-out (≥18:00) no longer silently drops the entire day's pay. Attendance is included in payroll with time capped at 17:00.
- **B2**: Intern late deduction is no longer double-counted. The late hour shortfall is already included in half_day_deduction; late_deduction is now zeroed for interns across all paths (report, cutoff, editor, PDF register).
- **B5**: Corrected misleading doc comments in lunch_break.rs that claimed lunch was NOT subtracted from payroll (it is).

## Testing
- cargo check --lib --tests: 0 errors
- 2 new regression tests for B1 (LATE_TIMEOUT backdate + reconcile)
- Existing test assertions updated for B2
- JS tests unaffected (no TS changes)

## Audit Evidence
- Intern with 1 late day (08:16→17:00): cutoff now ₱870 (was ₱860, matching Σ daily_pay)
- LATE_TIMEOUT day (18:05 clock-out): now produces payroll row capped at 17:00 (was silently unpaid)
- DTR safety: 0 InternDtr rows written during entire audit"

# Once CI is green:
gh pr merge --squash --auto
```

### 5. TS Parity (Out of Scope, Future Work)
The B1 fix was Rust-only per instructions. The same LATE_TIMEOUT filtering defect exists in the TS server:
- `server/src/attendance.ts:201`
- `server/src/admin.ts:135, :195, :136`

These are only relevant if the Google Sheets server path is used (not the Tauri desktop app).

## Known Issues Not Fixed
- **Rust tests cannot run locally**: `/mingw64/bin/libstdc++-6.dll` shadows the WinLibs copy. Test binary crashes with `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`. CI uses MSVC and is unaffected.
- **B3 (Orphan InternGrace sync rows)**: `ensure_payroll` enqueues InternGrace sync even when INSERT OR IGNORE was a no-op. Not fixed in this PR.
- **B4 (Cutoff generate scope leak)**: `payroll_generate_cutoff` with `employeeId` filter still reconciles ALL users. Not fixed in this PR.

## Repo Gates
Before merging, the CI workflow (`.github/workflows/ci.yml`) runs:
1. `npm run typecheck`
2. `npm run lint:oxlint`
3. `npm test` (JS — 490 tests)
4. `cargo test --manifest-path src-tauri/Cargo.toml --test-threads=1` (Rust — ~150 tests)

On merge to main, `.github/workflows/release.yml` auto-bumps patch version, builds, signs, and publishes a Windows installer.
