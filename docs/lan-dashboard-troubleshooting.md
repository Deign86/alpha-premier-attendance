# LAN Dashboard Troubleshooting

Check the front-desk laptop first: the Tauri process must be running, `lan.enabled` must be true, and the configured bind address must still belong to the active Private network adapter.

Use `Invoke-WebRequest http://127.0.0.1:4173/api/health` locally, then `Test-NetConnection <front-desk-ip> -Port 4173` from the boss PC. A local success with a remote failure indicates Windows Firewall, a wrong network profile, or an incorrect `allowed_subnets` value.

If the page says stale or offline, keep the browser open while restoring the network. SSE reconnects automatically and five-second polling keeps the last successful snapshot current. RFID writes are independent of the viewer and must continue while the viewer is disconnected.

For authentication failures, use the configured viewer token only; never use the admin PIN or service-account JSON. Restart the Tauri app after changing `config.toml`.
