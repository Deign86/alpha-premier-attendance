# tools/
## Responsibility
- Developer tooling for the CUA harness, JEV evaluators, and custom oxlint rules.
## Design
- `cua/` owns automation primitives and cases; it delegates judgment to `jev/`.
- `jev/` handles bounded attendance, payroll, and correction choices; `oxlint/anti-slop/` registers custom lint rules.
## Flow
- CUA target/capture and case predicates produce text evidence; verdict logic sanitizes and routes it through JEV.
- JEV validates, applies deterministic guards, calls `JevClient` when enabled, and audits results; Oxlint loads registered AST rules.
## Integration
- Live CUA entry point: `scripts/cua-jev-run.mjs`; evidence: `evidence/cua-jev/`.
- JEV uses `TYPESAFE_API_KEY`, `JEV_ENABLED`, TypeSafe System One, and Vitest tests; lint rules use `@oxlint/plugins`.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
