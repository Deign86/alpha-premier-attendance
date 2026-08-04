import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as eventApi from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import App, { shouldRouteGlobalRfidToSetup } from './App';

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
  mockEventBridge.__reset();
  invokeMock.mockClear();
  mockFetch();
});

describe('RFID kiosk', () => {
  it('routes global RFID scans to the registration dialog while setup is active', () => {
    expect(shouldRouteGlobalRfidToSetup(true, 'setup-token', 'scan')).toBe(true);
    expect(shouldRouteGlobalRfidToSetup(true, 'setup-token', 'edit')).toBe(false);
    expect(shouldRouteGlobalRfidToSetup(false, 'setup-token', 'scan')).toBe(false);
  });

  it('shows the scanner-first tap prompt with no visible RFID text input', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: /tap card/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/scanner card id/i)).not.toBeInTheDocument();
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

  it('keeps processing guard active during an in-flight scan', async () => {
    let resolveScan: ((value: Response) => void) | undefined;
    const scanCalls = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, enableScanSounds: false, resultResetDelayMs: 500 }) } as Response;
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

    await waitFor(() => expect(screen.getByRole('heading', { name: /tap card/i })).toBeInTheDocument(), { timeout: 1_000 });
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
            enableScanSounds: false,
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
      if (url.includes('/api/config')) return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, enableScanSounds: false, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
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
