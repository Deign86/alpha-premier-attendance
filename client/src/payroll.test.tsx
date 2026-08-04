import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PayrollCalculationProfile, PayrollCutoffRecord } from '@rfid-attendance/shared';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, savePayrollCutoff: vi.fn() };
});

import { savePayrollCutoff } from './api';
import { PayrollWorkspace } from './App';

const printProfiles: PayrollCalculationProfile[] = [
  { profileId: 'BEA_STANDARD', label: 'Bea standard', payrollFrequency: 'SEMI_MONTHLY', standardWorkingDaysPerCutoff: 11, incentivesAllowance: 0, specialAllowance: 0, specialHolidayMultiplier: 0.3, regularHolidayMultiplier: 1, halfDayFraction: 0.5, overtimeRate: 0 },
];

function samplePayrollRecord(overrides: Partial<PayrollCutoffRecord> = {}): PayrollCutoffRecord {
  return {
    payrollId: 'P-001', employeeId: 'EMP-001', employeeName: 'Ada Lovelace', employeeType: 'EMPLOYEE', payrollProfileId: 'BEA_STANDARD',
    payrollCutoffLabel: 'August 1-15, 2026', cutoffStart: '2026-08-01', cutoffEnd: '2026-08-15', payrollFrequency: 'SEMI_MONTHLY',
    dailyRate: 500, standardWorkingDays: 11, actualWorkingDays: 11, basicPay: 5500,
    specialHolidayDays: 0, specialHolidayMultiplier: 0.3, specialHolidayPay: 0,
    regularHolidayDays: 0, regularHolidayMultiplier: 1, regularHolidayPay: 0,
    incentivesAllowance: 0, specialAllowance: 0, totalCompensation: 5500, totalAllowance: 0,
    lateUnits: 0, lateDeduction: 0, halfDayCount: 1, halfDayDeduction: 250, absentDays: 0, absenceDeduction: 0,
    overtimeHours: 2, overtimeRate: 62.5, overtimePay: 125,
    manualAdjustment: 0, adjustmentReason: null, grossCompensation: 5375, netPay: 5375,
    signaturePlaceholder: '________________', calculationBreakdown: 'PHP 5,500.00 basic - PHP 250.00 half-day deduction = PHP 5,375.00',
    approvedWorkingDayOverage: false, status: 'FINALIZED', finalizedAt: '2026-08-15T12:00:00+08:00',
    ...overrides,
  };
}

describe('PayrollWorkspace', () => {
  it('releases the save button and shows the backend error when cutoff creation fails', async () => {
    vi.mocked(savePayrollCutoff).mockRejectedValueOnce('Employee and valid cutoff dates are required.');
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[{ userId: 'EMP-1', rfidUid: 'ABCD1234', fullName: 'Ada Lovelace', department: null, status: 'ACTIVE', employeeType: 'EMPLOYEE', dailyRate: 500, payrollProfileId: 'BEA_STANDARD', photoUrl: null }]}
        profiles={[{ profileId: 'BEA_STANDARD', label: 'Bea standard', payrollFrequency: 'SEMI_MONTHLY', standardWorkingDaysPerCutoff: 11, incentivesAllowance: 0, specialAllowance: 0, specialHolidayMultiplier: 0.3, regularHolidayMultiplier: 1, halfDayFraction: 0.5, overtimeRate: 0 }]}
        records={[]}
        onSaved={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Personnel'), 'EMP-1');
    await user.click(screen.getByRole('button', { name: /1st.*15th/i }));
    await user.click(screen.getByRole('button', { name: 'Save cutoff payroll' }));

    expect(await screen.findByText('Employee and valid cutoff dates are required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save cutoff payroll' })).toBeEnabled();
  });

  it('renders a worksheet-style printable payroll layout for saved cutoffs', () => {
    render(
      <PayrollWorkspace
        users={[]}
        profiles={printProfiles}
        records={[samplePayrollRecord(), samplePayrollRecord({ payrollId: 'P-002', employeeId: 'EMP-002', employeeName: 'Grace Hopper', status: 'DRAFT' })]}
        onSaved={vi.fn()}
      />,
    );
    expect(screen.getAllByText('Payroll Worksheet')).toHaveLength(2);
    expect(screen.getAllByAltText('Alpha Premier logo')).toHaveLength(2);
    expect(screen.getAllByText('Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila')).toHaveLength(2);
    expect(screen.getAllByText('Employee details')).toHaveLength(2);
    expect(screen.getAllByText('Earnings')).toHaveLength(2);
    expect(screen.getAllByText('Deductions')).toHaveLength(2);
    expect(screen.getAllByText('Pay summary')).toHaveLength(2);
    // Appears twice per worksheet: earnings grand-total row + pay summary cell.
    expect(screen.getAllByText('Gross compensation')).toHaveLength(4);
    // Names and amounts appear in both the on-screen register and the printable worksheet.
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('Grace Hopper').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('PHP 5,375.00').length).toBeGreaterThanOrEqual(6);
  });

  it('renders a worksheet-style printable intern payroll sheet with the fixed PHP 80/day rule', () => {
    render(
      <PayrollWorkspace
        users={[{ userId: 'INT-001', rfidUid: 'ABCD5678', fullName: 'Maria Santos', department: null, status: 'ACTIVE', employeeType: 'INTERN', dailyRate: null, payrollProfileId: null, photoUrl: null }]}
        profiles={printProfiles}
        records={[samplePayrollRecord({
          payrollId: 'P-INT-001', employeeId: 'INT-001', employeeName: 'Maria Santos', employeeType: 'INTERN',
          payrollProfileId: 'INTERN_STANDARD', dailyRate: 80, basicPay: 800, totalCompensation: 800,
          incentivesAllowance: 0, specialAllowance: 0, totalAllowance: 0, specialHolidayDays: 0, regularHolidayDays: 0,
          lateUnits: 3, lateDeduction: 30, halfDayCount: 0, halfDayDeduction: 0, absentDays: 0, absenceDeduction: 0,
          overtimeHours: 0, overtimeRate: 0, overtimePay: 0, grossCompensation: 770, netPay: 770, status: 'DRAFT',
          calculationBreakdown: 'PHP 800.00 basic - PHP 30.00 late deduction = PHP 770.00',
        })]}
        onSaved={vi.fn()}
      />,
    );

    // Intern worksheet-specific labels and fixed intern values.
    expect(screen.getAllByText('Intern Payroll Worksheet')).toHaveLength(1);
    expect(screen.getAllByAltText('Alpha Premier logo')).toHaveLength(1);
    expect(screen.getAllByText('Intern details')).toHaveLength(1);
    expect(screen.getAllByText('Counted days (days worked)')).toHaveLength(1);
    expect(screen.getAllByText('Total late hours')).toHaveLength(1);
    expect(screen.getAllByText('Maria Santos (Intern)')).toHaveLength(1);
    expect(screen.getAllByText('PHP 80.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('PHP 770.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('PHP 30.00').length).toBeGreaterThanOrEqual(2);
  });
});
