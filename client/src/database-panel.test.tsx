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

  beforeEach(() => {
    // SAFETY: Setting global Tauri mock interface for test environment
    const win = window as typeof window & { __TAURI_INTERNALS__?: object };
    win.__TAURI_INTERNALS__ = {};

    loadDatabaseInfoSpy = vi.spyOn(api, 'loadDatabaseInfo').mockResolvedValue(mockDbInfo);
    createDatabaseBackupSpy = vi.spyOn(api, 'createDatabaseBackup');
    requestDatabaseRestoreSpy = vi.spyOn(api, 'requestDatabaseRestore');
    openDatabaseBackupsFolderSpy = vi.spyOn(api, 'openDatabaseBackupsFolder');
    pickRestoreBackupFileSpy = vi.spyOn(api, 'pickRestoreBackupFile');
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
});
