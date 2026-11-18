# Opening the admin screens

Three ways in, on the Admin screen of the desktop app:

| Way in | Who | Notes |
|---|---|---|
| Admin RFID card | Whoever holds a card marked Admin Assist | Works with no internet. Only the attendance tracker uses these cards. |
| Keystone account | The CEO, and staff the CEO made an **attendance admin** in Keystone (User Accounts, a row's ⋯ menu) | "Sign in with your Keystone account". The audit log names the person. |
| Administrator PIN | Anyone who knows it | Kept for now. It goes, with its emailed reset code, once the owner says so. |

## The Keystone account

- **Who decides:** the CEO, in Keystone. Making someone an attendance admin, taking it back, turning an account off and resetting a password are all done there. Nothing about accounts is kept or changed on the kiosk.
- **Forgot password:** type the email, then **Forgot password?**. Firebase emails a reset link to that address; open it on any device, choose a new password, and sign in here with it. The screen says the same whether or not the address has an account.
- **No internet:** an account that signed in on this kiosk in the last 7 days still opens with the same password. One that never signed in here, or last did more than 7 days ago, needs the internet first (or an admin card).
- **Taken away in Keystone:** the next sign-in here with internet is refused, and from then on it does not open offline either. Until the kiosk is next online, a remembered sign-in still works: for someone who must be locked out today, also take back their admin card and make sure the kiosk is online.
- **Wrong tries:** five in a row pause account and PIN unlock for five minutes. Admin cards still open.
- **What the kiosk keeps:** a slow hash of the password of each account that got in, in its settings, to check it offline. Settings are never sent to Firebase. A password is never written to the audit log.

## What each refusal means

- *The email or password is not right.*
- *This account is not an attendance admin*: it is a real Keystone account without the tick, or not a member of Keystone at all.
- *This account has been turned off*: disabled in Firebase.
- *There is no internet, and this account has not signed in on this kiosk in the last 7 days.*
- *Account sign-in is not set up in this app build*: the build has no Firebase project (a development build).

Code: `src-tauri/src/services/admin_account.rs`, `client/src/account-sign-in.tsx`. Keystone's side: `Deign86/apg-keystone`, `docs/adr/0030`.
