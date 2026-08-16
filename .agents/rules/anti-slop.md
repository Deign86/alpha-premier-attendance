# Anti-Slop Coding Guidelines

Enforce rigorous type safety and reject low-evidence TypeScript/JavaScript patterns across the repository.

## Non-Negotiable Rules

1. **Explicit Safety Comments**: Every non-const type assertion (`as Type`) must be immediately preceded by a `// SAFETY: <explanation>` comment explaining why the invariant is guaranteed.
2. **No Double Casting**: Never use chained type assertions (`as unknown as Type`, `as any as Type`).
3. **No Conditional Empty Object Spread**: Do not write `...(cond ? { k: v } : {})`. Construct objects explicitly with statements or structured helpers.
4. **No Broad Dictionary Widening**: Do not widen objects to `Record<string, ...>` or `Record<string, unknown>`. Use inference, `satisfies`, or domain interfaces.
5. **No Low-Evidence Runtime `typeof`**: Validate boundary inputs with structured schemas or shape validators; branch on domain models instead of ad-hoc primitive checks.
6. **No `unknown` / `any` Parameters or Return Types**: Internal function interfaces must use domain types.
7. **Verification**: Always run `npm run lint:oxlint`, `npm run typecheck`, and `npm test` before committing.
