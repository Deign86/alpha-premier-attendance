# Rust test parity on Windows

`cargo test --lib` must still be run in CI. On some Windows developer machines
the lib test executable cannot start (`STATUS_ENTRYPOINT_NOT_FOUND`), so a
successful focused integration test run is **not** evidence that the complete
lib suite passed.

## What the Windows isolated binaries cover

The integration targets in `src-tauri/tests/` include selected source modules
directly to avoid loading the Tauri/WebView2 native dependencies:

| Integration target | Included source and resulting unit-test coverage |
| --- | --- |
| `intern_payroll_isolated` | `services/{payroll,employee_payroll,lunch_break,intern_payroll,cutoff_payroll}.rs`, plus target-level payroll/SQLite contract cases |
| `payroll_hours_accuracy` | `services/{payroll,employee_payroll,lunch_break,intern_payroll}.rs`, plus target-level Rust-hours contract vectors |
| `payroll_sheet_undertime` | `reporting/mod.rs`, `services/{payroll,lunch_break}.rs`, plus the PDF undertime regression |
| `cutoff_freeze` | `services/cutoff_payroll.rs`, plus target-level cutoff contract cases |

Each source module's `#[cfg(test)]` tests also compile when that module is
included by an integration target. These targets overlap, but they do not
cover the rest of the library: tests in `lib.rs` and other modules (including
`database`, `state`, `config`, `paths`, `lifecycle`, `lan_*`, TTS, and other
services) remain **lib-only** unless a future isolated target explicitly
includes them. The current isolated targets also do not exercise lib-level
command wiring. Do not treat this list as parity for the full library suite.

## Required verification

- CI's serialized full `cargo test -- --test-threads=1` remains authoritative.
- On Windows machines where the lib executable cannot load, run the relevant
  isolated target(s), but record the lib suite as blocked—not passed.
- When adding or changing a behavior-lock test, check its module against the
  table above. If it is not included, either add a safe isolated counterpart
  or call out that the assertion is CI-only; never infer parity from a related
  test in another module.
- Payroll grace tests should pass `grace_available` explicitly for each case
  and use fixed attendance dates. Do not use the host's current date or
  weekday to build Manila weekly-grace expectations.

## Golden fixture contract

`shared/payroll-fixtures.json` (version 2) is owned by the Rust engine. Section ownership: `baseInput` and `cutoffCases` are asserted by `cutoff_freeze`, `internDaily` by `payroll_hours_accuracy` (together with the invariant sweeps), and `internCutoffs` by `intern_payroll_isolated`. Rust is the only payroll engine of record; the TypeScript copy in `server/src` is legacy and has its own fixture under `server/test/fixtures/`.
