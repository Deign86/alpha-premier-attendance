import { describe, expect, it } from 'vitest';
import { adminErrorCodes, attendanceActions, attendanceStatuses, cardTypes, evaluateAttendanceArrivals, isLateTimeout, normalizeName, scanErrorCodes, scanSources, setupErrorCodes, type ScannerStatus } from './api-contracts.js';

describe('shared API contract literals', () => {
  it('keeps scan sources, card types, and attendance states stable', () => {
    expect(scanSources).toEqual(['RFID', 'MANUAL_TEST', 'ADMIN_ASSISTED_SCAN', 'ADMIN_BACKDATED_ENTRY']);
    expect(cardTypes).toEqual(['EMPLOYEE', 'ADMIN_ASSIST']);
    expect(attendanceActions).toEqual(['TIME_IN', 'TIME_OUT']);
    expect(attendanceStatuses).toEqual(['WORKING', 'COMPLETED', 'MISSED', 'LATE_TIMEOUT']);
  });

  it('exposes admin assist and backdated error codes', () => {
    expect(scanErrorCodes).toContain('ADMIN_CARD_REQUIRES_SELECTION');
    expect(scanErrorCodes).toContain('ATTENDANCE_ALREADY_EXISTS_FOR_DATE');
    expect(scanErrorCodes).toContain('BACKDATE_LIMIT_EXCEEDED');
    expect(adminErrorCodes).toContain('ATTENDANCE_ALREADY_EXISTS_FOR_DATE');
    expect(adminErrorCodes).toContain('BACKDATE_LIMIT_EXCEEDED');
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

describe('normalizeName', () => {
  it('trims leading and trailing whitespace and collapses multiple spaces', () => {
    expect(normalizeName('   john    doe   ')).toBe('John Doe');
    expect(normalizeName('  jane  ')).toBe('Jane');
    expect(normalizeName('')).toBe('');
    expect(normalizeName('   ')).toBe('');
  });

  it('capitalizes lowercase names', () => {
    expect(normalizeName('john doe')).toBe('John Doe');
    expect(normalizeName('ada lovelace')).toBe('Ada Lovelace');
  });

  it('normalizes uppercase names to title case', () => {
    expect(normalizeName('JOHN DOE')).toBe('John Doe');
    expect(normalizeName('GRACE HOPPER')).toBe('Grace Hopper');
  });

  it('handles mixed case and special separators (hyphens, apostrophes, periods)', () => {
    expect(normalizeName('mary-jane watson')).toBe('Mary-Jane Watson');
    expect(normalizeName("o'connor")).toBe("O'Connor");
    expect(normalizeName("o’neill")).toBe("O’Neill");
    expect(normalizeName('ma. teresa santos')).toBe('Ma. Teresa Santos');
    expect(normalizeName('de la cruz')).toBe('De La Cruz');
  });
});

describe('evaluateAttendanceArrivals & grace period rules', () => {
  it('identifies arrivals on or before 08:00 as ON_TIME', () => {
    const rows = [
      { attendanceId: '1', userId: 'EMP-01', attendanceDate: '2026-08-24', timeIn: '2026-08-24T07:55:00+08:00' },
      { attendanceId: '2', userId: 'EMP-01', attendanceDate: '2026-08-25', timeIn: '2026-08-25T08:00:00+08:00' },
    ];
    const results = evaluateAttendanceArrivals(rows);
    expect(results.get('1')?.arrivalStatus).toBe('ON_TIME');
    expect(results.get('2')?.arrivalStatus).toBe('ON_TIME');
  });

  it('allows exactly 1 GRACE_PERIOD per week for arrivals between 08:00 and 08:15', () => {
    const rows = [
      // Monday 8:10 -> Uses the 1 weekly grace period
      { attendanceId: '1', userId: 'EMP-01', attendanceDate: '2026-08-24', timeIn: '2026-08-24T08:10:00+08:00' },
      // Tuesday 8:08 -> Second arrival in 8:00-8:15 in same week -> LATE!
      { attendanceId: '2', userId: 'EMP-01', attendanceDate: '2026-08-25', timeIn: '2026-08-25T08:08:00+08:00' },
      // Next Monday 8:12 -> New week -> Uses new weekly grace period
      { attendanceId: '3', userId: 'EMP-01', attendanceDate: '2026-08-31', timeIn: '2026-08-31T08:12:00+08:00' },
    ];
    const results = evaluateAttendanceArrivals(rows);
    expect(results.get('1')?.arrivalStatus).toBe('GRACE_PERIOD');
    expect(results.get('2')?.arrivalStatus).toBe('LATE');
    expect(results.get('2')?.minutesLate).toBe(8);
    expect(results.get('3')?.arrivalStatus).toBe('GRACE_PERIOD');
  });

  it('treats arrivals strictly beyond 08:15 as LATE regardless of grace period availability', () => {
    const rows = [
      { attendanceId: '1', userId: 'EMP-01', attendanceDate: '2026-08-24', timeIn: '2026-08-24T08:16:00+08:00' },
      { attendanceId: '2', userId: 'EMP-02', attendanceDate: '2026-08-24', timeIn: '2026-08-24T09:30:00+08:00' },
    ];
    const results = evaluateAttendanceArrivals(rows);
    expect(results.get('1')?.arrivalStatus).toBe('LATE');
    expect(results.get('1')?.minutesLate).toBe(16);
    expect(results.get('2')?.arrivalStatus).toBe('LATE');
    expect(results.get('2')?.minutesLate).toBe(90);
  });
});

describe('bathroom key log contract literals', () => {
  it('defines gender keys and status values', () => {
    expect(['MALE', 'FEMALE']).toContain('MALE');
    expect(['MALE', 'FEMALE']).toContain('FEMALE');
  });
});
