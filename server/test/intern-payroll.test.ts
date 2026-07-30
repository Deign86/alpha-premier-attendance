import { describe, expect, it } from 'vitest';
import { calculateInternPayroll, manilaWeekStart } from '../src/intern-payroll.js';

describe('intern payroll policy', () => {
  it('keeps the first late exact and free', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:17:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: true,
    });

    expect(result).toMatchObject({ computedTimeIn: '2026-07-28T08:17:00+08:00', computedTimeOut: '2026-07-28T17:10:00+08:00', lateHours: 1, lateDeduction: 0, graceUsed: true, basePay: 80, dailyPay: 80 });
  });

  it('snaps later lates and floors daily pay at zero', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T16:01:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: false,
    });

    expect(result).toMatchObject({ computedTimeIn: '2026-07-28T17:00:00+08:00', lateHours: 9, lateDeduction: 90, graceUsed: false, dailyPay: 0 });
  });

  it('uses Monday as the Manila payroll week boundary', () => {
    expect(manilaWeekStart('2026-08-02')).toBe('2026-07-27');
    expect(manilaWeekStart('2026-08-03')).toBe('2026-08-03');
  });
});
