# LAN Live Attendance Viewer Fix

## Root causes found

- The legacy Node server called `app.listen(port)` and only advertised `localhost`; bind host and LAN diagnostics were not configurable.
- The Vite proxy target was hardcoded to `http://localhost:3001`.
- Browser API calls were scattered across `client/src/api.ts`, so a separately hosted viewer could not consistently honor an API host override.
- The Tauri viewer already had a read-only Axum server, private IPv4 selection, SSE, polling fallback, and connection status; those existing safeguards are retained.

## Files changed

- `client/src/network.ts`, `client/src/network.test.ts`: centralized browser API, SSE, and WebSocket URL resolution.
- `client/src/api.ts`: route all web API requests through the resolver.
- `client/src/dev-server-config.ts`, `client/vite.config.ts`: configurable proxy and LAN-accessible Vite host.
- `client/src/vite-config.test.ts`: proxy contract test.
- `client/.env.example`, `server/.env.example`: documented LAN endpoint and bind settings.
- `server/src/config.ts`, `server/src/app.ts`, `server/src/index.ts`: configurable host, targeted CORS, LAN URL diagnostics.
- `scripts/start-dev.mjs`: LAN bind defaults for the development server.
- `README.md`: same-Wi-Fi setup, platform IP lookup, firewall and troubleshooting guidance.

## LAN architecture

The packaged flow remains `Tauri -> Axum LAN server -> read-only browser viewer`. The Rust server binds the configured private IPv4 or the detected active LAN IPv4, serves the snapshot and SSE stream, reconnects with polling fallback, and exposes only attendance/health routes. The web development flow uses Vite on `0.0.0.0`; browser requests default to the current origin and can be redirected with `VITE_API_BASE_URL`.

The Node API binds to `HOST` (default `0.0.0.0`) and `PORT` (default `3001`), prints loopback plus detected RFC1918 URLs, and permits only configured CORS origins for cross-origin requests.

## Test matrix

| Scenario | Expected result |
| --- | --- |
| Host machine opens localhost | Snapshot and health succeed. |
| Device 1 opens host LAN IPv4 | Viewer loads without localhost requests. |
| Device 2 opens host LAN IPv4 | Same live snapshot and SSE stream are available. |
| New scan while both viewers are open | Both viewers update without refresh. |
| SSE disconnect | Viewer shows reconnecting/offline status, then refreshes current state and avoids duplicate rows. |
| Untrusted CORS origin | API rejects the cross-origin request unless explicitly configured. |

## Manual verification

1. Start `npm run tauri:dev` or the packaged executable with `[lan] enabled = true` and confirm the printed/panel URL is a private LAN IPv4.
2. On the host, run `Invoke-WebRequest http://127.0.0.1:4173/api/health`.
3. On two separate same-Wi-Fi devices, open `http://<host-lan-ip>:4173/attendance`.
4. Scan an enrolled card and confirm the row appears on both devices within two seconds.
5. Temporarily block or disconnect the host network; confirm status changes to reconnecting/offline, then reconnect and confirm the current snapshot returns.
6. For web development, open the Vite LAN URL and verify `VITE_API_BASE_URL` is empty or points to the intended API host.

## Limitations and security

Windows Firewall and Wi-Fi AP/client isolation remain environmental controls. The viewer is intentionally read-only and private-network scoped; admin, setup, payroll, exports, photos, and secrets remain local. Do not forward the port publicly, enable UPnP, or use a public network profile for office sharing.
