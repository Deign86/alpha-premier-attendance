# Simplified Keyboard-Mode RFID Scanner Architecture

**Goal:** Simplify the attendance system around supported keyboard-wedge RFID reader operation, eliminating unsupported hardware discovery, raw-HID/serial detection, transport classification, and background-capture claims.

## Summary of Changes

1. **Hardware Model:** The system exclusively supports USB keyboard-wedge RFID readers (e.g. 125 kHz EM4100 readers emitting decimal or hexadecimal characters followed by Enter).
2. **Foreground Window Focus:** Keystrokes are captured and buffered only while the attendance window is focused. Operators are guided with: "Keep the attendance window focused before scanning."
3. **Scan Flow & Validation:** Keystroke bursts are buffered with an inter-key gap threshold (250 ms), finalized on Enter (or configured idle timeout), and validated against expected length (with `expected_length = 0` allowing variable length 4–64 characters) and character set (`decimal` or `hex`). Scans are rejected and the buffer reset on invalid characters, buffer timeout, Escape key, or window blur.
4. **Clean Removal:**
   - Removed `hidapi` and `serialport` dependencies from `src-tauri/Cargo.toml`.
   - Removed `scanner_devices` command, raw-HID / serial reader configuration fields, and transport classification.
   - Removed `scannerTransports`, `scannerConfidences`, `canCreateBackgroundAttendance`, and `ForegroundInputProtection` from `@rfid-attendance/shared`.
   - Simplified `ScannerStatus` to `{ state, message, detail, mode: 'keyboard', paused: boolean }`.
   - Updated UI to present scanner as "Keyboard-mode RFID reader" with clear focus guidance.
