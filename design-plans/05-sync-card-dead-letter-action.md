# Plan 05 — DTR sync card: give the dead-letter note its action

- Status: DONE 2026-09-12 — inline `Retry sync now` reusing `syncInterns`;
  screenshot `15-sync-card-proof` shows action beside the 803 dead-letter note;
  typecheck + oxlint + 258/258 clean
- Current commit: `1294222`
- Surface: Admin → Data and backup → DTR sync status card
- Owners: `client/src/App.tsx` DatabasePanel — card markup `:3586–3631`,
  dead-letter note `:3622–3625`, existing `syncInterns` handler + `busy` state
  (`:3760+` region, `Sync Intern DTR now` button at `:3573` owns the action)

## Evidence (do not re-audit; verify before edit)

1. Tauri screenshot `02-data-backup-sync-health` (this session): with status
   `Attention`, the card reads `Last sync: — · 803 failed item(s) need attention`
   plus `Last error: Google Sheets sync failed` — an error/attention state whose
   only remedy (`Sync Intern DTR now`) sits outside the card with no link between
   them. Baseline rule: errors show next to where the action happens; empty/attention
   states carry one clear next action.
2. The correction reuses the existing `syncInterns` owner — no new handler, no new
   command, no copy invention beyond pointing at the existing button's action.

## Change (one change; markup only, same component)

1. In `client/src/App.tsx`, in the dead-letter branch of the sync-health note
   (`:3622–3625`), append an inline action reusing the existing handler:
   `{syncHealth && syncHealth.deadLetter > 0 ? (
     <> · {syncHealth.deadLetter} failed item(s) need attention{' '}
       <button className="text-button" type="button" disabled={busy}
         onClick={() => void syncInterns()}>Retry sync now</button>
     </> : ""}`
   Keep the surrounding `Last sync:` sentence and styling untouched.

## Checks

- `npm run typecheck -w client` exits 0.
- `npm test -w client -- src/App.test.tsx src/database-panel.test.tsx` exits 0.
- `npm run lint:oxlint` exits 0.
- Headful proof: screenshot Data & backup with dead letters — note reads
  `… need attention · [Retry sync now]`; clicking it runs the same sync path as
  the existing button (badge flips to `Syncing`).

## Risks

- `busy`/`syncInterns` must be in scope at the note's location (same component —
  verify while editing). If the note moves, move the button with it.
