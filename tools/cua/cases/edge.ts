/**
 * CUA-JEV-02 edge case: unknown UID (02a) + duplicate cooldown (02b).
 *
 * Runner contract (tools/cua/scenarios.contract.md):
 * - Kiosk `/` attendance mode, window pinned 1280x800 (see ../target.ts).
 * - Text-bearing steps drive `core.invoke` via `tauri_webview_execute_js` —
 *   OS keystrokes do NOT reach WebView2 content, so keyboard entry is never
 *   used here. CUA clicks are pixel-only; every assert reads a FRESH snapshot
 *   taken after the invoke (never the click/invoke return).
 * - Arg keys are lowerCamelCase exactly as in client/src/tauri-api.ts
 *   (`scan_rfid` takes `{ request: { rfidUid, source } }`).
 * - No verdict logic lives here: the runner judges via ../verdict.ts (JEV).
 *   This file only builds invoke scripts, names fresh-snapshot selectors,
 *   checks surface predicates on fresh snapshot text, and formats PII-free
 *   log lines.
 */

export const EDGE_SCENARIO_ID = 'CUA-JEV-02';
export const EDGE_PART_UNKNOWN = 'CUA-JEV-02a';
export const EDGE_PART_COOLDOWN = 'CUA-JEV-02b';
export const EDGE_EVIDENCE_SUBDIR = 'evidence/cua-jev/CUA-JEV-02';

/** Hex UID live-proved unregistered (rfid-kiosk.md): yields UNKNOWN_RFID_CARD. */
export const EDGE_UNKNOWN_UID = 'DEADBEEF01';

export const EDGE_SCAN_SOURCE = 'RFID';

export const EDGE_UNKNOWN_SELECTORS = [
  '[data-testid="kiosk-result-error"]',
  '[data-testid="setup-this-card"]',
] as const;

export const EDGE_COOLDOWN_SELECTORS = [
  '[data-testid="kiosk-result-error"]',
] as const;

export interface EdgeCaseStep {
  readonly partId: string;
  readonly description: string;
  /** JS for tauri_webview_execute_js wrapping core.invoke. */
  readonly invokeJs: string;
  /** Fresh-snapshot selectors the runner must capture AFTER the invoke. */
  readonly snapshotSelectors: readonly string[];
}

/** Build the core.invoke script; keys stay lowerCamelCase per tauri-api.ts. */
export function buildScanInvokeJs(rfidUid: string, source: string): string {
  const args = JSON.stringify({ request: { rfidUid, source } });
  return `window.__TAURI__.core.invoke('scan_rfid', ${args})`;
}

/** Part A: tap an unregistered UID; fresh snapshot must show unknown-card. */
export function unknownUidStep(unknownUid: string = EDGE_UNKNOWN_UID): EdgeCaseStep {
  return {
    partId: EDGE_PART_UNKNOWN,
    description: 'unknown UID tap shows unknown-card surface',
    invokeJs: buildScanInvokeJs(unknownUid, EDGE_SCAN_SOURCE),
    snapshotSelectors: EDGE_UNKNOWN_SELECTORS,
  };
}

/**
 * Part B: tap the same known UID twice in quick succession; the runner must
 * capture a fresh snapshot after EACH tap and assert the second shows the
 * duplicate-cooldown surface with exactly one attendance row for the UID.
 */
export function duplicateCooldownSteps(knownUid: string): readonly [EdgeCaseStep, EdgeCaseStep] {
  return [
    {
      partId: EDGE_PART_COOLDOWN,
      description: 'first tap records attendance',
      invokeJs: buildScanInvokeJs(knownUid, EDGE_SCAN_SOURCE),
      snapshotSelectors: ['[data-testid="kiosk-result-success"]'],
    },
    {
      partId: EDGE_PART_COOLDOWN,
      description: 'rapid re-tap shows cooldown surface',
      invokeJs: buildScanInvokeJs(knownUid, EDGE_SCAN_SOURCE),
      snapshotSelectors: EDGE_COOLDOWN_SELECTORS,
    },
  ];
}

/** Unknown-card surface on FRESH snapshot text: error, no success element. */
export function isUnknownCardSnapshot(freshSnapshotText: string): boolean {
  return (
    freshSnapshotText.includes('kiosk-result-error') &&
    freshSnapshotText.includes('UNKNOWN RFID CARD') &&
    !freshSnapshotText.includes('kiosk-result-success')
  );
}

/** Duplicate-cooldown surface on FRESH snapshot text: cooled error, no success. */
export function isCooldownSnapshot(freshSnapshotText: string): boolean {
  return (
    freshSnapshotText.includes('kiosk-result-error') &&
    freshSnapshotText.includes('DUPLICATE SCAN') &&
    !freshSnapshotText.includes('kiosk-result-success')
  );
}

/** Mask raw UIDs before logging so evidence logs carry no PII. */
export function redactUidText(text: string, uids: readonly string[]): string {
  let out = text;
  for (const uid of uids) {
    if (uid.length > 0) out = out.split(uid).join('[UID]');
  }
  return out;
}

/** PII-free PASS line the runner logs per part (2 snapshots total). */
export function formatEdgePassLine(partId: string, snapshotCount: number): string {
  return `${partId} PASS with ${snapshotCount} snapshot${snapshotCount === 1 ? '' : 's'}`;
}
