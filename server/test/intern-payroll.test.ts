import { describe, expect, it } from 'vitest';
import { calculateInternPayroll, manilaWeekStart } from '../src/intern-payroll.js';

describe('intern payroll policy', () => {
  it('applies weekly grace period for arrival between 08:00 and 08:15', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:12:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: true,
    });

    expect(result).toMatchObject({
      computedTimeIn: '2026-07-28T08:12:00+08:00',
      computedTimeOut: '2026-07-28T17:10:00+08:00',
      lateHours: 0,
      lateDeduction: 0,
      graceUsed: true,
      basePay: 80,
      dailyPay: 80,
      workedHours: 8,
    });
  });

  it('treats arrival beyond 08:15 as late even if graceAvailable is true', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:17:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: true,
    });

    expect(result).toMatchObject({
      computedTimeIn: '2026-07-28T09:00:00+08:00',
      lateHours: 1,
      lateDeduction: 10,
      graceUsed: false,
      basePay: 80,
      dailyPay: 70,
    });
  });

  it('never counts the 12:00–13:00 lunch hour as payable time', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.workedHours).toBe(8);
    expect(result.isHalfDay).toBe(false);
    expect(result.dailyPay).toBe(80);
  });

  it('automatically considers time-outs before 5:00 PM as half day and deducts half daily rate', () => {
    // 08:00 to 16:00 (4:00 PM): 7 payable hours, timed out before 5:00 PM -> half day.
    const early = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      graceAvailable: true,
    });
    expect(early.workedHours).toBe(7);
    expect(early.isHalfDay).toBe(true);
    expect(early.halfDayDeduction).toBe(40);
    expect(early.dailyPay).toBe(40);

    // 08:00 to 16:59:59: before 5:00 PM -> half day.
    const justBeforeFive = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:59:59+08:00',
      graceAvailable: true,
    });
    expect(justBeforeFive.isHalfDay).toBe(true);
    expect(justBeforeFive.halfDayDeduction).toBe(40);
    expect(justBeforeFive.dailyPay).toBe(40);

    // 08:00 to 17:00:00: full day.
    const fullDay = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(fullDay.workedHours).toBe(8);
    expect(fullDay.isHalfDay).toBe(false);
    expect(fullDay.halfDayDeduction).toBe(0);
    expect(fullDay.dailyPay).toBe(80);
  });

  it('snaps later lates and floors daily pay at zero', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T16:01:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: false,
    });

    expect(result).toMatchObject({ computedTimeIn: '2026-07-28T17:00:00+08:00', lateHours: 9, lateDeduction: 90, graceUsed: false, dailyPay: 0, workedHours: 2 });
  });

  it('uses Monday as the Manila payroll week boundary', () => {
    expect(manilaWeekStart('2026-08-02')).toBe('2026-07-27');
    expect(manilaWeekStart('2026-08-03')).toBe('2026-08-03');
  });

  it('deducts half day pay when worked hours are 4 or fewer', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:00:00+08:00',
      graceAvailable: true,
    });
    expect(result).toMatchObject({
      workedHours: 4,
      isHalfDay: true,
      halfDayDeduction: 40,
      basePay: 80,
      dailyPay: 40,
    });
  });
});
