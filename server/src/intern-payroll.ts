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
  const start = DateTime.fromISO(`${input.attendanceDate}T08:00:00`, { zone: timezone });
  if (!start.isValid) throw new Error('Payroll timestamps must be valid ISO values');

  const lateMilliseconds = actualTimeIn.toMillis() - start.toMillis();
  const lateHours = lateMilliseconds > 0 ? Math.ceil(lateMilliseconds / 3_600_000) : 0;
  const graceUsed = lateHours > 0 && input.graceAvailable;
  const lateDeduction = lateHours > 0 && !graceUsed ? lateHours * INTERN_LATE_DEDUCTION_PER_HOUR_PHP : 0;
  const computedTimeIn = lateHours > 0 && !graceUsed ? ceilHour(actualTimeIn) : actualTimeIn;
  const basePay = INTERN_DAILY_RATE_PHP;

  return {
    computedTimeIn: computedTimeIn.toISO({ suppressMilliseconds: true })!,
    computedTimeOut: actualTimeOut.toISO({ suppressMilliseconds: true })!,
    lateHours,
    lateDeduction,
    graceUsed,
    basePay,
    dailyPay: Math.max(0, basePay - lateDeduction),
    // Payable daily hours exclude the fixed 12:00–13:00 lunch break (shared rule).
    workedHours: paidWorkHoursCeiled(actualTimeIn, actualTimeOut),
  };
}

function ceilHour(value: DateTime): DateTime {
  const floor = value.startOf('hour');
  return value.equals(floor) ? floor : floor.plus({ hours: 1 });
}
