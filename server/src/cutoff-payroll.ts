import type { PayrollCalculationProfile, PayrollCutoffRecord } from '@rfid-attendance/shared';

export type CutoffInput = Omit<PayrollCutoffRecord, 'payrollId' | 'employeeName' | 'basicPay' | 'specialHolidayPay' | 'regularHolidayPay' | 'totalCompensation' | 'totalAllowance' | 'lateDeduction' | 'halfDayDeduction' | 'absenceDeduction' | 'overtimePay' | 'grossCompensation' | 'netPay' | 'calculationBreakdown' | 'finalizedAt'> & {
  employeeName: string;
  halfDayFraction: number;
  lateDeduction: number;
};

export const defaultPayrollProfiles: PayrollCalculationProfile[] = [
  {
    profileId: 'JEAN_TENURED', label: "Ma'am Jean payroll calculation", payrollFrequency: 'SEMI_MONTHLY', standardWorkingDaysPerCutoff: 11,
    incentivesAllowance: 6600, specialAllowance: 150, specialHolidayMultiplier: 0.3, regularHolidayMultiplier: 1, halfDayFraction: 0.5, overtimeRate: 0,
  },
  {
    profileId: 'BEA_STANDARD', label: "Ma'am Bea payroll calculation", payrollFrequency: 'SEMI_MONTHLY', standardWorkingDaysPerCutoff: 11,
    incentivesAllowance: 0, specialAllowance: 0, specialHolidayMultiplier: 0.3, regularHolidayMultiplier: 1, halfDayFraction: 0.5, overtimeRate: 0,
  },
];

export function calculateCutoffPayroll(input: CutoffInput): Omit<PayrollCutoffRecord, 'payrollId' | 'finalizedAt'> {
  validate(input);
  const { halfDayFraction, ...recordInput } = input;
  const dailyRate = cents(input.dailyRate);
  const basicPay = dailyRate * input.actualWorkingDays;
  const specialHolidayPay = multiply(dailyRate * input.specialHolidayDays, input.specialHolidayMultiplier);
  const regularHolidayPay = multiply(dailyRate * input.regularHolidayDays, input.regularHolidayMultiplier);
  const totalCompensation = basicPay + specialHolidayPay + regularHolidayPay;
  const incentivesAllowance = cents(input.incentivesAllowance);
  const specialAllowance = cents(input.specialAllowance);
  const totalAllowance = incentivesAllowance + specialAllowance;
  const lateDeduction = cents(input.lateDeduction);
  const halfDayDeduction = multiply(dailyRate * input.halfDayCount, halfDayFraction);
  const absenceDeduction = dailyRate * input.absentDays;
  const overtimePay = multiply(cents(input.overtimeRate) * input.overtimeHours, 1);
  const manualAdjustment = cents(input.manualAdjustment);
  const deductions = lateDeduction + halfDayDeduction + absenceDeduction;
  const grossCompensation = totalCompensation + totalAllowance + overtimePay + manualAdjustment - deductions;
  const record = {
    ...recordInput,
    dailyRate: pesos(dailyRate),
    basicPay: pesos(basicPay), specialHolidayPay: pesos(specialHolidayPay), regularHolidayPay: pesos(regularHolidayPay),
    incentivesAllowance: pesos(incentivesAllowance), specialAllowance: pesos(specialAllowance),
    totalCompensation: pesos(totalCompensation), totalAllowance: pesos(totalAllowance),
    lateDeduction: pesos(lateDeduction), halfDayDeduction: pesos(halfDayDeduction), absenceDeduction: pesos(absenceDeduction), overtimePay: pesos(overtimePay), manualAdjustment: pesos(manualAdjustment),
    grossCompensation: pesos(grossCompensation), netPay: pesos(grossCompensation),
    calculationBreakdown: JSON.stringify({ basicPay: pesos(basicPay), specialHolidayPay: pesos(specialHolidayPay), regularHolidayPay: pesos(regularHolidayPay), totalCompensation: pesos(totalCompensation), totalAllowance: pesos(totalAllowance), overtimePay: pesos(overtimePay), manualAdjustment: pesos(manualAdjustment), deductions: pesos(deductions), grossCompensation: pesos(grossCompensation) }),
  };
  return record;
}

function validate(input: CutoffInput): void {
  if (!input.employeeId.trim() || !input.employeeName.trim() || !validDate(input.cutoffStart) || !validDate(input.cutoffEnd) || input.cutoffEnd < input.cutoffStart) throw new Error('Employee and valid cutoff dates are required.');
  const nonNegative = [input.dailyRate, input.standardWorkingDays, input.actualWorkingDays, input.specialHolidayDays, input.regularHolidayDays, input.incentivesAllowance, input.specialAllowance, input.lateUnits, input.lateDeduction, input.halfDayCount, input.halfDayFraction, input.absentDays, input.overtimeHours, input.overtimeRate, input.manualAdjustment];
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Payroll values must be valid non-negative numbers.');
  if (input.actualWorkingDays > input.standardWorkingDays && !input.approvedWorkingDayOverage) throw new Error('Actual working days exceed standard days and require approval.');
  if (input.manualAdjustment !== 0 && !input.adjustmentReason?.trim()) throw new Error('A manual adjustment reason is required.');
}

function validDate(value: string): boolean { return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()); }
function cents(value: number): number { return Math.round(value * 100); }
function pesos(value: number): number { return Number((value / 100).toFixed(2)); }
function multiply(value: number, multiplier: number): number { return Math.round(value * multiplier); }
