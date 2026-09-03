import { describe, expect, it } from 'vitest';
import { calculateEmployeePayroll } from '../src/employee-payroll.js';

describe('employee payroll policy', () => {
  it('rounds input up and output down without changing actual timestamps', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T07:50:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      dailyRate: 650,
    });

    expect(result).toEqual({
      computedTimeIn: '2026-07-28T08:00:00+08:00',
      computedTimeOut: '2026-07-28T17:00:00+08:00',
      lateHours: 0,
      lateDeduction: 0,
      isHalfDay: false,
      halfDayDeduction: 0,
      basePay: 650,
      dailyPay: 650,
      // 9h20m clocked minus the 12:00–13:00 lunch hour = 8h20m → ceiled to 9.
      workedHours: 9,
    });
  });

  it('never counts the 12:00–13:00 lunch hour as payable time', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T09:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 650,
    });
    expect(result.workedHours).toBe(7);

    // Partial window: 11:45–13:15 pays only the working edges (30 minutes).
    const partial = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T11:45:00+08:00',
      actualTimeOut: '2026-07-28T13:15:00+08:00',
      dailyRate: 650,
    });
    expect(partial.workedHours).toBe(1);
    expect(partial.isHalfDay).toBe(true);
    expect(partial.halfDayDeduction).toBe(325);
    expect(partial.dailyPay).toBe(325);
  });

  it('automatically considers time-outs before 5:00 PM as half day and deducts half daily rate', () => {
    // 08:00 to 16:00 (4:00 PM): 7 payable hours (> 4 hrs), but clocked out before 5:00 PM.
    const earlyClockOut = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      dailyRate: 600,
    });
    expect(earlyClockOut.workedHours).toBe(7);
    expect(earlyClockOut.isHalfDay).toBe(true);
    expect(earlyClockOut.halfDayDeduction).toBe(300);
    expect(earlyClockOut.dailyPay).toBe(300);

    // 08:00 to 16:59:59 (just before 5:00 PM): half day.
    const justBeforeFive = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:59:59+08:00',
      dailyRate: 600,
    });
    expect(justBeforeFive.isHalfDay).toBe(true);
    expect(justBeforeFive.halfDayDeduction).toBe(300);
    expect(justBeforeFive.dailyPay).toBe(300);

    // 08:00 to 17:00:00 (5:00 PM): normal full day shift.
    const fullDay = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    });
    expect(fullDay.workedHours).toBe(8);
    expect(fullDay.isHalfDay).toBe(false);
    expect(fullDay.halfDayDeduction).toBe(0);
    expect(fullDay.dailyPay).toBe(600);
  });
});
