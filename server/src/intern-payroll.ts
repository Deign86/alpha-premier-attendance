import { DateTime } from 'luxon';
import { evaluateArrivalWithBudget, INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP } from '@rfid-attendance/shared';
import { capLateTimeoutOut, computeShiftCore, effectiveHalfDayTimeOut, manilaTimestamp } from './lunch-break.js';

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

function hasSubMillisecondFraction(iso: string): boolean {
  const fraction = /T\d{2}:\d{2}:\d{2}\.(\d+)(?:Z|[+-]\d{2}:\d{2})?$/i.exec(iso)?.[1] ?? '';
  return !/^0*$/.test(fraction.slice(3));
}

export function calculateInternPayroll(input: InternPayrollInput): InternPayrollResult {
  const actualTimeIn = manilaTimestamp(input.actualTimeIn);
  // Late time-out auto-cap (overtime forbidden): 18:00+ pays as 17:00.
  const actualTimeOut = capLateTimeoutOut(manilaTimestamp(input.actualTimeOut));
  // P4: reject inverted logs instead of silently setting worked hours to zero.
  if (actualTimeOut < actualTimeIn) throw new Error('Time-out cannot be earlier than time-in');
  const start = DateTime.fromISO(`${input.attendanceDate}T08:00:00`, { zone: timezone });
  if (!start.isValid) throw new Error('Payroll timestamps must be valid ISO values');

  const arrival = evaluateArrivalWithBudget(input.actualTimeIn, !input.graceAvailable, timezone);
  const graceUsed = arrival.arrivalStatus === 'GRACE_PERIOD';
  const clampLateIn = arrival.arrivalStatus === 'LATE' && (
    actualTimeIn.minute > 15 ||
    (actualTimeIn.minute === 15 && (
      actualTimeIn.second > 0 || actualTimeIn.millisecond > 0 || hasSubMillisecondFraction(input.actualTimeIn)
    ))
  );
  const effectiveTimeIn = clampLateIn
    ? actualTimeIn.plus({ hours: 1 }).startOf('hour')
    : actualTimeIn;
  const lateHours = arrival.arrivalStatus === 'LATE'
    ? Math.max(1, effectiveTimeIn.hour - start.hour)
    : 0;
  const lateDeduction = lateHours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP;
  const computedTimeIn = graceUsed ? start : effectiveTimeIn;
  const basePay = INTERN_DAILY_RATE_PHP;
  const hourlyRate = INTERN_DAILY_RATE_PHP / 8;
  const payableIn = graceUsed ? start : (lateHours > 0 ? computedTimeIn : (actualTimeIn < start ? start : actualTimeIn));
  const { workedHours, isHalfDay, halfDayDeduction: grossShortfall } = computeShiftCore(payableIn, actualTimeOut, actualTimeIn, hourlyRate);
  // payableIn already removes late hours; exclude those hours from undertime to avoid duplicate charging.
  const halfDayDeduction = Math.max(0, grossShortfall - lateHours * hourlyRate);
  const totalDailyDeduction = lateDeduction + halfDayDeduction;
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
    dailyPay: Math.max(0, basePay - totalDailyDeduction),
    workedHours,
  };
}
