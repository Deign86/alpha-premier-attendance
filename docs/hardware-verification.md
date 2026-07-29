# Hardware Verification Runbook

Use this runbook before enabling real cards and after replacing a reader, kiosk PC, or USB port. It assumes an RFID reader operating as a USB HID keyboard wedge and a running kiosk client.

## Acceptance Criteria

- The reader appears in Windows as a keyboard/HID device without an unknown-device warning.
- Every test card produces the expected UID exactly once, with the expected suffix behavior.
- Enter submission and the 150 ms idle fallback each submit one scan, never two.
- A successful first scan creates one `OPEN` row; the next scan closes it as `COMPLETED`.
- Unknown and inactive cards are rejected without an Attendance row.
- The kiosk shows a useful result, resets, and returns focus to the scan field after every outcome.
- The 10-second cooldown prevents an accidental repeated read from mutating attendance.
- Unknown-card enrollment and known-card reconfiguration are available only after a correct setup PIN, and neither changes `Attendance`.
- Setup lock/expiry removes authorization; a setup token cannot be reused for attendance or after the setup window ends.

## Test Materials

Prepare one active test user, one inactive test user, one unknown card, and a disposable test day or spreadsheet copy. Have the setup operator retrieve the server PIN without writing it into test evidence. Record the reader model, USB port, Windows machine name, browser version, kiosk URL, and test request IDs.

## Procedure

1. **Inspect the physical connection.** Plug the reader directly into the kiosk PC, avoid an unpowered hub, and confirm the reader's status light. In Device Manager, confirm it is listed under keyboards or HID devices.
2. **Confirm keyboard mode.** Open Notepad outside the kiosk and scan the active test card. The UID should appear as printable characters. Verify whether the reader sends Enter. Delete the test text afterward.
3. **Check UID formatting.** Compare the captured string with the `Users.rfid_uid` value. Confirm case, separators, leading zeros, and length. Normalize the roster or scanner configuration once; do not maintain multiple spellings.
4. **Open the kiosk.** Load the configured kiosk URL and verify that the RFID field is already focused after the first page load and after a refresh; no mouse click should be required.
5. **Test Enter-suffixed scans.** Scan the active card. Confirm one request, a `TIME_IN` result, and one `OPEN` Attendance row. Note the `requestId`.
6. **Test cooldown.** Present the same card again immediately. Confirm the UI reports cooldown/duplicate behavior and no second row is created.
7. **Complete attendance.** After the cooldown, scan the same card once. Confirm one `TIME_OUT` result and that the original row has `time_out` populated and `status=COMPLETED`.
8. **Test no-Enter scanners.** Temporarily disable the reader's Enter suffix (or use a test profile), scan an active card, and verify the 150 ms idle fallback submits once. Restore the production suffix setting afterward.
9. **Test slow/manual input.** Type a UID one character at a time. A pause longer than the idle threshold should submit the buffered value once; malformed or partial input must return `INVALID_SCAN_INPUT` or `UNKNOWN_RFID_CARD` without a write.
10. **Test card states.** Scan the inactive card and an unknown card. Verify the error code/message and that neither creates an Attendance row. Confirm each rejection has an `AuditLogs` entry.
11. **Test focus recovery.** Trigger success, unknown-card, inactive-user, validation, and Sheets-unavailable states. After each, press no extra keys and verify the next card is captured.
12. **Test disconnect/reconnect.** Unplug the reader, confirm the kiosk remains usable and displays no false attendance, reconnect it, and repeat a controlled test scan.
13. **Test LAN path (if enabled).** From the kiosk and one approved LAN client, check `/api/health`; verify the kiosk can scan while unapproved network sources are blocked by the Windows firewall.
14. **Test disabled setup.** With `ENABLE_CARD_SETUP=false`, attempt to open setup and confirm `SETUP_DISABLED`; scan the unknown card normally and confirm `UNKNOWN_RFID_CARD` with no `Users` or `Attendance` mutation.
15. **Test PIN unlock and enrollment.** Temporarily set `ENABLE_CARD_SETUP=true` with the supervised `SETUP_ADMIN_PIN`. Unlock with a wrong PIN (rejected and rate-limited), then the correct PIN. Scan the unknown card, submit approved profile fields, and confirm one `Users` row plus no `Attendance` row.
16. **Test known-card reconfiguration.** In the same setup session, scan the known test card, change a safe profile field or status, and confirm only the matching `Users` row changes. Verify its existing/open or completed Attendance history is byte-for-byte unchanged.
17. **Test conflict and expiry.** Attempt to assign an existing UID/user combination to a different user and confirm `USER_CONFLICT` without overwrite. Call setup lock, then retry lookup; wait past `SETUP_SESSION_MINUTES` in a short test configuration and confirm `SETUP_SESSION_EXPIRED`.
18. **Close the setup window.** Call `POST /api/setup/lock`, clear the browser token, set `ENABLE_CARD_SETUP=false`, and restart if configuration is startup-loaded. Repeat a normal Time In/Time Out to verify attendance behavior is unchanged.

## Evidence to Record

- Reader model, firmware/config profile, USB port, and Windows Device Manager screenshot or note.
- Raw Notepad UID (do not place personal card data in a public ticket), normalized roster UID, and suffix setting.
- Kiosk URL, test date/time in `Asia/Manila`, result for each card, and associated `requestId`.
- Spreadsheet row IDs/values before and after Time In/Out, plus AuditLogs entries.
- Any browser console/server log error and the recovery action.
- Setup endpoint outcomes, `expiresAt` behavior, and before/after `Users` row values. Never record the PIN or setup token.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| No characters in Notepad | Power, cable, USB port, or non-HID mode | Try a direct port/cable; install vendor profile; confirm HID mode. |
| Wrong UID or missing leading zeros | Reader formatting differs from roster | Capture raw output and normalize both reader configuration and `rfid_uid`. |
| Two submissions | Enter plus idle fallback race or duplicate key events | Confirm client clears its buffer and in-flight flag before both submit paths; inspect `requestId`s. |
| No-Enter card never submits | Input lost focus or idle timer disabled | Click scan field, verify safe config reports 150 ms, and test browser permissions. |
| Correct card says unknown | Wrong spreadsheet/tab, whitespace, case, or stale roster | Run `npm run validate:sheets -w server`, inspect the exact `Users` value, and retry. |
| Setup control unavailable | Setup is disabled or PIN is not configured | Confirm `ENABLE_CARD_SETUP=true` and `SETUP_ADMIN_PIN` on the server; do not put either value in client config. |
| Setup token rejected | Token was locked, expired, or sent in the wrong header | Unlock again and send `X-Setup-Token`; keep it in memory only. |
| Unknown card auto-enrolled unexpectedly | Normal attendance route is writing Users | Stop the service and inspect routes/logs; normal unknown scans must never mutate `Users`. |
| Known-card edit changed attendance | Setup and attendance writes are not isolated | Stop setup, preserve request IDs, and restore only from a verified backup after investigation. |
| Result succeeds but row is duplicated | Ambiguous write was retried blindly | Stop scanning, preserve request IDs, inspect read-back and AuditLogs, and escalate as a data conflict. |
| LAN client cannot load kiosk | Bind address, firewall, or private network profile | Bind to the private interface, allow the selected subnet, and keep the network profile Private. |

## Sign-Off

An operator and an implementation owner should both sign off the acceptance criteria. Keep the evidence with the release record. Remove disposable test users/cards or mark them `INACTIVE` before production use.
