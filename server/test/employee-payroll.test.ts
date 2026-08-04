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
  });
});
