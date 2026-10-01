import { DateTime } from 'luxon';
import { evaluateArrivalWithBudget, INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP, isNoGraceDate } from '@rfid-attendance/shared';
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

  const noGrace = isNoGraceDate(input.attendanceDate);
  // Half-day rule: an arrival at/after 12:00 renders the afternoon half of
  // the 8-hour day, so the shortfall is half-day undertime, never late hours.
  const afternoonHalfDay = actualTimeIn.hour >= 12;
  if (noGrace && actualTimeIn.toISODate() !== input.attendanceDate) {
    throw new Error('Payroll clock-in date must match attendanceDate in Manila');
  }
  const arrival = evaluateArrivalWithBudget(input.actualTimeIn, noGrace || !input.graceAvailable, timezone, input.attendanceDate);
  const graceUsed = !noGrace && arrival.arrivalStatus === 'GRACE_PERIOD';
  let effectiveTimeIn = actualTimeIn;
  let lateHours = 0;
  if (noGrace) {
    const elapsedMilliseconds = actualTimeIn.toMillis() - start.toMillis();
    const hasFractionBeyondMillisecond = hasSubMillisecondFraction(input.actualTimeIn);
    lateHours = !afternoonHalfDay && arrival.arrivalStatus === 'LATE'
      ? Math.max(1, Math.ceil(elapsedMilliseconds / 3_600_000) + (
        hasFractionBeyondMillisecond && elapsedMilliseconds % 3_600_000 === 0 ? 1 : 0
      ))
      : 0;
  } else {
    const clampLateIn = !afternoonHalfDay && arrival.arrivalStatus === 'LATE' && (
      actualTimeIn.minute > 15 ||
      (actualTimeIn.minute === 15 && (
        actualTimeIn.second > 0 || actualTimeIn.millisecond > 0 || hasSubMillisecondFraction(input.actualTimeIn)
      ))
    );
    effectiveTimeIn = clampLateIn
      ? actualTimeIn.plus({ hours: 1 }).startOf('hour')
      : actualTimeIn;
    lateHours = !afternoonHalfDay && arrival.arrivalStatus === 'LATE'
      ? Math.max(1, effectiveTimeIn.hour - start.hour)
      : 0;
  }
  const lateDeduction = lateHours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP;
  const computedTimeIn = graceUsed ? start : effectiveTimeIn;
  const basePay = INTERN_DAILY_RATE_PHP;
  const hourlyRate = INTERN_DAILY_RATE_PHP / 8;
  const payableIn = graceUsed ? start : (lateHours > 0 ? computedTimeIn : (actualTimeIn < start ? start : actualTimeIn));
  const { workedHours, isHalfDay, halfDayDeduction: grossShortfall } = computeShiftCore(payableIn, actualTimeOut, actualTimeIn, hourlyRate);
  // payableIn already removes late hours; exclude those hours from undertime to avoid duplicate charging.
  const remainingHours = Math.max(0, grossShortfall / hourlyRate - lateHours);
  const undertimeHours = Math.max(0, Math.ceil(remainingHours - 1e-9));
  const halfDayDeduction = undertimeHours * hourlyRate;
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
