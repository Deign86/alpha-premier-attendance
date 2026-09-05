import { DateTime } from 'luxon';
import { manilaTimestamp, paidWorkHoursCeiled } from './lunch-break.js';

export type EmployeePayrollInput = { actualTimeIn: string; actualTimeOut: string; dailyRate: number };
export type EmployeePayrollResult = { computedTimeIn: string; computedTimeOut: string; lateHours: number; lateDeduction: number; isHalfDay: boolean; halfDayDeduction: number; basePay: number; dailyPay: number; workedHours: number };
export function calculateEmployeePayroll(input: EmployeePayrollInput): EmployeePayrollResult {
  if (!Number.isFinite(input.dailyRate) || input.dailyRate <= 0) throw new Error('Employee daily rate must be greater than zero');
  const actualTimeIn = manilaTimestamp(input.actualTimeIn);
  const actualTimeOut = manilaTimestamp(input.actualTimeOut);
  // P4: reject inverted logs instead of silently flooring worked hours to zero.
  if (actualTimeOut < actualTimeIn) throw new Error('Time-out cannot be earlier than time-in');
  const workedHours = paidWorkHoursCeiled(actualTimeIn, actualTimeOut);
  // T6 (decision A): minute-precision office close — clock-out at exactly
  // 17:00:00 counts a full day; anything earlier is a half-day.
  const officeClose = actualTimeOut.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
  const isBeforeClose = actualTimeOut < officeClose;
  const isHalfDay = workedHours > 0 && (workedHours <= 4 || isBeforeClose);
  const halfDayDeduction = isHalfDay ? input.dailyRate / 2 : 0;

  // TODO: Employee late rules TBD by client
  return {
    computedTimeIn: ceilHour(actualTimeIn).toISO({ suppressMilliseconds: true })!,
    computedTimeOut: actualTimeOut.startOf('hour').toISO({ suppressMilliseconds: true })!,
    lateHours: 0,
    lateDeduction: 0,
    isHalfDay,
    halfDayDeduction,
    basePay: input.dailyRate,
    dailyPay: input.dailyRate - halfDayDeduction,
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
