# Alpha Premier Attendance

Alpha Premier Attendance is a Windows-first RFID attendance kiosk for the front desk. The application runs as a Tauri v2 desktop app, stores operational data in local SQLite, and exposes a read-only live dashboard to other computers on the trusted office LAN.

The front-desk laptop is the only attendance writer and the only computer connected to the RFID reader. The boss can open the dashboard from a normal browser without installing Tauri.

## Architecture

```text
RFID reader
    |
    v
Front-desk Windows laptop
    |
    v
Tauri v2 Rust core ---- local Tauri events ---- kiosk and admin windows
    |
    +---- SQLite primary store
    |
    +---- Axum LAN server ---- browser dashboard on the office network
    |
    +---- asynchronous Google Sheets export and backup queue
```

SQLite is the source of truth. Google Sheets is an optional write-only export target and is never required for a successful local scan. The LAN server exposes only attendance snapshots, health, and an SSE event stream; admin, payroll, setup, photo, and mutation APIs remain local to the Tauri app.

## Requirements

- Windows 10 or Windows 11 for the packaged application
- Node.js 20 or newer and npm for development
- Rust stable with the Windows desktop toolchain for Tauri development
- Microsoft WebView2 Runtime on the target Windows machine when using the portable executable
- An RFID reader. The default profile targets 125 kHz EM4100 USB readers (keyboard wedge: 10 decimal digits followed by Enter, burst under 100 ms). Background scanning requires a configured serial/COM or uniquely addressed raw-HID reader through `[scanner]`; keyboard-wedge input is foreground-only and detection-based because a generic hook cannot isolate it from ordinary foreground typing.

## Install And Run

Install workspace dependencies:

```powershell
npm install
```

Run the existing web-compatible development stack:

```powershell
npm run dev
```

Run the Tauri desktop development application:

```powershell
npm run tauri:dev
```

The Tauri development command builds `client/` first and then launches the native application. The client retains the existing kiosk routes:

- `/` for RFID attendance scanning
- `/attendance` for the local attendance view
- `/admin` for protected administration and payroll

## Windows Packaging

Build the production client and NSIS installer:

```powershell
npm run tauri:build
```

The generated artifacts are:

```text
src-tauri/target/release/alpha-premier-attendance.exe
src-tauri/target/release/bundle/nsis/Alpha Premier Attendance_0.1.0_x64-setup.exe
```

The NSIS package includes the offline WebView2 Runtime installer and installs it machine-wide, so it works on machines that do not already have WebView2. Windows will request Administrator approval during installation. The portable executable is a single application binary and requires WebView2 to already be installed on the target machine; use the NSIS package for a self-contained deployment.

## Front-Desk Configuration

Copy the example configuration into the Tauri application config directory as `config.toml`:

```powershell
Copy-Item src-tauri/config.example.toml "$env:APPDATA\com.alphapremier.attendance\config.toml"
```

Update the values for the office. Leave `bind_address` unset (recommended) so the app auto-detects the laptop's active office Wi-Fi/LAN IP; set it only to a private address that is actually assigned to the laptop (verify with `ipconfig`). The LAN server is disabled by default:

```toml
[lan]
enabled = true
# bind_address = "192.168.1.50"  # optional; leave unset to auto-detect
port = 4173
allow_wildcard_bind = false
allowed_subnets = ["192.168.1.0/24"]
auth_mode = "password"
viewer_password_hash = "<sha256-hex-token-hash>"
admin_pin = "<local-admin-pin>"
admin_session_minutes = 15
sse_keep_alive_seconds = 15

# Optional Google Sheets export configuration.
google_service_account_json_path = "service-account.json"
google_spreadsheet_id = "<spreadsheet-id>"
```

Secrets stay on the front-desk laptop and must never be committed. The service-account JSON path is constrained to the application config directory when configured.

The web-compatible Node server (`server/`) keeps `GOOGLE_SHEET_ID` as the spreadsheet source of truth and can optionally auto-create/reuse a Google Drive folder and reconcile the spreadsheet schema on startup. Set `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_CREATE_FOLDER_IF_MISSING`, and `GOOGLE_SHEETS_STATE_FILE`; see [docs/google-sheets-setup.md](docs/google-sheets-setup.md) and [docs/deployment.md](docs/deployment.md).

## Office Identity

The canonical company office is configured once in the same `config.toml` and is used everywhere the app shows a place: the front-desk kiosk, the admin panel, the LAN dashboard, and every generated report or export.

```toml
[office]
company_name = "Alpha Premier"
office_label = "Main Office"
office_address_line_1 = "Unit 3104C"
office_building = "Tektite East Tower"
office_district = "Ortigas Center"
office_city = "Pasig"
office_region = "Metro Manila"
office_country = "Philippines"
# Optional and configurable only; leave unset until the postal code is confirmed.
office_postal_code = ""
office_display_short = "Tektite East Tower, Ortigas Center, Pasig"
office_display_full = "Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila"
```

The values above are the real office and are also the built-in defaults, so the app is correct even before any configuration file exists. Display rules:

- `office_display_short` is used in compact UI, badges, table headers, and narrow cards (for example `Tektite East Tower, Ortigas Center, Pasig`).
- `office_display_full` is used in admin settings, setup screens, printed/exported headers, PDF/report metadata, and office info sections.
- If a display string is missing, the app composes it from the structured fields. If nothing is configured, it falls back to the safe short label `Alpha Premier Office`.
- Exports and report headers include the office identity as `Company: Alpha Premier` / `Office: Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila`.

In the web-compatible development server the same fields are read from environment variables (`COMPANY_NAME`, `OFFICE_BUILDING`, `OFFICE_CITY`, etc.), with the same defaults and display behavior. See [docs/deployment.md](docs/deployment.md).

## Generated Files And Portable Mode

Every file the app creates (attendance workbooks, payroll workbooks, payroll CSV, payslips, and payroll register PDFs) is saved to the application **exports folder**, and the UI shows the exact saved path with `Open file` and `Show in folder` actions backed by the Tauri opener plugin.

Installed mode (default):

```text
%LOCALAPPDATA%\com.alphapremier.attendance\exports\
```

Portable mode is explicit and never assumed. Create an empty `portable.dat` file next to the portable `.exe` (or set `ALPHA_PREMIER_PORTABLE=1`). Generated files, photos, and the SQLite database then live under `Data/` next to the executable:

```text
D:\Alpha Premier Attendance\Data\exports\
D:\Alpha Premier Attendance\Data\attendance.db
```

- Exports never depend on the current working directory.
- Installed runs never write into Program Files or the install directory.
- `Show in folder` reveals the exact file in Explorer; if reveal fails it falls back to opening the containing folder, and missing files show `The file could not be found. It may have been moved or deleted.`
- File-action commands require an active administrator session and only accept paths inside the application data root.
- The legacy `open_generated_artifact` reveal command remains available and resolves the same relative export paths in both modes.

## Live Viewer On Same Wi-Fi

The front-desk laptop starts the read-only viewer. Other phones and laptops open the LAN IPv4 URL printed by the server or shown in the desktop Live Attendance panel. All devices must be on the same private Wi-Fi/LAN; guest Wi-Fi and AP/client isolation prevent device-to-device traffic.

Start the host:

```powershell
npm run dev                 # web development server, Vite is LAN-accessible
npm run tauri:dev           # packaged/local desktop flow
```

Find the host IPv4 address:

```powershell
ipconfig                    # Windows
```

```bash
ipconfig getifaddr en0     # macOS Wi-Fi
hostname -I                # Linux
```

Open `http://<host-lan-ip>:4173/attendance` on your mobile phone or browser (the exact link is also shown in the desktop app's Live Attendance screen). Do not use `localhost` or `127.0.0.1` on another device.

### Windows Firewall Configuration (One-Time Setup)

If devices on the same Wi-Fi hang or show "Connecting..." / load indefinitely, allow port 4173 in Windows Defender Firewall. Open **PowerShell as Administrator** on the host PC:

```powershell
netsh advfirewall firewall add rule name="Alpha Premier Live Attendance" dir=in action=allow protocol=TCP localport=4173
```

Or for subnet-specific scoping:

```powershell
New-NetFirewallRule -DisplayName "Alpha Premier Attendance LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173 -Profile Private
```

From another PC or phone on the same Wi-Fi, verify and connect:

```powershell
Test-NetConnection <host-lan-ip> -Port 4173
Invoke-WebRequest http://<host-lan-ip>:4173/api/health -UseBasicParsing
```

Open in mobile Safari / Chrome:

```text
http://<host-lan-ip>:4173/attendance
```

The mobile dashboard loads the attendance snapshot and connects to `GET /api/events/attendance` via Server-Sent Events (SSE) with background polling fallback. When an employee scans their RFID tag on the desktop kiosk, the mobile phone updates **immediately in real time with zero latency**.

Troubleshooting:

- **Phone page hangs / loads forever:** Run the `netsh advfirewall` command above as Administrator. Verify your phone is on the same Wi-Fi network and that the router does not have "AP/Client Isolation" enabled.
- **Viewer opens but has no updates:** Check `/api/health`, keep the page open; SSE reconnects automatically.
- **Viewer connects to localhost:** Use the LAN IP (e.g. `http://192.168.x.x:4173/attendance`), not `127.0.0.1`.

The LAN routes are:

| Route | Purpose |
| --- | --- |
| `GET /attendance` | Read-only browser dashboard |
| `GET /api/attendance/today?date=YYYY-MM-DD` | Read-only Manila-date snapshot |
| `GET /api/events/attendance` | Attendance SSE stream |
| `GET /api/health` | Service, SQLite, LAN, and export health |

No public bind, router forwarding, UPnP mapping, public DNS record, or cloud tunnel is supported by default. See [docs/lan-dashboard-deployment.md](docs/lan-dashboard-deployment.md) and [docs/lan-dashboard-troubleshooting.md](docs/lan-dashboard-troubleshooting.md) for the operator procedure.

## RFID And Attendance Rules

- Card taps are captured at the native layer from a configured device-specific transport (raw HID or serial). Keyboard-wedge readers are captured only while the kiosk window is focused (foreground, heuristic classification); background attendance from keyboard-wedge input is intentionally disabled because the keystrokes also reach the foreground application and cannot be isolated from it.
- The webview never needs a focused text box. The Rust layer completes a scan on the reader's Enter suffix or an idle-timeout fallback, sanitizes the UID to uppercase hex, strips separators, validates length, and dedupes repeats within a short window.
- The kiosk receives clean `rfid-scan` events and drives fast feedback: processing, success with the employee photo, unknown card, duplicate cooldown, and error states.
- The scanner listener pauses while the operator types in admin, setup, or manual-entry screens so keystrokes are never misread as card taps.
- Each user has one Time In and one Time Out per Manila calendar day (`Asia/Manila`).
- **Late time-outs.** The office does not allow overtime. A time-out recorded strictly after 17:00 Manila is saved as `LATE_TIMEOUT` instead of `COMPLETED`: the record is kept and shown with a distinct state on the live attendance screens (in-app dashboard and LAN viewer), no payroll row is generated, and the attendance editor flags it for manual re-input of the official time-out. Re-entering a time-out at or before 17:00 completes the shift normally. The rule lives in `shared/src/api-contracts.ts` (`isLateTimeout`, `OFFICE_HOURS_END`) and is mirrored in `src-tauri/src/services/office_hours.rs` for the desktop app.
- Local writes are committed to SQLite before local events or Sheets export are published.
- Accepted and rejected scan requests are correlated with a request ID in the audit log.

Scanner state (`Connected` / `Scanning` / `Offline` / `Error`) is surfaced as `scanner-status` events and can be inspected with the `scanner_status` command; diagnostics belong in admin/setup, never on the main kiosk screen.

Payroll preserves the existing intern weekly grace and PHP 10 late deduction rules, employee raw timestamps and computed hour ceiling/floor, semi-monthly cutoff profiles, allowances, incentives, manual adjustments, and finalization. The Payroll tab has exactly two generate actions — **Generate Employee Payroll PDF** and **Generate Intern Payroll PDF** — and each produces one consolidated, landscape payroll sheet PDF for the selected cutoff using Tauri's native Rust backend (printpdf, no browser print dialog): a single bordered table with the reference columns (Employee #, Employee Name, Cut Off Rate, Daily Rate, Actual Working Days, Standard Working Days, Basic Rate, Total Compensation, Late 10 /hr, Halfday, Absent, Gross Compensation, Grand Total), a company/cutoff header (with the optional TIN), and a yellow-highlighted Gross Compensation grand total. Each PDF is saved to the app exports folder with a timestamped name (`payroll_YYYY-MM-DD_HH-mm-ss_employee.pdf`), recorded in the `payroll_pdfs` SQLite table (period, worker type, employee count, total amount, SHA-256, size, generated-at), and listed in the Payroll tab history with **Open PDF** (system default viewer) and **Show in Folder** actions — the same opener commands used by every other generated file. Nothing is ever printed from the browser. Interns are fully included in the payroll system: they can be selected in the admin payroll workspace and appear on the intern sheet using the fixed PHP 80.00 per day rate and a PHP 10.00 per hour late deduction (after weekly grace). Employees are subject to late deductions too: the cutoff payroll form includes a fillable late-deduction section where the payroll staff enters the employee's total late hours and a PHP-per-hour deduction rate; the deduction amount is computed from those values, can be overridden, and flows through to the saved record, the on-screen table, and the employee payroll sheet. The automatic daily employee payroll module intentionally retains:

```rust
// TODO: Employee late rules TBD by client
```

**Lunch break rule.** Paid hours never include the fixed 12:00–13:00 lunch window (`Asia/Manila`). The rule is centralized in `src-tauri/src/services/lunch_break.rs` (desktop app) and `server/src/lunch-break.ts` (legacy server), and it applies to employees and interns alike: daily worked hours, the attendance workbook `TOTAL_HOURS` column, and any derived payroll hour values subtract only the portion of the lunch window that overlaps the worked interval (partial clock-in/out inside the window and multi-day spans are handled). Overtime hours entered on cutoff payroll are recorded net of lunch; intern lateness continues to be measured against the 08:00 start and is unaffected.

## Photos And Security

Photos are stored locally under the Tauri application data directory as `{user_id}.webp`. Uploads accept JPEG, PNG, or WebP input up to 512 by 512 pixels and 500 KB. The command returns a local `asset://` URL; photos are never served through the LAN dashboard.

## Window, Tray, And Scanner Setup

**Window and tray.** Closing the main window hides the app to the system tray instead of exiting; scanning and the LAN viewer keep running. The tray menu offers **Show attendance app** and **Exit application** — only Exit terminates the process (and stops scanning). A successful scan recorded while the window is hidden or unfocused shows a Windows toast notification without stealing focus.

**EM4100 reader setup.** The reader ships as a USB keyboard wedge: a card tap types the 10-digit decimal ID plus Enter. With the default `scanner.mode = "keyboard"` the kiosk captures this burst only while its window is focused — tap a card without clicking anything and the scan is recorded. The default profile is `scanner.expected_length = 10` and `scanner.character_set = "decimal"`; readers programmed to emit 8 hexadecimal characters use `expected_length = 8`, `character_set = "hex"`, and `expected_length = 0` disables exact-length matching (4–64 characters still applies).

**Background scanning.** Verified background capture (minimized/tray-hidden, no focus required) is possible only for a uniquely addressed raw-HID reader (`scanner.mode = "hid"` with `scanner.hid_vid`/`scanner.hid_pid`) or a serial reader (`scanner.mode = "serial"` with `scanner.serial_port`). Keyboard-only readers cannot provide verified background capture without a signed filter driver, which is out of scope. The admin **Scanner diagnostics** panel lists all HID devices (path, VID/PID, product, usage page/usage, interface) and flags keyboard-interface devices so the reader can be identified and configured; a keyboard HID interface is labeled foreground-only.

Admin and setup sessions are short-lived in-memory Tauri state. The admin PIN, viewer token hash, and Google credentials are local configuration values and are never sent to the boss browser. The LAN viewer is read-only and subnet restricted.

## Data Migration

Export the existing Sheets tabs as CSV files named:

```text
Users.csv
Attendance.csv
AuditLogs.csv
InternGrace.csv
Payroll.csv
PayrollProfiles.csv
PayrollCutoffs.csv
```

Run a review-only migration first:

```powershell
npm run migrate:from-sheets -- --dry-run --input .\sheets-export
```

After reviewing headers, row counts, dates, identifiers, and payroll relationships, execute the import:

```powershell
npm run migrate:from-sheets -- --execute --input .\sheets-export --db .\attendance.db
```

The importer applies numbered SQLite migrations, imports the available tabs, and verifies imported row counts. Keep the old web deployment read-only for one pay period while comparing attendance and payroll results. See [docs/migration-cutover.md](docs/migration-cutover.md).

### Moving the app to a new front-desk PC

SQLite is the source of truth, and the whole database lives in one file (`attendance.db`). To move the app to the actual front-desk PC — or any replacement machine — use **Admin → Data and backup**:

1. On the old PC: **Create backup now** (the app writes a consistent snapshot via SQLite's online backup engine — safe even while the app is running — into `backups/`; one is also written automatically on every clean exit).
2. Copy `attendance-backup-*.apbackup` to a USB drive. This archive contains the complete application state: database, photos, exports, sync state, and configuration.
3. On the new PC: **Restore from backup file…** and confirm. The app closes, validates the file, restores on the next launch (the previous database is saved first as `backups/pre-restore-*.db`), and runs migrations automatically.

The database location is configurable — `[database] path` in `config.toml` (relative to the config directory, so portable deployments travel with their data) or the `ALPHA_PREMIER_DB_PATH` environment variable — and defaults to the data directory. A technician/installer flow exists at [scripts/migrate-database.ps1](scripts/migrate-database.ps1) and `ALPHA_PREMIER_RESTORE_FROM` for automated provisioning. Full runbook and troubleshooting: [docs/database-migration.md](docs/database-migration.md). Never copy `attendance.db` while the app is open — WAL writes can be lost.

## Development Commands

```powershell
npm run build
npm run typecheck
npm run lint
npm test
npm run rust:check
npm run rust:test
npm run migrate:from-sheets -- --dry-run --input .
```

The Rust crate uses SQLx migrations under `src-tauri/db/migrations`. SQLite is opened in WAL mode with foreign-key enforcement. The seeded profiles are `JEAN_TENURED` and `BEA_STANDARD`.

## Repository Layout

```text
client/       React, Vite, TypeScript kiosk and admin UI
server/       Existing web API retained for compatibility and comparison
shared/       Shared TypeScript API and LAN contracts
src-tauri/    Tauri v2 application, Rust commands, services, SQLite, LAN server
docs/         Deployment, hardware, payroll, migration, and troubleshooting guides
scripts/      Development and migration helper scripts
plan.md       Complete migration architecture and acceptance plan
```

## Branding

Brand assets live in two places, both repo-relative and machine-independent:

- `assets/` — original source PNGs (full wordmark, group wordmark, phoenix mark).
  The Rust PDF and Excel generators embed `assets/logo_phoenix.png` at compile
  time via `include_bytes!`, so reports never depend on runtime paths.
- `client/src/assets/branding/` — copies imported by Vite for the kiosk, admin,
  live attendance, and printable payroll worksheets.

Usage is intentional per surface: the kiosk and dashboard headers use the compact
phoenix mark, printable payroll worksheets use the official full wordmark, and
generated payslip/register PDFs and the payroll workbook carry the phoenix mark
in the header. Print output stays clean (no browser date/URL/page-count chrome).


## Scope And Non-Goals

The front-desk laptop remains the single source of truth and single attendance writer. Public internet hosting, remote access outside the office LAN, multi-writer deployments, browser-based remote admin, auto-updates, statutory deductions, and employee late-rule changes are outside the current release.
