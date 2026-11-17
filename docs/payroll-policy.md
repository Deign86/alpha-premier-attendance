# Payroll policy versions

Payroll rules that depend on the date are one dated, explicit **policy version**.
A day is always priced under the policy in force on its `attendance_date`, and
the version used is stored in `payroll.policy_version` (migration 0020).

Single source of truth: `src-tauri/src/services/intern_payroll.rs`
(`PolicyVersion`, `PolicyRules`, `policy_for_date`). Do not add date checks
anywhere else.

## One module owns payroll rules

`src-tauri/src/services/intern_payroll.rs` is the only place that decides
anything about a day's pay. Everything else reads its output:

| Question | Owner | Consumers (no rules of their own) |
|----------|-------|-----------------------------------|
| What does a day cost? | `calculate` | `ensure_payroll` stores the result in `payroll` |
| On time, weekly grace or late? | `arrival` | attendance list rows and kiosk scan responses (`arrivalStatus`, `minutesLate`); the UI shows them as sent |
| What does the Breakdown say about a day? | `explain_day` | cutoff generation; amounts are the stored engine result, never re-priced |
| Was it a half-day? | `calculate` (`is_half_day`) | cutoff generation counts the stored flag |

`src-tauri/src/lib.rs` only does the database work around it: the weekly
claim row in `intern_grace` and the cutoff totals. The TypeScript helpers in
`shared/src/api-contracts.ts` and `server/src/intern-payroll.ts` serve the
legacy web API, which is not shipped; the desktop UI uses them only when a row
carries no engine status. When a rule changes, change it in the Rust module and
nowhere else in the desktop app.

## Rule catalog

| Rule | V1_WEEKLY_GRACE | V2_NO_GRACE | V3_WEEKLY_GRACE | Code location |
|------|-----------------|-------------|-----------------|---------------|
| Effective dates | before 2026-10-01 | 2026-10-01 to 2026-11-15 | 2026-11-16 onward | `NO_GRACE_CUTOFF_DATE`, `WEEKLY_GRACE_RESUME_DATE`, `policy_for_date` |
| Weekly grace window | 15 min after 08:00, one claim per week (`intern_grace`) | none | same as V1 | `PolicyRules::weekly_grace_window_minutes`; claim bookkeeping in `ensure_payroll` (`src-tauri/src/lib.rs`) |
| Quarter-hour clamp | after 08:15:00 payable clock-in rounds up to next full hour | none, actual clock-in is payable | same as V2 | `PolicyRules::quarter_hour_clamp`; DTR display in `build_dtr_row_with_clamp` (`services/dtr_sync.rs`) |
| Late-hour rounding | floor of clamped hours, minimum 1 | ceil of actual hours from 08:00, minimum 1 | same as V2 | `PolicyRules::late_rounding` |
| Clock-in must be on `attendanceDate` (Manila) | not enforced | required | required | `PolicyRules::require_same_manila_date` |
| Undertime with late hours | 8 h minus worked hours minus charged late hours | same as V1 | shortfall after the charged late hours end (08:01 is charged to 09:00), so an unused part of a late hour hides no early time-out | `PolicyRules::undertime_after_late_window` |

Not date-gated (identical in every version): the intern daily rate, arrival at or
after 12:00 is half-day undertime and never late, 18:00+ time-out caps to 17:00,
lunch break exclusion, undertime ceil per hour.

The shared TS constants `NO_GRACE_CUTOFF_DATE` and `WEEKLY_GRACE_RESUME_DATE` in
`shared/src/api-contracts.ts` must stay equal to the Rust constants while the
client still reads them.

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
