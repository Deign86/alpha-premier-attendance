import { describe, expect, it } from 'vitest';
import { AttendanceService } from '../src/attendance.js';
import { InMemorySheetsService } from '../src/sheets.js';

const config = {
  timezone: 'Asia/Manila',
  scanCooldownMs: 1000,
};

describe('AttendanceService', () => {
  it('times in then times out an active user', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    const inResult = await service.scan({ rfidUid: 'aa-bb-cc-11', source: 'RFID' }, 'r1');
    expect(inResult.success).toBe(true);
    if (inResult.success) expect(inResult.action).toBe('TIME_IN');
    service.setNowProvider(() => new Date('2026-07-28T02:00:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.action).toBe('TIME_OUT');
      expect(outResult.attendance.status).toBe('COMPLETED');
    }
  });

  it('flags a time-out after office hours as LATE_TIMEOUT and still saves it', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r1');
    // 18:55 Manila — outside office hours, no overtime allowed.
    service.setNowProvider(() => new Date('2026-07-28T10:55:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.action).toBe('TIME_OUT');
      expect(outResult.attendance.status).toBe('LATE_TIMEOUT');
      expect(outResult.attendance.timeOut).toBe('2026-07-28T18:55:00+08:00');
      expect(outResult.message).toContain('Manual correction is required');
    }
    // The record is saved but never gets payroll, and a re-scan is rejected.
    const stored = await sheets.findAttendance('u1', '2026-07-28');
    expect(stored?.status).toBe('LATE_TIMEOUT');
    expect(await sheets.findPayrollByAttendanceId(stored!.attendanceId)).toBeNull();
    service.setNowProvider(() => new Date('2026-07-28T11:05:00.000Z'));
    const rescan = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r3');
    expect(rescan.success).toBe(false);
    if (!rescan.success) expect(rescan.error.code).toBe('ATTENDANCE_ALREADY_COMPLETED');
  });

  it('keeps a 17:00 time-out as a normal COMPLETED shift', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r1');
    // 17:00 Manila exactly is the end of the official workday.
    service.setNowProvider(() => new Date('2026-07-28T09:00:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.attendance.status).toBe('COMPLETED');
      expect(outResult.message).toBe('Time Out recorded successfully.');
    }
  });

  it('returns duplicate during cooldown', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada', rfidUid: 'AABB', department: null, active: true },
    ]);
    const service = new AttendanceService(sheets, config);
    await service.scan({ rfidUid: 'aabb', source: 'RFID' }, 'r1');
    const result = await service.scan({ rfidUid: 'AABB', source: 'RFID' }, 'r2');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DUPLICATE_SCAN');
  });
});
