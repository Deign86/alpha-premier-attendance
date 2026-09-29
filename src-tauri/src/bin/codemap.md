# src-tauri/src/bin/

## Responsibility
- Holds standalone Rust utility binaries; `migrate_from_sheets.rs` imports legacy CSV exports into the current local SQLite schema.

## Design
- Uses a Tokio main entry point, SQLx migrations, CSV reader, and parameterized SQLite inserts; no Tauri WebView or managed app state is started.
- Import is opt-in with `--execute`; default mode inspects inputs and prints source row counts without opening or modifying the database.

## Flow
- Parse `--input` and `--db` (defaults `.` and `attendance.db`) and inspect Users, Attendance, AuditLogs, InternGrace, Payroll, PayrollProfiles, and PayrollCutoffs CSV files.
- Validate required headers and count records; in execute mode open/create SQLite, run embedded migrations, then import users → attendance → grace → audit → payroll → profiles → cutoffs.
- Normalize legacy attendance statuses and numeric currency fields, use insert-ignore/replace semantics per table, then verify each database count is at least the corresponding source count.

## Integration
- Shares the crate's `db/migrations` schema with the desktop application and writes data that is consumed by the regular SQLx-backed commands/services.
- Run from the `src-tauri` crate with `cargo run --bin migrate_from_sheets -- --input <csv-dir> --db <database-path>`; append `--execute` to commit imports.
