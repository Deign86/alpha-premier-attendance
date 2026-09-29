# tools/oxlint/anti-slop/rules/
## Responsibility
- Individual oxlint rules for unsafe types, weak evidence, assertions, dynamic access, and test patterns.
## Design
- Type rules cover unknown contracts, broad `object`, unsafe dictionaries, known-value widening, and widen-then-assert flows.
- Other rules require `SAFETY:` comments; reject chained assertions, empty-object conditional spreads, forbidden symbol names, runtime `typeof`, Reflect access, and module mocks.
## Flow
- Modules export `defineRule` objects; visitors resolve annotations, aliases, scopes, or global calls and report matches.
- `anti-slop/index.ts` registers rules under their public kebab-case IDs.
## Integration
- Type analysis uses `../shared/dictionary-types.ts` and `../shared/lexical-type-parameters.ts`; Reflect rules use `../shared/reflect-method.ts`.
- All rules consume Oxlint ESTree/plugin APIs.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
