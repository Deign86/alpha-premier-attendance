import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InternPayslip, VoiceClipState } from '@rfid-attendance/shared';
import { tauriApi } from './tauri-api';
import { checkAdminSession, createAdminBackdatedAttendance, generateInternPayslipImages, generatePayrollPdf, loadDtrSyncHealth, lockAdmin, openGeneratedFile, pollVoiceClipReady, revealGeneratedFile, saveAdminAttendance, setupErrorFrom, submitScan, unlockAdmin, unlockSetup, updateBathroomLog } from './api';
import * as payslipRenderer from './intern-payslip-image';
import type { NativeSyncStatusResponse } from './tauri-api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('scan requests', () => {
  it('returns the scan response once the service responds', async () => {
    // SAFETY: Mock Response object for fetch
    const mockResponse = {
      ok: true,
      json: async () => ({ success: true, requestId: 'req-1', action: 'TIME_OUT' }),
    } as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    await expect(submitScan({ rfidUid: 'RFID-001', source: 'RFID' })).resolves.toMatchObject({ success: true });
  });

  it('returns a network error when the service is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(submitScan({ rfidUid: 'RFID-002', source: 'RFID' })).resolves.toMatchObject({
      success: true,
      offlineQueued: true,
    });
  });
});

describe('DTR sync health parsing', () => {
  it('preserves Rust summary retry count, persistence flag, and timestamp', async () => {
    const emittedAt = '2026-10-03T08:15:00Z';
    const response: NativeSyncStatusResponse = {
      success: true,
      pending: 0,
      deadLetter: 0,
      byTable: [],
      dtrPending: { count: 0, items: [] },
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
        retrying: 3,
        processing: 0,
        dead: 1,
        retryablePending: 3,
        needsAttention: 0,
        persistenceFailure: true,
        nextRetryEligibleAt: null,
        oldestOutstandingAgeSec: null,
        currentIssue: 'persistence',
        currentIssueSince: emittedAt,
        lastSuccessfulWriteAt: null,
        activity: 'retrying',
        emittedAt,
      },
    };
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.spyOn(tauriApi, 'syncStatus').mockResolvedValueOnce(response);

    const result = await loadDtrSyncHealth();

    expect(result).toMatchObject({
      success: true,
      health: { dtr: { retryablePending: 3, persistenceFailure: true, emittedAt } },
    });
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

describe('generated file actions', () => {
  it('opens a generated file through the native command', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const spy = vi.spyOn(tauriApi, 'openGeneratedFile').mockResolvedValueOnce({ success: true, message: 'File opened.' });
    const result = await openGeneratedFile('C:\\Data\\exports\\payroll-2026-08-04.csv');
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith('', 'C:\\Data\\exports\\payroll-2026-08-04.csv');
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('maps a missing file to a friendly message', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.spyOn(tauriApi, 'revealGeneratedFile').mockRejectedValueOnce('FILE_NOT_FOUND');
    const result = await revealGeneratedFile('C:\\Data\\exports\\gone.csv');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The file could not be found. It may have been moved or deleted.');
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('returns a desktop-only message in web mode', async () => {
    const result = await openGeneratedFile('C:\\whatever.csv');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('File actions are available in the desktop application.');
  });
});

describe('setupErrorFrom', () => {
  it('turns a genuine session failure into a clear expired/replaced message', () => {
    expect(setupErrorFrom('SETUP_AUTH_REQUIRED', 'SETUP_AUTH_REQUIRED')).toMatchObject({
      success: false,
      error: { code: 'SETUP_AUTH_REQUIRED', message: expect.stringContaining('expired or was replaced') },
    });
  });

  it('passes through real backend errors instead of masking them as auth failures', () => {
    expect(setupErrorFrom('USER_CONFLICT', 'SETUP_AUTH_REQUIRED')).toMatchObject({
      success: false,
      error: { code: 'USER_CONFLICT', message: expect.stringContaining('already in use') },
    });
    expect(setupErrorFrom('SETUP_VALIDATION_ERROR', 'SETUP_AUTH_REQUIRED')).toMatchObject({
      success: false,
      error: { code: 'SETUP_VALIDATION_ERROR' },
    });
  });

  it('surfaces unknown backend errors verbatim so the real cause is visible', () => {
    expect(setupErrorFrom('no such column: gender', 'SETUP_AUTH_REQUIRED')).toMatchObject({
      success: false,
      error: { code: 'SETUP_AUTH_REQUIRED', message: 'no such column: gender' },
    });
  });

  it('uses the fallback message when no backend detail is available', () => {
    expect(setupErrorFrom(undefined, 'SETUP_AUTH_REQUIRED')).toMatchObject({
      success: false,
      error: { code: 'SETUP_AUTH_REQUIRED', message: 'The setup request could not be completed.' },
    });
  });
});

describe('createAdminBackdatedAttendance', () => {
  it('handles successful creation in Tauri desktop mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const spy = vi.spyOn(tauriApi, 'adminCreateBackdatedAttendance').mockResolvedValueOnce({
      success: true,
      attendance: {
        attendanceId: 'att-123',
        attendanceDate: '2026-08-20',
        userId: 'u1',
        fullName: 'Alice Cooper',
        timeIn: '2026-08-20T08:00:00+08:00',
        timeOut: '2026-08-20T17:00:00+08:00',
        status: 'COMPLETED',
        source: 'ADMIN_BACKDATED_ENTRY',
      },
    });

    const result = await createAdminBackdatedAttendance({
      userId: 'u1',
      attendanceDate: '2026-08-20',
      timeIn: '2026-08-20T08:00:00+08:00',
      timeOut: '2026-08-20T17:00:00+08:00',
      reason: 'Physical timecard verified',
    });

    expect(result.success).toBe(true);
    expect(result.attendance?.attendanceId).toBe('att-123');
    expect(spy).toHaveBeenCalled();
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('maps known backend errors to friendly messages in Tauri mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.spyOn(tauriApi, 'adminCreateBackdatedAttendance').mockRejectedValueOnce('ATTENDANCE_ALREADY_EXISTS_FOR_DATE');

    const result = await createAdminBackdatedAttendance({
      userId: 'u1',
      attendanceDate: '2026-08-20',
      timeIn: '2026-08-20T08:00:00+08:00',
      reason: 'Physical timecard verified',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('An attendance record already exists for this employee on this date');
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

describe('updateBathroomLog', () => {
  it('updates bathroom log via tauriApi in desktop mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const spy = vi.spyOn(tauriApi, 'bathroomUpdateLog').mockResolvedValueOnce({
      success: true,
      entry: {
        logId: 'bath-1',
        logDate: '2026-08-31',
        userId: 'u1',
        fullName: 'Ramil C. Roque',
        department: 'IT/ Marketing Associate',
        genderKey: 'MALE',
        timeOut: '2026-08-31T10:00:00+08:00',
        timeIn: '2026-08-31T10:15:00+08:00',
        durationSeconds: 900,
        status: 'RETURNED',
        notes: 'Forgot to tap back in',
        createdAt: '2026-08-31T10:00:00+08:00',
        updatedAt: '2026-08-31T10:15:00+08:00',
      },
    });

    const result = await updateBathroomLog('bath-1', {
      timeOut: '2026-08-31T10:00:00+08:00',
      timeIn: '2026-08-31T10:15:00+08:00',
      notes: 'Forgot to tap back in',
    });

    expect(result.success).toBe(true);
    expect(result.entry?.status).toBe('RETURNED');
    expect(spy).toHaveBeenCalledWith('', 'bath-1', {
      timeOut: '2026-08-31T10:00:00+08:00',
      timeIn: '2026-08-31T10:15:00+08:00',
      notes: 'Forgot to tap back in',
    });
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('maps Tauri errors to failure response', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.spyOn(tauriApi, 'bathroomUpdateLog').mockRejectedValueOnce('Time-in (return) cannot precede time-out (checkout).');

    const result = await updateBathroomLog('bath-1', {
      timeOut: '2026-08-31T10:15:00+08:00',
      timeIn: '2026-08-31T10:00:00+08:00',
    });

    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('Time-in (return) cannot precede time-out (checkout).');
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('falls back to fetch in web mode', async () => {
    // SAFETY: Mock Response object for fetch
    const mockResponse = {
      ok: true,
      json: async () => ({
        success: true,
        entry: {
          logId: 'bath-1',
          logDate: '2026-08-31',
          userId: 'u1',
          fullName: 'Ramil C. Roque',
          genderKey: 'MALE',
          timeOut: '2026-08-31T10:00:00+08:00',
          timeIn: '2026-08-31T10:15:00+08:00',
          durationSeconds: 900,
          status: 'RETURNED',
          notes: 'Forgot to tap back in',
          createdAt: '2026-08-31T10:00:00+08:00',
          updatedAt: '2026-08-31T10:15:00+08:00',
        },
      }),
    } as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);

    const result = await updateBathroomLog('bath-1', {
      timeOut: '2026-08-31T10:00:00+08:00',
      timeIn: '2026-08-31T10:15:00+08:00',
    });

    expect(result.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/api/admin/bathroom/bath-1'),
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});

describe('admin session lifecycle', () => {
  it('unlocks and returns ISO expiresAt in Tauri mode', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const expiresAt = '2026-09-08T18:00:00.000Z';
    vi.spyOn(tauriApi, 'setupUnlock').mockResolvedValueOnce({
      success: true,
      token: 'admin-uuid-token-1234',
      expiresAt,
    });
    vi.spyOn(tauriApi, 'adminGetSession').mockResolvedValueOnce({
      token: 'admin-uuid-token-1234',
      expiresAt,
      role: 'admin',
    });
    vi.spyOn(tauriApi, 'setupLock').mockResolvedValueOnce({ success: true });

    const unlockResult = await unlockAdmin('test-pin');
    expect(unlockResult.success).toBe(true);
    if (unlockResult.success) {
      expect(unlockResult.expiresAt).toBe(expiresAt);
    }

    const sessionResult = await checkAdminSession();
    expect(sessionResult).toBe(expiresAt);

    await lockAdmin();
    const afterLock = await checkAdminSession();
    expect(afterLock).toBeNull();

    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

describe('pollVoiceClipReady', () => {
  const clip = (jobStatus: string | null, workerClip = false): VoiceClipState => ({
    personId: 'u-voice',
    workerClip,
    jobStatus,
  });

  it('resolves ready once the job reads DONE and streams snapshots', async () => {
    const snapshots: Array<VoiceClipState[]> = [];
    const load = vi.fn()
      .mockResolvedValueOnce([clip('PENDING')])
      .mockResolvedValueOnce([clip('PROCESSING')])
      .mockResolvedValueOnce([clip('DONE', true)]);
    const outcome = await pollVoiceClipReady('u-voice', {
      load,
      onSnapshot: (states) => { snapshots.push(states); },
      intervalMs: 5,
      timeoutMs: 500,
    });
    expect(outcome).toBe('ready');
    expect(load).toHaveBeenCalledTimes(3);
    expect(snapshots).toHaveLength(3);
  });

  it('ignores other people and stale rows until its own DONE', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce([{ personId: 'someone-else', workerClip: true, jobStatus: 'DONE' }])
      .mockResolvedValue([clip('DONE', true)]);
    const outcome = await pollVoiceClipReady('u-voice', {
      load,
      intervalMs: 5,
      timeoutMs: 500,
    });
    expect(outcome).toBe('ready');
    expect(load.mock.calls.length).toBeGreaterThan(1);
  });

  it('tolerates load failures and times out when DONE never arrives', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue([{ personId: 'u-voice', workerClip: false, jobStatus: 'PENDING' }]);
    const outcome = await pollVoiceClipReady('u-voice', {
      load,
      intervalMs: 5,
      timeoutMs: 25,
    });
    expect(outcome).toBe('timeout');
  });

  it('aborts when cancelled', async () => {
    const load = vi.fn();
    const outcome = await pollVoiceClipReady('u-voice', {
      load,
      intervalMs: 5,
      timeoutMs: 500,
      isCancelled: () => true,
    });
    expect(outcome).toBe('aborted');
    expect(load).not.toHaveBeenCalled();
  });
});


describe('readable native errors (manual audit)', () => {
  const desktop = () => Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  afterEach(() => {
    // SAFETY: test-only removal of the Tauri marker installed by desktop().
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('maps a rejected attendance save to a coded, readable error instead of throwing', async () => {
    desktop();
    vi.spyOn(tauriApi, 'adminUpdateAttendance').mockRejectedValueOnce('ATTENDANCE_CONFLICT');
    await expect(saveAdminAttendance('ATT-1', { timeOut: null })).resolves.toEqual({
      success: false,
      error: { code: 'ATTENDANCE_CONFLICT', message: expect.stringContaining('changed by another update') },
    });
    vi.spyOn(tauriApi, 'adminUpdateAttendance').mockRejectedValueOnce('ADMIN_VALIDATION_ERROR');
    await expect(saveAdminAttendance('ATT-1', {})).resolves.toMatchObject({ error: { message: 'The date or time is not valid. Check the times and try again.' } });
  });

  it('shows a sentence, not INVALID_ADMIN_PIN, when the kiosk Admin setup unlock fails', async () => {
    desktop();
    vi.spyOn(tauriApi, 'setupUnlock').mockRejectedValueOnce('INVALID_ADMIN_PIN');
    await expect(unlockSetup('000000')).resolves.toMatchObject({ success: false, error: { message: 'The administrator PIN or admin RFID card is invalid.' } });
  });

  it('says admin access is off when config disables it', async () => {
    desktop();
    vi.spyOn(tauriApi, 'setupUnlock').mockRejectedValueOnce('ADMIN_DISABLED');
    await expect(unlockAdmin('123987')).resolves.toMatchObject({ success: false, error: { message: 'Administrator access is turned off on this kiosk.' } });
  });

  it('explains a payroll PDF request for a cutoff with no records', async () => {
    desktop();
    vi.spyOn(tauriApi, 'generatePayrollPdf').mockRejectedValueOnce('NO_PAYROLL_RECORDS: No intern payroll records for X. Create and save an intern payroll for this cutoff first.');
    await expect(generatePayrollPdf({ cutoffStart: '2026-10-01', cutoffEnd: '2026-10-15', workerType: 'intern' })).resolves.toMatchObject({
      success: false,
      error: { message: expect.stringContaining('Generate the cutoff payroll first') },
    });
  });

  it('splits the code off native bathroom errors so only the sentence is shown', async () => {
    desktop();
    vi.spyOn(tauriApi, 'bathroomUpdateLog').mockRejectedValueOnce('BATHROOM_KEY_ALREADY_CHECKED_OUT: The MALE bathroom key is currently checked out by Sam Santos.');
    await expect(updateBathroomLog('bath-1', { timeOut: '2026-08-31T10:00:00+08:00', timeIn: null, notes: '' })).resolves.toEqual({
      success: false,
      error: { code: 'BATHROOM_KEY_ALREADY_CHECKED_OUT', message: 'The MALE bathroom key is currently checked out by Sam Santos.' },
    });
  });
});

describe('generateInternPayslipImages', () => {
  const request = { cutoffStart: '2026-10-01', cutoffEnd: '2026-10-15', payrollCutoffLabel: 'October 1-15, 2026' };
  const payslip = (employeeId: string, employeeName: string): InternPayslip => ({
    employeeId, employeeName, department: 'Marketing', designation: 'Intern', tin: '', bankName: '', accountNumber: '',
    standardWorkingDays: 11, actualWorkingDays: 11, dailyRateCentavos: 50000, basicCentavos: 550000, grossSalaryCentavos: 550000,
    adjustmentCentavos: 0, totalEarningsCentavos: 550000, absentCentavos: 0, lateCentavos: 0, halfdayCentavos: 0, undertimeCentavos: 0,
    totalDeductionsCentavos: 0, netPayCentavos: 550000,
  });
  const saved = { success: true as const, directoryPath: 'C:/data/exports/payslips/October 1-15, 2026', fileCount: 2, fileNames: ['Ada Lovelace.png', 'Grace Hopper.png'], message: 'Saved.' };
  const desktop = () => Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  afterEach(() => {
    // SAFETY: test-only removal of the Tauri marker installed by desktop().
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('renders every payslip in order and saves the images with the period label', async () => {
    desktop();
    const ada = payslip('INT-001', 'Ada Lovelace');
    const grace = payslip('INT-002', 'Grace Hopper');
    const data = { success: true as const, companyName: 'Alpha Premier', companyAddress: 'Makati City', payslips: [ada, grace] };
    vi.spyOn(tauriApi, 'internPayslips').mockResolvedValueOnce(data);
    const saveSpy = vi.spyOn(tauriApi, 'saveInternPayslipImages').mockResolvedValueOnce(saved);
    const renderSpy = vi.spyOn(payslipRenderer, 'renderInternPayslipPng').mockImplementation(async (item) => `png-${item.employeeId}`);

    await expect(generateInternPayslipImages(request)).resolves.toEqual(saved);

    expect(tauriApi.internPayslips).toHaveBeenCalledWith('', '2026-10-01', '2026-10-15');
    const header = { companyName: 'Alpha Premier', companyAddress: 'Makati City', periodLabel: 'October 1-15, 2026' };
    expect(renderSpy.mock.calls).toEqual([[ada, header], [grace, header]]);
    expect(saveSpy).toHaveBeenCalledWith('', 'October 1-15, 2026', [
      { employeeId: 'INT-001', employeeName: 'Ada Lovelace', pngBase64: 'png-INT-001' },
      { employeeId: 'INT-002', employeeName: 'Grace Hopper', pngBase64: 'png-INT-002' },
    ]);
  });

  it('falls back to the cutoff dates when the label is blank', async () => {
    desktop();
    vi.spyOn(tauriApi, 'internPayslips').mockResolvedValueOnce({ success: true, companyName: 'Alpha Premier', companyAddress: '', payslips: [payslip('INT-001', 'Ada Lovelace')] });
    const saveSpy = vi.spyOn(tauriApi, 'saveInternPayslipImages').mockResolvedValueOnce(saved);
    vi.spyOn(payslipRenderer, 'renderInternPayslipPng').mockResolvedValue('png');

    await generateInternPayslipImages({ ...request, payrollCutoffLabel: '  ' });

    expect(saveSpy).toHaveBeenCalledWith('', '2026-10-01 to 2026-10-15', expect.any(Array));
  });

  it('explains a request for a cutoff with no payroll records', async () => {
    desktop();
    vi.spyOn(tauriApi, 'internPayslips').mockRejectedValueOnce('NO_PAYROLL_RECORDS: No intern payroll records for X.');
    await expect(generateInternPayslipImages(request)).resolves.toEqual({
      success: false,
      error: { message: 'No payroll records exist for these cutoff dates. Generate the cutoff payroll first, then create the payslips.' },
    });
  });

  it('tells the admin to unlock when the admin session has expired', async () => {
    desktop();
    vi.spyOn(tauriApi, 'internPayslips').mockRejectedValueOnce('ADMIN_AUTH_REQUIRED');
    await expect(generateInternPayslipImages(request)).resolves.toMatchObject({ success: false, error: { message: expect.stringContaining('Administrator') } });
  });

  it('maps a rejected save to a generic message', async () => {
    desktop();
    vi.spyOn(tauriApi, 'internPayslips').mockResolvedValueOnce({ success: true, companyName: 'Alpha Premier', companyAddress: '', payslips: [payslip('INT-001', 'Ada Lovelace')] });
    vi.spyOn(tauriApi, 'saveInternPayslipImages').mockRejectedValueOnce('PAYSLIP_WRITE_FAILED: disk full');
    vi.spyOn(payslipRenderer, 'renderInternPayslipPng').mockResolvedValue('png');
    await expect(generateInternPayslipImages(request)).resolves.toEqual({ success: false, error: { message: 'Unable to generate the payslips.' } });
  });

  it('returns a desktop-only message in web mode', async () => {
    await expect(generateInternPayslipImages(request)).resolves.toEqual({ success: false, error: { message: 'Payslips are generated in the desktop application.' } });
  });
});
