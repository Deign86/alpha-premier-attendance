import { freshSnapshot, resolveTauriMainWindow, runDriverCall, tcpProbe } from '../target.js';
import type { CuaTarget } from '../target.js';
import { assertFreshSnapshot } from '../fresh-snapshot.js';

/**
 * CUA-JEV-01 driver (happy: kiosk tap to success).
 *
 * CUA boundary per verify skill rfid-kiosk.md: OS-level clicks land on kiosk
 * controls (foreground delivery), but keystrokes never reach WebView2 — so the
 * click goes through cua-driver pixels while the tap text goes via core.invoke.
 * Every assert reads a fresh snapshot; the click return is never asserted on.
 * No verdict logic here (tools/cua/verdict.ts owns JEV); no PII in logs.
 */

export const HAPPY_SCENARIO_ID = 'CUA-JEV-01';
export type HappyOutcome = 'pass' | 'fail' | 'skip';

export interface HappyLiveBridge {
  readonly active: boolean;
}

export interface HappyResult {
  readonly scenarioId: typeof HAPPY_SCENARIO_ID;
  readonly outcome: HappyOutcome;
  readonly liveBridge: HappyLiveBridge;
  readonly excerpt: string;
}

const SUBMIT_SELECTOR = '[data-testid="kiosk-record-submit"]';
const SUCCESS_SELECTOR = '[data-testid="kiosk-result-success"]';
const BRIDGE_URL = 'ws://127.0.0.1:9223';
const BRIDGE_PORT = 9223;
const ASSERT_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 750;
const EXCERPT_MAX_LEN = 160;

interface BridgeSocket {
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onerror: ((err: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
}

declare const WebSocket: new (url: string) => BridgeSocket;

interface BridgePending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

interface BridgeEnvelope {
  id?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
}

interface SubmitRectProbe {
  found: boolean;
  x: number;
  y: number;
}

interface DomProbe {
  hasSuccess: boolean;
  hasPhoto: boolean;
  textLen: number;
}

/** Minimal Tauri bridge invoke helper (same envelope as scripts/verify-tauri-mcp.mjs). */
export class HappyBridge {
  private socket: BridgeSocket | null = null;
  private reqId = 1;
  private readonly pending = new Map<string, BridgePending>();

  connect(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bridge connect timed out')), timeoutMs);
      try {
        const socket: BridgeSocket = new WebSocket(BRIDGE_URL);
        socket.onopen = () => {
          clearTimeout(timer);
          this.socket = socket;
          resolve();
        };
        socket.onerror = (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('bridge socket error'));
        };
        socket.onmessage = (event: { data: string }) => {
          // SAFETY: envelope shape verified live against the Tauri MCP bridge ({id,success,data})
          const parsed = JSON.parse(String(event.data)) as BridgeEnvelope;
          if (typeof parsed.id === 'string' && this.pending.has(parsed.id)) {
            const entry = this.pending.get(parsed.id);
            if (entry !== undefined) {
              this.pending.delete(parsed.id);
              if (parsed.success === false) {
                entry.reject(new Error(typeof parsed.error === 'string' ? parsed.error : 'bridge call failed'));
              } else {
                entry.resolve(parsed.data);
              }
            }
          }
        };
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error('bridge socket error'));
      }
    });
  }

  send(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket;
    if (socket === null) return Promise.reject(new Error('bridge not connected'));
    const id = String(this.reqId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`bridge ${command} timed out`));
        }
      }, 8000);
      this.pending.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      socket.send(JSON.stringify({ id, command, args }));
    });
  }

  /** Drive a Tauri IPC command inside the webview. Arg keys stay lowerCamelCase. */
  invoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    const script =
      'return await window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(command) + ', ' + JSON.stringify(args) + ')';
    return this.send('execute_js', { script });
  }

  executeJs(script: string): Promise<unknown> {
    return this.send('execute_js', { script });
  }

  close(): void {
    if (this.socket !== null) {
      this.socket.close();
      this.socket = null;
    }
  }
}

function rectAuditScript(): string {
  return (
    `const el = document.querySelector('${SUBMIT_SELECTOR}');` +
    'if (!el) return JSON.stringify({ found: false, x: 0, y: 0 });' +
    'const r = el.getBoundingClientRect();' +
    'return JSON.stringify({ found: true, x: r.x + r.width / 2, y: r.y + r.height / 2 });'
  );
}

function domProbeScript(): string {
  return (
    `const node = document.querySelector('${SUCCESS_SELECTOR}');` +
    'const img = node ? node.querySelector("img") : null;' +
    'return JSON.stringify({ hasSuccess: node !== null, hasPhoto: img !== null,' +
    ' textLen: node ? node.innerText.length : 0 });'
  );
}

/** Structural excerpt only (booleans + lengths) — never names, UIDs, or pixels. */
function scrubExcerpt(text: string, uid: string): string {
  let out = text;
  if (uid.length > 0) out = out.split(uid).join('[REDACTED]');
  out = out.replace(/data:image\/[a-zA-Z0-9+.-]+;base64,[A-Za-z0-9+/=]+/g, '[REDACTED_IMAGE]');
  return out.slice(0, EXCERPT_MAX_LEN);
}

function probeRect(raw: unknown): SubmitRectProbe {
  // SAFETY: payload produced by our own rectAuditScript above ({found,x,y})
  const parsed = JSON.parse(String(raw)) as SubmitRectProbe;
  return { found: parsed.found === true, x: Number(parsed.x), y: Number(parsed.y) };
}

function probeDom(raw: unknown): DomProbe {
  // SAFETY: payload produced by our own domProbeScript above ({hasSuccess,hasPhoto,textLen})
  const parsed = JSON.parse(String(raw)) as DomProbe;
  return {
    hasSuccess: parsed.hasSuccess === true,
    hasPhoto: parsed.hasPhoto === true,
    textLen: Number(parsed.textLen),
  };
}

function excerptFor(probe: DomProbe, uid: string): string {
  return scrubExcerpt(`success=${probe.hasSuccess} photo=${probe.hasPhoto} textLen=${probe.textLen}`, uid);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logResult(result: HappyResult): void {
  const verdict = result.outcome === 'skip' ? 'SKIP' : result.outcome === 'pass' ? 'PASS' : 'FAIL';
  console.log(`${result.scenarioId} ${verdict} liveBridge.active:${result.liveBridge.active} ${result.excerpt}`);
}

export async function runHappyCase(): Promise<HappyResult> {
  const live = await tcpProbe(BRIDGE_PORT);
  if (!live) {
    const result: HappyResult = {
      scenarioId: HAPPY_SCENARIO_ID,
      outcome: 'skip',
      liveBridge: { active: false },
      excerpt: 'bridge offline; contract-only, not live proof',
    };
    logResult(result);
    return result;
  }

  let target: CuaTarget;
  try {
    target = await resolveTauriMainWindow(HAPPY_SCENARIO_ID);
  } catch (err) {
    const result: HappyResult = {
      scenarioId: HAPPY_SCENARIO_ID,
      outcome: 'fail',
      liveBridge: { active: true },
      excerpt: scrubExcerpt(`target unresolved: ${err instanceof Error ? err.message : 'unknown'}`, ''),
    };
    logResult(result);
    return result;
  }

  const bridge = new HappyBridge();
  const fail = (excerpt: string, uid: string): HappyResult => {
    const result: HappyResult = {
      scenarioId: HAPPY_SCENARIO_ID,
      outcome: 'fail',
      liveBridge: { active: true },
      excerpt: scrubExcerpt(excerpt, uid),
    };
    logResult(result);
    return result;
  };

  try {
    await bridge.connect();
  } catch {
    return fail('bridge socket refused despite open port', '');
  }

  try {
    freshSnapshot(target);
    assertFreshSnapshot({ fromClickReturn: false });

    // Re-audit rects immediately before the click (same-capture pixels).
    const rect = probeRect(await bridge.executeJs(rectAuditScript()));
    if (!rect.found) return fail(`submit control absent ${SUBMIT_SELECTOR}`, '');
    await runDriverCall('click', JSON.stringify({ pid: target.pid, x: rect.x, y: rect.y }));
    // Click return deliberately ignored — fresh-snapshot rule: assert on a new capture.
    assertFreshSnapshot({ fromClickReturn: false });
    freshSnapshot(target);

    const uid = process.env['CUA_KNOWN_RFID_UID'] ?? '';
    if (uid.length === 0) return fail('missing CUA_KNOWN_RFID_UID env; tap not injected', '');
    try {
      await bridge.invoke('scan_rfid', { request: { rfidUid: uid, source: 'RFID' } });
    } catch (err) {
      return fail(`tap invoke rejected: ${err instanceof Error ? err.message : 'unknown'}`, uid);
    }

    const deadline = Date.now() + ASSERT_TIMEOUT_MS;
    let probe: DomProbe = { hasSuccess: false, hasPhoto: false, textLen: 0 };
    while (Date.now() < deadline) {
      assertFreshSnapshot({ fromClickReturn: false });
      freshSnapshot(target);
      probe = probeDom(await bridge.executeJs(domProbeScript()));
      if (probe.hasSuccess && probe.hasPhoto) {
        const result: HappyResult = {
          scenarioId: HAPPY_SCENARIO_ID,
          outcome: 'pass',
          liveBridge: { active: true },
          excerpt: excerptFor(probe, uid),
        };
        logResult(result);
        return result;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return fail(`timeout without success+photo ${excerptFor(probe, uid)}`, uid);
  } finally {
    bridge.close();
  }
}

const invokedDirectly = process.argv[1]?.endsWith('happy.ts') ?? false;
if (invokedDirectly) {
  runHappyCase().then(
    (result) => {
      process.exitCode = result.outcome === 'fail' ? 1 : 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
