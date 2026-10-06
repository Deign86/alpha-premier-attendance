import { describe, expect, it } from 'vitest';
import { calculateInternPayroll } from '../src/intern-payroll.js';

// T0 FREEZE (test-only): locks payroll vectors before any refactor.
// Order locked per vector: cap → half-day → window. 1-cent divergence = revert.
// Money asserts are exact (toEqual/toBe), never toBeCloseTo.
const DAY = '2026-07-28';
const stamp = (t: string): string => `${DAY}T${t}+08:00`;

function sortedJson(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as Record<string, unknown>).sort());
}

function capture(fn: () => unknown): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

describe('T0 freeze: intern payroll vectors (₱80/day, ₱10/h late)', () => {
  it('08:00-17:00 pays a full 8h day', () => {
    const result = calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: stamp('08:00:00'), actualTimeOut: stamp('17:00:00'), graceAvailable: true });
    expect(result.workedHours).toBe(8);
    expect(result.dailyPay).toBe(80);
    expect(result.halfDayDeduction).toBe(0);
    expect(result.basePay).toBe(80);
    expect(sortedJson(result)).toMatchSnapshot();
  });

  it('08:00-16:00 pays 7h with exact deduction', () => {
    const result = calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: stamp('08:00:00'), actualTimeOut: stamp('16:00:00'), graceAvailable: true });
    expect(result.workedHours).toBe(7);
    expect(result.dailyPay).toBe(70);
    expect(result.halfDayDeduction).toBe(10);
    expect(sortedJson(result)).toMatchSnapshot();
  });

  it('08:16 late arrival is ungraced outside the allowed window', () => {
    const result = calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: stamp('08:16:00'), actualTimeOut: stamp('17:00:00'), graceAvailable: true });
    expect(result.graceUsed).toBe(false);
    expect(result.lateHours).toBe(1);
    expect(result.lateDeduction).toBe(10);
    expect(result.computedTimeIn).toBe(stamp('09:00:00'));
    expect(result.workedHours).toBe(7);
    expect(result.dailyPay).toBe(70);
    expect(sortedJson(result)).toMatchSnapshot();
  });

  it('cap first: 18:30 out caps to 17:00 and stays full-day', () => {
    const result = calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: stamp('08:00:00'), actualTimeOut: stamp('18:30:00'), graceAvailable: true });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe(stamp('17:00:00'));
    expect(result.dailyPay).toBe(80);
    expect(sortedJson(result)).toMatchSnapshot();
  });

  it('intern passes 17:30 through (diverges from employee floor)', () => {
    const result = calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: stamp('08:00:00'), actualTimeOut: stamp('17:30:00'), graceAvailable: false });
    expect(result.isHalfDay).toBe(false);
    expect(result.computedTimeOut).toBe(stamp('17:30:00'));
    expect(sortedJson(result)).toMatchSnapshot();
  });

  it('rejects inverted stamps and offset-less ISO', () => {
    const inverted = capture(() => calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: stamp('09:00:00'), actualTimeOut: stamp('08:00:00'), graceAvailable: true }));
    expect(inverted.ok).toBe(false);
    if (!inverted.ok) expect(inverted.message).toContain('earlier than time-in');
    const offsetLess = capture(() => calculateInternPayroll({ attendanceDate: DAY, actualTimeIn: `${DAY}T08:00:00`, actualTimeOut: stamp('17:00:00'), graceAvailable: true }));
    expect(offsetLess.ok).toBe(false);
    if (!offsetLess.ok) expect(offsetLess.message).toContain('UTC offset');
    expect(sortedJson({ inverted, offsetLess })).toMatchSnapshot();
  });
});
