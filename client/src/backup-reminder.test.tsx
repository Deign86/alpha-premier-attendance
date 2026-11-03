import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AttendanceListItem, DatabaseBackupInfo, DatabaseInfoResponse } from '@rfid-attendance/shared';
import { createBackupNow, FridayBackupReminder, fridayBackupDue } from './backup-reminder';
import { DatabasePanel } from './App';
import { Toasts } from './toasts';
import * as api from './api';

const REMINDER = "It's Friday and everyone has timed out. Save this week's backup.";
// Fri Oct 30, 2026, 6:30 PM in Manila.
const FRIDAY_EVENING = new Date('2026-10-30T18:30:00+08:00');
const friday = () => FRIDAY_EVENING;
const interns: { userId: string; employeeType: 'INTERN' | 'EMPLOYEE' }[] = [
  { userId: 'APG-2026-001', employeeType: 'INTERN' },
  { userId: 'APG-2026-002', employeeType: 'INTERN' },
];

function row(userId: string, timeOut: string | null): AttendanceListItem {
  return {
    attendanceId: `${userId}-1030`,
    attendanceDate: '2026-10-30',
    timeIn: '2026-10-30T09:00:00+08:00',
    timeOut,
    status: timeOut ? 'COMPLETED' : 'WORKING',
    userId,
    fullName: 'Juan Dela Cruz',
    department: 'Sales',
  };
}
// The last intern leaves at 6:05 PM.
const allOut = [row('APG-2026-001', '2026-10-30T18:01:00+08:00'), row('APG-2026-002', '2026-10-30T18:05:00+08:00')];
const oneStillIn = [row('APG-2026-001', '2026-10-30T18:01:00+08:00'), row('APG-2026-002', null)];

function backup(modifiedAt: string): DatabaseBackupInfo {
  return { fileName: `attendance-backup-${modifiedAt}.apbackup`, filePath: `C:\\backups\\${modifiedAt}.apbackup`, sizeBytes: 1024, modifiedAt };
}
const yesterdaysBackup = [backup('2026-10-29T08:05:00+08:00')];
// Made at 8:00 AM Friday (by hand or when the app closed): before the day's work, so it doesn't count.
const morningBackup = [backup('2026-10-30T08:00:00+08:00')];
// Made at 6:10 PM Friday, after the last intern left: it covers the week.
const eveningBackup = [backup('2026-10-30T18:10:00+08:00')];

function dbInfo(backups: DatabaseBackupInfo[]): DatabaseInfoResponse {
  return {
    success: true,
    dbPath: 'C:\\data\\attendance.db',
    dataDir: 'C:\\data',
    backupDir: 'C:\\data\\backups',
    isPortableMode: false,
    restorePending: false,
    restoreSourcePath: null,
    backups,
    lastBackupAt: backups[0]?.modifiedAt ?? null,
  };
}

const createdBackup = (fileName: string) => ({
  success: true as const,
  filePath: `C:\\data\\backups\\${fileName}`,
  directoryPath: 'C:\\data\\backups',
  fileName,
  fileKind: 'backup' as const,
  isPortableMode: false,
});

describe('fridayBackupDue', () => {
  it('is due on a Manila Friday once every intern who came in has timed out and no backup was made since', () => {
    expect(fridayBackupDue(FRIDAY_EVENING, allOut, interns, yesterdaysBackup)).toBe(true);
    // No backups at all, or only one from before the last time-out (a morning or automatic backup), still asks.
    expect(fridayBackupDue(FRIDAY_EVENING, allOut, interns, [])).toBe(true);
    expect(fridayBackupDue(FRIDAY_EVENING, allOut, interns, morningBackup)).toBe(true);
  });

  it('is not due when any one rule fails', () => {
    // Not Friday in Manila: Thursday evening, and Fri 4:30 PM UTC, which is already Sat 12:30 AM in Manila.
    expect(fridayBackupDue(new Date('2026-10-29T18:30:00+08:00'), allOut, interns, yesterdaysBackup)).toBe(false);
    expect(fridayBackupDue(new Date('2026-10-30T16:30:00Z'), allOut, interns, yesterdaysBackup)).toBe(false);
    // An intern is still timed in.
    expect(fridayBackupDue(FRIDAY_EVENING, oneStillIn, interns, yesterdaysBackup)).toBe(false);
    // Nobody timed in today, or only people who are not interns did.
    expect(fridayBackupDue(FRIDAY_EVENING, [], interns, yesterdaysBackup)).toBe(false);
    expect(fridayBackupDue(FRIDAY_EVENING, allOut, [{ userId: 'APG-2026-001', employeeType: 'EMPLOYEE' }], yesterdaysBackup)).toBe(false);
    // A backup was made after the last intern left.
    expect(fridayBackupDue(FRIDAY_EVENING, allOut, interns, eveningBackup)).toBe(false);
  });

  it('reads Friday on Manila time, even when it is still Thursday in UTC', () => {
    // Fri 12:30 AM in Manila is Thu 4:30 PM UTC; last night's time-outs count for that Friday's rows.
    const earlyRows = [row('APG-2026-001', '2026-10-30T00:10:00+08:00')];
    expect(fridayBackupDue(new Date('2026-10-30T00:30:00+08:00'), earlyRows, interns, yesterdaysBackup)).toBe(true);
  });
});

describe('FridayBackupReminder', () => {
  let attendanceSpy: MockInstance;
  let infoSpy: MockInstance;
  let backupSpy: MockInstance;

  beforeEach(() => {
    window.localStorage.clear();
    attendanceSpy = vi.spyOn(api, 'loadAdminAttendance').mockResolvedValue({ success: true, date: '2026-10-30', attendance: allOut, fetchedAt: '2026-10-30T18:30:00+08:00' });
    infoSpy = vi.spyOn(api, 'loadDatabaseInfo').mockResolvedValue(dbInfo(yesterdaysBackup));
    backupSpy = vi.spyOn(api, 'createDatabaseBackup');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows under the header when every rule holds, reading the backups first and then today's attendance", async () => {
    render(<FridayBackupReminder users={interns} now={friday} />);

    expect(await screen.findByText(REMINDER)).toBeInTheDocument();
    expect(attendanceSpy).toHaveBeenCalledWith('2026-10-30');
    expect(infoSpy.mock.invocationCallOrder[0]).toBeLessThan(attendanceSpy.mock.invocationCallOrder[0]);
    expect(screen.getByRole('button', { name: 'Create backup now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Later' })).toBeInTheDocument();
  });

  it('still asks after a morning backup, and a backup made after the last time-out hides it', async () => {
    infoSpy.mockResolvedValue(dbInfo(morningBackup));
    const { unmount } = render(<FridayBackupReminder users={interns} now={friday} />);
    expect(await screen.findByText(REMINDER)).toBeInTheDocument();
    unmount();

    infoSpy.mockResolvedValue(dbInfo(eveningBackup));
    render(<FridayBackupReminder users={interns} now={friday} />);
    await waitFor(() => expect(attendanceSpy).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it('stays hidden while an intern is still timed in', async () => {
    attendanceSpy.mockResolvedValue({ success: true, date: '2026-10-30', attendance: oneStillIn, fetchedAt: '' });
    render(<FridayBackupReminder users={interns} now={friday} />);
    await waitFor(() => expect(attendanceSpy).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it("stops before today's attendance when the backups cannot be read (a web browser)", async () => {
    infoSpy.mockResolvedValue({ success: false, error: { message: 'Database tools are available in the desktop application.' } });
    render(<FridayBackupReminder users={interns} now={friday} />);
    await waitFor(() => expect(infoSpy).toHaveBeenCalled());
    await act(async () => {});
    expect(attendanceSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it('asks the server nothing on other days', async () => {
    render(<FridayBackupReminder users={interns} now={() => new Date('2026-10-29T18:30:00+08:00')} />);
    await act(async () => {});
    expect(attendanceSpy).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it('checks again every five minutes, so it appears once the last intern times out', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    attendanceSpy.mockResolvedValueOnce({ success: true, date: '2026-10-30', attendance: oneStillIn, fetchedAt: '' });
    render(<FridayBackupReminder users={interns} now={friday} />);
    // waitFor polls with setInterval, which is faked here: let the two loads settle on real timeouts instead.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(attendanceSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(attendanceSpy).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(await screen.findByText(REMINDER)).toBeInTheDocument();
    expect(attendanceSpy).toHaveBeenCalledTimes(2);
  });

  it('Create backup now runs the same backup, confirms with a toast, hides the reminder and stops checking', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    backupSpy.mockResolvedValueOnce(createdBackup('attendance-backup-20261030-103000.apbackup'));
    const user = userEvent.setup();
    render(<><FridayBackupReminder users={interns} now={friday} /><Toasts /></>);

    await screen.findByText(REMINDER);
    infoSpy.mockResolvedValue(dbInfo(eveningBackup));
    await user.click(screen.getByRole('button', { name: 'Create backup now' }));

    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Backup created: attendance-backup-20261030-103000.apbackup')).toBeInTheDocument();
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
    // The backup covers today: later checks ask the server nothing.
    await act(async () => {});
    const infoCalls = infoSpy.mock.calls.length;
    const attendanceCalls = attendanceSpy.mock.calls.length;
    act(() => {
      vi.advanceTimersByTime(15 * 60_000);
    });
    await act(async () => {});
    expect(infoSpy).toHaveBeenCalledTimes(infoCalls);
    expect(attendanceSpy).toHaveBeenCalledTimes(attendanceCalls);
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });

  it('keeps the reminder with the reason when the backup fails', async () => {
    backupSpy.mockResolvedValueOnce({ success: false, error: { message: 'Unable to create a database backup.' } });
    const user = userEvent.setup();
    render(<FridayBackupReminder users={interns} now={friday} />);

    await user.click(await screen.findByRole('button', { name: 'Create backup now' }));
    expect(await screen.findByText('Unable to create a database backup.')).toBeInTheDocument();
    expect(screen.getByText(REMINDER)).toBeInTheDocument();
  });

  it('hides after a backup made anywhere else (Data and backup)', async () => {
    backupSpy.mockResolvedValueOnce(createdBackup('b.apbackup'));
    render(<FridayBackupReminder users={interns} now={friday} />);
    await screen.findByText(REMINDER);

    infoSpy.mockResolvedValue(dbInfo(eveningBackup));
    await act(async () => {
      await createBackupNow();
    });
    await waitFor(() => expect(screen.queryByText(REMINDER)).not.toBeInTheDocument());
  });

  it('starts one backup when both Create backup now buttons are pressed, and both wait while it runs', async () => {
    let finish: (value: ReturnType<typeof createdBackup>) => void = () => {};
    backupSpy.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    vi.spyOn(api, 'loadDtrSyncHealth').mockResolvedValue({ success: false, error: { message: 'Sync status is available in the desktop application.' } });
    const user = userEvent.setup();
    render(<><FridayBackupReminder users={interns} now={friday} /><DatabasePanel /></>);

    await screen.findByText(REMINDER);
    const [bannerButton, panelButton] = screen.getAllByRole('button', { name: 'Create backup now' });
    await user.click(bannerButton);
    // Both buttons now say so and wait; a second call joins the backup already running.
    const saving = screen.getAllByRole('button', { name: 'Saving backup…' });
    expect(saving).toHaveLength(2);
    saving.forEach((button) => expect(button).toBeDisabled());
    expect(saving).toContain(panelButton);
    const joined = createBackupNow();
    expect(backupSpy).toHaveBeenCalledTimes(1);

    infoSpy.mockResolvedValue(dbInfo(eveningBackup));
    await act(async () => {
      finish(createdBackup('one.apbackup'));
      await joined;
    });
    expect(backupSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Create backup now' })).toBeEnabled();
  });

  it('Later hides it for the rest of the day without asking the server again, and it comes back next Friday', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const user = userEvent.setup();
    const { unmount } = render(<FridayBackupReminder users={interns} now={friday} />);

    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
    expect(backupSpy).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('apg-friday-backup-later')).toBe('2026-10-30');
    // The five-minute checks keep running but load nothing for the rest of the day.
    expect(attendanceSpy).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(30 * 60_000);
    });
    await act(async () => {});
    expect(attendanceSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    unmount();

    // Same day, page opened again: still hidden, still nothing asked.
    const again = render(<FridayBackupReminder users={interns} now={() => new Date('2026-10-30T19:45:00+08:00')} />);
    await act(async () => {});
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
    expect(attendanceSpy).toHaveBeenCalledTimes(1);
    again.unmount();

    // The next Friday it asks again.
    render(<FridayBackupReminder users={interns} now={() => new Date('2026-11-06T18:30:00+08:00')} />);
    expect(await screen.findByText(REMINDER)).toBeInTheDocument();
  });

  it('still works when the browser blocks storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const user = userEvent.setup();
    render(<FridayBackupReminder users={interns} now={friday} />);

    await user.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByText(REMINDER)).not.toBeInTheDocument();
  });
});
