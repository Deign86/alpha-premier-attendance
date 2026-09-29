# tools/oxlint/
## Responsibility
- Custom Oxlint rules enforcing repository anti-slop TypeScript contracts.
## Design
- `anti-slop/index.ts` registers `anti-slop/rules/`; `anti-slop/shared/` supplies reusable AST/type-resolution helpers.
- Rules reject weak types, unsafe assertions/broadening, runtime type checks, module mocks, and low-evidence APIs.
## Flow
- Oxlint loads the plugin → visitors inspect ESTree nodes, scope, and aliases → diagnostics mark contract violations.
- Type-focused rules build per-program environments before analyzing dictionaries and typed flows.
## Integration
- Rule modules use `defineRule` / `eslintCompatPlugin` from `@oxlint/plugins`; IDs are registered in `anti-slop/index.ts`.
- Lint configuration/commands consume the plugin; it has no application runtime path.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
