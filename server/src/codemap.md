# server/src/

## Responsibility
- Implements the Express API, attendance/setup/admin services, Sheets persistence, and payroll computation/sync operations.

## Design
- `app.ts` is the HTTP boundary; `attendance.ts`, `setup.ts`, and `admin.ts` own application rules and translate invalid states into domain errors.
- `sheets.ts` defines `GoogleSheetsService`, row contracts, in-memory indexed storage, and a Google Sheets adapter that validates/reconciles headers and performs row-level writes.
- RFID identity and Manila time are normalized in `rfid.ts` and `time.ts`; `mutex.ts` serializes attendance by user and intern weekly-grace claims by user/week.
- Per-attendance payroll (`payroll.ts`) dispatches to intern/employee engines; cutoff payroll is assembled in `admin.ts` and calculated by `cutoff-payroll.ts`.

## Flow
- Startup: `index.ts` → `loadConfig()` → `createServiceFromEnv()` → `createApp()` → `listen()`; Google mode ensures spreadsheet tabs before binding.
- Scan: `POST /api/attendance/scan` or `/api/scan` → `AttendanceService.scan` → normalize UID/find active user → resolve optional admin-assist target → keyed mutex → find/create/update today's attendance → ensure payroll on completion → audit and shared `ScanResponse`.
- Admin correction: route session verification → `AdminService` validation and Sheets mutation → payroll reconciliation/deletion as appropriate → audit; cutoff save builds employee/intern `CutoffInput` → `calculateCutoffPayroll` → cutoff sheet upsert.
- Intern DTR CLI: `sync-intern-dtr.ts` reads local SQLite → `planPush` resolves person tab/month/date and B:E values → optional `executePush` writes rows → format planning and absent sweep batch-update the sheet.

## Integration
- `app.ts` routes consume shared contracts and config, with setup/admin errors handled separately from scan errors; request IDs flow into responses and audit events.
- Service persistence is exclusively through `GoogleSheetsService`; its Google implementation uses Google Sheets/Drive APIs and maps validated tab rows to typed records.
- `intern-dtr-sync.ts` is the pure planning layer for the sync CLI; `lunch-break.ts` provides shared payroll clock math and DTR time-out capping.
- Shared policy/types come from `@rfid-attendance/shared`; standalone scripts `validate-sheets.ts`, `migrate-payroll-sheets.ts`, and `backfill-payroll.ts` check deployment prerequisites.
