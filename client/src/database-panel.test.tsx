import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatabasePanel, SystemPanel, UserEditor } from './App';
import { Toasts } from './toasts';
import * as api from './api';
import * as tauriApi from './tauri-api';
import { getDtrSyncHealthSnapshot, resetDtrSyncGuardForTests, setDtrSyncHealthSnapshot } from './dtr-sync-guard';
import type { AdminSyncDtrResponse, DatabaseInfoResponse } from '@rfid-attendance/shared';

const successfulDtrSync: AdminSyncDtrResponse = {
  success: true,
  internsChecked: 1,
  tabsCreated: [],
  rowsSynced: 2,
  details: [],
  errors: [],
};

type DtrInvokeArgs = { token: string; userId?: string; startFromUserId?: string };

const mockDbInfo: DatabaseInfoResponse = {
  success: true,
  dbPath: 'C:\\Users\\Admin\\AppData\\Local\\alpha-premier-attendance\\attendance.db',
  dataDir: 'C:\\Users\\Admin\\AppData\\Local\\alpha-premier-attendance',
  backupDir: 'C:\\Users\\Admin\\AppData\\Local\\alpha-premier-attendance\\backups',
  isPortableMode: false,
  restorePending: false,
  restoreSourcePath: null,
  lastBackupAt: '2026-08-15T00:00:00Z',
  backups: [
    {
      fileName: 'attendance-backup-20260815-000000.apbackup',
      filePath: 'C:\\Users\\Admin\\AppData\\Local\\alpha-premier-attendance\\backups\\attendance-backup-20260815-000000.apbackup',
      sizeBytes: 1048576,
      modifiedAt: '2026-08-15T00:00:00Z',
    },
  ],
};

describe('DatabasePanel', () => {
  let loadDatabaseInfoSpy: MockInstance;
  let createDatabaseBackupSpy: MockInstance;
  let requestDatabaseRestoreSpy: MockInstance;
  let openDatabaseBackupsFolderSpy: MockInstance;
  let pickRestoreBackupFileSpy: MockInstance;
  let loadDtrSyncHealthSpy: MockInstance;

  beforeEach(() => {
    // SAFETY: Setting global Tauri mock interface for test environment
    const win = window as typeof window & { __TAURI_INTERNALS__?: object };
    win.__TAURI_INTERNALS__ = {};

    loadDatabaseInfoSpy = vi.spyOn(api, 'loadDatabaseInfo').mockResolvedValue(mockDbInfo);
    createDatabaseBackupSpy = vi.spyOn(api, 'createDatabaseBackup');
    requestDatabaseRestoreSpy = vi.spyOn(api, 'requestDatabaseRestore');
    openDatabaseBackupsFolderSpy = vi.spyOn(api, 'openDatabaseBackupsFolder');
    pickRestoreBackupFileSpy = vi.spyOn(api, 'pickRestoreBackupFile');
    loadDtrSyncHealthSpy = vi.spyOn(api, 'loadDtrSyncHealth').mockResolvedValue({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        dtr: {
          enabled: true,
          queued: 0,
          retrying: 0,
          processing: 0,
          dead: 0,
          retryablePending: 0,
          needsAttention: 0,
          persistenceFailure: false,
          nextRetryEligibleAt: null,
          oldestOutstandingAgeSec: null,
          currentIssue: 'none',
          currentIssueSince: null,
          lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z',
          activity: 'idle',
        },
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDtrSyncGuardForTests();
    // SAFETY: Cleaning up mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('renders the backups heading and existing backups, with the database facts left to the System tab', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByRole('heading', { name: 'Backups' })).toBeInTheDocument();
    expect(screen.getByText('attendance-backup-20260815-000000.apbackup')).toBeInTheDocument();
    expect(screen.getByText('1024 KB')).toBeInTheDocument();
    expect(loadDatabaseInfoSpy).toHaveBeenCalled();
    // No developer details here: no database path, storage mode or update controls.
    expect(screen.queryByText(mockDbInfo.dbPath)).not.toBeInTheDocument();
    expect(screen.queryByText('Installed — app data folder')).not.toBeInTheDocument();
    expect(screen.queryByText(/Technical details/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /check for updates now/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /when you log in/i })).not.toBeInTheDocument();
  });

  it('lists the existing backups by date, newest month and newest backup first, whatever order they arrive in', async () => {
    // The desktop app returns backups by file name, so a September "pre-restore-" snapshot comes before the newer
    // "attendance-backup-" files, and November and October arrive mixed; an undated file goes last.
    const backup = (fileName: string, modifiedAt: string | null) => ({ ...mockDbInfo.backups[0], fileName, filePath: `C:\\backups\\${fileName}`, modifiedAt });
    loadDatabaseInfoSpy.mockResolvedValue({
      ...mockDbInfo,
      backups: [
        backup('pre-restore-20260912-101500.apbackup', '2026-09-12T10:15:00+08:00'),
        backup('attendance-backup-20261015-080200.apbackup', '2026-10-15T08:02:00+08:00'),
        backup('attendance-backup-20261101-080200.apbackup', '2026-11-01T08:02:00+08:00'),
        backup('copied-backup.apbackup', null),
        backup('attendance-backup-20261028-080200.apbackup', '2026-10-28T08:02:00+08:00'),
        backup('attendance-backup-20261103-080200.apbackup', '2026-11-03T08:02:00+08:00'),
      ],
    });
    render(<DatabasePanel />);

    await screen.findByText('pre-restore-20260912-101500.apbackup');
    const months = [...document.querySelectorAll('.db-backup-month')];
    expect(months.map((month) => month.querySelector('summary')?.textContent)).toEqual(['November 2026 2', 'October 2026 2', 'September 2026 1', 'Unknown date 1']);
    expect(months.map((month) => [...month.querySelectorAll('code')].map((name) => name.textContent))).toEqual([
      ['attendance-backup-20261103-080200.apbackup', 'attendance-backup-20261101-080200.apbackup'],
      ['attendance-backup-20261028-080200.apbackup', 'attendance-backup-20261015-080200.apbackup'],
      ['pre-restore-20260912-101500.apbackup'],
      ['copied-backup.apbackup'],
    ]);
  });

  it('shows two sections one after the other: Backups, then Google Sheets with its own Sync now and on/off', async () => {
    render(<DatabasePanel />);

    const backups = await screen.findByRole('region', { name: 'Backups' });
    const sheets = screen.getByRole('region', { name: 'Google Sheets' });
    expect(backups.compareDocumentPosition(sheets) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const name of [/create backup now/i, /restore from backup file/i, /open backups folder/i, /how to move to a new pc/i]) {
      expect(within(backups).getByRole('button', { name })).toBeInTheDocument();
    }
    expect(within(backups).queryByRole('button', { name: /sync now/i })).not.toBeInTheDocument();
    expect(within(sheets).getByRole('button', { name: /^sync now$/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /sync/i })).toHaveLength(1);
    // A plain tick box, no developer tooltip.
    const upload = within(sheets).getByRole('checkbox', { name: 'Upload attendance to Google Sheets from this PC' });
    expect(upload).toBeChecked();
    expect(upload.closest('label')).not.toHaveAttribute('title');
  });

  it('says plainly when uploading is off on this PC', async () => {
    vi.spyOn(api, 'getInternDtrSync').mockResolvedValue({ success: true, enabled: false });
    render(<DatabasePanel />);

    expect(await screen.findByText("Uploading is off for this PC. Attendance is kept here and uploads when it's turned back on.")).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Upload attendance to Google Sheets from this PC' })).not.toBeChecked();
    expect(screen.getByText('Paused on this PC')).toBeInTheDocument();
    // Nothing would upload, so Sync now waits too.
    expect(screen.getByRole('button', { name: /^sync now$/i })).toBeDisabled();
  });

  it('leaves out "Use Sync now" from a failed upload while uploading is off', async () => {
    vi.spyOn(api, 'getInternDtrSync').mockResolvedValue({ success: true, enabled: false });
    loadDtrSyncHealthSpy.mockResolvedValue({
      success: true,
      health: {
        pending: 0, deadLetter: 0, byTable: [], dtrPendingCount: 0, dtrPendingItems: [], lastSyncedAt: null, lastError: null,
        throttledUntil: null, lastThrottleReason: null, inProgress: null, leaseRecovered: 0, oldestRetryableAgeSec: null, pendingAgeAlert: false,
        dtr: {
          enabled: true, queued: 0, retrying: 0, processing: 0, dead: 2, retryablePending: 0, needsAttention: 0, persistenceFailure: false,
          nextRetryEligibleAt: null, oldestOutstandingAgeSec: null, currentIssue: 'none', currentIssueSince: null, lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z', activity: 'idle',
        },
      },
    });
    render(<DatabasePanel />);

    expect(await screen.findByText("2 records couldn't upload.")).toBeInTheDocument();
    expect(screen.queryByText(/Use Sync now/)).not.toBeInTheDocument();
  });

  it('turns uploading on and off in plain words, and says so when the setting could not change', async () => {
    const setSpy = vi.spyOn(api, 'setInternDtrSync')
      .mockResolvedValueOnce({ success: true, enabled: false })
      .mockResolvedValueOnce({ success: true, enabled: true })
      .mockResolvedValueOnce({ success: false, enabled: true, error: { message: 'DTR_TOGGLE_FAILED' } });
    vi.spyOn(api, 'getInternDtrSync').mockResolvedValue({ success: true, enabled: true });
    const user = userEvent.setup();
    render(<><DatabasePanel /><Toasts /></>);

    const upload = await screen.findByRole('checkbox', { name: 'Upload attendance to Google Sheets from this PC' });
    await waitFor(() => expect(upload).toBeEnabled());
    await user.click(upload);
    expect(await screen.findAllByText("Uploading is off for this PC. Attendance is kept here and uploads when it's turned back on.")).not.toHaveLength(0);
    await user.click(upload);
    expect(await screen.findByText('Uploading to Google Sheets is on for this PC.')).toBeInTheDocument();
    await user.click(upload);
    expect(await screen.findByText("Couldn't change the upload setting.")).toBeInTheDocument();
    expect(screen.queryByText(/DTR_TOGGLE_FAILED/)).not.toBeInTheDocument();
    expect(setSpy).toHaveBeenCalledTimes(3);
  });

  it('keeps backup buttons free while an upload runs, and upload controls free while a backup runs', async () => {
    let finishSync: (value: Awaited<ReturnType<typeof api.syncInternDtr>>) => void = () => {};
    vi.spyOn(api, 'syncInternDtr').mockReturnValueOnce(new Promise((resolve) => { finishSync = resolve; }));
    let finishBackup: (value: Awaited<ReturnType<typeof api.createDatabaseBackup>>) => void = () => {};
    createDatabaseBackupSpy.mockReturnValueOnce(new Promise((resolve) => { finishBackup = resolve; }));
    vi.spyOn(api, 'getInternDtrSync').mockResolvedValue({ success: true, enabled: true });
    const user = userEvent.setup();
    render(<DatabasePanel />);

    await user.click(await screen.findByRole('button', { name: /^sync now$/i }));
    expect(screen.getByRole('button', { name: /^sync now$/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create backup now' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /restore from backup file/i })).toBeEnabled();
    await act(async () => finishSync(successfulDtrSync));

    await user.click(screen.getByRole('button', { name: 'Create backup now' }));
    expect(screen.getByRole('button', { name: 'Saving backup…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: /restore from backup file/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^sync now$/i })).toBeEnabled();
    expect(screen.getByRole('checkbox', { name: 'Upload attendance to Google Sheets from this PC' })).toBeEnabled();
    await act(async () => finishBackup({ success: false, error: { message: 'Unable to create a database backup.' } }));
    expect(await screen.findByRole('button', { name: 'Create backup now' })).toBeEnabled();
  });

  it('shows a gold line while a restore waits for the app to reopen', async () => {
    loadDatabaseInfoSpy.mockResolvedValue({ ...mockDbInfo, restorePending: true });
    render(<DatabasePanel />);

    const line = await screen.findByText('A restore is waiting. Close and reopen the app to finish it.');
    expect(line).toHaveClass('db-restore-waiting');
    expect(within(screen.getByRole('region', { name: 'Backups' })).getByText(/A restore is waiting/)).toBe(line);
  });

  it('leads each backup row with its date and keeps no extra Latest backup card after Create backup now', async () => {
    createDatabaseBackupSpy.mockResolvedValueOnce({
      success: true,
      filePath: 'C:\\backups\\attendance-backup-20260815-020000.apbackup',
      directoryPath: 'C:\\backups',
      fileName: 'attendance-backup-20260815-020000.apbackup',
      fileKind: 'backup',
      isPortableMode: false,
    });
    const user = userEvent.setup();
    render(<DatabasePanel />);

    const name = await screen.findByText('attendance-backup-20260815-000000.apbackup');
    const row = name.closest('li');
    expect(row?.firstElementChild).toHaveTextContent('Aug 15, 2026, 8:00 AM');
    expect(row?.firstElementChild?.nextElementSibling).toBe(name);

    await user.click(screen.getByRole('button', { name: /create backup now/i }));
    expect(createDatabaseBackupSpy).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Latest backup')).not.toBeInTheDocument();
  });

  describe('Last backup line', () => {
    const backupAt = (modifiedAt: string) => ({ ...mockDbInfo.backups[0], filePath: `C:\\backups\\${modifiedAt}.apbackup`, modifiedAt });
    afterEach(() => vi.useRealTimers());

    it('leads with today and the time when the newest backup is from today', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T18:30:00+08:00'));
      // Newest first is not assumed: the newest of the list counts.
      loadDatabaseInfoSpy.mockResolvedValue({ ...mockDbInfo, backups: [backupAt('2026-10-21T08:05:00+08:00'), backupAt('2026-10-30T08:02:00+08:00')] });
      render(<DatabasePanel />);

      const line = await screen.findByText(/^Last backup:/);
      expect(line).toHaveTextContent('Last backup: today, 8:02 AM');
      expect(line).not.toHaveClass('is-stale');
      // It sits right under the heading, before the backup buttons.
      expect(screen.getByRole('heading', { name: 'Backups' }).nextElementSibling).toBe(line);
    });

    it('shows the date and time for an older backup within a week', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T18:30:00+08:00'));
      loadDatabaseInfoSpy.mockResolvedValue({ ...mockDbInfo, backups: [backupAt('2026-10-29T08:05:00+08:00')] });
      render(<DatabasePanel />);

      expect(await screen.findByText(/^Last backup:/)).toHaveTextContent('Last backup: Oct 29, 2026, 8:05 AM');
    });

    it('turns coral when the newest backup is over a week old', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T18:30:00+08:00'));
      loadDatabaseInfoSpy.mockResolvedValue({ ...mockDbInfo, backups: [backupAt('2026-10-21T08:05:00+08:00')] });
      render(<DatabasePanel />);

      const line = await screen.findByText('Last backup was 9 days ago. Create one now.');
      expect(line).toHaveClass('is-stale');
    });

    it('keeps a backup exactly a week old calm', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T18:30:00+08:00'));
      loadDatabaseInfoSpy.mockResolvedValue({ ...mockDbInfo, backups: [backupAt('2026-10-23T08:05:00+08:00')] });
      render(<DatabasePanel />);

      expect(await screen.findByText(/^Last backup:/)).toHaveTextContent('Last backup: Oct 23, 2026, 8:05 AM');
      expect(screen.queryByText(/days ago/)).not.toBeInTheDocument();
    });

    it('asks for a first backup when there are none', async () => {
      loadDatabaseInfoSpy.mockResolvedValue({ ...mockDbInfo, backups: [], lastBackupAt: null });
      render(<DatabasePanel />);

      expect(await screen.findByText('No backups yet. Create one now.')).toHaveClass('is-stale');
    });

    it('updates to today after Create backup now', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-30T18:30:00+08:00'));
      loadDatabaseInfoSpy
        .mockResolvedValueOnce({ ...mockDbInfo, backups: [backupAt('2026-10-21T08:05:00+08:00')] })
        .mockResolvedValue({ ...mockDbInfo, backups: [backupAt('2026-10-30T18:30:00+08:00'), backupAt('2026-10-21T08:05:00+08:00')] });
      createDatabaseBackupSpy.mockResolvedValueOnce({
        success: true,
        filePath: 'C:\\backups\\attendance-backup-20261030-103000.apbackup',
        directoryPath: 'C:\\backups',
        fileName: 'attendance-backup-20261030-103000.apbackup',
        fileKind: 'backup',
        isPortableMode: false,
      });
      const user = userEvent.setup();
      render(<DatabasePanel />);

      await screen.findByText('Last backup was 9 days ago. Create one now.');
      await user.click(screen.getByRole('button', { name: /create backup now/i }));
      expect(await screen.findByText(/^Last backup:/)).toHaveTextContent('Last backup: today, 6:30 PM');
    });
  });

  it('handles Create backup now action successfully', async () => {
    createDatabaseBackupSpy.mockResolvedValueOnce({
      success: true,
      filePath: 'C:\\backups\\attendance-backup-20260815-010000.apbackup',
      directoryPath: 'C:\\backups',
      fileName: 'attendance-backup-20260815-010000.apbackup',
      fileKind: 'backup',
      isPortableMode: false,
      message: 'Backup created.',
    });

    const user = userEvent.setup();
    render(<><DatabasePanel /><Toasts /></>);

    const backupBtn = await screen.findByRole('button', { name: /create backup now/i });
    await user.click(backupBtn);

    expect(createDatabaseBackupSpy).toHaveBeenCalledTimes(1);
    // A routine result: shown as a toast.
    expect(await screen.findByText(/Backup created: attendance-backup-20260815-010000.apbackup/i)).toBeInTheDocument();
  });

  it('displays error when backup creation fails', async () => {
    createDatabaseBackupSpy.mockResolvedValueOnce({
      success: false,
      error: { message: 'Failed to write backup snapshot' },
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const backupBtn = await screen.findByRole('button', { name: /create backup now/i });
    await user.click(backupBtn);

    expect(await screen.findByText('Failed to write backup snapshot')).toBeInTheDocument();
  });

  it('handles Open backups folder action', async () => {
    openDatabaseBackupsFolderSpy.mockResolvedValueOnce({
      ok: true,
      message: 'Backup folder opened.',
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const openBtn = await screen.findByRole('button', { name: /open backups folder/i });
    await user.click(openBtn);

    expect(openDatabaseBackupsFolderSpy).toHaveBeenCalledTimes(1);
  });

  it('handles Restore from backup file flow with confirmation', async () => {
    pickRestoreBackupFileSpy.mockResolvedValueOnce('C:\\backups\\attendance-backup-20260815-000000.apbackup');
    requestDatabaseRestoreSpy.mockResolvedValueOnce({
      success: true,
      message: 'Restore scheduled. The app will close and restore on the next launch.',
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const restoreBtn = await screen.findByRole('button', { name: /restore from backup file/i });
    await user.click(restoreBtn);

    // Confirm dialog should be visible
    expect(await screen.findByText('Restore database from backup?')).toBeInTheDocument();

    const confirmBtn = screen.getByRole('button', { name: 'Restore database' });
    await user.click(confirmBtn);

    expect(requestDatabaseRestoreSpy).toHaveBeenCalledWith('C:\\backups\\attendance-backup-20260815-000000.apbackup');
    expect(await screen.findByText(/Restore scheduled/i)).toBeInTheDocument();
  });

  it('restores a listed backup from its row after confirmation', async () => {
    requestDatabaseRestoreSpy.mockResolvedValueOnce({
      success: true,
      message: 'Restore scheduled. The application is restarting to apply the backup.',
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    await user.click(await screen.findByRole('button', { name: /^restore$/i }));
    expect(await screen.findByText('Restore database from backup?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Restore database' }));

    expect(requestDatabaseRestoreSpy).toHaveBeenCalledWith(mockDbInfo.backups[0].filePath);
    expect(pickRestoreBackupFileSpy).not.toHaveBeenCalled();
  });

  it('downloads a copy of a listed backup from its row', async () => {
    const saveBackupCopySpy = vi.spyOn(api, 'saveBackupCopy').mockResolvedValueOnce({
      ok: true,
      message: 'Backup saved to E:\\attendance-backup-20260815-000000.apbackup.',
    });

    const user = userEvent.setup();
    render(<><DatabasePanel /><Toasts /></>);

    await user.click(await screen.findByRole('button', { name: /^download$/i }));

    expect(saveBackupCopySpy).toHaveBeenCalledWith(mockDbInfo.backups[0].filePath, mockDbInfo.backups[0].fileName);
    expect(await screen.findByText(/Backup saved to E:/i)).toBeInTheDocument();
  });

  it('groups existing backups into one fold per month, the list open and every month closed', async () => {
    const backup = (stamp: string, modifiedAt: string) => ({
      fileName: `attendance-backup-${stamp}.apbackup`,
      filePath: `C:\\backups\\attendance-backup-${stamp}.apbackup`,
      sizeBytes: 114688,
      modifiedAt,
    });
    loadDatabaseInfoSpy.mockResolvedValue({
      ...mockDbInfo,
      backups: [
        backup('20261020-120000', '2026-10-20T04:00:00Z'),
        backup('20261012-120000', '2026-10-12T04:00:00Z'),
        backup('20260910-120000', '2026-09-10T04:00:00Z'),
      ],
    });

    render(<DatabasePanel />);

    const october = (await screen.findByText(/October 2026/)).closest('details');
    const september = screen.getByText(/September 2026/).closest('details');
    expect(october?.parentElement?.closest('details')).toHaveAttribute('open');
    expect(october).not.toHaveAttribute('open');
    expect(september).not.toHaveAttribute('open');
    expect(october).toHaveTextContent('attendance-backup-20261020-120000.apbackup');
    expect(october).toHaveTextContent('attendance-backup-20261012-120000.apbackup');
    expect(september).toHaveTextContent('attendance-backup-20260910-120000.apbackup');
  });

  it('opens and closes the move-to-a-new-PC guide', async () => {
    const user = userEvent.setup();
    render(<DatabasePanel />);

    expect(screen.queryByRole('dialog', { name: /moving to the new front-desk pc/i })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: /how to move to a new pc/i }));
    expect(screen.getByRole('dialog', { name: /moving to the new front-desk pc/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /got it/i }));
    expect(screen.queryByRole('dialog', { name: /moving to the new front-desk pc/i })).not.toBeInTheDocument();
  });

  it('allows canceling the restore dialog without scheduling', async () => {
    pickRestoreBackupFileSpy.mockResolvedValueOnce('C:\\backups\\test.apbackup');

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const restoreBtn = await screen.findByRole('button', { name: /restore from backup file/i });
    await user.click(restoreBtn);

    expect(await screen.findByText('Restore database from backup?')).toBeInTheDocument();

    const cancelBtn = screen.getByRole('button', { name: /cancel/i });
    await user.click(cancelBtn);

    await waitFor(() => {
      expect(screen.queryByText('Restore database from backup?')).not.toBeInTheDocument();
    });
    expect(requestDatabaseRestoreSpy).not.toHaveBeenCalled();
  });

  it('closes the restore confirmation with Escape, starting on Cancel and giving focus back to the row button', async () => {
    const user = userEvent.setup();
    render(<DatabasePanel />);

    const rowRestore = await screen.findByRole('button', { name: /^restore$/i });
    await user.click(rowRestore);
    const dialog = await screen.findByRole('dialog', { name: 'Restore database from backup?' });
    // Destructive: focus starts on Cancel, so Enter never restores by accident.
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(dialog).toContainElement(screen.getByRole('button', { name: 'Restore database' }));

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Restore database from backup?' })).not.toBeInTheDocument();
    expect(rowRestore).toHaveFocus();
    expect(requestDatabaseRestoreSpy).not.toHaveBeenCalled();
  });

  it('shows a failed backup list with Retry that loads it again', async () => {
    loadDatabaseInfoSpy
      .mockResolvedValueOnce({ success: false, error: { message: 'Unable to read the database status.' } })
      .mockResolvedValueOnce(mockDbInfo);
    const user = userEvent.setup();
    render(<DatabasePanel />);

    // The failed line keeps the reason the service gave.
    expect(await screen.findByText("Couldn't load the backup list. Unable to read the database status.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^retry$/i }));
    expect(await screen.findByText('attendance-backup-20260815-000000.apbackup')).toBeInTheDocument();
    expect(screen.queryByText(/Couldn't load the backup list/)).not.toBeInTheDocument();
  });

  it('shows the desktop-only reply in a browser as a calm note without Retry', async () => {
    // SAFETY: Removing the Tauri mock property, as in a plain browser
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    loadDatabaseInfoSpy.mockResolvedValue({ success: false, error: { message: 'Database tools are available in the desktop application.' } });
    render(<DatabasePanel />);

    const note = await screen.findByText('Database tools are available in the desktop application.');
    expect(note.closest('.notice')).toHaveClass('is-info');
    expect(screen.queryByText(/Couldn't load the backup list/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^retry$/i })).not.toBeInTheDocument();
  });

  it('closes the move-to-a-new-PC guide with Escape', async () => {
    const user = userEvent.setup();
    render(<DatabasePanel />);
    await user.click(await screen.findByRole('button', { name: /how to move to a new pc/i }));
    expect(screen.getByRole('button', { name: /got it/i })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: /moving to the new front-desk pc/i })).not.toBeInTheDocument();
  });

  it('triggers Sync Intern DTR now and displays result', async () => {
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockResolvedValueOnce({
      success: true,
      internsChecked: 1,
      tabsCreated: ['Marissa C. Dalisay'],
      rowsSynced: 4,
      details: [
        {
          userId: 'APG-2026-116',
          fullName: 'Marissa C. Dalisay',
          tab: 'Marissa C. Dalisay',
          tabCreated: true,
          rowsSynced: 4,
          status: 'SYNCED',
        },
      ],
      errors: [],
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);

    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Upload finished: 4 records sent.')).toBeInTheDocument();
  });

  it('shows the stopped tab and retries from that intern, keeping resumed progress until completion', async () => {
    const failed = Object.assign({
      success: false,
      internsChecked: 2,
      tabsCreated: [],
      rowsSynced: 1,
      details: [
        { userId: 'APG-TAB-MATCH', fullName: 'Tab Match Intern', tab: 'Failed Tab', tabCreated: false, rowsSynced: 0, status: 'SKIPPED' },
        { userId: 'APG-FAIL', fullName: 'Failed Intern', tab: 'Other Tab', tabCreated: false, rowsSynced: 0, status: 'ERROR' },
      ],
      errors: ['write failed'],
      error: { message: 'write failed' },
    }, { stoppedTab: 'Failed Tab', stoppedUserId: 'APG-FAIL' });
    let resolveResumed: ((report: AdminSyncDtrResponse) => void) | null = null;
    const invokeSpy = vi.fn(async (command: string, args: DtrInvokeArgs | undefined) => {
      if (command !== 'admin_sync_intern_dtr') return { success: true, enabled: true };
      if (args?.startFromUserId) {
        return new Promise<AdminSyncDtrResponse>((resolve) => { resolveResumed = resolve; });
      }
      return failed;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: invokeSpy } });
    let progressHandler: ((payload: tauriApi.DtrSyncProgress) => void) | null = null;
    vi.spyOn(tauriApi, 'listenForDtrSyncProgress').mockImplementation((handler) => {
      progressHandler = handler;
      return Promise.resolve(() => {});
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);
    await user.click(await screen.findByRole('button', { name: /^sync now$/i }));
    expect(await screen.findByText('Stopped at Failed Tab')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(invokeSpy).toHaveBeenCalledWith('admin_sync_intern_dtr', {
      token: '',
      userId: undefined,
      startFromUserId: 'APG-FAIL',
    }, undefined));
    act(() => {
      progressHandler?.({ current: 1, total: 2, userId: 'APG-FAIL', fullName: 'Failed Intern', status: 'syncing' });
    });
    expect(screen.getByText('Uploading 1 of 2…')).toBeInTheDocument();
    await act(async () => {
      resolveResumed?.({ success: true, internsChecked: 2, tabsCreated: [], rowsSynced: 3, details: [], errors: [] });
    });
    expect(await screen.findByText('Upload finished: 3 records sent.')).toBeInTheDocument();
    expect(screen.queryByText('Stopped at Failed Tab')).not.toBeInTheDocument();
  });

  it('retries the stopped user from a Rust-shaped MISSING_TAB report', async () => {
    const missingTabReport = Object.assign({
      success: false,
      internsChecked: 1,
      tabsCreated: [],
      rowsSynced: 0,
      details: [
        { userId: 'APG-MISSING', fullName: 'Missing Tab Intern', tab: null, tabCreated: false, rowsSynced: 0, status: 'MISSING_TAB' },
      ],
      errors: ['The intern DTR tab was not found.'],
      error: { message: 'The intern DTR tab was not found.' },
    }, { stoppedTab: null, stoppedUserId: 'APG-MISSING' });
    const invokeSpy = vi.fn(async (command: string, args: DtrInvokeArgs | undefined) => {
      if (command !== 'admin_sync_intern_dtr') return { success: true, enabled: true };
      if (args?.startFromUserId) {
        return { success: true, internsChecked: 1, tabsCreated: [], rowsSynced: 1, details: [], errors: [] };
      }
      return missingTabReport;
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: { invoke: invokeSpy } });

    const user = userEvent.setup();
    render(<DatabasePanel />);
    await user.click(await screen.findByRole('button', { name: /^sync now$/i }));
    expect(await screen.findByText('Stopped at Missing Tab Intern')).toBeInTheDocument();
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toBeEnabled();
    await user.click(retry);

    expect(invokeSpy).toHaveBeenCalledWith('admin_sync_intern_dtr', {
      token: '',
      userId: undefined,
      startFromUserId: 'APG-MISSING',
    }, undefined);
  });

  it('routes Data and per-intern sync buttons to the DTR command with the right user ID', async () => {
    const invokeSpy = vi.fn(async (_command: string, _args: DtrInvokeArgs | undefined) => successfulDtrSync);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: invokeSpy },
    });
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    vi.spyOn(tauriApi, 'listenForDtrSyncProgress').mockResolvedValue(() => {});

    const user = userEvent.setup();
    render(<DatabasePanel />);
    render(
      <UserEditor
        users={[
          {
            userId: 'APG-2026-103',
            rfidUid: 'ABCDEF1234',
            fullName: 'Juan Dela Cruz',
            department: null,
            status: 'ACTIVE',
            employeeType: 'INTERN',
            gender: null,
            dailyRate: null,
          },
        ]}
        editing={null}
        setEditing={() => {}}
        onSaved={() => {}}
      />,
    );

    await user.click(await screen.findByTestId('dtr-sync-now'));
    await user.click(await screen.findByTestId('dtr-sync-row-APG-2026-103'));

    expect(invokeSpy).toHaveBeenCalledWith('admin_sync_intern_dtr', {
      token: '',
      userId: undefined,
      startFromUserId: undefined,
    }, undefined);
    expect(invokeSpy).toHaveBeenCalledWith('admin_sync_intern_dtr', {
      token: '',
      userId: 'APG-2026-103',
      startFromUserId: undefined,
    }, undefined);
  });

  it('surfaces a DTR_SYNC_IN_PROGRESS response from the native second caller', async () => {
    const invokeSpy = vi.fn(async (_command: string, _args: DtrInvokeArgs | undefined) => {
      throw new Error('DTR_SYNC_IN_PROGRESS: another sync is active');
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: invokeSpy },
    });
    const user = userEvent.setup();
    render(<DatabasePanel />);

    await user.click(await screen.findByTestId('dtr-sync-now'));

    expect(await screen.findByText('Sync already running.')).toBeInTheDocument();
    expect(invokeSpy).toHaveBeenCalledWith('admin_sync_intern_dtr', {
      token: '',
      userId: undefined,
    }, undefined);
  });

  it('renders partial sync failures and BACKFILL_FAILED detail messages', async () => {
    const partialFailure: AdminSyncDtrResponse = {
      success: true,
      internsChecked: 2,
      tabsCreated: [],
      rowsSynced: 2,
      details: [
        {
          userId: 'APG-2026-103',
          fullName: 'Juan Dela Cruz',
          tab: 'Juan Dela Cruz',
          tabCreated: false,
          rowsSynced: 0,
          status: 'BACKFILL_FAILED',
        },
      ],
      errors: [
        'BACKFILL_FAILED: Juan Dela Cruz (APG-2026-103): Google Sheets write failed',
        'BACKFILL_FAILED: Marissa Dalisay (APG-2026-116): permission denied',
      ],
    };
    const invokeSpy = vi.fn(async (_command: string, _args: DtrInvokeArgs | undefined) => partialFailure);
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: { invoke: invokeSpy },
    });
    const user = userEvent.setup();
    render(<DatabasePanel />);

    await user.click(await screen.findByTestId('dtr-sync-now'));

    const errorsAlert = await screen.findByRole('alert');
    expect(errorsAlert).toHaveTextContent(/BACKFILL_FAILED: Juan Dela Cruz \(APG-2026-103\): Google Sheets write failed/i);
    expect(errorsAlert).toHaveTextContent(/BACKFILL_FAILED: Marissa Dalisay \(APG-2026-116\): permission denied/i);
    expect(screen.getByText(/^2 records sent, but some didn't upload:/)).toBeInTheDocument();
  });

  it('displays real-time progress bar when dtr-sync-progress events occur during sync', async () => {
    let progressHandler: ((payload: tauriApi.DtrSyncProgress) => void) | null = null;
    vi.spyOn(tauriApi, 'listenForDtrSyncProgress').mockImplementation((handler) => {
      progressHandler = handler;
      return Promise.resolve(() => {});
    });

    let resolveSync: (value: Awaited<ReturnType<typeof api.syncInternDtr>>) => void = () => {};
    const syncPromise = new Promise<Awaited<ReturnType<typeof api.syncInternDtr>>>((resolve) => {
      resolveSync = resolve;
    });
    vi.spyOn(api, 'syncInternDtr').mockReturnValueOnce(syncPromise);

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);

    expect(screen.getByText('Uploading…')).toBeInTheDocument();

    act(() => {
      progressHandler?.({
        current: 3,
        total: 10,
        userId: 'APG-2026-103',
        fullName: 'Juan Dela Cruz',
        status: 'syncing',
      });
    });

    expect(await screen.findByText('Uploading 3 of 10…')).toBeInTheDocument();
    // No Queue/Manual capsule in Data and backup.
    expect(screen.queryByText(/^(Queue|Manual)$/)).not.toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();

    await act(async () => {
      resolveSync({
        success: true,
        internsChecked: 10,
        tabsCreated: [],
        rowsSynced: 25,
        details: [],
        errors: [],
      });
    });

    expect(await screen.findByText('Upload finished: 25 records sent.')).toBeInTheDocument();
  });

  it('displays DTR sync error message when sync errors occur', async () => {
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockResolvedValueOnce({
      success: false,
      internsChecked: 1,
      tabsCreated: [],
      rowsSynced: 0,
      details: [],
      errors: ['Google Sheets auth failed: connection timed out'],
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);

    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Google Sheets auth failed: connection timed out/i)).toBeInTheDocument();
  });

  it('shows live DTR sync health with per-table pending rows', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 2,
        deadLetter: 0,
        byTable: [{ tableName: 'attendance', pending: 2 }],
        dtrPendingCount: 1,
        dtrPendingItems: [{ userId: 'APG-2026-116', fullName: 'Marissa C. Dalisay', attempts: 1, lastChecked: null }],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByRole('region', { name: 'Google Sheets' })).toBeInTheDocument();
    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
    expect(screen.getByText('attendance')).toBeInTheDocument();
    expect(screen.getByText('2 pending')).toBeInTheDocument();
    expect(screen.getByText('InternDtr tabs')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByText('Waiting for a tab')).toBeInTheDocument();
    expect(screen.getByText('Marissa C. Dalisay')).toBeInTheDocument();
    // Table names and counts are for support: inside the closed "Details for support" fold.
    const fold = screen.getByText('Details for support').closest('details');
    expect(fold).not.toHaveAttribute('open');
    expect(fold).toContainElement(screen.getByText('attendance'));
    expect(fold).toContainElement(screen.getByText('InternDtr tabs'));
    expect(loadDtrSyncHealthSpy).toHaveBeenCalled();
  });

  it('shows DTR health without reporting unrelated global ops DEAD items', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 0,
        deadLetter: 1,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: 'Google Sheets auth failed: expired token',
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        dtr: {
          enabled: true,
          queued: 0,
          retrying: 0,
          processing: 0,
          dead: 0,
          retryablePending: 0,
          needsAttention: 0,
          persistenceFailure: false,
          nextRetryEligibleAt: null,
          oldestOutstandingAgeSec: null,
          currentIssue: 'none',
          currentIssueSince: null,
          lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z',
          activity: 'idle',
        },
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByText(/^Up to date · last upload/)).toBeInTheDocument();
    expect(screen.queryByText('All sync failures: 1')).not.toBeInTheDocument();
    expect(screen.queryByText(/failed DTR item\(s\)/)).not.toBeInTheDocument();
    // One green line beside the heading; no second failures badge.
    expect(screen.getByText(/^Up to date · last upload/).closest('.sheets-status')).toHaveClass('is-ok');
    expect(screen.getAllByText(/^Up to date/)).toHaveLength(1);
    expect(screen.queryByText('Healthy')).not.toBeInTheDocument();
    expect(screen.queryByText('Attention')).not.toBeInTheDocument();
    expect(screen.queryByText(/Last error: Google Sheets auth failed: expired token/)).not.toBeInTheDocument();
  });

  it('renders unavailable before the DTR disabled state and uses retry eligibility copy', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: null,
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        dtr: {
          enabled: false,
          queued: 0,
          retrying: 0,
          processing: 0,
          dead: 0,
          retryablePending: 2,
          needsAttention: 0,
          persistenceFailure: false,
          nextRetryEligibleAt: '2026-08-15T01:00:00Z',
          oldestOutstandingAgeSec: null,
          currentIssue: 'none',
          currentIssueSince: null,
          lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z',
          activity: 'unavailable',
        },
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByText('Status unavailable. Attendance keeps saving on this PC.')).toBeInTheDocument();
    expect(screen.queryByText('Paused on this PC')).not.toBeInTheDocument();
  });

  it('renders retryable work as waiting and action-required work as admin attention', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: null,
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        dtr: {
          enabled: true,
          queued: 0,
          retrying: 0,
          processing: 0,
          dead: 0,
          retryablePending: 2,
          needsAttention: 0,
          persistenceFailure: false,
          nextRetryEligibleAt: '2026-08-15T01:00:00Z',
          oldestOutstandingAgeSec: null,
          currentIssue: 'unresolved_layout',
          currentIssueSince: null,
          lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z',
          activity: 'retrying',
        },
      },
    });

    const { unmount } = render(<DatabasePanel />);
    // Waiting is gold, not a failure: the count and the next try, in plain words.
    const waiting = await screen.findByText('2 records waiting · next try Aug 15, 2026, 9:00 AM');
    expect(waiting.closest('.sheets-status')).toHaveClass('is-waiting');
    expect(document.querySelector('.sheets-status.is-failed')).toBeNull();
    unmount();

    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: null,
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        dtr: {
          enabled: true,
          queued: 0,
          retrying: 0,
          processing: 0,
          dead: 0,
          retryablePending: 0,
          needsAttention: 1,
          persistenceFailure: false,
          nextRetryEligibleAt: null,
          oldestOutstandingAgeSec: null,
          currentIssue: 'unresolved_layout',
          currentIssueSince: null,
          lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z',
          activity: 'idle',
        },
      },
    });
    render(<DatabasePanel />);
    const attention = await screen.findByText('1 record needs an administrator before it can upload.');
    expect(attention.closest('.sheets-status')).toHaveClass('is-failed');
  });

  it('shows DTR DEAD independently and does not mark it as an ops failure', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: null,
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        dtr: {
          enabled: true,
          queued: 0,
          retrying: 0,
          processing: 0,
          dead: 1,
          retryablePending: 0,
          needsAttention: 0,
          persistenceFailure: false,
          nextRetryEligibleAt: null,
          oldestOutstandingAgeSec: null,
          currentIssue: 'none',
          currentIssueSince: null,
          lastSuccessfulWriteAt: null,
          emittedAt: '2026-08-15T00:00:00Z',
          activity: 'idle',
        },
      },
    });

    render(<DatabasePanel />);
    const failed = await screen.findByText("1 record couldn't upload. Use Sync now to try again.");
    expect(failed.closest('.sheets-status')).toHaveClass('is-failed');
    // One Sync now: no second retry button for failed records.
    expect(screen.getAllByRole('button', { name: /sync now/i })).toHaveLength(1);
    expect(screen.queryByText('All sync failures: 1')).not.toBeInTheDocument();
    expect(getDtrSyncHealthSnapshot()).toMatchObject({
      emittedAt: '2026-08-15T00:00:00Z',
      dead: 1,
      persistenceFailure: false,
    });
  });

  it('preserves a prior queue-persistence warning after an admin health refresh', async () => {
    setDtrSyncHealthSnapshot({
      activity: 'idle',
      queued: 0,
      retryablePending: 0,
      needsAttention: 0,
      dead: 0,
      persistenceFailure: true,
      emittedAt: '2026-08-15T00:00:00Z',
    });

    render(<DatabasePanel />);

    await screen.findByRole('region', { name: 'Google Sheets' });
    expect(getDtrSyncHealthSnapshot()?.persistenceFailure).toBe(true);
  });

  it('shows stale rows with an explicit offline indication when a refresh fails after a success', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 2,
        deadLetter: 0,
        byTable: [{ tableName: 'attendance', pending: 2 }],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
      },
    });
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: false,
      error: { message: 'network unreachable' },
    });

    render(<DatabasePanel />);

    expect(await screen.findByText('2 pending')).toBeInTheDocument();

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(await screen.findByText("Couldn't refresh the status, showing the last known one (network unreachable).")).toBeInTheDocument();
    expect(screen.getByText('attendance')).toBeInTheDocument();
    expect(screen.getByText('2 pending')).toBeInTheDocument();
  });

  it('shows the unavailable message and no rows when the first load fails', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: false,
      error: { message: 'Sync status is available in the desktop application.' },
    });

    render(<DatabasePanel />);

    expect(
      await screen.findByText('Sync status is available in the desktop application.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('InternDtr tabs')).not.toBeInTheDocument();
  });

  it('deduplicates a visibility refresh while the health request is in flight', async () => {
    let resolveFirst: (value: Awaited<ReturnType<typeof api.loadDtrSyncHealth>>) => void = () => {};
    const first = new Promise<Awaited<ReturnType<typeof api.loadDtrSyncHealth>>>((resolve) => {
      resolveFirst = resolve;
    });
    loadDtrSyncHealthSpy.mockReturnValueOnce(first);

    render(<DatabasePanel />);
    await screen.findByRole('region', { name: 'Google Sheets' });

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(loadDtrSyncHealthSpy).toHaveBeenCalledTimes(1);
    });

    resolveFirst({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
      },
    });
    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
  });

  it('refreshes sync health after Sync Intern DTR now', async () => {
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockResolvedValueOnce({
      success: true,
      internsChecked: 1,
      tabsCreated: [],
      rowsSynced: 2,
      details: [],
      errors: [],
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);
    await screen.findByRole('region', { name: 'Google Sheets' });
    const callsBefore = loadDtrSyncHealthSpy.mock.calls.length;

    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);

    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(loadDtrSyncHealthSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('keeps the Syncing badge while an overlapping background poll settles', async () => {
    // Independent verification found refreshSyncHealth downgraded the manual
    // sync state to loading/refreshing mid-flight, so the badge fell back to
    // "Not synced" while a sync was still running. A poll must not dislodge it.
    let resolveManual: (value: Awaited<ReturnType<typeof api.loadDtrSyncHealth>>) => void = () => {};
    const manual = new Promise<Awaited<ReturnType<typeof api.loadDtrSyncHealth>>>((resolve) => {
      resolveManual = resolve;
    });
    loadDtrSyncHealthSpy
      .mockResolvedValueOnce({
        success: true,
        health: {
          pending: 0,
          deadLetter: 0,
          byTable: [],
          dtrPendingCount: 0,
          dtrPendingItems: [],
          lastSyncedAt: '2026-08-15T00:00:00Z',
          lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        },
      })
      .mockReturnValueOnce(manual);

    let resolveSync: (value: Awaited<ReturnType<typeof api.syncInternDtr>>) => void = () => {};
    const syncPromise = new Promise<Awaited<ReturnType<typeof api.syncInternDtr>>>((resolve) => {
      resolveSync = resolve;
    });
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockReturnValueOnce(syncPromise);

    const user = userEvent.setup();
    render(<DatabasePanel />);
    // Initial mount load is a successful payload without the typed DTR summary.
    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();

    // Start the manual sync. It sets the syncing state SYNCHRONOUSLY, then
    // calls refreshSyncHealth which consumes the pending `manual` promise.
    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);
    await waitFor(() => {
      expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    });

    // The manual-sync refresh is still unresolved, so the badge must read
    // Syncing. This is the assertion that fails without the syncing guard.
    expect(screen.getByText('Uploading…')).toBeInTheDocument();
    expect(screen.queryByText('Not synced')).not.toBeInTheDocument();

    await act(async () => {
      resolveManual({
        success: true,
        health: {
          pending: 0,
          deadLetter: 0,
          byTable: [],
          dtrPendingCount: 0,
          dtrPendingItems: [],
          lastSyncedAt: '2026-08-15T00:00:00Z',
          lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        },
      });
    });
    expect(screen.getByText('Uploading…')).toBeInTheDocument();

    await act(async () => {
      resolveSync({ success: true, internsChecked: 1, tabsCreated: [], rowsSynced: 1, details: [], errors: [] });
    });
    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
  });

  it('does not let a background poll clear the Syncing badge (N8a)', async () => {
    let resolveSync: (value: Awaited<ReturnType<typeof api.syncInternDtr>>) => void = () => {};
    const syncPromise = new Promise<Awaited<ReturnType<typeof api.syncInternDtr>>>((resolve) => {
      resolveSync = resolve;
    });
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockReturnValueOnce(syncPromise);
    let resolveBg: (value: Awaited<ReturnType<typeof api.loadDtrSyncHealth>>) => void = () => {};
    const bgPromise = new Promise<Awaited<ReturnType<typeof api.loadDtrSyncHealth>>>((resolve) => {
      resolveBg = resolve;
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);
    expect(await screen.findByText(/^Up to date · last upload/)).toBeInTheDocument();
    // The next loadDtrSyncHealth call after mount is the background poll.
    loadDtrSyncHealthSpy.mockReturnValueOnce(bgPromise);

    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);
    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Uploading…')).toBeInTheDocument();

    // A background tick fires mid-sync and resolves healthy: badge must stay.
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(loadDtrSyncHealthSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await act(async () => {
      resolveBg({
        success: true,
        health: {
          pending: 0,
          deadLetter: 0,
          byTable: [],
          dtrPendingCount: 0,
          dtrPendingItems: [],
          lastSyncedAt: '2026-08-15T00:00:00Z',
          lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
        },
      });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByText('Uploading…')).toBeInTheDocument();

    // Finish the manual sync so the component settles: its own post-sync
    // refresh (releaseSyncing) leaves `syncing` for real.
    await act(async () => {
      resolveSync({
        success: true,
        internsChecked: 1,
        tabsCreated: [],
        rowsSynced: 1,
        details: [],
        errors: [],
      });
    });
    expect(await screen.findByText(/^Up to date · last upload/)).toBeInTheDocument();
  });

  const threeInterns = () => {
    const intern = (userId: string, fullName: string) => ({
      userId, rfidUid: `${userId}-UID`, fullName, department: null, status: 'ACTIVE' as const,
      employeeType: 'INTERN' as const, gender: null, dailyRate: null,
    });
    return [intern('A-1', 'Alex Rivera'), intern('S-2', 'Sam Santos'), intern('A-3', 'Alex Cruz')];
  };

  it('Users status reads as a sentence-case word (Active, Inactive), like Attendance corrections', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const [alex, sam, cruz] = threeInterns();
    render(<UserEditor users={[alex, { ...sam, status: 'INACTIVE' as const }, cruz]} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    const statusOf = (name: string) => within(screen.getByRole('row', { name: new RegExp(name) })).getByText(/^(Active|Inactive)$/);
    expect(statusOf('Alex Rivera')).toHaveTextContent(/^Active$/);
    expect(statusOf('Alex Rivera')).toHaveClass('status-pill', 'status-active');
    expect(statusOf('Sam Santos')).toHaveTextContent(/^Inactive$/);
    expect(statusOf('Sam Santos')).toHaveClass('status-pill', 'status-inactive');
    expect(screen.queryByText('ACTIVE')).not.toBeInTheDocument();
    expect(screen.queryByText('INACTIVE')).not.toBeInTheDocument();
  });

  it('Users header tick box selects only the users the search shows, with one count', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const user = userEvent.setup();
    render(<UserEditor users={threeInterns()} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    expect(screen.getByText('3 users')).toBeInTheDocument();
    // The tick box is the only "select all": no separate text button.
    expect(screen.queryByRole('button', { name: /select all/i })).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'Alex');
    expect(screen.getByText('2 of 3 match')).toBeInTheDocument();
    const master = screen.getByRole('checkbox', { name: 'Select all users' });
    await user.click(master);
    expect(master).toBeChecked();
    expect(within(screen.getByRole('group', { name: 'Selected users' })).getByText('2 selected')).toBeInTheDocument();

    // Unticking one leaves the header tick box half-ticked.
    await user.click(screen.getByRole('checkbox', { name: 'Select user Alex Cruz' }));
    expect(master).not.toBeChecked();
    expect(master).toHaveProperty('indeterminate', true);
  });

  it('Users selection bar shows only while rows are ticked, and Clear empties it', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const user = userEvent.setup();
    render(<UserEditor users={threeInterns()} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole('group', { name: 'Selected users' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add user/i })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select user Alex Rivera' }));
    const bar = screen.getByRole('group', { name: 'Selected users' });
    expect(within(bar).getByText('1 selected')).toBeInTheDocument();
    for (const name of ['Set active', 'Set inactive', 'Delete', 'Clear']) {
      expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
    }
    // The selection bar takes the list bar's place.
    expect(screen.queryByRole('button', { name: /add user/i })).not.toBeInTheDocument();

    await user.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(screen.queryByRole('group', { name: 'Selected users' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select user Alex Rivera' })).not.toBeChecked();
    expect(screen.getByText('3 users')).toBeInTheDocument();
    // Focus moves to the header tick box instead of being lost with the hidden bar.
    expect(screen.getByRole('checkbox', { name: 'Select all users' })).toHaveFocus();
  });

  it('Users selection bar Delete confirms before deleting the ticked users', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const deleteSpy = vi.spyOn(api, 'deleteAdminUser').mockResolvedValue({ success: true });
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<UserEditor users={threeInterns()} editing={null} setEditing={() => {}} onSaved={onSaved} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select user Alex Rivera' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select user Sam Santos' }));

    await user.click(within(screen.getByRole('group', { name: 'Selected users' })).getByRole('button', { name: 'Delete' }));
    expect(screen.getByRole('dialog', { name: 'Delete selected users?' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(deleteSpy).not.toHaveBeenCalled();
    expect(within(screen.getByRole('group', { name: 'Selected users' })).getByText('2 selected')).toBeInTheDocument();

    await user.click(within(screen.getByRole('group', { name: 'Selected users' })).getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Delete users' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(deleteSpy.mock.calls.map(([id]) => id)).toEqual(['A-1', 'S-2']);
    expect(screen.queryByRole('group', { name: 'Selected users' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all users' })).toHaveFocus();
  });

  it('Users selection bar Set inactive saves each ticked user with the new status', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const saveSpy = vi.spyOn(api, 'saveAdminUser').mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<UserEditor users={threeInterns()} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select user Sam Santos' }));
    await user.click(within(screen.getByRole('group', { name: 'Selected users' })).getByRole('button', { name: 'Set inactive' }));

    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'S-2', status: 'INACTIVE' }), 'S-2'));
    expect(saveSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Selected users' })).not.toBeInTheDocument());
  });

  it('Users search unticks users it hides, so batch actions only reach rows on screen', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const saveSpy = vi.spyOn(api, 'saveAdminUser').mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<UserEditor users={threeInterns()} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select all users' }));
    expect(within(screen.getByRole('group', { name: 'Selected users' })).getByText('3 selected')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'Alex');
    expect(within(screen.getByRole('group', { name: 'Selected users' })).getByText('2 selected')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select all users' })).toBeChecked();
    await user.click(within(screen.getByRole('group', { name: 'Selected users' })).getByRole('button', { name: 'Set inactive' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledTimes(2));
    expect(saveSpy.mock.calls.map(([, id]) => id)).toEqual(['A-1', 'A-3']);

    // Clearing the search does not bring Sam's tick back.
    await user.clear(screen.getByRole('searchbox', { name: 'Search users' }));
    expect(screen.getByRole('checkbox', { name: 'Select user Sam Santos' })).not.toBeChecked();
  });

  it('Users selection bar puts focus back on its button when a batch action partly fails', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    vi.spyOn(api, 'deleteAdminUser').mockImplementation(async (id) => ({ success: id !== 'S-2' }));
    const onSaved = vi.fn();
    const user = userEvent.setup();
    render(<UserEditor users={threeInterns()} editing={null} setEditing={() => {}} onSaved={onSaved} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select user Alex Rivera' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select user Sam Santos' }));
    const del = within(screen.getByRole('group', { name: 'Selected users' })).getByRole('button', { name: 'Delete' });
    await user.click(del);
    // The confirmation closes while Delete is disabled, so the focus first falls to the page.
    await user.click(screen.getByRole('button', { name: 'Delete users' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    // Sam could not be deleted and stays ticked for another try; the keyboard is back on Delete.
    expect(within(screen.getByRole('group', { name: 'Selected users' })).getByText('1 selected')).toBeInTheDocument();
    expect(del).toBeEnabled();
    expect(del).toHaveFocus();
  });

  it('Users selection keeps the focus where it is when the bar did not hold it', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const people = threeInterns();
    const user = userEvent.setup();
    const { rerender } = render(<UserEditor users={people} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole('checkbox', { name: 'Select user Sam Santos' }));
    act(() => screen.getByRole('checkbox', { name: 'Select user Sam Santos' }).blur());

    // Sam is removed elsewhere and the list reloads: the bar hides, but nothing pulls the focus to the tick box.
    rerender(<UserEditor users={people.filter((p) => p.userId !== 'S-2')} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    expect(await screen.findByText('2 users')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Selected users' })).not.toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it('User ID shows the example and a quiet format hint while typing, without blocking Save', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const saveSpy = vi.spyOn(api, 'saveAdminUser').mockResolvedValue({ success: true });
    const user = userEvent.setup();
    render(<UserEditor users={[]} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole('button', { name: /add user/i }));
    const userId = screen.getByLabelText(/^user id/i);
    expect(userId).toHaveAttribute('placeholder', 'e.g. APG-2026-001');
    expect(screen.queryByText('Usual format: APG-YYYY-NNN')).not.toBeInTheDocument();

    await user.type(userId, 'apg-2');
    expect(userId).toHaveValue('APG-2');
    expect(screen.getByText('Usual format: APG-YYYY-NNN')).toBeInTheDocument();
    // Read as the field's description, not as part of its name.
    expect(userId).toHaveAccessibleName('User ID');
    expect(userId).toHaveAccessibleDescription('Usual format: APG-YYYY-NNN');
    await user.type(userId, '026-001');
    expect(screen.queryByText('Usual format: APG-YYYY-NNN')).not.toBeInTheDocument();
    expect(userId).not.toHaveAttribute('aria-describedby');

    // A demo ID keeps the hint but still saves.
    await user.clear(userId);
    await user.type(userId, 'APG-DEMO-002');
    expect(screen.getByText('Usual format: APG-YYYY-NNN')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/rfid uid/i), 'RFID-9');
    await user.type(screen.getByLabelText(/full name/i), 'Juan Dela Cruz');
    await user.click(screen.getByRole('button', { name: 'Save user' }));
    await waitFor(() => expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ userId: 'APG-DEMO-002' }), undefined));
  });

  it('User ID hint stays off for admin RFID cards and for a record being edited', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const [alex] = threeInterns();
    const user = userEvent.setup();
    const { unmount } = render(<UserEditor users={[]} editing={null} setEditing={() => {}} onSaved={() => {}} />);
    await user.click(screen.getByRole('button', { name: /add user/i }));
    await user.click(screen.getByRole('radio', { name: /admin rfid card/i }));
    await user.type(screen.getByLabelText(/identifier \/ user id/i), 'FRONT-DESK');
    expect(screen.queryByText('Usual format: APG-YYYY-NNN')).not.toBeInTheDocument();
    unmount();

    // A-1 is not the usual format, but an existing ID is locked and fine as it is.
    render(<UserEditor users={[alex]} editing={alex} setEditing={() => {}} onSaved={() => {}} />);
    expect(await screen.findByLabelText(/^user id/i)).toHaveValue('A-1');
    expect(screen.queryByText('Usual format: APG-YYYY-NNN')).not.toBeInTheDocument();
  });

  it('caps the users list, with See all to lift the cap', async () => {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    class FakeResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // The cap itself is a stylesheet max-height; the user rows need 900px but only 500px fit.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(900);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(500);
    const intern = (userId: string, fullName: string) => ({
      userId, rfidUid: `${userId}-UID`, fullName, department: null, status: 'ACTIVE' as const,
      employeeType: 'INTERN' as const, gender: null, dailyRate: null,
    });

    try {
      render(
        <UserEditor
          users={[intern('A-1', 'Alex Rivera'), intern('S-2', 'Sam Santos'), intern('A-3', 'Alex Cruz')]}
          editing={null}
          setEditing={() => {}}
          onSaved={() => {}}
        />,
      );

      const usersSection = screen.getByRole('searchbox', { name: 'Search users' }).closest('section');
      expect(usersSection).toHaveClass('is-capped');

      const user = userEvent.setup();
      // The toggle no longer repeats the count shown beside it.
      await user.click(screen.getByRole('button', { name: 'See all' }));
      expect(usersSection).not.toHaveClass('is-capped');

      await user.click(screen.getByRole('button', { name: 'Show fewer' }));
      expect(usersSection).toHaveClass('is-capped');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shared guard disables Data Sync-now, Users bulk and per-row buttons while progress advances (task 9)', async () => {
    const handlers: Array<(payload: tauriApi.DtrSyncProgress) => void> = [];
    vi.spyOn(tauriApi, 'listenForDtrSyncProgress').mockImplementation((handler) => {
      handlers.push(handler);
      return Promise.resolve(() => {});
    });
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    let resolveSync: (value: Awaited<ReturnType<typeof api.syncInternDtr>>) => void = () => {};
    const syncPromise = new Promise<Awaited<ReturnType<typeof api.syncInternDtr>>>((resolve) => {
      resolveSync = resolve;
    });
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockReturnValueOnce(syncPromise);

    const user = userEvent.setup();
    render(<DatabasePanel />);
    render(
      <UserEditor
        users={[
          {
            userId: 'APG-2026-103',
            rfidUid: 'ABCDEF1234',
            fullName: 'Juan Dela Cruz',
            department: null,
            status: 'ACTIVE',
            employeeType: 'INTERN',
            gender: null,
            dailyRate: null,
          },
        ]}
        editing={null}
        setEditing={() => {}}
        onSaved={() => {}}
      />,
    );

    const dataSyncBtn = await screen.findByTestId('dtr-sync-now');
    const bulkBtn = await screen.findByTestId('dtr-sync-bulk');
    const rowBtn = await screen.findByTestId('dtr-sync-row-APG-2026-103');
    expect(dataSyncBtn).toBeEnabled();
    expect(bulkBtn).toBeEnabled();
    expect(rowBtn).toBeEnabled();

    await user.click(dataSyncBtn);
    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);

    // Single shared guard disables all three surfaces mid-sync.
    await waitFor(() => {
      expect(screen.getByTestId('dtr-sync-now')).toBeDisabled();
      expect(screen.getByTestId('dtr-sync-bulk')).toBeDisabled();
      expect(screen.getByTestId('dtr-sync-row-APG-2026-103')).toBeDisabled();
    });

    act(() => {
      for (const handler of handlers) {
        handler({
          current: 0,
          total: 10,
          userId: '',
          fullName: '',
          status: 'starting',
          source: 'manual',
        });
      }
    });
    const bars = await screen.findAllByRole('progressbar', { name: /intern dtr sync progress/i });
    expect(bars.length).toBeGreaterThan(0);
    for (const bar of bars) {
      expect(bar).toHaveAttribute('aria-valuenow', '0');
    }
    // Plain progress words; the Queue/Manual capsule is gone from Data and backup.
    expect(await screen.findByText('Uploading 0 of 10…')).toBeInTheDocument();
    expect(screen.queryByText('Manual')).not.toBeInTheDocument();

    act(() => {
      for (const handler of handlers) {
        handler({
          current: 3,
          total: 10,
          userId: 'APG-2026-103',
          fullName: 'Juan Dela Cruz',
          status: 'syncing',
          source: 'queue',
        });
      }
    });
    await waitFor(() => {
      const updated = screen.getAllByRole('progressbar', { name: /intern dtr sync progress/i });
      for (const bar of updated) {
        expect(bar).toHaveAttribute('aria-valuenow', '30');
      }
    });
    expect(await screen.findByText('Uploading 3 of 10…')).toBeInTheDocument();
    expect(screen.queryByText('Queue')).not.toBeInTheDocument();

    await act(async () => {
      resolveSync({
        success: true,
        internsChecked: 10,
        tabsCreated: [],
        rowsSynced: 25,
        details: [],
        errors: [],
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('dtr-sync-now')).toBeEnabled();
      expect(screen.getByTestId('dtr-sync-bulk')).toBeEnabled();
      expect(screen.getByTestId('dtr-sync-row-APG-2026-103')).toBeEnabled();
    });
  });
  it('lets the manual sync resolution leave the Syncing badge (N8b)', async () => {
    // A blanket `if (syncing) return prev` completion guard would strand the
    // badge here: this test pins the exit path the N8 fix must keep.
    vi.spyOn(api, 'syncInternDtr').mockResolvedValueOnce({
      success: true,
      internsChecked: 1,
      tabsCreated: [],
      rowsSynced: 1,
      details: [],
      errors: [],
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);
    expect(await screen.findByText(/^Up to date · last upload/)).toBeInTheDocument();

    const syncBtn = await screen.findByRole('button', { name: /^sync now$/i });
    await user.click(syncBtn);
    expect(await screen.findByText(/^Upload finished/)).toBeInTheDocument();
    expect(await screen.findByText(/^Up to date · last upload/)).toBeInTheDocument();
    expect(screen.queryByText('Uploading…')).not.toBeInTheDocument();
  });

  it('parses the task-10 health extension fields from the native payload', async () => {
    loadDtrSyncHealthSpy.mockRestore();
    const syncStatusSpy = vi.spyOn(tauriApi.tauriApi, 'syncStatus').mockResolvedValueOnce({
      success: true,
      pending: 4,
      deadLetter: 0,
      byTable: [],
      dtrPending: { count: 0, items: [] },
      lastSyncedAt: '2026-08-15T00:00:00Z',
      lastError: null,
      throttledUntil: '2026-09-18T01:00:00+00:00',
      lastThrottleReason: 'DTR_THROTTLE: 50-writes/min budget spent',
      inProgress: { owner: 'admin_sync_now', startedAt: '2026-09-18T00:59:00+00:00' },
      leaseRecovered: 2,
      oldestRetryableAgeSec: 25000,
      pendingAgeAlert: true,
    });
    const result = await api.loadDtrSyncHealth();
    expect(syncStatusSpy).toHaveBeenCalledTimes(1);
    if (!result.success) throw new Error('expected health parse to succeed');
    expect(result.health.throttledUntil).toBe('2026-09-18T01:00:00+00:00');
    expect(result.health.lastThrottleReason).toBe('DTR_THROTTLE: 50-writes/min budget spent');
    expect(result.health.inProgress).toEqual({ owner: 'admin_sync_now', startedAt: '2026-09-18T00:59:00+00:00' });
    expect(result.health.leaseRecovered).toBe(2);
    expect(result.health.oldestRetryableAgeSec).toBe(25000);
    expect(result.health.pendingAgeAlert).toBe(true);
  });

  it('renders throttled + in-progress health states in the Data card', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 4,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
        throttledUntil: '2026-09-18T01:00:00+00:00',
        lastThrottleReason: 'DTR_THROTTLE: 50-writes/min budget spent',
        inProgress: { owner: 'admin_sync_now', startedAt: '2026-09-18T00:59:00+00:00' },
        leaseRecovered: 2,
        oldestRetryableAgeSec: 25000,
        pendingAgeAlert: true,
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByText(/Throttled until/i)).toBeInTheDocument();
    expect(screen.getByText(/50-writes\/min budget spent/)).toBeInTheDocument();
    expect(screen.getByText(/admin_sync_now/)).toBeInTheDocument();
    expect(screen.getByText('Lease recovered').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText(/oldest retryable/i)).toBeInTheDocument();
  });

  it('renders Ready nulls as idle with no throttle or progress rows', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 0,
        deadLetter: 0,
        byTable: [],
        dtrPendingCount: 0,
        dtrPendingItems: [],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
        throttledUntil: null,
        lastThrottleReason: null,
        inProgress: null,
        leaseRecovered: 0,
        oldestRetryableAgeSec: null,
        pendingAgeAlert: false,
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByText('Status unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Throttled until/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/in progress/i)).not.toBeInTheDocument();
  });
});

describe('SystemPanel', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is one flat "This PC" card: version and updates, startup, one card reader line, and a closed support fold', async () => {
    vi.spyOn(api, 'loadDatabaseInfo').mockResolvedValue(mockDbInfo);
    vi.spyOn(api, 'getAutostartStatus').mockResolvedValue(false);
    const onManualUpdateCheck = vi.fn();
    const user = userEvent.setup();
    render(<SystemPanel onManualUpdateCheck={onManualUpdateCheck} />);

    const card = screen.getByRole('region', { name: 'This PC' });
    // No kicker, intro sentence or boxed sub-sections: the controls come straight after the title.
    expect(within(card).queryByText(/^system$/i)).not.toBeInTheDocument();
    expect(within(card).queryAllByRole('region')).toHaveLength(0);
    expect(within(card).getByText('Version: desktop app only')).toBeInTheDocument();
    expect(within(card).getByRole('checkbox', { name: 'Check for updates automatically' })).toBeInTheDocument();
    expect(within(card).getByRole('checkbox', { name: 'Open the attendance screen when you log in' })).toBeDisabled();
    // One reader line, with no page-open time passed off as a scan.
    const reader = within(card).getByText('Card reader:', { exact: false });
    expect(reader).toHaveTextContent('Card reader: Only in the desktop app');
    expect(within(card).queryByText(/last activity/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /check for updates now/i }));
    expect(onManualUpdateCheck).toHaveBeenCalledTimes(1);

    // Paths and storage mode sit inside the fold, which starts closed; no developer lines at all.
    const fold = screen.getByText('Technical details (for support)').closest('details');
    expect(fold).not.toBeNull();
    expect(fold).not.toHaveAttribute('open');
    expect(await within(fold!).findByText(mockDbInfo.dbPath)).toBeInTheDocument();
    expect(within(fold!).getByText(mockDbInfo.backupDir)).toBeInTheDocument();
    expect(within(fold!).getByText('Installed — app data folder')).toBeInTheDocument();
    expect(screen.queryByText(/config\.toml|Deign86|github/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/pending restore/i)).not.toBeInTheDocument();

    await user.click(screen.getByText('Technical details (for support)'));
    expect(fold).toHaveAttribute('open');
  });

  it("shows the reader as ready, with the last scan from today's attendance when there is one", async () => {
    vi.spyOn(api, 'loadDatabaseInfo').mockResolvedValue(mockDbInfo);
    vi.spyOn(api, 'getAutostartStatus').mockResolvedValue(false);
    vi.spyOn(tauriApi, 'getScannerStatus').mockResolvedValue({ state: 'connected', message: 'Waiting for card', detail: null, mode: 'keyboard', paused: false });
    // SAFETY: Minimal desktop-layer mock so the panel reads the reader like the desktop app
    (window as typeof window & { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__ = { invoke: vi.fn(async () => null) };
    try {
      const { rerender } = render(<SystemPanel onManualUpdateCheck={vi.fn()} />);
      const reader = await screen.findByText('Ready');
      // No time today yet: just the reader, no made-up scan time.
      expect(reader.closest('p')).toHaveTextContent(/^Card reader: Ready$/);

      rerender(<SystemPanel onManualUpdateCheck={vi.fn()} lastScanAt="2026-10-30T16:52:00+08:00" />);
      expect(reader.closest('p')).toHaveTextContent('Card reader: Ready · Last scan 4:52 PM');
    } finally {
      // SAFETY: Cleaning up the desktop-layer mock from window
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });
});
