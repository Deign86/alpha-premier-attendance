# Windows and LAN Deployment

This runbook deploys the RFID kiosk on a Windows workstation. It supports a localhost-only kiosk and a private-LAN mode for approved clients. Do not expose the Express API directly to the public internet.

## Prerequisites

- Windows 10/11, current security updates, and a synchronized system clock.
- Node.js LTS and npm available to the deployment account.
- The repository copied to a stable path with write access for build artifacts.
- Google Sheets credentials and spreadsheet prepared using [google-sheets-setup.md](google-sheets-setup.md).
- RFID reader configured as a USB HID keyboard wedge and verified with [hardware-verification.md](hardware-verification.md).

## Install and Configure

Open PowerShell in the repository root:

```powershell
npm install
Copy-Item server/.env.example server/.env
```

Edit `server/.env` using a protected editor. At minimum set:

```text
GOOGLE_SHEET_ID=<spreadsheet-id>
GOOGLE_SERVICE_ACCOUNT_EMAIL=<service-account-email>
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n<private-key>\n-----END PRIVATE KEY-----\n"
TIMEZONE=Asia/Manila
CLIENT_ORIGIN=http://localhost:5173
PORT=3001
ENABLE_ADMIN=true
ADMIN_PIN=<server-only-admin-pin>
ADMIN_SESSION_SECRET=<long-random-server-secret>
ADMIN_SESSION_MINUTES=15
```

Office identity is optional in the web-compatible server; when unset the canonical defaults are used. Configure the same values as the desktop `[office]` section when the server must show a different office:

```text
COMPANY_NAME=Alpha Premier
OFFICE_LABEL=Main Office
OFFICE_ADDRESS_LINE_1=Unit 3104C
OFFICE_BUILDING=Tektite East Tower
OFFICE_DISTRICT=Ortigas Center
OFFICE_CITY=Pasig
OFFICE_REGION=Metro Manila
OFFICE_COUNTRY=Philippines
# Optional; leave unset until the postal code is confirmed.
OFFICE_POSTAL_CODE=
OFFICE_DISPLAY_SHORT=Tektite East Tower, Ortigas Center, Pasig
OFFICE_DISPLAY_FULL=Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila
```

Google service-account credentials are passed directly to the backend through environment variables. Do not commit `.env`, JSON keys, browser profiles, or captured card data. The React client must never receive these values.

The deployed site has three views: `/` for the RFID reader kiosk, `/attendance` for a public live attendance display, and `/admin` for PIN-protected user/RFID and attendance corrections. The live view polls the shared API every five seconds, so both PCs must use the same deployed origin and spreadsheet. `ADMIN_SESSION_SECRET` must be a long random value shared by all server instances. The older `ENABLE_CARD_SETUP`, `SETUP_ADMIN_PIN`, and `SETUP_SESSION_MINUTES` names remain accepted as compatibility aliases.

## Build and Validate

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run validate:sheets -w server
```

Resolve all failures before enabling the kiosk. The Sheets validator must pass against the production spreadsheet and exact tab/header contract.

## Localhost-Only Mode (Recommended First)

1. Set `HOST=127.0.0.1`.
2. Start the built server with `npm run start -w server`; Express serves the built client from `client/dist`.
3. Open `http://127.0.0.1:3001` on the same workstation in a dedicated browser profile.
4. Check `http://127.0.0.1:3001/api/health` and `http://127.0.0.1:3001/api/config`.
5. Run one disposable Time In/Time Out with the hardware verification checklist.

Use a browser kiosk/full-screen policy only after the normal browser flow is proven. Keep an administrator escape path for maintenance.

## Private-LAN Mode

Use LAN mode only when another approved device must load the kiosk or health endpoint.

1. Assign the workstation a stable private IPv4 address or DHCP reservation.
2. Keep the API on port `3001`; configure `CLIENT_ORIGIN` to the kiosk origin (for example `http://192.168.1.20:3001` for the production Express-served client, or `http://192.168.1.20:5173` during Vite development).
3. Bind the server through the Windows process/network configuration approved for the kiosk, and configure the client origin/API base URL for the LAN hostname or IP.
4. Verify the Windows network profile is **Private**, not Public.
5. Add a narrow inbound Windows Defender Firewall rule for the chosen TCP port and private subnet. Example (replace values after checking them):

```powershell
New-NetFirewallRule -DisplayName "RFID Attendance API (Private LAN)" `
  -Direction Inbound -Protocol TCP -LocalPort 3001 -Action Allow `
  -Profile Private -RemoteAddress 192.168.1.0/24
```

6. Test from the kiosk and one approved LAN client. Confirm an unapproved subnet cannot connect.

Do not forward the port from the router. For broader access, put a managed HTTPS reverse proxy or identity-aware gateway in front and keep the API private.

## Process Startup and Recovery

- Run the API under a dedicated Windows user with the minimum filesystem permissions needed for the app and key file.
- Use Task Scheduler, NSSM, or an approved Windows service wrapper to start after network availability and restart on failure. Keep the command and account documented.
- Configure graceful shutdown so in-flight requests finish or return an explicit failure before restart.
- On restart, check `/api/health`, review recent server logs, and perform one controlled test scan. Never assume an interrupted write failed; search `Attendance`/`AuditLogs` by `request_id` first.
- Keep browser auto-start and kiosk policies separate from API process recovery so the operator can inspect a stopped service.

## Health and Logs

Check locally:

```powershell
Invoke-RestMethod http://127.0.0.1:3001/api/health
Invoke-RestMethod http://127.0.0.1:3001/api/config
```

Health should report the service name, current timestamp, and connected Sheets status. Logs should include request IDs, action/error codes, latency, and safe operational context. They must not include service-account JSON, tokens, or full personal-data payloads.

## Backup, Updates, and Rollback

- Export a spreadsheet backup before releases, schema edits, or bulk roster changes.
- Keep the previous application build available until the new build passes health and hardware smoke tests.
- Update by stopping the process, replacing build artifacts, running typecheck/build/validator, then restarting and testing one disposable user.
- If health or data checks fail, stop scans, restore the previous build/config, and inspect uncertain writes by request ID before resuming.
- Record release version, spreadsheet backup timestamp, key rotation date, and operator sign-off.

## Firewall and Security Checklist

- [ ] API binds to localhost unless LAN access is explicitly required.
- [ ] Inbound rule is Private profile only and restricted to the approved subnet.
- [ ] No router port forwarding or public DNS points at the kiosk.
- [ ] CORS/origin allowlist contains only the kiosk/LAN origin.
- [ ] Service-account key and `.env` are outside source control and ACL-protected.
- [ ] Windows account running the service has no unnecessary administrator rights.
- [ ] Browser kiosk profile does not retain unrelated credentials or browsing data.
- [ ] Logs and backups are access-controlled and have a retention owner.

## Stop Conditions

Stop accepting scans and escalate when any of the following occurs: repeated `ATTENDANCE_DATA_CONFLICT`, an ambiguous write without a read-back result, unexpected duplicate rows, a leaked credential, a failing health check after restart, or a reader producing inconsistent UIDs. Preserve request IDs and sheet evidence; do not “fix” rows manually until the incident is understood.
