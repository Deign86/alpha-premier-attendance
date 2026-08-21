import { describe, expect, it } from 'vitest';
import { calculateCutoffPayroll } from '../src/cutoff-payroll.js';

const jeanInput = {
  employeeId: 'APGCO-0013', employeeName: 'CHICO, JEAN ASHLEY', employeeType: 'EMPLOYEE' as const, payrollProfileId: 'JEAN_TENURED', payrollCutoffLabel: 'July 1-15, 2026', cutoffStart: '2026-07-01', cutoffEnd: '2026-07-15', payrollFrequency: 'SEMI_MONTHLY' as const,
  dailyRate: 705, standardWorkingDays: 11, actualWorkingDays: 11, specialHolidayDays: 1, specialHolidayMultiplier: 0.3, regularHolidayDays: 0, regularHolidayMultiplier: 1,
  incentivesAllowance: 6600, specialAllowance: 150, lateUnits: 0, lateDeduction: 0, halfDayCount: 0, halfDayFraction: 0.5, absentDays: 0, overtimeHours: 0, overtimeRate: 0, manualAdjustment: 0, adjustmentReason: null,
  signaturePlaceholder: '', approvedWorkingDayOverage: false, status: 'DRAFT' as const,
};

describe('cutoff payroll calculator', () => {
  it('calculates the Jean July 1-15 sample without a manual adjustment', () => {
    const result = calculateCutoffPayroll(jeanInput);
    expect(result.basicPay).toBe(7755);
    expect(result.specialHolidayPay).toBe(211.5);
    expect(result.regularHolidayPay).toBe(0);
    expect(result.totalCompensation).toBe(7966.5);
    expect(result.totalAllowance).toBe(6750);
    expect(result.grossCompensation).toBe(14716.5);
    expect(result.netPay).toBe(14716.5);
  });

  it('includes an explicit legacy manual adjustment in gross compensation', () => {
    const result = calculateCutoffPayroll({ ...jeanInput, manualAdjustment: 1500, adjustmentReason: 'Legacy payroll adjustment / needs verification' });
    expect(result.grossCompensation).toBe(16216.5);
    expect(result.calculationBreakdown).toContain('1500');
  });

  it('requires a reason for a manual adjustment and approval for day overage', () => {
    expect(() => calculateCutoffPayroll({ ...jeanInput, manualAdjustment: 1 })).toThrow('reason');
    expect(() => calculateCutoffPayroll({ ...jeanInput, actualWorkingDays: 12 })).toThrow('require approval');
  });

  it('subtracts a fillable employee late deduction from gross and net pay', () => {
    const result = calculateCutoffPayroll({ ...jeanInput, lateUnits: 5, lateDeduction: 250 });
    // Total compensation 7966.5 + allowances 6750 = 14716.5, minus 250 late deduction.
    expect(result).toMatchObject({ lateUnits: 5, lateDeduction: 250, grossCompensation: 14716.5, totalDeductions: 250, netPay: 14466.5 });
  });

  it('computes intern cutoffs at PHP 80/day with PHP 10/hour late deduction and floors at zero', () => {
    const internInput = {
      ...jeanInput,
      employeeId: 'INT-001', employeeName: 'Maria Santos', employeeType: 'INTERN' as const, payrollProfileId: 'INTERN_STANDARD',
      dailyRate: 80, standardWorkingDays: 11, actualWorkingDays: 10,
      specialHolidayDays: 0, specialHolidayMultiplier: 0, regularHolidayDays: 0, regularHolidayMultiplier: 0,
      incentivesAllowance: 0, specialAllowance: 0, lateUnits: 3, lateDeduction: 30,
      halfDayCount: 0, halfDayFraction: 0, absentDays: 0, overtimeHours: 0, overtimeRate: 0,
    };
    const result = calculateCutoffPayroll(internInput);
    expect(result).toMatchObject({ dailyRate: 80, basicPay: 800, totalCompensation: 800, totalAllowance: 0, lateUnits: 3, lateDeduction: 30, grossCompensation: 800, totalDeductions: 30, netPay: 770, employeeType: 'INTERN' });
    // An intern can never owe money for a cutoff (floor at zero).
    const zeroed = calculateCutoffPayroll({ ...internInput, actualWorkingDays: 0, lateUnits: 9, lateDeduction: 90 });
    expect(zeroed.grossCompensation).toBe(0);
    expect(zeroed.netPay).toBe(0);
  });

  it('computes partial intern cutoff with 1 day actual attendance and 10 absent days correctly', () => {
    const partialInternInput = {
      ...jeanInput,
      employeeId: 'APG-2026-102', employeeName: 'Deign Grey O. Lazaro', employeeType: 'INTERN' as const, payrollProfileId: 'INTERN_STANDARD',
      dailyRate: 80, standardWorkingDays: 11, actualWorkingDays: 1,
      specialHolidayDays: 0, specialHolidayMultiplier: 0, regularHolidayDays: 0, regularHolidayMultiplier: 0,
      incentivesAllowance: 0, specialAllowance: 0, lateUnits: 0, lateDeduction: 0,
      halfDayCount: 0, halfDayFraction: 0, absentDays: 10, overtimeHours: 0, overtimeRate: 0,
    };
    const result = calculateCutoffPayroll(partialInternInput);
    expect(result).toMatchObject({
      dailyRate: 80,
      basicPay: 880,
      totalCompensation: 880,
      absenceDeduction: 800,
      totalDeductions: 800,
      grossCompensation: 880,
      netPay: 80,
      employeeType: 'INTERN',
    });
  });

  it('computes employee cutoff with all editable earnings and statutory deductions', () => {
    const editableInput = {
      ...jeanInput,
      basicPay: 7755,
      hra: 500,
      incentivesAllowance: 6600,
      specialAllowance: 150,
      specialHolidayPay: 211.5,
      overtimePay: 200,
      lateDeduction: 100,
      sss: 450,
      phic: 200,
      hdmf: 100,
      salaryAdvance: 1000,
    };
    const result = calculateCutoffPayroll(editableInput);
    expect(result.basicPay).toBe(7755);
    expect(result.hra).toBe(500);
    expect(result.totalAllowance).toBe(7250);
    expect(result.specialHolidayPay).toBe(211.5);
    expect(result.overtimePay).toBe(200);
    expect(result.grossCompensation).toBe(15416.5);
    expect(result.totalDeductions).toBe(1850);
    expect(result.netPay).toBe(13566.5);
  });
});
