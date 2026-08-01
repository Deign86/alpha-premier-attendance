# Payroll Operations

Payroll is calculated from the local SQLite attendance record. Intern rules preserve weekly `InternGrace`, late-hour deductions at PHP 10 per hour, and floor-at-zero behavior. Employee records preserve raw timestamps, use the existing computed hour ceiling/floor, and keep deductions at zero until the client defines the rule.

`JEAN_TENURED` and `BEA_STANDARD` are seeded during migration. Use the local admin panel to edit a draft cutoff, reconcile attendance, and finalize it. Finalized cutoffs are immutable; export CSV only after reconciliation and retain the SQLite backup with the export.

The Sheets worker is write-only and asynchronous. A dead-letter count in the admin sync status requires retry after correcting credentials or connectivity; it never changes the local payroll result.
