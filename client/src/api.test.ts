import { afterEach, describe, expect, it, vi } from 'vitest';
import { submitScan } from './api';

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
