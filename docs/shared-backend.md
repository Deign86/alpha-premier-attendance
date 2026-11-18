# The attendance records in Firebase

While the kiosk is signed in to the ID register (Admin → System → ID register), its records are kept in the shared backend: Keystone's Firebase project, under `keystone/apg/att_<table>/<id>`.

**Firebase is the main record; the database on the kiosk is a working copy.** There is one kiosk and it is the only writer. Every tap and every change is written on the kiosk first, so nothing waits on the internet, and sent on the next pass. Nothing is merged, because nobody else writes.

## What is kept there

One document for each row of: `users`, `attendance`, `intern_grace`, `payroll`, `payroll_profiles`, `payroll_cutoffs`, `payroll_snapshots`, `bathroom_log`, `audit_logs`.

Each TIN and bank account number (`users` and `payroll_cutoffs`) is kept apart, under `keystone/apg/attprivate_<table>/<id>`, so that a later rule letting someone read attendance cannot show them.

## What stays on the kiosk only

- Settings (`app_settings`): they hold the admin PIN hash and sign-in tokens. A rebuilt kiosk is set up again (PIN, Sheets link).
- Photos, which are files on this computer.
- The Sheets queue and its state, export jobs and generated files, voice jobs, DTR reconciliation.

A test (`cloud_backup_never_covers_an_identity_number_or_a_secret`) fails if a later migration adds a column with such a name to a sent table without putting it apart.

## How it works

- It runs after each ID register pass (every two minutes), in the background. A tap never waits on it.
- A row is sent when it differs from what was last sent, and removed there when it is removed here. What was last sent is remembered by hash in `cloud-backup.json` beside the database. Deleting that file sends everything again, which is harmless **on a kiosk that has people**.
- At most 1,200 records go in one pass (60 requests of 20).
- With no internet nothing is lost: the next pass that gets through sends what changed.

## When Firebase becomes the main record

Once everything has been sent, the kiosk counts each collection in Firebase against its own database. When all are equal it keeps a copy of the database as it is at that moment (`attendance-before-firebase.db`, beside the database) and records the time; Admin → System then says "Firebase has been the main record since …". A collection that is short is sent again. This happens once.

## A new or reinstalled kiosk

A kiosk with **no people and no `cloud-backup.json`** fills its database from Firebase on its first pass after signing in, whole or not at all, and sends nothing back. A kiosk that has people is never filled. So: to replace the kiosk PC, install the program, set the admin PIN, sign in under Admin → System, and wait for the pass. Do not sign a second computer in with the kiosk's account while the kiosk is in use: there is one writer.

## Reading the status

Admin → System → ID register shows `Backup: N of M records are in the shared backend`, when it was last complete, since when Firebase is the main record, and any problem in plain words:

- *This kiosk's account may not write the backup*: the owner has not published Keystone's rules, or removed this kiosk from `devices`.
- *This kiosk's account may not read its records back yet*: Keystone's rules from ADR 0028 are not published yet.
- *Could not reach the shared backend*: no internet; it retries.
- *The shared backend refused part of the backup*: the message names the first record of the batch.
- *Firebase holds N of this kiosk's M … records*: they are sent again on the next pass.

## Who can read them

The kiosk's account and a Keystone owner. The rules and their tests are in `Deign86/apg-keystone` (`firestore.rules`, `e2e/cloud/kiosk-backup.e2e.ts`, `docs/adr/0027` and `0028`).

## Is this safer than before?

- Better: a dead kiosk PC no longer loses the records; the kiosk account's password is in no build; TINs and bank numbers are under their own lock.
- The cost: the kiosk's sign-in can now read everything back, so whoever holds it (the kiosk's Windows account, or a stolen kiosk) holds the records. Disable the kiosk's account in Firebase if the PC is lost.
- Google Sheets sync is unchanged: it still uses the service account file on the kiosk.

## Cost

About 7,000 writes for the first send of the present database, then a few hundred on a working day. The free plan allows 20,000 writes a day. The one-time count is about 11 reads.
