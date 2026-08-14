# Background RFID Scan Support

**Goal:** Receive verified RFID scans while the Windows Tauri app is minimized or tray-hidden without changing foreground keyboard input.

**Implemented boundary:** Tauri v2 owns native capture. Only configured raw HID, serial, or vendor transports may be treated as device-verified background input. Generic keyboard-wedge input is disabled for background attendance.

## Current Repository Findings

- The packaged app is Windows 10/11-first, uses Tauri v2, Rust, SQLite, and a queued Sheets exporter.
- `src-tauri/src/services/scanner.rs` previously installed a global `rdev` hook and could not identify the physical input device.
- `client/src/App.tsx` previously auto-focused a scanner input and classified browser key bursts; this could steal focus and could not affect other applications.
- The native HID path already uses `hidapi` with configured VID/PID values.
- Tauri had no tray lifecycle; close only triggered a best-effort database backup.

## Problem Model and Constraints

- A browser listener cannot monitor system-wide input while minimized and cannot suppress keystrokes in another application.
- Timing, length, and character heuristics cannot identify a physical reader and must never be treated as device certainty.
- `preventDefault()` is limited to the webview and is not a solution for foreground applications.
- The generic keyboard hook is therefore disabled for background capture. Keyboard-wedge hardware must be reconfigured to a device-specific transport before production background use.

## Recommended Architecture

- `scanner.rs` remains the native capture boundary and feeds the existing normalization, deduplication, and Tauri event pipeline.
- Configured raw-HID readers use `hidapi`; configured serial/COM readers use `serialport`; keyboard mode installs no global hook and reports `Connected` with a foreground-only message (scans are captured only while the kiosk window is active).
- The UI listens for native events but never focuses a scanner input automatically. Manual entry remains an explicit opt-in workflow.
- A Tauri system tray is installed at startup with Show and Exit actions. Closing the main window hides it; tray Exit requests process termination.
- Local SQLite remains authoritative; existing LAN events, audit rows, and sync queue behavior remain unchanged.

## Alternatives and Trade-offs

| Approach | Background-safe | Decision |
| --- | --- | --- |
| Configured raw HID/serial/vendor device | Yes, when the transport is non-keyboard | Preferred |
| Raw Input observation | Identifies devices but does not suppress legacy keyboard delivery | Discovery only |
| Keyboard prefix/suffix or timing | Classifies content but can leak into the focused app | Detection-only/unsupported for background writes |
| Generic global hook | Cannot prove source device | Disabled |

Windows is the supported packaged target. macOS and Linux require separate HID/serial adapters and platform permission work; no browser-only global listener is supported.

## Input Classification Contract

The shared contract in `shared/src/api-contracts.ts` defines:

- Transports: `raw_hid`, `serial`, `vendor_sdk`, `keyboard_wedge_detection`, `disabled`.
- Confidence: `device_verified`, `prefix_suffix_verified`, `heuristic_candidate`, `rejected`.
- `canCreateBackgroundAttendance()` returns true only for `device_verified` raw HID, serial, or vendor input.
- Scanner status includes capture readiness, transport, confidence, pause state, and safe reason metadata; it does not include typed keyboard content.

## Data Flow and State Model

Native reader -> scan buffer -> normalization -> confidence gate -> `rfid-scan` event -> existing native/Tauri attendance command -> SQLite -> attendance event and sync queue.

States are idle/connected, scanning, invalid/error, offline, and paused. Repeated UIDs are rejected first by native deduplication and then by the existing backend cooldown. Offline export does not invalidate a committed local attendance row.

## Implementation Phases

1. Repository and hardware audit: record reader model, transport, VID/PID, UID lengths, terminator, and leading-zero behavior.
2. Safe capture proof: use configured raw HID or another device-specific transport; keep keyboard-wedge mode disabled for background writes.
3. Native lifecycle: tray, hide-on-close, explicit exit, reconnect/error status, and no focus changes.
4. Admin calibration/settings: add only after the deployed reader transport is confirmed; protect changes with the existing admin session.
5. Hardware/security rollout: validate Windows builds, signing, antivirus/EDR behavior, notifications, sleep/resume, and offline sync.

## File-by-File Change Plan

- `src-tauri/Cargo.toml`: enable Tauri `tray-icon`, add the maintained serial transport, and remove the global `rdev` dependency.
- `src-tauri/src/services/scanner.rs`: refuse generic keyboard background capture while preserving raw-HID buffering, normalization, deduplication, and status events.
- `src-tauri/src/config.rs`: add serial settings, `background_capture_allowed()`, and document the keyboard safety policy.
- `src-tauri/src/lifecycle.rs`: provide tray installation, hide/exit policy, and tray actions.
- `src-tauri/src/lib.rs`: install the tray and hide the main window on ordinary close while preserving explicit Exit.
- `client/src/App.tsx`: remove scanner auto-focus, browser key-burst classification, and background keyboard interception.
- `client/src/App.test.tsx`: verify no focus stealing and no keyboard-burst submission.
- `shared/src/api-contracts.ts` and its tests: define scanner transports, confidence levels, status shape, and background-write policy.
- `README.md`, `docs/hardware-verification.md`, and `src-tauri/config.example.toml`: replace unsafe global-hook/keyboard-wedge claims with the device-specific transport requirement.

## Configuration and Settings

- `scanner.mode = "hid"` requires `hid_vid` and `hid_pid`; `auto` uses HID only when both are present.
- `scanner.mode = "keyboard"` is retained for configuration compatibility and reports `Connected` with a foreground-only message; it installs no global listener, so background capture from keyboard-wedge input is impossible by design.
- Existing `enter_suffix`, idle timeout, and dedup settings remain available for verified HID report assembly.
- Admin calibration, serial/vendor settings, and diagnostics remain a follow-up gated by hardware confirmation.

## Privacy, Security, and Permissions

- Ordinary keyboard input is not captured, delayed, replayed, suppressed, or logged.
- Canonical attendance/audit storage retains only the identifiers required by the existing attendance model.
- Do not add a kernel filter driver or generic keyboard suppression without a separate signing, antivirus, licensing, and endpoint-security review.
- Reader permission or connection failure is surfaced as offline/error with no heuristic fallback.

## Test Plan

- Shared unit tests cover transport/confidence literals and the background-write gate.
- Rust tests cover keyboard safety configuration, tray hide/exit policy, scanner normalization, idle completion, duplicate handling, and the existing SQLite/sync behavior.
- Client tests cover native event submission, manual entry, no auto-focus, no browser key-burst submission, and existing result/error flows.
- Full regression includes normal typing, fast typing, paste, IME, RDP, multiple keyboards, malformed input, minimized/unfocused UI, offline export, and app build checks.
- Physical hardware validation remains required for the actual deployed reader before enabling background attendance.

## Acceptance Criteria

- Configured device-specific HID scans can be received while the app is minimized or tray-hidden without focus changes.
- Ordinary keyboard input is not blocked, modified, delayed, replayed, or logged.
- Keyboard-wedge/timing-only input cannot create background attendance records.
- Invalid and duplicate scans remain deterministic and do not create unintended rows.
- Closing hides the app; tray Exit terminates it explicitly.
- Missing reader, permission failure, or unsupported transport degrades to an offline state.

## Deployed EM4100 Reader Profile

The deployed 125 kHz EM4100 USB reader is a keyboard-wedge device. The default scanner profile (`expected_length = 10`, `character_set = "decimal"`) matches its typical 10-digit decimal + Enter burst; 8-hex readers set `expected_length = 8`, `character_set = "hex"`, and `expected_length = 0` disables exact-length matching. Admin → Scanner diagnostics enumerates HID devices (path, VID/PID, product, usage page/usage, interface) and flags keyboard-interface devices as foreground-only, so the operator can identify the reader and configure a raw-HID/serial transport when one is available. Keyboard-only readers cannot provide verified background capture without a signed filter driver (out of scope).

## Open Questions / Decisions Needed

- Confirm the deployed reader model and whether it exposes non-keyboard HID, serial, or vendor SDK access.
- Confirm valid UID lengths, character set, terminator, and leading-zero behavior.
- Confirm whether post-restart auto-launch is required; explicit process exit currently stops scanning.
- Confirm whether the existing admin PIN is the correct role for future scanner settings and diagnostics.

## Out of Scope

- Generic global keyboard interception, browser-only background capture, kernel filter drivers, remote/public attendance writers, multi-writer deployments, and scanning after the process has explicitly exited.
