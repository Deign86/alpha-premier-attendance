# tools/cua/cases/
## Responsibility
- CUA harness scenario drivers/assertions for kiosk attendance, edge handling, and bathroom checkout/return regression.
## Design
- `happy.ts` runs CUA-JEV-01 foreground click, RFID `core.invoke`, and fresh success/photo polling.
- `edge.ts` defines CUA-JEV-02 unknown-UID/cooldown invokes, selectors, predicates, and UID redaction.
- `regression.ts` defines CUA-JEV-03 return snapshots and desktop-SQLite log transition assertions.
## Flow
- Invoke Tauri commands → capture fresh post-action text → run case predicates; click/invoke returns are not assertions.
- JEV verdict mapping lives in `../verdict.ts`; standalone bathroom regression skips without desktop SQLite/Tauri webview.
## Integration
- `scripts/cua-jev-run.mjs` loads cases; shared target/freshness contracts: `../target.ts`, `../fresh-snapshot.ts`.
- RFID args follow `client/src/tauri-api.ts` lowerCamelCase; logs scrub UIDs and avoid raw PII.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
