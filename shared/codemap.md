# shared/

## Responsibility
- Private `@rfid-attendance/shared` TypeScript package publishes contracts and policy shared by the server and desktop attendance application.

## Design
- Package entry points resolve to compiled `dist/api-contracts.js` and declarations; `src/api-contracts.ts` re-exports the office identity module.
- Literal unions, discriminated response types, and shared constants keep wire contracts and attendance/payroll policy consistent across runtimes.
- `office.ts` centralizes structured company/office identity and address display composition, with explicit display overrides and safe fallback.

## Flow
- Consumers import contracts/policy from the package root → `api-contracts.ts` exports scanner, attendance, LAN, admin/setup, payroll, bathroom, and generated-file models.
- Attendance helpers evaluate Manila arrivals and weekly grace, count workdays, and normalize names; payroll consumers use the shared intern rates and cutoff record/profile shapes.
- Office configuration enters through `OfficeIdentity` → formatting helpers compose short/full addresses and metadata for display/export.

## Integration
- Server imports contracts for Express request/response payloads, error codes, payroll rules, and office identity; desktop code shares the same API and payroll types.
- `npm run build` emits package artifacts; `typecheck`, `lint`, and `test` operate on this package independently.
