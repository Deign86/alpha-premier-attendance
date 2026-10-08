import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CutoffInput } from '../src/cutoff-payroll.js';
import { calculateCutoffPayroll } from '../src/cutoff-payroll.js';
import payrollFixtures from './fixtures/ts-payroll-fixtures.json';

// T0 FREEZE (test-only): independently reviewed baseline; a snapshot mismatch
// is investigated, never blanket-updated with -u without human approval.
// Money asserts are exact (toBe), never toBeCloseTo; 1-cent divergence = revert.
const PINNED_SHA256 = '08d8d00bd22a980243770eb307d2aaf58f27e7fa582ba33d6235d695c9c180b6';

const baseInput: CutoffInput = {
  ...payrollFixtures.baseInput,
  employeeType: 'EMPLOYEE',
  payrollFrequency: 'SEMI_MONTHLY',
  status: 'DRAFT',
};

function sortedJson(value: object): string {
  return JSON.stringify(value, Object.keys(value).sort());
}

describe('T0 freeze: cutoff payroll contract', () => {
  it('pins fixture bytes after CRLF-to-LF normalization only', async () => {
    const fixtureBytes = await readFile(new URL('./fixtures/ts-payroll-fixtures.json', import.meta.url), 'utf8');
    const normalizedFixture = fixtureBytes.replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(normalizedFixture, 'utf8').digest('hex')).toBe(PINNED_SHA256);
  });

  it('rounds monetary values to cents', () => {
    const result = calculateCutoffPayroll({ ...baseInput, dailyRate: 100.005, actualWorkingDays: 1 });
    expect(result.basicPay).toBe(100.01);
    expect(result.grossCompensation).toBe(100.01);
    expect(result.netPay).toBe(100.01);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('applies half-day fraction to whole-number counts', () => {
    const result = calculateCutoffPayroll({ ...baseInput, dailyRate: 100.01, halfDayCount: 1, halfDayFraction: 0.5 });
    expect(result.halfDayDeduction).toBe(50.01);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('uses the full fractional-day count as the half-day fraction', () => {
    const result = calculateCutoffPayroll({ ...baseInput, dailyRate: 100.01, halfDayCount: 0.5, halfDayFraction: 0.5 });
    expect(result.halfDayDeduction).toBe(50.01);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('locks BUG-PAY-02 zero-day allowance proration', () => {
    const result = calculateCutoffPayroll({
      ...baseInput,
      employeeType: 'INTERN',
      dailyRate: 80,
      actualWorkingDays: 0,
      incentivesAllowance: 1000,
      specialAllowance: 100,
      hra: 200,
      absentDays: 11,
    });
    expect(result.totalAllowance).toBe(0);
    expect(result.grossCompensation).toBe(880);
    expect(result.netPay).toBe(0);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('floors intern gross and net at zero', () => {
    const result = calculateCutoffPayroll({ ...baseInput, employeeType: 'INTERN', dailyRate: 0, actualWorkingDays: 0, lateUnits: 1 });
    expect(result.grossCompensation).toBe(0);
    expect(result.netPay).toBe(0);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('applies special and regular holiday multipliers', () => {
    const result = calculateCutoffPayroll({ ...baseInput, dailyRate: 100, actualWorkingDays: 0, specialHolidayDays: 1, specialHolidayMultiplier: 0.3, regularHolidayDays: 1, regularHolidayMultiplier: 1 });
    expect(result.specialHolidayPay).toBe(30);
    expect(result.regularHolidayPay).toBe(100);
    expect(result.grossCompensation).toBe(130);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('includes manual adjustment in gross and net', () => {
    const result = calculateCutoffPayroll({ ...baseInput, manualAdjustment: 12.34, adjustmentReason: 'Fixture adjustment' });
    expect(result.manualAdjustment).toBe(12.34);
    expect(result.grossCompensation).toBe(112.34);
    expect(result.netPay).toBe(112.34);
    expect(sortedJson({
      basicPay: result.basicPay,
      specialHolidayPay: result.specialHolidayPay,
      regularHolidayPay: result.regularHolidayPay,
      totalCompensation: result.totalCompensation,
      hra: result.hra,
      incentivesAllowance: result.incentivesAllowance,
      specialAllowance: result.specialAllowance,
      totalAllowance: result.totalAllowance,
      lateDeduction: result.lateDeduction,
      halfDayDeduction: result.halfDayDeduction,
      absenceDeduction: result.absenceDeduction,
      overtimePay: result.overtimePay,
      sss: result.sss,
      phic: result.phic,
      hdmf: result.hdmf,
      salaryAdvance: result.salaryAdvance,
      totalDeductions: result.totalDeductions,
      manualAdjustment: result.manualAdjustment,
      grossCompensation: result.grossCompensation,
      netPay: result.netPay,
    })).toMatchSnapshot();
  });

  it('rejects invalid calendar date', () => {
    expect(() => calculateCutoffPayroll({ ...baseInput, cutoffStart: '2026-02-30' })).toThrow('valid cutoff dates');
  });

  it('rejects negative payroll values', () => {
    expect(() => calculateCutoffPayroll({ ...baseInput, dailyRate: -1 })).toThrow('Payroll values');
  });

  it('requires approval for working-day overage', () => {
    expect(() => calculateCutoffPayroll({ ...baseInput, actualWorkingDays: 12 })).toThrow('approval');
  });

  it('requires a reason for manual adjustment', () => {
    expect(() => calculateCutoffPayroll({ ...baseInput, manualAdjustment: 1 })).toThrow('manual adjustment reason');
  });
});
