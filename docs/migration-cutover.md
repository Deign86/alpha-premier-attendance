# Migration And Cutover

Export the seven existing tabs as `Users.csv`, `Attendance.csv`, `AuditLogs.csv`, `InternGrace.csv`, `Payroll.csv`, `PayrollProfiles.csv`, and `PayrollCutoffs.csv` into one directory.

Run a dry run first:

```powershell
npm run migrate:from-sheets -- --dry-run --input .\sheets-export
```

Review headers, row counts, duplicate IDs, Manila dates, and payroll totals. Execute only after review:

```powershell
npm run migrate:from-sheets -- --execute --input .\sheets-export --db .\attendance.db
```

Keep the old web system read-only for one semi-monthly period. Compare daily attendance counts, intern grace claims, employee raw timestamps, Jean/Bea cutoff totals, and exported Sheets rows. Decommission the web writer only after operator sign-off and a verified SQLite/photo restore.
