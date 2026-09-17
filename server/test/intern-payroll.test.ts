import { describe, expect, it } from 'vitest';
import { getManilaWeekStart } from '@rfid-attendance/shared';
import { calculateInternPayroll } from '../src/intern-payroll.js';

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
      workedHours: 7,
    });
  });

  it('computes daily pay strictly 1:1 from DTR hours (8:00 AM to 3:00 PM -> 6 hours -> ₱60)', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T15:00:00+08:00',
      graceAvailable: false,
    });
    expect(result.workedHours).toBe(6);
    expect(result.dailyPay).toBe(60);
    expect(result.halfDayDeduction).toBe(20);
    expect(result.basePay).toBe(80);
  });

  it('computes 7 hours for 8:00 AM to 4:00 PM -> ₱70 (₱10 deduction)', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.workedHours).toBe(7);
    expect(result.dailyPay).toBe(70);
    expect(result.halfDayDeduction).toBe(10);
    expect(result.basePay).toBe(80);
  });

  it('computes full daily rate for 8:00 AM to 5:00 PM full day -> 8 hours -> ₱80', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(80);
    expect(result.halfDayDeduction).toBe(0);
    expect(result.basePay).toBe(80);
  });

  it('never counts unworked time beyond DTR time-in/out and calculates 1:1 hours', () => {
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

  it('deducts unrendered hours for shifts under 8 hours and treats full shift as full day', () => {
    // 08:00 to 15:00 (3:00 PM): 6 payable hours (7h - 1h lunch), 2h unrendered deducted (₱20).
    const early = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T15:00:00+08:00',
      graceAvailable: true,
    });
    expect(early.workedHours).toBe(6);
    expect(early.isHalfDay).toBe(false);
    expect(early.halfDayDeduction).toBe(20);
    expect(early.dailyPay).toBe(60);

    // 08:00 to 16:00: 7 hours (8h - 1h lunch), 1h unrendered deducted (₱10).
    const sevenHours = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T16:00:00+08:00',
      graceAvailable: true,
    });
    expect(sevenHours.workedHours).toBe(7);
    expect(sevenHours.isHalfDay).toBe(false);
    expect(sevenHours.halfDayDeduction).toBe(10);
    expect(sevenHours.dailyPay).toBe(70);

    // 08:00 to 17:00:00: full day (8 hours).
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

  it('afternoon arrival at/after 12:00 PM is half day even with 17:00+ time-out', () => {
    const noon = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T12:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: false,
    });
    expect(noon.workedHours).toBe(4);
    expect(noon.isHalfDay).toBe(true);
    expect(noon.halfDayDeduction).toBe(40);
    expect(noon.dailyPay).toBe(40);
  });

  it('T6 decision A: one second past 17:00:00 is still a full day', () => {
    const justAfterFive = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:01+08:00',
      graceAvailable: true,
    });
    expect(justAfterFive.isHalfDay).toBe(false);
    expect(justAfterFive.halfDayDeduction).toBe(0);
    expect(justAfterFive.dailyPay).toBe(80);
  });

  it('snaps later lates and floors daily pay at zero', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T16:01:00+08:00',
      actualTimeOut: '2026-07-28T17:10:00+08:00',
      graceAvailable: false,
    });

    expect(result).toMatchObject({ computedTimeIn: '2026-07-28T17:00:00+08:00', lateHours: 9, lateDeduction: 90, graceUsed: false, dailyPay: 0, workedHours: 0 });
  });

  it('strictly counts whole hours: 08:00-12:30 pays 4 hours (₱40), matching 08:00-12:00', () => {
    const atNoon = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:00:00+08:00',
      graceAvailable: true,
    });
    expect(atNoon.workedHours).toBe(4);
    expect(atNoon.dailyPay).toBe(40);
    expect(atNoon.isHalfDay).toBe(true);
    expect(atNoon.halfDayDeduction).toBe(40);

    const atTwelveThirty = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T12:30:00+08:00',
      graceAvailable: true,
    });
    expect(atTwelveThirty.workedHours).toBe(4);
    expect(atTwelveThirty.dailyPay).toBe(40);
    expect(atTwelveThirty.isHalfDay).toBe(true);
    expect(atTwelveThirty.halfDayDeduction).toBe(40);
  });

  it('uses Monday as the Manila payroll week boundary', () => {
    expect(getManilaWeekStart('2026-08-02')).toBe('2026-07-27');
    expect(getManilaWeekStart('2026-08-03')).toBe('2026-08-03');
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

  it('P4: rejects time-out earlier than time-in instead of zeroing hours', () => {
    expect(() => calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T09:00:00+08:00',
      actualTimeOut: '2026-07-28T08:00:00+08:00',
      graceAvailable: true,
    })).toThrow('earlier than time-in');
  });

  it('A2: morning half-day closed before office close pays an effective 12:00 time-out', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T11:30:00+08:00',
      graceAvailable: true,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T12:00:00+08:00');
  });

  it('A2: afternoon arrival at/after 12:00 is not replaced with a 12:00 time-out', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T12:30:00+08:00',
      actualTimeOut: '2026-07-28T16:30:00+08:00',
      graceAvailable: false,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T16:30:00+08:00');
  });

  it('A2: a clock-out exactly at 17:00 is not replaced with a 12:00 time-out', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:00:00+08:00',
      graceAvailable: true,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });

  it('A2: a post-18:00 clock-out caps to 17:00 before the half-day rule runs', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T18:30:00+08:00',
      graceAvailable: true,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
  });

  it('A2: the non-morning-half-day else branch returns the capped stamp unchanged', () => {
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T13:30:00+08:00',
      actualTimeOut: '2026-07-28T16:45:00+08:00',
      graceAvailable: false,
    });
    expect(result.isHalfDay).toBe(true);
    expect(result.computedTimeOut).toBe('2026-07-28T16:45:00+08:00');
  });

  it('A2: 17:30 stays 17:30 where the employee engine floors to 17:00', () => {
    // Locks the intentional intern/employee difference at the exact value the
    // Rust engines assert, so the two stacks cannot drift apart unnoticed.
    const result = calculateInternPayroll({
      attendanceDate: '2026-07-28',
      actualTimeIn: '2026-07-28T08:00:00+08:00',
      actualTimeOut: '2026-07-28T17:30:00+08:00',
      graceAvailable: false,
    });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe('2026-07-28T17:30:00+08:00');
  });
});
