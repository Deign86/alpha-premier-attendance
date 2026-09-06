---
name: verify-alpha-premier-attendance
description: "Verify Alpha Premier Attendance desktop app via Tauri MCP and native harness: launch dev instance, doctor checks, drive kiosk/admin/payroll/setup/bathroom flows, capture screenshots and state."
---

# Verify Alpha Premier Attendance

Drive and verify the Alpha Premier Attendance desktop app end-to-end using the native Tauri MCP Bridge and test harness. Current app version: `0.1.50`.

## Launch

Start the Tauri desktop application with the MCP bridge active:

```powershell
npm run tauri:dev
```

The app is ready when:
1. Vite dev server responds on `http://127.0.0.1:5173` (or `client/dist` loaded)
2. Tauri MCP Bridge WebSocket server starts listening on `ws://127.0.0.1:9223`
3. Desktop window titled "Alpha Premier Attendance" appears.

For headful driving, start a session via Tauri MCP tool `tauri_driver_session`:

```
tool: tauri_driver_session, args: { "action": "start" }
```

## Doctor

Before driving features or when troubleshooting, run the read-only doctor check:

```powershell
npm run doctor:mcp
```

Or verify bridge connectivity via Tauri MCP tool `tauri_driver_session`:

```
tool: tauri_driver_session, args: { "action": "status" }
```

Verify that:
- `tauri.conf.json` has `withGlobalTauri: true`
- `capabilities/default.json` grants `mcp-bridge:default`
- `Cargo.toml` has `tauri-plugin-mcp-bridge` (v0.13.0)
- Bridge port `9223` is open and responsive.

## Drive

Drive the application using the Tauri MCP tools (`tauri_webview_find_element`,
`tauri_webview_dom_snapshot`, `tauri_webview_interact`, `tauri_webview_keyboard`,
`tauri_webview_wait_for`, `tauri_webview_execute_js`, `tauri_webview_screenshot`,
`tauri_ipc_execute_command`, `tauri_ipc_monitor`, `tauri_ipc_get_captured`,
`tauri_ipc_emit_event`, `tauri_ipc_get_backend_state`, `tauri_manage_window`):

1. **Locate UI Elements**:
   Use `tauri_webview_find_element` or `tauri_webview_dom_snapshot` to inspect DOM structure and stable data/ARIA attributes.
   ```
   tool: tauri_webview_find_element, args: { "selector": "[data-testid=\"rfid-input-field\"]" }
   ```

2. **Interact with Controls**:
   Use `tauri_webview_interact` to click buttons, input values, or trigger form submissions.
   ```
   tool: tauri_webview_interact, args: { "selector": "button[type=\"submit\"]", "action": "click" }
   ```

3. **Direct IPC & State Verification**:
   Execute Tauri commands directly using `tauri_ipc_execute_command` to inspect native SQLite state, scanner status, or payroll calculations:
   ```
   tool: tauri_ipc_execute_command, args: { "command": "get_config" }
   ```
   The backend exposes 71 commands (see `src-tauri/src/lib.rs` `generate_handler!`).
   IPC arg keys on the wire are **lowerCamelCase by Tauri v2 default**: the
   `#[command]` macro renames every Rust param via `to_lower_camel_case()`
   (see `tauri-macros-2.6.3/src/command/wrapper.rs`: `argument_case` defaults
   to `Camel`). Live-proved: `setup_lookup_card` with `{ "rfidUid": ... }`
   succeeds while `{ "rfid_uid": ... }` fails with a missing-key error — so
   write args exactly as the frontend bridge does in
   `client/src/tauri-api.ts` (e.g. `rfidUid`, `cutoffStart`, `cutoffEnd`,
   `payrollCutoffLabel`, `userId`, `logId`, `genderKey`, `attendanceId`,
   `payrollId`, `filePath`, `fullName`). When in doubt, copy the key names
   from `tauri-api.ts`, never from the Rust signatures.

4. **Monitor Native Events**:
   Track scan events (`rfid-scan`, `attendance-updated`, `scanner-status`) using `tauri_ipc_monitor` and retrieve event logs with `tauri_ipc_get_captured`.

## Evidence

Capture concrete proof for all verification runs:

1. **Screenshots**:
   Capture webview screenshots to prove UI rendering and visual confirmation states:
   ```
   tool: tauri_webview_screenshot, args: { "name": "kiosk_time_in_success" }
   ```

2. **DOM Snapshots & Transcripts**:
   Capture DOM snapshots showing rendered employee details, attendance timestamps, or dialog states.

3. **Generated File Verification**:
   Inspect generated payroll registers (`exports/payroll-*.xlsx`, `exports/payroll-*.pdf`) and attendance sheets (`exports/attendance-*.xlsx`) to verify column structures, formulas, and Manila timestamp formatting.

## Standalone-mode caveat

`npm run verify:mcp` marks workflows PASSED from unit/integration contracts when
port 9223 is offline (`liveBridge.active: false`). Treat those as
**contract checks, not live proof** — a green standalone run does not replace a
headful drive. Always note `liveBridge.active` in the report.

Bathroom key state is **desktop-only evidence**: the Express server keeps a
separate in-memory bathroom store, so browser/LAN checks cannot confirm the
Tauri SQLite `bathroom_log`. Verify bathroom flows via Tauri IPC or the desktop
webview only.

## Cleanup

1. Stop the active Tauri MCP driver session:
   ```
   tool: tauri_driver_session, args: { "action": "stop" }
   ```

2. Terminate the spawned Tauri dev background process (kill by TaskId / process ID, not by global process kill).
3. Preserve captured screenshots and evidence logs in the task artifact directory.

## Helpers

- `npm run doctor:mcp` (`node scripts/doctor-tauri-mcp.mjs`): Performs environment and bridge pre-flight checks.
- `npm run verify:mcp` (`node scripts/verify-tauri-mcp.mjs`): Runs end-to-end user-workflow verification across kiosk, admin, setup, payroll, bathroom, and TTS diagnostics.
- `npm run tauri:dev`: Starts frontend and Tauri backend with debug assertions enabling the MCP bridge.
- `npm run test -w client -- src/tauri-config.test.ts`: Runs automated unit tests verifying Tauri MCP configuration.
