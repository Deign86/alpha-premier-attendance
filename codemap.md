# Repository Atlas: alpha-premier-attendance

## Project Responsibility
RFID attendance desktop kiosk (Tauri v2 + React 18 + Rust + Express + Google Sheets). Kiosk scan → local SQLite (desktop) or Sheets (server) → payroll engines (intern/employee/cutoff) → Sheets sync, LAN viewer, XLSX/PDF exports, TTS announcements.

## System Entry Points
- `client/index.html` → `client/src/main.tsx` → `client/src/App.tsx`: kiosk / `/attendance` live view / `/admin` panel.
- `src-tauri/src/lib.rs::run` (via `src-tauri/src/main.rs`): Tauri setup, `AppState`, SQLite migrations, scanner + sync workers, LAN server.
- `server/src/index.ts` → `createApp()` (`server/src/app.ts`): Express `/api/*` (scan/setup/admin/payroll), Sheets or memory adapter.
- `shared/src/api-contracts.ts`: wire contracts + Manila attendance/payroll policy shared by server and desktop.
- `scripts/start-dev.mjs`: dev orchestration (server :3001 + client :5173 + Tauri 9223).

## Data & Control Flow
1. RFID keyboard-wedge UID → `App.tsx` normalize/dedupe → `api.ts` facade → Tauri `invoke` (`tauri-api.ts`) or HTTP (`network.ts`, offline queue in localStorage).
2. Desktop: `lib.rs` command → `services::scanner` normalize → SQLite attendance row → event bus → Sheets/DTR sync workers, TTS job, LAN SSE push.
3. Server: `POST /api/attendance/scan` → `AttendanceService.scan` → per-user `mutex` → Sheets row find/create/update → `PayrollService` on completion → audit.
4. Payroll: per-attendance engines (`payroll.ts` → intern/employee) + cutoff assembly (`admin.ts` + `cutoff-payroll.ts`); intern DTR CLI (`sync-intern-dtr.ts`) plans `planPush` then `executePush` to intern workbook.
5. Exports/voice: `reporting/` loaders → XLSX/PDF writers; `tts/` manager (local engines + VoiceStudio clips) → playback + IPC status.

## Directory Map (Aggregated)
| Directory | Responsibility Summary | Detailed Map |
|-----------|------------------------|--------------|
| `.` | Repo root: Tauri desktop + Express server + shared contracts + tooling. | [View Map](codemap.md) |
| `client/` | Frontend package boundary: Vite build/dev/proxy, React entry, Tauri webview host. | [View Map](client/codemap.md) |
| `client/src/` | UI layer: kiosk/live/admin screens, `api.ts` Tauri-or-HTTP facade, panels, transport adapters. | [View Map](client/src/codemap.md) |
| `client/src/services/` | Frontend services: TTS/cloned-voice orchestration, updater check/install. | [View Map](client/src/services/codemap.md) |
| `server/` | Express backend package: Sheets-backed APIs + operator CLIs (validate/migrate/backfill/sync). | [View Map](server/codemap.md) |
| `server/src/` | HTTP boundary + domain services: scan/setup/admin, Sheets adapter, payroll engines, intern-DTR push. | [View Map](server/src/codemap.md) |
| `shared/` | `@rfid-attendance/shared` package: contracts + policy published to server and desktop. | [View Map](shared/codemap.md) |
| `shared/src/` | Contract/policy source: scan/payroll/LAN/bathroom types, Manila time math, office identity. | [View Map](shared/src/codemap.md) |
| `src-tauri/` | Desktop crate + packaging: Tauri v2 app, SQLite truth, NSIS/updater config. | [View Map](src-tauri/codemap.md) |
| `src-tauri/src/` | Backend modules: commands, `AppState`, SQLite, LAN Axum server, lifecycle/tray, services. | [View Map](src-tauri/src/codemap.md) |
| `src-tauri/src/bin/` | Legacy Sheets-CSV migration utility (dry-run/execute). | [View Map](src-tauri/src/bin/codemap.md) |
| `src-tauri/src/reporting/` | Export data loaders + XLSX/PDF document generators. | [View Map](src-tauri/src/reporting/codemap.md) |
| `src-tauri/src/services/` | Business services: scanner, payroll, Sheets/DTR sync, reconciliation, voice jobs. | [View Map](src-tauri/src/services/codemap.md) |
| `src-tauri/src/tts/` | Speech manager: engine fallback, playback, IPC integration. | [View Map](src-tauri/src/tts/codemap.md) |
| `tools/` | Dev tooling: CUA harness, JEV evaluators, oxlint custom rules. | [View Map](tools/codemap.md) |
| `tools/cua/` | Automation primitives + verdict routing for live-app checks. | [View Map](tools/cua/codemap.md) |
| `tools/cua/cases/` | CUA scenario predicates and case flows. | [View Map](tools/cua/cases/codemap.md) |
| `tools/jev/` | Bounded judgment evaluators: validation, guards, `JevClient`, audit. | [View Map](tools/jev/codemap.md) |
| `tools/oxlint/` | Custom lint plugin registration and AST rules. | [View Map](tools/oxlint/codemap.md) |
| `tools/oxlint/anti-slop/` | Anti-slop rule set (e.g. no-widen-then-assert, dictionary types). | [View Map](tools/oxlint/anti-slop/codemap.md) |
| `scripts/` | Node helpers: dev start, Tauri/CUA verification, screenshots, Sheets maintenance, release. | [View Map](scripts/codemap.md) |

## Integration Points
- Contract spine: `shared/src/api-contracts.ts` → `server/src/*`, `client/src/api.ts`, desktop screens/exports.
- Persistence duality: desktop SQLite (`src-tauri/src/database.rs`, `state.rs`) vs server Sheets (`server/src/sheets.ts`); reconciled by sync workers + `sync-intern-dtr.ts`.
- IPC/HTTP edges: Tauri commands (`lib.rs`) ↔ `client/src/tauri-api.ts`; Express routes (`server/src/app.ts`) ↔ `client/src/network.ts`; LAN Axum server → read-only viewers via SSE.
- Evidence/ops: `scripts/cua-jev-run.mjs` → `evidence/cua-jev/`; release via `.github/workflows/release.yml` (typecheck/lint/test → frontend build → Tauri sign + `latest.json`).
