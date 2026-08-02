import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

const successResponse = {
  success: true,
  requestId: 'req-1',
  action: 'TIME_IN',
  message: 'Time in recorded',
  attendance: {
    attendanceId: 'att-1',
    attendanceDate: '2026-07-28',
    timeIn: '2026-07-28T09:00:00+08:00',
    timeOut: null,
    status: 'OPEN',
  },
  user: { userId: 'u-1', fullName: 'Ada Lovelace', department: 'Engineering', photoUrl: 'asset://localhost/C:/photos/ada.webp' },
};

function mockFetch(response: unknown = successResponse) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/config') {
      return {
        ok: true,
        json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, enableScanSounds: false, resultResetDelayMs: 500 }),
      } as Response;
    }
    return { ok: true, json: async () => response } as Response;
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockFetch();
});

describe('RFID kiosk', () => {
  it('focuses the RFID field on first load without a mouse click', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByLabelText(/scanner card id/i)).toHaveFocus());
  });

  it('submits an RFID scan when the scanner sends Enter', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);

    await user.type(input, '04A1B2C3');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ rfidUid: '04A1B2C3', source: 'RFID' }),
      }),
    ));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Ada Lovelace ID' })).toHaveClass('result-photo-full');
  });

  it('submits a rapid scanner input after the idle fallback delay', async () => {
    const user = userEvent.setup();
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    await user.type(input, 'ABCD1234');

    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith('/api/attendance/scan', expect.anything()));
  });

  it('supports manual UID mode and identifies its source', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /manual uid/i }));
    const input = screen.getByLabelText(/manual card id/i);
    await user.type(input, 'MANUAL-001');
    await user.click(screen.getByRole('button', { name: /record attendance/i }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({ body: JSON.stringify({ rfidUid: 'MANUAL-001', source: 'MANUAL_TEST' }) }),
    ));
  });

  it('renders an API error and returns to ready after the reset delay', async () => {
    const user = userEvent.setup();
    mockFetch({
      success: false,
      requestId: 'req-2',
      error: { code: 'UNKNOWN_RFID_CARD', message: 'Card is not registered.' },
    });
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    await user.type(input, 'BAD-CARD');
    await user.keyboard('{Enter}');
    expect(await screen.findByText('Card is not registered.')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByText(/tap your card to begin/i)).toBeInTheDocument(), { timeout: 1_000 });
    await waitFor(() => expect(screen.getByLabelText(/scanner card id/i)).toHaveFocus());
  });

  it('enrolls an unknown card through the protected setup flow', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, enableScanSounds: false, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
      if (url.includes('/api/setup/unlock')) return { ok: true, json: async () => ({ success: true, setupToken: 'setup-token', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      if (url.includes('/api/setup/card')) return { ok: true, json: async () => ({ success: true, rfidUid: 'ABCD1234', user: null }) } as Response;
      if (url.includes('/api/setup/users')) return { ok: true, json: async () => ({ success: true, created: true, user: { userId: 'EMP-002', fullName: 'Grace Hopper', department: 'Engineering', status: 'ACTIVE', rfidUid: 'ABCD1234' } }) } as Response;
      return { ok: true, json: async () => ({ success: false, error: { code: 'UNKNOWN_RFID_CARD', message: 'Card is not registered.' } }) } as Response;
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    await user.type(screen.getByLabelText(/administrator pin/i), '2468');
    await user.click(screen.getByRole('button', { name: /unlock setup/i }));
    const setupInput = await screen.findByLabelText(/setup card id/i);
    await user.type(setupInput, 'ABCD1234');
    await user.keyboard('{Enter}');
    await screen.findByText('ABCD1234');
    await user.type(screen.getByLabelText(/^user id/i), 'EMP-002');
    await user.type(screen.getByLabelText(/full name/i), 'Grace Hopper');
    await user.click(screen.getByRole('button', { name: /save user/i }));
    expect(await screen.findByText('Card enrolled successfully.')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/setup/users', expect.objectContaining({ method: 'POST' }));
  });
});
