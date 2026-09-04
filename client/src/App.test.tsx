import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { greetingForDate, shouldRouteGlobalRfidToSetup, ScannerDiagnostics } from './App';
import * as ttsService from './services/ttsService';
import * as tauriApi from './tauri-api';
import type { BathroomScanResponse, ScannerStatus } from '@rfid-attendance/shared';

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
    isFirstArrivalToday: true,
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
  vi.spyOn(tauriApi, 'listenForCheckForUpdates').mockImplementation(() => Promise.resolve(() => {}));
  vi.spyOn(tauriApi, 'setScannerPaused').mockResolvedValue();
  vi.spyOn(tauriApi, 'notifyScanSuccess').mockResolvedValue();
  vi.spyOn(tauriApi, 'getScannerStatus').mockRejectedValue(new Error('web mode'));
  vi.spyOn(ttsService, 'announceAttendance').mockResolvedValue(null);
  vi.spyOn(ttsService, 'announceBathroom').mockResolvedValue(null);
  vi.spyOn(ttsService, 'announceAdminAssist').mockResolvedValue(null);
  vi.spyOn(ttsService, 'announceScanError').mockResolvedValue(null);
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
    mockFetch({
      ...successResponse,
      action: 'TIME_IN',
      message: 'Time In recorded successfully.',
      attendance: {
        ...successResponse.attendance,
        timeIn: '2026-07-28T08:00:00+08:00',
        status: 'WORKING',
      },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      personId: 'u-1',
      userId: 'u-1',
      attendanceType: 'time_in',
      arrivalStatus: 'ON_TIME',
      isLateTimeout: false,
      isAssisted: false,
      isFirstTimeInToday: true,
      timeInIso: '2026-07-28T08:00:00+08:00',
    });
  });

  it('announces a grace period time-in in TTS announcement', async () => {
    mockFetch({
      ...successResponse,
      action: 'TIME_IN',
      message: 'Time In recorded successfully.',
      attendance: {
        ...successResponse.attendance,
        timeIn: '2026-07-28T08:08:00+08:00',
        status: 'WORKING',
      },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      personId: 'u-1',
      userId: 'u-1',
      attendanceType: 'time_in',
      arrivalStatus: 'GRACE_PERIOD',
      isLateTimeout: false,
      isAssisted: false,
      isFirstTimeInToday: true,
      timeInIso: '2026-07-28T08:08:00+08:00',
    });
  });

  it('announces a late time-in in TTS announcement', async () => {
    mockFetch({
      ...successResponse,
      action: 'TIME_IN',
      message: 'Time In recorded successfully.',
      attendance: {
        ...successResponse.attendance,
        timeIn: '2026-07-28T08:30:00+08:00',
        status: 'WORKING',
      },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      personId: 'u-1',
      userId: 'u-1',
      attendanceType: 'time_in',
      arrivalStatus: 'LATE',
      isLateTimeout: false,
      isAssisted: false,
      isFirstTimeInToday: true,
      timeInIso: '2026-07-28T08:30:00+08:00',
    });
  });

  it('announces a time-out with goodbye in TTS announcement', async () => {
    mockFetch({
      ...successResponse,
      action: 'TIME_OUT',
      message: 'Time out recorded',
      attendance: { ...successResponse.attendance, timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      personId: 'u-1',
      userId: 'u-1',
      attendanceType: 'time_out',
      arrivalStatus: undefined,
      isLateTimeout: false,
      isAssisted: false,
      isFirstTimeInToday: undefined,
      timeInIso: '2026-07-28T09:00:00+08:00',
    });
  });

  it('announces a late time-out in TTS announcement when overtime is detected', async () => {
    mockFetch({
      ...successResponse,
      action: 'TIME_OUT',
      message: 'Time Out recorded after office hours. Manual correction is required.',
      attendance: { ...successResponse.attendance, timeOut: '2026-07-28T18:05:00+08:00', status: 'LATE_TIMEOUT' },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    expect(ttsService.announceAttendance).toHaveBeenCalledWith({
      employeeName: 'Ada Lovelace',
      personId: 'u-1',
      userId: 'u-1',
      attendanceType: 'time_out',
      arrivalStatus: undefined,
      isLateTimeout: true,
      isAssisted: false,
      isFirstTimeInToday: undefined,
      timeInIso: '2026-07-28T09:00:00+08:00',
    });
  });

  it('announces admin assist card presentation', async () => {
    mockFetch({
      success: true,
      requestId: 'req-admin',
      action: 'ADMIN_ASSIST',
      message: 'Admin assist card accepted. Select an employee to record attendance.',
      adminCard: { rfidUid: 'ADMIN-01', label: 'Front Desk Admin' },
      activeEmployees: [
        { userId: 'EMP-001', fullName: 'Ada Lovelace', department: 'Engineering', photoUrl: null },
      ],
    });
    render(<App />);
    act(() => emitRfidScan('ADMIN-01'));
    expect(await screen.findByText(/assisted attendance/i)).toBeInTheDocument();
    expect(ttsService.announceAdminAssist).toHaveBeenCalled();
  });

  it('announces scan error on unregistered card', async () => {
    mockFetch({
      success: false,
      requestId: 'req-err',
      error: { code: 'UNKNOWN_RFID_CARD', message: 'This RFID card is not registered.' },
    });
    render(<App />);
    act(() => emitRfidScan('UNREGISTERED'));
    expect(await screen.findByText('This RFID card is not registered.')).toBeInTheDocument();
    expect(ttsService.announceScanError).toHaveBeenCalledWith({
      errorCode: 'UNKNOWN_RFID_CARD',
      message: 'This RFID card is not registered.',
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

  it('keeps the scanner live for setup unlock and scan steps and pauses for form typing steps', async () => {
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

    // Setup dialog (Unlock screen): scanner stays live for Admin RFID card taps.
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    await waitFor(() => expect(pauseSpy).toHaveBeenCalledWith(false));
    pauseSpy.mockClear();

    // Unlocked scan step: scanner live for the card being enrolled.
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
    await user.type(screen.getByLabelText(/full name/i), '  grace   hopper  ');
    fireEvent.blur(screen.getByLabelText(/full name/i));
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Grace Hopper');
    await user.click(screen.getByRole('button', { name: /save user/i }));
    expect(await screen.findByText('Card enrolled successfully.')).toBeInTheDocument();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/setup/users',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"fullName":"Grace Hopper"'),
      }),
    );
  });

  it('supports drag and drop photo upload in setup dialog', async () => {
    let capturedPhotoBody: unknown;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
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
      if (url.includes('/api/setup/photo')) {
        capturedPhotoBody = JSON.parse(String(init?.body));
        // SAFETY: Fetch returns photo upload mock
        return { ok: true, json: async () => ({ success: true, photoUrl: 'asset://localhost/photos/photo.webp' }) } as Response;
      }
      // SAFETY: Fallback response mock
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const mockBitmap: Partial<ImageBitmap> = {
      width: 200,
      height: 200,
      close: vi.fn(),
    };
    // SAFETY: Partial mock for ImageBitmap in node environment
    globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap as ImageBitmap);

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const mockContext: Partial<CanvasRenderingContext2D> = {
      drawImage: vi.fn(),
    };
    // SAFETY: Partial mock for 2D canvas context in node environment
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext as CanvasRenderingContext2D);
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,mockdata');

    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /admin setup/i }));
      await user.type(screen.getByLabelText(/administrator pin/i), '2468');
      await user.click(screen.getByRole('button', { name: /unlock setup/i }));
      const setupInput = await screen.findByLabelText(/setup card id/i);
      await user.type(setupInput, 'ABCD1234');
      await user.keyboard('{Enter}');
      await screen.findByText('ABCD1234');
      await user.type(screen.getByLabelText(/^user id/i), 'EMP-003');

      const dropzone = screen.getByText(/choose an id photo/i).closest('label');
      expect(dropzone).not.toBeNull();

      fireEvent.dragEnter(dropzone!);
      expect(dropzone).toHaveClass('is-dragging');
      fireEvent.dragLeave(dropzone!);
      expect(dropzone).not.toHaveClass('is-dragging');

      const file = new File(['mock content'], 'avatar.png', { type: 'image/png' });
      fireEvent.drop(dropzone!, {
        dataTransfer: {
          files: [file],
        },
      });

      expect(await screen.findByText('Photo ready')).toBeInTheDocument();
      expect(capturedPhotoBody).toEqual({
        userId: 'EMP-003',
        dataUrl: 'data:image/jpeg;base64,mockdata',
      });
    } finally {
      globalThis.createImageBitmap = originalCreateImageBitmap;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
    }
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

describe('Admin Attendance Corrections', () => {
  it('allows clearing time-in and time-out with clear buttons and saving', async () => {
    window.history.pushState({}, '', '/admin');
    let patchedBody: {
      attendanceDate?: string;
      timeIn?: string | null;
      timeOut?: string | null;
      expectedTimeIn?: string | null;
      expectedTimeOut?: string | null;
    } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch mock users
        return { ok: true, json: async () => ({ success: true, users: [] }) } as Response;
      }
      if (url.includes('/api/admin/attendance/a1')) {
        // SAFETY: Parsing mocked patch request body
        patchedBody = JSON.parse(String(init?.body)) as { attendanceDate?: string; timeIn?: string | null; timeOut?: string | null; expectedTimeIn?: string | null; expectedTimeOut?: string | null };
        // SAFETY: Fetch mock patch response
        return { ok: true, json: async () => ({ success: true, attendance: { attendanceId: 'a1', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '', timeOut: null, status: 'MISSED' } }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Fetch mock attendance list
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-07-28',
            attendance: [
              { attendanceId: 'a1', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T08:00:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
            ],
            fetchedAt: '2026-07-28T10:00:00+08:00',
          }),
        } as Response;
      }
      if (url.includes('/api/admin/payroll/profiles')) {
        // SAFETY: Fetch mock payroll profiles
        return { ok: true, json: async () => ({ success: true, profiles: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/cutoffs')) {
        // SAFETY: Fetch mock payroll cutoffs
        return { ok: true, json: async () => ({ success: true, payroll: [] }) } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      expect(await screen.findByDisplayValue('08:00')).toBeInTheDocument();
      expect(screen.getByDisplayValue('17:00')).toBeInTheDocument();

      const clearInBtn = screen.getByRole('button', { name: /clear time in for ada lovelace/i });
      const clearOutBtn = screen.getByRole('button', { name: /clear time out for ada lovelace/i });

      await user.click(clearInBtn);
      await user.click(clearOutBtn);

      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => expect(patchedBody).toEqual({
        attendanceDate: '2026-07-28',
        timeIn: null,
        timeOut: null,
        expectedTimeIn: '2026-07-28T08:00:00+08:00',
        expectedTimeOut: '2026-07-28T17:00:00+08:00',
      }));
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('supports multi-select and batch actions in Admin Users table', async () => {
    vi.restoreAllMocks();
    const deletedUserIds: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users') && init?.method === 'DELETE') {
        const id = url.split('/').pop();
        if (id) deletedUserIds.push(id);
        // SAFETY: Fetch delete user mock
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users list mock
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'EMPLOYEE', status: 'ACTIVE' },
              { userId: 'u2', fullName: 'Charles Babbage', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Fetch mock attendance list
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/profiles')) {
        // SAFETY: Fetch mock payroll profiles
        return { ok: true, json: async () => ({ success: true, profiles: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/cutoffs')) {
        // SAFETY: Fetch mock payroll cutoffs
        return { ok: true, json: async () => ({ success: true, payroll: [] }) } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /users and rfid/i }));

      expect(await screen.findByText('Total users: 2')).toBeInTheDocument();
      const masterCheckbox = screen.getByRole('checkbox', { name: /select all users/i });
      expect(masterCheckbox).not.toBeChecked();

      await user.click(masterCheckbox);
      expect(masterCheckbox).toBeChecked();
      expect(await screen.findByText('2 of 2 user(s) selected')).toBeInTheDocument();

      const batchDeleteBtn = screen.getByRole('button', { name: /delete selected \(2\)/i });
      await user.click(batchDeleteBtn);

      expect(screen.getByRole('dialog', { name: /delete selected users\?/i })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(deletedUserIds).toContain('u1');
        expect(deletedUserIds).toContain('u2');
      });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('supports multi-select and batch actions in Attendance Workspace', async () => {
    vi.restoreAllMocks();
    const deletedAttendanceIds: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/attendance') && init?.method === 'DELETE') {
        const pathPart = url.split('/')[4];
        const id = pathPart ? pathPart.split('?')[0] : '';
        if (id) deletedAttendanceIds.push(id);
        // SAFETY: Fetch delete attendance mock
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Fetch mock attendance list
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-07-28',
            attendance: [
              { attendanceId: 'att1', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T08:00:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
              { attendanceId: 'att2', attendanceDate: '2026-07-28', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-28T08:30:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users mock
        return { ok: true, json: async () => ({ success: true, users: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/profiles')) {
        // SAFETY: Fetch mock payroll profiles
        return { ok: true, json: async () => ({ success: true, profiles: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/cutoffs')) {
        // SAFETY: Fetch mock payroll cutoffs
        return { ok: true, json: async () => ({ success: true, payroll: [] }) } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      expect(await screen.findByText('Total records: 2')).toBeInTheDocument();
      const masterCheckbox = screen.getByRole('checkbox', { name: /select all attendance records/i });
      expect(masterCheckbox).not.toBeChecked();

      await user.click(masterCheckbox);
      expect(masterCheckbox).toBeChecked();
      expect(await screen.findByText('2 of 2 attendance record(s) selected')).toBeInTheDocument();

      const batchDeleteBtn = screen.getByRole('button', { name: /delete selected \(2\)/i });
      await user.click(batchDeleteBtn);

      expect(screen.getByRole('dialog', { name: /delete selected attendance records\?/i })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /confirm/i }));

      await waitFor(() => {
        expect(deletedAttendanceIds).toContain('att1');
        expect(deletedAttendanceIds).toContain('att2');
      });
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('allows registering an Admin RFID card with segmented control', async () => {
    interface CapturedSetupUserPayload {
      rfidUid?: string;
      cardType?: string;
      label?: string;
      userId?: string;
    }
    let capturedUpsertBody: CapturedSetupUserPayload | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Mock config response
        return {
          ok: true,
          json: async () => ({
            success: true,
            timezone: 'Asia/Manila',
            rfidAutoSubmitDelayMs: 30,
            resultResetDelayMs: 500,
            enableCardSetup: true,
          }),
        } as Response;
      }
      if (url.includes('/api/setup/unlock')) {
        // SAFETY: Mock unlock response
        return {
          ok: true,
          json: async () => ({ success: true, setupToken: 'tok-123', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
        } as Response;
      }
      if (url.includes('/api/setup/card')) {
        // SAFETY: Mock lookup response
        return {
          ok: true,
          json: async () => ({ success: true, rfidUid: 'ADDE23', user: null }),
        } as Response;
      }
      if (url.includes('/api/setup/users')) {
        if (init?.body) {
          // SAFETY: Parse mock upsert body
          capturedUpsertBody = JSON.parse(String(init.body)) as CapturedSetupUserPayload;
        }
        // SAFETY: Mock upsert response
        return {
          ok: true,
          json: async () => ({
            success: true,
            created: true,
            user: {
              userId: 'ADMIN_CARD_ADDE23',
              rfidUid: 'ADDE23',
              fullName: 'Front Desk Admin',
              status: 'ACTIVE',
              cardType: 'ADMIN_ASSIST',
            },
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    const user = userEvent.setup();
    render(<App />);

    // Open setup dialog
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    expect(await screen.findByRole('dialog', { name: /associate rfid card/i })).toBeInTheDocument();

    // Enter PIN
    await user.type(screen.getByLabelText(/administrator pin/i), '1234');
    await user.click(screen.getByRole('button', { name: /unlock setup/i }));

    // Scan card
    const cardInput = await screen.findByLabelText(/setup card id/i);
    await user.type(cardInput, 'ADDE23{enter}');

    // Now in edit step: segmented control is visible
    expect(await screen.findByRole('radiogroup', { name: /register card as:/i })).toBeInTheDocument();
    const adminCardOption = screen.getByRole('radio', { name: /admin rfid card/i });
    expect(adminCardOption).not.toBeChecked();

    // Select Admin RFID card
    await user.click(adminCardOption);
    expect(adminCardOption).toBeChecked();

    // Employee fields should be hidden, label field should be visible
    expect(screen.queryByLabelText(/^user id$/i)).not.toBeInTheDocument();
    const labelInput = screen.getByLabelText(/card label/i);
    expect(labelInput).toBeInTheDocument();
    await user.type(labelInput, 'Front Desk Admin');

    // Save admin card
    const saveButton = screen.getByRole('button', { name: /save admin card/i });
    await user.click(saveButton);

    await waitFor(() => {
      expect(capturedUpsertBody).toMatchObject({
        rfidUid: 'ADDE23',
        cardType: 'ADMIN_ASSIST',
        label: 'Front Desk Admin',
      });
    });
  });

  it('handles Admin RFID card tap by opening Assisted Attendance modal and confirming assisted scan', async () => {
    interface CapturedScanPayload {
      rfidUid?: string;
      source?: string;
      targetUserId?: string;
      reason?: string;
    }
    let capturedScanBody: CapturedScanPayload | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Fetch returns mock Response for config
        return {
          ok: true,
          json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }),
        } as Response;
      }
      if (url.includes('/api/attendance/scan')) {
        // SAFETY: Parse mock scan body
        const body = JSON.parse(String(init?.body ?? '{}')) as CapturedScanPayload;
        capturedScanBody = body;
        if (body.source === 'ADMIN_ASSISTED_SCAN') {
          // SAFETY: Return successful assisted scan response
          return {
            ok: true,
            json: async () => ({
              success: true,
              requestId: 'req-assisted',
              action: 'TIME_IN',
              message: 'Time in recorded (assisted)',
              attendance: {
                attendanceId: 'att-assisted',
                attendanceDate: '2026-08-27',
                timeIn: '2026-08-27T09:00:00+08:00',
                timeOut: null,
                status: 'WORKING',
                source: 'ADMIN_ASSISTED_SCAN',
                recordedBy: 'Duty Manager',
                recordedReason: 'Forgot RFID card',
                recordedAt: '2026-08-27T09:00:00+08:00',
              },
              user: {
                userId: 'EMP-01',
                fullName: 'Bob Smith',
                department: 'Operations',
                employeeType: 'EMPLOYEE',
              },
            }),
          } as Response;
        }
        // Initial Admin card scan returns ADMIN_ASSIST prompt
        // SAFETY: Return admin assist prompt
        return {
          ok: true,
          json: async () => ({
            success: true,
            action: 'ADMIN_ASSIST',
            adminCard: {
              rfidUid: 'ADMIN_CARD_UID',
              label: 'Duty Manager',
            },
            activeEmployees: [
              {
                userId: 'EMP-01',
                fullName: 'Bob Smith',
                department: 'Operations',
              },
              {
                userId: 'EMP-02',
                fullName: 'Carol Danvers',
                department: 'Engineering',
              },
            ],
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    const user = userEvent.setup();
    render(<App />);

    // Emit Admin RFID scan
    act(() => {
      emitRfidScan('ADMIN_CARD_UID');
    });

    // Assisted Attendance modal should appear
    expect(await screen.findByRole('dialog', { name: /assisted attendance/i })).toBeInTheDocument();
    expect(screen.getByText(/Duty Manager/i)).toBeInTheDocument();
    expect(screen.getByText(/Auto-cancels in 25s/i)).toBeInTheDocument();

    // Search and select Bob Smith
    const searchInput = screen.getByPlaceholderText(/search employee/i);
    await user.type(searchInput, 'Bob');
    expect(screen.getByText('Bob Smith')).toBeInTheDocument();
    expect(screen.queryByText('Carol Danvers')).not.toBeInTheDocument();

    const employeeOption = screen.getByRole('button', { name: /bob smith/i });
    await user.click(employeeOption);

    // Confirm assisted attendance
    const confirmButton = screen.getByRole('button', { name: /confirm attendance/i });
    expect(confirmButton).toBeEnabled();
    await user.click(confirmButton);

    // Modal closes and Kiosk shows success with assisted badge
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /assisted attendance/i })).not.toBeInTheDocument();
      expect(screen.getByText(/assisted by duty manager/i)).toBeInTheDocument();
    });

    expect(capturedScanBody).toMatchObject({
      rfidUid: 'ADMIN_CARD_UID',
      source: 'ADMIN_ASSISTED_SCAN',
      targetUserId: 'EMP-01',
      reason: 'Forgot RFID card',
    });
  });

  it('renders assisted/backdated badges, filter pills, and supports backdated attendance creation in Admin panel', async () => {
    interface CapturedBackdatePayload {
      userId?: string;
      attendanceDate?: string;
      timeIn?: string;
      timeOut?: string | null;
      reason?: string;
    }
    let capturedBackdateBody: CapturedBackdatePayload | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Return active session
        return { ok: true, json: async () => ({ success: true, authenticated: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Return active users list
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u1', fullName: 'Alice Cooper', department: 'QA', status: 'ACTIVE', cardType: 'EMPLOYEE', rfidUid: 'AC1' },
              { userId: 'ADMIN_CARD_1', fullName: 'Front Desk Admin', department: '', status: 'ACTIVE', cardType: 'ADMIN_ASSIST', rfidUid: 'ADMIN1' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance/backdate')) {
        // SAFETY: Parse mock backdate body
        capturedBackdateBody = JSON.parse(String(init?.body ?? '{}')) as CapturedBackdatePayload;
        // SAFETY: Return backdate success
        return {
          ok: true,
          json: async () => ({
            success: true,
            attendance: {
              attendanceId: 'backdate-1',
              userId: 'u1',
              attendanceDate: '2026-08-20',
              timeIn: '2026-08-20T08:00:00+08:00',
              timeOut: '2026-08-20T17:00:00+08:00',
              status: 'COMPLETED',
              source: 'ADMIN_BACKDATED_ENTRY',
              recordedBy: 'Admin',
              recordedReason: 'Forgot card last week',
              recordedAt: '2026-08-27T09:00:00+08:00',
            },
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Return attendance with assisted and backdated rows
        return {
          ok: true,
          json: async () => ({
            success: true,
            attendance: [
              {
                attendanceId: 'att-norm',
                userId: 'u1',
                fullName: 'Alice Cooper',
                department: 'QA',
                attendanceDate: '2026-08-27',
                timeIn: '2026-08-27T08:00:00+08:00',
                timeOut: null,
                status: 'WORKING',
                source: 'RFID',
              },
              {
                attendanceId: 'att-asst',
                userId: 'u1',
                fullName: 'Alice Cooper',
                department: 'QA',
                attendanceDate: '2026-08-27',
                timeIn: '2026-08-27T09:00:00+08:00',
                timeOut: null,
                status: 'WORKING',
                source: 'ADMIN_ASSISTED_SCAN',
                recordedBy: 'Duty Manager',
                recordedReason: 'Forgot RFID card',
                recordedAt: '2026-08-27T09:00:00+08:00',
              },
              {
                attendanceId: 'att-bdt',
                userId: 'u1',
                fullName: 'Alice Cooper',
                department: 'QA',
                attendanceDate: '2026-08-20',
                timeIn: '2026-08-20T08:00:00+08:00',
                timeOut: '2026-08-20T17:00:00+08:00',
                status: 'COMPLETED',
                source: 'ADMIN_BACKDATED_ENTRY',
                recordedBy: 'Admin',
                recordedReason: 'Physical attendance verified',
                recordedAt: '2026-08-27T09:00:00+08:00',
              },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/payroll/profiles')) {
        // SAFETY: Return empty profiles
        return { ok: true, json: async () => ({ success: true, profiles: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/cutoffs')) {
        // SAFETY: Return empty cutoffs
        return { ok: true, json: async () => ({ success: true, records: [] }) } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    window.history.pushState({}, '', '/admin');
    const user = userEvent.setup();
    render(<App />);

    // Switch to Attendance tab
    await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

    // Badges should be visible in the table
    expect(await screen.findByText(/assisted by duty manager/i)).toBeInTheDocument();
    expect(screen.getByText(/backdated entry by admin — physical attendance verified/i)).toBeInTheDocument();

    // Filter pills should show counts
    const assistedPill = screen.getByRole('button', { name: /assisted 1/i });
    const backdatedPill = screen.getByRole('button', { name: /backdated 1/i });
    expect(assistedPill).toBeInTheDocument();
    expect(backdatedPill).toBeInTheDocument();

    // Click "+ Add missed attendance"
    const addMissedButton = screen.getByRole('button', { name: /\+ add missed attendance/i });
    await user.click(addMissedButton);

    // Modal opens
    const dialog = await screen.findByRole('dialog', { name: /add missed attendance/i });
    expect(dialog).toBeInTheDocument();

    // Employee select should contain active employee (Alice Cooper), but not admin card
    const employeeSelect = within(dialog).getByLabelText(/^employee:$/i);
    expect(employeeSelect).toHaveTextContent('Alice Cooper');
    expect(employeeSelect).not.toHaveTextContent('Front Desk Admin');

    // Fill in reason
    const reasonInput = within(dialog).getByLabelText(/reason \(mandatory audit trail\):/i);
    await user.type(reasonInput, 'Employee verified on site');

    // Submit backdated entry
    const submitButton = within(dialog).getByRole('button', { name: /add missed attendance/i });
    await user.click(submitButton);

    await waitFor(() => {
      expect(capturedBackdateBody).toMatchObject({
        userId: 'u1',
        reason: 'Employee verified on site',
      });
    });
  });

  it('creates a correction for 2026-09-01 while today is 2026-09-02 and ensures the row still shows 2026-09-01', async () => {
    vi.restoreAllMocks();
    let capturedBody: {
      userId?: string;
      attendanceDate?: string;
      timeIn?: string;
      timeOut?: string | null;
      reason?: string;
    } | null = null;
    const recordsMap = new Map<string, Array<{
      attendanceId: string;
      userId: string;
      fullName: string;
      department: string;
      attendanceDate: string;
      timeIn: string | null;
      timeOut: string | null;
      status: string;
      source: string;
      recordedBy?: string;
      recordedReason?: string;
      recordedAt?: string;
    }>>();
    recordsMap.set('2026-09-02', []);
    recordsMap.set('2026-09-01', []);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch admin session mock
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users mock
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [{ userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', status: 'ACTIVE', cardType: 'EMPLOYEE' }],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance/backdate') && init?.method === 'POST') {
        capturedBody = JSON.parse(String(init.body));
        const newRecord = {
          attendanceId: 'att-bdt-1',
          userId: 'u1',
          fullName: 'Ada Lovelace',
          department: 'Engineering',
          attendanceDate: capturedBody?.attendanceDate ?? '2026-09-01',
          timeIn: capturedBody?.timeIn ?? null,
          timeOut: capturedBody?.timeOut ?? null,
          status: 'COMPLETED',
          source: 'ADMIN_BACKDATED_ENTRY',
          recordedBy: 'Admin',
          recordedReason: capturedBody?.reason,
          recordedAt: '2026-09-02T08:00:00+08:00',
        };
        const list = recordsMap.get(newRecord.attendanceDate) ?? [];
        list.push(newRecord);
        recordsMap.set(newRecord.attendanceDate, list);
        // SAFETY: Return backdated attendance response
        return { ok: true, json: async () => ({ success: true, attendance: newRecord }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        const match = url.match(/date=([^&]+)/);
        const reqDate = match ? match[1] : '2026-09-02';
        // SAFETY: Return attendance for requested date
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: reqDate,
            attendance: recordsMap.get(reqDate) ?? [],
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true, profiles: [], cutoffs: [] }) } as Response;
    });

    window.history.pushState({}, '', '/admin');
    const user = userEvent.setup();
    render(<App />);

    try {
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      // Click Add missed attendance
      await user.click(screen.getByRole('button', { name: /\+ add missed attendance/i }));

      const dialog = await screen.findByRole('dialog', { name: /add missed attendance/i });
      expect(dialog).toBeInTheDocument();

      // Change attendance date to 2026-09-01
      const dateInput = within(dialog).getByLabelText(/attendance date \(past date only\):/i);
      fireEvent.change(dateInput, { target: { value: '2026-09-01' } });

      const reasonInput = within(dialog).getByLabelText(/reason \(mandatory audit trail\):/i);
      await user.type(reasonInput, 'Forgotten checkout on 09/01');

      // Submit
      const submitBtn = within(dialog).getByRole('button', { name: /add missed attendance/i });
      await user.click(submitBtn);

      // Verify payload
      await waitFor(() => {
        expect(capturedBody).toMatchObject({
          userId: 'u1',
          attendanceDate: '2026-09-01',
          timeIn: '2026-09-01T08:00:00+08:00',
          timeOut: '2026-09-01T17:00:00+08:00',
        });
      });

      // The row for 2026-09-01 is displayed in the table with date 2026-09-01
      expect(await screen.findByText('2026-09-01')).toBeInTheDocument();
      expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('filters attendance by specific date and verifies records for that date are shown', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-02T10:00:00+08:00'));
    type MockAttendanceItem = {
      attendanceId: string;
      userId: string;
      fullName: string;
      department: string;
      attendanceDate: string;
      timeIn: string | null;
      timeOut: string | null;
      status: string;
    };
    type AttendanceDateRecords = Record<string, MockAttendanceItem[]>;
    const recordsByDate: AttendanceDateRecords = {
      '2026-08-30': [
        { attendanceId: 'att-1', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', attendanceDate: '2026-08-30', timeIn: '2026-08-30T08:00:00+08:00', timeOut: '2026-08-30T17:00:00+08:00', status: 'COMPLETED' },
      ],
      '2026-09-01': [
        { attendanceId: 'att-2', userId: 'u2', fullName: 'Charles Babbage', department: 'Engineering', attendanceDate: '2026-09-01', timeIn: '2026-09-01T08:30:00+08:00', timeOut: '2026-09-01T17:30:00+08:00', status: 'COMPLETED' },
      ],
      '2026-09-02': [
        { attendanceId: 'att-3', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', attendanceDate: '2026-09-02', timeIn: '2026-09-02T08:15:00+08:00', timeOut: null, status: 'WORKING' },
      ],
      '2026-09-05': [
        { attendanceId: 'att-4', userId: 'u3', fullName: 'Grace Hopper', department: 'Engineering', attendanceDate: '2026-09-05', timeIn: '2026-09-05T09:00:00+08:00', timeOut: '2026-09-05T18:00:00+08:00', status: 'COMPLETED' },
      ],
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch admin session mock
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        const match = url.match(/date=([^&]+)/);
        const reqDate = match ? match[1] : '2026-09-02';
        const rows = recordsByDate[reqDate] ?? [];
        // SAFETY: Return attendance for requested date
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: reqDate,
            attendance: rows,
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true, users: [], profiles: [], cutoffs: [] }) } as Response;
    });

    window.history.pushState({}, '', '/admin');
    const user = userEvent.setup();
    render(<App />);

    try {
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      // By default, initial date shows Ada Lovelace for 2026-09-02
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

      // Change specific date to 2026-09-01
      const dateInput = screen.getByLabelText(/filter attendance date/i);
      fireEvent.change(dateInput, { target: { value: '2026-09-01' } });

      // After changing date to 2026-09-01, Charles Babbage is shown
      expect(await screen.findByText('Charles Babbage')).toBeInTheDocument();
      expect(screen.getByText('2026-09-01')).toBeInTheDocument();

      // Other dates are not shown
      expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
      expect(screen.queryByText('2026-08-30')).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      window.history.pushState({}, '', '/');
    }
  });

  it('ensures editing a correction does not change its displayed date in the table or request payload', async () => {
    vi.restoreAllMocks();
    let savedPayload: {
      attendanceDate?: string;
      timeIn?: string | null;
      timeOut?: string | null;
    } | null = null;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch admin session mock
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/attendance/att-edit-1') && init?.method === 'PATCH') {
        savedPayload = JSON.parse(String(init.body));
        // SAFETY: Return patched attendance
        return {
          ok: true,
          json: async () => ({
            success: true,
            attendance: {
              attendanceId: 'att-edit-1',
              attendanceDate: '2026-09-01',
              userId: 'u1',
              fullName: 'Ada Lovelace',
              department: 'Engineering',
              timeIn: savedPayload?.timeIn,
              timeOut: savedPayload?.timeOut,
              status: 'COMPLETED',
            },
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Return attendance for Ada Lovelace on 2026-09-01
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-09-01',
            attendance: [
              {
                attendanceId: 'att-edit-1',
                attendanceDate: '2026-09-01',
                userId: 'u1',
                fullName: 'Ada Lovelace',
                department: 'Engineering',
                timeIn: '2026-09-01T08:00:00+08:00',
                timeOut: '2026-09-01T17:00:00+08:00',
                status: 'COMPLETED',
              },
            ],
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true, users: [], profiles: [], cutoffs: [] }) } as Response;
    });

    window.history.pushState({}, '', '/admin');
    const user = userEvent.setup();
    render(<App />);

    try {
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      // Table row shows 2026-09-01
      expect(await screen.findByText('2026-09-01')).toBeInTheDocument();

      // Edit time-out
      const timeOutInput = screen.getByLabelText(/^time out for ada lovelace$/i);
      fireEvent.change(timeOutInput, { target: { value: '18:00' } });

      // Save
      await user.click(screen.getByRole('button', { name: /^save$/i }));

      await waitFor(() => {
        expect(savedPayload).toMatchObject({
          attendanceDate: '2026-09-01',
          timeIn: '2026-09-01T08:00:00+08:00',
          timeOut: '2026-09-01T18:00:00+08:00',
        });
      });

      // Row still displays 2026-09-01
      expect(screen.getByText('2026-09-01')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('allows unlocking setup dialog alternatively using Admin RFID card tap without typing password', async () => {
    let capturedUnlockBody: { pin?: string; rfidUid?: string } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Return config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
      }
      if (url.includes('/api/setup/unlock')) {
        // SAFETY: Test JSON parse
        capturedUnlockBody = JSON.parse(String(init?.body)) as { pin?: string; rfidUid?: string };
        // SAFETY: Return unlock token
        return { ok: true, json: async () => ({ success: true, setupToken: 'token-by-admin-rfid', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    window.history.pushState({}, '', '/');
    const user = userEvent.setup();
    render(<App />);

    // Open Admin Setup modal
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));

    // Modal is at step 01 Unlock
    expect(screen.getByText(/01 unlock/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter pin or scan admin card/i)).toBeInTheDocument();

    // Tap registered Admin RFID card
    await act(async () => {
      for (const h of rfidHandlers) h('ADDE23');
    });

    // Automatically transitions to Step 02 Scan card
    await screen.findByLabelText(/setup card id/i);
    expect(capturedUnlockBody).toEqual({ pin: 'ADDE23' });
    expect(screen.getByText(/new card enrollment/i)).toBeInTheDocument();
  });

  it('allows unlocking Admin panel alternatively using Admin RFID card tap without typing password', async () => {
    let capturedAdminUnlockBody: { pin?: string; rfidUid?: string } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Return config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/unlock')) {
        // SAFETY: Test JSON parse
        capturedAdminUnlockBody = JSON.parse(String(init?.body)) as { pin?: string; rfidUid?: string };
        // SAFETY: Return admin unlock session
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: false, status: 401, json: async () => ({ success: false }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Mock users list
        return { ok: true, json: async () => ({ success: true, users: [] }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Mock attendance list
        return { ok: true, json: async () => ({ success: true, attendance: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/profiles')) {
        // SAFETY: Mock payroll profiles
        return { ok: true, json: async () => ({ success: true, profiles: [] }) } as Response;
      }
      if (url.includes('/api/admin/payroll/cutoffs')) {
        // SAFETY: Mock payroll cutoffs
        return { ok: true, json: async () => ({ success: true, payroll: [] }) } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    window.history.pushState({}, '', '/admin');
    render(<App />);

    // Login screen is visible
    expect(await screen.findByRole('button', { name: /unlock admin/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/enter pin or scan admin card/i)).toBeInTheDocument();

    // Tap registered Admin RFID card
    await act(async () => {
      for (const h of rfidHandlers) h('ADDE23');
    });

    // Unlocks Admin panel directly
    expect(capturedAdminUnlockBody).toEqual({ pin: 'ADDE23' });
    expect(await screen.findByRole('button', { name: /users and rfid/i })).toBeInTheDocument();
  });

  it('switches between Attendance and Bathroom Key Log mode via header buttons and 1/2 keybindings', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila' }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Mock users list
        return { ok: true, json: async () => ({ success: true, users: [] }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Mock attendance list
        return { ok: true, json: async () => ({ success: true, attendance: [] }) } as Response;
      }
      if (url.includes('/api/admin/bathroom/status')) {
        // SAFETY: Mock bathroom status
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-08-27',
            maleActive: null,
            femaleActive: null,
            maleLogs: [],
            femaleLogs: [],
            fetchedAt: '2026-08-27T10:00:00Z',
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true, profiles: [], payroll: [] }) } as Response;
    });

    window.history.pushState({}, '', '/admin');
    const user = userEvent.setup();
    render(<App />);

    // Initially in Attendance mode
    expect(await screen.findByRole('button', { name: /users and rfid/i })).toBeInTheDocument();

    const attendanceModeBtn = screen.getByRole('tab', { name: /^attendance$/i });
    const bathroomModeBtn = screen.getByRole('tab', { name: /^bathroom key log$/i });
    expect(attendanceModeBtn).toHaveClass('is-active');
    expect(bathroomModeBtn).not.toHaveClass('is-active');

    // 1. Click button to switch to Bathroom Key Log mode
    await user.click(bathroomModeBtn);
    expect(await screen.findByRole('heading', { name: /bathroom key log/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /users and rfid/i })).not.toBeInTheDocument();

    // 2. Press "1" key to switch back to Attendance mode
    fireEvent.keyDown(window, { key: '1' });
    expect(await screen.findByRole('button', { name: /users and rfid/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /bathroom key log/i })).not.toBeInTheDocument();

    // 3. Press "2" key to switch to Bathroom Key Log mode
    fireEvent.keyDown(window, { key: '2' });
    expect(await screen.findByRole('heading', { name: /bathroom key log/i })).toBeInTheDocument();

    // 4. Pressing "1" inside a focused input must NOT switch mode
    const searchInput = screen.getAllByPlaceholderText(/search staff by name or id…/i)[0];
    searchInput.focus();
    fireEvent.keyDown(searchInput, { key: '1' });
    // Still in bathroom mode
    expect(screen.getByRole('heading', { name: /bathroom key log/i })).toBeInTheDocument();
  });

  it('switches between Attendance and Bathroom Key Log mode on the Kiosk', async () => {
    window.history.pushState({}, '', '/');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    // Initially in Attendance mode
    expect(screen.getByTestId('kiosk-mode-attendance')).toHaveClass('active');
    expect(screen.getByTestId('kiosk-mode-bathroom')).not.toHaveClass('active');
    expect(screen.getByText(/alpha premier/i)).toBeInTheDocument();

    // 1. Click Bathroom Key Log mode tab on Kiosk
    await user.click(screen.getByTestId('kiosk-mode-bathroom'));
    expect(screen.getByTestId('kiosk-mode-bathroom')).toHaveClass('active');
    expect(await screen.findByTestId('bathroom-kiosk-view')).toBeInTheDocument();
    expect(screen.getByTestId('bathroom-kiosk-card-male')).toBeInTheDocument();
    expect(screen.getByTestId('bathroom-kiosk-card-female')).toBeInTheDocument();

    // 2. Click Attendance mode tab to switch back
    await user.click(screen.getByTestId('kiosk-mode-attendance'));
    expect(screen.getByTestId('kiosk-mode-attendance')).toHaveClass('active');
    expect(screen.queryByTestId('bathroom-kiosk-view')).not.toBeInTheDocument();
  });

  it('announces bathroom key checkout, return, and in-use errors in bathroom kiosk mode', async () => {
    window.history.pushState({}, '', '/');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const user = userEvent.setup();

    let bathroomScanMock: BathroomScanResponse = {
      success: true,
      action: 'CHECKOUT',
      genderKey: 'MALE',
      user: {
        userId: 'EMP-01',
        fullName: 'John Doe',
        department: 'Engineering',
        photoUrl: null,
        gender: 'MALE',
      },
      timeOut: '2026-08-28T10:00:00+08:00',
      message: 'Male floor key checked out',
      timestamp: '2026-08-28T10:00:00+08:00',
    };

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/bathroom/scan')) {
        // SAFETY: Mock bathroom scan response
        return { ok: true, json: async () => bathroomScanMock } as Response;
      }
      if (url.includes('/bathroom/status')) {
        // SAFETY: Mock bathroom status
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-08-28',
            maleActive: null,
            femaleActive: null,
            maleLogs: [],
            femaleLogs: [],
            fetchedAt: '2026-08-28T10:00:00Z',
          }),
        } as Response;
      }
      // SAFETY: Generic fallback
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    render(<App />);

    // Switch to Bathroom mode
    await user.click(screen.getByTestId('kiosk-mode-bathroom'));
    expect(await screen.findByTestId('bathroom-kiosk-view')).toBeInTheDocument();

    // 1. Scan for checkout
    act(() => emitRfidScan('MALE-CARD-01'));
    expect(await screen.findByText('John Doe')).toBeInTheDocument();
    expect(ttsService.announceBathroom).toHaveBeenCalledWith({
      action: 'CHECKOUT',
      genderKey: 'MALE',
      employeeName: 'John Doe',
      personId: 'EMP-01',
      remindReturnWindow: true,
    });

    // 2. Scan for return
    bathroomScanMock = {
      success: true,
      action: 'RETURN',
      genderKey: 'FEMALE',
      user: {
        userId: 'EMP-02',
        fullName: 'Jane Smith',
        department: 'Design',
        photoUrl: null,
        gender: 'FEMALE',
      },
      timeOut: '2026-08-28T09:50:00+08:00',
      timeIn: '2026-08-28T10:00:00+08:00',
      durationSeconds: 600,
      message: 'Female floor key returned',
      timestamp: '2026-08-28T10:00:00+08:00',
    };
    act(() => emitRfidScan('FEMALE-CARD-01'));
    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    expect(ttsService.announceBathroom).toHaveBeenCalledWith({
      action: 'RETURN',
      genderKey: 'FEMALE',
      employeeName: 'Jane Smith',
      personId: 'EMP-02',
    });

    // 3. Scan with key in use error
    bathroomScanMock = {
      success: false,
      error: {
        code: 'BATHROOM_KEY_IN_USE',
        message: 'The male bathroom key is currently in use by John Doe.',
      },
      genderKey: 'MALE',
      activeHolder: {
        logId: 'log-1',
        userId: 'EMP-01',
        fullName: 'John Doe',
        department: 'Engineering',
        genderKey: 'MALE',
        timeOut: '2026-08-28T10:00:00+08:00',
      },
    };
    act(() => emitRfidScan('MALE-CARD-02'));
    expect(await screen.findByText(/currently in use by/i)).toBeInTheDocument();
    expect(ttsService.announceScanError).toHaveBeenCalledWith({
      errorCode: 'BATHROOM_KEY_IN_USE',
      message: 'The male bathroom key is currently in use by John Doe.',
      activeHolderName: 'John Doe',
      activeHolderId: 'EMP-01',
      genderKey: 'MALE',
    });
  });
});
