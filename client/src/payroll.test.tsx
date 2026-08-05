import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => { window.print = vi.fn(); });

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

  it('renders a worksheet-style printable payroll layout for saved cutoffs via the employee print action', async () => {
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[]}
        profiles={printProfiles}
        records={[samplePayrollRecord(), samplePayrollRecord({ payrollId: 'P-002', employeeId: 'EMP-002', employeeName: 'Grace Hopper', status: 'DRAFT' })]}
        onSaved={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Print Employee Payroll' }));
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

  it('renders a worksheet-style printable intern payroll sheet with the fixed PHP 80/day rule via the intern print action', async () => {
    const user = userEvent.setup();
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

    await user.click(screen.getByRole('button', { name: 'Print Intern Payroll' }));

    // Intern worksheet-specific labels and fixed intern values.
    expect(screen.getAllByText('Intern Payroll Worksheet')).toHaveLength(1);
    expect(screen.getAllByAltText('Alpha Premier logo')).toHaveLength(1);
    expect(screen.getAllByText('Intern details')).toHaveLength(1);
    expect(screen.getAllByText('Counted days (days worked)')).toHaveLength(1);
    expect(screen.getAllByText('Total late hours').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Maria Santos (Intern)')).toHaveLength(1);
    expect(screen.getAllByText('PHP 80.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('PHP 770.00').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText('PHP 30.00').length).toBeGreaterThanOrEqual(2);
    // Simplified intern payslip: total earnings plus late, half-day, and absence deduction lines.
    expect(screen.getAllByText('Total earnings').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/Half-day — 0 half-day\(s\)/)).toHaveLength(1);
    expect(screen.getAllByText(/Absence — 0 absent day\(s\)/)).toHaveLength(1);
    // Employee-only compensation fields must never appear on the intern format.
    expect(screen.queryByText('Special holiday pay')).not.toBeInTheDocument();
    expect(screen.queryByText('Regular holiday pay')).not.toBeInTheDocument();
    expect(screen.queryByText('Incentives allowance')).not.toBeInTheDocument();
    expect(screen.queryByText('Special allowance')).not.toBeInTheDocument();
    expect(screen.queryByText('Overtime pay')).not.toBeInTheDocument();
    expect(screen.queryByText('Employee details')).not.toBeInTheDocument();
  });

  it('provides a fillable late-deduction form for employees and computes the deduction from hours × rate', async () => {
    vi.mocked(savePayrollCutoff).mockResolvedValueOnce({ success: true } as never);
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[{ userId: 'EMP-1', rfidUid: 'ABCD1234', fullName: 'Ada Lovelace', department: null, status: 'ACTIVE', employeeType: 'EMPLOYEE', dailyRate: 500, payrollProfileId: 'BEA_STANDARD', photoUrl: null }]}
        profiles={printProfiles}
        records={[]}
        onSaved={vi.fn()}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Personnel'), 'EMP-1');
    await user.click(screen.getByRole('button', { name: /1st.*15th/i }));

    const hours = screen.getByLabelText('Total late hours');
    const rate = screen.getByLabelText('Late deduction rate (PHP/hr)');
    const deduction = screen.getByLabelText(/Late deduction \(PHP\)/);

    await user.clear(hours);
    await user.type(hours, '5');
    await user.clear(rate);
    await user.type(rate, '50');
    expect(deduction).toHaveValue(250);

    await user.click(screen.getByRole('button', { name: 'Save cutoff payroll' }));
    expect(savePayrollCutoff).toHaveBeenCalledWith(
      expect.objectContaining({ employeeId: 'EMP-1', lateUnits: 5, lateDeductionRate: 50, lateDeduction: 250 }),
    );
  });

  it('renders the employee worksheet with late hours and a per-hour rate', async () => {
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[]}
        profiles={printProfiles}
        records={[samplePayrollRecord({ lateUnits: 5, lateDeduction: 250 })]}
        onSaved={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Print Employee Payroll' }));
    expect(screen.getAllByText(/5 hour\(s\) at PHP 50\.00 per hour/)).toHaveLength(1);
  });

  it('renders the stored calculation-breakdown JSON as readable remarks instead of raw JSON', async () => {
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[]}
        profiles={printProfiles}
        records={[samplePayrollRecord({
          calculationBreakdown: JSON.stringify({ basicPayCentavos: 550000, totalCompensationCentavos: 550000, totalAllowanceCentavos: 0, lateDeductionCentavos: 0, halfDayDeductionCentavos: 25000, absenceDeductionCentavos: 0, overtimePayCentavos: 0, grossCompensationCentavos: 525000 }),
        })]}
        onSaved={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Print Employee Payroll' }));
    // Native backend stores centavo values; remarks must show readable pesos, not raw JSON.
    expect(screen.getByText(/Basic pay PHP 5,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Half-day deduction PHP 250\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Gross compensation PHP 5,250\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/basicPayCentavos/)).not.toBeInTheDocument();
  });

  it('formats HTTP-service peso breakdown JSON in worksheet remarks', async () => {
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[]}
        profiles={printProfiles}
        records={[samplePayrollRecord({
          calculationBreakdown: JSON.stringify({ basicPay: 5500, specialHolidayPay: 0, regularHolidayPay: 0, totalCompensation: 5500, totalAllowance: 0, overtimePay: 0, manualAdjustment: 0, deductions: 250, grossCompensation: 5250 }),
        })]}
        onSaved={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Print Employee Payroll' }));
    expect(screen.getByText(/Basic pay PHP 5,500\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Deductions PHP 250\.00/)).toBeInTheDocument();
    expect(screen.getByText(/Gross compensation PHP 5,250\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/"basicPay":/)).not.toBeInTheDocument();
  });

  it('provides separate print actions that render only the matching payroll template', async () => {
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[]}
        profiles={printProfiles}
        records={[
          samplePayrollRecord(),
          samplePayrollRecord({
            payrollId: 'P-INT-001', employeeId: 'INT-001', employeeName: 'Maria Santos', employeeType: 'INTERN',
            payrollProfileId: 'INTERN_STANDARD', dailyRate: 80, basicPay: 800, totalCompensation: 800,
            incentivesAllowance: 0, specialAllowance: 0, totalAllowance: 0, specialHolidayDays: 0, regularHolidayDays: 0,
            lateUnits: 3, lateDeduction: 30, halfDayCount: 0, halfDayDeduction: 0, absentDays: 0, absenceDeduction: 0,
            overtimeHours: 0, overtimeRate: 0, overtimePay: 0, grossCompensation: 770, netPay: 770, status: 'DRAFT',
            calculationBreakdown: 'PHP 800.00 basic - PHP 30.00 late deduction = PHP 770.00',
          }),
        ]}
        onSaved={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Print Intern Payroll' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print Employee Payroll' })).toBeInTheDocument();
    // No template is loaded until a print action is chosen.
    expect(screen.queryByText('Payroll Worksheet')).not.toBeInTheDocument();
    expect(screen.queryByText('Intern Payroll Worksheet')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Print Employee Payroll' }));
    expect(screen.getAllByText('Payroll Worksheet')).toHaveLength(1);
    expect(screen.getAllByText('Ada Lovelace').length).toBeGreaterThanOrEqual(2);
    // Interns are never printed on the employee template.
    expect(screen.queryByText('Intern Payroll Worksheet')).not.toBeInTheDocument();
    expect(screen.queryByText('Intern details')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Print Intern Payroll' }));
    expect(screen.getAllByText('Intern Payroll Worksheet')).toHaveLength(1);
    expect(screen.getAllByText('Maria Santos (Intern)')).toHaveLength(1);
    expect(screen.getAllByText('Maria Santos').length).toBeGreaterThanOrEqual(1);
    // Employees are never printed on the intern template.
    expect(screen.queryByText('Payroll Worksheet')).not.toBeInTheDocument();
    expect(screen.queryByText('Employee details')).not.toBeInTheDocument();
  });

  it('shows a message instead of opening the print dialog when the selected payroll type has no records', async () => {
    const user = userEvent.setup();
    render(
      <PayrollWorkspace
        users={[]}
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

    await user.click(screen.getByRole('button', { name: 'Print Employee Payroll' }));
    expect(screen.getByText(/No employee payroll records to print/)).toBeInTheDocument();
    expect(screen.queryByText('Payroll Worksheet')).not.toBeInTheDocument();
    expect(window.print).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Print Intern Payroll' }));
    expect(screen.getAllByText('Intern Payroll Worksheet')).toHaveLength(1);
  });
});
