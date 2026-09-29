# shared/src/

## Responsibility
- Defines cross-runtime API contracts and attendance/payroll policy in `api-contracts.ts`; defines canonical company/office identity formatting in `office.ts`.

## Design
- `api-contracts.ts` exports literal-backed unions, record/request/response types, and pure policy helpers without server or UI dependencies.
- Manila-time helpers evaluate arrivals/grace and late time-outs; date helpers calculate Monday week starts/workdays, while normalization standardizes names.
- `office.ts` owns typed structured fields, defaults, address composition, explicit display overrides, fallback resolution, and printable metadata lines.

## Flow
- Package-root imports enter through `api-contracts.ts`, which re-exports `OfficeIdentity` and `office.ts` helpers alongside domain contracts.
- Server scan/payroll consumers use `evaluateArrivalWithBudget`, `getManilaWeekStart`, shared status/error/source unions, and intern rate constants.
- Server and desktop screens/exports pass `OfficeIdentity` through `resolveOfficeDisplay` or `officeMetadataLines`; empty overrides fall back to composed structured address and then safe display text.

## Integration
- `api-contracts.ts` contracts cover kiosk scans, setup/admin, attendance/LAN, bathroom-key logs, payroll, generated files, and TTS; server `app.ts`, services, and Sheets mapper consume these types.
- The package compiles this source directory to `dist`; tests colocated here cover contracts and office helper behavior (test files are not production modules).
