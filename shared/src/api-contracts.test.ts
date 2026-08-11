import { describe, expect, it } from 'vitest';
import { attendanceActions, attendanceStatuses, isLateTimeout, scanSources, setupErrorCodes, scannerConfidences, scannerTransports, canCreateBackgroundAttendance } from './api-contracts.js';

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

describe('background scanner safety contract', () => {
  it('allows background attendance only for verified device transports', () => {
    expect(scannerConfidences).toEqual(['device_verified', 'prefix_suffix_verified', 'heuristic_candidate', 'rejected']);
    expect(scannerTransports).toEqual(['raw_hid', 'serial', 'vendor_sdk', 'keyboard_wedge_detection', 'disabled']);
    expect(canCreateBackgroundAttendance('device_verified', 'raw_hid')).toBe(true);
    expect(canCreateBackgroundAttendance('device_verified', 'serial')).toBe(true);
    expect(canCreateBackgroundAttendance('prefix_suffix_verified', 'keyboard_wedge_detection')).toBe(false);
    expect(canCreateBackgroundAttendance('heuristic_candidate', 'keyboard_wedge_detection')).toBe(false);
  });
});

describe('office-hours late timeout policy', () => {
  it('flags time-outs strictly after 17:00 Manila', () => {
    expect(isLateTimeout('2026-08-04T18:55:12+08:00')).toBe(true);
    expect(isLateTimeout('2026-08-04T17:01:00+08:00')).toBe(true);
    expect(isLateTimeout('2026-08-04T23:59:00+08:00')).toBe(true);
  });

  it('keeps time-outs at or before 17:00 Manila as normal', () => {
    expect(isLateTimeout('2026-08-04T17:00:00+08:00')).toBe(false);
    expect(isLateTimeout('2026-08-04T16:59:00+08:00')).toBe(false);
    expect(isLateTimeout('2026-08-04T07:30:00+08:00')).toBe(false);
  });

  it('compares in Manila time regardless of the timestamp offset', () => {
    // 18:55 Manila == 10:55 UTC on the same day.
    expect(isLateTimeout('2026-08-04T10:55:00Z')).toBe(true);
    // 16:00 Manila == 08:00 UTC.
    expect(isLateTimeout('2026-08-04T08:00:00Z')).toBe(false);
  });

  it('never treats an unparseable timestamp as late', () => {
    expect(isLateTimeout('not-a-timestamp')).toBe(false);
    expect(isLateTimeout('')).toBe(false);
  });
});
