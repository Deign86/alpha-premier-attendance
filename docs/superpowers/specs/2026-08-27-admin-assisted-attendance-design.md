# Admin-Assisted Attendance and Backdated Manual Entry Design Spec

## Scope

Alpha Premier Attendance requires two related capabilities enabling designated administrators to record attendance on behalf of employees who physically reported to work:

1. **Feature A: Admin RFID (Same-Day Live Assist)**: A dedicated physical RFID card assigned to administrators that shifts the kiosk into "Assisted Attendance" mode when scanned, letting the admin record a live `TIME_IN` or `TIME_OUT` for an active employee who forgot their card on the same day.
2. **Feature B: Backdated Manual Time-In (Past-Date Missed Attendance)**: An admin-panel action within the PIN-gated attendance screen allowing an admin to create a new attendance record for an employee on a past date where no attendance record currently exists.
3. **Card Registration Evolution**: Extending the card registration dialog and admin user management to register cards either as a normal "Employee card" or an "Admin RFID card" (unbound to employee attendance).
4. **Unified Audit-Trail & Reporting**: A shared data and audit design distinguishing card-scanned attendance from admin-assisted live scans and backdated manual entries across the live dashboard, admin table, exports (CSV/XLSX), and payroll calculations.

---

## Architecture & Data Contracts

### 1. Card Type Distinction
A card is explicitly registered with a `card_type` discriminator:
- `'EMPLOYEE'`: Normal card assigned to a worker; records attendance for that worker when scanned.
- `'ADMIN_ASSIST'`: Administrative card; never records attendance for itself. Tapping it on the kiosk initiates Assisted Attendance mode.

```ts
export const cardTypes = ['EMPLOYEE', 'ADMIN_ASSIST'] as const;
export type CardType = (typeof cardTypes)[number];
```

### 2. Scan Sources & Audit Metadata
Attendance records capture how and by whom the entry was recorded:
- `ScanSource`: `'RFID' | 'MANUAL_TEST' | 'ADMIN_ASSISTED_SCAN' | 'ADMIN_BACKDATED_ENTRY'`
- `recordedBy`: Admin identifier or display name who authorized the override.
- `recordedReason`: Mandatory reason string explaining why the entry was created on behalf of the employee.
- `recordedAt`: Manila ISO-8601 timestamp when the administrative action occurred (distinct from the attendance timestamp itself).

### 3. Error Codes
Consistent error handling across Express and Tauri:
- `ADMIN_CARD_REQUIRES_SELECTION`: Admin assist card scanned on attendance endpoint without employee target.
- `ATTENDANCE_ALREADY_EXISTS_FOR_DATE`: Attempt to backdate manual attendance for a date that already has an attendance row.
- `BACKDATE_LIMIT_EXCEEDED`: Attempt to backdate attendance into a finalized/locked payroll cutoff period or invalid date range.

---

## Database Migration (`src-tauri/db/migrations/0011_admin_assist_and_audit.sql`)

1. **Users Schema Extension**:
   ```sql
   ALTER TABLE users ADD COLUMN card_type TEXT NOT NULL DEFAULT 'EMPLOYEE' CHECK (card_type IN ('EMPLOYEE', 'ADMIN_ASSIST'));
   ```
2. **Attendance Schema Extension**:
   ```sql
   ALTER TABLE attendance ADD COLUMN recorded_by TEXT;
   ALTER TABLE attendance ADD COLUMN recorded_reason TEXT;
   ALTER TABLE attendance ADD COLUMN recorded_at TEXT;
   ```
3. **Database-Level Constraint (Schema Enforcement)**:
   Prevent admin cards from recording attendance for themselves at the engine level:
   ```sql
   CREATE TRIGGER IF NOT EXISTS trg_prevent_admin_card_attendance
   BEFORE INSERT ON attendance
   FOR EACH ROW
   WHEN EXISTS (
       SELECT 1 FROM users
       WHERE users.user_id = NEW.user_id
         AND users.card_type = 'ADMIN_ASSIST'
   )
   BEGIN
       SELECT RAISE(ABORT, 'Cannot record attendance for admin assist card');
   END;

   CREATE TRIGGER IF NOT EXISTS trg_prevent_admin_card_attendance_update
   BEFORE UPDATE OF user_id ON attendance
   FOR EACH ROW
   WHEN EXISTS (
       SELECT 1 FROM users
       WHERE users.user_id = NEW.user_id
         AND users.card_type = 'ADMIN_ASSIST'
   )
   BEGIN
       SELECT RAISE(ABORT, 'Cannot record attendance for admin assist card');
   END;
   ```

---

## Feature A: Admin RFID (Same-Day Live Assist)

### Workflow
1. **Tap Detection**:
   When an RFID card with `card_type == 'ADMIN_ASSIST'` is scanned on the kiosk, `scan_rfid` / `submitScan` detects the admin card flag.
   - It does **not** insert or update attendance for the admin card.
   - It returns `{ success: true, action: 'ADMIN_ASSIST', adminCard: { rfidUid, label }, activeEmployees: [...] }`.
2. **Kiosk State Transition**:
   The kiosk opens the **Assisted Attendance Modal**:
   - Displays admin card identifier/label (e.g., "Front desk admin card #1").
   - Presents a searchable selector of `ACTIVE` employees (name, ID, department, photo).
   - Allows manual UID lookup as a fallback.
   - Reason selector: defaults to `"Forgot RFID card"` with custom reason support.
   - Primary action: "Confirm Attendance".
   - Secondary action: "Cancel".
   - **Idle Timeout**: A 25-second countdown timer automatically cancels assisted mode and resets the kiosk to the welcoming idle greeting if unattended.
3. **Execution**:
   Upon confirmation, the kiosk sends `submitScan`:
   ```ts
   {
     rfidUid: adminCard.rfidUid,
     source: 'ADMIN_ASSISTED_SCAN',
     targetUserId: selectedEmployee.userId,
     reason: selectedReason
   }
   ```
4. **Backend Processing**:
   - Re-verifies admin card validity (`card_type == 'ADMIN_ASSIST'`).
   - Re-verifies target employee is `ACTIVE` and is not the admin card itself.
   - Determines action (`TIME_IN` or `TIME_OUT`) according to standard attendance action rules for the target employee for today.
   - Saves attendance row with `source = 'ADMIN_ASSISTED_SCAN'`, `recorded_by`, `recorded_reason`, `recorded_at`.
   - If shift completes (`COMPLETED`), triggers daily payroll reconciliation.
   - Broadcasts real-time `attendance-updated` event.
   - Returns standard `ScanSuccessResponse` with employee photo and greeting.
   - Kiosk plays greeting audio via TTS and returns to idle mode after standard result reset delay.

---

## Feature B: Backdated Manual Time-In (Past-Date Missed Attendance)

### Workflow
1. **Entry Point**:
   In the PIN-protected Admin panel under "Attendance corrections", an "Add missed attendance" button opens the backdated entry modal.
2. **Form Inputs**:
   - **Employee**: Searchable dropdown of active employees.
   - **Date**: Date input strictly restricted to past dates (`date < todayManila`).
   - **Time In**: Valid time (HH:mm) converted to Manila timestamp (`YYYY-MM-DDTHH:mm:00+08:00`). Required.
   - **Time Out**: Optional time (HH:mm). If entered, must be `>= timeIn`.
   - **Reason**: Required free-text justification (e.g., `"Confirmed present via CCTV on 08/20; forgot card"`).
3. **Validation Gates**:
   - **No Duplicate**: Checks `attendance` for `(user_id, date)`. If a row already exists, rejects with `ATTENDANCE_ALREADY_EXISTS_FOR_DATE` and prompts editing the existing row instead.
   - **Payroll Lock Check**: Checks whether the target date falls within any `FINALIZED` payroll cutoff period. If locked, rejects with `BACKDATE_LIMIT_EXCEEDED`.
   - **Plausible Time**: Verified via Manila timezone helpers.
4. **Persistence & Side Effects**:
   - Saved with `source = 'ADMIN_BACKDATED_ENTRY'`, `recorded_by = 'Admin'`, `recorded_reason = reason`, `recorded_at = now`.
   - If both `timeIn` and `timeOut` are present:
     * Evaluates `isLateTimeout`: if `timeOut > 18:00`, status is `LATE_TIMEOUT`; otherwise `COMPLETED`.
     * If `COMPLETED`, calculates daily payroll record (`PayrollService.ensureForCompletedAttendance`).
   - If only `timeIn` is present: status is `WORKING`.
   - Logs audit event (`ADMIN_BACKDATED_ATTENDANCE`).
   - Broadcasts real-time `attendance-updated` event.
5. **Security Isolation**:
   - Route and command are PIN-protected and admin-only.
   - The read-only LAN dashboard/viewer surface explicitly excludes this mutation route.

---

## Card Registration UI Evolution

1. **Card Registration Dialog (`SetupDialog`)**:
   - Top segmented control:
     * `[ Employee card ]` (default)
     * `[ Admin RFID card ]` (new)
   - When **Admin RFID card** is selected:
     * Captures card UID via RFID reader tap or manual hex entry.
     * Replaces employee fields with an optional Card Label input (e.g., `"Front desk admin card #1"`).
     * Saves user row with:
       - `userId`: `ADMIN_CARD_<UID>`
       - `rfidUid`: `<UID>`
       - `fullName`: `label.trim() || 'Admin Assist Card'`
       - `department`: `'Admin'`
       - `status`: `'ACTIVE'`
       - `cardType`: `'ADMIN_ASSIST'`
   - When **Employee card** is selected:
     * Retains exact existing behavior (User ID, full name, department, employee type, daily rate, photo upload).
2. **Admin Users & RFID List (`UserEditor`)**:
   - Visual badge on table rows: `<span className="badge badge-admin-card">Admin RFID Card</span>`.
   - Action to revoke/deactivate the admin card.
   - Prohibits registering the same UID as both employee and admin card (enforced by SQLite `UNIQUE` on `rfid_uid`).

---

## Shared Audit-Trail, Visual Badging & Reporting

1. **Kiosk Live Dashboard & Admin Table**:
   - Normal scans: No special badge (clean standard view).
   - Admin-assisted scans: Badge `Assisted` with tooltip `Assisted by <Admin> (<Reason>)`.
   - Backdated entries: Badge `Backdated` with tooltip `Backdated by <Admin> (<Reason>)`.
2. **Admin Filter Bar**:
   - Alongside `All`, `Grace Period`, `Late`, `Late Timeout`, add filter pills:
     * `Assisted` (count)
     * `Backdated` (count)
   - Management can instantly isolate and audit manual overrides.
3. **Exports (CSV & XLSX)**:
   - Client CSV export (`exportAttendanceCsv`): Appends `Recorded via`, `Recorded by`, and `Reason` columns.
   - Rust XLSX export (`load_attendance_rows` / `AttendanceExportRow`): Maps `source`, `recorded_by`, and `notes/reason` into the exported workbook so payroll reconcilers can see overrides.

---

## Testing & Verification Strategy

1. **Shared Workspace Unit Tests**:
   - `ScanSource` values, new error codes, and audit properties on contracts.
2. **Server Workspace Unit & Integration Tests**:
   - Admin card registration & rejection of attendance scans directly for admin cards.
   - Assisted scan execution writing target employee attendance with audit metadata.
   - Backdated attendance creation with validation (past date, cutoff collision, duplicate row rejection).
3. **Rust / Tauri Backend Tests**:
   - SQLite migration 0010 execution and trigger enforcement.
   - Tauri commands `admin_upsert_user` (with `card_type`), `scan_rfid` (admin assist routing), and `admin_create_backdated_attendance`.
4. **Client Workspace Unit & Component Tests**:
   - Card registration radio toggle and field visibility.
   - Kiosk transition to Assisted Attendance mode on admin card tap, employee selection, and 25s timeout.
   - Admin panel "Add missed attendance" modal, validation, and audit badges.
5. **Full Repository Gates**:
   - `npm run lint:oxlint`, `npm run typecheck`, `npm test`, `cargo test`.
