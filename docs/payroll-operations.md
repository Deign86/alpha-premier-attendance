# Payroll Operations

Payroll is calculated from the local SQLite attendance record. Intern rules preserve weekly `InternGrace`, late-hour deductions at PHP 10 per hour, and floor-at-zero behavior. Interns are included in cutoff payroll generation: the admin payroll workspace lets you select an intern and generate an **Intern Payroll PDF** with the fixed PHP 80.00 daily rate and a PHP 10.00 per hour late deduction (after the weekly grace applied at the daily ledger level). Employee records preserve raw timestamps, use the existing computed hour ceiling/floor, and support manual late deductions through a fillable cutoff form: enter the employee's total late hours and a PHP-per-hour deduction rate (the amount is computed from those values and can be overridden). Late hours and the deduction are stored on the cutoff record and appear on the register, CSV export, and generated payroll PDF. Automatic daily employee late rules remain undefined; cutoff deductions are filled in by payroll staff.

## Generated payroll PDFs

The Payroll tab's **Generate Employee Payroll PDF** / **Generate Intern Payroll PDF** buttons produce one consolidated, landscape payroll sheet PDF per cutoff entirely in the Tauri Rust backend (`src-tauri/src/reporting/mod.rs` `generate_payroll_sheet_pdf`, via printpdf) — no browser print dialog is ever involved, so no browser headers, timestamps, or `localhost` URLs appear in the output. Files are saved to the app exports folder (`Data/exports`, or `exports/` next to the executable in portable mode) with timestamped names like `payroll_2026-08-14_10-30-00_employee.pdf`, and each generation is recorded in the `payroll_pdfs` SQLite table (migration `0008_payroll_pdfs.sql`) with the local path, cutoff period, worker type, employee count, gross total in centavos, SHA-256, size, and Manila generated-at timestamp. The Payroll tab lists that history with **Open PDF** (opens in the system default viewer) and **Show in Folder** buttons, backed by the existing `open_generated_file` / `reveal_generated_file` Tauri commands (`admin_authorized` + canonical path validation). The optional `tax_identification_number` office setting (`config.toml` `[office]`) is printed as `TIN:` on the sheet header when configured.

## Lunch break rule

Paid hours never include the fixed **12:00–13:00** lunch window (`Asia/Manila`). The rule is centralized so it can be audited or changed in one place per runtime:

- Desktop app (authoritative): `src-tauri/src/services/lunch_break.rs` — `LUNCH_START_HOUR` / `LUNCH_END_HOUR`
- Legacy server: `server/src/lunch-break.ts` — `LUNCH_START_HOUR` / `LUNCH_END_HOUR`

The shared helper subtracts **only the portion of the lunch window that overlaps the worked interval**, so these cases are all handled correctly:

- shift spans the whole window (e.g. 09:00–17:00 → 7 paid hours),
- clock-in before 12:00 and clock-out after 13:00,
- clock-in or clock-out *inside* the window (only the non-lunch edges are paid),
- partial hours around lunch (e.g. 11:45–13:15 → 30 paid minutes),
- overnight / multi-day spans (each touched day's window is checked).

It applies equally to **employees and interns**: `worked_hours` on daily payroll results (Rust `EmployeePayrollResult` / `InternPayrollResult`, TS `calculateEmployeePayroll` / `calculateInternPayroll`) excludes the lunch hour, and the attendance workbook `TOTAL_HOURS` column (`reporting::elapsed_hours`) is lunch-adjusted so reports never show raw totals that include the break. Overtime hours entered on cutoff payroll are manual inputs recorded net of lunch; intern lateness is still measured against the 08:00 start and is unaffected by the lunch rule.

`JEAN_TENURED` and `BEA_STANDARD` are seeded during migration. Intern cutoff records use the fixed `INTERN_STANDARD` classification instead of a configurable profile. Use the local admin panel to edit a draft cutoff, reconcile attendance, and finalize it. Finalized cutoffs are immutable; export CSV only after reconciliation and retain the SQLite backup with the export.

The Sheets worker is write-only and asynchronous. A dead-letter count in the admin sync status requires retry after correcting credentials or connectivity; it never changes the local payroll result.
