import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as tauriApi from './tauri-api';
import * as ttsService from './services/ttsService';

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.localStorage.clear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  window.history.pushState({}, '', '/');
});

describe('kiosk feature gaps', () => {
  it('normalizes and drops a duplicate native scan during the cooldown window', async () => {
    vi.spyOn(ttsService, 'announceAttendance').mockResolvedValue(null);
    const handlers: Array<(uid: string) => void> = [];
    vi.spyOn(tauriApi, 'listenForGlobalRfid').mockImplementation((handler) => {
      handlers.push(handler);
      return Promise.resolve(() => {});
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Mock response supplies the config fields used by App.
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila' }) } as Response;
      }
      // SAFETY: Mock success response matches attendance scan result contract.
      return {
        ok: true,
        json: async () => ({
          success: true,
          requestId: 'req-1',
          action: 'TIME_IN',
          message: 'Time in recorded',
          attendance: { attendanceId: 'a1', attendanceDate: '2026-10-03', timeIn: '2026-10-03T09:00:00+08:00', timeOut: null, status: 'WORKING', isFirstArrivalToday: true },
          user: { userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', gender: 'FEMALE', photoUrl: null },
        }),
      } as Response;
    });

    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => handlers.forEach((handler) => handler('04A1B2C3')));
    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

    act(() => handlers.forEach((handler) => handler(' 04a1b2c3 ')));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(fetchSpy.mock.calls.filter(([input]) => String(input) === '/api/attendance/scan')).toHaveLength(1);
  });

  it('keeps an expired admin session locked and reports that it must be unlocked again', async () => {
    window.history.pushState({}, '', '/admin');
    vi.resetModules();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Mock response supplies the config fields used by App.
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila' }) } as Response;
      }
      if (url === '/api/admin/session') {
        // SAFETY: Expired session response matches checkAdminSession's contract.
        return { ok: true, json: async () => ({ expiresAt: '2020-01-01T00:00:00.000Z' }) } as Response;
      }
      if (url === '/api/admin/lock') {
        // SAFETY: Lock response matches the API contract.
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url === '/api/admin/users') {
        // SAFETY: Empty roster response matches the API contract.
        return { ok: true, json: async () => ({ success: true, users: [] }) } as Response;
      }
      if (url.startsWith('/api/admin/attendance')) {
        // SAFETY: Empty attendance response matches the API contract.
        return { ok: true, json: async () => ({ success: true, date: '2026-10-03', attendance: [] }) } as Response;
      }
      if (url === '/api/admin/payroll/profiles') {
        // SAFETY: Empty profiles response matches the API contract.
        return { ok: true, json: async () => ({ success: true, profiles: [] }) } as Response;
      }
      if (url === '/api/admin/payroll/cutoffs') {
        // SAFETY: Empty cutoffs response matches the API contract.
        return { ok: true, json: async () => ({ success: true, payroll: [] }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    try {
      const { default: SessionTestApp } = await import('./App');
      render(<SessionTestApp />);
      expect(await screen.findByText('Admin session expired. Please unlock again.')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: 'Manage attendance' })).toBeInTheDocument();
      expect(screen.getByLabelText(/administrator pin/i)).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('uses the global RFID listener for card lookup in the active setup scan step', async () => {
    const handlers: Array<(uid: string) => void> = [];
    vi.spyOn(tauriApi, 'listenForGlobalRfid').mockImplementation((handler) => {
      handlers.push(handler);
      return Promise.resolve(() => {});
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Mock response supplies config fields used by App.
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableCardSetup: true }) } as Response;
      }
      if (url === '/api/setup/unlock') {
        // SAFETY: Mock setup unlock response matches the API contract.
        return { ok: true, json: async () => ({ success: true, setupToken: 'setup-token', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.startsWith('/api/setup/card')) {
        // SAFETY: Mock card lookup response matches the API contract.
        return { ok: true, json: async () => ({ success: true, rfidUid: 'ABCD1234', user: null }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();

    render(<App />);
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    await user.type(screen.getByLabelText(/administrator pin/i), '2468');
    await user.click(screen.getByRole('button', { name: /unlock setup/i }));
    await screen.findByLabelText(/setup card id/i);
    act(() => handlers.forEach((handler) => handler('ABCD1234')));

    expect(await screen.findByText('ABCD1234')).toBeInTheDocument();
    expect(fetchSpy.mock.calls.some(([input]) => String(input).startsWith('/api/setup/card?rfidUid='))).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });
});
