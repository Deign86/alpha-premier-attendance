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

  it('detects admin assist RFID card and executes assisted scan for active employee', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true },
      { userId: 'ADMIN_CARD_AD01', fullName: 'Front Desk Admin', rfidUid: 'AD01', department: 'Admin', active: true, cardType: 'ADMIN_ASSIST' },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));

    // Step 1: Admin card scanned on kiosk without target employee
    const assistPrompt = await service.scan({ rfidUid: 'AD01', source: 'RFID' }, 'req-adm-1');
    expect(assistPrompt.success).toBe(true);
    if (assistPrompt.success && assistPrompt.action === 'ADMIN_ASSIST') {
      expect(assistPrompt.adminCard).toEqual({ rfidUid: 'AD01', label: 'Front Desk Admin' });
      expect(assistPrompt.activeEmployees).toHaveLength(1);
      expect(assistPrompt.activeEmployees[0].userId).toBe('u1');
    } else {
      expect.fail('Expected action to be ADMIN_ASSIST');
    }

    // Step 2: Confirming assisted scan on behalf of Ada
    const assistedScan = await service.scan({
      rfidUid: 'AD01',
      source: 'ADMIN_ASSISTED_SCAN',
      targetUserId: 'u1',
      reason: 'Forgot RFID card',
    }, 'req-adm-2');
    expect(assistedScan.success).toBe(true);
    if (assistedScan.success && assistedScan.action !== 'ADMIN_ASSIST') {
      expect(assistedScan.action).toBe('TIME_IN');
      expect(assistedScan.user.userId).toBe('u1');
      expect(assistedScan.attendance.source).toBe('ADMIN_ASSISTED_SCAN');
      expect(assistedScan.attendance.recordedBy).toBe('Front Desk Admin');
      expect(assistedScan.attendance.recordedReason).toBe('Forgot RFID card');
    }

    // Verify row was written for Ada, NOT for the admin card
    expect(await sheets.findAttendance('ADMIN_CARD_AD01', '2026-07-28')).toBeNull();
    const adaAtt = await sheets.findAttendance('u1', '2026-07-28');
    expect(adaAtt).not.toBeNull();
    expect(adaAtt?.source).toBe('ADMIN_ASSISTED_SCAN');
  });

  it('rejects recording attendance directly for an admin card or targeting an inactive user', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u-inactive', fullName: 'Inactive User', rfidUid: 'BA01', department: 'Engineering', active: false },
      { userId: 'ADMIN_CARD_AD01', fullName: 'Front Desk Admin', rfidUid: 'AD01', department: 'Admin', active: true, cardType: 'ADMIN_ASSIST' },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));

    // Trying to target the admin card itself
    const selfTarget = await service.scan({
      rfidUid: 'AD01',
      source: 'ADMIN_ASSISTED_SCAN',
      targetUserId: 'ADMIN_CARD_AD01',
    }, 'req-self');
    expect(selfTarget.success).toBe(false);
    if (!selfTarget.success) {
      expect(selfTarget.error.code).toBe('ADMIN_CARD_REQUIRES_SELECTION');
    }

    // Trying to target an inactive user
    const inactTarget = await service.scan({
      rfidUid: 'AD01',
      source: 'ADMIN_ASSISTED_SCAN',
      targetUserId: 'u-inactive',
    }, 'req-inact');
    expect(inactTarget.success).toBe(false);
    if (!inactTarget.success) {
      expect(inactTarget.error.code).toBe('INACTIVE_USER');
    }
  });

  it('keeps 17:00 (5:00 PM) time-outs as normal COMPLETED shifts', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r1');
    // 17:00 Manila (5:00 PM) exactly — normal completion of 8 AM to 5 PM office hours.
    service.setNowProvider(() => new Date('2026-07-28T09:00:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.attendance.status).toBe('COMPLETED');
      expect(outResult.attendance.timeOut).toBe('2026-07-28T17:00:00+08:00');
      expect(outResult.message).toBe('Time Out recorded successfully.');
    }
  });

  it('keeps 5:05 PM (17:05) time-outs as normal COMPLETED shifts within grace period', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r1');
    // 17:05 Manila (5:05 PM) — within grace period before 18:00 cutoff.
    service.setNowProvider(() => new Date('2026-07-28T09:05:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.attendance.status).toBe('COMPLETED');
      expect(outResult.attendance.timeOut).toBe('2026-07-28T17:05:00+08:00');
    }
  });

  it('flags 6:05 PM (18:05) time-outs as LATE_TIMEOUT shifts requiring manual correction', async () => {
    const sheets = new InMemorySheetsService([
      { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'AABBCC11', department: 'Engineering', active: true, employeeType: 'EMPLOYEE', dailyRate: 500 },
    ]);
    const service = new AttendanceService(sheets, config, () => new Date('2026-07-28T01:00:00.000Z'));
    await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r1');
    // 18:05 Manila (6:05 PM) — at/after 18:00 cutoff.
    service.setNowProvider(() => new Date('2026-07-28T10:05:00.000Z'));
    const outResult = await service.scan({ rfidUid: 'AABBCC11', source: 'RFID' }, 'r2');
    expect(outResult.success).toBe(true);
    if (outResult.success) {
      expect(outResult.attendance.status).toBe('LATE_TIMEOUT');
      expect(outResult.attendance.timeOut).toBe('2026-07-28T18:05:00+08:00');
      expect(outResult.message).toContain('after office hours');
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
