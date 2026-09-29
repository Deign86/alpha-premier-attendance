# tools/oxlint/anti-slop/shared/
## Responsibility
- Shared AST utilities for type/dictionary analysis, lexical type-parameter scoping, and global Reflect-call recognition.
## Design
- `dictionary-types.ts` builds environments and classifies unsafe values/broad targets, resolving wrappers, aliases, generics, and mapped types.
- `lexical-type-parameters.ts` finds binders shadowing aliases; `reflect-method.ts` resolves global Reflect calls vs local bindings.
## Flow
- Rules pass ESTree nodes/environments to classifiers, which return classifications without diagnostics; reflection checks resolve callee scope.
## Integration
- Imported by `../rules/`; AST/scope contracts come from `@oxlint/plugins`; no application runtime entry point.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
