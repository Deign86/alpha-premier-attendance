import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { lunchBreakExcludedSeconds, paidWorkHours, paidWorkHoursCeiled, paidWorkSeconds } from '../src/lunch-break.js';
import { calculateEmployeePayroll } from '../src/employee-payroll.js';
import { calculateInternPayroll } from '../src/intern-payroll.js';

const timezone = 'Asia/Manila';
function at(hour: number, minute: number, day = 1): DateTime {
  return DateTime.fromISO(`2026-08-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`, { setZone: true }).setZone(timezone);
}
function seconds(hours: number): number { return hours * 3600; }

describe('lunch break exclusion (12:00–13:00 Manila)', () => {
  it('excludes the full window from a shift spanning lunch', () => {
    expect(lunchBreakExcludedSeconds(at(9, 0), at(17, 0))).toBe(seconds(1));
    expect(paidWorkSeconds(at(9, 0), at(17, 0))).toBe(seconds(7));
    expect(paidWorkHoursCeiled(at(9, 0), at(17, 0))).toBe(7);
  });

  it('excludes nothing for shifts entirely before lunch', () => {
    expect(lunchBreakExcludedSeconds(at(6, 0), at(11, 0))).toBe(0);
    expect(paidWorkSeconds(at(6, 0), at(11, 0))).toBe(seconds(5));
  });

  it('excludes nothing for shifts entirely after lunch', () => {
    expect(lunchBreakExcludedSeconds(at(13, 0), at(18, 0))).toBe(0);
    expect(paidWorkSeconds(at(13, 0), at(18, 0))).toBe(seconds(5));
  });

  it('subtracts only the overlap when clock-out falls inside the window', () => {
    // 11:30–12:30 → 11:30–12:00 is paid (30 min), 12:00–12:30 excluded.
    expect(lunchBreakExcludedSeconds(at(11, 30), at(12, 30))).toBe(1800);
    expect(paidWorkSeconds(at(11, 30), at(12, 30))).toBe(1800);
  });

  it('subtracts only the overlap when clock-in falls inside the window', () => {
    // 12:30–14:00 → 13:00–14:00 is paid (60 min), 12:30–13:00 excluded.
    expect(lunchBreakExcludedSeconds(at(12, 30), at(14, 0))).toBe(1800);
    expect(paidWorkSeconds(at(12, 30), at(14, 0))).toBe(seconds(1));
  });

  it('pays nothing for an interval entirely inside the lunch window', () => {
    expect(paidWorkSeconds(at(12, 10), at(12, 50))).toBe(0);
    // 12:10–13:10 → only the 10 minutes after 13:00 are paid.
    expect(paidWorkSeconds(at(12, 10), at(13, 10))).toBe(600);
  });

  it('sums only the working edges for partial hours around lunch', () => {
    // 11:45–13:15 → 15 min before + 15 min after = 30 min paid.
    expect(paidWorkSeconds(at(11, 45), at(13, 15))).toBe(1800);
    expect(paidWorkHours(at(11, 45), at(13, 15))).toBeCloseTo(0.5);
  });

  it('handles overnight spans by checking each touched day', () => {
    // 22:00 on Aug 1 → 14:00 on Aug 2 crosses the Aug 2 lunch window.
    expect(lunchBreakExcludedSeconds(at(22, 0, 1), at(14, 0, 2))).toBe(seconds(1));
    expect(paidWorkSeconds(at(22, 0, 1), at(14, 0, 2))).toBe(seconds(15));
  });

  it('floors inverted or zero intervals at zero paid time', () => {
    expect(paidWorkSeconds(at(17, 0), at(9, 0))).toBe(0);
    expect(paidWorkSeconds(at(9, 0), at(9, 0))).toBe(0);
  });
});

describe('employee payroll calculates hours 1:1 from DTR', () => {
  it('reports 8 payable hours for a 09:00–17:00 shift', () => {
    const result = calculateEmployeePayroll({ actualTimeIn: '2026-08-01T09:00:00+08:00', actualTimeOut: '2026-08-01T17:00:00+08:00', dailyRate: 500 });
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(500);
  });

  it('reports 2 ceiled hours for an 11:45-13:15 shift (1.5h elapsed)', () => {
    const result = calculateEmployeePayroll({ actualTimeIn: '2026-08-01T11:45:00+08:00', actualTimeOut: '2026-08-01T13:15:00+08:00', dailyRate: 500 });
    expect(result.workedHours).toBe(2);
    expect(result.dailyPay).toBe(125);
  });
});

describe('intern payroll calculates hours 1:1 from DTR', () => {
  it('reports 8 payable hours for a 08:00–17:00 shift while keeping PHP 80/day', () => {
    const result = calculateInternPayroll({ attendanceDate: '2026-08-01', actualTimeIn: '2026-08-01T08:00:00+08:00', actualTimeOut: '2026-08-01T17:00:00+08:00', graceAvailable: true });
    expect(result.workedHours).toBe(8);
    expect(result.basePay).toBe(80);
    expect(result.dailyPay).toBe(80);
  });

  it('reports 8 payable hours for 09:30–17:00 (7.5h elapsed ceiled to 8h)', () => {
    const result = calculateInternPayroll({ attendanceDate: '2026-08-01', actualTimeIn: '2026-08-01T09:30:00+08:00', actualTimeOut: '2026-08-01T17:00:00+08:00', graceAvailable: false });
    expect(result.lateHours).toBe(2);
    expect(result.lateDeduction).toBe(20);
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(80);
  });
});
