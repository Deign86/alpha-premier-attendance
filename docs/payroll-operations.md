# Payroll Operations

Payroll is calculated from the local SQLite attendance record. Intern rules preserve weekly `InternGrace`, late-hour deductions at PHP 10 per hour, and floor-at-zero behavior. Interns are included in cutoff payroll generation: the admin payroll workspace lets you select an intern and produce an **Intern Payroll Worksheet** with the fixed PHP 80.00 daily rate and a PHP 10.00 per hour late deduction (after the weekly grace applied at the daily ledger level). Employee records preserve raw timestamps, use the existing computed hour ceiling/floor, and keep deductions at zero until the client defines the rule.

`JEAN_TENURED` and `BEA_STANDARD` are seeded during migration. Intern cutoff records use the fixed `INTERN_STANDARD` classification instead of a configurable profile. Use the local admin panel to edit a draft cutoff, reconcile attendance, and finalize it. Finalized cutoffs are immutable; export CSV only after reconciliation and retain the SQLite backup with the export.

The Sheets worker is write-only and asynchronous. A dead-letter count in the admin sync status requires retry after correcting credentials or connectivity; it never changes the local payroll result.
