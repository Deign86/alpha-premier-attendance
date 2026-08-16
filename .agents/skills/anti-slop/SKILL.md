---
name: anti-slop
description: Enforce high-evidence TypeScript and JavaScript patterns using the anti-slop Oxlint rules. Use when writing, modifying, reviewing, or remediating TypeScript and JavaScript code to ensure all types are supported by compiler evidence rather than unjustified assertions, open dictionaries, or low-evidence runtime checks.
---

# Anti-Slop Guidelines & Skill for Antigravity 2.0

Anti-slop rejects low-evidence, low-signal TypeScript and JavaScript patterns that fabricate certainty or disguise weak contracts.

## Key Rules & Enforcement

1. **Safety Comments for Type Assertions (`anti-slop/require-safety-comment-for-type-assertion`)**:
   - Any non-const type assertion (`as T`) MUST be immediately preceded by a `// SAFETY: <explanation>` comment clearly stating the invariant or domain proof that guarantees correctness.

2. **No Chained Type Assertions (`anti-slop/no-chained-type-assertions`)**:
   - Do not double-cast (`expr as unknown as Target` or `expr as any as Target`). Parse at the boundary or refine the type safely.

3. **No Conditional Empty Object Spread (`anti-slop/no-conditional-empty-object-spread`)**:
   - Avoid `...(condition ? { key: val } : {})`.
   - Build objects explicitly using imperative branches or structured helpers with optional properties.

4. **No Known Value Widening (`anti-slop/no-known-value-widening`)**:
   - Do not annotate object literals with broad open dictionary types (e.g. `Record<string, string>`).
   - Keep TypeScript inference, validate using `satisfies`, or define explicit domain interfaces.

5. **No Runtime Typeof for Domain Verification (`anti-slop/no-runtime-typeof`)**:
   - Do not use `typeof x === 'string'` or `typeof x === 'object'` to lazily branch on domain data.
   - Parse input cleanly at the I/O boundary (using explicit validators or schema parsers) and branch on verified domain models.

6. **No Unknown Parameters or Returns (`anti-slop/no-unknown-parameters`, `anti-slop/no-unknown-returns`)**:
   - Never expose `unknown` or `any` in internal function contracts.
   - Accept named domain types or generic parameters bounded by schema parsers.

7. **No Unsafe Dictionary Types (`anti-slop/no-unsafe-dictionary-type`)**:
   - Avoid generic `Record<string, any>` dictionaries. Use strict mappings, Maps, or typed structs.

8. **No Module Mocking (`anti-slop/no-module-mocking`)**:
   - In tests, prefer dependency injection and faithful test doubles over `vi.mock()` / `jest.mock()`.

## Installation & Maintenance

- Vendored rules reside in `tools/oxlint/anti-slop/`.
- Configured in `oxlint.config.ts`.
- Run validation via: `npx oxlint --config oxlint.config.ts shared/src server/src client/src`
