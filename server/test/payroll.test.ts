import { describe, expect, it } from 'vitest';
import { InMemorySheetsService, type SheetAttendance, type SheetUser } from '../src/sheets.js';
import { PayrollService } from '../src/payroll.js';

describe('payroll service integration', () => {
  it('writes one intern payroll row on completed attendance and is idempotent', async () => {
    const user: SheetUser = { userId: 'I-1', fullName: 'Intern One', rfidUid: 'A1B2', department: null, active: true, employeeType: 'INTERN' };
    const attendance: SheetAttendance = {
      attendanceId: 'A-1', attendanceDate: '2026-07-28', userId: 'I-1', rfidUid: 'A1B2', fullName: 'Intern One', department: null,
      timeIn: '2026-07-28T08:12:00+08:00', timeOut: '2026-07-28T17:10:00+08:00', status: 'COMPLETED', source: 'RFID', notes: '',
    };
    const sheets = new InMemorySheetsService([user], [attendance]);
    const service = new PayrollService(sheets);
    const first = await service.ensureForCompletedAttendance(attendance, user);
    const second = await service.ensureForCompletedAttendance(attendance, user);
    expect(first.payrollId).toBe(second.payrollId);
    expect(first.dailyPay).toBe(80);
    expect(first.actualTimeIn).toBe(attendance.timeIn);
    expect(first.computedTimeIn).toBe('2026-07-28T08:00:00+08:00');
  });

  it('one grace per Manila week', async () => {
    const user: SheetUser = { userId: 'I-WEEK', fullName: 'Weekly Intern', rfidUid: 'C3D4', department: null, active: true, employeeType: 'INTERN' };
    const sheets = new InMemorySheetsService([user]);
    const service = new PayrollService(sheets);
    const attendanceFor = (attendanceId: string, attendanceDate: string): SheetAttendance => ({
      attendanceId, attendanceDate, userId: user.userId, rfidUid: user.rfidUid, fullName: user.fullName, department: null,
      timeIn: `${attendanceDate}T08:08:00+08:00`, timeOut: `${attendanceDate}T17:00:00+08:00`, status: 'COMPLETED', source: 'RFID', notes: '',
    });
    const firstAttendance = attendanceFor('I-WEEK-1', '2026-09-21');
    const secondAttendance = attendanceFor('I-WEEK-2', '2026-09-22');
    await sheets.createAttendance(firstAttendance);
    await sheets.createAttendance(secondAttendance);
    const first = await service.ensureForCompletedAttendance(firstAttendance, user);
    const second = await service.ensureForCompletedAttendance(secondAttendance, user);
    expect(first).toMatchObject({ graceUsed: true, lateHours: 0, lateDeduction: 0, dailyPay: 80 });
    expect(second).toMatchObject({ graceUsed: false, lateHours: 1, lateDeduction: 10, dailyPay: 70 });
  });

  it('claims exact 08:15 grace once and charges second same-week 08:15 arrival plus separate undertime', async () => {
    const user: SheetUser = { userId: 'I-815-WEEK', fullName: 'Quarter Past Intern', rfidUid: 'C3D5', department: null, active: true, employeeType: 'INTERN' };
    const sheets = new InMemorySheetsService([user]);
    const service = new PayrollService(sheets);
    const attendanceFor = (attendanceId: string, attendanceDate: string): SheetAttendance => ({
      attendanceId, attendanceDate, userId: user.userId, rfidUid: user.rfidUid, fullName: user.fullName, department: null,
      timeIn: `${attendanceDate}T08:15:00+08:00`, timeOut: `${attendanceDate}T15:00:00+08:00`, status: 'COMPLETED', source: 'RFID', notes: '',
    });

    const firstAttendance = attendanceFor('I-815-WEEK-1', '2026-09-21');
    const secondAttendance = attendanceFor('I-815-WEEK-2', '2026-09-22');
    await sheets.createAttendance(firstAttendance);
    await sheets.createAttendance(secondAttendance);
    const first = await service.ensureForCompletedAttendance(firstAttendance, user);
    const second = await service.ensureForCompletedAttendance(secondAttendance, user);

    expect(first).toMatchObject({ graceUsed: true, lateHours: 0, lateDeduction: 0, basePay: 80, dailyPay: 60 });
    expect(second).toMatchObject({ graceUsed: false, lateHours: 1, lateDeduction: 10, basePay: 80, dailyPay: 50 });
    expect(second.dailyPay).toBe(second.basePay - second.lateDeduction - 20);
  });
});
