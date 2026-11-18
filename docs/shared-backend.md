# The kiosk's backup in the shared backend

While the kiosk is connected to the ID register (it connects by itself; see [id-register.md](id-register.md)), it also keeps a copy of its records in the shared backend: Keystone's Firebase project, under `keystone/apg/att_<table>/<id>`. Keystone and the other Alpha Premier programs can then read attendance and payroll from one place, and a lost kiosk is not lost records.

**The database on the kiosk is the original.** The copy goes one way. Nothing is ever read back from it, and editing it in Firebase changes nothing here.

## What is copied

One document for each row of: `users`, `attendance`, `intern_grace`, `payroll`, `payroll_profiles`, `payroll_cutoffs`, `payroll_snapshots`, `bathroom_log`, `audit_logs`.

## What stays on the kiosk

- Settings (`app_settings`): they hold the admin PIN hash and sign-in tokens.
- Every TIN and bank account number (`users` and `payroll_cutoffs`).
- Photos, which are files on this computer.
- The Sheets queue and its state, export jobs and generated files, voice jobs, DTR reconciliation.

A test (`cloud_backup_never_covers_an_identity_number_or_a_secret`) fails if a later migration adds a column with such a name to a copied table without leaving it out.

## How it works

- It runs after each ID register pass (every two minutes), in the background. A tap never waits on it.
- A row is sent when it differs from what was last sent, and removed there when it is removed here. What was last sent is remembered by hash in `cloud-backup.json` beside the database. Deleting that file sends everything again, which is harmless.
- At most 1,200 records go in one pass (60 requests of 20), so the first backup of the present database takes about six passes, some twelve minutes. Requests are small because Keystone's rules check the kiosk once for each record and Firestore limits how many checks one request may make.
- With no internet nothing is lost: the next pass that gets through sends what changed.

## Reading the status

Admin → System → ID register shows `Backup: N of M records are in the shared backend`, when it was last complete, and any problem in plain words:

- *This kiosk's account may not write the backup*: the owner has not published Keystone's rules for it, or removed this kiosk from `devices`.
- *Could not reach the shared backend*: no internet; it retries.
- *The shared backend refused part of the backup*: the message names the first record of the batch.

## Who can read the copy

Only a Keystone owner. The kiosk's account writes it and cannot read it back. The rules and their tests are in `Deign86/apg-keystone` (`firestore.rules`, `e2e/cloud/kiosk-backup.e2e.ts`, `docs/adr/0027`).

## Cost

About 7,000 writes for the first backup of the present database, then a few hundred on a working day. The free plan allows 20,000 writes a day.
