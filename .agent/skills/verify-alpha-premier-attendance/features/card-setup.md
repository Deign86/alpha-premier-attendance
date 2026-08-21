# Card Setup Flow

Guided workflow to register unrecognized RFID cards and associate them with active staff members without full admin access.

## Sub-features

- `SETUP-DETECT`: Automatically intercepts unassigned RFID scans and prompts the operator to register the card.
- `SETUP-AUTH`: Lightweight PIN protection (`1234`) distinct from full administrative privileges.
- `SETUP-BIND`: Dropdown selection of active employees missing an assigned RFID card.
- `SETUP-WEDGE`: Live RFID listener automatically populates scanned card UID into the binding form while in setup mode.

## How to get to it (user POV)

- Scan an unregistered RFID card on the kiosk (or click the "Card Setup" / "Admin setup" button).
- Enter the Setup PIN (`1234`) when prompted in the unlock dialog.
- Select the employee from the list to bind the card to, or click "Create New Employee".

## Driving it with Tauri MCP

Preconditions:
- Desktop app is running with active Tauri MCP WebSocket bridge on port 9223.
- An unregistered card UID (e.g. `CARD-NEW-999`) is scanned or supplied.

- **Trigger Setup Unlock**:
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
  *Observable result*: Returns `{ "success": true, "token": "<token>", "expiresAt": "..." }`.

- **Lookup Card Status**: Check whether a UID is already assigned.
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "ipc_execute_command",
    "Arguments": {
      "command": "setup_lookup_card",
      "payload": { "token": "<token>", "rfidUid": "CARD-NEW-999" }
    }
  }
  ```
  *Observable result*: Returns `{ "success": true, "assigned": false }`.

- **Assign Card to User**: Submit card binding.
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "ipc_execute_command",
    "Arguments": {
      "command": "setup_upsert_user",
      "payload": {
        "token": "<token>",
        "user": {
          "employeeId": "EMP-001",
          "rfidUid": "CARD-NEW-999"
        }
      }
    }
  }
  ```
  *Observable result*: Returns `{ "success": true, "message": "Card mapped to employee" }`.

- **Capture Evidence**:
  ```json
  {
    "ServerName": "tauri",
    "ToolName": "webview_screenshot",
    "Arguments": { "name": "card_setup_completed" }
  }
  ```
  *Observable result*: Subsequent scan of `CARD-NEW-999` immediately logs attendance for `EMP-001` on the kiosk.

## Gotchas

- When card setup is open, the background RFID listener switches from attendance logging to card detection mode to avoid duplicate clock-in records during setup.

