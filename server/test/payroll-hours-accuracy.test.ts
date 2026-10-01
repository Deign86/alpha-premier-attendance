import { describe, expect, it } from 'vitest';
import { calculateEmployeePayroll } from '../src/employee-payroll.js';
import { calculateInternPayroll } from '../src/intern-payroll.js';

describe('payroll hours accuracy characterization', () => {
  describe('employee payroll', () => {
    it('T-E1: pays a standard full day', () => {
      // Rules: lunch-break.ts:146-159 fractional paid hours; employee-payroll.ts:12-15 hourly rate and daily pay.
      const result = calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T08:00:00+08:00',
        actualTimeOut: '2026-07-28T17:00:00+08:00',
        dailyRate: 800,
      });

      expect(result.workedHours).toBe(8);
      expect(result.dailyPay).toBe(800);
      expect(result.halfDayDeduction).toBe(0);
      expect(result.isHalfDay).toBe(false);
      expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
    });

    it('T-E2: treats a four-hour morning shift as a half day with noon time-out', () => {
      // Rules: lunch-break.ts:146-159 and :102-106; effective noon rule at :118-125.
      const result = calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T08:00:00+08:00',
        actualTimeOut: '2026-07-28T12:00:00+08:00',
        dailyRate: 800,
      });

      expect(result.workedHours).toBe(4);
      expect(result.dailyPay).toBe(400);
      expect(result.halfDayDeduction).toBe(400);
      expect(result.isHalfDay).toBe(true);
      expect(result.computedTimeOut).toBe('2026-07-28T12:00:00+08:00');
    });

    it('T-E3: preserves fractional paid hours across the lunch overlap', () => {
      // Rules: lunch-break.ts:146-159 subtracts lunch and preserves fractions; characterization divergence from Rust R-E3.
      const result = calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T11:45:00+08:00',
        actualTimeOut: '2026-07-28T13:15:00+08:00',
        dailyRate: 800,
      });

      expect(result.workedHours).toBe(0.5);
      expect(result.dailyPay).toBe(50);
      expect(result.halfDayDeduction).toBe(750);
      expect(result.isHalfDay).toBe(true);
    });

    it('T-E4: divides a non-even daily rate by eight for hourly pay', () => {
      // Rule: employee-payroll.ts:12-15 uses dailyRate / 8 then multiplies fractional worked hours.
      const result = calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T08:00:00+08:00',
        actualTimeOut: '2026-07-28T17:00:00+08:00',
        dailyRate: 803,
      });

      expect(result.dailyPay).toBe(803);
      expect(result.halfDayDeduction).toBe(0);
    });

    it('T-E5: caps an 18:00-or-later time-out to 17:00', () => {
      // Rule: lunch-break.ts:94-99 caps the time-out before shift calculation.
      const result = calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T08:00:00+08:00',
        actualTimeOut: '2026-07-28T18:30:00+08:00',
        dailyRate: 800,
      });

      expect(result.workedHours).toBe(8);
      expect(result.dailyPay).toBe(800);
      expect(result.computedTimeOut).toBe('2026-07-28T17:00:00+08:00');
    });

    it('T-E6: deducts one unrendered hour for a 16:00 time-out', () => {
      // Rules: lunch-break.ts:146-159 calculates seven paid hours and the one-hour shortfall.
      const result = calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T08:00:00+08:00',
        actualTimeOut: '2026-07-28T16:00:00+08:00',
        dailyRate: 800,
      });

      expect(result.workedHours).toBe(7);
      expect(result.dailyPay).toBe(700);
      expect(result.halfDayDeduction).toBe(100);
      expect(result.isHalfDay).toBe(false);
    });

    it('T-E7: rejects inverted and offset-less timestamps', () => {
      // Rule: employee-payroll.ts:7-11 validates timestamps and rejects time-out earlier than time-in.
      expect(() => calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T17:00:00+08:00',
        actualTimeOut: '2026-07-28T08:00:00+08:00',
        dailyRate: 800,
      })).toThrow();
      expect(() => calculateEmployeePayroll({
        actualTimeIn: '2026-07-28T08:00:00',
        actualTimeOut: '2026-07-28T17:00:00+08:00',
        dailyRate: 800,
      })).toThrow();
    });
  });

  describe('intern payroll', () => {
    it('T-I1: computes a full October no-grace day', () => {
      // Rules: intern-payroll.ts:49-56 no-grace lateness; :74-80 deductions; :97 pay.
      const result = calculateInternPayroll({
        attendanceDate: '2026-10-01',
        actualTimeIn: '2026-10-01T08:00:00+08:00',
        actualTimeOut: '2026-10-01T17:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(0);
      expect(result.workedHours).toBe(8);
      expect(result.halfDayDeduction).toBe(0);
      expect(result.dailyPay).toBe(80);
    });

    it('T-I2: charges two late hours for a 09:30 arrival', () => {
      // Rules: intern-payroll.ts:49-56 uses ceil(elapsed / hour); :71 and :97 compute deductions and pay.
      const result = calculateInternPayroll({
        attendanceDate: '2026-10-01',
        actualTimeIn: '2026-10-01T09:30:00+08:00',
        actualTimeOut: '2026-10-01T17:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(2);
      expect(result.lateDeduction).toBe(20);
      expect(result.workedHours).toBe(6.5);
      expect(result.halfDayDeduction).toBe(0);
      expect(result.dailyPay).toBe(60);
    });

    it('T-I3: subtracts late hours before calculating additional undertime', () => {
      // Rules: intern-payroll.ts:77-80 excludes already-deducted late hours; :97 caps resulting pay.
      const result = calculateInternPayroll({
        attendanceDate: '2026-10-01',
        actualTimeIn: '2026-10-01T09:30:00+08:00',
        actualTimeOut: '2026-10-01T16:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(2);
      expect(result.lateDeduction).toBe(20);
      expect(result.workedHours).toBe(5.5);
      expect(result.halfDayDeduction).toBe(10);
      expect(result.dailyPay).toBe(50);
    });

    it('T-I4: deducts one undertime hour for an 08:00-to-16:00 shift', () => {
      // Rules: lunch-break.ts:146-159 gives seven hours; intern-payroll.ts:77-80 applies the shortfall.
      const result = calculateInternPayroll({
        attendanceDate: '2026-10-01',
        actualTimeIn: '2026-10-01T08:00:00+08:00',
        actualTimeOut: '2026-10-01T16:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(0);
      expect(result.workedHours).toBe(7);
      expect(result.halfDayDeduction).toBe(10);
      expect(result.dailyPay).toBe(70);
    });

    it('T-I5: applies grace before the October 1 no-grace cutover only', () => {
      // Rules: intern-payroll.ts:41-46 selects grace by date; :49-56 calculates no-grace lateness.
      const september = calculateInternPayroll({
        attendanceDate: '2026-09-30',
        actualTimeIn: '2026-09-30T08:08:00+08:00',
        actualTimeOut: '2026-09-30T17:00:00+08:00',
        graceAvailable: true,
      });
      const october = calculateInternPayroll({
        attendanceDate: '2026-10-01',
        actualTimeIn: '2026-10-01T08:08:00+08:00',
        actualTimeOut: '2026-10-01T17:00:00+08:00',
        graceAvailable: true,
      });

      expect(september.graceUsed).toBe(true);
      expect(september.computedTimeIn).toBe('2026-09-30T08:00:00+08:00');
      expect(september.dailyPay).toBe(80);
      expect(october.graceUsed).toBe(false);
      expect(october.lateHours).toBe(1);
      expect(october.lateDeduction).toBe(10);
      expect(october.dailyPay).toBe(70);
    });

    it('T-I6: converts an 08:00-to-12:30 shift to four worked hours and noon time-out', () => {      // Rules: lunch-break.ts:146-159 truncates through lunch-adjusted paid seconds; :102-106 marks half day; :118-125 applies noon.
      const result = calculateInternPayroll({
        attendanceDate: '2026-10-01',
        actualTimeIn: '2026-10-01T08:00:00+08:00',
        actualTimeOut: '2026-10-01T12:30:00+08:00',
        graceAvailable: false,
      });

      expect(result.workedHours).toBe(4);
      expect(result.isHalfDay).toBe(true);
      expect(result.halfDayDeduction).toBe(40);
      expect(result.dailyPay).toBe(40);
      expect(result.computedTimeOut).toBe('2026-10-01T12:00:00+08:00');
    });

    it('T-I7: books a 12:00-to-17:00 afternoon arrival as half-day undertime, not late', () => {
      // Rule: an arrival at/after 12:00 renders the afternoon half of the day;
      // the 4-hour shortfall is half-day deduction, never late hours.
      const result = calculateInternPayroll({
        attendanceDate: '2026-10-02',
        actualTimeIn: '2026-10-02T12:00:00+08:00',
        actualTimeOut: '2026-10-02T17:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(0);
      expect(result.lateDeduction).toBe(0);
      expect(result.workedHours).toBe(4);
      expect(result.isHalfDay).toBe(true);
      expect(result.halfDayDeduction).toBe(40);
      expect(result.dailyPay).toBe(40);
    });

    it('T-I8: books a pre-cutover 12:00-to-17:00 arrival as half-day undertime, not late', () => {
      // Rule: same afternoon-arrival exemption on the legacy grace branch.
      const result = calculateInternPayroll({
        attendanceDate: '2026-09-15',
        actualTimeIn: '2026-09-15T12:00:00+08:00',
        actualTimeOut: '2026-09-15T17:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(0);
      expect(result.lateDeduction).toBe(0);
      expect(result.workedHours).toBe(4);
      expect(result.isHalfDay).toBe(true);
      expect(result.halfDayDeduction).toBe(40);
      expect(result.dailyPay).toBe(40);
    });
    it('T-I9: skips the quarter clamp for a pre-cutover 12:30 arrival', () => {
      // Rule: payable stays the actual stamp when no late is charged.
      // 12:30-to-17:00 spans 4.5h minus the 0.5h 12:30-13:00 lunch overlap.
      const result = calculateInternPayroll({
        attendanceDate: '2026-09-15',
        actualTimeIn: '2026-09-15T12:30:00+08:00',
        actualTimeOut: '2026-09-15T17:00:00+08:00',
        graceAvailable: false,
      });

      expect(result.lateHours).toBe(0);
      expect(result.lateDeduction).toBe(0);
      expect(result.computedTimeIn).toBe('2026-09-15T12:30:00+08:00');
      expect(result.workedHours).toBe(4);
      expect(result.isHalfDay).toBe(true);
      expect(result.halfDayDeduction).toBe(40);
      expect(result.dailyPay).toBe(40);
    });
  });
});
