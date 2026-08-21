# Admin Panel & Employee Roster Management

Administrative workspace for managing employee and intern profiles, RFID card mappings, photo uploads, and manual attendance correction with operator audit logging.

## Sub-features

- `ADMIN-AUTH`: Protected entry requiring the configured administrator PIN (`1234`).
- `ADMIN-ROSTER`: Paginated table listing all employees and interns with filtering and search.
- `ADMIN-UPSERT`: Add new worker or edit details (name, employee ID, role, worker type, RFID UID, rate).
- `ADMIN-PHOTO`: Client-side validation and storage of profile photo (JPEG/PNG/WebP, capped at 500 KiB / 4096x4096px).
- `ADMIN-ATTENDANCE`: View daily time stamps and modify or delete erroneous scans with audit logging.

## How to get to it (user POV)

- From the Kiosk view, click the "Admin" button in the upper header.
- Enter the Admin PIN (`1234`) in the PIN modal and click "Unlock".
- The Admin workspace displays tabs for "Employees", "Attendance", "Payroll", and "Database".

## Driving it with Tauri MCP

Preconditions:
- Desktop app is running and responsive on Tauri MCP bridge port 9223.
- Database contains active system configuration with admin PIN configured.

- **Authenticate Session**: Unlock admin panel with PIN.
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
  *Observable result*: Returns `{ "success": true, "token": "<session_token>", "expiresAt": "..." }`.

- **List Users**: Query employee and intern roster.
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
  *Observable result*: Returns `{ "success": true, "users": [ ... ] }` containing all registered workers.

- **Create or Update Worker Profile**: Add worker with explicit role and rate.
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "ipc_execute_command",
    "Arguments": {
      "command": "admin_upsert_user",
      "payload": {
        "token": "<session_token>",
        "user": {
          "employeeId": "EMP-VERIFY-001",
          "fullName": "Tauri Verification Worker",
          "workerType": "REGULAR",
          "rfidUid": "CARD-VERIFY-001"
        }
      }
    }
  }
  ```
  *Observable result*: Worker is stored in SQLite and appears in the roster query.

- **Capture Visual & DOM Proof**:
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_screenshot",
    "Arguments": { "name": "admin_roster_table" }
  }
  ```
  *Observable result*: Screenshot captured displaying the updated employee roster table.

## Gotchas

- Session tokens expire automatically after the configured inactivity timeout. Re-authenticate if an `UNAUTHORIZED` error is returned.
- Gender and worker type values must conform to strict domain enums (`MALE` / `FEMALE` / `OTHER`, `REGULAR` / `INTERN`).

