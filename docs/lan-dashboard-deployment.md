# LAN Live Attendance Deployment

The front-desk Windows laptop is the only attendance writer and the only computer that needs the Tauri installer. The boss PC is a read-only browser client on the same trusted private office network.

## Front-desk laptop

1. Give the laptop a DHCP reservation or static private address, for example `192.168.1.50`.
2. Set the Windows network profile to **Private**.
3. Copy `src-tauri/config.example.toml` to the Tauri application config directory as `config.toml`.
4. Set `lan.enabled = true`, `lan.bind_address = "192.168.1.50"`, `lan.port = 4173`, and `lan.allowed_subnets = ["192.168.1.0/24"]`.
5. Keep `lan.allow_wildcard_bind = false`. A wildcard bind is permitted only when an operator explicitly enables it and supplies an office subnet.
6. Use `auth_mode = "password"` with a SHA-256 token hash when the dashboard must be gated. Pass the token once in the URL as `?token=...`; never put the token in source code or the installer.

Create the firewall rule from an elevated PowerShell prompt, adjusting the subnet for the office:

```powershell
New-NetFirewallRule -DisplayName "Alpha Premier Attendance LAN" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 4173 -Profile Private -RemoteAddress 192.168.1.0/24
```

Do not create a Public-profile rule, router port forward, UPnP mapping, public DNS record, or cloud tunnel.

## Boss PC connectivity test

From the boss PC, verify the route and port before opening the dashboard:

```powershell
Test-NetConnection 192.168.1.50 -Port 4173
Invoke-WebRequest http://192.168.1.50:4173/api/health -UseBasicParsing
```

Open `http://192.168.1.50:4173/attendance` (add the configured viewer token query parameter when password mode is enabled). The page must show the current Manila date and a live state.

## Acceptance test

1. Leave the dashboard open on the boss PC.
2. Scan an enrolled RFID card on the front-desk reader.
3. Confirm the SQLite-backed row appears on the boss browser within two seconds and the SSE connection remains live.
4. Disconnect the laptop from the network for at least ten seconds. The boss page must show stale/offline state and continue polling/reconnecting.
5. Scan while the dashboard is unreachable. The kiosk must still commit the scan locally and report success.
6. Reconnect the network and confirm the browser refreshes to the current snapshot.
7. From a machine outside the allowed subnet, verify TCP 4173 and all viewer routes are blocked.

The LAN surface never exposes admin, payroll, setup, photo, RFID, sync, or mutation routes. Google credentials, admin PINs, SQLite files, photos, and audit logs remain on the front-desk laptop.
