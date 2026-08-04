import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import { invoke } from '@tauri-apps/api/core';
import { exportPayrollCsv, submitScan } from './api';

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
  it('uses the native payroll export command and downloads its CSV response', async () => {
    vi.mocked(invoke).mockResolvedValueOnce('payrollId,employeeId\n');
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const createObjectUrl = vi.fn(() => 'blob:payroll');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    const result = await exportPayrollCsv();

    expect(result.success).toBe(true);
    expect(invoke).toHaveBeenCalledWith('payroll_export_csv', { token: '' });
    expect(createObjectUrl).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:payroll');
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    click.mockRestore();
  });
});
