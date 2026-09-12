# Plan 03 — Payroll grid: single-line headers + sticky key columns

- Status: DONE 2026-09-12 — nowrap headers + sticky cols 1–3 (lefts 0/38/128,
  border-box exact); screenshot `13-payroll-proof` shows whole-word headers;
  typecheck + oxlint + 258/258 clean
- Current commit: `1294222`
- Surface: Admin → Payroll → draft payroll grid (24 columns, `min-width: 1980px`)
- Owners: `client/src/styles.css` `.payroll-table` block (:607–669+);
  markup `client/src/App.tsx` `:5816` (`payroll-table-with-bar`) and header row
  (~:5904, `Employee #`, `Standard days`, `Overtime`, …)

## Evidence (do not re-audit; verify before edit)

1. Tauri screenshot `03-payroll` (this session): headers wrap mid-word —
   `STANDA RD`, `INCENTIV ES`, `OVERTIM E`, `PHILHEAL TH`, `ADVANC E` — because
   `.payroll-table th` (`styles.css:648–663`) sets `white-space: normal` over
   narrow per-column `min-width`s (:665–669), while the table is `min-width:
   1980px` inside an `overflow-x: auto` wrap (:614–621, :640–646). Scrolling
   exists but is undiscoverable (styled thin scrollbar only) and scrolled content
   loses row identity (no sticky columns).
2. No `DESIGN.md` governs this; the correction reuses existing tokens
   (`--surface-raised`, `--line-bright`) and existing scroll container.

## Change (one change; CSS block only, no markup, no new dependencies)

1. In `client/src/styles.css`, inside the `.payroll-table` section:
   - `.payroll-table th`: change `white-space: normal` → `white-space: nowrap`.
   - Add sticky key columns (checkbox + Employee # + Employee name):
     `.payroll-table th:nth-child(-n+3), .payroll-table td:nth-child(-n+3) {
     position: sticky; left: 0; background: var(--surface-raised); z-index: 1; }`
     with cumulative `left` offsets matching the first columns' widths — measure
     from the rendered header (38px select col per :665) and set explicit lefts.
   - Keep `min-width: 1980px`, `table-layout: auto`, and the existing scrollbar
     styling untouched.

## Checks

- `npm test -w client -- src/App.test.tsx` exits 0 (payroll tests cover the grid).
- `npm run lint:oxlint` exits 0 (CSS untouched by oxlint; sanity only).
- Headful proof: screenshot Payroll at 1920px and at 1280px — headers render
  whole words; scrolling right keeps Employee #/name pinned.

## Risks

- Sticky offsets must match real column widths; if headers shift, adjust only the
  `left` values. Do not restyle the scrollbar or abbreviate header copy here.
