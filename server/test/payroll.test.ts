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
    expect(first.computedTimeIn).toBe(attendance.timeIn);
  });
});
