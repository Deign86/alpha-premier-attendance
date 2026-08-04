# Kiosk Native RFID Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Present a Manila-time-aware kiosk greeting and restore reliable unfocused RFID capture through the native Tauri scanner pipeline.

**Architecture:** Keep capture in `src-tauri/src/services/scanner.rs`, where keyboard-wedge and configured HID streams share completion, normalization, deduplication, and Tauri event emission. Keep the React listener and existing attendance API/SQLite command intact, changing only the idle copy hierarchy and truthful state labels.

**Tech Stack:** Rust 2021, Tauri 2, `rdev`, `hidapi`, React 18, TypeScript, Vitest, Testing Library.

---

### Task 1: Manila Greeting Hierarchy

**Files:**
- Modify: `client/src/App.test.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/styles.css`

- [ ] **Step 1: Write failing greeting and hierarchy tests**

Add assertions that `greetingForDate` returns morning before 12:00, afternoon before 18:00, and evening thereafter in `Asia/Manila`. Replace the idle `Tap card` expectation with a dominant greeting and a separate `Scan card` helper expectation, while retaining the assertion that no primary scanner input exists.

```tsx
expect(greetingForDate(new Date('2026-08-04T01:00:00Z'), 'Asia/Manila')).toBe('Good morning');
expect(greetingForDate(new Date('2026-08-04T05:00:00Z'), 'Asia/Manila')).toBe('Good afternoon');
expect(greetingForDate(new Date('2026-08-04T11:00:00Z'), 'Asia/Manila')).toBe('Good evening');
```

- [ ] **Step 2: Run the focused client test and confirm RED**

Run: `npm --workspace client test -- App.test.tsx`

Expected: FAIL because `greetingForDate` is not exported and the screen still renders `Tap card`.

- [ ] **Step 3: Implement the greeting hierarchy**

Export a pure timezone-aware helper using `Intl.DateTimeFormat(..., { hourCycle: 'h23' }).formatToParts()`. Use it for the idle headline, retain `Reading card...` while processing, and render `Scan card` as the idle supporting copy. Adjust only the hero typography needed to suit sentence-case greeting text.

- [ ] **Step 4: Run the focused client test and confirm GREEN**

Run: `npm --workspace client test -- App.test.tsx`

Expected: all kiosk tests pass.

### Task 2: Native Keyboard-Wedge Regression

**Files:**
- Modify: `src-tauri/src/services/scanner.rs`

- [ ] **Step 1: Add failing native capture tests**

Add tests proving keyboard events translate scanner UID keys without invoking layout-derived event names, Enter is treated only as completion, and the idle buffer returns a candidate only after the configured timeout.

```rust
assert_eq!(key_text(Key::Num9), Some('9'));
assert_eq!(key_text(Key::KeyF), Some('F'));
assert_eq!(key_text(Key::Return), None);
```

Use controlled `Instant` values for idle completion so the test does not sleep.

- [ ] **Step 2: Run the scanner unit tests and confirm RED**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::scanner::tests -- --nocapture`

Expected: the new idle-completion API test fails until the buffer exposes deterministic completion logic.

- [ ] **Step 3: Implement the minimal native repair**

Keep the `rdev` callback short by translating `event.event_type` through deterministic virtual-key mapping and never reading `event.name`. Move idle candidate extraction into a testable `ScanBuffer` method used by the flusher. Preserve configured Enter completion, pause behavior, UID normalization, native deduplication, `rfid-scan` emission, and `scanner-status` emission.

- [ ] **Step 4: Run scanner tests and confirm GREEN**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::scanner::tests -- --nocapture`

Expected: all scanner unit tests pass.

### Task 3: Immediate Frontend Feedback and Status Truth

**Files:**
- Modify: `client/src/App.test.tsx`
- Modify: `client/src/App.tsx`
- Modify: `client/src/tauri-api.ts` only if the Rust event payload differs from the declared type

- [ ] **Step 1: Add failing response-state tests**

Assert that a native `rfid-scan` event immediately renders `Reading card...`, that native status events map to `Ready`, `Scanning`, `Offline`, and `Error`, and that success still renders the employee photo.

- [ ] **Step 2: Run the focused client test and confirm RED**

Run: `npm --workspace client test -- App.test.tsx`

Expected: any missing status label or processing behavior fails with its exact accessible text.

- [ ] **Step 3: Implement only missing frontend wiring**

Retain one stable `rfid-scan` listener and one `scanner-status` listener. Route valid scans through the existing `submitScan` call with the in-flight guard, and use native states for the compact status pill. Do not add a focused or hidden scanner input.

- [ ] **Step 4: Run the focused client test and confirm GREEN**

Run: `npm --workspace client test -- App.test.tsx`

Expected: all kiosk tests pass, including success photo and unknown-card feedback.

### Task 4: Regression Verification

**Files:**
- Verify only; no planned production changes.

- [ ] **Step 1: Run the full client suite**

Run: `npm --workspace client test`

Expected: zero failing tests.

- [ ] **Step 2: Run client typecheck and production build**

Run: `npm --workspace client run typecheck`

Run: `npm --workspace client run build`

Expected: both commands exit successfully.

- [ ] **Step 3: Run the Rust suite and build check**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`

Run: `cargo check --manifest-path src-tauri/Cargo.toml`

Expected: zero failures and successful compilation.

- [ ] **Step 4: Inspect the final diff**

Run: `git diff --check`

Run: `git diff -- client/src/App.tsx client/src/App.test.tsx client/src/styles.css client/src/tauri-api.ts src-tauri/src/services/scanner.rs`

Expected: no whitespace errors; changes remain limited to greeting, scanner capture, native state wiring, and tests.
