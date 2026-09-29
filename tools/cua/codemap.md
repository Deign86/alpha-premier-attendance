# tools/cua/
## Responsibility
- Shared CUA harness for Tauri window targeting, fresh surface capture/assertion, and evidence recording.
## Design
- `target.ts` resolves scenario tokens/windows through `cua-driver` and pins geometry to 1280×800.
- `assert.ts`/`fresh-snapshot.ts` enforce fresh post-action capture; `cases/` supplies scenario drivers and predicates.
- `verdict.ts` adapts scrubbed text to JEV; `evidence.ts` persists scrubbed artifacts.
## Flow
- Resolve target → drive/invoke → capture DOM/IPC → assert → judge → write evidence; assertions consume unique snapshot IDs.
- `captureSurface` reads window state, DOM (fallback: `find_element`), then IPC; evidence records verdict/elements and recording or recorder-absent frames/NOTE.
## Integration
- `scripts/cua-jev-run.mjs` orchestrates live runs; `scripts/cua-jev-doctor.mjs` checks readiness.
- Bridge: `ws://127.0.0.1:9223`; target discovery: `cua-driver`; verdict integrates JEV redaction/policy/client/audit; tests: `__tests__/`.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
