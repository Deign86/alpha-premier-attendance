import { afterEach, describe, expect, it, vi } from 'vitest';
import { tauriApi } from './tauri-api';
import { exportPayrollCsv, openGeneratedFile, revealGeneratedFile, setupErrorFrom, submitScan } from './api';

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

describe('payroll exports', () => {
  it('uses the native payroll export command and returns file metadata', async () => {
    const spy = vi.spyOn(tauriApi, 'payrollExportCsv').mockResolvedValueOnce({
      success: true,
      filePath: 'C:\\Data\\exports\\payroll-2026-08-04.csv',
      directoryPath: 'C:\\Data\\exports',
      fileName: 'payroll-2026-08-04.csv',
      fileKind: 'csv',
      isPortableMode: true,
    });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const createObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });

    const result = await exportPayrollCsv();

    expect(result.success).toBe(true);
    expect(spy).toHaveBeenCalledWith('');
    expect(createObjectUrl).not.toHaveBeenCalled();
    // SAFETY: Removing test mock property from window
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('downloads the CSV through a blob in web mode without file metadata', async () => {
    // SAFETY: Mock Response object for fetch
    const mockResponse = {
      ok: true,
      text: async () => 'payrollId,employeeId\n',
    } as Response;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse);
    const createObjectUrl = vi.fn(() => 'blob:payroll');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const result = await exportPayrollCsv();

    expect(result.success).toBe(true);
    expect(createObjectUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:payroll');
    click.mockRestore();
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

