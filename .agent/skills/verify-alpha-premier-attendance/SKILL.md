---
name: verify-alpha-premier-attendance
description: "Verify Alpha Premier Attendance desktop app via Tauri MCP and native harness: launch dev instance, doctor checks, drive kiosk/admin/payroll/setup flows, capture screenshots and state."
---

# Verify Alpha Premier Attendance

Drive and verify the Alpha Premier Attendance desktop app end-to-end using the native Tauri MCP Bridge and test harness.

## Launch

Start the Tauri desktop application with the MCP bridge active:

```powershell
npm run tauri:dev
```

The app is ready when:
1. Vite dev server responds on `http://localhost:3000` (or `client/dist` loaded)
2. Tauri MCP Bridge WebSocket server starts listening on `ws://127.0.0.1:9223` (or `0.0.0.0:9223`)
3. Desktop window titled "Alpha Premier Attendance" appears.

For headful driving, start a session via Tauri MCP:
```json
{
  "ServerName": "tauri",
  "ToolName": "driver_session",
  "Arguments": { "action": "start" }
}
```

## Doctor

Before driving features or when troubleshooting, run the read-only doctor check:

```powershell
npm run doctor:mcp
```

Or verify bridge connectivity via Tauri MCP:
```json
{
  "ServerName": "tauri",
  "ToolName": "driver_session",
  "Arguments": { "action": "status" }
}
```

Verify that:
- `tauri.conf.json` has `withGlobalTauri: true`
- `capabilities/default.json` grants `mcp-bridge:default`
- `Cargo.toml` has `tauri-plugin-mcp-bridge`
- Bridge port `9223` is open and responsive.

## Drive

Drive the application using the Tauri MCP tools:

1. **Locate UI Elements**:
   Use `webview_find_element` or `webview_dom_snapshot` to inspect DOM structure and stable data/ARIA attributes.
   ```json
   {
     "ServerName": "tauri",
     "ToolName": "webview_find_element",
     "Arguments": { "selector": "[data-testid=\"rfid-input-field\"]" }
   }
   ```

2. **Interact with Controls**:
   Use `webview_interact` to click buttons, input values, or trigger form submissions.
   ```json
   {
     "ServerName": "tauri",
     "ToolName": "webview_interact",
     "Arguments": { "selector": "button[type=\"submit\"]", "action": "click" }
   }
   ```

3. **Direct IPC & State Verification**:
   Execute Tauri commands directly using `ipc_execute_command` to inspect native SQLite state, scanner status, or payroll calculations:
   ```json
   {
     "ServerName": "tauri",
     "ToolName": "ipc_execute_command",
     "Arguments": { "command": "get_config" }
   }
   ```

4. **Monitor Native Events**:
   Track scan events (`rfid-scan`, `attendance-updated`, `scanner-status`) using `ipc_monitor` and retrieve event logs with `ipc_get_captured`.

## Evidence

Capture concrete proof for all verification runs:

1. **Screenshots**:
   Capture webview screenshots to prove UI rendering and visual confirmation states:
   ```json
   {
     "ServerName": "tauri",
     "ToolName": "webview_screenshot",
     "Arguments": { "name": "kiosk_time_in_success" }
   }
   ```

2. **DOM Snapshots & Transcripts**:
   Capture DOM snapshots showing rendered employee details, attendance timestamps, or dialog states.

3. **Generated File Verification**:
   Inspect generated payroll registers (`exports/payroll-*.xlsx`, `exports/payroll-*.pdf`) and attendance sheets (`exports/attendance-*.xlsx`) to verify column structures, formulas, and Manila timestamp formatting.

## Cleanup

1. Stop the active Tauri MCP driver session:
   ```json
   {
     "ServerName": "tauri",
     "ToolName": "driver_session",
     "Arguments": { "action": "stop" }
   }
   ```

2. Terminate the spawned Tauri dev background process (kill by TaskId / process ID, not by global process kill).
3. Preserve captured screenshots and evidence logs in the task artifact directory.

## Helpers

- `npm run doctor:mcp` (`node scripts/doctor-tauri-mcp.mjs`): Performs environment and bridge pre-flight checks.
- `npm run verify:mcp` (`node scripts/verify-tauri-mcp.mjs`): Runs end-to-end user-workflow verification across kiosk, admin, setup, payroll, and TTS diagnostics.
- `npm run tauri:dev`: Starts frontend and Tauri backend with debug assertions enabling the MCP bridge.
- `npm run test -w client -- src/tauri-config.test.ts`: Runs automated unit tests verifying Tauri MCP configuration.

