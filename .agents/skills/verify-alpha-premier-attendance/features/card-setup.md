# Card Setup Flow

Guided workflow to register unrecognized RFID cards and associate them with active staff members without full admin access.

## Sub-features

- **Fast Unregistered Detection**: Automatically intercepts unassigned RFID scans and prompts the operator to register the card.
- **Card Setup PIN**: Lightweight PIN protection distinct from full administrative privileges.
- **Employee Assignment**: Dropdown selection of active employees missing an assigned RFID card.
- **Live RFID Wedge Listener**: Automatically populates scanned card UID into the binding form while in setup mode.

## How to get to it (user POV)

1. Scan an unregistered RFID card on the kiosk or click the "Card Setup" button.
2. Enter the Card Setup PIN when prompted.
3. Select the employee from the list to bind the card to, or click "Create New Employee".

## Driving it with Tauri MCP

1. **Trigger Setup Unlock**:
   - Call `setup_unlock`:
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
2. **Lookup Card Status**:
   - Check whether a UID is already assigned:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "setup_lookup_card",
         "payload": { "token": "<token>", "rfidUid": "NEW-CARD-001" }
       }
     }
     ```
3. **Assign Card to User**:
   - Submit card binding:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "ipc_execute_command",
       "Arguments": {
         "command": "setup_upsert_user",
         "payload": {
           "token": "<token>",
           "user": {
             "employeeId": "EMP-002",
             "rfidUid": "NEW-CARD-001"
           }
         }
       }
     }
     ```
4. **Capture Evidence**:
   - Verify subsequent scan of `NEW-CARD-001` identifies the employee immediately on the kiosk view.
   - Take a screenshot of the confirmation dialog:
     ```json
     {
       "ServerName": "tauri",
       "ToolName": "webview_screenshot",
       "Arguments": { "name": "card_setup_completed" }
     }
     ```

## Gotchas

- When card setup is open, the background RFID listener switches from attendance logging to card detection mode to avoid duplicate clock-in records during setup.
