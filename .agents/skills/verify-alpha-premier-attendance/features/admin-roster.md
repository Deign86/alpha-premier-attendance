# Admin Panel & Employee Roster Management

Administrative interface for managing employee and intern profiles, RFID card mappings, photo uploads, and manual attendance correction.

## Sub-features

- **PIN Authentication**: Protected entry requiring the configured administrator PIN.
- **Roster Management**: Paginated table listing all employees and interns with filtering and search.
- **User Upsert**: Add new worker or edit details (name, employee ID, role, worker type, RFID UID, rate).
- **ID Photo Upload**: Client-side validation and storage of profile photo (JPEG/PNG, capped at 500 KiB / 4096x4096px).
- **Attendance Ledger**: View daily time stamps and modify or delete erroneous scans with audit logging.

## How to get to it (user POV)

1. From the Kiosk view, click the "Admin" button in the upper corner.
2. Enter the Admin PIN in the PIN modal and click "Unlock".
3. The Admin workspace displays tabs for "Employees", "Attendance", "Payroll", and "Database".

## Driving it with Tauri MCP

1. **Authenticate via IPC or UI**:
   - Unlock the session using `setup_unlock`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "setup_unlock",
         "payload": { "pin": "1234" }
       }
     }
     ```
2. **List Users**:
   - Query existing users via `admin_list_users`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "admin_list_users",
         "payload": { "token": "<session_token>" }
       }
     }
     ```
3. **Add or Update Employee**:
   - Fill out employee modal via `webview_interact` or invoke `admin_upsert_user`:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "admin_upsert_user",
         "payload": {
           "token": "<session_token>",
           "user": {
             "employeeId": "EMP-999",
             "fullName": "Test Verification Worker",
             "workerType": "REGULAR",
             "rfidUid": "VERIFY-UID-999"
           }
         }
       }
     }
     ```
4. **Capture Evidence**:
   - Verify user exists in the roster table and take a screenshot:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_screenshot",
       "Arguments": { "name": "admin_roster_table" }
     }
     ```

## Gotchas

- Session tokens expire automatically after the configured inactivity timeout. Re-authenticate if an `UNAUTHORIZED` error is returned.
- Gender and worker type values must conform to strict domain enums (`MALE` / `FEMALE` / `OTHER`, `REGULAR` / `INTERN`).
