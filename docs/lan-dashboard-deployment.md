# LAN Live Attendance Deployment

The front-desk Windows laptop is the only attendance writer and the only computer that needs the Tauri installer. The boss PC is a read-only browser client on the same trusted private office network.

## Front-desk laptop

1. Give the laptop a DHCP reservation or static private address, for example `192.168.1.50`.
2. Set the Windows network profile to **Private** (the Live Attendance screen warns when the profile is Public, which blocks inbound traffic by default).
3. Copy `src-tauri/config.example.toml` to the Tauri application config directory as `config.toml`.
4. Leave `lan.bind_address` **unset** so the app auto-detects the active office Wi-Fi/LAN IP. Set it only when the laptop has a fixed private address, and confirm it with `ipconfig` — a stale bind address is the most common reason the viewer works on the laptop but phones on the same Wi-Fi cannot open it.
5. Set `lan.port = 4173` and, when the office needs it, `lan.allowed_subnets = ["192.168.1.0/24"]`. An empty subnet list allows any private address on the same LAN.
6. Keep `lan.allow_wildcard_bind = false`. A wildcard bind is permitted only when an operator explicitly enables it and supplies an office subnet.
7. Use `auth_mode = "password"` with a SHA-256 token hash when the dashboard must be gated. Pass the token once in the URL as `?token=...`; never put the token in source code or the installer.

### Starting the viewer

* **Auto-start:** with `lan.enabled = true`, the viewer starts when the app boots.
* **On demand:** the in-app **Live Attendance** screen (`/attendance`) starts (or verifies) the viewer when opened, even when `lan.enabled = false`. Set `lan.allow_runtime_start = false` in `config.toml` to disable the viewer entirely; the panel then shows **Disabled**.
* The panel shows the current state (**Starting / Running / Stopped / Disabled / Needs attention**), the shareable URL built from the laptop's real LAN IP (never localhost), the port, the LAN IP, allowed subnets, network profile, firewall rule state, a local `/api/health` probe result, and **Copy URL** / **Open Local Viewer** actions.
* When no `lan.bind_address` is configured, the app auto-detects the active office Wi-Fi/LAN IPv4 and binds to it.

Create the firewall rule from an elevated PowerShell prompt, adjusting the subnet for the office:

```powershell
New-NetFirewallRule -DisplayName "Alpha Premier Attendance LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173 -Profile Private -RemoteAddress 192.168.1.0/24
```

A `netsh` equivalent (shown in the in-app guidance) is:

```bat
netsh advfirewall firewall add rule name="Alpha Premier Live Attendance" dir=in action=allow protocol=TCP localport=4173 profile=private
```

Do not create a Public-profile rule, router port forward, UPnP mapping, public DNS record, or cloud tunnel.

## Boss PC connectivity test

From the boss PC, verify the route and port before opening the dashboard:

```powershell
Test-NetConnection 192.168.1.50 -Port 4173
Invoke-WebRequest http://192.168.1.50:4173/api/health -UseBasicParsing
```

Open `http://192.168.1.50:4173/attendance` (add the configured viewer token query parameter when password mode is enabled). The page must show the current Manila date, a live state chip, and the day's time-ins/time-outs newest first. The laptop itself can also verify locally with `Invoke-WebRequest http://127.0.0.1:4173/api/health` — the laptop is always allowed even when subnets are configured.

The viewer page matches the Alpha Premier design (dark brand header, gold accents, refined cards). It loads the snapshot immediately from `/api/attendance/today?date=YYYY-MM-DD`, then receives real-time updates over Server-Sent Events at `/api/events/attendance`; if the stream drops it reconnects with backoff and falls back to polling every few seconds. Snapshot fetches time out after eight seconds and the page reports **Offline** instead of hanging forever. It contains no admin, setup, payroll, mutation, or secret material.

## Acceptance test

1. Leave the dashboard open on the boss PC.
2. Scan an enrolled RFID card on the front-desk reader.
3. Confirm the SQLite-backed row appears on the boss browser within two seconds and the SSE connection remains live.
4. Disconnect the laptop from the network for at least ten seconds. The boss page must show stale/offline state and continue polling/reconnecting.
5. Scan while the dashboard is unreachable. The kiosk must still commit the scan locally and report success.
6. Reconnect the network and confirm the browser refreshes to the current snapshot.
7. From a machine outside the allowed subnet, verify TCP 4173 and all viewer routes are blocked.

The LAN surface never exposes admin, payroll, setup, photo, RFID, sync, or mutation routes. Google credentials, admin PINs, SQLite files, photos, and audit logs remain on the front-desk laptop.
