import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import fixtures from '../../shared/arrival-fixtures.json';
import { AttendanceTable } from './live-attendance';

/**
 * The client half of the boundary pin. `shared/arrival-fixtures.json` holds attendance rows as the desktop payroll
 * engine answers them (src-tauri pins that in `arrival_fields_match_the_fixture_the_client_renders`); here each
 * `expected` object is shown as it arrives. The client computes nothing: a clamped row is one whose payable time-in
 * differs from its scan.
 */
describe('attendance rows are shown as the payroll engine answered them', () => {
  const rows = fixtures.rows.map((row, index) => ({
    attendanceId: `fixture-${index}`,
    attendanceDate: row.input.attendanceDate,
    userId: `APG-2026-${index}`,
    fullName: row.name,
    department: null,
    timeIn: row.input.timeIn,
    timeOut: null,
    status: 'WORKING' as const,
    // SAFETY: The fixture holds only the three statuses the engine answers; the Rust test pins them
    arrivalStatus: row.expected.arrivalStatus as 'ON_TIME' | 'GRACE_PERIOD' | 'LATE',
    minutesLate: row.expected.minutesLate,
    graceUsed: row.expected.graceUsed,
    payableTimeIn: row.expected.payableTimeIn,
  }));

  it.each(fixtures.rows.map((row) => [row.name, row] as const))('%s', (name, row) => {
    render(<AttendanceTable rows={rows} timezone="Asia/Manila" showPayable order="oldest" onToggleOrder={() => undefined} />);
    const line = screen.getByText(name).closest('tr');
    if (!line) throw new Error('row not in the table');
    const chip = within(line).queryByTestId('clamped-time-in');
    expect(chip !== null).toBe(row.shown.clamped);
    expect(within(line).getByText(row.shown.timeIn)).toBeInTheDocument();
    if (chip) expect(chip).toHaveTextContent(row.shown.timeIn);
  });

  it('shows the scan, not the payable time, to a viewer without an admin session', () => {
    render(<AttendanceTable rows={rows} timezone="Asia/Manila" order="oldest" onToggleOrder={() => undefined} />);
    expect(screen.queryByTestId('clamped-time-in')).not.toBeInTheDocument();
  });
});
