import { describe, expect, it } from 'vitest';
import { calculateEmployeePayroll } from '../src/employee-payroll.js';
import { manilaTimestamp } from '../src/lunch-break.js';

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
      // 07:50 to 17:10 elapsed is ceiled to 10 hours and capped at standard 8 hours.
      workedHours: 8,
    });
  });

  it('computes daily pay strictly 1:1 from DTR hours (8:00 AM to 3:00 PM -> 6 hours at ₱800/day -> ₱600)', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T15:00:00+08:00',
      dailyRate: 800,
    });
    expect(result.workedHours).toBe(6);
    expect(result.dailyPay).toBe(600);
    expect(result.halfDayDeduction).toBe(200);
    expect(result.basePay).toBe(800);
  });

  it('computes 7 hours for 8:00 AM to 4:00 PM at ₱800/day -> ₱700 (₱100 deduction)', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      dailyRate: 800,
    });
    expect(result.workedHours).toBe(7);
    expect(result.dailyPay).toBe(700);
    expect(result.halfDayDeduction).toBe(100);
    expect(result.basePay).toBe(800);
  });

  it('computes full daily rate for 8:00 AM to 5:00 PM full day (8 hours at ₱800/day -> ₱800)', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 800,
    });
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(800);
    expect(result.halfDayDeduction).toBe(0);
    expect(result.basePay).toBe(800);
  });

  it('calculates 1:1 hours for standard and partial shifts', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 650,
    });
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(650);

    // Partial window: 11:45–13:15 elapsed is 1.5h minus 1h lunch = 0.5h -> 0 whole hours.
    const partial = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T11:45:00+08:00',
      actualTimeOut: '2026-07-28T13:15:00+08:00',
      dailyRate: 650,
    });
    expect(partial.workedHours).toBe(0);
    expect(partial.dailyPay).toBe(0);
  });

  it('strictly counts whole hours: 08:00-12:30 pays 4 hours, matching 08:00-12:00', () => {
    const atNoon = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:00:00+08:00',
      dailyRate: 600,
    });
    expect(atNoon.workedHours).toBe(4);
    expect(atNoon.dailyPay).toBe(300);
    expect(atNoon.isHalfDay).toBe(true);

    const atTwelveThirty = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:30:00+08:00',
      dailyRate: 600,
    });
    expect(atTwelveThirty.workedHours).toBe(4);
    expect(atTwelveThirty.dailyPay).toBe(300);
    expect(atTwelveThirty.isHalfDay).toBe(true);
    expect(atTwelveThirty.halfDayDeduction).toBe(300);
  });

  it('deducts unrendered hours for shifts under 8 hours and treats full shift as full day', () => {
    // 08:00 to 15:00 (3:00 PM): 6 payable hours (7h - 1h lunch), 2 hours unrendered deducted.
    const earlyClockOut = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T15:00:00+08:00',
      dailyRate: 600,
    });
    expect(earlyClockOut.workedHours).toBe(6);
    expect(earlyClockOut.isHalfDay).toBe(false);
    expect(earlyClockOut.halfDayDeduction).toBe(150);
    expect(earlyClockOut.dailyPay).toBe(450);

    // 08:00 to 16:00 (4:00 PM): 7 payable hours (8h - 1h lunch), 1 hour unrendered deducted.
    const sevenHours = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      dailyRate: 600,
    });
    expect(sevenHours.workedHours).toBe(7);
    expect(sevenHours.isHalfDay).toBe(false);
    expect(sevenHours.halfDayDeduction).toBe(75);
    expect(sevenHours.dailyPay).toBe(525);

    // 08:00 to 17:00:00 (5:00 PM): normal full day shift (8 hours).
    const fullDay = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    });
    expect(fullDay.workedHours).toBe(8);
    expect(fullDay.isHalfDay).toBe(false);
    expect(fullDay.halfDayDeduction).toBe(0);
    expect(fullDay.dailyPay).toBe(600);

    // T6 decision A: 08:00 to 17:00:01 (one second past close): full day.
    const justAfterFive = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:01+08:00',
      dailyRate: 600,
    });
    expect(justAfterFive.isHalfDay).toBe(false);
    expect(justAfterFive.halfDayDeduction).toBe(0);
    expect(justAfterFive.dailyPay).toBe(600);
  });

  it('afternoon arrival at/after 12:00 PM is half day even with 17:00+ time-out', () => {
    const noon = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T12:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    });
    expect(noon.workedHours).toBe(4);
    expect(noon.isHalfDay).toBe(true);
    expect(noon.halfDayDeduction).toBe(300);
    expect(noon.dailyPay).toBe(300);
    const overtime = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T12:00:00+08:00',
      actualTimeOut: '2026-07-28T18:00:00+08:00',
      dailyRate: 600,
    });
    expect(overtime.isHalfDay).toBe(true);
    const before = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T11:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    });
    expect(before.isHalfDay).toBe(false);
    expect(before.workedHours).toBe(5);
  });

  it('P5: sub-second residue does not push an exact hour up', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00.500+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    });
    expect(result.computedTimeIn).toBe('2026-07-28T08:00:00+08:00');
    expect(result.isHalfDay).toBe(false);
  });

  it('P4: rejects time-out earlier than time-in instead of zeroing hours', () => {
    expect(() => calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T09:00:00+08:00',
      actualTimeOut: '2026-07-28T08:00:00+08:00',
      dailyRate: 600,
    })).toThrow('earlier than time-in');
  });

  it('P6: rejects offset-less timestamps at the payroll boundary', () => {
    expect(() => manilaTimestamp('2026-07-28T08:00:00')).toThrow('UTC offset');
    expect(() => calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    })).toThrow('UTC offset');
  });

  it('A2: morning half-day closed before office close pays an effective 12:00 time-out', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T11:30:00+08:00',
      dailyRate: 600,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T12:00:00+08:00');
  });

  it('A2: afternoon arrival at/after 12:00 is not replaced with a 12:00 time-out', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T12:30:00+08:00',
      actualTimeOut: '2026-07-28T16:30:00+08:00',
      dailyRate: 600,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T16:00:00+08:00');
  });

  it('A2: a clock-out exactly at 17:00 is not replaced with a 12:00 time-out', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      dailyRate: 600,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });

  it('A2: a post-18:00 clock-out caps to 17:00 before the half-day rule runs', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T18:30:00+08:00',
      dailyRate: 600,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });

  it('A2: the non-morning-half-day else branch floors the time-out to the hour', () => {
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T13:30:00+08:00',
      actualTimeOut: '2026-07-28T16:45:00+08:00',
      dailyRate: 600,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T16:00:00+08:00');
  });

  it('A2: 17:30 floors to 17:00 where the intern engine keeps 17:30', () => {
    // Locks the intentional employee/intern difference at the exact value the
    // Rust engines assert, so the two stacks cannot drift apart unnoticed.
    const result = calculateEmployeePayroll({
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:30:00+08:00',
      dailyRate: 600,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });
});
