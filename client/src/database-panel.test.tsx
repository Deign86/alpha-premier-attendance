import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatabasePanel, UserEditor } from './App';
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
    await user.click(await screen.findByRole('button', { name: /sync intern dtr now/i }));
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
    expect(screen.getByText(/Syncing intern 1 of 2: Failed Intern/)).toBeInTheDocument();
    await act(async () => {
      resolveResumed?.({ success: true, internsChecked: 2, tabsCreated: [], rowsSynced: 3, details: [], errors: [] });
    });
    expect(await screen.findByText(/DTR sync complete: checked 2 intern\(s\), synced 3 row\(s\)\./)).toBeInTheDocument();
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
    await user.click(await screen.findByRole('button', { name: /sync intern dtr now/i }));
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
        'BACKFILL_FAILED: Maricon Danao (APG-2026-116): permission denied',
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
    expect(errorsAlert).toHaveTextContent(/BACKFILL_FAILED: Maricon Danao \(APG-2026-116\): permission denied/i);
    expect(screen.getByText(/Synced 2 row\(s\), but encountered errors:/i)).toBeInTheDocument();
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

    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
    await user.click(syncBtn);

    expect(screen.getByText('Syncing…')).toBeInTheDocument();

    act(() => {
      progressHandler?.({
        current: 3,
        total: 10,
        userId: 'APG-2026-103',
        fullName: 'Juan Dela Cruz',
        status: 'syncing',
      });
    });

    expect(await screen.findByText(/Syncing intern 3 of 10: Juan Dela Cruz/i)).toBeInTheDocument();
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

    expect(await screen.findByText(/DTR sync complete: checked 10 intern\(s\), synced 25 row\(s\)\./i)).toBeInTheDocument();
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

    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
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
        dtrPendingItems: [{ userId: 'APG-2026-116', fullName: 'Maricon C. Danao', attempts: 1, lastChecked: null }],
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

    expect(await screen.findByLabelText('DTR sync status')).toBeInTheDocument();
    expect(await screen.findByText('DTR status unavailable')).toBeInTheDocument();
    expect(screen.getByText('attendance')).toBeInTheDocument();
    expect(screen.getByText('2 pending')).toBeInTheDocument();
    expect(screen.getByText('InternDtr tabs')).toBeInTheDocument();
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a tab: Maricon C\. Danao/)).toBeInTheDocument();
    expect(loadDtrSyncHealthSpy).toHaveBeenCalled();
  });

  it('labels DTR health separately and reports global ops DEAD items', async () => {
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

    expect(await screen.findByText('DTR idle')).toBeInTheDocument();
    expect(screen.getByText('All sync failures: 1')).toBeInTheDocument();
    expect(screen.getByLabelText('DTR-only sync status')).toHaveTextContent('DTR idle');
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

    expect(await screen.findByText('DTR status unavailable. Attendance continues to save locally.')).toBeInTheDocument();
    expect(screen.queryByText('Sheet syncing paused; attendance recording continues.')).not.toBeInTheDocument();
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
    expect(await screen.findByText(/2 punches are waiting for retry/)).toBeInTheDocument();
    expect(screen.getByText(/Retry attempts are bounded/)).toBeInTheDocument();
    expect(screen.getByText(/Next retry eligibility:/)).toBeInTheDocument();
    expect(screen.queryByText(/next attempt|automatic delivery/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/need admin (?:help|attention)/i)).not.toBeInTheDocument();
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
    expect(await screen.findByText('Punches need admin attention before they can sync.')).toBeInTheDocument();
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
    expect(await screen.findByText('DTR attention')).toBeInTheDocument();
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

    await screen.findByLabelText('DTR sync status');
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

    expect(await screen.findByText(/showing last known data \(network unreachable\)/i)).toBeInTheDocument();
    expect(screen.getByText('DTR status update delayed')).toBeInTheDocument();
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
      await screen.findByText(/DTR status unavailable — Sync status is available in the desktop application\./),
    ).toBeInTheDocument();
    expect(screen.getByText('DTR status unavailable')).toBeInTheDocument();
    expect(screen.queryByText('InternDtr tabs')).not.toBeInTheDocument();
  });

  it('deduplicates a visibility refresh while the health request is in flight', async () => {
    let resolveFirst: (value: Awaited<ReturnType<typeof api.loadDtrSyncHealth>>) => void = () => {};
    const first = new Promise<Awaited<ReturnType<typeof api.loadDtrSyncHealth>>>((resolve) => {
      resolveFirst = resolve;
    });
    loadDtrSyncHealthSpy.mockReturnValueOnce(first);

    render(<DatabasePanel />);
    await screen.findByLabelText('DTR sync status');

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
    expect(await screen.findByText('DTR status unavailable')).toBeInTheDocument();
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
    expect(await screen.findByText('DTR status unavailable')).toBeInTheDocument();

    // Start the manual sync. It sets the syncing state SYNCHRONOUSLY, then
    // calls refreshSyncHealth which consumes the pending `manual` promise.
    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
    await user.click(syncBtn);
    await waitFor(() => {
      expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    });

    // The manual-sync refresh is still unresolved, so the badge must read
    // Syncing. This is the assertion that fails without the syncing guard.
    expect(screen.getByText('Syncing…')).toBeInTheDocument();
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
    expect(screen.getByText('Syncing…')).toBeInTheDocument();

    await act(async () => {
      resolveSync({ success: true, internsChecked: 1, tabsCreated: [], rowsSynced: 1, details: [], errors: [] });
    });
    expect(await screen.findByText('DTR status unavailable')).toBeInTheDocument();
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
    expect(await screen.findByText('DTR idle')).toBeInTheDocument();
    // The next loadDtrSyncHealth call after mount is the background poll.
    loadDtrSyncHealthSpy.mockReturnValueOnce(bgPromise);

    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
    await user.click(syncBtn);
    expect(syncInternDtrSpy).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Syncing…')).toBeInTheDocument();

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
    expect(screen.getByText('Syncing…')).toBeInTheDocument();

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
    expect(await screen.findByText('DTR idle')).toBeInTheDocument();
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
    expect(await screen.findAllByText('Manual')).not.toHaveLength(0);

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
    expect(await screen.findAllByText('Queue')).not.toHaveLength(0);

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
    expect(await screen.findByText('DTR idle')).toBeInTheDocument();

    const syncBtn = await screen.findByRole('button', { name: /sync intern dtr now/i });
    await user.click(syncBtn);
    expect(await screen.findByText(/DTR sync complete/i)).toBeInTheDocument();
    expect(await screen.findByText('DTR idle')).toBeInTheDocument();
    expect(screen.queryByText('Syncing…')).not.toBeInTheDocument();
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
    expect(screen.getByText(/lease recovered: 2/i)).toBeInTheDocument();
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

    expect(await screen.findByText('DTR status unavailable')).toBeInTheDocument();
    expect(screen.queryByText(/Throttled until/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/in progress/i)).not.toBeInTheDocument();
  });
});
