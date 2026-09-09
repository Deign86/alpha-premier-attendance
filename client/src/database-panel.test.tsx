import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatabasePanel } from './App';
import * as api from './api';
import type { DatabaseInfoResponse } from '@rfid-attendance/shared';

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
      },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // SAFETY: Cleaning up mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('renders database path, storage mode, and existing backups', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByText('Move the attendance database to a new computer')).toBeInTheDocument();
    expect(screen.getByText('Installed — app data folder')).toBeInTheDocument();
    expect(screen.getByText('attendance-backup-20260815-000000.apbackup')).toBeInTheDocument();
    expect(screen.getByText('1024 KB')).toBeInTheDocument();
    expect(loadDatabaseInfoSpy).toHaveBeenCalled();
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
    render(<DatabasePanel />);

    const backupBtn = await screen.findByRole('button', { name: /create backup now/i });
    await user.click(backupBtn);

    expect(createDatabaseBackupSpy).toHaveBeenCalledTimes(1);
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

    const confirmBtn = screen.getByRole('button', { name: /confirm/i });
    await user.click(confirmBtn);

    expect(requestDatabaseRestoreSpy).toHaveBeenCalledWith('C:\\backups\\attendance-backup-20260815-000000.apbackup');
    expect(await screen.findByText(/Restore scheduled/i)).toBeInTheDocument();
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

  it('triggers Sync Intern DTR now and displays result', async () => {
    const syncInternDtrSpy = vi.spyOn(api, 'syncInternDtr').mockResolvedValueOnce({
      success: true,
      internsChecked: 1,
      tabsCreated: ['Maricon C. Danao'],
      rowsSynced: 4,
      details: [
        {
          userId: 'APG-2026-116',
          fullName: 'Maricon C. Danao',
          tab: 'Maricon C. Danao',
          tabCreated: true,
          rowsSynced: 4,
          status: 'SYNCED',
        },
      ],
      errors: [],
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
    await user.click(syncBtn);

    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/DTR sync complete: checked 1 intern\(s\), synced 4 row\(s\) \(1 new tab\(s\) created: Maricon C\. Danao\)\./i)).toBeInTheDocument();
  });

  it('shows live DTR sync health with per-table pending rows', async () => {
    loadDtrSyncHealthSpy.mockResolvedValueOnce({
      success: true,
      health: {
        pending: 2,
        deadLetter: 0,
        byTable: [{ tableName: 'attendance', pending: 2 }],
        dtrPendingCount: 1,
        dtrPendingItems: [{ userId: 'APG-2026-116', fullName: 'Maricon C. Danao', attempts: 1, lastChecked: null }],
        lastSyncedAt: '2026-08-15T00:00:00Z',
        lastError: null,
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByLabelText('DTR sync status')).toBeInTheDocument();
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('attendance')).toBeInTheDocument();
    expect(screen.getByText('2 pending')).toBeInTheDocument();
    expect(screen.getByText('InternDtr tabs')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a tab: Maricon C\. Danao/)).toBeInTheDocument();
    expect(loadDtrSyncHealthSpy).toHaveBeenCalled();
  });

  it('flags failed sync items as Attention with the last error', async () => {
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
      },
    });

    render(<DatabasePanel />);

    expect(await screen.findByText('Attention')).toBeInTheDocument();
    expect(await screen.findByText(/Last error: Google Sheets auth failed: expired token/)).toBeInTheDocument();
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
    await screen.findByLabelText('DTR sync status');
    const callsBefore = loadDtrSyncHealthSpy.mock.calls.length;

    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
    await user.click(syncBtn);

    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(loadDtrSyncHealthSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });
});
