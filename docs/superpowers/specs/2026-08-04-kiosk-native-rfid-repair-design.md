# Kiosk Greeting and Native RFID Repair

## Scope

Revise the kiosk idle hierarchy so a Manila-time-aware greeting is dominant and `Scan card` is the smaller instruction. Repair native card capture without requiring a focused web input, while preserving the existing attendance command, SQLite writes, live updates, and employee-photo feedback.

## Architecture

The Rust scanner service remains the sole capture boundary. Keyboard-wedge and configured raw-HID sources feed one scan accumulator. Enter or the configured idle timeout completes a candidate scan. The shared pipeline normalizes the UID, rejects invalid input, suppresses repeats inside the native deduplication window, emits `rfid-scan`, and reports lifecycle changes through `scanner-status`.

The React kiosk registers one stable listener for each native event. A clean scan immediately enters the processing state, invokes the existing attendance API, and renders the existing success or error result. The attendance command and its SQLite transaction remain unchanged.

## Windows Keyboard Capture

Keyboard-wedge capture uses deterministic virtual-key translation for scanner characters instead of layout-based character-name translation. This keeps the low-level Windows hook callback short and avoids hook removal caused by slow layout translation. Enter completes the scan when enabled; otherwise the idle timer completes it.

Raw HID remains opt-in through configured vendor and product identifiers. HID reports are converted into the same character stream and do not bypass normalization, completion, or deduplication.

## Kiosk Experience

The idle headline is `Good morning`, `Good afternoon`, or `Good evening`, calculated from the configured timezone, which defaults to `Asia/Manila`. `Scan card` appears directly below as the concise supporting instruction. Processing replaces the greeting with immediate reading feedback; success and error results keep their existing focused layouts and employee photo behavior.

The compact scanner indicator maps native states to `Ready`, `Scanning`, `Offline`, and `Error`. Diagnostic detail remains available without adding visible kiosk clutter. Manual entry remains a secondary explicit action and never becomes the primary scanner path.

## Error Handling

Invalid native input reports an error state and automatically returns to ready after a short recovery period. Missing or failed HID devices report offline/error truthfully. Frontend attendance errors continue to show the backend message, including unknown card, duplicate, and database failures. An in-flight guard prevents overlapping attendance requests.

## Testing

Rust tests cover virtual-key translation, Enter completion, idle completion, normalization, invalid candidates, and deduplication. Frontend tests cover Manila-time greeting selection, the smaller `Scan card` instruction, native-event processing, success photos, error feedback, and absence of a primary RFID textbox. Existing client and Rust suites plus production builds provide regression verification.
