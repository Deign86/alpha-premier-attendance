# New interns from the ID register

The Alpha Premier ID Maker records every card it issues in a shared register (Keystone's Firebase project, `keystone/apg/idreg/{number}`). When the card is an intern's, this kiosk adds the person to Users on its own, waiting for a card. Employees are left out: this app is for interns.

The apps stay separate and share one backend. With the same sign-in the kiosk also keeps a copy of its own records there: see [shared-backend.md](shared-backend.md).

## What the kiosk does

- Every two minutes it asks the register how many intern cards there are (one read). Only when that number has changed does it read the list.
- Each new intern becomes an Active user named by their ID number (for example `APG-2026-126`), with the name and title printed on the card. Their card shows as **Waiting for a card**.
- A person the kiosk already has is never changed. A person an administrator deleted is never added again.
- No photo is copied. Photos stay on the computer that made the card.

## Giving a waiting person a card

1. Admin → Users. The person shows **Waiting for a card**.
2. Edit. The RFID UID field is empty: click it and tap the card.
3. Save. Their next tap records time-in.

Until then no tap or typed scan can stand in for them: a waiting user's stored UID is `PENDING-<user id>`, and scans are hex only.

## Setting it up (once per kiosk)

1. **Owner, in the Firebase console** (project `apg-keystone`): Authentication → Add user, with an email and password for this kiosk. Copy the new user's UID.
2. **Owner, in Firestore**: add the document `keystone/apg/devices/<that UID>` with a `name` field (for example `Attendance kiosk`). This account can then read the ID register and write the kiosk's backup, and nothing else. It is not a Keystone member. (Rules: `Deign86/apg-keystone`, `firestore.rules`.)
3. **On the kiosk**: Admin → System → ID register. Enter that email and password and sign in. The password is used once and not kept; the kiosk keeps a sign-in token in its own database.

To stop a kiosk: delete its `devices` document, or disable the account. The kiosk says so under ID register and stops asking.

## Building

The project is baked in at build time from two repository secrets, so neither is in the source:

- `ALPHA_PREMIER_FIREBASE_PROJECT_ID`
- `ALPHA_PREMIER_FIREBASE_API_KEY`

A release fails without them. A copy built by hand without them has no register: Admin → System says so and the kiosk asks nothing.

## What is kept on the kiosk

In `app_settings`: the account's email, its refresh token, the count last seen, the numbers already seen, when it last checked and the last problem. The refresh token is in the database file and in its backups; it can read the register and write the kiosk's backup, nothing more. Signing out removes the token.
