# Payroll policy versions

Payroll rules that depend on the date are one dated, explicit **policy version**.
A day is always priced under the policy in force on its `attendance_date`, and
the version used is stored in `payroll.policy_version` (migration 0020).

Single source of truth: `src-tauri/src/services/intern_payroll.rs`
(`PolicyVersion`, `PolicyRules`, `policy_for_date`). Do not add date checks
anywhere else.

## Rule catalog

| Rule | V1_WEEKLY_GRACE | V2_NO_GRACE | Code location |
|------|-----------------|-------------|---------------|
| Effective dates | before 2026-10-01 | 2026-10-01 onward | `NO_GRACE_CUTOFF_DATE`, `policy_for_date` |
| Weekly grace window | 15 min after 08:00, one claim per week (`intern_grace`) | none | `PolicyRules::weekly_grace_window_minutes`; claim bookkeeping in `ensure_payroll` (`src-tauri/src/lib.rs`) |
| Quarter-hour clamp | after 08:15:00 payable clock-in rounds up to next full hour | none, actual clock-in is payable | `PolicyRules::quarter_hour_clamp`; DTR display in `build_dtr_row_with_clamp` (`services/dtr_sync.rs`) |
| Late-hour rounding | floor of clamped hours, minimum 1 | ceil of actual hours from 08:00, minimum 1 | `PolicyRules::late_rounding` |
| Clock-in must be on `attendanceDate` (Manila) | not enforced | required | `PolicyRules::require_same_manila_date` |

Not date-gated (identical in every version): daily rate PHP 80.00, arrival at or
after 12:00 is half-day undertime and never late, 18:00+ time-out caps to 17:00,
lunch break exclusion, undertime ceil per hour.

The shared TS constant `NO_GRACE_CUTOFF_DATE` in `shared/src/api-contracts.ts`
must stay equal to the Rust constant while the client still reads it.

## Changing a rule safely

1. Add a new `PolicyVersion` variant (e.g. `V3...`) with its own `PolicyRules`
   and extend `policy_for_date` with its effective date. Never edit a released
   version or move an existing cutoff date.
2. Make `as_str()` return a new stable id; old rows keep their stored id, so
   past days stay priced under the old version.
3. Add fixture rows (pre- and post-boundary dates, both sides of the new date)
   and a row for the new version in `released_policy_versions_are_frozen`
   (the guard test fails until you do), plus a boundary assertion in
   `policy_for_date_pins_boundary_dates`.
4. Update this catalog (new column, effective date, code location) and add a
   migration only if the new version needs persisted data; `ensure_payroll`
   already writes `policy_for_date(date).as_str()`.
