import type { CuaTarget } from './target.js';

export interface SurfaceMatchers {
  readonly domIncludes: readonly string[];
  readonly ipcIncludes?: readonly string[];
}
export interface SurfaceBridgeArgs {
  readonly pid?: number;
  readonly windowId?: string;
  readonly selector?: string;
}
export interface SurfaceBridge {
  send(command: string, args?: SurfaceBridgeArgs): Promise<unknown>;
}
export interface SurfaceCapture {
  readonly snapshotId: string;
  readonly domText: string;
  readonly ipcTail: string;
  readonly fromClickReturn: boolean;
}
export interface SurfaceResult {
  readonly pass: boolean;
  readonly excerpt: string;
  readonly snapshotId: string;
}
const consumedIds = new Set<string>();
let captureCount = 0;
function toText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  const json = JSON.stringify(value);
  return typeof json === 'string' ? json : '';
}
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (reflow?)`)), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
function excerptFor(text: string, needles: readonly string[]): string {
  const lines = text.split('\n');
  const hits = lines.filter((line) => needles.some((n) => line.includes(n)));
  const picked = hits.length > 0 ? hits : lines;
  return picked.slice(0, 8).join('\n').slice(0, 1200);
}
export async function captureSurface(bridge: SurfaceBridge, target: CuaTarget, timeoutMs = 8000): Promise<SurfaceCapture> {
  await withTimeout(bridge.send('get_window_state', { pid: target.pid, windowId: target.windowId }), timeoutMs, 'get_window_state');
  let dom: unknown;
  try {
    dom = await withTimeout(bridge.send('dom_snapshot', { windowId: target.windowId }), timeoutMs, 'dom_snapshot');
  } catch {
    await new Promise((r) => setTimeout(r, 250));
    dom = await withTimeout(bridge.send('find_element', { windowId: target.windowId, selector: target.elementToken }), timeoutMs, 'find_element');
  }
  const ipc = await withTimeout(bridge.send('ipc_read', { windowId: target.windowId }), timeoutMs, 'ipc_read');
  captureCount += 1;
  return { snapshotId: `${Date.now()}-${captureCount}-${target.pid}`, domText: toText(dom), ipcTail: toText(ipc), fromClickReturn: false };
}
export function assertSurface(capture: SurfaceCapture, matchers: SurfaceMatchers): SurfaceResult {
  if (capture.fromClickReturn) throw new Error('CUA fresh-snapshot rule: never assert on a click return; capture a fresh snapshot first');
  if (consumedIds.has(capture.snapshotId)) throw new Error(`stale surface reuse rejected: snapshot ${capture.snapshotId} already asserted`);
  consumedIds.add(capture.snapshotId);
  const needles = [...matchers.domIncludes, ...(matchers.ipcIncludes ?? [])];
  const haystack = `${capture.domText}\n${capture.ipcTail}`;
  const pass = needles.length > 0 && needles.every((n) => haystack.includes(n));
  return { pass, excerpt: excerptFor(haystack, needles), snapshotId: capture.snapshotId };
}
export async function assertFreshSurface(bridge: SurfaceBridge, target: CuaTarget, matchers: SurfaceMatchers, timeoutMs = 8000): Promise<SurfaceResult> {
  return assertSurface(await captureSurface(bridge, target, timeoutMs), matchers);
}
