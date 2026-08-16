import { DateTime } from 'luxon';
import { manilaTimestamp, paidWorkHoursCeiled } from './lunch-break.js';

export type EmployeePayrollInput = { actualTimeIn: string; actualTimeOut: string; dailyRate: number };
export type EmployeePayrollResult = { computedTimeIn: string; computedTimeOut: string; lateHours: number; lateDeduction: number; basePay: number; dailyPay: number; workedHours: number };
export function calculateEmployeePayroll(input: EmployeePayrollInput): EmployeePayrollResult {
  if (!Number.isFinite(input.dailyRate) || input.dailyRate <= 0) throw new Error('Employee daily rate must be greater than zero');
  const actualTimeIn = manilaTimestamp(input.actualTimeIn);
  const actualTimeOut = manilaTimestamp(input.actualTimeOut);

  // TODO: Employee late rules TBD by client
  return {
    computedTimeIn: ceilHour(actualTimeIn).toISO({ suppressMilliseconds: true })!,
    computedTimeOut: actualTimeOut.startOf('hour').toISO({ suppressMilliseconds: true })!,
    lateHours: 0,
    lateDeduction: 0,
    basePay: input.dailyRate,
    dailyPay: input.dailyRate,
    // Payable daily hours exclude the fixed 12:00–13:00 lunch break (shared rule).
    workedHours: paidWorkHoursCeiled(actualTimeIn, actualTimeOut),
  };
}

function ceilHour(value: DateTime): DateTime {
  const floor = value.startOf('hour');
  return value.equals(floor) ? floor : floor.plus({ hours: 1 });
}
