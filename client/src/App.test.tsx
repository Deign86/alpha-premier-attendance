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
    expect(await screen.findByText('Card is not registered.')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByRole('heading', { name: /good (morning|afternoon|evening)/i })).toBeInTheDocument(), { timeout: 1_000 });
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

      // The actual scan stays underneath in the real input.
      expect(screen.getByDisplayValue('08:30')).toBeInTheDocument();

      // Capture the clamped row before the chip unmounts on reveal.
      const row = chip.closest('tr');
      expect(row).not.toBeNull();

      // Clicking the chip reveals the actual value for editing.
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
      expect(screen.getByDisplayValue('08:21')).toBeInTheDocument();
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

      expect(await screen.findByText('Total users: 2')).toBeInTheDocument();
      const masterCheckbox = screen.getByRole('checkbox', { name: /select all users/i });
      expect(masterCheckbox).not.toBeChecked();

      await user.click(masterCheckbox);
      expect(masterCheckbox).toBeChecked();
      expect(await screen.findByText('2 of 2 user(s) selected')).toBeInTheDocument();

      const batchDeleteBtn = screen.getByRole('button', { name: /delete selected \(2\)/i });
      await user.click(batchDeleteBtn);

      expect(screen.getByRole('dialog', { name: /delete selected users\?/i })).toBeInTheDocument();
      expect(screen.getByText('Are you sure you want to delete 2 selected user(s)? All associated records (attendance, bathroom logs, and payroll) will be permanently deleted. This cannot be undone.')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /confirm/i }));

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

      expect(await screen.findByText('Total users: 2')).toBeInTheDocument();
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
      await unlockAdmin('293906');
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

      await user.click(screen.getByRole('button', { name: /confirm/i }));
      await waitFor(() => {
        expect(deletedId).toBe('u1');
      });
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

      expect(await screen.findByText('Photo uploaded successfully.')).toBeInTheDocument();
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
      expect(screen.getByDisplayValue('09:03')).toBeInTheDocument();
      expect(screen.getAllByDisplayValue('09:15')).toHaveLength(3);
      expect(screen.getAllByDisplayValue('08:15')).toHaveLength(2);
      expect(screen.getByDisplayValue('08:10')).toBeInTheDocument();
      expect(screen.getAllByDisplayValue('09:16')).toHaveLength(2);
      expect(screen.getByDisplayValue('10:16')).toBeInTheDocument();
      const boundaryGraceInput = screen.getAllByDisplayValue('08:15').find((input) =>
        input.closest('tr')?.textContent?.includes('Grace Hopper'),
      );
      expect(boundaryGraceInput?.closest('tr')).toHaveTextContent('9:00 AM');
      const exactGraceInput = screen.getAllByDisplayValue('08:15').find((input) =>
        input.closest('tr')?.textContent?.includes('Charles Babbage'),
      );
      expect(exactGraceInput?.closest('tr')).not.toHaveTextContent('clamped');
      const subMillisecondClampInput = screen.getAllByDisplayValue('09:15').find((input) =>
        input.closest('tr')?.textContent?.includes('2026-08-03'),
      );
      expect(subMillisecondClampInput?.closest('tr')).toHaveTextContent('10:00 AM');
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

      expect(await screen.findByTestId('clamped-time-in')).toHaveTextContent('10:00 AM');
      expect(screen.getByDisplayValue('09:30')).toBeInTheDocument();

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
      expect(screen.getByDisplayValue('08:10')).toBeInTheDocument();
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
      const dates = chips.map((chip) => {
        // SAFETY: the chip renders inside its attendance row
        const rowElement = chip.closest('tr') as HTMLTableRowElement;
        return within(rowElement).getAllByRole('cell')[1].textContent;
      });
      expect(dates).toEqual(expect.arrayContaining(['2026-07-28', '2026-08-04']));
      // New week's graced first late keeps its actual time.
      expect(screen.getByDisplayValue('08:10')).toBeInTheDocument();
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
    return render(<PayrollWorkspace records={records} onSaved={vi.fn()} />);
  }

  it('derives total deductions from components when a legacy cutoff row omits the field', () => {
    const legacy = cutoffRecord({ employeeId: 'EMP-LEGACY', employeeName: 'Legacy Row' });
    delete legacy.totalDeductions;
    renderRecords([legacy]);
    const row = screen.getByRole('row', { name: /Legacy Row/ });
    // 10 late + 80 absent + 0 statutory = 90, not PHP 0.00 beside a reduced net.
    expect(within(row).getByText('PHP 90.00')).toBeInTheDocument();
    // SAFETY: the single derived total sits in the Total Deductions cell (index 25)
    const cells = within(row).getAllByRole('cell');
    expect(cells[25]?.textContent).toBe('PHP 90.00');
  });

  it('keeps the backend-authoritative total deductions when present', () => {
    renderRecords([cutoffRecord({ employeeId: 'EMP-BACKEND', employeeName: 'Backend Row', totalDeductions: 420 })]);
    const row = screen.getByRole('row', { name: /Backend Row/ });
    expect(within(row).getByText('PHP 420.00')).toBeInTheDocument();
    expect(within(row).queryByText('PHP 90.00')).not.toBeInTheDocument();
  });
});
