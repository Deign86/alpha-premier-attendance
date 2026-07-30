import { DateTime } from 'luxon';

export type EmployeePayrollInput = { actualTimeIn: string; actualTimeOut: string; dailyRate: number };
export type EmployeePayrollResult = { computedTimeIn: string; computedTimeOut: string; lateHours: number; lateDeduction: number; basePay: number; dailyPay: number };

const timezone = 'Asia/Manila';

export function calculateEmployeePayroll(input: EmployeePayrollInput): EmployeePayrollResult {
  if (!Number.isFinite(input.dailyRate) || input.dailyRate <= 0) throw new Error('Employee daily rate must be greater than zero');
  const actualTimeIn = DateTime.fromISO(input.actualTimeIn, { setZone: true }).setZone(timezone);
  const actualTimeOut = DateTime.fromISO(input.actualTimeOut, { setZone: true }).setZone(timezone);
  if (!actualTimeIn.isValid || !actualTimeOut.isValid) throw new Error('Payroll timestamps must be valid ISO values');

  // TODO: Employee late rules TBD by client
  return {
    computedTimeIn: ceilHour(actualTimeIn).toISO({ suppressMilliseconds: true })!,
    computedTimeOut: actualTimeOut.startOf('hour').toISO({ suppressMilliseconds: true })!,
    lateHours: 0,
    lateDeduction: 0,
    basePay: input.dailyRate,
    dailyPay: input.dailyRate,
  };
}

function ceilHour(value: DateTime): DateTime {
  const floor = value.startOf('hour');
  return value.equals(floor) ? floor : floor.plus({ hours: 1 });
}
