# tools/oxlint/anti-slop/
## Responsibility
- Implements/registers custom oxlint rules for explicit, evidence-backed TypeScript contracts.
## Design
- `index.ts` exports the `anti-slop` plugin; `rules/` contains diagnostics and `shared/` centralizes AST/type helpers.
- Rules report diagnostics, not rewrites, for safety comments, domain contracts, and unwanted coding patterns.
## Flow
- Registration maps kebab-case rule IDs to imported rule objects; visitors analyze syntax, aliases, and scopes.
- Dictionary/widening rules use shared classifiers; Reflect rules share global method resolution.
## Integration
- Uses `@oxlint/plugins` rule/ESTree/scope/source interfaces; parent: `../codemap.md`.
- Rule inventory: `rules/codemap.md`; helper contracts: `shared/codemap.md`.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
