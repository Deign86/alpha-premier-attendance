# tools/jev/
## Responsibility
- JEV evaluators/transport for attendance anomalies, payroll reviews, and manual attendance corrections.
## Design
- `types.ts` defines bounded choices/results; `schemas.ts` validates inputs and TypeSafe Choice responses.
- `redaction.ts` pseudonymizes/sanitizes; `policy.ts` resolves settings/fallbacks; `evaluators.ts` applies guardrails, thresholds, and auditing.
## Flow
- Validate → build state/rubric → `JevClient` checks policy/key and calls System One with timeout/retries → classify result/fallback → audit.
- `index.ts` exports APIs; `cli.ts` runs developer scenarios; `audit.ts` retains a bounded in-memory ledger and notifies subscribers.
## Integration
- Environment: `JEV_ENABLED`, `TYPESAFE_API_KEY`; endpoint: `https://api.typesafe.ai/v1/systemone`; tests may inject fetch/client.
- `__tests__/` covers schemas, redaction, policy, transport, audit, evaluators, and optional live integration.
<!-- Fixer: Fill in this section with architectural understanding -->
## Responsibility
<!-- What is this folder's job in the system? -->
## Design
<!-- Key patterns, abstractions, architectural decisions -->
## Flow
<!-- How does data/control flow through this module? -->
## Integration
<!-- How does it connect to other parts of the system? -->
