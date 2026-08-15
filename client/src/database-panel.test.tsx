import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatabasePanel } from './App';
import * as api from './api';
import type { DatabaseInfoResponse } from '@rfid-attendance/shared';
import * as dialog from '@tauri-apps/plugin-dialog';

vi.mock('./api', async () => {
  const actual = await vi.importActual<typeof import('./api')>('./api');
  return {
    ...actual,
    loadDatabaseInfo: vi.fn(),
    createDatabaseBackup: vi.fn(),
    requestDatabaseRestore: vi.fn(),
    openDatabaseBackupsFolder: vi.fn(),
  };
});

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

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
  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {};
    vi.mocked(api.loadDatabaseInfo).mockResolvedValue(mockDbInfo);
  });

  it('renders database path, storage mode, and existing backups', async () => {
    render(<DatabasePanel />);

    expect(await screen.findByText('Move the attendance database to a new computer')).toBeInTheDocument();
    expect(screen.getByText('Installed — app data folder')).toBeInTheDocument();
    expect(screen.getByText('attendance-backup-20260815-000000.apbackup')).toBeInTheDocument();
    expect(screen.getByText('1024 KB')).toBeInTheDocument();
  });

  it('handles Create backup now action successfully', async () => {
    vi.mocked(api.createDatabaseBackup).mockResolvedValueOnce({
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

    expect(api.createDatabaseBackup).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(/Backup created: attendance-backup-20260815-010000.apbackup/i)).toBeInTheDocument();
  });

  it('displays error when backup creation fails', async () => {
    vi.mocked(api.createDatabaseBackup).mockResolvedValueOnce({
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
    vi.mocked(api.openDatabaseBackupsFolder).mockResolvedValueOnce({
      ok: true,
      message: 'Backup folder opened.',
    });

    const user = userEvent.setup();
    render(<DatabasePanel />);

    const openBtn = await screen.findByRole('button', { name: /open backups folder/i });
    await user.click(openBtn);

    expect(api.openDatabaseBackupsFolder).toHaveBeenCalledTimes(1);
  });

  it('handles Restore from backup file flow with confirmation', async () => {
    vi.mocked(dialog.open).mockResolvedValueOnce('C:\\backups\\attendance-backup-20260815-000000.apbackup');
    vi.mocked(api.requestDatabaseRestore).mockResolvedValueOnce({
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

    expect(api.requestDatabaseRestore).toHaveBeenCalledWith('C:\\backups\\attendance-backup-20260815-000000.apbackup');
    expect(await screen.findByText(/Restore scheduled/i)).toBeInTheDocument();
  });

  it('allows canceling the restore dialog without scheduling', async () => {
    vi.mocked(dialog.open).mockResolvedValueOnce('C:\\backups\\test.apbackup');

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
    expect(api.requestDatabaseRestore).not.toHaveBeenCalled();
  });
});
