# src-tauri/

## Responsibility
- Rust/Tauri v2 application crate for the Alpha Premier Attendance desktop kiosk, local API, LAN viewer, payroll, reporting, and background integrations.
- `tauri.conf.json` configures the `main` WebView, frontend bundle, local asset protocol, NSIS packaging, and signed-updater endpoint.

## Design
- Cargo builds the `alpha_premier_attendance_lib` as `cdylib`, `rlib`, and `staticlib`; `src/main.rs` is a thin binary entry point to `run()`.
- Runtime dependencies include Tauri plugins, Tokio/Axum, SQLx SQLite migrations, and spreadsheet/PDF generation crates; Windows adds registry access for autostart repair.
- Runtime data paths/configuration are resolved separately from packaged resources; SQLite is the durable local source of truth.

## Flow
- `main()` calls `alpha_premier_attendance_lib::run()`; Tauri setup enforces one instance, installs tray/autostart, loads config, processes a pending restore, then creates shared `AppState` and runs SQLite migrations.
- Setup manages state, starts the scanner and periodic Sheets/DTR/voice workers, optionally starts the LAN server, registers command handlers, and focuses the main window.
- Frontend commands operate on shared state/database; window close hides to tray and requests a portable SQLite backup.

## Integration
- WebView invokes Rust commands over Tauri IPC; plugins provide dialogs, notifications, updater, autostart, logging, and SQLite access.
- Axum exposes the read-only attendance viewer to permitted LAN clients; Google Sheets synchronization and VoiceStudio clip pulls run as resilient background tasks.
- Portable backup/restore and file exports use configured app data/export directories; migrations are embedded from `db/migrations`.
