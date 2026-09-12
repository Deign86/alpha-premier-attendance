import { capLateTimeoutOut, ceilHour, effectiveHalfDayTimeOut, isHalfDayWork, manilaTimestamp, paidWorkHoursCeiled } from './lunch-break.js';

export type EmployeePayrollInput = { actualTimeIn: string; actualTimeOut: string; dailyRate: number };
export type EmployeePayrollResult = { computedTimeIn: string; computedTimeOut: string; lateHours: number; lateDeduction: number; isHalfDay: boolean; halfDayDeduction: number; basePay: number; dailyPay: number; workedHours: number };
export function calculateEmployeePayroll(input: EmployeePayrollInput): EmployeePayrollResult {
  if (!Number.isFinite(input.dailyRate) || input.dailyRate <= 0) throw new Error('Employee daily rate must be greater than zero');
  const actualTimeIn = manilaTimestamp(input.actualTimeIn);
  // Late time-out auto-cap (overtime forbidden): 18:00+ pays as 17:00.
  const actualTimeOut = capLateTimeoutOut(manilaTimestamp(input.actualTimeOut));
  // P4: reject inverted logs instead of silently flooring worked hours to zero.
  if (actualTimeOut < actualTimeIn) throw new Error('Time-out cannot be earlier than time-in');
  const workedHours = paidWorkHoursCeiled(actualTimeIn, actualTimeOut);
  const isHalfDay = isHalfDayWork(workedHours, actualTimeOut, actualTimeIn);
  const halfDayDeduction = isHalfDay ? input.dailyRate / 2 : 0;

  // DTR DECOUPLING: computed fields are PAYROLL-ONLY. Morning half-day
  // closed before office close pays as an effective 08:00–12:00 window even
  // though the DTR row keeps actual stamps. Never push these back to DTR.
  const halfDayNoon = effectiveHalfDayTimeOut(isHalfDay, actualTimeIn, actualTimeOut);
  const effectiveTimeOut = halfDayNoon ?? actualTimeOut.startOf('hour');

  // TODO: Employee late rules TBD by client
  return {
    computedTimeIn: ceilHour(actualTimeIn).toISO({ suppressMilliseconds: true })!,
    computedTimeOut: effectiveTimeOut.toISO({ suppressMilliseconds: true })!,
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
