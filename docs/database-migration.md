# Moving the Attendance Database to a New Computer

The attendance system stores everything in a single local SQLite file
(`attendance.db`) on the front-desk PC. When the setup/config PC is replaced by
the actual front-desk PC — or any time the app must move to a new machine — the
database moves with it. This document is the runbook for that transfer.

## Where the database lives

| Mode | Default location |
| ---- | ---------------- |
| Installed (NSIS, per-machine) | `%LOCALAPPDATA%\com.alphapremier.attendance\attendance.db` |
| Portable (`portable.dat` next to the `.exe`) | `<exe folder>\Data\attendance.db` |
| Override | `[database] path` in `config.toml`, or the `ALPHA_PREMIER_DB_PATH` environment variable |

The database file location is **configurable**, never hardcoded. Priority:

1. `[database] path` in `config.toml` (relative paths resolve against the config
   directory — next to the executable in portable mode, so a USB deployment can
   carry its data with it).
2. `ALPHA_PREMIER_DB_PATH` environment variable (for installers/scripting).
3. The default data-directory location above.

A configured value with a file extension (e.g. `attendance.db`) is treated as
the database file itself; a value without one is treated as a directory and
`attendance.db` is appended. Example:

```toml
# config.toml — store the database somewhere stable and shared, e.g. a D: drive
[database]
path = "D:/Attendance/attendance.db"
```

The database opened at startup runs the SQLite migrations automatically, so a
backup made by an older app version is upgraded in place on first launch.

## Why a plain file copy is unsafe

The app opens SQLite in WAL journal mode. While the app is running, recent
writes can live in `attendance.db-wal` (and `attendance.db-shm`) next to the
main file. Copying only `attendance.db` mid-session silently drops those recent
records, and copying the sidecars while the app is writing can corrupt the
copy. **Never copy the `.db` file while the app is open.**

Every supported transfer path below avoids this:

- The in-app backup uses SQLite's online backup engine (`VACUUM INTO`), which
  produces a consistent snapshot even while the app is recording scans.
- The in-app restore swaps files only at startup, before the database is
  opened, so no two processes ever touch the file.

## Recommended flow (in-app, no manual SQL)

Both PCs must be running this app version (any 0.1.x build with the Data &
backup panel).

1. **On the old PC** — open **Admin → Data and backup** and press
   **Create backup now**. The app writes
   `attendance-backup-YYYYMMDD-HHMMSS.apbackup` into
   `%LOCALAPPDATA%\com.alphapremier.attendance\backups` (or
   `<exe folder>\Data\backups` in portable mode) and keeps the newest 10.
   A backup is also written automatically every time the app closes cleanly,
   so a fresh one usually already exists before a migration.
2. **Copy the file** to a USB drive (or the office network), then plug it into
   the new PC.
3. **On the new PC** — open **Admin → Data and backup** and press
   **Restore from backup file…**, select the copied `.db` file, and confirm.
   The app validates the file (SQLite integrity check + attendance schema),
   closes itself, and on the next launch:
   - saves the current database (if any) as
     `backups/pre-restore-YYYYMMDD-HHMMSS.db` so the restore can be rolled back,
   - restores from the selected file using SQLite's online backup engine,
   - runs migrations, then starts normally.

All users, RFID cards, attendance records, payroll profiles, cutoff payroll,
sync queue, and audit logs move with the file. No configuration beyond the
restore step is required on the new PC.

If the restore cannot be applied (file missing, invalid, or a write failure),
the app **keeps its current database** and writes `restore.failed` next to the
data directory; the kiosk still starts. The admin panel shows the pending/
failed state.

## Manual flow (technician, no app interaction)

When the app cannot be opened (e.g. imaging a replacement machine), use the
helper script — the app must be closed:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\migrate-database.ps1 `
  -BackupFile "D:\attendance-backup-20260805-143000.apbackup"
```

The script locates the live database (portable vs installed, honouring
`[database] path`), saves the current database aside, and restores the backup.
Add `-DryRun` to preview. For portable deployments pass `-ExeDir`:

```powershell
.\scripts\migrate-database.ps1 -BackupFile "D:\backup.db" -ExeDir "D:\AttendanceApp"
```

Fully manual equivalent (no script): copy the backup file over the live
`attendance.db` while the app is closed, then start the app. The backup file
must come from the in-app backup (a consistent snapshot), not a raw copy of a
running database.

## Installer / scripting flow

For automated provisioning, set the environment variable once and launch the
app; the restore happens before the database is opened, then the variable can
be dropped:

```powershell
$env:ALPHA_PREMIER_RESTORE_FROM = "D:\attendance-backup-20260805-143000.apbackup"
& ".\alpha-premier-attendance.exe"
Remove-Item Env:\ALPHA_PREMIER_RESTORE_FROM
```

`ALPHA_PREMIER_RESTORE_FROM` behaves exactly like the admin marker flow
(validation, pre-restore safety snapshot, online-backup restore) and the marker
file in the data directory takes priority when both are present.

## Post-migration checklist

1. Open the app on the new PC and unlock Admin.
2. Admin → Users and RFID: confirm the expected employees and card UIDs.
3. Admin → Attendance corrections: spot-check recent dates.
4. Admin → Payroll: confirm cutoff payroll records are present.
5. Admin → Data and backup: confirm the database path is the one you expect
   and that a fresh backup can be created.
6. If the old PC stays on the network, stop using it as a writer so the two
   PCs do not record into separate databases. Only one PC should ever write.

## Backups lifecycle

- Backups live in `data_dir\backups` (`attendance-backup-*.apbackup`). Each archive contains the complete application state: SQLite, photos, exports, sync files, and `config.toml`.
- Automatic: one is created on every clean app exit.
- Manual: Admin → Data and backup → Create backup now.
- Rotation: the newest 10 are kept; older backups are deleted automatically.
- Pre-restore safety snapshots (`pre-restore-*.db`) are also kept here and
  count toward the same folder.

## Troubleshooting

| Symptom | Cause / fix |
| ------- | ----------- |
| "The selected file is not a valid Alpha Premier attendance database" | The file is not a SQLite database with the attendance schema (e.g. a raw copy, a photo, a ZIP). Use a backup produced by the app. |
| Restore scheduled but nothing changed on next launch | Check `restore.failed` next to the data directory, or the app log. The most common cause is the source file not being found (USB drive removed). |
| App starts with empty data after restore | The restore replaces the whole database — an empty/old backup was selected. Restore again from the correct file; the pre-restore snapshot still contains the previous data. |
| Two PCs both recording | Only one PC should ever be the writer. After migration, decommission the old PC as a writer or point both at the same `[database] path` on a shared drive (SQLite over network shares is discouraged). |
