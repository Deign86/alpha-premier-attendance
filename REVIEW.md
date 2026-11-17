# Review guide

How to review a change to this repository. Reviewers (human or agent) read this
file **from the base branch**, never from the pull request under review: a
change must not be able to edit the rules it is judged by. A review belongs to
one commit; after a new push, review again.

Tag every finding **Important** (must fix before merge), **Nit** (optional) or
**Pre-existing** (real, but not introduced by this change; do not block on it).

## Always

- The pull request says how it was verified (see "Verified:" in AGENTS.md) and
  the claim matches what the diff could have exercised.
- No test was skipped, retried, given a sleep or loosened to get green.
- No type assertion without a `// SAFETY:` comment; no new dependency for
  something the standard library or an installed package already does.

## Checklist by diff trigger

Check only the rows whose trigger appears in the diff.

| If the diff touches | Check |
|---|---|
| `src-tauri/src/services/intern_payroll.rs` | A released `PolicyVersion` or a cutoff date is not edited: rule changes are a new version with its own effective date, a new row in `released_policy_versions_are_frozen`, and a new column in `docs/payroll-policy.md`. |
| `src-tauri/src/services/intern_payroll.rs` | The property tests (`property_*`, `differential_*`) still pass unchanged. If one was edited, the pull request names the rule that changed and why the old property no longer holds. |
| Late, grace, undertime or half-day rules anywhere else (`lib.rs`, `reporting/`, `client/`, `shared/`) | Important: day pricing, arrival status and Breakdown day lines belong only in `services/intern_payroll.rs`. Other code reads the stored result. |
| `shared/payroll-fixtures.json` | Values came from running the Rust engine, not by hand; `shared/src/payroll-fixtures.pin.test.ts` is updated in the same change. |
| `WEEKLY_GRACE_RESUME_DATE` or `NO_GRACE_CUTOFF_DATE` | The Rust constant and the TypeScript constant in `shared/src/api-contracts.ts` are equal. |
| Payslip or payroll totals (`reporting/mod.rs`, `intern-payslip-image.ts`, payroll parts of `App.tsx`) | Total earnings minus total deductions equals net pay, and nothing that lowers pay is shown on the earnings side. |
| `payroll_cutoffs` writes or finalize (`lib.rs`) | A finalized cutoff and the days inside it are never re-priced or rewritten. |
| `src-tauri/db/migrations/` | New numbered file only; no edit to a released migration; old rows still load. |
| Attendance scan, time-out or correction paths (`lib.rs`) | The payroll row and the weekly grace claim are written in the same transaction as the attendance change. |
| `services/sheets_sync.rs`, `services/dtr_sync.rs` | SQLite stays the source of truth; a sheet failure never blocks a scan; DTR rows keep actual stamps. |
| `.github/workflows/` | Pull-request triggers have no `paths-ignore` (required checks would never run); the three required check names are unchanged. |
| `REVIEW.md`, `.claude/settings.json`, `scripts/verify-changed.mjs`, `AGENTS.md` | Important: the change weakens no check. A removed rule states which miss it no longer guards against. |
| `client/src/styles.css` or new UI | Uses existing tokens; one accent per view; states for empty, loading and error. |

## Keeping this file useful

- Add a row when a bug reached `main` that a diff-visible trigger would have
  caught. Say which bug in the pull request.
- Remove a row that has not caught anything and whose code is gone. This file,
  `GATES.md` and the test suites only grow if nobody prunes them.
