# RFID Card Registration

An RFID card is recognized only when its UID matches an `ACTIVE` row in the `Users` sheet. The setup flow writes the card-to-user association to `Users`; normal attendance scans then use that association.

## 1. Enable protected setup

Set these variables in the same PowerShell window used to start the server:

```powershell
$env:SHEETS_MODE = "google"
$env:ENABLE_CARD_SETUP = "true"
$env:SETUP_ADMIN_PIN = "choose-a-private-pin"
$env:SETUP_SESSION_MINUTES = "15"
$env:BLOB_READ_WRITE_TOKEN = "server-only-vercel-blob-token"
npm run dev
```

The server also needs the normal Google Sheets variables: `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY`. For local memory testing, use `SHEETS_MODE=memory`; the association will not survive a server restart.

## 2. Associate a card with an employee or administrator

1. Open the site and select `Admin setup` (or visit `/admin`).
2. Enter the administrator PIN.
3. Scan the RFID card. If it is unknown, the form opens blank.
4. Choose the registration type using the segmented control:
   - **Employee card** (default):
     - Enter the person's `User ID`, `Full name`, and optional `Department / role`.
     - Select `Employee type` (`Intern` or `Regular Employee`). For employees, provide a positive daily rate and optional photo.
     - Set `Status` to `Active`, then click `Save user`.
   - **Admin RFID card** (new):
     - Select **Admin RFID card** on the segmented toggle.
     - Enter an optional `Card label` (e.g. `Front desk admin card #1`).
     - Employee-only fields (User ID, department, daily rate, photo) are automatically hidden and managed.
     - Click `Save admin card`.
     - *Note*: Admin RFID cards shift the kiosk into "Assisted Attendance" mode when tapped to clock in/out an active employee who forgot their card. Admin cards cannot record attendance for themselves (enforced by database triggers).

Card taps are captured at the native Rust layer through a configured device-specific transport (raw HID or serial) or, for keyboard-wedge readers, the focused kiosk window's burst capture; they surface to the kiosk as `rfid-scan` events. No global keyboard hook is installed. While the kiosk window is focused, no webview field needs to be selected; operators can tap cards at any time, and the scanner pauses only while the operator types in admin, setup, or manual-entry screens. Keyboard-wedge input is foreground-only: it cannot create attendance records while the kiosk is minimized or tray-hidden, because a generic hook cannot isolate the reader from ordinary foreground typing.

For an employee card (e.g., Deign Lazaro), the profile should look like:

```text
User ID:          DEIGN-001
Full name:        Deign Lazaro
Department / role: IT / Admin
Status:           ACTIVE
RFID UID:         the UID read from Deign's physical card
```

For an admin assist card, the record is stored as:

```text
User ID:          ADMIN_CARD_<UID>
Card label:       Front desk admin card #1
Card type:        ADMIN_ASSIST
Status:           ACTIVE
```

## 3. Users sheet format

The `Users` tab must contain these headers:

```text
userid | rfiduid | fullname | department | status | createdat | employeetype | dailyrate | photourl
```

Do not manually create an `Attendance` row for enrollment. The first normal scan creates the employee's time-in record.

## Troubleshooting

- `Setup locked`: set `ENABLE_CARD_SETUP=true` and `SETUP_ADMIN_PIN`, then restart the server.
- `This RFID card is not registered`: repeat the setup scan and save the card UID exactly as read.
- `USER_CONFLICT`: that UID or User ID is already assigned. Reconfigure the existing profile or deactivate the old card first.
- The setup flow succeeds but normal scans still fail: confirm the saved row has `status` equal to `ACTIVE` and that the kiosk is connected to the same Google Sheet.
