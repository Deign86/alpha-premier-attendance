# scripts/
## Responsibility
- Node developer, verification, screenshot, spreadsheet-maintenance, and release helper scripts.
## Design
- `start-dev.mjs` launches API/frontend; `cua-jev-run.mjs` orchestrates the CUA harness and doctor scripts check its Tauri bridge.
- UI skills CLI/MCP shims, Tauri workflow verification, version bumping, cleanup, voice conversion, screenshots, and Sheets scripts handle developer tasks.
## Flow
- Dev start: provision credentials/secrets → spawn server → await `/api/config` → spawn client; CUA: doctor → cases/JEV or offline evidence → ledger/status.
- Tauri verify: inspect config/capabilities/MCP → probe/drive workflows → write evidence; Sheets: read/plan → optionally update → summarize.
- Cleanup measures artifacts before optional deletion; release helper synchronizes package and Tauri versions.
## Integration
- Node scripts use repo packages and relevant ports: Tauri 9223, Vite 5173, API 3001; CUA runner imports TS through `tsx`.
- CUA/JEV env inputs include `TYPESAFE_API_KEY` and known RFID UID; evidence is under `evidence/`; Sheets requires local service-account key.
- Release helper exports GitHub Actions outputs; artifact cleanup supports dry-run, threshold, and force modes.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
