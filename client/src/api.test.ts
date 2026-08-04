import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { exportPayrollCsv, openGeneratedFile, revealGeneratedFile, submitScan } from './api';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('scan requests', () => {
  it('returns the scan response once the service responds', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, requestId: 'req-1', action: 'TIME_OUT' }),
    } as Response);

    await expect(submitScan({ rfidUid: 'RFID-001', source: 'RFID' })).resolves.toMatchObject({ success: true });
  });

  it('returns a network error when the service is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(submitScan({ rfidUid: 'RFID-002', source: 'RFID' })).resolves.toMatchObject({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR' },
    });
  });
});

describe('payroll exports', () => {
  it('uses the native payroll export command and returns file metadata', async () => {
    vi.mocked(invoke).mockResolvedValueOnce({
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
    expect(invoke).toHaveBeenCalledWith('payroll_export_csv', { token: '' });
    expect(createObjectUrl).not.toHaveBeenCalled();
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('downloads the CSV through a blob in web mode without file metadata', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => 'payrollId,employeeId\n',
    } as Response);
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
    vi.mocked(invoke).mockResolvedValueOnce({ success: true, message: 'File opened.' });
    const result = await openGeneratedFile('C:\\Data\\exports\\payroll-2026-08-04.csv');
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith('open_generated_file', { token: '', filePath: 'C:\\Data\\exports\\payroll-2026-08-04.csv' });
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('maps a missing file to a friendly message', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockRejectedValueOnce('FILE_NOT_FOUND');
    const result = await revealGeneratedFile('C:\\Data\\exports\\gone.csv');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('The file could not be found. It may have been moved or deleted.');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it('returns a desktop-only message in web mode', async () => {
    const result = await openGeneratedFile('C:\\whatever.csv');
    expect(result.ok).toBe(false);
    expect(result.message).toBe('File actions are available in the desktop application.');
  });
});
