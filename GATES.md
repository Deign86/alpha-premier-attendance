# Acceptance Gates: Full Database Backup and Restore Cross-PC Parity

## Core Gates

- [x] GATE-1: Identify exact reason why restoring on a separate PC does not restore the full database
  EVIDENCE: (1) Windows file locks on `logs/` aborted restore before copying DB in v0.1.1; (2) Hardcoded machine-specific absolute photo paths in `users.photo_url` (`C:/Users/Deign/...`) caused broken assets on target PCs with different usernames/paths; (3) Manual application restart was previously needed after scheduling restore.

- [x] GATE-2: Verify how the desktop UI, IPC commands, and database engine handle restore and subsequent queries
  EVIDENCE: `db_restore_request` now issues `app.restart()` for automatic relaunch. `restore_portable_backup` executes direct atomic DB file restoration and automatically runs `UPDATE users SET photo_url = ...` to point to the local machine's photos folder. `resolve_user_photo_url` handles local photo fallback for `admin_users`, `setup_scan`, and kiosk `scan`.

- [x] GATE-3: Ensure migrations, table schema, and all tables (users, attendance, profiles, cutoffs, sync state, photos, etc.) restore and display in the UI with 100% fidelity
  EVIDENCE: Verified all 19 users, 22 attendance rows, 208 audit logs, 15 payroll rows, 4 export jobs, and 19 WebP photo assets restore and resolve cleanly.

- [x] GATE-4: Verify multi-PC simulation end-to-end with automated checks
  EVIDENCE: `cargo test` (128 passed), `npm test` (168 passed). Multi-generation test `multi_generation_backup_restore_parity_roundtrip` verified across 3 distinct simulated machines.

- [x] GATE-5: Build release setup.exe and verify installer
  EVIDENCE: `Alpha Premier Attendance_0.1.2_x64-setup.exe` (144 MB) built, copied to `C:\Users\Deign\Downloads\`, and published to GitHub release `https://github.com/Deign86/alpha-premier-attendance/releases/tag/v0.1.2`.
