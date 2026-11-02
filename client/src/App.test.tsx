import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App, { greetingForDate, shouldRouteGlobalRfidToSetup, ScannerDiagnostics, PayrollWorkspace } from './App';
import { unlockAdmin } from './api';
import * as api from './api';
import * as ttsService from './services/ttsService';
import * as tauriApi from './tauri-api';
import { resetDtrSyncGuardForTests, setDtrSyncHealthSnapshot } from './dtr-sync-guard';
import type { BathroomScanResponse, PayrollCutoffRecord, ScannerStatus } from '@rfid-attendance/shared';

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
  vi.spyOn(tauriApi, 'listenForDtrSyncProgress').mockImplementation(() => Promise.resolve(() => {}));
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
  it('marks the kiosk DTR badge as attention when DEAD items exist', async () => {
    const emittedAt = new Date().toISOString();
    act(() => {
      setDtrSyncHealthSnapshot({
        activity: 'idle',
        queued: 0,
        retryablePending: 0,
        needsAttention: 0,
        dead: 1,
        persistenceFailure: false,
        emittedAt,
      });
    });
    render(<App />);
    expect(await screen.findByLabelText('Intern DTR sync health')).toHaveClass('attention');
    act(() => {
      setDtrSyncHealthSnapshot({
        activity: 'idle',
        queued: 0,
        retryablePending: 0,
        needsAttention: 0,
        dead: 0,
        persistenceFailure: true,
        emittedAt,
      });
    });
    expect(await screen.findByText('Attendance could not be queued for DTR sync; notify an administrator.')).toBeInTheDocument();
    expect(screen.queryByText('No DTR items queued')).not.toBeInTheDocument();
    act(() => resetDtrSyncGuardForTests());
  });

  it('renders retryable work from the complete DTR health event', async () => {
    let healthHandler: ((payload: tauriApi.DtrSyncHealthEvent) => void) | null = null;
    vi.spyOn(tauriApi, 'listenForDtrSyncHealth').mockImplementation((handler) => {
      healthHandler = handler;
      return Promise.resolve(() => {});
    });
    render(<App />);
    await waitFor(() => expect(healthHandler).not.toBeNull());

    act(() => {
      healthHandler?.({
        activity: 'retrying',
        queued: 0,
        retryablePending: 2,
        needsAttention: 0,
        dead: 0,
        persistenceFailure: false,
        emittedAt: new Date().toISOString(),
      });
    });

    expect(await screen.findByText('2 punches are waiting for retry; attempts are bounded.')).toBeInTheDocument();
    expect(screen.queryByText('No DTR items queued')).not.toBeInTheDocument();
  });

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

  it('shows a scan notice when the wedge drops an unrecognized burst', async () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<App />);
    const input = screen.getByLabelText(/scanner card id/i);
    for (const key of ['0', '1', '2', '3', '4', '5', '6', '7', '8']) fireEvent.keyDown(input, { key });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByTestId('kiosk-scan-notice')).toHaveTextContent(/not recognized/i);
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
      attendanceDate: '2026-07-28',
      employeeType: undefined,
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
      attendanceDate: '2026-07-28',
      employeeType: undefined,
      isLateTimeout: false,
      isAssisted: false,
      isFirstTimeInToday: true,
      timeInIso: '2026-07-28T08:08:00+08:00',
    });
  });

  it('marks the second grace-window arrival in the same week as late', async () => {
    const currentResponse = {
      ...successResponse,
      attendance: {
        ...successResponse.attendance,
        attendanceDate: '2026-07-28',
        attendanceId: 'att-tuesday',
        timeIn: '2026-07-28T08:08:00+08:00',
      },
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Config response matches the shape consumed by loadConfig.
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
      }
      if (url === '/api/attendance/scan') {
        // SAFETY: Scan response matches the typed success fixture.
        return { ok: true, json: async () => currentResponse } as Response;
      }
      const date = new URL(url, window.location.origin).searchParams.get('date');
      const attendance = date === '2026-07-27'
        ? [{ attendanceId: 'att-monday', attendanceDate: '2026-07-27', userId: 'u-1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-27T08:06:00+08:00', timeOut: null, status: 'WORKING' }]
        : [{ attendanceId: 'att-tuesday', attendanceDate: '2026-07-28', userId: 'u-1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T08:08:00+08:00', timeOut: null, status: 'WORKING' }];
      // SAFETY: Attendance response matches the list contract for weekly evaluation.
      return { ok: true, json: async () => ({ success: true, date, attendance, fetchedAt: '2026-07-28T09:00:00+08:00' }) } as Response;
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    await screen.findByText('Ada Lovelace');
    await waitFor(() => expect(ttsService.announceAttendance).toHaveBeenCalledWith(expect.objectContaining({
      attendanceType: 'time_in',
      arrivalStatus: 'LATE',
      timeInIso: '2026-07-28T08:08:00+08:00',
    })));
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
      attendanceDate: '2026-07-28',
      employeeType: undefined,
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
      attendanceDate: '2026-07-28',
      employeeType: undefined,
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
      attendanceDate: '2026-07-28',
      employeeType: undefined,
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
    expect(await screen.findByText('Card not registered')).toBeInTheDocument();
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

  it('header pill follows the scan: Reading…, then Done or Error, then back to Ready', async () => {
    let resolveScan: ((value: Response) => void) | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 1200 }) } as Response;
      }
      if (url !== '/api/attendance/scan') {
        // SAFETY: Fetch returns an empty day for the headcount and the week's arrival history
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance: [], fetchedAt: '2026-07-28T09:00:00+08:00' }) } as Response;
      }
      return new Promise<Response>((resolve) => { resolveScan = resolve; });
    });
    // A 1.2 s result window, so Done and Error stay long enough to observe when the whole suite runs at once.
    render(<App />);
    const scannerPill = () => document.querySelector('.scanner-pill');
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Ready'));

    act(() => emitRfidScan('0000000001'));
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Reading…'));
    await act(async () => {
      // SAFETY: Resolve scan promise with mock Response
      resolveScan?.({ ok: true, json: async () => successResponse } as Response);
    });
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Done'));
    expect(scannerPill()).toHaveClass('is-connected');
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Ready'), { timeout: 4_000 });

    act(() => emitRfidScan('0000000002'));
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Reading…'));
    await act(async () => {
      // SAFETY: Resolve scan promise with mock error Response
      resolveScan?.({ ok: true, json: async () => ({ success: false, requestId: 'req-err', error: { code: 'UNKNOWN_RFID_CARD', message: 'This RFID card is not registered.' } }) } as Response);
    });
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Error'));
    expect(scannerPill()).toHaveClass('is-error');
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Ready'), { timeout: 4_000 });
  }, 15_000);

  it('keeps the header pill calm on a repeat tap (the kiosk shows Already scanned)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 1200 }) } as Response;
      }
      if (url !== '/api/attendance/scan') {
        // SAFETY: Fetch returns an empty day for the headcount and the week's arrival history
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance: [], fetchedAt: '2026-07-28T09:00:00+08:00' }) } as Response;
      }
      // SAFETY: Fetch returns the backend's repeat-tap rejection
      return { ok: true, json: async () => ({ success: false, requestId: 'req-dup', error: { code: 'DUPLICATE_SCAN', message: 'Card scanned too recently.' } }) } as Response;
    });
    render(<App />);
    const scannerPill = () => document.querySelector('.scanner-pill');
    await waitFor(() => expect(scannerPill()).toHaveTextContent('Ready'));
    act(() => emitRfidScan('0000000003'));
    expect(await screen.findByText(/already scanned/i)).toBeInTheDocument();
    expect(scannerPill()).toHaveTextContent('Done');
    expect(scannerPill()).not.toHaveClass('is-error');
  });

  it('keeps processing guard active during an in-flight scan', async () => {
    let resolveScan: ((value: Response) => void) | undefined;
    const scanCalls = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/config') {
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
      }
      if (String(input) === '/api/attendance') {
        // SAFETY: Fetch returns an empty day for the in-office headcount
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance: [], fetchedAt: '2026-07-28T09:00:00+08:00' }) } as Response;
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

  it('routes the manual Record button to the bathroom pipeline in bathroom mode (B1)', async () => {
    window.history.pushState({}, '', '/');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === '/api/config') {
        // SAFETY: Fetch returns mock Response for config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
      }
      if (url.startsWith('/api/bathroom/status')) {
        // SAFETY: Fetch returns mock bathroom status
        return { ok: true, json: async () => ({ success: true, maleActive: null, femaleActive: null, maleLogs: [], femaleLogs: [] }) } as Response;
      }
      if (url === '/api/bathroom/scan') {
        // SAFETY: Fetch returns mock bathroom checkout
        return { ok: true, json: async () => ({ success: true, action: 'CHECKOUT', genderKey: 'MALE', user: { userId: 'u-1', fullName: 'Ada Lovelace' }, message: 'ok', timestamp: '2026-07-28T09:00:00+08:00' }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByTestId('kiosk-mode-bathroom'));
    expect(await screen.findByTestId('bathroom-kiosk-view')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /manual entry/i }));
    await user.type(screen.getByLabelText(/manual card id/i), 'BATH-001');
    await user.click(screen.getByRole('button', { name: /record/i }));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/bathroom/scan',
      expect.objectContaining({ body: JSON.stringify({ rfidUid: 'BATH-001', source: 'MANUAL_TEST' }) }),
    ));
    expect(globalThis.fetch).not.toHaveBeenCalledWith('/api/attendance/scan', expect.anything());
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
    expect(await screen.findByText('Card not registered')).toBeInTheDocument();
    expect(screen.getByText('Please ask an admin to set up this card.')).toBeInTheDocument();
    expect(screen.queryByText('UNKNOWN RFID CARD')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('heading', { name: /good (morning|afternoon|evening)/i })).toBeInTheDocument(), { timeout: 1_000 });
  });

  it('explains an inactive card in plain words with a next step', async () => {
    mockFetch({
      success: false,
      requestId: 'req-inactive',
      error: { code: 'INACTIVE_USER', message: 'This user is inactive.' },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(await screen.findByText('Card inactive')).toBeInTheDocument();
    expect(screen.getByText('Please see an admin to turn this card back on.')).toBeInTheDocument();
    expect(screen.queryByText('INACTIVE USER')).not.toBeInTheDocument();
  });

  it('keeps showing the system message for errors without a plain-word version', async () => {
    mockFetch({
      success: false,
      requestId: 'req-rate',
      error: { code: 'RATE_LIMITED', message: 'Too many scans. Please wait a moment.' },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(await screen.findByText('Too many scans. Please wait a moment.')).toBeInTheDocument();
    expect(screen.queryByText('RATE LIMITED')).not.toBeInTheDocument();
  });

  it('shows how many people are in the office (timed in, not yet out) in the header', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      if (String(input) === '/api/attendance') {
        // SAFETY: Fetch returns today's attendance for the headcount
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-07-28',
            fetchedAt: '2026-07-28T09:00:00+08:00',
            attendance: [{ status: 'WORKING' }, { status: 'WORKING' }, { status: 'COMPLETED' }, { status: 'LATE_TIMEOUT' }],
          }),
        } as Response;
      }
      // SAFETY: Fetch returns mock Response for config and other requests
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
    });
    render(<App />);
    expect(await screen.findByTestId('kiosk-in-office')).toHaveTextContent('2 in office');
  });

  it('puts the cursor in the field when Manual entry opens', async () => {
    const user = userEvent.setup();
    mockFetch();
    render(<App />);
    await user.click(screen.getByTestId('kiosk-manual-toggle'));
    await waitFor(() => expect(screen.getByLabelText('Manual card ID')).toHaveFocus());
  });

  it('shows what was recorded in an action band instead of the stock confirmation', async () => {
    mockFetch({ ...successResponse, message: 'Time In recorded successfully.' });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    const result = await screen.findByTestId('kiosk-result-success');
    expect(within(result).getByText('Time in')).toBeInTheDocument();
    expect(within(result).getByText(/9:00/)).toBeInTheDocument();
    expect(within(result).queryByText('Time In recorded successfully.')).not.toBeInTheDocument();
  });

  it('keeps a server message that says more than the stock confirmation', async () => {
    mockFetch({ ...successResponse, message: 'Lunch break started. Tap again when you are back.' });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(await screen.findByText('Lunch break started. Tap again when you are back.')).toBeInTheDocument();
  });

  it('shows initials when the intern has no ID photo', async () => {
    mockFetch({ ...successResponse, user: { ...successResponse.user, photoUrl: null } });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(await screen.findByLabelText('ID photo unavailable')).toHaveTextContent('AL');
  });

  it('explains a repeat tap in plain words instead of an error code', async () => {
    mockFetch({
      success: false,
      requestId: 'req-dup',
      error: { code: 'DUPLICATE_SCAN', message: 'This card was scanned too recently.' },
    });
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(await screen.findByText('Already scanned')).toBeInTheDocument();
    expect(screen.queryByText('DUPLICATE SCAN')).not.toBeInTheDocument();
  });

  it('shows a saved-offline card for a queued scan', async () => {
    mockFetch({
      success: true,
      offlineQueued: true,
      message: 'Attendance saved offline. Will automatically sync when reconnected.',
    });
    render(<App />);
    act(() => emitRfidScan('OFFLINE01'));
    expect(within(await screen.findByTestId('kiosk-result-offline')).getByText('Saved offline')).toBeInTheDocument();
  });

  it('shows a cannot-reach card when the scan gets no answer', async () => {
    mockFetch();
    vi.spyOn(api, 'submitScan').mockRejectedValue(new Error('network down'));
    render(<App />);
    act(() => emitRfidScan('04A1B2C3'));
    expect(within(await screen.findByTestId('kiosk-result-unreachable')).getByText("Can't reach the system")).toBeInTheDocument();
  });

  it('handles offline queued scans and returns to ready after reset delay', async () => {
    mockFetch({
      success: true,
      offlineQueued: true,
      message: 'Attendance saved offline. Will automatically sync when reconnected.',
    });
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    act(() => emitRfidScan('OFFLINE01'));
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

  it('shows a late time-out as its own status word in the live attendance view', async () => {
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
                { attendanceId: 'a3', attendanceDate: '2026-07-28', userId: 'u3', fullName: 'Alan Turing', department: 'Engineering', timeIn: '2026-07-28T08:10:00+08:00', timeOut: '2026-07-28T18:20:00+08:00', status: 'LATE_TIMEOUT' },
              ],
            }),
          } as Response;
        }
        // SAFETY: Fetch returns fallback success Response mock
        return { ok: true, json: async () => ({ success: true }) } as Response;
      });
      render(<App />);
      // A dot and a word, the same name everywhere ("Late time-out"), with the reason in its tooltip.
      const lates = await screen.findAllByText('Late time-out');
      expect(lates).toHaveLength(2);
      const [late] = lates;
      expect(late).toHaveClass('status-word', 'is-late_timeout');
      expect(late).toHaveAttribute('title', 'Timed out after office hours; the time-out needs correcting');
      // The chip above counts them in the plural.
      expect(screen.getByRole('list', { name: 'Today at a glance' })).toHaveTextContent('2 late time-outs');
      expect(screen.queryByText('Correction needed')).not.toBeInTheDocument();
      // Normal shifts show their own word with the same dot.
      expect(screen.getByText('Completed')).toHaveClass('status-word', 'is-completed');
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
    expect(screen.getByLabelText(/^user id/i)).toHaveAttribute('placeholder', 'e.g. APG-2026-001');
    await user.type(screen.getByLabelText(/^user id/i), 'EMP-002');
    // Not the usual intern format: a quiet hint under the field, and Save still works below.
    expect(screen.getByText('Usual format: APG-YYYY-NNN')).toBeInTheDocument();
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

  it('shows no User ID format hint for an existing card saved with another ID style', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch returns config Response mock (long auto-submit delay: the card is submitted with Enter)
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 5_000, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
      }
      if (url.includes('/api/setup/unlock')) {
        // SAFETY: Fetch returns unlock Response mock
        return { ok: true, json: async () => ({ success: true, setupToken: 'setup-token', expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/setup/card')) {
        // SAFETY: Fetch returns an existing demo card
        return { ok: true, json: async () => ({ success: true, rfidUid: 'DEMO0002', user: { userId: 'APG-DEMO-002', fullName: 'Juan Dela Cruz', department: 'IT', status: 'ACTIVE', rfidUid: 'DEMO0002', cardType: 'EMPLOYEE', gender: null, dailyRate: null, photoUrl: null } }) } as Response;
      }
      // SAFETY: Fetch returns fallback Response mock
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    await user.type(screen.getByLabelText(/administrator pin/i), '2468');
    await user.click(screen.getByRole('button', { name: /unlock setup/i }));
    await user.type(await screen.findByLabelText(/setup card id/i), 'DEMO0002{enter}');
    expect(await screen.findByLabelText(/^user id/i)).toHaveValue('APG-DEMO-002');
    expect(screen.queryByText('Usual format: APG-YYYY-NNN')).not.toBeInTheDocument();
  });

  it('supports drag and drop photo upload in setup dialog', async () => {
    let capturedPhotoBody: unknown;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // Long auto-submit delay: on a slow CI runner a 30ms gap mid-typing
        // looked up "ABCD" early and sent "1234" into the User ID field. The
        // test submits the card with Enter, so auto-submit must not fire.
        // SAFETY: Fetch returns config Response mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 5_000, resultResetDelayMs: 500, enableCardSetup: true }) } as Response;
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
    const button = await screen.findByRole('button', { name: 'Reader ready' });
    expect(button).toHaveClass('is-ready');
    // The details stay folded away until the dot is clicked.
    expect(screen.queryByText(/Reader: Keyboard-mode RFID reader/)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Reader: Keyboard-mode RFID reader/)).toBeInTheDocument();
    expect(screen.getByText(/Keep the attendance window focused before scanning\./)).toBeInTheDocument();
    expect(screen.getByText(/Waiting for card/)).toBeInTheDocument();
    // No time is made up from when the page opened: without a scan today there is no time line.
    expect(screen.queryByText(/Last (activity|scan)/)).not.toBeInTheDocument();
  });

  it("shows the last scan from today's attendance in the details", async () => {
    vi.spyOn(tauriApi, 'getScannerStatus').mockResolvedValue({
      state: 'connected',
      message: 'Keyboard-mode RFID reader ready',
      detail: null,
      mode: 'keyboard',
      paused: false,
    });
    render(<ScannerDiagnostics lastScanAt="2026-10-30T16:52:00+08:00" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reader ready' }));
    expect(screen.getByText('Last scan: 4:52 PM')).toBeInTheDocument();
  });

  it('shows a grey Browser mode state instead of checking forever in a web browser', async () => {
    render(<ScannerDiagnostics />);
    // getScannerStatus rejects in the browser build (see beforeEach), so no status ever arrives.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const button = screen.getByRole('button', { name: 'Browser mode' });
    expect(button).toHaveClass('is-browser');
    expect(screen.queryByText(/checking/i)).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(screen.getByText('The card reader is checked only in the desktop app on the attendance PC.')).toBeInTheDocument();
  });

  it('follows the desktop reader: checking, missing, failing and ready', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    try {
      render(<ScannerDiagnostics />);
      expect(screen.getByRole('button', { name: 'Checking…' })).toHaveClass('is-checking');
      await waitFor(() => expect(scannerStatusHandlers.length).toBeGreaterThan(0));
      const status = (state: ScannerStatus['state']): ScannerStatus => ({ state, message: 'Reader update', detail: null, mode: 'keyboard', paused: false });
      act(() => emitScannerStatus(status('offline')));
      expect(screen.getByRole('button', { name: 'Reader missing' })).toHaveClass('is-missing');
      act(() => emitScannerStatus(status('error')));
      expect(screen.getByRole('button', { name: 'Reader error' })).toHaveClass('is-error');
      act(() => emitScannerStatus(status('connected')));
      expect(screen.getByRole('button', { name: 'Reader ready' })).toHaveClass('is-ready');
    } finally {
      Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
    }
  });

  it('toggles the details on click and closes them with Escape or a click outside', async () => {
    const user = userEvent.setup();
    render(<><ScannerDiagnostics /><p>Outside</p></>);
    const button = await screen.findByRole('button', { name: 'Browser mode' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(button).not.toHaveAttribute('aria-controls');

    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const details = screen.getByText('Opened in a web browser').parentElement;
    expect(button).toHaveAttribute('aria-controls', details?.id);
    await user.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Opened in a web browser')).not.toBeInTheDocument();

    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Opened in a web browser')).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await user.click(button);
    await user.click(screen.getByText('Outside'));
    expect(screen.queryByText('Opened in a web browser')).not.toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the details when keyboard focus moves away, and an Escape elsewhere leaves focus alone', async () => {
    const user = userEvent.setup();
    render(<><ScannerDiagnostics /><input aria-label="Elsewhere" /></>);
    const button = await screen.findByRole('button', { name: 'Browser mode' });
    await user.click(button);
    expect(screen.getByText('Opened in a web browser')).toBeInTheDocument();
    await user.tab();
    expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus();
    expect(screen.queryByText('Opened in a web browser')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('textbox', { name: 'Elsewhere' })).toHaveFocus();
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
  it('caps the corrections table and lets See all lift the cap', async () => {
    window.history.pushState({}, '', '/admin');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
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
      // SAFETY: Fetch fallback (users, payroll)
      return { ok: true, json: async () => ({ success: true, users: [], profiles: [], payroll: [] }) } as Response;
    });
    class FakeResizeObserver {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    // Pretend the rows need more height than the capped table shows.
    vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(1200);
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(560);

    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      const tableBox = (await screen.findByRole('checkbox', { name: 'Select all attendance records' })).closest('.table-wrap');
      expect(tableBox).toHaveClass('attendance-table-wrap');
      expect(tableBox).not.toHaveClass('is-expanded');

      await user.click(await screen.findByRole('button', { name: 'See all' }));
      expect(tableBox).toHaveClass('is-expanded');

      await user.click(screen.getByRole('button', { name: 'Show less' }));
      expect(tableBox).not.toHaveClass('is-expanded');
    } finally {
      vi.unstubAllGlobals();
      window.history.pushState({}, '', '/');
    }
  });

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

      // The row reads as plain times until Edit opens its time fields.
      expect(await screen.findByText('8:00 AM')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Edit times for Ada Lovelace' }));
      expect(screen.getByDisplayValue('08:00')).toBeInTheDocument();
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

  it('clamps a repeat late intern time-in to 09:00 AM while keeping the actual scan reachable and saved', async () => {
    vi.restoreAllMocks();
    let patchedBody: { timeIn?: string | null; expectedTimeIn?: string | null } | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users list mock
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
              { userId: 'u2', fullName: 'Charles Babbage', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
              { userId: 'u3', fullName: 'Grace Hopper', rfidUid: 'RFID-3', employeeType: 'INTERN', status: 'ACTIVE' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance/c2') && init?.method === 'PATCH') {
        // SAFETY: Parse the patched request body
        patchedBody = JSON.parse(String(init.body)) as { timeIn?: string | null; expectedTimeIn?: string | null };
        // SAFETY: Return the patched row
        return {
          ok: true,
          json: async () => ({
            success: true,
            attendance: { attendanceId: 'c2', attendanceDate: '2026-07-28', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-28T08:30:00+08:00', timeOut: null, status: 'WORKING' },
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Monday-week attendance: intern grace then repeat late, one late employee, one on-time intern
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-07-28',
            attendance: [
              { attendanceId: 'c1', attendanceDate: '2026-07-27', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-27T08:06:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'c2', attendanceDate: '2026-07-28', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-28T08:30:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'e1', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T09:00:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'g1', attendanceDate: '2026-07-28', userId: 'u3', fullName: 'Grace Hopper', department: 'Engineering', timeIn: '2026-07-28T07:55:00+08:00', timeOut: null, status: 'WORKING' },
            ],
          }),
        } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true, profiles: [], cutoffs: [] }) } as Response;
    });

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      // Only the intern's repeat late row is clamped; grace-first, employee, and on-time rows render as before.
      const chip = await screen.findByTestId('clamped-time-in');
      expect(chip).toHaveTextContent('9:00 AM');
      expect(chip.getAttribute('title')).toBe('Actual scan: 8:30 AM (payable time clamped)');
      expect(screen.getAllByTestId('clamped-time-in')).toHaveLength(1);

      // Capture the clamped row before the chip unmounts on reveal.
      const row = chip.closest('tr');
      expect(row).not.toBeNull();

      // Clicking the chip opens the row with the actual scan in its time field.
      await user.click(chip);
      expect(screen.queryByTestId('clamped-time-in')).not.toBeInTheDocument();
      expect(screen.getByDisplayValue('08:30')).toHaveFocus();

      // Save posts the actual time-in, never the displayed 09:00 clamp.
      // SAFETY: closest('tr') is checked non-null above
      await user.click(within(row as HTMLElement).getByRole('button', { name: /^save$/i }));
      await waitFor(() => expect(patchedBody).toMatchObject({
        timeIn: '2026-07-28T08:30:00+08:00',
        expectedTimeIn: '2026-07-28T08:30:00+08:00',
      }));
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('uses earlier week history to clamp an admin date-only 08:21 late arrival', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-30T10:00:00+08:00'));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch mock intern roster
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [{ userId: 'u-lazaro', fullName: 'Deign Grey O. Lazaro', rfidUid: 'RFID-LAZARO', employeeType: 'INTERN', status: 'ACTIVE' }],
          }),
        } as Response;
      }
      if (url.includes('/api/attendance?date=')) {
        // SAFETY: Earlier Monday grace-window scan returned by the week-history probe
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-09-28',
            fetchedAt: '2026-09-30T10:00:00+08:00',
            attendance: [{ attendanceId: 'lazaro-grace', attendanceDate: '2026-09-28', userId: 'u-lazaro', fullName: 'Deign Grey O. Lazaro', department: 'Operations', timeIn: '2026-09-28T08:10:00+08:00', timeOut: null, status: 'WORKING' }],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Admin endpoint contains only the selected date's rows
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-09-30',
            attendance: [{ attendanceId: 'lazaro-late', attendanceDate: '2026-09-30', userId: 'u-lazaro', fullName: 'Deign Grey O. Lazaro', department: 'Operations', timeIn: '2026-09-30T08:21:00+08:00', timeOut: null, status: 'WORKING' }],
          }),
        } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true, profiles: [], cutoffs: [] }) } as Response;
    });

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      const chip = await screen.findByTestId('clamped-time-in');
      expect(chip).toHaveTextContent('9:00 AM');
      expect(chip.getAttribute('title')).toBe('Actual scan: 8:21 AM (payable time clamped)');
      await user.click(chip);
      expect(screen.getByDisplayValue('08:21')).toHaveFocus();
    } finally {
      vi.useRealTimers();
      window.history.pushState({}, '', '/');
    }
  });

  it('exports the clamped 09:00 time-in with the actual scan preserved in a sibling audit column', async () => {
    vi.restoreAllMocks();
    const exportedBlobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        exportedBlobs.push(blob);
        return 'blob:attendance-export';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    const linkClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users list mock
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
              { userId: 'u2', fullName: 'Charles Babbage', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Fetch mock attendance: intern grace day then repeat-late day
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-07-28',
            attendance: [
              { attendanceId: 'c1', attendanceDate: '2026-07-27', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-27T08:06:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'c2', attendanceDate: '2026-07-28', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-28T08:30:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'e1', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T07:55:00+08:00', timeOut: null, status: 'WORKING' },
            ],
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
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));
      await user.click(await screen.findByRole('button', { name: /export csv/i }));

      await waitFor(() => expect(exportedBlobs.length).toBeGreaterThan(0));
      await screen.findByText(/Generated attendance-export.*\(3 rows\)/);
      const raw = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exportedBlobs[0]);
      });
      const content = raw.replace(/^\uFEFF/, '');
      const lines = content.split('\r\n').filter(Boolean);
      // Every cell is quoted, so split on the quoted separator for positional checks.
      const cells = (line: string) => line.replace(/^"|"$/g, '').split('","');
      // Pre-existing column indexes are stable; the audit column is appended last.
      expect(cells(lines[0])).toEqual([
        'Employee name',
        'Employee ID',
        'Department',
        'Date',
        'Time in',
        'Arrival',
        'Time out',
        'Status',
        'Total hours',
        'Source',
        'Recorded By',
        'Recorded Reason',
        'Recorded At',
        'Actual time-in',
      ]);
      const clampedLine = lines.find((line) => line.includes('Charles Babbage') && line.includes('2026-07-28'));
      const graceLine = lines.find((line) => line.includes('Charles Babbage') && line.includes('2026-07-27'));
      expect(clampedLine).toBeDefined();
      expect(graceLine).toBeDefined();
      // Repeat-late row: payable 09:00 stays in Time in (index 4), real scan moves to index 13.
      // SAFETY: clampedLine/graceLine checked defined by expect above
      expect(cells(clampedLine as string)[4]).toBe('2026-07-28T09:00:00+08:00');
      // SAFETY: clampedLine checked defined by expect above
      expect(cells(clampedLine as string)[13]).toBe('2026-07-28T08:30:00+08:00');
      // Grace-first row: both columns carry the actual time.
      // SAFETY: graceLine checked defined by expect above
      expect(cells(graceLine as string)[4]).toBe('2026-07-27T08:06:00+08:00');
      // SAFETY: graceLine checked defined by expect above
      expect(cells(graceLine as string)[13]).toBe('2026-07-27T08:06:00+08:00');
      expect(linkClick).toHaveBeenCalled();
    } finally {
      window.history.pushState({}, '', '/');
      linkClick.mockRestore();
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
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
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

      expect(await screen.findByText('2 users')).toBeInTheDocument();
      const masterCheckbox = screen.getByRole('checkbox', { name: /select all users/i });
      expect(masterCheckbox).not.toBeChecked();

      await user.click(masterCheckbox);
      expect(masterCheckbox).toBeChecked();
      const selectionBar = await screen.findByRole('group', { name: 'Selected users' });
      expect(within(selectionBar).getByText('2 selected')).toBeInTheDocument();

      await user.click(within(selectionBar).getByRole('button', { name: 'Delete' }));

      expect(screen.getByRole('dialog', { name: /delete selected users\?/i })).toBeInTheDocument();
      expect(screen.getByText('Are you sure you want to delete 2 selected user(s)? All associated records (attendance, bathroom logs, and payroll) will be permanently deleted. This cannot be undone.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Delete users' }));

      await waitFor(() => {
        expect(deletedUserIds).toContain('u1');
        expect(deletedUserIds).toContain('u2');
      });
    } finally {
      window.history.pushState({}, '', '/');
    }
  }, 15_000);

  it('shows a Voice slot per user with play and regenerate actions', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users list mock (Ada matches the bundled manifest)
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
              { userId: 'u2', fullName: 'Zed Nullman', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
            ],
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
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /users and rfid/i }));

      expect(await screen.findByText('2 users')).toBeInTheDocument();
      expect(screen.getByRole('columnheader', { name: 'Voice' })).toBeInTheDocument();
      // Ada has a bundled manifest clip: Bea badge + Play + Regenerate.
      const adaRow = (await screen.findByText('Ada Lovelace')).closest('tr');
      expect(adaRow).not.toBeNull();
      // SAFETY: closest('tr') is checked non-null on the line above
      expect(within(adaRow as HTMLElement).getByText('Bea')).toBeInTheDocument();
      // SAFETY: closest('tr') is checked non-null on the line above
      expect(within(adaRow as HTMLElement).getByRole('button', { name: 'Play' })).toBeInTheDocument();
      // Unknown name: Piper fallback still offers Regenerate.
      const zedRow = (await screen.findByText('Zed Nullman')).closest('tr');
      expect(zedRow).not.toBeNull();
      // SAFETY: closest('tr') is checked non-null on the line above
      expect(within(zedRow as HTMLElement).getByText('Piper')).toBeInTheDocument();
      // SAFETY: closest('tr') is checked non-null on the line above
      expect(within(zedRow as HTMLElement).getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('shows regeneration progress in the row until the new clip is ready', { timeout: 25000 }, async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch config mock
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users list mock (Zed has no clip: Piper fallback)
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u2', fullName: 'Zed Nullman', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
            ],
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
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    const adminExpiresAt = new Date(Date.now() + 900_000).toISOString();
    vi.spyOn(tauriApi.tauriApi, 'setupUnlock').mockResolvedValue({
      success: true,
      token: 'test-admin-token',
      expiresAt: adminExpiresAt,
    });
    vi.spyOn(tauriApi.tauriApi, 'adminGetSession').mockResolvedValue({
      success: true,
      token: 'test-admin-token',
      expiresAt: adminExpiresAt,
      role: 'admin',
    });
    vi.spyOn(tauriApi.tauriApi, 'adminUsers').mockResolvedValue({
      success: true,
      users: [
        { userId: 'u2', fullName: 'Zed Nullman', rfidUid: 'RFID-2', department: null, status: 'ACTIVE', employeeType: 'INTERN', gender: null, dailyRate: null, photoUrl: null },
      ],
    });
    vi.spyOn(tauriApi.tauriApi, 'adminAttendance').mockResolvedValue({ success: true, date: '2026-09-12', attendance: [], fetchedAt: new Date().toISOString() });
    vi.spyOn(tauriApi.tauriApi, 'payrollProfiles').mockResolvedValue({ success: true, profiles: [] });
    vi.spyOn(tauriApi.tauriApi, 'payrollCutoffs').mockResolvedValue({ success: true, payroll: [] });
    vi.spyOn(tauriApi.tauriApi, 'voiceWorkerStatus').mockResolvedValue({
      active: 0,
      retry: 0,
      lastPersonId: null,
      lastSpokenText: null,
      lastCompletedAt: null,
      lastError: null,
    });
    const clipStates: Array<Array<{ personId: string; workerClip: boolean; jobStatus: string | null }>> = [
      [],
      [{ personId: 'u2', workerClip: false, jobStatus: 'PENDING' }],
      [{ personId: 'u2', workerClip: false, jobStatus: 'PROCESSING' }],
      [{ personId: 'u2', workerClip: true, jobStatus: 'DONE' }],
    ];
    vi.spyOn(tauriApi.tauriApi, 'voiceClipStates').mockImplementation(async () => {
      const next = clipStates.shift();
      return next ?? [{ personId: 'u2', workerClip: true, jobStatus: 'DONE' }];
    });
    vi.spyOn(tauriApi.tauriApi, 'voiceRegenerate').mockResolvedValue('Zed Nullman');

    try {
      window.history.pushState({}, '', '/admin');
      // Seed the native admin token (Tauri mode keeps it in module state).
      await unlockAdmin('test-pin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /users and rfid/i }));

      const zedRow = (await screen.findByText('Zed Nullman')).closest('tr');
      expect(zedRow).not.toBeNull();
      // SAFETY: closest('tr') is checked non-null on the line above
      fireEvent.click(within(zedRow as HTMLElement).getByRole('button', { name: 'Regenerate' }));

      // Stage 1: queued loader with an indeterminate progress bar.
      expect(await screen.findByRole('progressbar', { name: /zed nullman/i })).toBeInTheDocument();
      expect(await screen.findByText('Queued…')).toBeInTheDocument();
      // Stage 2: worker picks the job up.
      expect(await screen.findByText('Cloning…', {}, { timeout: 8000 })).toBeInTheDocument();
      // Finish: ready message, loader gone, Bea chip live.
      expect(await screen.findByText(/voice clip ready/i, {}, { timeout: 12000 })).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
      const doneRow = (await screen.findByText('Zed Nullman')).closest('tr');
      expect(doneRow).not.toBeNull();
      // SAFETY: closest('tr') is checked non-null on the line above
      expect(within(doneRow as HTMLElement).getByText('Bea')).toBeInTheDocument();
    } finally {
      // SAFETY: Removing test mock property from window
      delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      window.history.pushState({}, '', '/');
    }
  });

  it('confirms single user deletion with permanent records deletion warning', async () => {
    vi.restoreAllMocks();
    let deletedId = '';
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
        deletedId = url.split('/').pop() ?? '';
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
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
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

      const deleteBtn = await screen.findByRole('button', { name: /^delete$/i });
      await user.click(deleteBtn);

      expect(screen.getByRole('dialog', { name: /delete user\?/i })).toBeInTheDocument();
      expect(screen.getByText('Are you sure you want to delete Ada Lovelace (u1)? All associated records (attendance, bathroom logs, and payroll) will be permanently deleted. This cannot be undone.')).toBeInTheDocument();

      // A permanent delete stays off until the User ID is typed; the field has focus so typing starts at once.
      const confirmDelete = screen.getByRole('button', { name: 'Delete user' });
      const typeId = screen.getByLabelText(/type u1 to confirm/i);
      expect(typeId).toHaveFocus();
      expect(confirmDelete).toBeDisabled();
      await user.type(typeId, 'u2');
      expect(confirmDelete).toBeDisabled();
      await user.clear(typeId);
      await user.type(typeId, 'U1');
      expect(confirmDelete).toBeEnabled();
      expect(deletedId).toBe('');

      await user.click(confirmDelete);
      await waitFor(() => {
        expect(deletedId).toBe('u1');
      });
      // The routine result is a toast.
      expect(await screen.findByText('Deleted Ada Lovelace.')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('supports ID photo upload, preview, and removal in UserEditor', async () => {
    let capturedPhotoBody: unknown;
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch mock users
        return { ok: true, json: async () => ({ success: true, users: [] }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Fetch mock attendance
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
      if (url.includes('/api/setup/photo')) {
        capturedPhotoBody = JSON.parse(String(init?.body));
        // SAFETY: Fetch returns photo upload mock
        return { ok: true, json: async () => ({ success: true, photoUrl: 'asset://localhost/photos/u1.webp' }) } as Response;
      }
      // SAFETY: Fallback response mock
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    const originalCreateImageBitmap = globalThis.createImageBitmap;
    const mockBitmap: Partial<ImageBitmap> = { width: 200, height: 200, close: vi.fn() };
    // SAFETY: Partial mock for ImageBitmap in node environment
    globalThis.createImageBitmap = vi.fn().mockResolvedValue(mockBitmap as ImageBitmap);

    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    const mockContext: Partial<CanvasRenderingContext2D> = { drawImage: vi.fn() };
    // SAFETY: Partial mock for 2D canvas context in node environment
    HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(mockContext as CanvasRenderingContext2D);
    const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = vi.fn().mockReturnValue('data:image/jpeg;base64,mockadmindata');

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /users and rfid/i }));
      // The registration form opens on demand.
      await user.click(screen.getByRole('button', { name: /^add user$/i }));

      const dropzone = screen.getByText(/choose an id photo/i).closest('label');
      expect(dropzone).not.toBeNull();

      // Attempt photo upload before typing userId
      const file = new File(['mock content'], 'admin-avatar.png', { type: 'image/png' });
      fireEvent.drop(dropzone!, {
        dataTransfer: { files: [file] },
      });
      expect(await screen.findByText('Enter the User ID before uploading a photo.')).toBeInTheDocument();

      // Now enter User ID
      await user.type(screen.getByLabelText(/^user id/i), 'EMP-999');

      // Drop photo again
      fireEvent.drop(dropzone!, {
        dataTransfer: { files: [file] },
      });

      expect(await screen.findByText('Photo uploaded.')).toBeInTheDocument();
      expect(capturedPhotoBody).toEqual({
        userId: 'EMP-999',
        dataUrl: 'data:image/jpeg;base64,mockadmindata',
      });

      // Preview should show Change photo and Remove photo buttons
      expect(screen.getByRole('button', { name: /remove photo/i })).toBeInTheDocument();
      expect(screen.getByText(/change photo/i)).toBeInTheDocument();

      // Click remove photo
      await user.click(screen.getByRole('button', { name: /remove photo/i }));
      expect(screen.getByText(/choose an id photo/i)).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
      globalThis.createImageBitmap = originalCreateImageBitmap;
      HTMLCanvasElement.prototype.getContext = originalGetContext;
      HTMLCanvasElement.prototype.toDataURL = originalToDataURL;
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

      expect(await screen.findByText('2 records')).toBeInTheDocument();
      const masterCheckbox = screen.getByRole('checkbox', { name: /select all attendance records/i });
      expect(masterCheckbox).not.toBeChecked();

      await user.click(masterCheckbox);
      expect(masterCheckbox).toBeChecked();
      expect(await screen.findByText('2 selected')).toBeInTheDocument();

      const batchDeleteBtn = screen.getByRole('button', { name: 'Delete selected' });
      await user.click(batchDeleteBtn);

      expect(screen.getByRole('dialog', { name: /delete selected attendance records\?/i })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Delete records' }));

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
                employeeType: 'INTERN',
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

    // The notes' wording, their full text in the tooltip, and no inline style.
    const assistedNote = await screen.findByText(/assisted by duty manager/i);
    expect(assistedNote).toHaveTextContent('Assisted by Duty Manager');
    expect(assistedNote).toHaveAttribute('title', 'Kiosk scan assisted by: Duty Manager (Forgot RFID card)');
    expect(assistedNote).not.toHaveAttribute('style');
    const backdatedNote = screen.getByText(/backdated by admin — physical attendance verified/i);
    expect(backdatedNote).toHaveTextContent('Backdated by Admin — Physical attendance verified');
    expect(backdatedNote).toHaveAttribute('title', 'Backdated manual entry by: Admin — Reason: Physical attendance verified');
    expect(backdatedNote).not.toHaveAttribute('style');

    // Filter pills should show counts
    const assistedPill = screen.getByRole('button', { name: /assisted 1/i });
    const backdatedPill = screen.getByRole('button', { name: /backdated 1/i });
    expect(assistedPill).toBeInTheDocument();
    expect(backdatedPill).toBeInTheDocument();

    // Status filters are one choice at a time; choosing the current one again goes back to All.
    const allStatuses = screen.getByRole('button', { name: /^all \d+$/i });
    const working = screen.getByRole('button', { name: /^working \d+$/i });
    expect(allStatuses).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(working);
    expect(working).toHaveAttribute('aria-pressed', 'true');
    expect(allStatuses).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(working);
    expect(allStatuses).toHaveAttribute('aria-pressed', 'true');
    // Assisted and Backdated switch on and off on their own.
    fireEvent.click(assistedPill);
    expect(assistedPill).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(assistedPill);
    expect(assistedPill).toHaveAttribute('aria-pressed', 'false');

    // Add missed attendance (an outline button in the table bar)
    const addMissedButton = screen.getByRole('button', { name: /^add missed attendance$/i });
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

  it('creates a correction for 2026-09-01 while today is 2026-09-02 and shows its row under Tue, Sep 1, 2026', async () => {
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
      await user.click(screen.getByRole('button', { name: /^add missed attendance$/i }));

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

      // The table moves to 2026-09-01 (shown once above it) and lists the new row
      expect(await screen.findByText('Tue, Sep 1, 2026')).toBeInTheDocument();
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
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
      expect(screen.getByText('Wed, Sep 2, 2026')).toBeInTheDocument();

      // Change specific date to 2026-09-01
      const dateInput = screen.getByLabelText(/filter attendance date/i);
      fireEvent.change(dateInput, { target: { value: '2026-09-01' } });

      // After changing date to 2026-09-01, Charles Babbage is shown
      expect(await screen.findByText('Charles Babbage')).toBeInTheDocument();
      expect(screen.getByText('Tue, Sep 1, 2026')).toBeInTheDocument();

      // Other dates are not shown
      expect(screen.queryByText('Grace Hopper')).not.toBeInTheDocument();
      expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
      expect(screen.queryByText('Sun, Aug 30, 2026')).not.toBeInTheDocument();
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
      fireEvent.change(screen.getByLabelText(/filter attendance date/i), { target: { value: '2026-09-01' } });

      // The table shows 2026-09-01 once, above Ada's row
      expect(await screen.findByText('Tue, Sep 1, 2026')).toBeInTheDocument();
      expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();

      // Edit time-out
      await user.click(screen.getByRole('button', { name: 'Edit times for Ada Lovelace' }));
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

      // The row closes again and the table still shows 2026-09-01
      await waitFor(() => expect(screen.queryByLabelText(/^time out for ada lovelace$/i)).not.toBeInTheDocument());
      expect(screen.getByText('Tue, Sep 1, 2026')).toBeInTheDocument();
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

    // Unlocks Admin panel directly, opening on Attendance corrections
    expect(capturedAdminUnlockBody).toEqual({ pin: 'ADDE23' });
    expect(await screen.findByRole('button', { name: /users and rfid/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /attendance corrections/i })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText(/^\d+ records?$/)).toBeInTheDocument();
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

  it('shows the brand block and page buttons on the page, with the tabs and mode switch as two bars below', async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/bathroom/status')) {
        // SAFETY: Mock bathroom status
        return { ok: true, json: async () => ({ success: true, date: '2026-08-27', maleActive: null, femaleActive: null, maleLogs: [], femaleLogs: [], fetchedAt: '2026-08-27T10:00:00Z' }) } as Response;
      }
      // SAFETY: Fallback mock response (config, users, attendance, payroll)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', users: [], attendance: [], profiles: [], payroll: [] }) } as Response;
    });
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByRole('button', { name: /users and rfid/i });

      // Header on the page: the brand block (with the visible title) on the left, reader status and page buttons on the right.
      const heading = screen.getByRole('heading', { level: 1, name: 'Manage attendance' });
      expect(heading).toBeVisible();
      const header = heading.closest('header');
      expect(header).not.toBeNull();
      const inHeader = within(header!);
      expect(inHeader.getByText('ALPHA PREMIER REALTY')).toBeInTheDocument();
      expect(inHeader.getByText('Administrator access')).toBeInTheDocument();
      expect(inHeader.getByRole('button', { name: 'Browser mode' })).toBeInTheDocument();
      expect(inHeader.getByRole('link', { name: 'Scanner' })).toHaveAttribute('href', '/');
      expect(inHeader.getByRole('link', { name: 'Live view' })).toHaveAttribute('href', '/attendance');
      expect(inHeader.getByRole('button', { name: 'Lock' })).toBeInTheDocument();

      // Below the header, one row with two separate bars: the six section tabs, then the mode switch.
      // Attendance corrections comes first and is where the admin page opens; System comes last.
      const tabNames = ['Attendance corrections', 'Users and RFID', 'Payroll', 'Data and backup', 'Voice announcements', 'System'];
      const tabs = screen.getByRole('button', { name: 'Payroll' }).parentElement;
      expect(within(tabs!).getAllByRole('button').map((tab) => tab.textContent)).toEqual(tabNames);
      expect(within(tabs!).getByRole('button', { name: 'Attendance corrections' })).toHaveAttribute('aria-current', 'page');
      expect(within(tabs!).getByRole('button', { name: 'Users and RFID' })).not.toHaveAttribute('aria-current');
      const switcher = screen.getByRole('tablist', { name: 'Administrator mode switcher' });
      expect(header).not.toContainElement(tabs);
      expect(header).not.toContainElement(switcher);
      expect(tabs).not.toContainElement(switcher);
      expect(switcher.parentElement).toBe(tabs?.parentElement);
      expect(switcher.previousElementSibling).toBe(tabs);

      // Bathroom mode hides the tabs bar; the switch stays in its row.
      await user.click(within(switcher).getByRole('tab', { name: /^bathroom key log$/i }));
      expect(await screen.findByRole('heading', { name: /bathroom key log/i })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Users and RFID' })).not.toBeInTheDocument();
      expect(screen.getByRole('tablist', { name: 'Administrator mode switcher' })).toBe(switcher);
    } finally {
      window.history.pushState({}, '', '/');
    }
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

  it('clears the reader box when a bathroom result goes back to ready', async () => {
    window.history.pushState({}, '', '/');
    const user = userEvent.setup();
    const checkout: BathroomScanResponse = {
      success: true,
      action: 'CHECKOUT',
      genderKey: 'FEMALE',
      user: { userId: 'EMP-02', fullName: 'Jane Smith', department: 'Finance', photoUrl: null, gender: 'FEMALE' },
      timeOut: '2026-08-28T10:00:00+08:00',
      message: 'Female floor key checked out',
      timestamp: '2026-08-28T10:00:00+08:00',
    };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch returns config with a short reset delay
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 300 }) } as Response;
      }
      if (url.includes('/bathroom/scan')) {
        // SAFETY: Mock bathroom scan response
        return { ok: true, json: async () => checkout } as Response;
      }
      // SAFETY: Bathroom status and other requests get an empty day
      return { ok: true, json: async () => ({ success: true, date: '2026-08-28', maleActive: null, femaleActive: null, maleLogs: [], femaleLogs: [], fetchedAt: '2026-08-28T10:00:00Z' }) } as Response;
    });
    render(<App />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    await user.click(screen.getByTestId('kiosk-mode-bathroom'));
    act(() => emitRfidScan('FEMALE-CARD-01'));
    expect(await screen.findByText('Jane Smith')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText(/scanner card id/i)).toHaveValue(''), { timeout: 1_500 });
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

  it('does not switch kiosk mode when typing 2 in Associate RFID #admin-pin', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Mock config with card setup enabled so Admin setup button renders
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableCardSetup: true }) } as Response;
      }
      // SAFETY: Fallback mock response
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });

    window.history.pushState({}, '', '/');
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const user = userEvent.setup();
    render(<App />);

    // Open SetupDialog on the kiosk route
    await user.click(await screen.findByRole('button', { name: /admin setup/i }));
    expect(await screen.findByRole('dialog', { name: /associate rfid card/i })).toBeInTheDocument();

    // Focus #admin-pin and type 2: must NOT arm the kiosk mode-switch timer
    // SAFETY: #admin-pin is rendered by the open SetupDialog above
    const pinInput = document.getElementById('admin-pin') as HTMLInputElement;
    pinInput.focus();
    fireEvent.keyDown(pinInput, { key: '2' });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(screen.getByTestId('kiosk-mode-attendance')).toHaveClass('active');
    expect(screen.queryByTestId('bathroom-kiosk-view')).not.toBeInTheDocument();

    // Close dialog: pressing 2 on window DOES switch to bathroom kiosk
    await user.click(screen.getByRole('button', { name: /close card setup/i }));
    fireEvent.keyDown(window, { key: '2' });
    expect(await screen.findByTestId('bathroom-kiosk-view')).toBeInTheDocument();
  });
});

describe('N6 LiveAttendance ordering', () => {
  it('keeps the newest snapshot when overlapping loads resolve out of order', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      const resolvers: Array<(value: Response) => void> = [];
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/api/config') {
          // SAFETY: Fetch returns config Response mock
          return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
        }
        if (url === '/api/attendance') {
          return new Promise<Response>((resolve) => { resolvers.push(resolve); });
        }
        // SAFETY: Fetch returns fallback success Response mock
        return { ok: true, json: async () => ({ success: true }) } as Response;
      });
      const row = (name: string, id: string) => ({
        attendanceId: id,
        attendanceDate: '2026-07-28',
        userId: id,
        fullName: name,
        department: 'Engineering',
        timeIn: '2026-07-28T08:00:00+08:00',
        timeOut: null,
        status: 'WORKING',
      });
      render(<App />);
      // Initial render reads the loading state, not an empty day.
      expect(screen.getByText('Loading live attendance…')).toBeInTheDocument();
      expect(screen.queryByText('No attendance has been recorded today.')).not.toBeInTheDocument();
      await waitFor(() => expect(resolvers.length).toBe(1));
      // Second overlapping refresh (window focus) starts before the first settles.
      act(() => { window.dispatchEvent(new Event('focus')); });
      await waitFor(() => expect(resolvers.length).toBe(2));
      // Newest resolves first, older resolves second and must be dropped.
      await act(async () => {
        // SAFETY: Resolve pending attendance fetch with the newer snapshot
        resolvers[1]({ ok: true, json: async () => ({ success: true, date: '2026-07-28', fetchedAt: '2026-07-28T10:00:02+08:00', attendance: [row('New Person', 'n1')] }) } as Response);
      });
      expect(await screen.findByText('New Person')).toBeInTheDocument();
      await act(async () => {
        // SAFETY: Resolve pending attendance fetch with the older snapshot
        resolvers[0]({ ok: true, json: async () => ({ success: true, date: '2026-07-28', fetchedAt: '2026-07-28T10:00:00+08:00', attendance: [row('Old Person', 'o1')] }) } as Response);
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(screen.getByText('New Person')).toBeInTheDocument();
      expect(screen.queryByText('Old Person')).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Live attendance revamp', () => {
  function mockLiveFetch() {
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
              // An admin correction that clears the time in leaves a MISSED row with an empty timeIn.
              { attendanceId: 'a3', attendanceDate: '2026-07-28', userId: 'u3', fullName: 'Alan Turing', department: 'Engineering', timeIn: '', timeOut: null, status: 'MISSED' },
            ],
          }),
        } as Response;
      }
      // SAFETY: Fetch returns fallback success Response mock
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });
  }

  it('header links read as buttons with icons', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      mockLiveFetch();
      render(<App />);
      const scanner = await screen.findByRole('link', { name: 'Scanner' });
      const admin = screen.getByRole('link', { name: 'Admin' });
      expect(scanner).toHaveAttribute('href', '/');
      expect(admin).toHaveAttribute('href', '/admin');
      expect(scanner.querySelector('svg')).not.toBeNull();
      expect(admin.querySelector('svg')).not.toBeNull();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('LAN viewer is collapsed by default but still auto-starts', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      mockLiveFetch();
      const startLan = vi.spyOn(api, 'startLanViewer');
      render(<App />);
      const toggle = await screen.findByRole('button', { name: /lan viewer/i });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByRole('region', { name: 'LAN viewer' })).not.toBeInTheDocument();
      expect(startLan).toHaveBeenCalled();
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('region', { name: 'LAN viewer' })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('shows at-a-glance counts from the loaded rows', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      mockLiveFetch();
      render(<App />);
      expect(screen.queryByRole('list', { name: 'Today at a glance' })).not.toBeInTheDocument();
      const counts = await screen.findByRole('list', { name: 'Today at a glance' });
      expect(within(counts).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['0 in office', '2 timed out', '2 timed in', '1 late time-out']);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('filters the rows on screen by name, ID and department while the counts keep the whole day', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url === '/api/attendance') {
          // SAFETY: Fetch returns attendance Response mock
          return {
            ok: true,
            json: async () => ({
              success: true,
              date: '2026-07-28',
              fetchedAt: '2026-07-28T10:00:00+08:00',
              attendance: [
                { attendanceId: 'f1', attendanceDate: '2026-07-28', userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', department: 'Sales', timeIn: '2026-07-28T08:00:00+08:00', timeOut: null, status: 'WORKING' },
                { attendanceId: 'f2', attendanceDate: '2026-07-28', userId: 'APG-2026-002', fullName: 'Maria Santos', department: 'Engineering', timeIn: '2026-07-28T08:10:00+08:00', timeOut: null, status: 'WORKING' },
                { attendanceId: 'f3', attendanceDate: '2026-07-28', userId: 'APG-2026-003', fullName: 'Jose Rizal', department: 'Engineering', timeIn: '2026-07-28T08:20:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
              ],
            }),
          } as Response;
        }
        // SAFETY: Fetch returns fallback success Response mock (config, roster, LAN)
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila' }) } as Response;
      });
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText('Juan Dela Cruz');
      const counts = screen.getByRole('list', { name: 'Today at a glance' });
      const countText = () => within(counts).getAllByRole('listitem').map((item) => item.textContent);
      expect(countText()).toEqual(['2 in office', '1 timed out', '3 timed in']);

      const department = screen.getByRole('combobox', { name: 'Department' });
      expect(within(department).getAllByRole('option').map((option) => option.textContent)).toEqual(['All departments', 'Engineering', 'Sales']);

      const search = screen.getByRole('searchbox', { name: 'Search name or ID' });
      await user.type(search, 'dela');
      expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
      expect(screen.queryByText('Maria Santos')).not.toBeInTheDocument();
      expect(screen.queryByText('Jose Rizal')).not.toBeInTheDocument();
      // The IDs stay beside the names and are searchable too.
      await user.clear(search);
      await user.type(search, '2026-002');
      expect(screen.getByText('Maria Santos')).toBeInTheDocument();
      expect(screen.getByText('APG-2026-002')).toBeInTheDocument();
      expect(screen.queryByText('Juan Dela Cruz')).not.toBeInTheDocument();

      await user.clear(search);
      await user.selectOptions(department, 'Engineering');
      expect(screen.getByText('Maria Santos')).toBeInTheDocument();
      expect(screen.getByText('Jose Rizal')).toBeInTheDocument();
      expect(screen.queryByText('Juan Dela Cruz')).not.toBeInTheDocument();

      // Nothing matches: a plain message and a way back; the counts never change.
      await user.type(search, 'Juan');
      expect(screen.getByText('No one matches')).toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
      expect(countText()).toEqual(['2 in office', '1 timed out', '3 timed in']);
      const attendanceCalls = fetchSpy.mock.calls.filter(([input]) => String(input) === '/api/attendance').length;
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(search).toHaveValue('');
      expect(department).toHaveValue('');
      // The Clear filters button goes away with the message, so focus returns to the search box.
      expect(search).toHaveFocus();
      ['Juan Dela Cruz', 'Maria Santos', 'Jose Rizal'].forEach((name) => expect(screen.getByText(name)).toBeInTheDocument());
      // Filtering works on the loaded rows only.
      expect(fetchSpy.mock.calls.filter(([input]) => String(input) === '/api/attendance').length).toBe(attendanceCalls);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('N7 concurrent voice regen ownership', () => {
  it('resolving A first after starting B keeps B loader and writes no A message', async () => {
    window.history.pushState({}, '', '/admin');
    try {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/api/config')) {
          // SAFETY: Fetch config mock
          return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500, enableAdmin: true }) } as Response;
        }
        if (url.includes('/api/admin/session')) {
          // SAFETY: Fetch mock admin session active
          return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
        }
        if (url.includes('/api/admin/users')) {
          // SAFETY: Fetch users list mock with two regen targets
          return {
            ok: true,
            json: async () => ({
              success: true,
              users: [
                { userId: 'uA', fullName: 'Ada Alpha', rfidUid: 'RFID-A', employeeType: 'INTERN', status: 'ACTIVE' },
                { userId: 'uB', fullName: 'Zed Beta', rfidUid: 'RFID-B', employeeType: 'INTERN', status: 'ACTIVE' },
              ],
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
      vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
      let resolveRegenA: (value: Awaited<ReturnType<typeof api.regenerateVoiceClip>>) => void = () => {};
      let resolveRegenB: (value: Awaited<ReturnType<typeof api.regenerateVoiceClip>>) => void = () => {};
      let resolvePollA: (value: Awaited<ReturnType<typeof api.pollVoiceClipReady>>) => void = () => {};
      let resolvePollB: (value: Awaited<ReturnType<typeof api.pollVoiceClipReady>>) => void = () => {};
      const regenA = new Promise<Awaited<ReturnType<typeof api.regenerateVoiceClip>>>((resolve) => { resolveRegenA = resolve; });
      const regenB = new Promise<Awaited<ReturnType<typeof api.regenerateVoiceClip>>>((resolve) => { resolveRegenB = resolve; });
      const pollA = new Promise<Awaited<ReturnType<typeof api.pollVoiceClipReady>>>((resolve) => { resolvePollA = resolve; });
      const pollB = new Promise<Awaited<ReturnType<typeof api.pollVoiceClipReady>>>((resolve) => { resolvePollB = resolve; });
      vi.spyOn(api, 'regenerateVoiceClip').mockImplementation((personId: string) => (personId === 'uA' ? regenA : regenB));
      vi.spyOn(api, 'pollVoiceClipReady').mockImplementation((personId: string) => (personId === 'uA' ? pollA : pollB));
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: /users and rfid/i }));
      await screen.findByText('Ada Alpha');
      await screen.findByText('Zed Beta');
      const adaRow = (await screen.findByText('Ada Alpha')).closest('tr');
      const zedRow = (await screen.findByText('Zed Beta')).closest('tr');
      expect(adaRow).not.toBeNull();
      expect(zedRow).not.toBeNull();
      // SAFETY: closest('tr') is checked non-null on the lines above
      fireEvent.click(within(adaRow as HTMLElement).getByRole('button', { name: 'Regenerate' }));
      expect(await screen.findByRole('progressbar', { name: /ada alpha/i })).toBeInTheDocument();
      // SAFETY: closest('tr') is checked non-null on the lines above
      fireEvent.click(within(zedRow as HTMLElement).getByRole('button', { name: 'Regenerate' }));
      expect(await screen.findByRole('progressbar', { name: /zed beta/i })).toBeInTheDocument();
      // A finishes first but no longer owns the slot: it must write nothing.
      await act(async () => { resolveRegenA({ ok: true, spokenText: 'Ada Alpha' }); });
      await act(async () => { resolvePollA('ready'); });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
      expect(screen.getByRole('progressbar', { name: /zed beta/i })).toBeInTheDocument();
      expect(screen.queryByText(/voice clip ready/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/voice clip queued/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/Ada Alpha.*plays automatically/i)).not.toBeInTheDocument();
      // B still owns the slot: its own completion lands the message.
      await act(async () => { resolveRegenB({ ok: true, spokenText: 'Zed Beta' }); });
      await act(async () => { resolvePollB('ready'); });
      expect(await screen.findByText(/voice clip ready \(zed beta\)/i)).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Weekly-grace clamp display extension', () => {
  const clampWeekRows = [
    // Intern grace-first late row (Mon) — never clamped.
    { attendanceId: 'i1', attendanceDate: '2026-07-27', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-27T08:06:00+08:00', timeOut: '2026-07-27T17:00:00+08:00', status: 'COMPLETED' },
    // Same intern repeat-late row (Tue) — clamped to 09:00 AM.
    { attendanceId: 'i2', attendanceDate: '2026-07-28', userId: 'u2', fullName: 'Charles Babbage', department: 'Math', timeIn: '2026-07-28T08:30:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED' },
    // Employee with the same late pattern — employees are never clamped.
    { attendanceId: 'e2', attendanceDate: '2026-07-28', userId: 'u1', fullName: 'Ada Lovelace', department: 'Engineering', timeIn: '2026-07-28T09:01:00+08:00', timeOut: null, status: 'WORKING' },
  ];
  // Realistic single-day snapshot: only today's rows, so the intern's row is
  // his week's first late arrival in this file and clamps only once earlier
  // week history is grouped in.
  const todayOnlyRows = clampWeekRows.filter((row) => row.attendanceDate === '2026-07-28');
  const mondayGraceRow = clampWeekRows.filter((row) => row.attendanceId === 'i1');

  const mockLiveFetch = (options: {
    todayRows?: typeof clampWeekRows;
    historyRows?: typeof clampWeekRows;
    failHistory?: boolean;
  } = {}) => {
    const { todayRows = clampWeekRows, historyRows = clampWeekRows, failHistory = false } = options;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users roster mock (one intern, one employee)
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
              { userId: 'u2', fullName: 'Charles Babbage', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/attendance?date=')) {
        // Week-history probe for the clamp grouping; failure must degrade silently.
        if (failHistory) throw new Error('attendance history unavailable');
        // SAFETY: Fetch mock dated attendance history
        return {
          ok: true,
          json: async () => ({ success: true, date: 'history', fetchedAt: '2026-07-28T10:00:00+08:00', attendance: historyRows }),
        } as Response;
      }
      if (url.includes('/api/attendance')) {
        // SAFETY: Fetch mock live attendance snapshot (today only)
        return {
          ok: true,
          json: async () => ({ success: true, date: '2026-07-28', fetchedAt: '2026-07-28T10:00:00+08:00', attendance: todayRows }),
        } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true }) } as Response;
    });
  };

  it('shows the 09:00 AM clamp chip with the actual scan in the tooltip on the Live Attendance table', async () => {
    window.history.pushState({}, '', '/attendance');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-28T10:00:00+08:00'));
    try {
      vi.restoreAllMocks();
      // Live snapshot carries only today's rows; Monday's grace row arrives
      // through the best-effort week-history fetch.
      mockLiveFetch({ todayRows: todayOnlyRows, historyRows: mondayGraceRow });
      render(<App />);
      const chip = await screen.findByTestId('clamped-time-in');
      expect(chip).toHaveTextContent('9:00 AM');
      expect(chip.getAttribute('title')).toBe('Actual scan: 8:30 AM (payable time clamped)');
      expect(screen.getAllByTestId('clamped-time-in')).toHaveLength(1);
      // The employee row keeps its actual time.
      expect(screen.getByText('9:01 AM')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      window.history.pushState({}, '', '/');
    }
  });

  it('degrades to actual-only times on the live table when the week-history fetch fails', async () => {
    window.history.pushState({}, '', '/attendance');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-28T10:00:00+08:00'));
    try {
      vi.restoreAllMocks();
      mockLiveFetch({ todayRows: todayOnlyRows, failHistory: true });
      render(<App />);
      // Late rows clamp even when the best-effort history request fails.
      expect(await screen.findByTestId('clamped-time-in')).toHaveTextContent('9:00 AM');
      expect(screen.getByText('9:01 AM')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
      window.history.pushState({}, '', '/');
    }
  });

  it('falls back to actual times on the live table when no roster is reachable', async () => {
    window.history.pushState({}, '', '/attendance');
    try {
      vi.restoreAllMocks();
      mockLiveFetch();
      vi.spyOn(api, 'loadAdminUsers').mockRejectedValue(new Error('admin session required'));
      render(<App />);
      expect(await screen.findByText('8:30 AM')).toBeInTheDocument();
      expect(screen.queryByTestId('clamped-time-in')).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('shows the clamped 09:00 AM payable time with the actual scan in the tooltip in payroll deduction details', async () => {
    try {
      vi.restoreAllMocks();
      vi.spyOn(api, 'loadPayrollPdfs').mockResolvedValue({ success: true, payrollPdfs: [] });
      const breakdown = {
        deductions: [
          { date: '2026-08-03', category: 'LATE', label: 'Late', details: 'Late arrival at 8:06 AM (Weekly grace applied — PHP 0.00 deduction)', timeIn: '8:06 AM', timeOut: '5:00 PM', workedHours: null, hoursShort: null, lateHours: 0, amount: 0 },
          { date: '2026-08-04', category: 'LATE', label: 'Late', details: 'Late arrival at 8:30 AM (1 hr(s) late)', timeIn: '8:30 AM', timeOut: '5:00 PM', workedHours: null, hoursShort: null, lateHours: 1, amount: 10 },
        ],
      };
      const internRecord: PayrollCutoffRecord = {
        payrollId: 'P-INT-CLAMP', employeeId: 'INT-CLAMP', employeeName: 'Charles Babbage', employeeType: 'INTERN',
        payrollProfileId: 'INTERN_STANDARD', payrollCutoffLabel: 'August 1-15, 2026', cutoffStart: '2026-08-01', cutoffEnd: '2026-08-15',
        payrollFrequency: 'SEMI_MONTHLY', dailyRate: 80, standardWorkingDays: 10, actualWorkingDays: 10, basicPay: 800,
        specialHolidayDays: 0, specialHolidayMultiplier: 0, specialHolidayPay: 0, regularHolidayDays: 0, regularHolidayMultiplier: 0, regularHolidayPay: 0,
        incentivesAllowance: 0, specialAllowance: 0, totalCompensation: 800, totalAllowance: 0, lateUnits: 1, lateDeduction: 10,
        halfDayCount: 0, halfDayDeduction: 0, absentDays: 0, absenceDeduction: 0, overtimeHours: 0, overtimeRate: 0, overtimePay: 0,
        manualAdjustment: 0, adjustmentReason: null, grossCompensation: 800, netPay: 790,
        calculationBreakdown: JSON.stringify(breakdown), approvedWorkingDayOverage: false, status: 'DRAFT', finalizedAt: null,
      };
      render(<PayrollWorkspace records={[internRecord]} onSaved={vi.fn()} />);
      // The record's Aug 1–15 cutoff isn't the pre-filled one, so show every cutoff's records.
      fireEvent.click(screen.getByRole('button', { name: 'All cutoffs' }));
      fireEvent.click(screen.getByRole('button', { name: 'Breakdown' }));
      const chip = await screen.findByTestId('clamped-payroll-time-in');
      expect(chip).toHaveTextContent('9:00 AM');
      expect(chip.getAttribute('title')).toBe('Actual scan: 8:30 AM (payable time clamped)');
      // Only the deducted late day clamps; the grace-applied day keeps its actual time.
      expect(screen.getAllByTestId('clamped-payroll-time-in')).toHaveLength(1);
      expect(screen.getByText('8:06 AM – 5:00 PM')).toBeInTheDocument();
      // SAFETY: the single clamped chip is located above
      const clampedCell = (screen.getByTestId('clamped-payroll-time-in') as HTMLElement).closest('td');
      expect(clampedCell?.textContent).toBe('9:00 AM – 5:00 PM');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('hourly late clamp', () => {
  const v3Users = [
    { userId: 'u1', fullName: 'Ada Lovelace', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE' },
    { userId: 'u2', fullName: 'Charles Babbage', rfidUid: 'RFID-2', employeeType: 'INTERN', status: 'ACTIVE' },
    { userId: 'u3', fullName: 'Grace Hopper', rfidUid: 'RFID-3', employeeType: 'INTERN', status: 'ACTIVE' },
  ];

  type V3FixtureRow = {
    attendanceId: string;
    attendanceDate: string;
    userId: string;
    fullName: string;
    department: string;
    timeIn: string;
    timeOut: null;
    status: string;
  };

  const mockAdminFetch = (attendance: V3FixtureRow[]) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/config')) {
        // SAFETY: Fetch mock config
        return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', enableAdmin: true }) } as Response;
      }
      if (url.includes('/api/admin/session')) {
        // SAFETY: Fetch mock admin session active
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Fetch users list mock
        return { ok: true, json: async () => ({ success: true, users: v3Users }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Fetch mock attendance for the requested week
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance }) } as Response;
      }
      // SAFETY: Fetch fallback
      return { ok: true, json: async () => ({ success: true, profiles: [], cutoffs: [] }) } as Response;
    });
  };

  const row = (
    attendanceId: string,
    attendanceDate: string,
    timeIn: string,
  ) => ({
    attendanceId,
    attendanceDate,
    userId: 'u2',
    fullName: 'Charles Babbage',
    department: 'Math',
    timeIn: `${attendanceDate}T${timeIn}+08:00`,
    timeOut: null,
    status: 'WORKING',
  });

  it('uses a strict hourly :15 boundary for intern attendance and weekly grace', async () => {
    vi.restoreAllMocks();
    mockAdminFetch([
      row('hour-grace-exact', '2026-07-27', '08:15:00.000000000'),
      row('hour-0916', '2026-07-27', '09:16:00'),
      row('hour-0903', '2026-07-28', '09:03:00'),
      row('hour-1016', '2026-07-29', '10:16:00'),
      row('hour-091500', '2026-07-30', '09:15:00'),
      row('hour-0915001', '2026-07-31', '09:15:00.001'),
      { ...row('hour-grace-sub-ms', '2026-07-27', '08:15:00.000000001'), userId: 'u3', fullName: 'Grace Hopper' },
      { ...row('hour-grace-after-boundary', '2026-07-28', '08:10:00'), userId: 'u3', fullName: 'Grace Hopper' },
      row('hour-091500000001', '2026-08-03', '09:15:00.000000001'),
      { ...row('hour-employee', '2026-07-27', '09:16:00'), userId: 'u1', fullName: 'Ada Lovelace' },
    ]);

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      const chips = await screen.findAllByTestId('clamped-time-in');
      expect(chips).toHaveLength(6);
      expect(chips.filter((chip) => chip.textContent === '10:00 AM')).toHaveLength(4);
      expect(chips.filter((chip) => chip.textContent === '11:00 AM')).toHaveLength(1);
      // Each chip keeps the actual scan in its tooltip; rows that are not clamped show the actual time.
      const actualScan = (time: string) => `Actual scan: ${time} (payable time clamped)`;
      const chipsFor = (time: string) => chips.filter((chip) => chip.getAttribute('title') === actualScan(time));
      expect(chipsFor('9:16 AM')).toHaveLength(2);
      expect(chipsFor('10:16 AM')).toHaveLength(1);
      // 09:15:00.001 and the next week's 09:15 plus a nanosecond are both past :15.
      expect(chipsFor('9:15 AM').map((chip) => chip.textContent)).toEqual(['10:00 AM', '10:00 AM']);
      expect(screen.getByText('9:03 AM')).toBeInTheDocument();
      expect(screen.getByText('9:15 AM')).toBeInTheDocument();
      expect(screen.getByText('8:10 AM')).toBeInTheDocument();
      // A nanosecond past the 08:15 grace window clamps to 9:00; exactly 08:15 stays the actual grace arrival.
      const [boundaryGraceChip] = chipsFor('8:15 AM');
      expect(boundaryGraceChip).toHaveTextContent('9:00 AM');
      expect(boundaryGraceChip.closest('tr')).toHaveTextContent('Grace Hopper');
      expect(screen.getByText('8:15 AM').closest('tr')).toHaveTextContent('Charles Babbage');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('clamps a 09:30 repeat late to 10:00 in the admin table and CSV', async () => {
    vi.restoreAllMocks();
    const exportedBlobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        exportedBlobs.push(blob);
        return 'blob:attendance-export';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    const linkClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    // Monday 08:06 spends the week's grace; Tuesday 09:30 is a repeat late
    // past the weekly grace window; it still uses the hourly clamp.
    mockAdminFetch([
      row('v3r1', '2026-07-27', '08:06:00'),
      row('v3r2', '2026-07-28', '09:30:00'),
    ]);

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      const chip = await screen.findByTestId('clamped-time-in');
      expect(chip).toHaveTextContent('10:00 AM');
      expect(chip.getAttribute('title')).toBe('Actual scan: 9:30 AM (payable time clamped)');
      expect(screen.getByText('8:06 AM')).toBeInTheDocument();

      await user.click(await screen.findByRole('button', { name: /export csv/i }));
      await waitFor(() => expect(exportedBlobs.length).toBeGreaterThan(0));
      const raw = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exportedBlobs[0]);
      });
      const lines = raw.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
      const cells = (line: string) => line.replace(/^"|"$/g, '').split('","');
      const lateLine = lines.find((line) => line.includes('2026-07-28'));
      expect(lateLine).toBeDefined();
      // SAFETY: lateLine checked defined above
      expect(cells(lateLine as string)[4]).toBe('2026-07-28T10:00:00+08:00');
      // SAFETY: lateLine checked defined above
      expect(cells(lateLine as string)[13]).toBe('2026-07-28T09:30:00+08:00');
      // The graced Monday row is untouched, and the actual audit column stays last.
      // SAFETY: lateLine checked defined above
      expect(cells(lines[0]).at(-1)).toBe('Actual time-in');
      expect(linkClick).toHaveBeenCalled();
    } finally {
      window.history.pushState({}, '', '/');
      linkClick.mockRestore();
    }
  });

  it('clamps all non-graced lates while preserving the first grace-window arrival', async () => {
    vi.restoreAllMocks();
    // u2: Tue 08:30 follows Monday's graced 08:06 and must chip.
    // u3: the non-grace Monday late clamps, while Tuesday's first grace-window
    // arrival remains actual and does not get a chip.
    mockAdminFetch([
      row('v3a1', '2026-07-27', '08:06:00'),
      row('v3a2', '2026-07-28', '08:30:00'),
      { ...row('v3b1', '2026-07-27', '09:30:00'), userId: 'u3', fullName: 'Grace Hopper' },
      { ...row('v3b2', '2026-07-28', '08:10:00'), userId: 'u3', fullName: 'Grace Hopper' },
    ]);

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      const chips = await screen.findAllByTestId('clamped-time-in');
      expect(chips).toHaveLength(2);
      expect(chips.map((chip) => chip.textContent)).toEqual(expect.arrayContaining(['9:00 AM', '10:00 AM']));
      // SAFETY: the chip renders inside its attendance row
      expect((chips[0] as HTMLElement).closest('tr')).toHaveTextContent('Charles Babbage');
      // u3's first grace-window arrival stays actual.
      expect(screen.getByText('8:10 AM')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('resets the clamp and the grace at the Manila Monday week boundary', async () => {
    vi.restoreAllMocks();
    // Week 1: 08:06 graced, 08:30 chipped. Week 2 (from Mon 2026-08-03):
    // 08:10 graces fresh (no chip) and 08:20 is the new week's repeat late.
    mockAdminFetch([
      row('v3w1a', '2026-07-27', '08:06:00'),
      row('v3w1b', '2026-07-28', '08:30:00'),
      row('v3w2a', '2026-08-03', '08:10:00'),
      row('v3w2b', '2026-08-04', '08:20:00'),
    ]);

    try {
      window.history.pushState({}, '', '/admin');
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));

      const chips = await screen.findAllByTestId('clamped-time-in');
      expect(chips).toHaveLength(2);
      // The chipped rows are Tuesday 2026-07-28 (08:30) and Tuesday 2026-08-04 (08:20).
      expect(chips.map((chip) => chip.getAttribute('title'))).toEqual(expect.arrayContaining([
        'Actual scan: 8:30 AM (payable time clamped)',
        'Actual scan: 8:20 AM (payable time clamped)',
      ]));
      // Each week's graced first late keeps its actual time.
      expect(screen.getByText('8:06 AM')).toBeInTheDocument();
      expect(screen.getByText('8:10 AM')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('clamps a past-09:00 late in the live table and payroll details', async () => {
    window.history.pushState({}, '', '/attendance');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-28T10:00:00+08:00'));
    try {
      vi.restoreAllMocks();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const url = String(input);
        if (url.includes('/api/config')) {
          // SAFETY: Fetch mock config
          return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', rfidAutoSubmitDelayMs: 30, resultResetDelayMs: 500 }) } as Response;
        }
        if (url.includes('/api/admin/users')) {
          // SAFETY: Fetch users list mock (one intern)
          return { ok: true, json: async () => ({ success: true, users: v3Users }) } as Response;
        }
        if (url.includes('/api/attendance?date=')) {
          // SAFETY: Fetch mock graced Monday history row
          return { ok: true, json: async () => ({ success: true, date: 'history', fetchedAt: '2026-07-28T10:00:00+08:00', attendance: [row('v3l1', '2026-07-27', '08:06:00')] }) } as Response;
        }
        if (url.includes('/api/attendance')) {
          // SAFETY: Fetch mock live snapshot with the 09:30 repeat late
          return { ok: true, json: async () => ({ success: true, date: '2026-07-28', fetchedAt: '2026-07-28T10:00:00+08:00', attendance: [row('v3l2', '2026-07-28', '09:30:00')] }) } as Response;
        }
        // SAFETY: Fetch fallback
        return { ok: true, json: async () => ({ success: true }) } as Response;
      });
      render(<App />);
      // Grace was consumed Monday; this later arrival clamps to the next hour.
      expect(await screen.findByTestId('clamped-time-in')).toHaveTextContent('10:00 AM');
    } finally {
      vi.useRealTimers();
      window.history.pushState({}, '', '/');
    }

    try {
      vi.restoreAllMocks();
      vi.spyOn(api, 'loadPayrollPdfs').mockResolvedValue({ success: true, payrollPdfs: [] });
      const breakdown = {
        deductions: [
          { date: '2026-08-04', category: 'LATE', label: 'Late', details: 'Late arrival at 9:30 AM (1 hr(s) late)', timeIn: '9:30 AM', timeOut: '5:00 PM', workedHours: null, hoursShort: null, lateHours: 1, amount: 10 },
        ],
      };
      const internRecord: PayrollCutoffRecord = {
        payrollId: 'P-INT-CEIL', employeeId: 'INT-CEIL', employeeName: 'Charles Babbage', employeeType: 'INTERN',
        payrollProfileId: 'INTERN_STANDARD', payrollCutoffLabel: 'August 1-15, 2026', cutoffStart: '2026-08-01', cutoffEnd: '2026-08-15',
        payrollFrequency: 'SEMI_MONTHLY', dailyRate: 80, standardWorkingDays: 10, actualWorkingDays: 10, basicPay: 800,
        specialHolidayDays: 0, specialHolidayMultiplier: 0, specialHolidayPay: 0, regularHolidayDays: 0, regularHolidayMultiplier: 0, regularHolidayPay: 0,
        incentivesAllowance: 0, specialAllowance: 0, totalCompensation: 800, totalAllowance: 0, lateUnits: 1, lateDeduction: 10,
        halfDayCount: 0, halfDayDeduction: 0, absentDays: 0, absenceDeduction: 0, overtimeHours: 0, overtimeRate: 0, overtimePay: 0,
        manualAdjustment: 0, adjustmentReason: null, grossCompensation: 800, netPay: 790,
        calculationBreakdown: JSON.stringify(breakdown), approvedWorkingDayOverage: false, status: 'DRAFT', finalizedAt: null,
      };
      render(<PayrollWorkspace records={[internRecord]} onSaved={vi.fn()} />);
      // The record's Aug 1–15 cutoff isn't the pre-filled one, so show every cutoff's records.
      fireEvent.click(screen.getByRole('button', { name: 'All cutoffs' }));
      fireEvent.click(screen.getByRole('button', { name: 'Breakdown' }));
      // The payroll details use the same hourly display clamp.
      expect(await screen.findByTestId('clamped-payroll-time-in')).toHaveTextContent('10:00 AM');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Payroll total-deductions fallback', () => {
  function cutoffRecord(overrides: Partial<PayrollCutoffRecord> = {}): PayrollCutoffRecord {
    return {
      payrollId: 'P-FALLBACK', employeeId: 'EMP-FB', employeeName: 'Ada Lovelace', employeeType: 'INTERN',
      payrollProfileId: 'BEA_STANDARD', payrollCutoffLabel: 'August 1-15, 2026', cutoffStart: '2026-08-01', cutoffEnd: '2026-08-15',
      payrollFrequency: 'SEMI_MONTHLY', dailyRate: 500, standardWorkingDays: 11, actualWorkingDays: 10, basicPay: 5500,
      specialHolidayDays: 0, specialHolidayMultiplier: 0.3, specialHolidayPay: 0, regularHolidayDays: 0, regularHolidayMultiplier: 1, regularHolidayPay: 0,
      incentivesAllowance: 0, specialAllowance: 0, totalCompensation: 5500, totalAllowance: 0, lateUnits: 1, lateDeduction: 10,
      halfDayCount: 0, halfDayDeduction: 0, absentDays: 1, absenceDeduction: 80, overtimeHours: 0, overtimeRate: 0, overtimePay: 0,
      manualAdjustment: 0, adjustmentReason: null, grossCompensation: 5500, netPay: 5410,
      calculationBreakdown: 'PHP 5,500.00 basic', approvedWorkingDayOverage: false, status: 'DRAFT', finalizedAt: null,
      sss: 0, phic: 0, hdmf: 0, salaryAdvance: 0,
      ...overrides,
    };
  }

  function renderRecords(records: PayrollCutoffRecord[]) {
    vi.restoreAllMocks();
    vi.spyOn(api, 'loadPayrollPdfs').mockResolvedValue({ success: true, payrollPdfs: [] });
    const view = render(<PayrollWorkspace records={records} onSaved={vi.fn()} />);
    // The rows' Aug 1–15 cutoff isn't the pre-filled one, so show every cutoff's records.
    fireEvent.click(screen.getByRole('button', { name: 'All cutoffs' }));
    return view;
  }

  it('derives total deductions from components when a legacy cutoff row omits the field', () => {
    const legacy = cutoffRecord({ employeeId: 'EMP-LEGACY', employeeName: 'Legacy Row' });
    delete legacy.totalDeductions;
    renderRecords([legacy]);
    const row = screen.getByRole('row', { name: /Legacy Row/ });
    // 10 late + 80 absent + 0 statutory = 90, not PHP 0.00 beside a reduced net.
    expect(within(row).getByText('PHP 90.00')).toBeInTheDocument();
    // The derived total sits in the Total Deductions column (its position varies as empty columns hide).
    const headings = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
    const cells = within(row).getAllByRole('cell');
    expect(cells[headings.indexOf('Total Deductions')]?.textContent).toBe('PHP 90.00');
  });

  it('keeps the backend-authoritative total deductions when present', () => {
    renderRecords([cutoffRecord({ employeeId: 'EMP-BACKEND', employeeName: 'Backend Row', totalDeductions: 420 })]);
    const row = screen.getByRole('row', { name: /Backend Row/ });
    expect(within(row).getByText('PHP 420.00')).toBeInTheDocument();
    expect(within(row).queryByText('PHP 90.00')).not.toBeInTheDocument();
  });
});

describe('Users and RFID: registration form on demand', () => {
  const people = [
    { userId: 'APG-1', rfidUid: 'UID-1', fullName: 'Ada Lovelace', department: 'IT', status: 'ACTIVE', employeeType: 'INTERN', gender: null, dailyRate: null, photoUrl: null },
    { userId: 'APG-2', rfidUid: 'UID-2', fullName: 'Grace Hopper', department: 'IT', status: 'ACTIVE', employeeType: 'INTERN', gender: null, dailyRate: null, photoUrl: null },
  ];
  function mockAdminFetch() {
    vi.restoreAllMocks();
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Mock users list
        return { ok: true, json: async () => ({ success: true, users: people }) } as Response;
      }
      if (url.includes('/api/admin/bathroom/status')) {
        // SAFETY: Mock bathroom status
        return { ok: true, json: async () => ({ success: true, date: '2026-08-27', maleActive: null, femaleActive: null, maleLogs: [], femaleLogs: [], fetchedAt: '2026-08-27T10:00:00Z' }) } as Response;
      }
      // SAFETY: Fallback mock response (config, attendance, payroll)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', attendance: [], payroll: [], profiles: [] }) } as Response;
    });
  }
  async function openUsersTab() {
    mockAdminFetch();
    window.history.pushState({}, '', '/admin');
    const user = userEvent.setup();
    render(<App />);
    // Admin opens on Attendance corrections; this tab is second.
    await user.click(await screen.findByRole('button', { name: /users and rfid/i }));
    await screen.findByText('Ada Lovelace');
    return user;
  }

  it('keeps the form closed until Add user, and closes it again', async () => {
    const user = await openUsersTab();
    expect(screen.queryByLabelText(/^user id/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^add user$/i }));
    expect(screen.getByLabelText(/^user id/i)).toHaveFocus();

    await user.click(screen.getByRole('button', { name: /close user form/i }));
    expect(screen.queryByLabelText(/^user id/i)).not.toBeInTheDocument();
  });

  it('asks before a tab switch throws away unsaved typing', async () => {
    const user = await openUsersTab();
    await user.click(screen.getByRole('button', { name: /^add user$/i }));
    await user.type(screen.getByLabelText(/full name/i), 'Katherine Johnson');
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /attendance corrections/i }));
    expect(screen.getByRole('dialog', { name: /discard unsaved changes/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(screen.getByLabelText(/full name/i)).toHaveValue('Katherine Johnson');
    expect(screen.getByRole('button', { name: /users and rfid/i })).toHaveClass('is-active');

    await user.click(screen.getByRole('button', { name: /attendance corrections/i }));
    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(screen.getByRole('button', { name: /attendance corrections/i })).toHaveClass('is-active');
    expect(screen.queryByRole('dialog', { name: /discard unsaved changes/i })).not.toBeInTheDocument();
  });

  it('asks before Edit or Cancel throws away unsaved typing, not when nothing changed, and ignores the 2 key while open', async () => {
    const user = await openUsersTab();
    const adaRow = screen.getByText('Ada Lovelace').closest('tr');
    const graceRow = screen.getByText('Grace Hopper').closest('tr');
    await user.click(within(adaRow!).getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('heading', { name: 'Editing Ada Lovelace' })).toBeInTheDocument();

    // Nothing typed yet: Edit switches straight away.
    await user.click(within(graceRow!).getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('heading', { name: 'Editing Grace Hopper' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: /discard unsaved changes/i })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText(/department/i));
    await user.type(screen.getByLabelText(/department/i), 'Finance');
    await user.click(within(adaRow!).getByRole('button', { name: /^edit$/i }));
    expect(screen.getByRole('dialog', { name: /discard unsaved changes/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /keep editing/i }));
    expect(screen.getByRole('heading', { name: 'Editing Grace Hopper' })).toBeInTheDocument();

    // While the pop-up is open the 1/2 shortcut does nothing, so it can't throw the typing away.
    fireEvent.keyDown(window, { key: '2' });
    expect(screen.queryByRole('dialog', { name: /discard unsaved changes/i })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Editing Grace Hopper' })).toBeInTheDocument();

    // Cancel with unsaved typing asks too; discarding closes the pop-up.
    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    await user.click(screen.getByRole('button', { name: /discard changes/i }));
    expect(screen.queryByRole('dialog', { name: 'Editing Grace Hopper' })).not.toBeInTheDocument();
  });
});

describe('Pop-ups and admin lists: keyboard, toasts and Retry', () => {
  const people = [
    { userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE', cardType: 'EMPLOYEE' },
  ];
  const attendanceRow = {
    attendanceId: 'att-1', attendanceDate: '2026-07-28', userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', department: 'Sales',
    timeIn: '2026-07-28T08:00:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED', source: 'RFID',
  };
  /** Admin with one user and one attendance row; `failUsersOnce` makes the first users load fail. */
  function mockAdmin(failUsersOnce = false) {
    vi.restoreAllMocks();
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    const calls = { users: 0, attendance: 0 };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        calls.users += 1;
        if (failUsersOnce && calls.users === 1) throw new Error('offline');
        // SAFETY: Mock users list
        return { ok: true, json: async () => ({ success: true, users: people }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        calls.attendance += 1;
        // SAFETY: Mock attendance list
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance: [attendanceRow] }) } as Response;
      }
      // SAFETY: Fallback mock response (config, payroll, bathroom)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', payroll: [], profiles: [] }) } as Response;
    });
    return calls;
  }

  it('closes Add missed attendance with Escape, keeps Tab inside it and gives focus back to its button', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));
      const opener = screen.getByRole('button', { name: /^add missed attendance$/i });
      await user.click(opener);

      const dialog = await screen.findByRole('dialog', { name: /add missed attendance/i });
      expect(dialog.contains(document.activeElement)).toBe(true);
      // Far more Tabs (forwards and back) than the pop-up has controls: focus never leaves it.
      for (let index = 0; index < 12; index += 1) {
        await user.tab();
        expect(dialog.contains(document.activeElement)).toBe(true);
      }
      for (let index = 0; index < 12; index += 1) {
        await user.tab({ shift: true });
        expect(dialog.contains(document.activeElement)).toBe(true);
      }

      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: /add missed attendance/i })).not.toBeInTheDocument();
      expect(opener).toHaveFocus();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('answers Escape in the top pop-up only: the discard question first, then the form', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /users and rfid/i }));
      await screen.findByText('Juan Dela Cruz');
      const addUser = screen.getByRole('button', { name: /^add user$/i });
      await user.click(addUser);
      await user.type(screen.getByLabelText(/full name/i), 'Maria Clara');

      // Escape on the form asks first; the destructive question starts on its safe button.
      await user.keyboard('{Escape}');
      const ask = screen.getByRole('dialog', { name: /discard unsaved changes/i });
      expect(within(ask).getByRole('button', { name: /keep editing/i })).toHaveFocus();

      // Escape closes only the question; the form and its typing stay.
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog', { name: /discard unsaved changes/i })).not.toBeInTheDocument();
      expect(screen.getByLabelText(/full name/i)).toHaveValue('Maria Clara');

      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: /discard changes/i }));
      expect(screen.queryByRole('dialog', { name: /add user/i })).not.toBeInTheDocument();
      expect(addUser).toHaveFocus();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('shows a failed users list with Retry that reloads only that list, while other tabs still load', async () => {
    const calls = mockAdmin(true);
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      // The failure does not block Attendance corrections, where the admin page opens.
      expect(await screen.findByText('1 record')).toBeInTheDocument();
      const attendanceLoads = calls.attendance;

      await user.click(screen.getByRole('button', { name: /users and rfid/i }));
      expect(await screen.findByText("Couldn't load users.")).toBeInTheDocument();
      expect(screen.queryByText('No users yet. Use Add user to register the first one.')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /retry/i }));
      expect(await screen.findByText('Juan Dela Cruz')).toBeInTheDocument();
      expect(screen.queryByText("Couldn't load users.")).not.toBeInTheDocument();
      expect(calls.users).toBe(2);
      expect(calls.attendance).toBe(attendanceLoads);
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('shows placeholder rows while the users list loads', async () => {
    mockAdmin();
    let releaseUsers: () => void = () => {};
    const usersGate = new Promise<void>((resolve) => {
      releaseUsers = resolve;
    });
    vi.spyOn(api, 'loadAdminUsers').mockImplementation(async () => {
      await usersGate;
      // SAFETY: Mock users response in the shared contract's form
      return { success: true, users: people } as Awaited<ReturnType<typeof api.loadAdminUsers>>;
    });
    window.history.pushState({}, '', '/admin');
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole('button', { name: /users and rfid/i }));
      expect(await screen.findByText('Loading users…')).toBeInTheDocument();
      expect(screen.queryByText('No users yet. Use Add user to register the first one.')).not.toBeInTheDocument();
      act(() => releaseUsers());
      expect(await screen.findByText('Juan Dela Cruz')).toBeInTheDocument();
      expect(screen.queryByText('Loading users…')).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Admin results and date changes', () => {
  const people = [
    { userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', rfidUid: 'RFID-1', employeeType: 'INTERN', status: 'ACTIVE', cardType: 'EMPLOYEE' },
  ];
  const attendanceRow = {
    attendanceId: 'att-1', attendanceDate: '2026-07-28', userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', department: 'Sales',
    timeIn: '2026-07-28T08:00:00+08:00', timeOut: '2026-07-28T17:00:00+08:00', status: 'COMPLETED', source: 'RFID',
  };
  /** Admin with one user; attendance for `failDate` fails, every other date has one row. */
  function mockAdmin(failDate = '') {
    vi.restoreAllMocks();
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Mock users list
        return { ok: true, json: async () => ({ success: true, users: people }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        if (failDate && url.includes(`date=${failDate}`)) throw new Error('offline');
        // SAFETY: Mock attendance list
        return { ok: true, json: async () => ({ success: true, date: '2026-07-28', attendance: [attendanceRow] }) } as Response;
      }
      // SAFETY: Fallback mock response (config, payroll, bathroom)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', payroll: [], profiles: [] }) } as Response;
    });
  }

  it('clears an earlier save error once the save works', async () => {
    mockAdmin();
    vi.spyOn(api, 'saveAdminUser')
      .mockResolvedValueOnce({ success: false, error: { message: 'This RFID card is already assigned.' } })
      .mockResolvedValueOnce({ success: true });
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /users and rfid/i }));
      await screen.findByText('Juan Dela Cruz');
      await user.click(screen.getByRole('button', { name: /^add user$/i }));
      await user.type(screen.getByLabelText(/^user id/i), 'APG-2026-002');
      await user.type(screen.getByLabelText(/rfid uid/i), 'RFID-2');
      await user.type(screen.getByLabelText(/full name/i), 'Maria Clara');

      await user.click(screen.getByRole('button', { name: 'Save user' }));
      expect(await screen.findByText('This RFID card is already assigned.')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Save user' }));
      expect(await screen.findByText('User saved.')).toBeInTheDocument();
      expect(screen.queryByText('This RFID card is already assigned.')).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('drops the old date’s rows, selection and actions while another date fails to load', async () => {
    mockAdmin('2026-07-01');
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));
      expect(await screen.findByText('1 record')).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: /select attendance for juan dela cruz/i }));
      expect(screen.getByText('1 selected')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Filter attendance date'), { target: { value: '2026-07-01' } });

      expect(await screen.findByText("Couldn't load attendance for this date.")).toBeInTheDocument();
      expect(screen.getByText('0 records')).toBeInTheDocument();
      expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Selected attendance records' })).not.toBeInTheDocument();
      expect(screen.queryByRole('checkbox', { name: /select attendance for juan dela cruz/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /export csv/i })).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: /select all attendance records/i })).toBeDisabled();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Attendance corrections: rows open on Edit', () => {
  type MockRow = {
    attendanceId: string; attendanceDate: string; userId: string; fullName: string; department: string;
    timeIn: string; timeOut: string | null; status: string; source: string;
  };
  const people = [
    { userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', rfidUid: 'RFID-1', employeeType: 'EMPLOYEE', status: 'ACTIVE', cardType: 'EMPLOYEE' },
  ];
  /** One day: Juan late 1h 05m, Maria late 5h 22m (still working), Jose late 20m. */
  const day = (date: string, juanIn = '09:05:00'): MockRow[] => [
    { attendanceId: `${date}-juan`, attendanceDate: date, userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', department: 'Sales', timeIn: `${date}T${juanIn}+08:00`, timeOut: `${date}T17:00:00+08:00`, status: 'COMPLETED', source: 'RFID' },
    { attendanceId: `${date}-maria`, attendanceDate: date, userId: 'APG-2026-002', fullName: 'Maria Clara', department: 'Sales', timeIn: `${date}T13:22:00+08:00`, timeOut: null, status: 'WORKING', source: 'RFID' },
    { attendanceId: `${date}-jose`, attendanceDate: date, userId: 'APG-2026-003', fullName: 'Jose Rizal', department: 'Sales', timeIn: `${date}T08:20:00+08:00`, timeOut: `${date}T17:00:00+08:00`, status: 'COMPLETED', source: 'RFID' },
  ];
  type SaveBody = { timeIn?: string | null; timeOut?: string | null; expectedTimeIn?: string | null; expectedTimeOut?: string | null };

  /** The mocked server's rows by date (a test may change them to stand for a new scan). */
  let stored = new Map<string, MockRow[]>();
  type SaveError = { code: string; message: string };
  /**
   * Admin whose attendance for any date is `day(date)`; a save updates the stored row. `holdSave` delays the save's
   * answer; `failSave` may answer a save with an error instead (the record then stays as stored).
   */
  function mockAdmin(holdSave?: Promise<void>, juanIn?: string, failSave?: () => SaveError | null) {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    stored = new Map<string, MockRow[]>();
    const saves: SaveBody[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Mock users list
        return { ok: true, json: async () => ({ success: true, users: people }) } as Response;
      }
      if (url.includes('/api/admin/attendance/') && init?.method === 'PATCH') {
        // SAFETY: Parse the mocked save body
        const body = JSON.parse(String(init.body)) as SaveBody;
        saves.push(body);
        await holdSave;
        const error = failSave?.() ?? null;
        if (error) {
          // SAFETY: Mock failed save response
          return { ok: true, json: async () => ({ success: false, error }) } as Response;
        }
        for (const list of stored.values()) {
          const row = list.find((item) => url.includes(`/api/admin/attendance/${item.attendanceId}`));
          if (row) {
            row.timeIn = body.timeIn ?? '';
            row.timeOut = body.timeOut ?? null;
          }
        }
        // SAFETY: Mock save response
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url.includes('/api/admin/attendance/backdate')) {
        // SAFETY: Mock missed-attendance add
        return { ok: true, json: async () => ({ success: true }) } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        const date = /date=([^&]+)/.exec(url)?.[1] ?? '2026-07-28';
        if (!stored.has(date)) stored.set(date, day(date, juanIn));
        const rows = (stored.get(date) ?? []).map((row) => ({ ...row }));
        // SAFETY: Mock attendance list for the requested date
        return { ok: true, json: async () => ({ success: true, date, attendance: rows }) } as Response;
      }
      // SAFETY: Fallback mock response (config, payroll, payroll PDFs, bathroom)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', payroll: [], profiles: [], payrollPdfs: [] }) } as Response;
    });
    return saves;
  }

  /** Opens Attendance corrections on Tue, Jul 28, 2026 and returns Juan's row. */
  async function openDay(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
    render(<App />);
    await user.click(await screen.findByRole('button', { name: /attendance corrections/i }));
    fireEvent.change(screen.getByLabelText('Filter attendance date'), { target: { value: '2026-07-28' } });
    expect(await screen.findByText('Tue, Jul 28, 2026')).toBeInTheDocument();
    return rowOf(await screen.findByText('Juan Dela Cruz'));
  }
  function rowOf(element: HTMLElement): HTMLElement {
    const row = element.closest('tr');
    if (!row) throw new Error('not in a table row');
    return row;
  }
  /** The day with Jose's time-out after office hours, so his record is a late time-out. */
  const withLateJose = (date: string, juanIn?: string): MockRow[] =>
    day(date, juanIn).map((row) => (row.fullName === 'Jose Rizal' ? { ...row, timeOut: `${date}T18:40:00+08:00`, status: 'LATE_TIMEOUT' } : row));
  /** Records every attendance delete the page sends (by record); `fail` answers the chosen ones with an error. */
  function trackDeletes(fail: (attendanceId: string) => boolean = () => false): string[] {
    const deleted: string[] = [];
    const base = vi.mocked(globalThis.fetch).getMockImplementation();
    vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
      if (init?.method === 'DELETE') {
        const attendanceId = decodeURIComponent(/\/api\/admin\/attendance\/([^?]+)/.exec(String(input))?.[1] ?? '');
        deleted.push(attendanceId);
        const body = fail(attendanceId) ? { success: false, error: { message: 'Could not delete.' } } : { success: true };
        // SAFETY: Mock delete response
        return { ok: true, json: async () => body } as Response;
      }
      if (!base) throw new Error('fetch is not mocked');
      return base(input, init);
    });
    return deleted;
  }

  it('shows each row read-only with plain times until Edit, and Cancel closes it again', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);

      // Read-only: plain times, "—" for a missing time-out, quiet Edit and Delete, no time fields anywhere.
      expect(within(juan).getByText('9:05 AM')).toBeInTheDocument();
      expect(within(juan).getByText('5:00 PM')).toBeInTheDocument();
      expect(within(rowOf(screen.getByText('Maria Clara'))).getByText('—')).toBeInTheDocument();
      expect(within(juan).getByRole('button', { name: 'Edit times for Juan Dela Cruz' })).toBeInTheDocument();
      expect(within(juan).getByRole('button', { name: "Delete Juan Dela Cruz's record" })).toBeInTheDocument();
      expect(screen.queryByLabelText(/^time (in|out) for/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();

      // Edit opens only that row: its time fields (focus on time in), Save and Cancel instead of Edit and Delete.
      await user.click(within(juan).getByRole('button', { name: 'Edit times for Juan Dela Cruz' }));
      expect(within(juan).getByLabelText('Time in for Juan Dela Cruz')).toHaveValue('09:05');
      expect(within(juan).getByLabelText('Time in for Juan Dela Cruz')).toHaveFocus();
      expect(within(juan).getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:00');
      expect(within(juan).getByRole('button', { name: 'Save' })).toBeInTheDocument();
      expect(within(juan).queryByRole('button', { name: "Delete Juan Dela Cruz's record" })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Time in for Maria Clara')).not.toBeInTheDocument();
      // Opening a row changes nothing yet.
      expect(within(juan).queryByText('Unsaved')).not.toBeInTheDocument();

      // A change shows "Unsaved" (and the gold edge); Cancel throws it away and goes back to plain times.
      fireEvent.change(within(juan).getByLabelText('Time out for Juan Dela Cruz'), { target: { value: '17:30' } });
      expect(within(juan).getByText('Unsaved')).toBeInTheDocument();
      expect(juan).toHaveClass('is-unsaved');
      await user.click(within(juan).getByRole('button', { name: 'Cancel' }));
      expect(within(juan).queryByLabelText('Time out for Juan Dela Cruz')).not.toBeInTheDocument();
      expect(within(juan).getByText('5:00 PM')).toBeInTheDocument();
      expect(within(juan).queryByText('Unsaved')).not.toBeInTheDocument();
      expect(within(juan).getByRole('button', { name: 'Edit times for Juan Dela Cruz' })).toHaveFocus();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('keeps unsaved times through a search, and asks before another date discards them', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await user.click(within(juan).getByRole('button', { name: 'Edit times for Juan Dela Cruz' }));
      fireEvent.change(within(juan).getByLabelText('Time out for Juan Dela Cruz'), { target: { value: '17:30' } });

      // Searching hides the row; clearing the search brings it back with the typing kept.
      const search = screen.getByPlaceholderText('Name or ID');
      await user.type(search, 'Maria');
      expect(screen.queryByText('Juan Dela Cruz')).not.toBeInTheDocument();
      await user.clear(search);
      const back = rowOf(await screen.findByText('Juan Dela Cruz'));
      expect(within(back).getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');
      expect(within(back).getByText('Unsaved')).toBeInTheDocument();

      // Another date asks first; Keep editing stays on this day with the typing.
      const dateInput = screen.getByLabelText('Filter attendance date');
      fireEvent.change(dateInput, { target: { value: '2026-07-29' } });
      const ask = screen.getByRole('dialog', { name: 'Discard unsaved changes?' });
      expect(ask).toHaveTextContent('Some times on Tue, Jul 28, 2026 are not saved yet. Showing Wed, Jul 29, 2026 discards them.');
      await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByText('Tue, Jul 28, 2026')).toBeInTheDocument();
      expect(dateInput).toHaveValue('2026-07-28');
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');

      // Discard changes shows the other date, every row read-only.
      fireEvent.change(dateInput, { target: { value: '2026-07-29' } });
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(await screen.findByText('Wed, Jul 29, 2026')).toBeInTheDocument();
      expect(await screen.findByText('Juan Dela Cruz')).toBeInTheDocument();
      expect(screen.queryByLabelText(/^time (in|out) for/i)).not.toBeInTheDocument();
      expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();

      // With nothing unsaved, a date change just happens.
      fireEvent.change(dateInput, { target: { value: '2026-07-28' } });
      expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).not.toBeInTheDocument();
      expect(await screen.findByText('Tue, Jul 28, 2026')).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('saves only the changed time, shows Saving… and then the row read-only with its new time', async () => {
    let releaseSave: () => void = () => {};
    // Time in with seconds: it must go back exactly as stored, while the edited time-out is rebuilt.
    const saves = mockAdmin(new Promise<void>((resolve) => { releaseSave = resolve; }), '09:05:42');
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await user.click(within(juan).getByRole('button', { name: 'Edit times for Juan Dela Cruz' }));
      fireEvent.change(within(juan).getByLabelText('Time out for Juan Dela Cruz'), { target: { value: '17:30' } });
      await user.click(within(juan).getByRole('button', { name: 'Save' }));

      expect(await within(juan).findByRole('button', { name: 'Saving…' })).toBeDisabled();
      act(() => releaseSave());

      // The untouched time-in keeps its exact stamp (seconds and all); the edited time-out is rebuilt as HH:MM:00.
      expect(saves).toEqual([{
        attendanceDate: '2026-07-28',
        timeIn: '2026-07-28T09:05:42+08:00',
        timeOut: '2026-07-28T17:30:00+08:00',
        expectedTimeIn: '2026-07-28T09:05:42+08:00',
        expectedTimeOut: '2026-07-28T17:00:00+08:00',
      }]);
      await waitFor(() => expect(within(juan).queryByLabelText('Time out for Juan Dela Cruz')).not.toBeInTheDocument());
      expect(within(juan).getByText('5:30 PM')).toBeInTheDocument();
      expect(await screen.findByText("Saved Juan Dela Cruz's times.")).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('shows the chosen day once above the table and late arrivals in hours and minutes', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);

      // The day sits once beside the count; no Date column and no 2026-07-28 anywhere in the table.
      expect(screen.getAllByText('Tue, Jul 28, 2026')).toHaveLength(1);
      expect(screen.getByText('3 records')).toBeInTheDocument();
      expect(screen.queryByRole('columnheader', { name: 'Date' })).not.toBeInTheDocument();
      expect(screen.queryByText('2026-07-28')).not.toBeInTheDocument();

      // "Late 1h 05m", "Late 5h 22m", "Late 20m"; the tooltip keeps the minutes.
      expect(within(juan).getByText('Late 1h 05m')).toHaveAttribute('title', 'Late arrival (65 minutes)');
      expect(screen.getByText('Late 5h 22m')).toBeInTheDocument();
      expect(screen.getByText('Late 20m')).toBeInTheDocument();

      // A confirmation that names the day uses the same date style.
      await user.click(within(juan).getByRole('button', { name: "Delete Juan Dela Cruz's record" }));
      expect(screen.getByRole('dialog', { name: 'Delete attendance record?' })).toHaveTextContent(
        "This will permanently delete Juan Dela Cruz's time-in/time-out record for Tue, Jul 28, 2026.",
      );
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
  it('orders the status filters with Late time-out after All, counts each record once and keeps Late as a separate toggle (filters)', async () => {
    // Juan on time; Maria (working) and Jose (late time-out) arrived late.
    mockAdmin(undefined, '07:55:00');
    stored.set('2026-07-28', withLateJose('2026-07-28', '07:55:00'));
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      await openDay(user);

      const statuses = screen.getByRole('group', { name: 'Filter by status' });
      const buttons = within(statuses).getAllByRole('button');
      expect(buttons.map((button) => button.textContent)).toEqual(['All 3', 'Late time-out 1', 'Working 1', 'Completed 1', 'Missed 0']);
      // A record is counted once: the statuses add up to All.
      const counted = buttons.slice(1).map((button) => Number(button.querySelector('.filter-count')?.textContent));
      expect(counted.reduce((sum, count) => sum + count, 0)).toBe(3);
      // The late time-out count is coral while there are any; an empty status is dimmed.
      expect(buttons[1].querySelector('.filter-count')).toHaveClass('is-alert');
      expect(buttons[3].querySelector('.filter-count')).not.toHaveClass('is-alert');
      expect(buttons[4]).toHaveClass('is-empty');

      // Late is an arrival toggle beside Assisted and Backdated; the ones with nothing to show are dimmed.
      const showOnly = screen.getByRole('group', { name: 'Show only' });
      expect(within(showOnly).getAllByRole('button').map((button) => button.textContent)).toEqual(['Late 2', 'Assisted 0', 'Backdated 0']);
      const late = within(showOnly).getByRole('button', { name: 'Late 2' });
      expect(late).not.toHaveClass('is-empty');
      expect(within(showOnly).getByRole('button', { name: 'Assisted 0' })).toHaveClass('is-empty');
      expect(within(showOnly).getByRole('button', { name: 'Backdated 0' })).toHaveClass('is-empty');

      // Late combines with a status. The statuses count what the other filters let through, so All matches the rows
      // shown and a status Late leaves empty is dimmed.
      await user.click(late);
      expect(late).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('2 of 3 records')).toBeInTheDocument();
      expect(screen.queryByText('Juan Dela Cruz')).not.toBeInTheDocument();
      expect(within(statuses).getAllByRole('button').map((button) => button.textContent)).toEqual(['All 2', 'Late time-out 1', 'Working 1', 'Completed 0', 'Missed 0']);
      expect(within(statuses).getByRole('button', { name: 'Completed 0' })).toHaveClass('is-empty');
      await user.click(within(statuses).getByRole('button', { name: 'Working 1' }));
      expect(late).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByText('1 of 3 records')).toBeInTheDocument();
      expect(screen.getByText('Maria Clara')).toBeInTheDocument();
      expect(screen.queryByText('Jose Rizal')).not.toBeInTheDocument();
      // The toggles count with the chosen status: one working record arrived late.
      expect(within(showOnly).getAllByRole('button').map((button) => button.textContent)).toEqual(['Late 1', 'Assisted 0', 'Backdated 0']);
      // Turning Late off keeps the status, and the statuses count the whole day again.
      await user.click(late);
      expect(late).toHaveAttribute('aria-pressed', 'false');
      expect(screen.getByText('1 of 3 records')).toBeInTheDocument();
      expect(within(statuses).getAllByRole('button').map((button) => button.textContent)).toEqual(['All 3', 'Late time-out 1', 'Working 1', 'Completed 1', 'Missed 0']);
      // A search narrows the counts too.
      await user.type(screen.getByPlaceholderText('Name or ID'), 'Juan');
      expect(within(statuses).getAllByRole('button').map((button) => button.textContent)).toEqual(['All 1', 'Late time-out 0', 'Working 0', 'Completed 1', 'Missed 0']);
      expect(within(showOnly).getByRole('button', { name: 'Late 0' })).toHaveClass('is-empty');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('puts one short late time-out line under a late time-out row, in its own note line', async () => {
    mockAdmin();
    stored.set('2026-07-28', withLateJose('2026-07-28'));
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      await openDay(user);

      const jose = rowOf(screen.getByText('Jose Rizal'));
      expect(within(jose).getByText('Late time-out')).toHaveClass('status-word', 'is-late_timeout');
      // Plain words for the other statuses, as a dot and a word.
      expect(within(rowOf(screen.getByText('Maria Clara'))).getByText('Working')).toHaveClass('status-word', 'is-working');
      const note = jose.nextElementSibling;
      expect(note).toHaveClass('attendance-row-note');
      expect(note).toHaveTextContent('Timed out after office hours. Click Edit and enter the real time-out.');
      // No long paragraph above the row any more, and no note under the other rows.
      expect(screen.queryByText(/manual correction required/i)).not.toBeInTheDocument();
      expect(jose.previousElementSibling).not.toHaveTextContent(/office hours/);
      expect(rowOf(screen.getByText('Maria Clara')).nextElementSibling).not.toHaveClass('attendance-row-note');

      // While the row is open the line says what to do there.
      await user.click(within(jose).getByRole('button', { name: 'Edit times for Jose Rizal' }));
      expect(jose.nextElementSibling).toHaveTextContent('Timed out after office hours. Enter the real time-out and click Save.');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('swaps the table bar for a selection bar while rows are ticked (selection bar)', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      await openDay(user);
      const header = screen.getByRole('checkbox', { name: 'Select all attendance records' });

      // One count, the header tick box only (no Select all button), no selection bar yet.
      expect(screen.getByText('3 records')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^select all/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Selected attendance records' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('checkbox', { name: 'Select attendance for Maria Clara' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select attendance for Jose Rizal' }));
      const bar = screen.getByRole('group', { name: 'Selected attendance records' });
      expect(within(bar).getByText('2 selected')).toBeInTheDocument();
      expect(header).toBePartiallyChecked();
      // The list bar is hidden meanwhile (both stay in the same place), so its buttons can't be reached.
      expect(screen.queryByRole('button', { name: /^add missed attendance$/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /export csv/i })).not.toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Export selected' })).toBeEnabled();

      // Delete selected asks first; cancelling keeps the selection.
      await user.click(within(bar).getByRole('button', { name: 'Delete selected' }));
      expect(screen.getByRole('dialog', { name: 'Delete selected attendance records?' })).toHaveTextContent('2 selected attendance record(s)');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(within(bar).getByText('2 selected')).toBeInTheDocument();

      // Clear empties it: the list bar comes back and the focus lands on the header tick box.
      await user.click(within(bar).getByRole('button', { name: 'Clear' }));
      expect(screen.queryByRole('group', { name: 'Selected attendance records' })).not.toBeInTheDocument();
      expect(header).not.toBeChecked();
      expect(header).toHaveFocus();
      expect(screen.getByRole('button', { name: /^add missed attendance$/i })).toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('acts only on ticked rows still shown after Late and Assisted narrow the list (selection bar)', async () => {
    // Juan on time; Maria late and assisted; Jose late.
    mockAdmin(undefined, '07:55:00');
    stored.set('2026-07-28', withLateJose('2026-07-28', '07:55:00').map((row) => (row.fullName === 'Maria Clara' ? { ...row, source: 'ADMIN_ASSISTED_SCAN' } : row)));
    const deleted = trackDeletes();
    const exported: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob) => {
        exported.push(blob);
        return 'blob:attendance-export';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: () => undefined });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      await openDay(user);
      for (const name of ['Juan Dela Cruz', 'Maria Clara', 'Jose Rizal']) {
        await user.click(screen.getByRole('checkbox', { name: `Select attendance for ${name}` }));
      }
      const bar = screen.getByRole('group', { name: 'Selected attendance records' });
      expect(within(bar).getByText('3 selected')).toBeInTheDocument();

      // Late hides on-time Juan, then Assisted hides Jose: only Maria stays ticked.
      const showOnly = screen.getByRole('group', { name: 'Show only' });
      await user.click(within(showOnly).getByRole('button', { name: 'Late 2' }));
      expect(within(bar).getByText('2 selected')).toBeInTheDocument();
      await user.click(within(showOnly).getByRole('button', { name: 'Assisted 1' }));
      expect(within(bar).getByText('1 selected')).toBeInTheDocument();

      // Export selected writes exactly that one record.
      await user.click(within(bar).getByRole('button', { name: 'Export selected' }));
      await waitFor(() => expect(exported).toHaveLength(1));
      const csv = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error);
        reader.readAsText(exported[0]);
      });
      const dataLines = csv.split('\r\n').filter(Boolean).slice(1);
      expect(dataLines).toHaveLength(1);
      expect(dataLines[0]).toContain('Maria Clara');

      // Delete selected deletes exactly that one record.
      await user.click(within(bar).getByRole('button', { name: 'Delete selected' }));
      expect(screen.getByRole('dialog', { name: 'Delete selected attendance records?' })).toHaveTextContent('1 selected attendance record(s)');
      await user.click(screen.getByRole('button', { name: 'Delete records' }));
      await waitFor(() => expect(deleted).toEqual(['2026-07-28-maria']));
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('keeps the focus on the selection bar when some selected records could not be deleted (selection bar)', async () => {
    mockAdmin();
    const deleted = trackDeletes((attendanceId) => attendanceId === '2026-07-28-jose');
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      await openDay(user);
      await user.click(screen.getByRole('checkbox', { name: 'Select attendance for Maria Clara' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select attendance for Jose Rizal' }));
      const bar = screen.getByRole('group', { name: 'Selected attendance records' });
      await user.click(within(bar).getByRole('button', { name: 'Delete selected' }));
      await user.click(screen.getByRole('button', { name: 'Delete records' }));

      // Jose's record failed: it stays ticked, the bar stays, and the focus is back on Delete selected, not the page.
      await waitFor(() => expect(within(bar).getByText('1 selected')).toBeInTheDocument());
      expect(deleted).toEqual(expect.arrayContaining(['2026-07-28-maria', '2026-07-28-jose']));
      expect(deleted).toHaveLength(2);
      expect(within(bar).getByRole('button', { name: 'Delete selected' })).toHaveFocus();
      expect(screen.getByRole('checkbox', { name: 'Select attendance for Jose Rizal' })).toBeChecked();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  /** Opens Juan's row and types a new time-out into it. */
  async function editJuan(user: ReturnType<typeof userEvent.setup>, juan: HTMLElement, timeOut = '17:30') {
    await user.click(within(juan).getByRole('button', { name: 'Edit times for Juan Dela Cruz' }));
    fireEvent.change(within(juan).getByLabelText('Time out for Juan Dela Cruz'), { target: { value: timeOut } });
  }
  const discardQuestion = () => screen.queryByRole('dialog', { name: 'Discard unsaved changes?' });

  it('keeps the note about unsaved rows hidden by filters, and its Show, while rows are ticked (selection bar)', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan);
      // Working hides Juan's unsaved row; then a row is ticked and the selection bar takes over.
      await user.click(screen.getByRole('button', { name: 'Working 1' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select attendance for Maria Clara' }));
      const bar = screen.getByRole('group', { name: 'Selected attendance records' });
      expect(within(bar).getByText('1 selected')).toBeInTheDocument();
      expect(within(bar).getByText(/1 unsaved row hidden by filters/)).toBeInTheDocument();

      await user.click(within(bar).getByRole('button', { name: 'Show' }));
      expect(screen.getByText('Juan Dela Cruz')).toBeInTheDocument();
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');
      expect(screen.queryByText(/unsaved row hidden by filters/)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('asks before a tab, Bathroom mode (button or the 2 key) or Lock throws away unsaved times', { timeout: 20000 }, async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan);

      // Another tab asks, naming this section; Keep editing keeps the typing.
      await user.click(screen.getByRole('button', { name: 'Payroll' }));
      expect(discardQuestion()).toHaveTextContent('You have unsaved changes in Attendance corrections. Leaving now discards them.');
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByRole('button', { name: /attendance corrections/i })).toHaveAttribute('aria-current', 'page');
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');

      // The System tab, last in the bar, asks the same way.
      await user.click(screen.getByRole('button', { name: 'System' }));
      expect(discardQuestion()).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByRole('button', { name: 'System' })).not.toHaveAttribute('aria-current');

      // The 2 key asks too, even with focus on the row's Save button.
      const save = within(juan).getByRole('button', { name: 'Save' });
      save.focus();
      fireEvent.keyDown(save, { key: '2' });
      expect(discardQuestion()).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));

      // So do the Bathroom Key Log button and Lock.
      await user.click(screen.getByRole('tab', { name: /bathroom key log/i }));
      expect(discardQuestion()).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      await user.click(screen.getByRole('button', { name: 'Lock' }));
      expect(discardQuestion()).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');

      // Discard changes goes ahead; afterwards nothing is guarded.
      await user.click(screen.getByRole('button', { name: 'Payroll' }));
      await user.click(screen.getByRole('button', { name: 'Discard changes' }));
      expect(screen.getByRole('button', { name: 'Payroll' })).toHaveAttribute('aria-current', 'page');
      await user.click(screen.getByRole('button', { name: /attendance corrections/i }));
      expect(await screen.findByText('Juan Dela Cruz')).toBeInTheDocument();
      expect(screen.queryByLabelText('Time out for Juan Dela Cruz')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Payroll' }));
      expect(discardQuestion()).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('asks before Today or an added missed attendance moves to another date, and Keep editing stays', { timeout: 20000 }, async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan);

      await user.click(screen.getByRole('button', { name: 'Today' }));
      expect(discardQuestion()).toHaveTextContent('Some times on Tue, Jul 28, 2026 are not saved yet.');
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByText('Tue, Jul 28, 2026')).toBeInTheDocument();

      // A missed attendance added for yesterday would show that day: it asks first.
      await user.click(screen.getByRole('button', { name: /^add missed attendance$/i }));
      const add = await screen.findByRole('dialog', { name: /add missed attendance/i });
      await user.type(within(add).getByLabelText(/reason \(mandatory audit trail\):/i), 'Forgot card');
      await user.click(within(add).getByRole('button', { name: /add missed attendance/i }));
      expect(await screen.findByRole('dialog', { name: 'Discard unsaved changes?' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.getByText('Tue, Jul 28, 2026')).toBeInTheDocument();
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('holds a date typed by keyboard while rows are unsaved, asking only on Enter or leaving the field', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan);
      const dateInput = screen.getByLabelText('Filter attendance date');

      // A year typed digit by digit passes through 0002 and 2026: no question while typing.
      fireEvent.keyDown(dateInput, { key: '2' });
      fireEvent.change(dateInput, { target: { value: '0002-07-29' } });
      expect(discardQuestion()).not.toBeInTheDocument();
      expect(dateInput).toHaveValue('0002-07-29');
      fireEvent.keyDown(dateInput, { key: '6' });
      fireEvent.change(dateInput, { target: { value: '2026-07-29' } });
      expect(discardQuestion()).not.toBeInTheDocument();

      fireEvent.keyDown(dateInput, { key: 'Enter' });
      expect(discardQuestion()).toHaveTextContent('Showing Wed, Jul 29, 2026 discards them.');
      await user.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(dateInput).toHaveValue('2026-07-28');

      // Leaving the field asks too.
      fireEvent.keyDown(dateInput, { key: '3' });
      fireEvent.change(dateInput, { target: { value: '2026-07-30' } });
      fireEvent.blur(dateInput);
      expect(discardQuestion()).toHaveTextContent('Showing Thu, Jul 30, 2026 discards them.');
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('keeps a row open with the server times and the problem when the record changed before Save', async () => {
    const conflict = 'This record was changed by another update. The list was reloaded — check the times and save again.';
    mockAdmin(undefined, undefined, () => ({ code: 'ATTENDANCE_CONFLICT', message: conflict }));
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan);
      // Meanwhile the kiosk records a new time-out for Juan.
      const stamped = stored.get('2026-07-28')?.find((row) => row.fullName === 'Juan Dela Cruz');
      if (!stamped) throw new Error('no stored row for Juan');
      stamped.timeOut = '2026-07-28T17:45:00+08:00';

      await user.click(within(juan).getByRole('button', { name: 'Save' }));
      expect(await screen.findByText(conflict)).toBeInTheDocument();
      await waitFor(() => expect(within(juan).getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:45'));
      expect(within(juan).getByRole('button', { name: 'Save' })).toBeEnabled();
      expect(within(juan).queryByText('Unsaved')).not.toBeInTheDocument();
      // The server's message is enough: no second "record changed" note.
      expect(screen.queryByText(/Your typed times were cleared/)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('saves a time-out after 6:00 PM and keeps the late time-out note on its own line under the row', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan, '18:30');
      await user.click(within(juan).getByRole('button', { name: 'Save' }));

      const note = await screen.findByText('Saved. Still a late time-out: enter the real time-out.');
      await waitFor(() => expect(within(juan).queryByLabelText('Time out for Juan Dela Cruz')).not.toBeInTheDocument());
      expect(within(juan).getByText('6:30 PM')).toBeInTheDocument();
      expect(note.closest('tr')).toHaveClass('attendance-row-note');
      expect(juan.nextElementSibling).toBe(note.closest('tr'));
      expect(screen.queryByText("Saved Juan Dela Cruz's times.")).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('opens two rows at once, locks the date while one saves, and leaves focus where the admin is typing', async () => {
    let releaseSave: () => void = () => {};
    mockAdmin(new Promise<void>((resolve) => { releaseSave = resolve; }));
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      const maria = rowOf(screen.getByText('Maria Clara'));
      await editJuan(user, juan);
      await user.click(within(maria).getByRole('button', { name: 'Edit times for Maria Clara' }));
      fireEvent.change(within(maria).getByLabelText('Time out for Maria Clara'), { target: { value: '17:10' } });
      expect(within(juan).getByText('Unsaved')).toBeInTheDocument();
      expect(within(maria).getByText('Unsaved')).toBeInTheDocument();

      await user.click(within(juan).getByRole('button', { name: 'Save' }));
      // While a row saves, the date stays put.
      expect(screen.getByLabelText('Filter attendance date')).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Today' })).toBeDisabled();
      // The admin carries on in Maria's row.
      const mariaIn = within(maria).getByLabelText('Time in for Maria Clara');
      mariaIn.focus();
      act(() => releaseSave());

      await waitFor(() => expect(within(juan).queryByLabelText('Time out for Juan Dela Cruz')).not.toBeInTheDocument());
      expect(mariaIn).toHaveFocus();
      expect(within(maria).getByLabelText('Time out for Maria Clara')).toHaveValue('17:10');
      expect(screen.getByLabelText('Filter attendance date')).toBeEnabled();

      // Cancel closes only Maria's row and gives focus to its Edit.
      await user.click(within(maria).getByRole('button', { name: 'Cancel' }));
      expect(within(maria).getByRole('button', { name: 'Edit times for Maria Clara' })).toHaveFocus();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('says so when a refresh replaced typed times because the record changed on the server', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      const maria = rowOf(screen.getByText('Maria Clara'));
      await editJuan(user, juan);
      // A new scan changes Juan's record; Maria's save refreshes the list.
      const stamped = stored.get('2026-07-28')?.find((row) => row.fullName === 'Juan Dela Cruz');
      if (!stamped) throw new Error('no stored row for Juan');
      stamped.timeOut = '2026-07-28T17:45:00+08:00';
      await user.click(within(maria).getByRole('button', { name: 'Edit times for Maria Clara' }));
      fireEvent.change(within(maria).getByLabelText('Time out for Maria Clara'), { target: { value: '17:10' } });
      await user.click(within(maria).getByRole('button', { name: 'Save' }));

      expect(await screen.findByText('This record changed (for example a new scan). Your typed times were cleared; check and edit again.')).toBeInTheDocument();
      expect(within(juan).getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:45');
      expect(within(juan).queryByText('Unsaved')).not.toBeInTheDocument();
      // Typing again answers the note.
      fireEvent.change(within(juan).getByLabelText('Time out for Juan Dela Cruz'), { target: { value: '17:50' } });
      expect(screen.queryByText(/Your typed times were cleared/)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });

  it('points out unsaved rows hidden by the filters and shows them again', async () => {
    mockAdmin();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      const juan = await openDay(user);
      await editJuan(user, juan);
      await user.type(screen.getByPlaceholderText('Name or ID'), 'Maria');
      expect(screen.queryByText('Juan Dela Cruz')).not.toBeInTheDocument();
      // The note sits in both bar layers (so ticking rows never hides it); the shown one has the reachable Show.
      expect(screen.getByRole('button', { name: 'Show' }).parentElement).toHaveTextContent(/^1 unsaved row hidden by filters/);

      await user.click(screen.getByRole('button', { name: 'Show' }));
      expect(screen.getByPlaceholderText('Name or ID')).toHaveValue('');
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');
      expect(screen.queryByText(/hidden by filters/)).not.toBeInTheDocument();
    } finally {
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Sort by time in: Attendance corrections and Live attendance', () => {
  /** Four people on one day: Maria last in (1:22 PM), Juan, Jose first in (8:20 AM), Andres with no time in. */
  const rowsFor = (date: string) => [
    { attendanceId: 'r-juan', attendanceDate: date, userId: 'APG-2026-001', fullName: 'Juan Dela Cruz', department: 'Sales', timeIn: `${date}T09:05:00+08:00`, timeOut: `${date}T17:00:00+08:00`, status: 'COMPLETED', source: 'RFID' },
    { attendanceId: 'r-andres', attendanceDate: date, userId: 'APG-2026-004', fullName: 'Andres Bonifacio', department: 'Operations', timeIn: '', timeOut: null, status: 'MISSED', source: 'RFID' },
    { attendanceId: 'r-maria', attendanceDate: date, userId: 'APG-2026-002', fullName: 'Maria Clara', department: 'Sales', timeIn: `${date}T13:22:00+08:00`, timeOut: null, status: 'WORKING', source: 'RFID' },
    { attendanceId: 'r-jose', attendanceDate: date, userId: 'APG-2026-003', fullName: 'Jose Rizal', department: 'Operations', timeIn: `${date}T08:20:00+08:00`, timeOut: `${date}T17:00:00+08:00`, status: 'COMPLETED', source: 'RFID' },
  ];
  function mockFetch() {
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/attendance') || url === '/api/attendance') {
        const date = /date=([^&]+)/.exec(url)?.[1] ?? '2026-07-28';
        // SAFETY: Mock attendance list (admin date list and the live snapshot)
        return { ok: true, json: async () => ({ success: true, date, fetchedAt: `${date}T15:00:00+08:00`, attendance: rowsFor(date) }) } as Response;
      }
      // SAFETY: Fallback mock response (config, users, payroll, LAN)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', users: [], payroll: [], profiles: [], attendance: [] }) } as Response;
    });
  }
  /** Names in the order the table shows them. */
  const shownNames = () => [...document.querySelectorAll('tbody tr')].flatMap((row) => {
    const name = row.querySelector('td strong')?.textContent;
    return name ? [name] : [];
  });

  it('sorts corrections by time in, newest first, empty time in last, keeping filters, ticks and open rows', async () => {
    localStorage.clear();
    mockFetch();
    window.history.pushState({}, '', '/admin');
    try {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText('Juan Dela Cruz');

      // Newest first by default; the heading says so to screen readers and its button names the other order.
      const heading = screen.getByRole('columnheader', { name: /time in/i });
      expect(heading).toHaveAttribute('aria-sort', 'descending');
      expect(shownNames()).toEqual(['Maria Clara', 'Juan Dela Cruz', 'Jose Rizal', 'Andres Bonifacio']);

      // An open row with a change and a ticked row survive the re-sort.
      const juan = screen.getByText('Juan Dela Cruz').closest('tr');
      expect(juan).not.toBeNull();
      // SAFETY: closest('tr') is checked non-null above
      await user.click(within(juan as HTMLElement).getByRole('button', { name: 'Edit times for Juan Dela Cruz' }));
      fireEvent.change(screen.getByLabelText('Time out for Juan Dela Cruz'), { target: { value: '17:30' } });
      await user.click(screen.getByRole('checkbox', { name: 'Select attendance for Jose Rizal' }));

      // The heading keeps its name; the tooltip says what a click does.
      const sortButton = within(heading).getByRole('button', { name: 'Time in' });
      expect(sortButton).toHaveAttribute('title', 'Sort by time in, oldest first');
      await user.click(sortButton);
      expect(heading).toHaveAttribute('aria-sort', 'ascending');
      expect(sortButton).toHaveAttribute('title', 'Sort by time in, newest first');
      expect(shownNames()).toEqual(['Jose Rizal', 'Juan Dela Cruz', 'Maria Clara', 'Andres Bonifacio']);
      expect(screen.getByLabelText('Time out for Juan Dela Cruz')).toHaveValue('17:30');
      expect(screen.getByRole('checkbox', { name: 'Select attendance for Jose Rizal' })).toBeChecked();
      expect(localStorage.getItem('alpha_premier_sort_attendance_corrections')).toBe('oldest');

      // A status filter and a search keep the order.
      await user.click(screen.getByRole('button', { name: /^completed \d+$/i }));
      expect(shownNames()).toEqual(['Jose Rizal', 'Juan Dela Cruz']);
      await user.click(screen.getByRole('button', { name: /^all \d+$/i }));
      await user.type(screen.getByPlaceholderText('Name or ID'), 'c');
      expect(shownNames()).toEqual(['Juan Dela Cruz', 'Maria Clara', 'Andres Bonifacio']);

      // Phones get the same choice as a small toggle beside the count (hidden on wide screens). It sits in both bar
      // layers; this is the one in the bar that is showing.
      const toggle = screen.getAllByText('Oldest first').find((element) => !element.closest('[aria-hidden="true"]'));
      if (!toggle) throw new Error('no sort toggle in the shown bar');
      expect(toggle).toHaveClass('time-order-toggle');
      fireEvent.click(toggle);
      expect(heading).toHaveAttribute('aria-sort', 'descending');
      expect(toggle).toHaveTextContent('Newest first');
      expect(shownNames()).toEqual(['Maria Clara', 'Juan Dela Cruz', 'Andres Bonifacio']);
    } finally {
      localStorage.clear();
      window.history.pushState({}, '', '/');
    }
  });

  it('opens corrections in the order the viewer chose last time', async () => {
    localStorage.clear();
    localStorage.setItem('alpha_premier_sort_attendance_corrections', 'oldest');
    mockFetch();
    window.history.pushState({}, '', '/admin');
    try {
      render(<App />);
      await screen.findByText('Juan Dela Cruz');
      expect(screen.getByRole('columnheader', { name: /time in/i })).toHaveAttribute('aria-sort', 'ascending');
      expect(shownNames()).toEqual(['Jose Rizal', 'Juan Dela Cruz', 'Maria Clara', 'Andres Bonifacio']);
    } finally {
      localStorage.clear();
      window.history.pushState({}, '', '/');
    }
  });

  it('sorts Live attendance by time in together with the search and department filter', async () => {
    localStorage.clear();
    mockFetch();
    window.history.pushState({}, '', '/attendance');
    try {
      const user = userEvent.setup();
      render(<App />);
      await screen.findByText('Juan Dela Cruz');
      const heading = screen.getByRole('columnheader', { name: /time in/i });
      expect(heading).toHaveAttribute('aria-sort', 'descending');
      expect(shownNames()).toEqual(['Maria Clara', 'Juan Dela Cruz', 'Jose Rizal', 'Andres Bonifacio']);

      await user.selectOptions(screen.getByRole('combobox', { name: 'Department' }), 'Operations');
      expect(shownNames()).toEqual(['Jose Rizal', 'Andres Bonifacio']);
      await user.click(within(heading).getByRole('button', { name: 'Time in' }));
      expect(heading).toHaveAttribute('aria-sort', 'ascending');
      expect(shownNames()).toEqual(['Jose Rizal', 'Andres Bonifacio']);
      expect(localStorage.getItem('alpha_premier_sort_live_attendance')).toBe('oldest');

      await user.selectOptions(screen.getByRole('combobox', { name: 'Department' }), '');
      expect(shownNames()).toEqual(['Jose Rizal', 'Juan Dela Cruz', 'Maria Clara', 'Andres Bonifacio']);
      await user.type(screen.getByRole('searchbox', { name: 'Search name or ID' }), 'c');
      expect(shownNames()).toEqual(['Juan Dela Cruz', 'Maria Clara', 'Andres Bonifacio']);

      // The phone toggle flips the same order.
      fireEvent.click(screen.getByText('Oldest first'));
      expect(heading).toHaveAttribute('aria-sort', 'descending');
      expect(shownNames()).toEqual(['Maria Clara', 'Juan Dela Cruz', 'Andres Bonifacio']);
    } finally {
      localStorage.clear();
      window.history.pushState({}, '', '/');
    }
  });
});

describe('Sort by time in: clamped rows', () => {
  it('sorts a clamped time-in by the payable time it shows, and the heading keeps its name', async () => {
    localStorage.clear();
    vi.spyOn(api, 'loadVoiceClipStates').mockResolvedValue([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/api/admin/session')) {
        // SAFETY: Mock session check
        return { ok: true, json: async () => ({ success: true, expiresAt: new Date(Date.now() + 600_000).toISOString() }) } as Response;
      }
      if (url.includes('/api/admin/users')) {
        // SAFETY: Mock users: one intern (clamped after the week's grace) and one employee
        return {
          ok: true,
          json: async () => ({
            success: true,
            users: [
              { userId: 'APG-2026-004', fullName: 'Lorenzo Ruiz', rfidUid: 'RFID-4', employeeType: 'INTERN', status: 'ACTIVE' },
              { userId: 'APG-2026-005', fullName: 'Gabriela Silang', rfidUid: 'RFID-5', employeeType: 'EMPLOYEE', status: 'ACTIVE' },
            ],
          }),
        } as Response;
      }
      if (url.includes('/api/admin/attendance')) {
        // SAFETY: Monday's grace for the intern, then Tuesday 8:30 (shown as 9:00 AM) and the employee's 8:45
        return {
          ok: true,
          json: async () => ({
            success: true,
            date: '2026-07-28',
            attendance: [
              { attendanceId: 'l-mon', attendanceDate: '2026-07-27', userId: 'APG-2026-004', fullName: 'Lorenzo Ruiz', department: 'Operations', timeIn: '2026-07-27T08:06:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'g-tue', attendanceDate: '2026-07-28', userId: 'APG-2026-005', fullName: 'Gabriela Silang', department: 'Finance', timeIn: '2026-07-28T08:45:00+08:00', timeOut: null, status: 'WORKING' },
              { attendanceId: 'l-tue', attendanceDate: '2026-07-28', userId: 'APG-2026-004', fullName: 'Lorenzo Ruiz', department: 'Operations', timeIn: '2026-07-28T08:30:00+08:00', timeOut: null, status: 'WORKING' },
            ],
          }),
        } as Response;
      }
      // SAFETY: Fallback mock response (config, payroll, week history)
      return { ok: true, json: async () => ({ success: true, timezone: 'Asia/Manila', payroll: [], profiles: [], attendance: [] }) } as Response;
    });
    window.history.pushState({}, '', '/admin');
    try {
      render(<App />);
      const chip = await screen.findByTestId('clamped-time-in');
      expect(chip).toHaveTextContent('9:00 AM');
      // Newest first by what the table shows: 9:00 AM (an 8:30 scan) comes before 8:45 AM.
      const firstRows = [...document.querySelectorAll('tbody tr.attendance-row')].slice(0, 2);
      expect(firstRows[0]).toContainElement(chip);
      expect(firstRows[1]).toHaveTextContent('Gabriela Silang');
      expect(firstRows[1]).toHaveTextContent('8:45 AM');
      // The heading's name stays "Time in"; the order is in aria-sort and the action in the tooltip.
      const heading = screen.getByRole('columnheader', { name: 'Time in' });
      expect(heading).toHaveAttribute('aria-sort', 'descending');
      expect(within(heading).getByRole('button', { name: 'Time in' })).toHaveAttribute('title', 'Sort by time in, oldest first');
    } finally {
      localStorage.clear();
      window.history.pushState({}, '', '/');
    }
  });
});
