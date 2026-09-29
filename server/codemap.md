# server/

## Responsibility
- Node/Express backend package: serves attendance, setup, admin, and payroll APIs backed by Google Sheets or an in-memory adapter.
- Includes operator CLIs for sheet validation, payroll-tab checks, and intern-DTR export.

## Design
- ESM TypeScript; `npm run dev` launches `src/index.ts` with `tsx`, while `build` compiles `src` to `dist`.
- `@rfid-attendance/shared` supplies API contracts and common attendance/payroll policy; Google Sheets is the production persistence adapter.
- `SHEETS_MODE` selects Google Sheets or memory; production config rejects memory mode.

## Flow
- `src/index.ts` loads environment config → creates/ensures `GoogleSheetsAdapter` or `InMemorySheetsService` → injects both into `createApp` → listens on configured host/port.
- Express routes delegate scan processing to `AttendanceService`, setup routes to `SetupService`, and authenticated admin routes to `AdminService`.
- `AttendanceService.scan` resolves the card and date row under a per-user mutex, writes attendance, then invokes `PayrollService` for completed rows.
- `AdminService` handles user/attendance corrections and cutoff payroll; CLI scripts separately validate schemas or plan/push kiosk DTR rows to the intern workbook.

## Integration
- `src/app.ts` exposes `/api/*`, secures requests with Helmet/CORS/rate limiting, and optionally serves the built client.
- `src/sheets.ts` implements the `GoogleSheetsService` contract over Sheets tabs (Users, Attendance, AuditLogs, Payroll, InternGrace, PayrollProfiles, PayrollCutoffs); memory adapter supports tests and local mode.
- Server package scripts cover build/typecheck/lint/test plus `validate:sheets`, `migrate:payroll`, `backfill:payroll`, and `sync:intern-dtr`.
