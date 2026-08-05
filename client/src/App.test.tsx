import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as eventApi from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import App, { greetingForDate, shouldRouteGlobalRfidToSetup } from './App';
import { announceTimeIn, announceTimeOut } from './speech';

/** Speech announcements are asserted via the mocked module, never spoken in tests. */
vi.mock('./speech', () => ({
  announceTimeIn: vi.fn(),
  announceTimeOut: vi.fn(),
}));

/**
 * Mock the Tauri command bridge so tests can assert native scanner pause calls.
 * Rejects by default (web mode) so promise chains resolve through `.catch`.
 */
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(() => Promise.reject(new Error('web mode'))) }));

const invokeMock = vi.mocked(invoke);

/**
 * Mock the Tauri event bridge so tests can emit native `rfid-scan` events the
 * same way the Rust scanner pipeline does (no focused input involved).
 */
vi.mock('@tauri-apps/api/event', () => {
  const handlers = new Map<string, Array<(event: { payload: unknown }) => void>>();
  return {
    listen: vi.fn((eventName: string, handler: (event: { payload: unknown }) => void) => {
      const list = handlers.get(eventName) ?? [];
      list.push(handler);
      handlers.set(eventName, list);
      return Promise.resolve(() => {
        const current = handlers.get(eventName) ?? [];
        handlers.set(eventName, current.filter((h) => h !== handler));
      });
    }),
    __emit: (eventName: string, payload: unknown) => {
      (handlers.get(eventName) ?? []).forEach((h) => h({ payload }));
    },
    __reset: () => {
      handlers.clear();
    },
  };
});

const mockEventBridge = eventApi as unknown as {
  __emit: (eventName: string, payload: unknown) => void;
  __reset: () => void;
};

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
    status: 'WORKING',
  },
  user: { userId: 'u-1', fullName: 'Ada Lovelace', department: 'Engineering', photoUrl: 'asset://localhost/C:/photos/ada.webp' },
};

function mockFetch(response: unknown = successResponse) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/config') {
      return {
        ok: true,
        json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }),
      } as Response;
    }
    return { ok: true, json: async () => response } as Response;
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mockEventBridge.__reset();
  invokeMock.mockClear();
  vi.mocked(announceTimeIn).mockClear();
  vi.mocked(announceTimeOut).mockClear();
  mockFetch();
});

describe('RFID kiosk', () => {
  it('uses Manila local time for the welcoming greeting', () => {
    expect(greetingForDate(new Date('2026-08-04T01:00:00Z'), 'Asia/Manila')).toBe('Good morning');
    expect(greetingForDate(new Date('2026-08-04T05:00:00Z'), 'Asia/Manila')).toBe('Good afternoon');
    expect(greetingForDate(new Date('2026-08-04T11:00:00Z'), 'Asia/Manila')).toBe('Good evening');
  });

  it('routes global RFID scans to the registration dialog while setup is active', () => {
    expect(shouldRouteGlobalRfidToSetup(true, 'setup-token', 'scan')).toBe(true);
    expect(shouldRouteGlobalRfidToSetup(true, 'setup-token', 'edit')).toBe(false);
    expect(shouldRouteGlobalRfidToSetup(false, 'setup-token', 'scan')).toBe(false);
  });

  it('shows a welcoming greeting and a scanner text box that is always focused and read-only', async () => {
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole('heading', { name: /good (morning|afternoon|evening)/i })).toBeInTheDocument();
    expect(screen.getByText(/^tap your card on the reader$/i)).toHaveClass('hero-sub');
    const input = screen.getByLabelText(/scanner card id/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // The kiosk box is locked for scanning: no typing or editing until Manual entry.
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveFocus();
  });

  it('captures a rapid keyboard-wedge scan into the read-only box and submits it as RFID', async () => {
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    expect(input).toHaveAttribute('readonly');
    // A reader types the whole UID in a fast burst, then Enter.
    for (const key of ['0', '4', 'a', '1', 'b', '2', 'c', '3']) {
      fireEvent.keyDown(input, { key });
    }
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({ body: JSON.stringify({ rfidUid: '04A1B2C3', source: 'RFID' }) }),
    ));
  });

  it('keeps the scanner box locked against slow manual typing (Manual entry is opt-in)', async () => {
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    // A person typing with normal pauses never arms a scan…
    for (const key of ['1', '2', '3', '4']) {
      fireEvent.keyDown(input, { key });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    }
    // …and Enter alone does not bypass the lock.
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });

  it('submits a native scan event and shows the employee photo', async () => {
    render(<App />);
    act(() => mockEventBridge.__emit('rfid-scan', '04A1B2C3'));

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

  it('announces a time-in with the time-appropriate greeting in speech', async () => {
    render(<App />);
    act(() => mockEventBridge.__emit('rfid-scan', '04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(vi.mocked(announceTimeIn)).toHaveBeenCalledWith(expect.stringMatching(/^Good (morning|afternoon|evening)$/));
    expect(vi.mocked(announceTimeOut)).not.toHaveBeenCalled();
  });

  it('announces a time-out with a goodbye in speech', async () => {
    mockFetch({
      ...successResponse,
      action: 'TIME_OUT',
      message: 'Time out recorded',
      attendance: { ...successResponse.attendance, timeOut: '2026-07-28T18:00:00+08:00', status: 'COMPLETED' },
    });
    render(<App />);
    act(() => mockEventBridge.__emit('rfid-scan', '04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(vi.mocked(announceTimeOut)).toHaveBeenCalled();
    expect(vi.mocked(announceTimeIn)).not.toHaveBeenCalled();
  });

  it('shows the four native scanner states truthfully', async () => {
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const status = (state: 'connected' | 'scanning' | 'offline' | 'error', message: string) => ({
      state,
      message,
      detail: null,
      mode: 'keyboard',
      paused: false,
    });

    act(() => mockEventBridge.__emit('scanner-status', status('connected', 'Waiting for card')));
    expect(screen.getByText(/^Ready$/)).toBeInTheDocument();
    act(() => mockEventBridge.__emit('scanner-status', status('scanning', 'Scan received')));
    expect(screen.getByText(/^Scanning$/)).toBeInTheDocument();
    act(() => mockEventBridge.__emit('scanner-status', status('offline', 'Scanner unavailable')));
    expect(screen.getByText(/^Offline$/)).toBeInTheDocument();
    act(() => mockEventBridge.__emit('scanner-status', status('error', 'Invalid scan format')));
    expect(screen.getByText(/^Error$/)).toBeInTheDocument();
  });

  it('keeps processing guard active during an in-flight scan', async () => {
    let resolveScan: ((value: Response) => void) | undefined;
    const scanCalls = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
      }
      scanCalls(String(input));
      return new Promise<Response>((resolve) => { resolveScan = resolve; });
    });
    render(<App />);
    act(() => mockEventBridge.__emit('rfid-scan', '04A1B2C3'));
    expect(await screen.findByText(/reading card/i)).toBeInTheDocument();

    // A second card during processing is dropped until the first completes.
    act(() => mockEventBridge.__emit('rfid-scan', 'DEADBEEF'));
    expect(scanCalls).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveScan?.({ ok: true, json: async () => successResponse } as Response);
    });
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('supports manual UID mode as an explicit fallback and identifies its source', async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole('button', { name: /manual entry/i }));
    const input = screen.getByLabelText(/manual card id/i);
    await user.type(input, 'MANUAL-001');
    await user.click(screen.getByRole('button', { name: /record/i }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({ body: JSON.stringify({ rfidUid: 'MANUAL-001', source: 'MANUAL_TEST' }) }),
    ));
  });

  it('renders an API error and returns to ready after the reset delay', async () => {
    mockFetch({
      success: false,
      requestId: 'req-2',
      error: { code: 'UNKNOWN_RFID_CARD', message: 'Card is not registered.' },
    });
    render(<App />);
    // Let the config load so the (mocked) short reset delay is in effect.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    act(() => mockEventBridge.__emit('rfid-scan', 'DEADBEEF'));
    expect(await screen.findByText('Card is not registered.')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('heading', { name: /good (morning|afternoon|evening)/i })).toBeInTheDocument(), { timeout: 1_000 });
  });

  it('shows the canonical office short address on the kiosk', async () => {
    render(<App />);
    expect(await screen.findByText('Tektite East Tower, Ortigas Center, Pasig')).toBeInTheDocument();
  });

  it('uses the configured office identity when the backend provides one', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        return {
          ok: true,
          json: async () => ({
            success: true,
            timezone: 'Asia/Manila',
            rfidAutoSubmitDelayMs: 30,

            resultResetDelayMs: 500,
            office: {
              companyName: 'Alpha Premier',
              officeLabel: 'Main Office',
              officeAddressLine1: 'Unit 3104C',
              officeBuilding: 'Tektite East Tower',
              officeDistrict: 'Ortigas Center',
              officeCity: 'Pasig',
              officeRegion: 'Metro Manila',
              officeCountry: 'Philippines',
              officePostalCode: '',
              officeDisplayShort: 'Tektite East Tower, Ortigas Center, Pasig',
              officeDisplayFull: 'Unit 3104C, Tektite East Tower, Ortigas Center, Pasig, Metro Manila',
            },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ success: false, error: { code: 'UNKNOWN_RFID_CARD', message: 'Card is not registered.' } }) } as Response;
    });
    render(<App />);
    expect(await screen.findByText('Tektite East Tower, Ortigas Center, Pasig')).toBeInTheDocument();
  });

  it('keeps the scanner live only for the setup scan step and pauses for typing steps', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
      if (url.includes('/api/setup/unlock')) return { ok: true, json: async () => ({ success: true, setupToken: 'setup-token', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      return { ok: true, json: async () => successResponse } as Response;
    });
    const user = userEvent.setup();
    render(<App />);
    // Kiosk idle: scanner runs.
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('scanner_pause', { paused: false }));
    invokeMock.mockClear();

    // Setup dialog (PIN screen): typing step, scanner paused.
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('scanner_pause', { paused: true }));
    invokeMock.mockClear();

    // Unlocked scan step: scanner live again for the card being enrolled.
    await user.type(screen.getByLabelText(/administrator pin/i), '2468');
    await user.click(screen.getByRole('button', { name: /unlock setup/i }));
    await screen.findByLabelText(/setup card id/i);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith('scanner_pause', { paused: false }));
  });

  it('shows a distinct LATE TIMEOUT pill in the live attendance view', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/api/config') {
          return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
        }
        if (url === '/api/attendance') {
          return {
            ok: true,
            json: async () => ({
              success: true,
              date: '2026-07-28',
              fetchedAt: '2026-07-28T10:00:00+08:00',
              attendance: [
                { attendanceId: 'a1', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T08:00:00+08:00', timeOut: '2026-07-28T18:55:00+08:00', status: 'LATE_TIMEOUT' },
                { attendanceId: 'a2', attendanceDate: '2026-07-28', userId: 'u2', fullName: 'Grace Hopper', department: 'Engineering', timeIn: '2026-07-28T08:00:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
              ],
            }),
          } as Response;
        }
        return { ok: true, json: async () => ({ success: true }) } as Response;
      });
      render(<App />);
      expect(await screen.findByText('LATE TIMEOUT')).toBeInTheDocument();
      expect(screen.getByText('Correction needed')).toBeInTheDocument();
      // Normal shifts keep rendering their existing status unchanged.
      expect(screen.getByText('COMPLETED')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('enrolls an unknown card through the protected setup flow', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
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
