import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { greetingForDate, shouldRouteGlobalRfidToSetup, ScannerDiagnostics } from './App';
import * as ttsService from './services/ttsService';
import * as tauriApi from './tauri-api';
import type { ScannerStatus } from '@rfid-attendance/shared';

let rfidHandlers: Array<(uid: string) => void> = [];
let scannerStatusHandlers: Array<(status: ScannerStatus) => void> = [];

function emitRfidScan(uid: string) {
  rfidHandlers.forEach((h) => h(uid));
}

function emitScannerStatus(status: ScannerStatus) {
  scannerStatusHandlers.forEach((h) => h(status));
}

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
  user: { userId: 'u-1', fullName: 'Ada Lovelace', department: 'Engineering', gender: 'FEMALE', photoUrl: 'asset://localhost/C:/photos/ada.webp' },
};

function mockFetch<T extends { success: boolean }>(response?: T) {
  const payload = response ?? successResponse;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    if (String(input) === '/api/config') {
      // SAFETY: Fetch returns mock Response for config
      return {
        ok: true,
        json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }),
      } as Response;
    }
    // SAFETY: Fetch returns mock Response for general requests
    return { ok: true, json: async () => payload } as Response;
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rfidHandlers = [];
  scannerStatusHandlers = [];

  vi.spyOn(tauriApi, 'listenForGlobalRfid').mockImplementation((handler) => {
    rfidHandlers.push(handler);
    return Promise.resolve(() => {
      rfidHandlers = rfidHandlers.filter((h) => h !== handler);
    });
  });
  vi.spyOn(tauriApi, 'listenForScannerStatus').mockImplementation((handler) => {
    scannerStatusHandlers.push(handler);
    return Promise.resolve(() => {
      scannerStatusHandlers = scannerStatusHandlers.filter((h) => h !== handler);
    });
  });
  vi.spyOn(tauriApi, 'listenForAttendanceUpdates').mockImplementation(() => Promise.resolve(() => {}));
  vi.spyOn(tauriApi, 'setScannerPaused').mockResolvedValue();
  vi.spyOn(tauriApi, 'notifyScanSuccess').mockResolvedValue();
  vi.spyOn(tauriApi, 'getScannerStatus').mockRejectedValue(new Error('web mode'));
  vi.spyOn(ttsService, 'announceAttendance').mockResolvedValue(null);
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

  it('shows a welcoming greeting without stealing focus for keyboard-wedge capture', async () => {
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(screen.getByRole('heading', { name: /good (morning|afternoon|evening)/i })).toBeInTheDocument();
    expect(screen.getByText(/^tap your card on the reader$/i)).toHaveClass('hero-sub');
    // SAFETY: Input element queried by label text
    const input = screen.getByLabelText(/scanner card id/i) as HTMLInputElement;
    expect(input).toBeInTheDocument();
    // The kiosk box is locked for scanning: no typing or editing until Manual entry.
    expect(input).toHaveAttribute('readonly');
    expect(input).not.toHaveFocus();
  });

  it('captures a fast keyboard-wedge burst while the kiosk is active', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    expect(input).toHaveAttribute('readonly');
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      fireEvent.keyDown(input, { key });
    }
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({
        body: JSON.stringify({ rfidUid: '0123456789', source: 'RFID' }),
      }),
    ));
  });

  it('does not submit a wrong-length keyboard-wedge burst', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });

  it('rejects letters in decimal keyboard-wedge input without later partial submission', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['0', '4', 'A', '1', '2', '3', '4', '5', '6', '7', '8', '9']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });

  it('submits variable-length scans when expectedLength is 0', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mockFetch({
      ...successResponse,
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        // SAFETY: Fetch returns config Response mock
        return {
          ok: true,
          json: async () => ({
            success: true,
            timezone: 'Asia/Manila',
            rfidAutoSubmitDelayMs: 30,
            resultResetDelayMs: 500,
            scanner: { expectedLength: 0, characterSet: 'decimal' },
          }),
        } as Response;
      }
      // SAFETY: Fetch returns success Response mock
      return { ok: true, json: async () => successResponse } as Response;
    });
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['1', '2', '3', '4', '5']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({
        body: JSON.stringify({ rfidUid: '12345', source: 'RFID' }),
      }),
    ));
  });

  it('clears the scan buffer when Escape is pressed', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['0', '1', '2', '3', '4']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Escape' });
    for (const key of ['5', '6', '7', '8', '9']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    // Partial buffer was cleared by Escape so final buffer was only 5 digits (wrong length)
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });

  it('clears the scan buffer when the window loses focus (blur)', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['0', '1', '2', '3', '4']) fireEvent.keyDown(input, { key });
    fireEvent.blur(window);
    for (const key of ['5', '6', '7', '8', '9']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });

  it('clears the buffer on slow manual typing with gaps exceeding 250ms', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['0', '1', '2', '3', '4']) {
      fireEvent.keyDown(input, { key });
    }
    // Wait >250ms
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    for (const key of ['5', '6', '7', '8', '9']) {
      fireEvent.keyDown(input, { key });
    }
    fireEvent.keyDown(input, { key: 'Enter' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
  });

  it('keeps the scanner box locked against all keyboard typing (Manual entry is opt-in)', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    // No keyboard stream is treated as a background scanner source.
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
    act(() => emitRfidScan('04A1B2C3'));

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

  it('announces a time-in with employee name in TTS announcement', async () => {
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      attendanceType: 'time_in',
    });
  });

  it('announces a time-out with goodbye in TTS announcement', async () => {
    mockFetch({
      ...successResponse,
      action: 'TIME_OUT',
      message: 'Time out recorded',
      attendance: { ...successResponse.attendance, timeOut: '2026-07-28T18:00:00+08:00', status: 'COMPLETED' },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      attendanceType: 'time_out',
    });
  });

  it('shows the four native scanner states truthfully', async () => {
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const status = (state: 'connected' | 'scanning' | 'offline' | 'error', message: string): ScannerStatus => ({
      state,
      message,
      detail: null,
      mode: 'keyboard',
      paused: false,
    });

    act(() => emitScannerStatus(status('connected', 'Waiting for card')));
    expect(screen.getByText(/^Ready$/)).toBeInTheDocument();
    act(() => emitScannerStatus(status('scanning', 'Scan received')));
    expect(screen.getByText(/^Scanning$/)).toBeInTheDocument();
    act(() => emitScannerStatus(status('offline', 'Scanner unavailable')));
    expect(screen.getByText(/^Offline$/)).toBeInTheDocument();
    act(() => emitScannerStatus(status('error', 'Invalid scan format')));
    expect(screen.getByText(/^Error$/)).toBeInTheDocument();
  });

  it('keeps processing guard active during an in-flight scan', async () => {
    let resolveScan: ((value: Response) => void) | undefined;
    const scanCalls = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
      }
      scanCalls(String(input));
      return new Promise<Response>((resolve) => { resolveScan = resolve; });
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(await screen.findByText(/reading card/i)).toBeInTheDocument();

    // A second card during processing is dropped until the first completes.
    act(() => emitRfidScan('DEADBEEF'));
    expect(scanCalls).toHaveBeenCalledTimes(1);

    await act(async () => {
      // SAFETY: Resolve scan promise with mock Response
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
    act(() => emitRfidScan('DEADBEEF'));
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
        // SAFETY: Fetch returns office config Response mock
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
      // SAFETY: Fetch returns unknown card error Response mock
      return { ok: true, json: async () => ({ success: false, error: { code: 'UNKNOWN_RFID_CARD', message: 'Card is not registered.' } }) } as Response;
    });
    render(<App />);
    expect(await screen.findByText('Tektite East Tower, Ortigas Center, Pasig')).toBeInTheDocument();
  });

  it('keeps the scanner live only for the setup scan step and pauses for typing steps', async () => {
    vi.restoreAllMocks();
    const pauseSpy = vi.spyOn(tauriApi, 'setScannerPaused').mockResolvedValue();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
      }
      if (url.includes('/api/setup/unlock')) {
        // SAFETY: Fetch returns unlock Response mock
        return { ok: true, json: async () => ({ success: true, setupToken: 'setup-token', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      // SAFETY: Fetch returns success Response mock
      return { ok: true, json: async () => successResponse } as Response;
    });
    const user = userEvent.setup();
    render(<App />);
    // Kiosk idle: scanner runs.
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith(false));
    pauseSpy.mockClear();

    // Setup dialog (PIN screen): typing step, scanner paused.
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith(true));
    pauseSpy.mockClear();

    // Unlocked scan step: scanner live again for the card being enrolled.
    await user.type(screen.getByLabelText(/administrator pin/i), '2468');
    await user.click(screen.getByRole('button', { name: /unlock setup/i }));
    await screen.findByLabelText(/setup card id/i);
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith(false));
  });

  it('shows a distinct LATE TIMEOUT pill in the live attendance view', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/api/config') {
          // SAFETY: Fetch returns config Response mock
          return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
        }
        if (url === '/api/attendance') {
          // SAFETY: Fetch returns attendance Response mock
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
        // SAFETY: Fetch returns fallback success Response mock
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
      if (url.includes('/api/config')) {
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
      }
      if (url.includes('/api/setup/unlock')) {
        // SAFETY: Fetch returns unlock Response mock
        return { ok: true, json: async () => ({ success: true, setupToken: 'setup-token', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/setup/card')) {
        // SAFETY: Fetch returns card lookup Response mock
        return { ok: true, json: async () => ({ success: true, rfidUid: 'ABCD1234', user: null }) } as Response;
      }
      if (url.includes('/api/setup/users')) {
        // SAFETY: Fetch returns user creation Response mock
        return { ok: true, json: async () => ({ success: true, created: true, user: { userId: 'EMP-002', fullName: 'Grace Hopper', department: 'Engineering', status: 'ACTIVE', rfidUid: 'ABCD1234' } }) } as Response;
      }
      // SAFETY: Fetch returns fallback error Response mock
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
    expect(screen.getByLabelText(/^user id/i)).toHaveFocus();
    await user.type(screen.getByLabelText(/^user id/i), 'EMP-002');
    await user.type(screen.getByLabelText(/full name/i), 'Grace Hopper');
    await user.click(screen.getByRole('button', { name: /save user/i }));
    expect(await screen.findByText('Card enrolled successfully.')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/setup/users', expect.objectContaining({ method: 'POST' }));
  });
});

describe('ScannerDiagnostics', () => {
  it('presents the scanner as a keyboard-mode RFID reader with focus guidance', async () => {
    vi.spyOn(tauriApi, 'getScannerStatus').mockResolvedValue({
      state: 'connected',
      message: 'Keyboard-mode RFID reader ready',
      detail: 'Keep the attendance window focused before scanning',
      mode: 'keyboard',
      paused: false,
    });
    render(<ScannerDiagnostics />);
    expect(await screen.findByText(/Reader: Keyboard-mode RFID reader/)).toBeInTheDocument();
    expect(screen.getByText(/Keep the attendance window focused before scanning\./)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for card/)).toBeInTheDocument();
  });
});

describe('hidden-window scan notification', () => {
  it('notifies only when the window is hidden/unfocused and the scan succeeds', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const notifySpy = vi.spyOn(tauriApi, 'notifyScanSuccess').mockResolvedValue();
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => emitRfidScan('0123456789'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({ body: JSON.stringify({ rfidUid: '0123456789', source: 'RFID' }) }),
    ));
    await waitFor(() => expect(notifySpy).toHaveBeenCalledWith('Ada Lovelace'));
    hasFocus.mockRestore();
  });

  it('never notifies for a foreground scan', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const notifySpy = vi.spyOn(tauriApi, 'notifyScanSuccess').mockResolvedValue();
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    act(() => emitRfidScan('0123456789'));
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/attendance/scan',
      expect.objectContaining({ body: JSON.stringify({ rfidUid: '0123456789', source: 'RFID' }) }),
    ));
    expect(notifySpy).not.toHaveBeenCalledWith('Ada Lovelace');
    hasFocus.mockRestore();
  });
});
