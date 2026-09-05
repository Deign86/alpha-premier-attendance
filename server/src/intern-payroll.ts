import { DateTime } from 'luxon';
import { INTERN_DAILY_RATE_PHP, INTERN_LATE_DEDUCTION_PER_HOUR_PHP } from '@rfid-attendance/shared';
import { manilaTimestamp, paidWorkHoursCeiled } from './lunch-break.js';

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

export function manilaWeekStart(attendanceDate: string): string {
  const date = DateTime.fromISO(attendanceDate, { zone: timezone });
  if (!date.isValid) throw new Error('attendanceDate must be a valid Manila date');
  return date.minus({ days: date.weekday - 1 }).toISODate()!;
}

export function calculateInternPayroll(input: InternPayrollInput): InternPayrollResult {
  const actualTimeIn = manilaTimestamp(input.actualTimeIn);
  const actualTimeOut = manilaTimestamp(input.actualTimeOut);
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
  const workedHours = paidWorkHoursCeiled(actualTimeIn, actualTimeOut);
  // T6 (decision A): minute-precision office close — clock-out at exactly
  // 17:00:00 counts a full day; anything earlier is a half-day.
  const officeClose = actualTimeOut.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
  const isBeforeClose = actualTimeOut < officeClose;
  const isHalfDay = workedHours > 0 && (workedHours <= 4 || isBeforeClose);
  const halfDayDeduction = isHalfDay ? basePay / 2 : 0;

  return {
    computedTimeIn: computedTimeIn.toISO({ suppressMilliseconds: true })!,
    computedTimeOut: actualTimeOut.toISO({ suppressMilliseconds: true })!,
    lateHours,
    lateDeduction,
    isHalfDay,
    halfDayDeduction,
    graceUsed,
    basePay,
    dailyPay: Math.max(0, basePay - lateDeduction - halfDayDeduction),
    // Payable daily hours exclude the fixed 12:00–13:00 lunch break (shared rule).
    workedHours,
  };
}

function ceilHour(value: DateTime): DateTime {
  // P5: truncate sub-second residue first so 08:00:00.500 counts exact-hour.
  const truncated = value.set({ millisecond: 0 });
  const floor = truncated.startOf('hour');
  return truncated.equals(floor) ? floor : floor.plus({ hours: 1 });
}
