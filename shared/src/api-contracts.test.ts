import { describe, expect, it } from 'vitest';
import { attendanceActions, attendanceStatuses, isLateTimeout, scanSources, setupErrorCodes, type ScannerStatus } from './api-contracts.js';

describe('shared API contract literals', () => {
  it('keeps scan sources and attendance states stable', () => {
    expect(scanSources).toEqual(['RFID', 'MANUAL_TEST']);
    expect(attendanceActions).toEqual(['TIME_IN', 'TIME_OUT']);
    expect(attendanceStatuses).toEqual(['WORKING', 'COMPLETED', 'MISSED', 'LATE_TIMEOUT']);
  });

  it('exposes protected setup error codes for both workspaces', () => {
    expect(setupErrorCodes).toContain('SETUP_AUTH_REQUIRED');
    expect(setupErrorCodes).toContain('USER_CONFLICT');
  });
});

describe('scanner status contract', () => {
  it('serializes the simplified scanner status shape', () => {
    const status: ScannerStatus = {
      state: 'connected',
      message: 'Keyboard-mode RFID reader ready',
      detail: 'Keep the attendance window focused before scanning',
      mode: 'keyboard',
      paused: false,
    };
    expect(Object.keys(status).sort()).toEqual([
      'detail',
      'message',
      'mode',
      'paused',
      'state',
    ]);
    expect(status.mode).toBe('keyboard');
    expect(status.state).toBe('connected');
  });
});

describe('office-hours late timeout policy', () => {
  it('flags time-outs strictly after 18:00 Manila (true overtime hours from 6 PM onwards)', () => {
    expect(isLateTimeout('2026-08-04T18:55:12+08:00')).toBe(true);
    expect(isLateTimeout('2026-08-04T18:01:00+08:00')).toBe(true);
    expect(isLateTimeout('2026-08-04T23:59:00+08:00')).toBe(true);
  });

  it('keeps time-outs at or before 18:00 Manila as normal (including 5:05 PM)', () => {
    expect(isLateTimeout('2026-08-04T18:00:00+08:00')).toBe(false);
    expect(isLateTimeout('2026-08-04T17:05:00+08:00')).toBe(false);
    expect(isLateTimeout('2026-08-04T17:00:00+08:00')).toBe(false);
    expect(isLateTimeout('2026-08-04T16:59:00+08:00')).toBe(false);
    expect(isLateTimeout('2026-08-04T07:30:00+08:00')).toBe(false);
  });

  it('compares in Manila time regardless of the timestamp offset', () => {
    // 18:55 Manila == 10:55 UTC on the same day (late).
    expect(isLateTimeout('2026-08-04T10:55:00Z')).toBe(true);
    // 17:05 Manila == 09:05 UTC on the same day (normal).
    expect(isLateTimeout('2026-08-04T09:05:00Z')).toBe(false);
    // 18:00 Manila == 10:00 UTC on the same day (normal).
    expect(isLateTimeout('2026-08-04T10:00:00Z')).toBe(false);
    // 16:00 Manila == 08:00 UTC (normal).
    expect(isLateTimeout('2026-08-04T08:00:00Z')).toBe(false);
  });

  it('never treats an unparseable timestamp as late', () => {
    expect(isLateTimeout('not-a-timestamp')).toBe(false);
    expect(isLateTimeout('')).toBe(false);
  });
});
