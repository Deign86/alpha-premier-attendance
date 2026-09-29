# client/
## Responsibility
The client package is the browser/Tauri frontend build boundary: it serves the React attendance UI and configures development, production bundling, and Vitest. The actual UI and runtime adapters live under `src/`.

## Design
- `package.json` defines Vite dev/build, TypeScript typecheck, ESLint, and Vitest scripts; React 18, Tauri v2 plugins, and `@rfid-attendance/shared` are runtime dependencies.
- `vite.config.ts` installs the React plugin, emits the production bundle without sourcemaps/compressed-size reporting, proxies `/api` through `attendanceApiProxy`, and runs tests in jsdom with `src/test/setup.ts`.
- `dev-server-config.ts` provides the `/api` proxy target from `VITE_API_PROXY_TARGET`, defaulting to `http://127.0.0.1:3001`.
- `index.html` supplies the root mount element and loads `/src/main.tsx` as the module entry point.

## Flow
1. Vite serves `index.html` during development or bundles it for production; its module script enters `src/main.tsx`.
2. `main.tsx` initializes the MCP automation helper and mounts `App` inside React `StrictMode` at `#root`.
3. Frontend API requests to `/api` use Vite's proxy in development; the frontend's production build is compiled with `tsc -b` before Vite bundles it.
4. `npm test` invokes Vitest using the configured jsdom environment and setup module.

## Integration
- Consumed by: desktop Tauri webview and browser development/runtime; `index.html` is the frontend document entry.
- Depends on: `src/main.tsx`, `src/dev-server-config.ts`, Vite, `@vitejs/plugin-react`, React, Tauri v2 APIs/plugins, and `@rfid-attendance/shared`.
- Development API routing: `vite.config.ts` → `attendanceApiProxy` in `src/dev-server-config.ts` → configured backend target.
- Commands: `npm run dev`, `npm run build`, `npm run typecheck`, `npm run lint`, and `npm test`.
