# Full-Feature Test Coverage Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add missing automated tests so every verified feature has runnable regression coverage.

**Architecture:** Three parallel lanes (client vitest, server vitest, Rust unit tests), each auditing its assigned features against existing tests and adding only genuine gaps. Tests-only: no production code changes.

**Tech Stack:** vitest + jsdom + @testing-library/react (client/server); Rust `#[cfg(test)]` mods (src-tauri).

**Spec:** `.agents/skills/verify-alpha-premier-attendance/features/` (7 feature files: rfid-kiosk, admin-roster, card-setup, payroll-exports, settings-lan-tts, bathroom-key-log, dtr-sync). Already well-covered — skip: payroll-exports, dtr-sync (covered this session + parity fixtures).

## Global Constraints
- Tests only; never change production code to make a test pass.
- Anti-slop: no `as T` without `// SAFETY:`, no `any`, no double casts.
- Client/server verify: `npx vitest run <touched-file>` in its workspace; full gate is root `npm test`.
- Rust verify: `cargo check --tests --manifest-path src-tauri/Cargo.toml`; `cargo test` binaries exit `0xc0000139` locally (documented loader fault) — CI executes.
- Each lane owns disjoint files; no cross-lane edits.

## Review Focus
- Kiosk scan validation edges (bad UID shapes, duplicate-scan cooldowns) untested in UI.
- Admin PIN/session expiry paths untested outside live MCP runs.
- Card-setup wedge-routing and duplicate-card guards untested.
- Bathroom double-checkout/return ordering covered live-only, not in unit tests.
- LAN port/bind and TTS fallback-chain defaults asserted nowhere runnable.

---

### Task A: Client feature-test gaps
**Files:** Create/extend under `client/src/` — kiosk views, admin workspace, card-setup modal, bathroom log/panel, voice settings.
- [ ] Audit each assigned feature against existing `client/src/**/*.test.*`; list gaps.
- [ ] Add missing tests (jsdom + testing-library; mock `window.__TAURI__` invoke per existing patterns).
- [ ] Run: `npx vitest run` on each touched file in `client/`. Expected: PASS.

### Task B: Server feature-test gaps
**Files:** Extend under `server/test/` — setup/card-status, admin auth/session, attendance corrections, bathroom API, LAN/sheets API shapes.
- [ ] Audit against existing `server/test/*`; list gaps (skip payroll + DTR internals).
- [ ] Add missing tests with minimal fakes; no network.
- [ ] Run: `npx vitest run` on each touched file in `server/`. Expected: PASS.

### Task C: Rust feature-test gaps
**Files:** Extend `#[cfg(test)]` mods in `src-tauri/src/` — `scan_rfid` validation/debounce edges, bathroom toggle/edit validation, setup/unlock PIN paths, LAN/office config resolution.
- [ ] Audit against existing test mods; list gaps (skip payroll/DTR/sheets-sync — covered).
- [ ] Add pure-function tests only; no DB/network.
- [ ] Run: `cargo check --tests --manifest-path src-tauri/Cargo.toml`. Expected: PASS (warnings pre-existing).
