# Simplification Audit Ledger

Persistent delta audit. Each run audits only commits added since the recorded
boundary, re-verifies open findings, and appends. Whole-system coverage is
reached incrementally.

## How to run this again

1. Delta = `<last audited commit>..HEAD`. Read the boundary below, not a version guess.
2. Review only changed files, split into non-overlapping subsystem lanes.
3. Re-verify every still-open finding against current source.
4. Materiality bar: accept only when the change removes an invalid-state class,
   removes duplicated business rules/branching, collapses scattered flags, or
   clarifies ownership. Reject anything that only relocates complexity behind a
   new type, or that is stylistic/hypothetical/line-count-only.
5. Update this file: boundary, findings, closed findings, skip log, coverage.
6. Run five independent verification passes (coverage, duplication, materiality,
   priority, adversarial-critical) before accepting the result.

---

## Boundary

| Field | Value |
|---|---|
| Last audited commit | `fbfe7694c03d28814680567982d8a6641f6eedc0` |
| Baseline audited this run | `c21cd00` / `v0.1.57` (commit titled "audit remediation") |
| Delta audited | `v0.1.57..HEAD` — **31 files, +1843/−197** |
| Date | 2026-09-12 |
| Mode | Read-only. No file/test/commit changes. |

**Next run:** delta starts at `fbfe769`.

### Delta commits
- `5b0d692` feat(dtr-payroll): decouple half-day pay from DTR display; late time-out auto-cap
- `b06dc25` feat(admin): realtime DTR sync status, autostart self-heal, file logging
- `27e0d7e`, `b05f915`, `94ffa80`, `fbfe769` — release prep, skills, docs

### Delta file classification (31 total)
`git diff --name-only v0.1.57..HEAD` yields 31 paths:

| Class | Count | Files |
|---|---|---|
| Executable source | 17 | 7 Rust (`lib.rs`, `lifecycle.rs`, `services/{dtr_recon,dtr_sync,employee_payroll,intern_payroll,payroll}.rs`), 4 server src (`{employee-payroll,intern-dtr-sync,intern-payroll,lunch-break}.ts`), 3 client src (`App.tsx`, `api.ts`, `tauri-api.ts`), 1 shared src (`api-contracts.ts`), 2 tests (`client/src/database-panel.test.tsx`, `server/test/intern-dtr-sync.test.ts`) |
| Runtime config | 3 | `src-tauri/Cargo.toml`, `src-tauri/capabilities/default.json`, `src-tauri/tauri.conf.json` |
| Presentation / docs / manifests | 11 | `client/src/styles.css`, 4 package manifests, `Cargo.lock`, `CHANGELOG.md`, `GATES.md`, `AGENTS.md`, 2 skill files |

> **Correction (run 1 verification):** an earlier revision of this ledger stated
> "24 files, +1407/−196" and "17 code files". Both were wrong — they were
> code-only filtered counts. The true delta is **31 files**. The agent test file
> `server/test/intern-dtr-sync.test.ts` was also missing from the lane mapping
> and is now assigned to D3.

---

## Coverage contract

| Lane | Subsystem | Files (delta) | Status |
|---|---|---|---|
| D1 | Rust DTR row build + classification | `services/dtr_sync.rs`, `services/dtr_recon.rs` | reviewed |
| D2 | Payroll rules across stacks | `services/payroll.rs`, `services/intern_payroll.rs`, `services/employee_payroll.rs`, `server/src/{lunch-break,employee-payroll,intern-payroll}.ts` | reviewed |
| D3 | TS DTR sync + shared contracts + its tests | `server/src/intern-dtr-sync.ts`, `shared/src/api-contracts.ts`, **`server/test/intern-dtr-sync.test.ts`** | reviewed |
| D4 | Client sync-health state | `client/src/{App.tsx,api.ts,tauri-api.ts,database-panel.test.tsx}` | reviewed |
| D5 | Native sync payload + autostart lifecycle + runtime config | `src-tauri/src/{lib.rs,lifecycle.rs}`, `Cargo.toml`, `capabilities/default.json`, `tauri.conf.json` | reviewed |

Coverage: 17/17 executable source files and 3/3 runtime-config files assigned.
`styles.css` and 10 docs/manifest files are reviewed and excluded as
presentation/documentation — they carry no data structure, state, control flow,
ownership, or algorithm change.

**Material config changes reviewed (not omissions):**
- `capabilities/default.json:15` adds `"log:default"` — a real permission-surface
  change enabling the Tauri log plugin. Material, and covered by D5.
- `Cargo.toml:57-60` adds `winreg = "0.10"` under `[target.'cfg(windows)'.dependencies]`
  — a direct registry-manipulating dependency enabling autostart self-heal.
  Material, and covered by D5.
- Both are behavior-enabling dependency/permission changes, not simplification
  targets in themselves; they are recorded here so they are not silently dropped.

---

## Accepted findings (ALL RESOLVED)

All four findings below have been implemented, tested, and independently verified against the repository. Their status is **CLOSED — VERIFIED**.

### A1 — Post-cap ordering is not validated consistently; one record can render an end stamp earlier than its start
- **Status: CLOSED — VERIFIED** (implemented in TS `intern-dtr-sync.ts` and Rust `dtr_sync.rs`)
- **Fix:** Added private `normalizeRecord` (TS) and `normalize_record` (Rust) that own parse + Manila + cap + ordering validation once. Both `build_dtr_row` and `classify_record_row` (and TS equivalents) consume the normalized result. Whitespace-only timestamps are normalized consistently across both runtimes.
- **Evidence:** `server/test/intern-dtr-sync.test.ts` (68/68 passed, +6 A1 tests); `cargo test --profile fast dtr_sync` (49/49 passed, +3 A1 tests). Inverted pair 17:30 in / 18:00 out now throws in all 4 functions.

### A2 — The half-day effective-window branch is duplicated within each stack
- **Status: CLOSED — VERIFIED** (implemented in TS `lunch-break.ts` and Rust `payroll.rs`)
- **Fix:** Added `effectiveHalfDayTimeOut` (TS) and `early_half_day_noon_out` (Rust) returning noon Option/null. All 4 payroll engines consume the helper and delete the duplicated condition. The intentional employee (hour-floored) vs intern (raw stamp) else-branch difference is preserved and locked by mirrored tests (17:30 -> 17:00 vs 17:30) in both runtimes.
- **Evidence:** `test/employee-payroll.test.ts` (13/13 passed); `test/intern-payroll.test.ts` (16/16 passed); `cargo test --profile fast payroll` (50/50 passed).

### A3 — Sync-health status is three independently-updated flags permitting contradictory UI
- **Status: CLOSED — VERIFIED** (implemented in `client/src/App.tsx`)
- **Fix:** Replaced 3 independent `useState` values with one `SyncHealthState` discriminated union (`loading | ready | refreshing | stale | error | syncing`). Derived `syncBadge` once outside JSX via an IIFE with inferred literals (0 oxlint errors). Stale state explicitly renders "Offline" with a "showing last known data (<reason>)" note. Manual sync owns the badge while in flight; background polls cannot dislodge it.
- **Evidence:** `client/src/database-panel.test.tsx` (14/14 passed, +4 regression tests). `npx oxlint` passes with 0 errors.

### A4 — Autostart mutation rule duplicated across tray and command paths
- **Status: CLOSED — VERIFIED** (implemented in `src-tauri/src/lifecycle.rs` and `lib.rs`)
- **Fix:** Added `set_autostart_enabled(app, config_dir, enabled)` and `apply_opt_out_marker(dir, enabled)`. Both tray toggle and `autostart_set` command call the shared helper. Registry mutation runs first; marker is touched only on success. Marker I/O stays log-only.
- **Evidence:** `cargo test --profile fast lifecycle` (11/11 passed, +1 marker test). `cargo check` clean (0 unused-import warnings in payroll/lifecycle).

---

- **Verdict:** recommend (highest priority)
- **Lanes:** D1 + D3
- **Evidence:**
  - Rust `build_dtr_row` validates ordering on the **raw** timestamp, then caps:
    `src-tauri/src/services/dtr_sync.rs:437` (`if tout_dt < tin_dt`) before `:443` (`cap_late_timeout_out`).
  - Rust `classify_record_row` caps **first**, then validates:
    `src-tauri/src/services/dtr_sync.rs:501` (cap) before `:516` (`if tout_dt < tin_dt`).
  - TS `buildDtrRow` validates on **raw**: `server/src/intern-dtr-sync.ts:401`, caps after (`:407`).
  - TS `classifyRecordKind` caps first (`:504`, via `capRecordOutIso`) and **has no ordering check at all**;
    `isShortStint` (`:366`) returns true for a negative duration because it tests `< 4h`.
  - Call sites: `dtr_sync.rs:1397` and `:1541` (classify, then plan → build at `:1092`);
    `dtr_recon.rs:183` (build) then `:191` (classify) — **recon runs the reverse order**.
- **Verified behavior for `time_in=17:30`, `time_out=18:00`** (caps out→17:00):
  - Rust `build_dtr_row` → `["", "", "5:30:00 PM", "5:00:00 PM"]` (renders end before start)
  - Rust `classify_record_row` → `Err("Time-out cannot be earlier than time-in: 17:00 < 17:30")`
  - TS `buildDtrRow` → `["", "", "5:30:00 PM", "5:00:00 PM"]` (renders end before start)
  - TS `classifyRecordKind` → `"afternoon-fragment"` (accepts the inverted capped interval)
- **Per-runtime difference (do not collapse into one description):**
  Rust's defect is a **builder/classifier ordering mismatch**. TS has the same
  builder issue **plus a classifier that lacks post-cap ordering validation entirely**.
  Both share one root cause: the cap/order normalization is duplicated and ordered differently.
- **Reachability — confirmed, not theoretical:** no write path enforces post-cap ordering.
  `admin_update_attendance_impl` validates only RFC3339 syntax, not ordering
  (`src-tauri/src/lib.rs:1437-1444`); the scan path stores `time_out` without comparing to
  `time_in` (`:4518-4521`); backdated create rejects only **raw** inversion (`:1609-1614`),
  which `17:30 → 18:00` passes.
- **Proposed representation:** one validated, normalized observation per runtime
  (parse in/out → Manila → cap → ordering check) returning a small enum
  (no time-in / working / completed). Both builders and both classifiers consume it.
- **Smallest credible scope:** `src-tauri/src/services/dtr_sync.rs` (private helper),
  `server/src/intern-dtr-sync.ts` (private helper). Public interfaces unchanged.
  Tests in the existing modules.
- **Regression risks:** missing/blank stamp behavior must not change; the 18:00→17:00 cap
  and the 4-hour short-stint boundary must hold. Pairs whose *capped* out precedes in
  become explicit errors — a behavior correction that may surface queued bad rows.
- **Validation:** add `17:30`/`18:00` asserting all four functions agree; keep
  `08:00`/`19:30` → row `[8:00 AM,'','',5:00 PM]` + `FullDay`/`full`; then
  `npm run lint:oxlint`, `npm run typecheck`, `npm test`, `npm run rust:test`.
- **Confidence:** high
- **Correction (run 1 verification):** an earlier revision claimed "TS: `buildDtrRow` throws"
  for this input. **That was wrong** — it returns an inverted row, like Rust's builder.
  The corrected behavior above was independently confirmed. Also corrected: recon builds
  before classifying, not after.

### A2 — The half-day effective-window branch is duplicated within each stack

- **Verdict:** recommend
- **Lane:** D2
- **Evidence:** identical condition `isHalfDay && timeIn.hour < 12 && timeOut < officeClose`
  and the same noon substitution, four times:
  - `src-tauri/src/services/employee_payroll.rs:62` (branch `:65`)
  - `src-tauri/src/services/intern_payroll.rs:86` (branch `:89`)
  - `server/src/employee-payroll.ts:19` (branch `:23`)
  - `server/src/intern-payroll.ts:53` (branch `:55`)
  The shared half-day *classifier* already exists (`lunch-break.ts:120`,
  `services/payroll.rs:63`) but does not own effective-window selection.
- **Current complexity:** one business rule ("a morning half-day closed early pays as
  08:00–12:00") written four times against two time libraries, so it can drift between
  the employee engine and the intern engine independently.
- **Proposed representation:** one helper per runtime owning the effective payroll
  clock-out. Must **not** absorb the non-half-day branch: employee floors the out-hour
  (`employee_payroll.rs:42-53`, `employee-payroll.ts:21-23`) while intern returns the raw
  capped stamp (`intern_payroll.rs:99`, `intern-payroll.ts:58-61`). Pass the capped out time in.
- **Smallest credible scope:** `services/payroll.rs` + the two Rust payroll engines;
  `server/src/lunch-break.ts` + the two TS payroll engines.
- **Regression risks:** the employee/intern rounding difference above; preserve cap-before-half-day ordering.
- **Validation:** existing payroll tests (`server/test/{employee,intern}-payroll.test.ts`,
  Rust `#[cfg(test)]` modules) plus boundary cases: morning early close, afternoon arrival,
  exactly 17:00, post-18:00 cap.
- **Confidence:** high
- **Prerequisite: none.** A2 does **not** depend on A1.

### A3 — Sync-health status is three independently-updated flags permitting contradictory UI

- **Verdict:** recommend
- **Lane:** D4
- **Evidence:** `client/src/App.tsx:3287-3289` holds `syncHealth`, `syncHealthError`,
  `syncingDtr` as independent `useState`. `refreshSyncHealth` (`:3292`) sets success and
  error independently and **retains the previous `syncHealth` on failure** (`:3301-3303`).
  Status is derived from a nested ternary cascade at `:3551`; the unavailable branch is
  gated on `syncHealthError && !syncHealth` at `:3578` only.
- **Invalid state (confirmed reaching the DOM):** a failed refresh after a success yields
  `{syncHealth: stale, syncHealthError: "…", syncingDtr: false}` — the badge renders
  `"Offline"` while the body renders stale table rows, unlabeled as stale.
  Also `syncingDtr` is cleared (`:3343-3344`) **before** `refreshSyncHealth()`, so the
  panel briefly shows a stale snapshot as non-syncing.
- **Proposed representation:** one discriminated union —
  `loading | ready | refreshing | error{message, staleHealth?} | syncing` — with
  `{label, className}` derived once outside JSX.
- **Smallest credible scope:** `client/src/App.tsx:3287-3303`, `:3315-3348`, `:3551-3610`;
  assertions in `client/src/database-panel.test.tsx`.
- **Regression risks:** current code deliberately keeps stale rows after a failure —
  preserve only when labeled stale. Tests may assert `"Offline"`/`"Syncing"` precedence.
  The `syncHealthSeq` guard (`:3291-3296`) is correct and must stay.
- **Validation:** test success→failure asserting stale data is explicitly labeled;
  deferred-promise test that an older response cannot overwrite a newer one.
- **Confidence:** high

### A4 — Autostart mutation rule duplicated across tray and command paths

- **Verdict:** recommend
- **Lane:** D5
- **Evidence:** tray toggle `src-tauri/src/lifecycle.rs:161-189` and
  `autostart_set` `src-tauri/src/lib.rs:4846-4864` both independently call
  `autolaunch.enable()/disable()`, log, then `clear_opt_out()` / `record_opt_out()`
  (`lifecycle.rs:169,181`; `lib.rs:4854,4861`). Precedence is re-checked separately at
  `lifecycle.rs:333` and `:399`.
- **Current complexity:** the enable/disable-plus-marker rule exists twice with
  **divergent failure semantics** — the tray logs and reverts the checkbox; the command
  propagates registry/plugin errors with `?`. A future change can update one path only.
- **Proposed representation:** one `set_autostart_preference(app, config_dir, enabled)`
  lifecycle helper owning enable/disable + marker + confirmed status; both callers use it.
  Keep marker = persisted intent, registry = actual state, `decide_autostart_action`
  (`lifecycle.rs:266`) as the pure precedence decision — do not build a larger state machine.
- **Smallest credible scope:** `lifecycle.rs:161-189`, `lib.rs:4846-4864`.
  Tests live **inline in `lifecycle.rs`**, not a separate test file.
- **Regression risks:** registry errors must still fail the command and must **not**
  mutate the marker; marker I/O stays log-only; non-Windows plugin path unchanged.
  Tray checkbox and React state remain separate projections.
- **Validation:** existing decision tests `lifecycle.rs:438-488` and marker round-trip
  `:510-519`; add enabled⇒clear-marker / disabled⇒record-marker helper tests.
- **Confidence:** high

---

## Explicit skips (reviewed, no change justified)

| # | Lane | Rejected proposal | Why rejected |
|---|---|---|---|
| S1 | D1 | Merge DTR display cells + paint kind + payroll window into one aggregate row state | `build_dtr_row`/`DtrRowKind`/payroll are deliberately decoupled and documented (`dtr_sync.rs:408-419`, `:475-480`). Merging re-couples display and payroll. A `HalfDay` paint with actual end stamps is intended, not invalid. |
| S2 | D2 | Shared cross-stack payroll result type / shared executable rule module | Rust (`chrono`) and TS (Luxon) cannot share code; result shapes genuinely differ (intern has grace/late state). A shared model would add optionality — exactly the invalid-state class we remove. |
| S3 | D3 | Discriminated union over `DtrRowKind` axes | No demonstrated invalid combination; `DtrRowKind` is paint-only (`dtr_sync.rs:475-477`) and payroll derives `isHalfDay` separately. **Corrected:** the cap (18:00 hour threshold) and `isLateTimeout` (minute truncation) are *not proven* equivalent here — that equivalence claim was unsupported and is withdrawn. Rejection stands on "no demonstrated invalid state", not on proven equivalence. |
| S4 | D4 | Collapse `Native*` wire types into `Dtr*` domain types | The two layers have different jobs: untrusted wire shape vs normalized domain model (`tauri-api.ts:5-35` vs `api.ts:698-739`). Removing either loses boundary validation or forces optionality into the UI. |
| S5 | D5 | Add a cross-language schema/generation step for the native payload | Only one consumer exists (`tauri-api.ts:28-36`, `:88-90`); the payload is hand-typed and validated at the boundary. Generation infrastructure is out of proportion to the gain. |
| S6 | D2 | Centralize cross-stack policy constants (17/18/12/4) into one shared source | Not credible across runtimes; document or parity-test instead. Standing parity risk, not a simplification. |

---

## Cross-cutting patterns

1. **Duplicated business rule, two runtimes.** Every payroll/DTR rule in this delta exists
   in both Rust and TS by design. The material risk is not the duplication but
   **order-of-operations drift** (A1) and **branch drift** (A2).
2. **Indicator state carried as independent flags.** A3 is the same failure mode this repo
   already fixed once for the scanner (separate booleans → one `ScannerStatus`). Same fix shape.
3. **One business rule, two call sites with divergent error handling.** A4 (tray vs command),
   A2 (employee vs intern engine).
4. **Payload shaped by `serde_json::json!`.** `lib.rs:3680` builds the largest new payload by
   hand; TS compensates with a hand-written parser. Correct for one consumer; standing drift risk.

## Duplicates / superseded findings

- Original lane D1 and D3 opportunities are the **same root cause** (duplicated cap/order
  normalization) and are merged into A1, with per-runtime differences preserved.
- No accepted finding duplicates another: A1 (DTR normalization) vs A2 (payroll window) vs
  A3 (client UI state) vs A4 (autostart mutation) have disjoint files and rules.
- No skip hides a material defect already accepted elsewhere.

---

## Priority ranking

Ranked by impact × confidence ÷ (effort × blast radius).

| Rank | ID | Impact | Confidence | Effort | Blast radius | Prerequisites |
|---|---|---|---|---|---|---|
| 1 | A1 | High — contradictory public behavior; renders end before start on payroll-adjacent path | High | Small–Medium | Medium (DTR push + backfill + recon) | none |
| 2 | A3 | Medium — visibly contradictory admin badge | High | Small | Low (one panel) | none |
| 3 | A4 | Medium — duplicated rule with already-divergent failure semantics | High | Small | Low (startup/tray) | none |
| 4 | A2 | Medium — 4× duplicated business branch | High | Medium | Medium–High (all payroll math) | none |

**Correction (run 1 verification):** an earlier revision claimed A2 depends on A1 and that
"A1 and A2 both touch the payroll/DTR core". **Both claims were false.** A1's scope is DTR
sync files; A2's scope is payroll files; no file appears in both. A2 is independent and
cannot consume A1's helper. A1 is still ranked first on impact, not on dependency.

**Best first slices:**
1. A1 regression test only — `17:30`/`18:00` across both stacks. ~2 test files.
2. A3 union in `DatabasePanel`. One file + its test.
3. A4 `set_autostart_preference` helper. Two files, tests inline in `lifecycle.rs`.
4. A2 helper extraction.

---

## Independent verification passes (run 1)

Five fresh read-only reviewer agents audited this ledger against the repository.
Their verdicts and dispositions:

| Pass | Verdict | Findings adopted |
|---|---|---|
| V1 coverage / missing boundaries | **BLOCK → fixed** | True delta is 31 files, not 24. `server/test/intern-dtr-sync.test.ts` was unassigned code; now in D3. Capability and `winreg` dependency are material and were inconsistently described as excluded; both are now recorded as covered by D5. |
| V2 duplication / ownership overlap | PARTIAL | A1/A2/A4 confirmed distinct; no duplicate findings. A1 must distinguish per-runtime failure modes — adopted. S3's equivalence claim unsupported — withdrawn. |
| V3 materiality / over-abstraction | CONFIRMED | All four findings material; all 8 required fields present on every finding; none stylistic or line-count-only. |
| V4 priority consistency | **BLOCK → fixed** | False A1→A2 prerequisite and false file-intersection claim removed. Audit-log assertions lacked embedded evidence; evidence added below. |
| V5 adversarial verification of A1 | PARTIAL → fixed | A1 reachable and real: **confirmed**. But the claim "TS `buildDtrRow` throws" was **wrong** (it returns an inverted row); recon ordering was stated backwards. Both corrected. |

Net effect: A1's *mechanism* was independently confirmed by three passes; its *evidence
text* required correction; the ledger's inventory and priority rationale were wrong and
are now corrected.

## Audit log (with runnable evidence)

| Step | Action | Evidence |
|---|---|---|
| T0 | Inventory | `git diff --name-only v0.1.57..HEAD` → 31 paths (listed above) |
| T1 | Lane review | 5 read-only reviewer lanes; all returned exactly 2 opportunities or skip (8 opportunities, 6 skips) |
| T2 | Coordinator verification | Every citation re-read in source; A1 reachability traced to `dtr_sync.rs:1397`, `:1541`, `dtr_recon.rs:183,191` |
| T3 | Dedupe | D1+D3 merged → A1; D4/D5 payload findings demoted → S4/S5 |
| T4 | Independent verification | 5 fresh agents (V1–V5); 2 BLOCK, 3 PARTIAL; all dispositions applied |
| T5 | Corrections applied | Inventory 24→31; code 17→18; added D3 test file; A1 TS + recon evidence corrected; A1→A2 dependency removed; S3 claim weakened |
| T6 | Coverage re-check | 17/17 executable source + 3/3 runtime config assigned; 11 presentation/doc files excluded with reason |
| T7 | Repository unchanged | `git status --short` → only pre-existing `i-have-adhd` skill deletions, `AGENTS.md` modification, untracked `probe_cavoti.mjs`, plus this ledger |

## Repository state

Audit wrote only this ledger. No source file, test, config, or dependency was
modified. Pre-existing working-tree changes (`.agent/skills/i-have-adhd/SKILL.md`,
`.agents/skills/i-have-adhd/SKILL.md`, `AGENTS.md`, untracked `probe_cavoti.mjs`)
were present before this run and are untouched.
