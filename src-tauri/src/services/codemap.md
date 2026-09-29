# src-tauri/src/services/

## Responsibility
- Domain and integration services for RFID scanning, attendance time rules, lunch breaks, payroll, Sheets/DTR sync and reconciliation, office hours, and VoiceStudio clip pulls.

## Design
- `mod.rs` exposes focused modules; pure payroll/time calculations are separated from async SQLx, network, and device operations.
- Service calls receive the shared `AppState` or explicit `SqlitePool`/config inputs; `sync_retry` centralizes retry scheduling, throttles, and sync-guard contracts.
- Scanner owns native listener state/events; Sheets/DTR services coordinate remote updates against SQLite queues/state, while voice jobs persist queue state and generated clips under app data.

## Flow
- `services::scanner` reads keyboard-wedge/HID input, normalizes UID against `ScannerConfig`, and emits `rfid-scan`; `lib.rs` receives scans, validates identity/status, persists attendance, then publishes live events and sync queue work.
- Payroll commands call intern/employee and cutoff calculators using attendance, holidays, office-hour, and lunch-break rules, then persist calculated cutoff/payroll results.
- Background startup loop calls Sheets sync, scheduled DTR reconciliation, and `voice_pull::run_once`; DTR commands also process pending rows and dispatch spreadsheet batch writes with throttling/retry.

## Integration
- `lib.rs` Tauri commands invoke admin, payroll, scanner, DTR, recon, Sheets, and voice service APIs; `AppState` provides SQLite and long-lived worker coordination.
- Remote Sheets/Drive APIs use the configured endpoints/credentials and persist retry/sync metadata in SQLite; the LAN server's event bus is fed by successful attendance mutations.
- `tts/` can play downloaded name clips; `reporting/` shares time/pay calculations for generated exports.
