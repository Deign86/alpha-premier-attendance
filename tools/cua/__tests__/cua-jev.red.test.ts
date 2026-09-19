import { describe, expect, it } from 'vitest';
import { resolveCuaTarget } from '../target-resolver.js';
import { assertFreshSnapshot } from '../fresh-snapshot.js';
import { judgeCuaScenario } from '../verdict.js';
import { writeCuaEvidence } from '../evidence.js';

const WAVE_THRESHOLD = 0.8;

describe('CUA-JEV RED: interfaces pinned before implementation', () => {
  it('CUA-JEV-01 target resolver returns {pid,windowId,elementToken}', () => {
    const target = resolveCuaTarget('CUA-JEV-01');
    expect(target.pid).toBeGreaterThan(0);
    expect(target.windowId).toBe('main');
    expect(target.elementToken).toBe('kiosk-record-submit');
  });

  it('CUA-JEV-01/02/03 fresh-snapshot rule rejects click-return assert', () => {
    expect(() => assertFreshSnapshot({ fromClickReturn: true })).toThrow();
    expect(assertFreshSnapshot({ fromClickReturn: false }).fresh).toBe(true);
  });

  it('CUA-JEV verdict Choice maps pass/fail/needs_review with confidence>=0.8 threshold', () => {
    const verdict = judgeCuaScenario('CUA-JEV-01', {
      decision: 'success',
      confidence: WAVE_THRESHOLD,
      status: 'ok',
    });
    expect(['pass', 'fail', 'needs_review']).toContain(verdict.choice);
    expect(verdict.passRequiresConfidenceAtLeast).toBe(WAVE_THRESHOLD);
  });

  it('CUA-JEV JEV state carries no RFID/photo/PII', () => {
    const verdict = judgeCuaScenario('CUA-JEV-01', {
      decision: 'success',
      confidence: WAVE_THRESHOLD,
      status: 'ok',
    });
    const serialized: string = JSON.stringify(verdict.jevState);
    expect(serialized).not.toMatch(/rfid|photo|data:image/i);
  });

  it('CUA-JEV-02 edge unknown UID + duplicate cooldown verdicts', () => {
    const partA = judgeCuaScenario('CUA-JEV-02', {
      decision: 'edge_handled',
      confidence: WAVE_THRESHOLD,
      status: 'ok',
    });
    const partB = judgeCuaScenario('CUA-JEV-02', {
      decision: 'edge_handled',
      confidence: WAVE_THRESHOLD,
      status: 'ok',
    });
    expect(partA.choice).toBe('pass');
    expect(partB.choice).toBe('pass');
  });

  it('CUA-JEV-03 bathroom checkout-to-return verdict', () => {
    const verdict = judgeCuaScenario('CUA-JEV-03', {
      decision: 'returned',
      confidence: WAVE_THRESHOLD,
      status: 'ok',
    });
    expect(verdict.choice).toBe('pass');
  });

  it('CUA-JEV evidence files written on fail', () => {
    const written = writeCuaEvidence('CUA-JEV-01', { choice: 'fail' });
    expect(written).toContain('evidence/cua-jev/CUA-JEV-01/');
  });
});
