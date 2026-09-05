import type { PayrollCalculationProfile, PayrollCutoffRecord } from '@rfid-attendance/shared';

export type CutoffInput = Omit<PayrollCutoffRecord, 'payrollId' | 'employeeName' | 'basicPay' | 'specialHolidayPay' | 'regularHolidayPay' | 'totalCompensation' | 'totalAllowance' | 'halfDayDeduction' | 'absenceDeduction' | 'overtimePay' | 'totalDeductions' | 'grossCompensation' | 'netPay' | 'calculationBreakdown' | 'finalizedAt'> & {
  employeeName: string;
  halfDayFraction: number;
  lateDeduction: number;
  basicPay?: number;
  specialHolidayPay?: number;
  regularHolidayPay?: number;
  absenceDeduction?: number;
  overtimePay?: number;
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
  const baseDays = input.absentDays > 0 ? input.actualWorkingDays + input.absentDays : input.actualWorkingDays;
  const basicPay = input.basicPay != null ? cents(input.basicPay) : dailyRate * baseDays;
  const specialHolidayPay = input.specialHolidayPay != null ? cents(input.specialHolidayPay) : multiply(dailyRate * input.specialHolidayDays, input.specialHolidayMultiplier);
  const regularHolidayPay = input.regularHolidayPay != null ? cents(input.regularHolidayPay) : multiply(dailyRate * input.regularHolidayDays, input.regularHolidayMultiplier);
  const totalCompensation = basicPay + specialHolidayPay + regularHolidayPay;
  const hra = cents(input.hra ?? 0);
  const incentivesAllowance = cents(input.incentivesAllowance);
  const specialAllowance = cents(input.specialAllowance);
  // T2: zero-day cutoff proration (mirrors Rust BUG-PAY-02) — an employee who
  // worked 0 days must not receive the full flat allowance sum.
  const workedZeroDays = input.actualWorkingDays === 0 && input.standardWorkingDays > 0;
  const allowanceFactor = workedZeroDays ? Math.min(1, Math.max(0, input.actualWorkingDays / input.standardWorkingDays)) : 1;
  const totalAllowance = multiply(incentivesAllowance + specialAllowance + hra, allowanceFactor);
  const lateDeduction = cents(input.lateDeduction);
  const halfDayDeduction = multiply(dailyRate * input.halfDayCount, halfDayFraction);
  const absenceDeduction = input.absenceDeduction != null ? cents(input.absenceDeduction) : dailyRate * input.absentDays;
  const overtimePay = input.overtimePay != null ? cents(input.overtimePay) : multiply(cents(input.overtimeRate) * input.overtimeHours, 1);
  const sss = cents(input.sss ?? 0);
  const phic = cents(input.phic ?? 0);
  const hdmf = cents(input.hdmf ?? 0);
  const salaryAdvance = cents(input.salaryAdvance ?? 0);
  const manualAdjustment = cents(input.manualAdjustment);
  const totalDeductions = lateDeduction + halfDayDeduction + absenceDeduction + sss + phic + hdmf + salaryAdvance;
  // Intern payroll floors at zero for the cutoff: an intern can never owe
  // money for a period (mirrors the floor-at-zero daily intern rule). Gross
  // is floored on its own — it must never subtract deductions (review P1).
  const grossEarnings = totalCompensation + totalAllowance + overtimePay + manualAdjustment;
  const grossCompensation = input.employeeType === 'INTERN' ? Math.max(0, grossEarnings) : grossEarnings;
  const netBeforeFloor = grossEarnings - totalDeductions;
  const netPay = input.employeeType === 'INTERN' ? Math.max(0, netBeforeFloor) : netBeforeFloor;
  const record = {
    ...recordInput,
    dailyRate: pesos(dailyRate),
    basicPay: pesos(basicPay), specialHolidayPay: pesos(specialHolidayPay), regularHolidayPay: pesos(regularHolidayPay),
    hra: pesos(hra),
    incentivesAllowance: pesos(incentivesAllowance), specialAllowance: pesos(specialAllowance),
    totalCompensation: pesos(totalCompensation), totalAllowance: pesos(totalAllowance),
    lateDeduction: pesos(lateDeduction), halfDayDeduction: pesos(halfDayDeduction), absenceDeduction: pesos(absenceDeduction), overtimePay: pesos(overtimePay),
    sss: pesos(sss), phic: pesos(phic), hdmf: pesos(hdmf), salaryAdvance: pesos(salaryAdvance),
    totalDeductions: pesos(totalDeductions),
    manualAdjustment: pesos(manualAdjustment),
    grossCompensation: pesos(grossCompensation), netPay: pesos(netPay),
    calculationBreakdown: JSON.stringify({ basicPay: pesos(basicPay), specialHolidayPay: pesos(specialHolidayPay), regularHolidayPay: pesos(regularHolidayPay), totalCompensation: pesos(totalCompensation), totalAllowance: pesos(totalAllowance), overtimePay: pesos(overtimePay), manualAdjustment: pesos(manualAdjustment), totalDeductions: pesos(totalDeductions), grossCompensation: pesos(grossCompensation), netPay: pesos(netPay) }),
  };
  return record;
}

function validate(input: CutoffInput): void {
  if (!input.employeeId.trim() || !input.employeeName.trim() || !validDate(input.cutoffStart) || !validDate(input.cutoffEnd) || input.cutoffEnd < input.cutoffStart) throw new Error('Employee and valid cutoff dates are required.');
  const nonNegative = [
    input.dailyRate, input.standardWorkingDays, input.actualWorkingDays, input.specialHolidayDays, input.regularHolidayDays,
    input.hra ?? 0, input.incentivesAllowance, input.specialAllowance, input.lateUnits, input.lateDeduction,
    input.halfDayCount, input.halfDayFraction, input.absentDays, input.overtimeHours, input.overtimeRate,
    input.sss ?? 0, input.phic ?? 0, input.hdmf ?? 0, input.salaryAdvance ?? 0,
    input.manualAdjustment,
  ];
  if (input.basicPay != null) nonNegative.push(input.basicPay);
  if (input.specialHolidayPay != null) nonNegative.push(input.specialHolidayPay);
  if (input.regularHolidayPay != null) nonNegative.push(input.regularHolidayPay);
  if (input.absenceDeduction != null) nonNegative.push(input.absenceDeduction);
  if (input.overtimePay != null) nonNegative.push(input.overtimePay);
  if (nonNegative.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('Payroll values must be valid non-negative numbers.');
  if (input.actualWorkingDays > input.standardWorkingDays && !input.approvedWorkingDayOverage) throw new Error('Actual working days exceed standard days and require approval.');
  if (input.manualAdjustment !== 0 && !input.adjustmentReason?.trim()) throw new Error('A manual adjustment reason is required.');
}

function validDate(value: string): boolean {
  // P7: shape checks alone accepted Feb-30 — verify a real calendar day (stdlib only).
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
function cents(value: number): number { return Math.round(value * 100); }
function pesos(value: number): number { return Number((value / 100).toFixed(2)); }
function multiply(value: number, multiplier: number): number { return Math.round(value * multiplier); }
