# Plan 02 — Users table: keep Payroll-profile cell on one line

- Status: DONE 2026-09-12 — one class added; screenshot `12-users-table-proof`
  shows every Payroll-profile cell single-line; typecheck + oxlint + 258/258 clean
- Current commit: `1294222`
- Surface: Admin → Users and RFID → users table, Payroll-profile column
- Owners: `client/src/App.tsx` UserEditor table (:4577–4588);
  existing token `.user-status-cell` (`client/src/styles.css`:1419–1421,
  `white-space: nowrap`), already used by the RFID (:4576) and Status (:4589) cells

## Evidence (do not re-audit; verify before edit)

1. Tauri screenshot `01-app-overview` (this session): the Payroll-profile column
   renders `Not applicabl e` — broken mid-word across two lines — while the RFID
   and Status cells in the same rows stay single-line (`user-status-cell`).
   Same column, contradictory presentation = in-scope contradiction.
2. Source: the `td` at `App.tsx:4577` (`{user.cardType === "ADMIN_ASSIST" ? … :
   … : "Not applicable"}`) is the only unwrapped cell in that row; the fix reuses
   the sibling cells' owner, no new CSS.

## Change (one change; one class attribute)

1. In `client/src/App.tsx`, add `className="user-status-cell"` to the `td` at
   line 4577 (the payroll-profile cell). No copy change (`Not applicable` stays),
   no CSS change. `table-layout: auto` widens the column; overflow continues to
   scroll in the existing `.table-wrap`.

## Checks

- `npm run typecheck -w client` exits 0.
- `npm test -w client -- src/App.test.tsx` exits 0 (voice-slot test covers this row).
- `npm run lint:oxlint` exits 0.
- Headful proof: screenshot Users/RFID — every Payroll-profile cell single-line.

## Risks

- None known. If the column grows too wide on small windows, file a follow-up plan
  (abbreviation copy); do not invent `N/A` copy inside this plan.
