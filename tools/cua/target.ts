import { execFile } from 'node:child_process';
import net from 'node:net';

export const CUA_TARGET_WIDTH = 1280;
export const CUA_TARGET_HEIGHT = 800;
export const CUA_MAIN_WINDOW_ID = 'main';
export const CUA_APP_NAME_MATCH = /alpha premier attendance/i;

export type CuaScenarioId = 'CUA-JEV-01' | 'CUA-JEV-02' | 'CUA-JEV-03';
export interface CuaGeometry { width: number; height: number; x: number; y: number; }
export interface CuaTarget { pid: number; windowId: string; elementToken: string; geometry: CuaGeometry; }
export interface CuaSnapshot { target: CuaTarget; fresh: boolean; capturedAt: string; }
interface DriverAppEntry { name: string; pid: number; running: boolean; }
interface DriverAppsPayload { apps: DriverAppEntry[]; }
interface DriverWindowEntry { window_id: number; pid: number; x: number; y: number; width: number; height: number; minimized: boolean; }
interface DriverWindowsPayload { windows?: DriverWindowEntry[]; _legacy_windows?: DriverWindowEntry[]; }

const SCENARIO_TOKENS = {
  'CUA-JEV-01': 'kiosk-record-submit',
  'CUA-JEV-02': 'kiosk-record-submit',
  'CUA-JEV-03': 'bathroom-checkout',
} satisfies Record<CuaScenarioId, string>;

export function pinnedGeometry(): CuaGeometry {
  return { width: CUA_TARGET_WIDTH, height: CUA_TARGET_HEIGHT, x: 0, y: 0 };
}

export function resolveCuaTarget(scenarioId: CuaScenarioId): CuaTarget {
  return { pid: process.pid, windowId: CUA_MAIN_WINDOW_ID, elementToken: SCENARIO_TOKENS[scenarioId], geometry: pinnedGeometry() };
}

export function freshSnapshot(target: CuaTarget): CuaSnapshot {
  return { target, fresh: true, capturedAt: new Date().toISOString() };
}

// Reuses scripts/cua-jev-doctor.mjs tcpProbe shape (net.Socket, bounded timeout).
export function tcpProbe(port: number, host = '127.0.0.1', timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new net.Socket();
    s.setTimeout(timeoutMs);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => { s.destroy(); resolve(false); });
    s.connect(port, host);
  });
}

// Primary channel: cua-driver stdio (no new deps; in-process fallback deferred).
export function runDriverCall(tool: string, argsJson = '{}'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('cua-driver', ['call', tool, argsJson], { timeout: 8000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err) { resolve(null); return; }
      resolve(String(stdout));
    });
  });
}

export async function resolveTauriMainWindow(scenarioId: CuaScenarioId = 'CUA-JEV-01'): Promise<CuaTarget> {
  const appsRaw = await runDriverCall('list_apps');
  if (appsRaw === null) throw new Error('cua-driver unreachable (not on PATH or daemon stopped)');
  // SAFETY: list_apps envelope verified live against cua-driver 0.28.2 ({apps:[{name,pid,running}]})
  const appsPayload = JSON.parse(appsRaw) as DriverAppsPayload;
  const apps = Array.isArray(appsPayload.apps) ? appsPayload.apps : [];
  const app = apps.find((entry) => entry.running && CUA_APP_NAME_MATCH.test(entry.name));
  if (!app || app.pid <= 0) throw new Error('Alpha Premier Attendance is not running (list_apps running:false)');
  const windowsRaw = await runDriverCall('list_windows', JSON.stringify({ pid: app.pid }));
  if (windowsRaw === null) throw new Error(`list_windows failed for pid ${app.pid}`);
  // SAFETY: list_windows envelope verified live ({_legacy_windows:[{window_id,pid,x,y,width,height,minimized}]})
  const windowsPayload = JSON.parse(windowsRaw) as DriverWindowsPayload;
  const candidates = [...(windowsPayload.windows ?? []), ...(windowsPayload._legacy_windows ?? [])].filter((w) => w.pid === app.pid);
  const main = candidates.filter((w) => !w.minimized).sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!main) throw new Error(`no visible main window for pid ${app.pid}`);
  await runDriverCall('set_window_frame', JSON.stringify({ pid: app.pid, window_id: main.window_id, x: main.x, y: main.y, width: CUA_TARGET_WIDTH, height: CUA_TARGET_HEIGHT }));
  const readbackRaw = await runDriverCall('list_windows', JSON.stringify({ pid: app.pid }));
  if (readbackRaw === null) throw new Error(`set_window_frame readback failed for pid ${app.pid}`);
  // SAFETY: same list_windows envelope as above, re-read after the pin
  const readback = JSON.parse(readbackRaw) as DriverWindowsPayload;
  const pinned = [...(readback.windows ?? []), ...(readback._legacy_windows ?? [])].find((w) => w.window_id === main.window_id);
  if (!pinned || pinned.width !== CUA_TARGET_WIDTH || pinned.height !== CUA_TARGET_HEIGHT) throw new Error(`pin ${CUA_TARGET_WIDTH}x${CUA_TARGET_HEIGHT} not confirmed by readback`);
  await runDriverCall('get_window_state', JSON.stringify({ pid: app.pid, window_id: main.window_id }));
  return { pid: app.pid, windowId: CUA_MAIN_WINDOW_ID, elementToken: SCENARIO_TOKENS[scenarioId], geometry: { width: pinned.width, height: pinned.height, x: pinned.x, y: pinned.y } };
}

const invokedDirectly = process.argv[1]?.endsWith('target.ts') ?? false;
if (invokedDirectly) {
  resolveTauriMainWindow().then(
    (target) => console.log(`live target pid=${target.pid} windowId=${target.windowId} ${target.geometry.width}x${target.geometry.height}`),
    (err: Error) => { console.error(`offline: ${err.message}`); process.exitCode = 1; },
  );
}
