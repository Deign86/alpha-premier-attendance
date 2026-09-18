import { DateTime } from 'luxon';
import { INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP } from '@rfid-attendance/shared';
import { capLateTimeoutOut, ceilHour, computeShiftCore, effectiveHalfDayTimeOut, manilaTimestamp } from './lunch-break.js';

export type InternPayrollInput = {
  attendanceDate: string;
  actualTimeIn: string;
  actualTimeOut: string;
  graceAvailable: boolean;
};

export type InternPayrollResult = {
  computedTimeIn: string;
  computedTimeOut: string;
  lateHours: number;
  lateDeduction: number;
  isHalfDay: boolean;
  halfDayDeduction: number;
  graceUsed: boolean;
  basePay: number;
  dailyPay: number;
  workedHours: number;
};

const timezone = 'Asia/Manila';

export function calculateInternPayroll(input: InternPayrollInput): InternPayrollResult {
  const actualTimeIn = manilaTimestamp(input.actualTimeIn);
  // Late time-out auto-cap (overtime forbidden): 18:00+ pays as 17:00.
  const actualTimeOut = capLateTimeoutOut(manilaTimestamp(input.actualTimeOut));
  // P4: reject inverted logs instead of silently flooring worked hours to zero.
  if (actualTimeOut < actualTimeIn) throw new Error('Time-out cannot be earlier than time-in');
  const start = DateTime.fromISO(`${input.attendanceDate}T08:00:00`, { zone: timezone });
  const graceEnd = DateTime.fromISO(`${input.attendanceDate}T08:15:00`, { zone: timezone });
  if (!start.isValid || !graceEnd.isValid) throw new Error('Payroll timestamps must be valid ISO values');

  const lateMilliseconds = actualTimeIn.toMillis() - start.toMillis();
  const rawLateHours = lateMilliseconds > 0 ? Math.ceil(lateMilliseconds / 3_600_000) : 0;
  const inGraceWindow = actualTimeIn > start && actualTimeIn <= graceEnd;

  const graceUsed = inGraceWindow && input.graceAvailable;
  const lateHours = graceUsed ? 0 : rawLateHours;
  const lateDeduction = lateHours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP;
  const computedTimeIn = lateHours > 0 ? ceilHour(actualTimeIn) : actualTimeIn;
  const basePay = INTERN_DAILY_RATE_PHP;
  const hourlyRate = INTERN_DAILY_RATE_PHP / 8;
  const payableIn = graceUsed ? start : (lateHours > 0 ? computedTimeIn : (actualTimeIn < start ? start : actualTimeIn));
  const { workedHours, isHalfDay, halfDayDeduction, dailyPay } = computeShiftCore(payableIn, actualTimeOut, actualTimeIn, hourlyRate);
  // DTR DECOUPLING: `computedTimeOut` is a PAYROLL-ONLY effective window.
  // A morning half-day closed before office close pays as 08:00–12:00 even
  // though the DTR row keeps the actual 08:00–15:00 stamps. Never push
  // computed values back into the DTR sheet writer (planPush/buildDtrRow).
  const effectiveTimeOut = effectiveHalfDayTimeOut(isHalfDay, actualTimeIn, actualTimeOut) ?? actualTimeOut;

  return {
    computedTimeIn: computedTimeIn.toISO({ suppressMilliseconds: true })!,
    computedTimeOut: effectiveTimeOut.toISO({ suppressMilliseconds: true })!,
    lateHours,
    lateDeduction,
    isHalfDay,
    halfDayDeduction,
    graceUsed,
    basePay,
    dailyPay,
    workedHours,
  };
}
