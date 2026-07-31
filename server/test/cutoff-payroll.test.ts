import { describe, expect, it } from 'vitest';
import { calculateCutoffPayroll } from '../src/cutoff-payroll.js';

const jeanInput = {
  employeeId: 'APGCO-0013', employeeName: 'CHICO, JEAN ASHLEY', payrollProfileId: 'JEAN_TENURED', payrollCutoffLabel: 'July 1-15, 2026', cutoffStart: '2026-07-01', cutoffEnd: '2026-07-15', payrollFrequency: 'SEMI_MONTHLY' as const,
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
});
