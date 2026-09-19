# Card Setup Flow

Guided workflow to register unrecognized RFID cards and associate them with active staff members without full admin access.

## Sub-features

- `SETUP-DETECT`: Automatically intercepts unassigned RFID scans and prompts the operator to register the card.
- `SETUP-AUTH`: PIN protection using the shared admin PIN (`293906` default, overridable by config file) — plus `ADMIN_ASSIST` card unlock. Not a separate privilege from admin.
- `SETUP-BIND`: Free-text User ID + Full name form (plus status/type/gender selects), not an employee dropdown. No "Create New Employee" button — new cards show a blank profile.
- `SETUP-WEDGE`: While the setup `scan` step is live, wedge/global scans route to the setup input; the native scanner only pauses while typing in non-scan steps. No separate "detection mode" exists.

## How to get to it (user POV)

- Scan an unregistered RFID card on the kiosk (or click the "Admin setup" footer button; unknown-card errors show "Setup this card").
- Enter the Setup PIN (`293906`) when prompted in the unlock dialog.
- Fill User ID + Full name in the binding form and save.

## Driving it with Tauri MCP

> IPC route (live-proved): `tauri_ipc_execute_command` drops command args.
> Drive backend commands via `tauri_webview_execute_js` wrapping
> `window.__TAURI__.core.invoke('<command>', { camelCaseArgs })` with arg keys
> exactly as in `client/src/tauri-api.ts` (e.g. `setup_lookup_card` takes
> `{ token, rfidUid }` — `rfid_uid` fails).

Preconditions:
- Desktop app is running with active Tauri MCP WebSocket bridge on port 9223.
- An unregistered card UID (e.g. `CARD-NEW-999`) is scanned or supplied.

- **Trigger Setup Unlock** (see IPC route note above):
  `setup_unlock` with `{ "pin": "293906" }` (the shared admin PIN — setup has
  no separate privilege; `admin_unlock` is an alias. A registered
  `ADMIN_ASSIST` card UID also unlocks).
  *Observable result*: Returns `{ "success": true, "token": "<token>", "expiresAt": "..." }`.

- **Lookup Card Status**: `setup_lookup_card` with
  `{ "token": "<token>", "rfidUid": "CARD-NEW-999" }`.
  *Observable result*: Returns `{ "success": true, "rfidUid": "CARD-NEW-999", "user": null }` for an unregistered card (or the user object when assigned).

- **Assign Card to User**: `setup_upsert_user` with
  `{ "token": "<token>", "user": { "rfidUid": "CARD-NEW-999",
  "userId": "<NEW-ID>", "fullName": "<Name>", "status": "ACTIVE" } }`
  (`userId`, not `employeeId`).
  *Observable result*: Returns `{ "success": true, "created": true, "userId":
  "<NEW-ID>" }` (no `message` field; UI shows "Card enrolled successfully.").

- **Capture Evidence** (`tauri_webview_screenshot`):
  ```
  tool: tauri_webview_screenshot, args: { "name": "card_setup_completed" }
  ```
  *Observable result*: Subsequent scan of `CARD-NEW-999` immediately logs attendance for `EMP-001` on the kiosk.

## Gotchas

- When card setup is open, the background RFID listener switches from attendance logging to card detection mode to avoid duplicate clock-in records during setup.

