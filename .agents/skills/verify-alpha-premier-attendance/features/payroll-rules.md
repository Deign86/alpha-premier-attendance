# Payroll Rules (day pricing, weekly grace, undertime, adjustments)

What an intern's day costs and how it is shown. All rules live in
`src-tauri/src/services/intern_payroll.rs`; `docs/payroll-policy.md` lists them
by policy version. Use the table below as the grading rubric: each row is an
input you can create and the exact result the app must show.

## Sub-features

- `RULES-GRACE`: once per Manila Monday–Sunday week, the first arrival from 08:01:00 to 08:15:00 has no late deduction (days from 2026-11-16).
- `RULES-LATE`: from 08:01:00 every started hour late costs one hour of pay.
- `RULES-UNDERTIME`: each short hour costs one hour of pay, counted from the end of the charged late hours.
- `RULES-ADJUSTMENT`: a negative manual adjustment is shown under deductions; total earnings stay whole.

## How to get to it (user POV)

- Admin workspace → Attendance corrections: the Arrival column shows `On time`, `Grace` or `Late Nm`.
- Admin workspace → Payroll → Generate from attendance → Breakdown on a row: one line per graced, late or undertime day.
- Payroll → Generate Intern Payslips: the payslip image.

## Rubric (intern daily rate 80.00, hour 10.00, dates on or after 2026-11-16)

| Day | Arrival column | Breakdown lines | Day's deductions |
|---|---|---|---|
| 08:00 → 17:00 | On time | none | 0.00 |
| 08:01 → 15:00, first late arrival of the week | Grace | Grace 0.00; Undertime 20.00 | 20.00 |
| 08:05 → 17:00, grace already used that week | Late 5m | Late 10.00 | 10.00 |
| 08:01 → 15:01, grace already used | Late 1m | Late 10.00; Undertime 20.00 | 30.00 |
| 08:01 → 16:59, grace already used | Late 1m | Late 10.00; Undertime 10.00 | 20.00 |
| 08:15:01 → 17:00, grace available | Late 16m | Late 10.00 | 10.00 |
| 13:00 → 17:00 | Late | Half-day 40.00 | 40.00 |

Cutoff and payslip, for any mix of the rows above:

- Total Earnings = standard days × 80.00 (plus a positive manual adjustment only).
- Total Deductions = absent + late + half-day + undertime (+ a negative manual adjustment, shown as "Adjustment").
- Net Pay = Total Earnings − Total Deductions, never below 0.00.

## Driving it with Tauri MCP

Same IPC route as `payroll-exports.md` (`window.__TAURI__.core.invoke`).

1. Create the day through the kiosk path or `admin_create_backdated_attendance`, with both time-in and time-out.
2. `admin_attendance` with `{ token, date }` → each row carries `arrivalStatus` (`ON_TIME` | `GRACE_PERIOD` | `LATE`) and `minutesLate`.
3. `payroll_generate_cutoff` for the cutoff, then `payroll_list_cutoffs` → `calculationBreakdown` is JSON; its `deductions` array holds the lines (`category` `GRACE` | `LATE` | `UNDERTIME` | `ABSENCE`).
4. Screenshot the Attendance corrections table and the Breakdown popup as evidence.

## Without the desktop app

The same rubric is pinned in tests that run anywhere:

- `cargo test --manifest-path src-tauri/Cargo.toml --lib graced_undertime` (attendance → cutoff → Breakdown → payslip on a real SQLite file).
- `cargo test --manifest-path src-tauri/Cargo.toml --test payroll_hours_accuracy property_ differential_` (20,000 generated days each).

## Gotchas

- A day before 2026-11-16 prices under an older policy version on purpose; do not use one to check the rows above.
- A draft cutoff keeps its old Breakdown text until it is regenerated; a finalized cutoff never changes.
- A time-out from 17:00:00 to 17:59:59 counts as worked; 18:00:00 or later is capped back to 17:00.
