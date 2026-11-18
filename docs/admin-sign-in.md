# Opening the admin screens

Two ways in, on the Admin screen and on the kiosk's card-setup pop-up:

| Way in | Who | Notes |
|---|---|---|
| Admin RFID card | Whoever holds a card marked Admin Assist | Works with no internet. Only the attendance tracker uses these cards. |
| Keystone account | The CEO, and staff the CEO made an **attendance admin** in Keystone (User Accounts, a row's ⋯ menu) | "Sign in with your Keystone account". The audit log names the person. |

## The Keystone account

- **Who decides:** the CEO, in Keystone. Making someone an attendance admin, taking it back, turning an account off and resetting a password are all done there. Nothing about accounts is kept or changed on the kiosk.
- **Forgot password:** type the email, then **Forgot password?**. Firebase emails a reset link to that address; open it on any device, choose a new password, and sign in here with it. The screen says the same whether or not the address has an account.
- **No internet:** an account that signed in on this kiosk in the last 7 days still opens with the same password. One that never signed in here, or last did more than 7 days ago, needs the internet first (or an admin card).
- **Taken away in Keystone:** the next sign-in here with internet is refused, and from then on it does not open offline either. Until the kiosk is next online, a remembered sign-in still works: for someone who must be locked out today, also take back their admin card and make sure the kiosk is online.
- **Wrong tries:** five in a row pause anything typed for five minutes. Tapping an admin card still opens.
- **What the kiosk keeps:** a slow hash of the password of each account that got in, in its settings, to check it offline. Settings are never sent to Firebase. A password is never written to the audit log.

## There is no shared PIN

The administrator PIN and its emailed reset code were removed on 18 November 2026 (owner decision). A PIN that was set on a kiosk before then opens nothing; its stored hash is left in the kiosk's settings and is not read.

**If nobody can get in** (no admin card to hand, no internet, no account remembered on the kiosk): IT opens `config.toml` on the kiosk, adds `admin_pin = "something-long"`, restarts the app, types that in the card field, and removes the line again afterwards. This is the only PIN left and it exists only while that line does.

The Apps Script that emailed reset codes (`pin-reset-mailer`) is no longer called by any release from this one on. Its deployment and the `ALPHA_PREMIER_PIN_RESET_URL` repository secret can be archived and deleted by the owner.

## What each refusal means

- *The email or password is not right.*
- *This account is not an attendance admin*: it is a real Keystone account without the tick, or not a member of Keystone at all.
- *This account has been turned off*: disabled in Firebase.
- *There is no internet, and this account has not signed in on this kiosk in the last 7 days.*
- *Account sign-in is not set up in this app build*: the build has no Firebase project (a development build).

Code: `src-tauri/src/services/admin_account.rs`, `client/src/account-sign-in.tsx`. Keystone's side: `Deign86/apg-keystone`, `docs/adr/0030`.
