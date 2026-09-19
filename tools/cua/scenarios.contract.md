# CUA + JEV scenario contract (no product code)

Wave plan: session `ses_f483e9013ffewqvkvimhi6TOT7`. This file is the contract only.
Runner/harness implementation comes later; do not add product `.ts`/`.mjs` here.

## Reuse (not duplicate)

- Launch / doctor / cleanup: `.agents/skills/verify-alpha-premier-attendance/SKILL.md`
  (`npm run tauri:dev`, ready = Vite `127.0.0.1:5173` + bridge `ws://127.0.0.1:9223` +
  window; cleanup = `tauri_driver_session stop` + kill by exact PID).
- Scripts: `package.json` `doctor:mcp` (`scripts/doctor-tauri-mcp.mjs`),
  `verify:mcp` (`scripts/verify-tauri-mcp.mjs`), `jev:eval` (`npx tsx tools/jev/cli.ts`),
  `jev:test`.
- JEV gate: `tools/jev/policy.ts:16` (`JEV_ENABLED === 'true'`),
  `tools/jev/client.ts:36` + `tools/jev/cli.ts:13` (`TYPESAFE_API_KEY` env-only).
- Target: Tauri main `1280x800`, devUrl `127.0.0.1:5173`, bridge `ws://127.0.0.1:9223`,
  API `:3001`.

## Global rules (all scenarios)

1. `JEV_ENABLED=true` + `TYPESAFE_API_KEY` from env only. No `VITE_` key, no dotenv
   changes, no edits to `tools/jev/*` or the verify skill.
2. JEV confidence threshold for this wave: **0.8**
   (code default in `tools/jev/policy.ts` is 0.7; the wave gate is stricter).
3. **CUA fresh-snapshot rule**: never assert on a click return. After every
   click, take a fresh snapshot (`tauri_webview_dom_snapshot` /
   `tauri_webview_find_element` / `tauri_webview_screenshot`) and assert on that.
4. **JEV text-only**: JEV judges OCR/DOM text + IPC/logs tail only. Screenshots are
   human/CUA evidence, never JEV input pixels.
5. Evidence per scenario id under `evidence/cua-jev/<id>/`
   (screenshot + DOM/IPC capture + JEV log tail). Bathroom state is desktop-only
   evidence (Express keeps a separate in-memory bathroom store).

## JEV state fields (recorded per verdict)

`decision`, `confidence`, `probabilities`, `status` (`ok` | `fallback`),
`fallbackReason` (when `status: fallback`), `model`, `latencyMs`.
PASS additionally requires `status: ok` and `confidence >= 0.8`.

---

## CUA-JEV-01 (happy: kiosk tap to success)

- Test id: `CUA-JEV-01`
- Steps:
  1. Doctor passes; start `npm run tauri:dev`; confirm Vite `:5173` + bridge `:9223`.
  2. Pin window frame `1280x800`; open kiosk `/` (attendance mode).
  3. CUA clicks the record/submit control by fresh-screenshot pixels
     (`[data-testid="kiosk-record-submit"]` re-audited via Tauri right before).
  4. Inject the tap via `core.invoke` (`rfidUid`, camelCase keys per skill).
  5. Fresh DOM snapshot; read result text + `attendance-updated` IPC tail.
  6. JEV judges the fresh text (success + photo + name visible).
- Binary PASS predicate: fresh snapshot shows `kiosk-result-success` with employee
  name/photo AND `attendance-updated` fired AND JEV `decision: success`,
  `status: ok`, `confidence >= 0.8`.
- Real surface: `evidence/cua-jev/CUA-JEV-01/` screenshot + DOM snapshot +
  `tauri_ipc_get_captured` tail.
- JEV state fields: `decision`, `confidence`, `probabilities`, `status`,
  `fallbackReason`, `model`, `latencyMs`.

## CUA-JEV-02 (edge: unknown UID + duplicate cooldown)

- Test id: `CUA-JEV-02`
- Steps:
  1. Same launch/pin as CUA-JEV-01, kiosk `/` attendance mode.
  2. Part A (unknown UID): invoke tap with an unregistered UID; fresh snapshot.
  3. JEV judges the fresh text (unknown-card state, no success element).
  4. Part B (duplicate cooldown): invoke the same known UID twice in quick
     succession; fresh snapshot after the second.
  5. JEV judges the fresh text (duplicate-cooldown state, single attendance row).
- Binary PASS predicate: Part A shows unknown-card state with zero new attendance
  rows AND Part B shows duplicate-cooldown state with exactly one row for the UID
  AND JEV `decision: edge_handled` on both parts, `status: ok`,
  `confidence >= 0.8`.
- Real surface: `evidence/cua-jev/CUA-JEV-02/` screenshots (one per part) + DOM
  snapshots + IPC tail showing the cooled-down second tap.
- JEV state fields: `decision`, `confidence`, `probabilities`, `status`,
  `fallbackReason`, `model`, `latencyMs` (recorded separately for Part A / B).

## CUA-JEV-03 (regression: bathroom checkout to return)

- Test id: `CUA-JEV-03`
- Steps:
  1. Same launch/pin as CUA-JEV-01; switch kiosk to bathroom mode.
  2. Checkout `MALE` key via invoke (`genderKey: MALE`, camelCase); fresh snapshot
     shows holder + elapsed timer (`bathroom-kiosk-status`, `bathroom-kiosk-holder-male`).
  3. Return the key; fresh snapshot shows `AVAILABLE` + log row with duration.
  4. JEV judges the fresh text sequence (checkout state, then returned state).
- Binary PASS predicate: checkout snapshot shows holder + running timer AND
  return snapshot shows `AVAILABLE` with a `RETURNED` log row carrying a duration
  AND JEV `decision: returned`, `status: ok`, `confidence >= 0.8`.
- Real surface: `evidence/cua-jev/CUA-JEV-03/` screenshots (checkout + return) +
  DOM snapshots + `bathroom_log` IPC verification (desktop-only evidence).
- JEV state fields: `decision`, `confidence`, `probabilities`, `status`,
  `fallbackReason`, `model`, `latencyMs`.
