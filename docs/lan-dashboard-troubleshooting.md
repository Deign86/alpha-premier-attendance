# LAN Dashboard Troubleshooting

Check the front-desk laptop first: the Tauri process must be running, `lan.enabled` must be true (or the viewer started from the Live Attendance screen), and the configured bind address must still belong to the active Private network adapter.

Use `Invoke-WebRequest http://127.0.0.1:4173/api/health` locally, then `Test-NetConnection <front-desk-ip> -Port 4173` from the boss PC. A local success with a remote failure indicates Windows Firewall, a wrong network profile, or an incorrect `allowed_subnets` value. The in-app Live Attendance panel shows a local `/api/health` probe, the firewall rule state, and plain-language guidance for the most common causes.

Common causes, in order of likelihood:

1. **The laptop is on a Public network profile.** Windows blocks most inbound traffic. Set the Wi-Fi/LAN profile to **Private** (Settings → Network & Internet → Properties → Network profile type). The panel warns when this is detected.
2. **No firewall allow rule for the viewer port.** Create one with `netsh advfirewall firewall add rule name="Alpha Premier Live Attendance" dir=in action=allow protocol=TCP localport=4173 profile=private`. The panel reports whether an allow rule was found.
3. **The configured bind address is stale.** If `lan.bind_address` was set to an old IP, the viewer cannot start or phones cannot reach it. The panel says "The configured bind address does not match an active network adapter." Leave it unset to auto-detect, or update it to the current `ipconfig` address.
4. **The phone is on a different subnet or the Wi-Fi isolates clients.** Confirm the phone is on the same office Wi-Fi/LAN subnet as the laptop. Guest Wi-Fi, hotspot mode, and "AP/client isolation" router settings block device-to-device traffic and cannot be fixed from the laptop.
5. **The viewer is bound to localhost.** The panel says "Live Attendance is bound to localhost and cannot be reached by other devices." Loopback is never shareable; set `lan.bind_address` to the office LAN IP or leave it unset.

## The page hangs / loads forever

The viewer page never blocks on a broken stream: it renders the snapshot first, times out snapshot fetches after eight seconds, reconnects SSE with backoff, and keeps polling every five seconds as a fallback. If a phone still shows "Connecting…" for a long time, the TCP connection is being dropped silently (firewall/Public profile) or the Wi-Fi is isolating clients — follow the checks above.

If the page says stale or offline, keep the browser open while restoring the network. SSE reconnects automatically and five-second polling keeps the last successful snapshot current. RFID writes are independent of the viewer and must continue while the viewer is disconnected.

For authentication failures, use the configured viewer token only; never use the admin PIN or service-account JSON. Restart the Tauri app after changing `config.toml`.
