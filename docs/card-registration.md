# RFID Card Registration

An RFID card is recognized only when its UID matches an `ACTIVE` row in the `Users` sheet. The setup flow writes the card-to-user association to `Users`; normal attendance scans then use that association.

## 1. Enable protected setup

Set these variables in the same PowerShell window used to start the server:

```powershell
$env:SHEETS_MODE = "google"
$env:ENABLE_CARD_SETUP = "true"
$env:SETUP_ADMIN_PIN = "choose-a-private-pin"
$env:SETUP_SESSION_MINUTES = "15"
npm run dev
```

The server also needs the normal Google Sheets variables: `GOOGLE_SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY`. For local memory testing, use `SHEETS_MODE=memory`; the association will not survive a server restart.

## 2. Associate a card with an employee

1. Open the site and select `Admin` (or visit `/admin`).
2. Enter the setup PIN.
3. Scan the employee's RFID card. If it is unknown, the form opens blank.
4. Enter the employee's `User ID`, `Full name`, and `Department / role`.
5. Set `Status` to `Active`, then select `Save user`.
6. Lock the admin session and scan the same card on the normal attendance screen.

The kiosk RFID input is focused automatically when `/` opens and regains focus after each scan result, so operators can tap cards without clicking the field.

For Deign Lazaro, the profile should look like:

```text
User ID:          DEIGN-001
Full name:        Deign Lazaro
Department / role: IT / Admin
Status:           ACTIVE
RFID UID:         the UID read from Deign's physical card
```

## 3. Users sheet format

The `Users` tab must contain these headers:

```text
userid | rfiduid | fullname | department | status | createdat
```

Do not manually create an `Attendance` row for enrollment. The first normal scan creates the employee's time-in record.

## Troubleshooting

- `Setup locked`: set `ENABLE_CARD_SETUP=true` and `SETUP_ADMIN_PIN`, then restart the server.
- `This RFID card is not registered`: repeat the setup scan and save the card UID exactly as read.
- `USER_CONFLICT`: that UID or User ID is already assigned. Reconfigure the existing profile or deactivate the old card first.
- The setup flow succeeds but normal scans still fail: confirm the saved row has `status` equal to `ACTIVE` and that the kiosk is connected to the same Google Sheet.
