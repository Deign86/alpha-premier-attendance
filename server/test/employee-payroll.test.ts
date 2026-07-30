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
      basePay: 650,
      dailyPay: 650,
    });
  });
});
