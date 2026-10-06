import { describe, expect, it } from 'vitest';
import { calculateInternPayroll } from '../src/intern-payroll.js';

describe('payroll hours accuracy characterization', () => {
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
