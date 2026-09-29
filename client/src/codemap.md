# client/src/
## Responsibility
This is the UI layer for the attendance kiosk, live attendance viewer, administration, and browser/Tauri integration. `App.tsx` owns the route-selected screens and workflows; adjacent modules provide focused panels, transport adapters, and UI helpers.

## Design
- `main.tsx` mounts `App` under `StrictMode`; `App.tsx` selects kiosk, `LiveAttendance`, or `AdminPanel` by pathname and manages workflow state with React hooks.
- `api.ts` is the typed application service facade: it dispatches operations to `tauriApi` in Tauri or HTTP through `network.ts` in browser mode, with desktop-only fallbacks and response normalization.
- `tauri-api.ts` maps typed frontend methods to Tauri `invoke` commands and event listeners; `network.ts` resolves API/realtime URLs and persists offline attendance scans in localStorage.
- UI modules separate bathroom view/log (`BathroomKioskView`, `BathroomKeyLogPanel`), voice settings, update surfaces, and generated-file actions; `dtr-sync-guard.ts` exposes a shared external-store flag through `useDtrSyncActive`.
- `mcp-bridge-helper.ts` exposes DOM reference/text/XPath lookup and inline script injection for webview automation; `speech.ts` is deprecated legacy Web Speech API compatibility code, not the authoritative announcement path.

## Flow
1. `index.html` loads `main.tsx`; React mounts `App`, which renders the kiosk by default or `LiveAttendance` at `/attendance` and `AdminPanel` at `/admin`.
2. RFID arrives via the keyboard-wedge handler or `listenForGlobalRfid`; `App` normalizes/deduplicates and guards the UID, then sends attendance or bathroom scans through `submitScan` / `submitBathroomScan` in `api.ts`.
3. The facade chooses Tauri commands (`tauri-api.ts`) or browser HTTP (`network.ts`); failed offline attendance posts enter `enqueueOfflineScan`, and `App` retries/removes queued records when connectivity returns.
4. Typed success/error results update React state; kiosk screens render the outcome and announce via `services/ttsService.ts`. Config/setup/admin, attendance, payroll, database, DTR, and bathroom panel actions similarly pass through the API facade.
5. `UpdateBanner` checks/installs updates through `services/updateService.ts`; panels such as `VoiceSettingsPanel` and `GeneratedFileActions` delegate settings/audio or OS file actions to the service/API layer.

## Integration
- Consumed by: `client/index.html` via `src/main.tsx`; Tauri desktop webview and Vite browser development.
- Depends on: `@rfid-attendance/shared` domain contracts, React, Lucide, Tauri v2 APIs/plugins, and `services/` modules.
- Main UI call sites: `App` → `submitScan`, `submitBathroomScan`, `loadAttendance`, `unlockSetup`, `loadBathroomStatus`; `VoiceSettingsPanel` → `ttsService`; `UpdateBanner` → `updateService` and `listenForCheckForUpdates`.
- Transport boundary: `api.ts` → `tauriApi` (`invoke`/events) or `apiUrl`/`fetch`; `network.ts` also supplies `sseUrl` and `websocketUrl` to realtime consumers.
