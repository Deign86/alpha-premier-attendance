import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return { ...actual, savePayrollCutoff: vi.fn() };
});

import { savePayrollCutoff } from './api';
import { PayrollWorkspace } from './App';

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

    await user.selectOptions(screen.getByLabelText('Employee'), 'EMP-1');
    await user.click(screen.getByRole('button', { name: /1st.*15th/i }));
    await user.click(screen.getByRole('button', { name: 'Save cutoff payroll' }));

    expect(await screen.findByText('Employee and valid cutoff dates are required.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save cutoff payroll' })).toBeEnabled();
  });
});
