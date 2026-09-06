---
name: create-verification-skill
description: "Generate a project-local verification skill that drives your app the way a user does — main driver is Tauri MCP, which exercises the live app to surface bugs. Use for /create-verification-skill, \"make a control skill for this repo\", or when a project has no scripted way to prove UI/CLI/service behavior."
disable-model-invocation: true
---

# Create a verification skill

Every serious project needs a scripted way to drive the real app and prove behavior: launch it, exercise a feature the way a user would, and capture evidence. This skill generates that as a project-local skill (`.cursor/skills/verify-<app>/`) tailored to the repo. You write the generator's output for the next agent, not for a human: it will be read cold, mid-task, by an agent that has never seen the app.

## 1. Interview the repo, not the user

Answer these from the codebase and only ask the user what you cannot observe:

- **Surface:** what does a user actually touch? A web UI, a CLI/TUI, a desktop app, an API, a mobile app, a library? A repo can have several; pick the primary one and note the rest.
- **Run:** how does the app start locally? Prefer the repo's own documented dev command (package scripts, Makefile, README quickstart). Note ports, env vars, seed data, auth.
- **Drive:** how can an agent interact with it programmatically? Main driver is Tauri MCP (see the driver reference below): the live desktop app is driven through the Tauri MCP bridge — UI via `tauri_webview_*` tools, backend state via `tauri_ipc_execute_command`, headless scripts via the raw bridge protocol. Existing repo harnesses (`scripts/verify-*.mjs`, `doctor` scripts) come second. Only for non-Tauri apps fall back to a generic recipe: browser/CDP for web and Electron, a tmux/PTY harness for CLI/TUI, plain HTTP for services.
- **Observe:** what evidence can be captured? Screenshots, terminal transcripts, response bodies, logs, exit codes, DB state.
- **Isolate:** can two instances run side by side (ports, data dirs, profiles)? If not, say so in the generated skill: refusing to double-drive a shared instance beats corrupting the user's session.

If the checkout doesn't build or start as-is, fix that first (or report it precisely) before generating; a skill written against a broken base teaches wrong steps. When an irrelevant missing asset blocks startup (a static dir the API never serves, a sample config), the generated skill may create it, clearly marked as verification scaffolding, and remove it in cleanup.

## Tauri MCP driver reference (main driver)

Every generated skill drives the app through Tauri MCP. Bake these repo-grounded facts in — never invent alternatives:

- **Launch:** `npm run tauri:dev` (`tauri:dev:fast` for iteration). Ready when Vite answers on `http://127.0.0.1:5173` and the bridge listens on `ws://127.0.0.1:9223`, window titled "Alpha Premier Attendance".
- **Doctor:** `npm run doctor:mcp` (read-only pre-flight).
- **Gateway tools (interactive driving):** `tauri_driver_session` (`start`/`status`/`stop`), `tauri_webview_find_element`, `tauri_webview_interact`, `tauri_webview_keyboard`, `tauri_webview_wait_for`, `tauri_webview_execute_js`, `tauri_webview_dom_snapshot`, `tauri_webview_screenshot`, `tauri_ipc_execute_command` with envelope `{ "command": "<name>", "args": { ... } }`, `tauri_ipc_monitor`, `tauri_manage_window`. There is no `ServerName`/`ToolName`/`Arguments` envelope and no `payload` key — those never reach the backend.
- **IPC arg casing:** Tauri `#[command]` wire keys are lowerCamelCase by default (`rfid_uid` in Rust is `rfidUid` on the wire). Harnesses must send camelCase.
- **Auth:** default admin PIN is `293906` (config-file-overridable); `setup_unlock` returns the session token every authenticated command needs.
- **Headless harness protocol (raw WebSocket, NOT JSON-RPC):** frames are `{ "id": "<string>", "command": "<name>", "args": { ... } }`, matched by string `id`. Valid commands: `execute_js` with `{ "script": "return await window.__TAURI_INTERNALS__.invoke('<cmd>', <camelCaseArgs>)" }`, `capture_native_screenshot`, `list_windows`, `get_window_info`. The bridge speaks no `initialize` / `tools/list` / `tools/call` — a script written against those hangs forever waiting for replies that never come.
- **5-second budget:** `execute_js` resolves server-side within 5s. Only drive commands that resolve fast; a command that needs subprocesses or network probes must be fixed (concurrent, capped, fail-open) before it can be verified live.
- **Bug-surfacing bar:** drive edge and hostile inputs (unregistered cards, wrong PINs, timeout paths), assert response SHAPES not just success flags, and forbid silent swallows in harnesses — an error the harness hides is a bug the skill will never find.

## 2. Generate the skill

Write `.cursor/skills/verify-<app>/SKILL.md` with YAML frontmatter (`name: verify-<app>` and a `description` that names the app, the surface, and when to reach for it — without frontmatter the skill never registers) and these sections, each grounded in what the interview actually found (no placeholders left):

- **Launch:** the exact command that starts the app for verification, and how to tell it's ready (a log line, a port answering, a prompt). Include teardown. For a short-lived CLI or TUI there is no server to keep alive: launch means build the binary (or install deps) once, then start each drive in its own isolated PTY or tmux session.
- **Doctor:** one read-only check that answers "is this instance worth driving?" — process up, right version/build, port owned by us, auth valid. An agent runs this first whenever anything looks off.
- **Drive:** the Tauri MCP recipe with real selectors/commands from this repo, not examples: `tauri_webview_*` locator/interaction calls with stable handles (ARIA labels, data attributes) and `tauri_ipc_execute_command` calls with the exact camelCase `{command, args}` shape. Prefer stable handles over coordinates and tab order.
- **Evidence:** what to capture for a proof and where it goes. State the proof standards: exercise the real user path, not internal setters or test-only endpoints; capture the action and the resulting state, not just the final screen; verify side effects (files written, rows inserted, messages sent) alongside what's visible; mocks only where a production boundary already isolates the external system. Live proof means the harness drove the running app over Tauri MCP (e.g. `scripts/verify-tauri-mcp.mjs` 7/7 with `evidence/verification-summary.json` plus screenshots). Standalone/offline mode verifies contracts only and must be LABELED as such — never report contract-only results as live green. When the safe path is a dry-run or test mode, verify what it actually skips by observing (files, network, git refs) rather than trusting its name: some dry-runs still touch the network or open a browser.
- **Cleanup:** how to tear down instances the run created. Never kill by process name; kill what you started. Cleanup removes instances and scratch state, never the evidence: proof artifacts survive the teardown, in a location the skill names.
- **Helpers:** any script the skill ships is executable and its invocation is shown in the skill body. A helper the reader has to reverse-engineer is not a helper.

## 3. Seed the feature map

Create `.cursor/skills/verify-<app>/features/README.md` plus one file per user-facing feature you can identify (aim for the top 3-5 to start, from routes, commands, menus, or docs). Follow the shape in [`references/feature-map-example/`](references/feature-map-example/), with a README index and one file per feature. Each file answers, from the user's point of view: what the feature is, how to reach it, how to drive it with the harness, and what observable end state proves it works. The four H2s are `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`. The map is the repo's maintained verification source; a proof that drives one convenient entry point is incomplete when the map lists others.

## 4. Prove the generated skill before handing it over

Run its own instructions end to end once against the live app over Tauri MCP: launch, doctor, drive ONE mapped feature (one is enough; the map exists so later runs can cover the rest), capture evidence, clean up. After cleanup, confirm the evidence still exists at the named location — a cleanup that eats the proof fails this step. Fix what fails, and run the generated cleanup after every failed iteration too, so broken attempts don't strand processes and ports. A generated skill that was never executed is a draft, not a deliverable.

## 5. Offer the maintenance loop

Point the user at `/maintain-verification-skill` for keeping the map honest as the app changes. Suggest a cadence only if they ask.
