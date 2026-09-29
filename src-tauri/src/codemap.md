# src-tauri/src/

## Responsibility
- Crate root and backend modules: `lib.rs` owns Tauri commands, `AppState` wiring, attendance/admin workflows, and runtime setup.
- Supporting modules isolate config/path resolution, typed errors, SQLite backup/restore, lifecycle/tray behavior, LAN networking/server, and business services.

## Design
- `AppState` is cloned into Tauri-managed state and worker tasks; its SQLx `SqlitePool`, event bus, scanner, TTS manager, LAN runtime, sync guards, and paths coordinate shared work.
- SQLx migrations create the local schema; command implementations use parameterized SQLite queries, while domain calculations and integrations live under `services/`.
- `reporting/` contains reusable export data loaders and document generators; `tts/` encapsulates local speech engines and playback.

## Flow
- Startup in `lib::run`: resolve paths/config → restore request if present → `AppState::new` opens WAL SQLite, enables foreign keys, migrates → manage state and launch workers/server/scanner.
- The frontend invokes registered `#[tauri::command]` handlers; RFID events are normalized by `services::scanner`, then command logic validates users and records attendance/key activity in SQLite.
- Mutations queue sync work or publish attendance events; periodic workers dispatch Sheets/DTR work, reconciliation, and voice jobs; export commands load rows and write reports.

## Integration
- `lib.rs` is the IPC boundary to the Tauri WebView; command results use serialized JSON and typed response structures.
- `database.rs` handles consistent VACUUM INTO snapshots and restore files; `state.rs` owns pool/migration and shared runtime state.
- `lan_server.rs` serves read-only Axum HTTP/SSE; `lifecycle.rs` covers single-instance IPC, tray, autostart, and hide-on-close; `config.rs` and `paths.rs` supply settings and storage locations.
