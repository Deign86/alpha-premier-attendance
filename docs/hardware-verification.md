# Hardware Verification Runbook

Use this runbook before enabling real cards and after replacing a reader, kiosk PC, or USB port. It describes verification procedures for the supported keyboard-mode USB RFID reader.

## Deployed Reader: 125 kHz EM4100 USB (Keyboard Mode)

The deployed reader is a 125 kHz EM4100 contactless card reader operating on a standard USB keyboard interface. Expected behavior:

- **Tap profile:** A card tap emits a burst of decimal digits (typically 10) followed by Enter in under 100 ms, with an audible beep. The default configuration is `scanner.expected_length = 10` and `scanner.character_set = "decimal"` in `config.toml`; readers programmed to emit 8 hexadecimal characters must set `expected_length = 8` and `character_set = "hex"`. Variable length is supported with `expected_length = 0` (4–64 characters).
- **Foreground scan flow:** Keep the attendance window focused before scanning. While the window has focus, card taps are buffered, validated, and submitted automatically upon receiving Enter.
- **Operator notice:** The attendance window must be the active, focused foreground window during scanning.
- **Admin diagnostics:** Admin → Scanner diagnostics presents the scanner as a "Keyboard-mode RFID reader" with guidance to keep the window focused.

## Acceptance Criteria

- The reader appears in Windows as a standard keyboard/HID input device without driver errors.
- Every test card produces the expected UID exactly once.
- The scanner completes a scan on Enter or the configured idle-timeout fallback.
- A successful first scan creates one `WORKING` row; the next scan closes it as `COMPLETED`.
- Unknown and inactive cards are rejected without an Attendance row.
- The kiosk shows a large, clear result and resets after every outcome.
- The cooldown prevents an accidental repeated read from mutating attendance.
- Unknown-card enrollment and known-card reconfiguration are available only after a correct setup PIN, and neither changes `Attendance`.
- Setup lock/expiry removes authorization; a setup token cannot be reused for attendance or after the setup window ends.

## Test Materials

Prepare one active test user, one inactive test user, one unknown card, and a disposable test day or database backup. Have the setup operator retrieve the server PIN without writing it into test evidence. Record the reader model, USB port, Windows machine name, kiosk URL, and test request IDs.

## Procedure

1. **Inspect the physical connection.** Plug the reader directly into the kiosk PC, avoid an unpowered hub, and confirm the reader's status light. In Device Manager, confirm it is listed under keyboards or HID devices.
2. **Check UID formatting.** Compare the captured string with the `Users.rfid_uid` value. Confirm case, separators, leading zeros, and length. Normalize the roster or scanner configuration once; do not maintain multiple spellings.
3. **Open the kiosk.** Load the kiosk window and ensure it is focused. Tap a card and confirm the scan result appears.
4. **Test Enter-suffixed scans.** Scan the active card. Confirm one request, a `TIME_IN` result, and one `WORKING` Attendance row. Note the `requestId`.
5. **Test cooldown.** Present the same card again immediately. Confirm the UI reports cooldown/duplicate behavior and no second row is created.
6. **Test completion.** After the cooldown, scan the same card once. Confirm one `TIME_OUT` result and that the original row has `time_out` populated and `status=COMPLETED`.
7. **Test no-Enter scanners (if applicable).** If using a reader without Enter suffix, verify the idle fallback submits once.
8. **Test manual fallback.** Open the kiosk's `Manual entry` fallback and type a UID. Enter or the Record button submits once; malformed or partial input returns `INVALID_SCAN_INPUT` or `UNKNOWN_RFID_CARD` without a write. The scanner listener pauses while manual entry is active.
9. **Test card states.** Scan the inactive card and an unknown card. Verify the error code/message and that neither creates an Attendance row. Confirm each rejection has an `AuditLogs` entry.
10. **Test focus requirement.** With another app focused, verify the kiosk does not consume keystrokes. Refocus the kiosk window and verify normal card taps work.
11. **Test LAN path (if enabled).** From the kiosk and one approved LAN client, check `/api/health`; verify the kiosk functions properly.
12. **Test disabled setup.** With `ENABLE_CARD_SETUP=false`, attempt to open setup and confirm `SETUP_DISABLED`; scan the unknown card normally and confirm `UNKNOWN_RFID_CARD` with no `Users` or `Attendance` mutation.
13. **Test PIN unlock and enrollment.** Temporarily set `ENABLE_CARD_SETUP=true` with the supervised `SETUP_ADMIN_PIN`. Unlock with a wrong PIN (rejected and rate-limited), then the correct PIN. Scan the unknown card, submit approved profile fields, and confirm one `Users` row plus no `Attendance` row.
14. **Test known-card reconfiguration.** In the same setup session, scan the known test card, change a safe profile field or status, and confirm only the matching `Users` row changes. Verify its existing/working or completed Attendance history is byte-for-byte unchanged.
15. **Test conflict and expiry.** Attempt to assign an existing UID/user combination to a different user and confirm `USER_CONFLICT` without overwrite. Call setup lock, then retry lookup; wait past `SETUP_SESSION_MINUTES` in a short test configuration and confirm `SETUP_SESSION_EXPIRED`.
16. **Close the setup window.** Call `POST /api/setup/lock`, clear the browser token, set `ENABLE_CARD_SETUP=false`, and restart if configuration is startup-loaded. Repeat a normal Time In/Time Out to verify attendance behavior is unchanged.

## Evidence to Record

- Reader model, firmware/config profile, USB port, and Windows Device Manager note.
- Raw UID, normalized roster UID, and suffix setting.
- Kiosk URL, test date/time in `Asia/Manila`, result for each card, and associated `requestId`.
- Database row IDs/values before and after Time In/Out, plus AuditLogs entries.
- Any browser console/server log error and the recovery action.
- Setup endpoint outcomes, `expiresAt` behavior, and before/after `Users` row values. Never record the PIN or setup token.

## Troubleshooting

| Symptom | Likely cause | Action |
| --- | --- | --- |
| No characters typed / no scan | Power, cable, USB port, or unfocused window | Try a direct port/cable; ensure the attendance window is focused before scanning. |
| Wrong UID or missing leading zeros | Reader formatting differs from roster | Capture raw output and normalize both reader configuration and `rfid_uid`. |
| Two submissions | Enter plus idle fallback race or duplicate key events | Confirm scanner dedup window and in-flight guard swallow repeats; inspect `requestId`s. |
| No-Enter card never submits | Enter suffix disabled but idle fallback misconfigured | Verify `scanner.enter_suffix` and `scanner.idle_timeout_ms` in `config.toml`. |
| Correct card says unknown | Wrong database record, whitespace, case, or stale roster | Inspect the exact `Users` value and retry. |
| Setup control unavailable | Setup is disabled or PIN is not configured | Confirm `ENABLE_CARD_SETUP=true` and `SETUP_ADMIN_PIN` in config. |
| Setup token rejected | Token was locked, expired, or sent in the wrong header | Unlock again and keep token in memory only. |
| Unknown card auto-enrolled unexpectedly | Normal attendance route is writing Users | Stop the service and inspect routes/logs; normal unknown scans must never mutate `Users`. |
| Known-card edit changed attendance | Setup and attendance writes are not isolated | Stop setup, preserve request IDs, and restore only from a verified backup after investigation. |
| Result succeeds but row is duplicated | Ambiguous write was retried blindly | Stop scanning, preserve request IDs, inspect read-back and AuditLogs, and escalate as a data conflict. |
| LAN client cannot load kiosk | Bind address, firewall, or private network profile | Bind to the private interface, allow the selected subnet, and keep the network profile Private. |

## Sign-Off

An operator and an implementation owner should both sign off the acceptance criteria. Keep the evidence with the release record. Remove disposable test users/cards or mark them `INACTIVE` before production use.
