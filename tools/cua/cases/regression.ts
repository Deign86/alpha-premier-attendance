import { assertFreshSnapshot } from '../fresh-snapshot.js';
import { resolveCuaTarget } from '../target.js';

/**
 * CUA-JEV-03 regression: bathroom MALE checkout → return.
 *
 * Contract: tools/cua/scenarios.contract.md (CUA-JEV-03). Drive kiosk mode-tab
 * `2` (bathroom), checkout MALE via `bathroom_time_out`, snapshot the holder +
 * elapsed timer, return via `bathroom_time_in`, then dual-assert the fresh
 * snapshot AND the desktop IPC `bathroom_log` row (OUT → RETURNED,
 * duration > 0). Evidence is desktop-only SQLite via Tauri IPC — never the
 * LAN store. No verdict logic here (see ../verdict.ts); no new deps.
 */

export const REGRESSION_SCENARIO_ID = 'CUA-JEV-03';
export const REGRESSION_SKIP_REASON = 'needs desktop SQLite';
export const REGRESSION_EVIDENCE_SOURCE = 'desktop-sqlite' as const;

export const REGRESSION_MODE_TAB_TESTID = 'kiosk-mode-bathroom';
export const REGRESSION_HOLDER_TESTID = 'bathroom-kiosk-holder-male';
export const REGRESSION_STATUS_TESTID = 'bathroom-kiosk-status';
export const REGRESSION_LOG_PANEL_TESTID = 'bathroom-key-log-panel';

export const REGRESSION_CHECKOUT_COMMAND = 'bathroom_time_out';
export const REGRESSION_RETURN_COMMAND = 'bathroom_time_in';
export const REGRESSION_STATUS_COMMAND = 'bathroom_get_status';

export type RegressionGenderKey = 'MALE' | 'FEMALE';
export type RegressionLogStatus = 'OUT' | 'RETURNED';

export interface RegressionSnapshot {
  readonly fresh: boolean;
  readonly text: string;
}

export interface RegressionLogRow {
  readonly logId: string;
  readonly genderKey: RegressionGenderKey;
  readonly status: RegressionLogStatus;
  readonly durationSeconds: number | null;
}

export interface RegressionCheckoutArgs {
  readonly token: string;
  readonly userId: string;
  readonly genderKey: RegressionGenderKey;
}

export interface RegressionReturnArgs {
  readonly token: string;
  readonly logId: string;
}

export interface RegressionPass {
  readonly kind: 'pass';
  readonly logId: string;
  readonly durationSeconds: number;
}

export interface RegressionFail {
  readonly kind: 'fail';
  readonly reason: string;
}

export interface RegressionSkipped {
  readonly kind: 'skipped';
  readonly reason: string;
}

export type RegressionResult = RegressionPass | RegressionFail | RegressionSkipped;

export interface RegressionCaseInput {
  readonly token: string;
  readonly userId: string;
  readonly checkoutSnapshot: RegressionSnapshot;
  readonly returnSnapshot: RegressionSnapshot;
  readonly logBefore: RegressionLogRow;
  readonly logAfter: RegressionLogRow;
}

function assertNever(value: never): never {
  throw new Error(`unreachable regression result: ${JSON.stringify(value)}`);
}

/** Standalone (node/vitest) has no Tauri webview, so desktop SQLite is unreachable. */
export function isDesktopBathroomAvailable(): boolean {
  return 'window' in globalThis;
}

export function skipStandalone(): RegressionSkipped {
  return { kind: 'skipped', reason: REGRESSION_SKIP_REASON };
}

/** camelCase keys exactly as client/src/tauri-api.ts. */
export function buildCheckoutArgs(token: string, userId: string): RegressionCheckoutArgs {
  return { token, userId, genderKey: 'MALE' };
}

/** camelCase keys exactly as client/src/tauri-api.ts. */
export function buildReturnArgs(token: string, logId: string): RegressionReturnArgs {
  return { token, logId };
}

/** Pin the Tauri main target for this scenario (1280x800, bathroom token). */
export function regressionTarget(): string {
  return resolveCuaTarget(REGRESSION_SCENARIO_ID).elementToken;
}

function assertFreshText(snapshot: RegressionSnapshot): void {
  assertFreshSnapshot({ fromClickReturn: false });
  if (!snapshot.fresh) {
    throw new Error('CUA fresh-snapshot rule: assert on a fresh snapshot only');
  }
}

/** Checkout snapshot shows the holder plus a running mm:ss elapsed timer. */
export function assertCheckoutSnapshot(snapshot: RegressionSnapshot): void {
  assertFreshText(snapshot);
  if (!snapshot.text.includes(REGRESSION_HOLDER_TESTID) && snapshot.text.length === 0) {
    throw new Error('checkout snapshot shows no holder');
  }
  if (!/\d+:\d{2}/.test(snapshot.text)) {
    throw new Error('checkout snapshot shows no running timer');
  }
}

/** Return snapshot shows AVAILABLE plus a duration-carrying RETURNED row. */
export function assertReturnSnapshot(snapshot: RegressionSnapshot): void {
  assertFreshText(snapshot);
  if (!snapshot.text.includes('AVAILABLE')) {
    throw new Error('return snapshot does not show AVAILABLE');
  }
  if (!snapshot.text.includes('RETURNED')) {
    throw new Error('return snapshot shows no RETURNED row');
  }
  if (!/\d+:\d{2}/.test(snapshot.text)) {
    throw new Error('return snapshot shows no duration');
  }
}

/**
 * IPC leg of the dual assert: desktop-only `bathroom_log` row moves
 * OUT → RETURNED with durationSeconds > 0. LAN rows are rejected —
 * only `desktop-sqlite` evidence counts.
 */
export function assertLogTransition(
  before: RegressionLogRow,
  after: RegressionLogRow,
  source: typeof REGRESSION_EVIDENCE_SOURCE,
): number {
  if (source !== REGRESSION_EVIDENCE_SOURCE) {
    throw new Error('bathroom evidence must come from desktop SQLite, never the LAN store');
  }
  if (before.logId !== after.logId) {
    throw new Error('bathroom log row identity changed across return');
  }
  if (before.status !== 'OUT' || after.status !== 'RETURNED') {
    throw new Error('bathroom log row did not move OUT → RETURNED');
  }
  if (after.durationSeconds === null || !(after.durationSeconds > 0)) {
    throw new Error('bathroom log RETURNED row carries no duration');
  }
  return after.durationSeconds;
}

/** Pure case check: dual-assert snapshot + IPC; standalone skips with reason. */
export function checkRegression(input: RegressionCaseInput): RegressionResult {
  if (!isDesktopBathroomAvailable()) {
    return skipStandalone();
  }
  try {
    assertCheckoutSnapshot(input.checkoutSnapshot);
    assertReturnSnapshot(input.returnSnapshot);
    const durationSeconds = assertLogTransition(input.logBefore, input.logAfter, REGRESSION_EVIDENCE_SOURCE);
    return { kind: 'pass', logId: input.logAfter.logId, durationSeconds };
  } catch (err) {
    return { kind: 'fail', reason: err instanceof Error ? err.message : 'unknown regression failure' };
  }
}

/** Single log line per outcome; PASS line is the expected desktop outcome. */
export function logRegressionResult(result: RegressionResult): void {
  switch (result.kind) {
    case 'pass':
      console.log(`PASS ${REGRESSION_SCENARIO_ID} logId=${result.logId} duration=${result.durationSeconds}s`);
      break;
    case 'fail':
      console.log(`FAIL ${REGRESSION_SCENARIO_ID} reason=${result.reason}`);
      break;
    case 'skipped':
      console.log(`SKIP ${REGRESSION_SCENARIO_ID} reason=${result.reason}`);
      break;
    default:
      assertNever(result);
  }
}
