# Google Sheets Setup Runbook

This runbook provisions the service account and spreadsheet used by the RFID attendance API. Perform it with a Google Cloud administrator and a spreadsheet owner.

## 1. Create or Select a Cloud Project

1. Open Google Cloud Console and create/select a dedicated project for the kiosk.
2. Enable billing if required by the console. The Sheets API itself is typically quota-limited rather than chargeable, but the project must be valid.
3. Enable **Google Sheets API** under APIs & Services. Do not enable unrelated APIs unless a later deployment requires them.

## 2. Create a Service Account

1. Create a service account with a descriptive name such as `rfid-attendance-api`.
2. Do not grant broad project roles. The API only needs access to the target spreadsheet through sharing.
3. Create one JSON key for the deployment owner, download it once, and store it in a protected location. Treat it as a password.
4. Copy the service-account email; it will be used to share the spreadsheet.

## 3. Create the Spreadsheet

Create one spreadsheet and add tabs named exactly `Users`, `Attendance`, and `AuditLogs`. Put the following headers in row 1, in this exact order. Do not add a title row above them.

### Users

```text
user_id,rfid_uid,full_name,department,status,created_at
```

### Attendance

```text
attendance_id,attendance_date,user_id,rfid_uid,full_name,department,time_in,time_out,status,source,notes
```

### AuditLogs

```text
log_id,timestamp,event_type,rfid_uid,user_id,message,request_id
```

Freeze row 1. Keep data values as plain text/ISO timestamps; do not insert formulas into columns written by the service. Avoid sorting a live sheet while a kiosk is processing a scan.

## 4. Share the Spreadsheet

1. Share the spreadsheet with the service-account email as **Editor**.
2. Do not publish the spreadsheet or use “Anyone with the link.”
3. Keep human editors limited to roster/operations staff. The service account should not receive access to unrelated spreadsheets.

## 5. Seed a Test User

Add one disposable active user and one inactive user. Example values (replace the UID with a real test card):

```text
user_id: TEST-001
rfid_uid: 04A1B2C3
full_name: Test User
department: QA
status: ACTIVE
created_at: 2026-01-01T00:00:00+08:00
```

For the inactive row, use a different UID and `status: INACTIVE`. Keep `user_id` and `rfid_uid` unique. Remove or deactivate these rows after acceptance testing.

## 6. Provision Server Configuration

Set secrets only on the server process account. Use a protected `.env` file or Windows environment variables; never put them in the client build.

```text
GOOGLE_SHEETS_SPREADSHEET_ID=<spreadsheet-id>
GOOGLE_SERVICE_ACCOUNT_JSON=<minified-json-or-protected-key-path>
TIMEZONE=Asia/Manila
HOST=127.0.0.1
PORT=3000
ENABLE_CARD_SETUP=false
SETUP_ADMIN_PIN=<server-only-pin-when-setup-is-needed>
SETUP_SESSION_MINUTES=15
```

If the implementation uses a key path instead of inline JSON, set that variable according to the server config module and ACL the file so ordinary kiosk users cannot read it. Keep a non-secret `.env.example` with variable names only.

`ENABLE_CARD_SETUP` defaults to `false`. When it is `true`, `SETUP_ADMIN_PIN` is required and the API accepts setup requests only during a short-lived session (`SETUP_SESSION_MINUTES`, default 15). Do not put the PIN in the client environment or build output. Keep setup disabled during ordinary attendance operation and enable it only for a supervised enrollment window.

## 7. Validate Before Starting the Kiosk

From the repository root:

```powershell
npm install
npm run validate:sheets -w server
```

The validator must confirm the spreadsheet ID is reachable, all three tabs exist, and every header matches exactly. It should fail closed for a missing tab, renamed header, duplicate header, or insufficient permission.

Then start the API and check:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/health
Invoke-RestMethod http://127.0.0.1:3000/api/config
```

`/api/config` may return timezone and timing settings, but must never return credentials or the spreadsheet ID.

## 8. Verify Read and Write Access

Use the hardware runbook for a controlled scan. Confirm that a successful test creates an `Attendance` row and an `AuditLogs` row with the same `request_id`. Confirm a second scan updates the original row rather than appending another row.

If a write times out, stop scanning and inspect the sheet by `request_id` before retrying. The API is designed to read back after uncertain writes; operators must not manually duplicate the event while the result is unresolved.

## 9. Protected Card Enrollment and Reconfiguration

Setup mode is separate from attendance. An unknown card must continue to return `UNKNOWN_RFID_CARD` from `POST /api/attendance/scan`; it is never auto-enrolled by a normal scan.

1. Set `ENABLE_CARD_SETUP=true` and provision `SETUP_ADMIN_PIN` on the server. Restart or reload the API, then open the setup control on the kiosk while physically present at the workstation.
2. Submit `POST /api/setup/unlock` with `{ "pin": "..." }`. On success, retain the opaque `setupToken` in memory until `expiresAt`; send it as `X-Setup-Token`. Do not write it to local storage or logs.
3. Scan the card and call `GET /api/setup/card?rfidUid=<normalized-uid>`. A `user: null` response means the card is unknown and eligible for supervised enrollment; a populated user means it is already registered.
4. For an unknown card, collect the operator-approved `userId`, `fullName`, optional `department`, and `status`, then call `POST /api/setup/users` with the setup token. Confirm one new `Users` row and no `Attendance` row.
5. For a known card, review and edit the returned user profile, then call the same upsert endpoint. This updates only the matching `Users` row; it must not alter historical or open attendance rows.
6. If the UID is assigned to another user, stop and resolve the roster conflict. The API must return `USER_CONFLICT` without overwriting either user. For a replacement card, deactivate the old UID first, then enroll the new UID as a separate supervised action.
7. Call `POST /api/setup/lock` when finished. Clear the token in the browser even if the request fails. Set `ENABLE_CARD_SETUP=false` after the enrollment window and restart the service if configuration is loaded at startup.

The setup contract is: unlock (`POST /api/setup/unlock`), lock (`POST /api/setup/lock`), card lookup (`GET /api/setup/card?rfidUid=...`), and Users upsert (`POST /api/setup/users`). Setup errors include `SETUP_DISABLED`, `INVALID_SETUP_PIN`, `SETUP_AUTH_REQUIRED`, `SETUP_SESSION_EXPIRED`, `SETUP_VALIDATION_ERROR`, `USER_CONFLICT`, and `GOOGLE_SHEETS_UNAVAILABLE`.

## 10. Rotation and Recovery

- Create a replacement service-account key before revoking the old one; update the protected deployment secret and restart the API.
- Verify `/api/health` and one controlled scan after rotation.
- Revoke the old key in Cloud Console and record the rotation date.
- Export/download a spreadsheet backup before schema changes or bulk roster edits.
- If the key is exposed, revoke it immediately, issue a new key, review audit/server logs, and rotate any host credentials that were colocated with it.

## Common Errors

| Error | Check |
| --- | --- |
| `PERMISSION_DENIED` | Spreadsheet is shared with the exact service-account email; key belongs to the expected project. |
| Tab/header validation failure | Names and row-1 headers match the exact lists above, with no hidden spaces. |
| `GOOGLE_SHEETS_UNAVAILABLE` | Internet/DNS, API enablement, quota, service-account key validity, and system clock. |
| Duplicate user/card | `user_id` and normalized `rfid_uid` are unique in `Users`; mark old cards inactive. |
| Formula or display corruption | Remove formulas from write columns and review any values beginning with `=`, `+`, `-`, or `@`. |
| `SETUP_DISABLED` | Set `ENABLE_CARD_SETUP=true` only for a supervised setup window, then restart if required. |
| `INVALID_SETUP_PIN` | Verify the server-only `SETUP_ADMIN_PIN`; never send or store the PIN in the client bundle. |
| `SETUP_SESSION_EXPIRED` | Unlock again and finish the operation within `SETUP_SESSION_MINUTES`; lock explicitly afterward. |
| `USER_CONFLICT` | Stop; inspect `Users` for duplicate UID/user assignments before attempting a replacement-card workflow. |
