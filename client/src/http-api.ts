import type {
  AdminAttendanceResponse,
  AdminUsersResponse,
  AttendanceListItem,
  AttendanceListResponse,
  BathroomActionResponse,
  BathroomScanResponse,
  BathroomStatusResponse,
  PayrollCutoffsResponse,
  PayrollProfilesResponse,
  SafeConfigResponse,
  ScanResponse,
  SetupErrorResponse,
  SetupLookupResponse,
  SetupUnlockResponse,
  SetupUpsertResponse,
} from '@rfid-attendance/shared';
import { SpokenFailure, markUnreachable } from './error-sentences';
import { apiUrl } from './network';
import type { tauriApi } from './tauri-api';

/**
 * The browser transport: the same members as the desktop transport (`tauriApi`), answered by the legacy Node
 * server in `server/`. It exists so the client can be developed in a browser tab; the shipped app never uses it.
 *
 * The server keeps the Admin session in a cookie, so the `token` arguments are ignored here, except the setup
 * token, which it wants in a header. A command the server has no route for fails with the sentence the screen shows.
 */

type Outcome = { success: boolean; error?: { message?: string } };

let abortSignal: AbortSignal | undefined;

/** Runs one transport call so that, in the browser, `signal` cancels its request. The desktop transport has nothing to cancel. */
export function withAbort<T>(signal: AbortSignal | undefined, call: () => Promise<T>): Promise<T> {
  abortSignal = signal;
  try {
    return call();
  } finally {
    abortSignal = undefined;
  }
}

async function ask<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  // SAFETY: The legacy server answers each route with the shared contract type the caller names
  return (await response.json()) as T;
}

const sending = <T extends object>(method: 'POST' | 'PATCH' | 'PUT', body: T): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function setupAsk<T>(path: string, options: { method: 'GET' | 'POST'; setupToken?: string; body?: string }): Promise<T | SetupErrorResponse> {
  try {
    const headers: Record<string, string> = {};
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.setupToken) {
      headers['X-Setup-Token'] = options.setupToken;
    }
    const init: RequestInit = { method: options.method, headers, signal: abortSignal };
    if (options.body) {
      init.body = options.body;
    }
    return await ask<T>(path, init);
  } catch {
    return { success: false, error: { code: 'GOOGLE_SHEETS_UNAVAILABLE', message: 'Unable to reach setup service. Please try again.' } };
  }
}

const desktopOnly = (sentence: string) => (): Promise<never> => Promise.reject(new SpokenFailure(sentence));
/** Commands that only ever ran in the desktop app and whose callers have their own words for a failure. */
const noRoute = desktopOnly('This is available in the desktop application.');

const lanOnly = desktopOnly('The LAN viewer is available in the desktop application.');
const fileOnly = desktopOnly('File actions are available in the desktop application.');
const sheetsOnly = desktopOnly('Google Sheets sync is available in the desktop application.');
const toggleOnly = desktopOnly('DTR sync toggle is available in the desktop application.');
const restoreOnly = desktopOnly('Restore is available in the desktop application.');
const accountOnly = desktopOnly('Signing in with an account is only available in the desktop app.');

export const httpApi: typeof tauriApi = {
  getConfig: async () => {
    const response = await fetch(apiUrl('/api/config'), { signal: abortSignal });
    if (!response.ok) throw new Error('CONFIG_UNAVAILABLE');
    // SAFETY: Parsing response as SafeConfigResponse; api.ts fills every missing field from its defaults
    return (await response.json()) as SafeConfigResponse;
  },
  getHealth: () => ask('/api/health'),
  generatePayrollPdf: desktopOnly('Payroll PDFs are generated in the desktop application.'),
  listPayrollPdfs: desktopOnly('Payroll PDFs are available in the desktop application.'),
  internPayslips: desktopOnly('Payslips are generated in the desktop application.'),
  saveInternPayslipImages: desktopOnly('Payslips are generated in the desktop application.'),
  getAttendance: (date) => ask<AttendanceListResponse>(`/api/attendance${date ? `?date=${encodeURIComponent(date)}` : ''}`, { signal: abortSignal }),
  bathroomGetStatus: (_token, date) => ask<BathroomStatusResponse>(date ? `/api/bathroom/status?date=${encodeURIComponent(date)}` : '/api/bathroom/status', { signal: abortSignal }),
  bathroomScanRfid: (rfidUid, request) =>
    ask<BathroomScanResponse>('/api/bathroom/scan', { ...sending('POST', request ?? { rfidUid }), signal: abortSignal }).catch((error) => {
      throw markUnreachable(error);
    }),
  bathroomTimeOut: (_token, userId, genderKey, notes) =>
    ask<BathroomActionResponse>('/api/admin/bathroom/time-out', sending('POST', { userId, genderKey, notes })).catch((error) => {
      throw markUnreachable(error);
    }),
  bathroomTimeIn: (_token, logId, notes) =>
    ask<BathroomActionResponse>('/api/admin/bathroom/time-in', sending('POST', { logId, notes })).catch((error) => {
      throw markUnreachable(error);
    }),
  bathroomUpdateLog: (_token, logId, request) =>
    ask<BathroomActionResponse>(`/api/admin/bathroom/${encodeURIComponent(logId)}`, sending('PATCH', request)).catch((error) => {
      throw markUnreachable(error);
    }),
  lanStatus: lanOnly,
  lanStart: lanOnly,
  lanStop: lanOnly,
  openViewerUrl: async (url) => {
    window.open(url, '_blank');
  },
  scanRfid: async (request) => {
    const response = await fetch(apiUrl('/api/attendance/scan'), { ...sending('POST', request), signal: abortSignal });
    // SAFETY: Parsing scan response JSON
    const data = (await response.json()) as ScanResponse;
    if (data && Object(data) === data && 'success' in data) return data;
    return { success: false, requestId: `client-${Date.now()}`, error: { code: 'INTERNAL_SERVER_ERROR', message: 'The attendance service returned an invalid response.' } };
  },
  setupUnlock: async (pin) => {
    const answer = await setupAsk<SetupUnlockResponse>('/api/setup/unlock', { method: 'POST', body: JSON.stringify({ pin }) });
    return answer.success ? { success: true, token: answer.setupToken, expiresAt: answer.expiresAt } : answer;
  },
  setupLock: async (setupToken) => {
    await setupAsk<{ success: true }>('/api/setup/lock', { method: 'POST', setupToken });
    return { success: true };
  },
  adminUnlock: async (pin) => {
    // Never rejects: callers hold a busy flag across this call.
    try {
      const answer = await ask<{ success: true; expiresAt: string } | { success: false; error: { message: string } }>('/api/admin/unlock', sending('POST', { pin }));
      return answer.success ? { success: true, token: '', expiresAt: answer.expiresAt } : answer;
    } catch {
      return { success: false, error: { message: 'Unable to reach the attendance service. Please try again.' } };
    }
  },
  adminLock: async () => {
    await fetch(apiUrl('/api/admin/lock'), { method: 'POST' });
    return { success: true };
  },
  adminAccountUnlock: accountOnly,
  adminAccountReset: accountOnly,
  setupLookupCard: (token, rfidUid) => setupAsk<SetupLookupResponse>(`/api/setup/card?rfidUid=${encodeURIComponent(rfidUid)}`, { method: 'GET', setupToken: token }),
  setupUpsertUser: (token, user) => setupAsk<SetupUpsertResponse>('/api/setup/users', { method: 'POST', setupToken: token, body: JSON.stringify(user) }),
  adminGetSession: async () => {
    const response = await fetch(apiUrl('/api/admin/session'));
    if (!response.ok) throw new Error('ADMIN_SESSION_EXPIRED');
    // SAFETY: Parsing admin session check JSON
    const data = (await response.json()) as { expiresAt?: string };
    if (!data.expiresAt) throw new Error('ADMIN_SESSION_EXPIRED');
    return { success: true, expiresAt: data.expiresAt };
  },
  adminUsers: () => ask<AdminUsersResponse>('/api/admin/users', { signal: abortSignal }),
  adminListUsers: () => ask<{ success: true; users: unknown[] }>('/api/admin/users'),
  adminUpsertUser: (_token, user, existingUserId) =>
    ask<Outcome>(existingUserId ? `/api/admin/users/${encodeURIComponent(existingUserId)}` : '/api/admin/users', sending(existingUserId ? 'PATCH' : 'POST', user)),
  adminDeleteUser: (_token, userId) => ask<Outcome>(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  adminAttendance: (_token, date) => ask<AdminAttendanceResponse>(`/api/admin/attendance?date=${encodeURIComponent(date)}`, { signal: abortSignal }),
  adminListAttendance: (_token, date) => ask(`/api/admin/attendance?date=${encodeURIComponent(date)}`),
  adminUpdateAttendance: (_token, attendanceId, payload) =>
    ask<Outcome>(`/api/admin/attendance/${encodeURIComponent(attendanceId)}`, sending('PATCH', payload)).catch((error) => {
      throw markUnreachable(error);
    }),
  adminCreateBackdatedAttendance: (_token, payload) =>
    ask<{ success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } }>('/api/admin/attendance/backdate', sending('POST', payload)).catch((error) => {
      throw markUnreachable(error);
    }),
  adminDeleteAttendance: (_token, attendanceId, date) =>
    ask<Outcome>(`/api/admin/attendance/${encodeURIComponent(attendanceId)}?date=${encodeURIComponent(date)}`, { method: 'DELETE' }).catch((error) => {
      throw markUnreachable(error);
    }),
  payrollProfiles: () => ask<PayrollProfilesResponse>('/api/admin/payroll/profiles'),
  payrollUpsertProfile: (_token, profile) => {
    const profileId = 'profileId' in profile ? String(profile.profileId) : '';
    return ask<{ success: boolean }>(`/api/admin/payroll/profiles/${encodeURIComponent(profileId)}`, sending('PUT', profile));
  },
  payrollDeleteProfile: (_token, profileId) => ask<Outcome>(`/api/admin/payroll/profiles/${encodeURIComponent(profileId)}`, { method: 'DELETE' }),
  payrollCutoffs: () => ask<PayrollCutoffsResponse>('/api/admin/payroll/cutoffs'),
  internPayrollReport: () => Promise.resolve({ success: true, payroll: [] }),
  payrollGenerateCutoff: desktopOnly('Automatic payroll generation is available in the desktop application.'),
  payrollCreateCutoff: (_token, input) => ask('/api/admin/payroll/cutoffs', sending('POST', input)),
  payrollUpdateCutoff: (_token, input) => {
    const payrollId = 'payrollId' in input ? String(input.payrollId) : '';
    return ask(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}`, sending('PATCH', input));
  },
  payrollFinalizeCutoff: (_token, payrollId) => ask<Outcome>(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}/finalize`, { method: 'POST' }),
  payrollDeleteCutoff: (_token, payrollId) => ask<Outcome>(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}`, { method: 'DELETE' }),
  exportAttendanceXlsx: desktopOnly('Attendance workbooks are available in the desktop application.'),
  openGeneratedFile: fileOnly,
  revealGeneratedFile: fileOnly,
  openGeneratedDirectory: fileOnly,
  syncStatus: desktopOnly('Sync status is available in the desktop application.'),
  syncInternDtr: sheetsOnly,
  getInternDtrSync: toggleOnly,
  setInternDtrSync: toggleOnly,
  sheetsNukeResync: () => Promise.resolve({ success: false, error: { message: 'Google Sheets sync is available in the desktop application.' } }),
  uploadPhoto: (token, userId, base64Data) => setupAsk<{ success: true; photoUrl: string }>('/api/setup/photo', { method: 'POST', setupToken: token, body: JSON.stringify({ userId, dataUrl: base64Data }) }),
  dbInfo: desktopOnly('Database tools are available in the desktop application.'),
  dbBackup: desktopOnly('Database backup is available in the desktop application.'),
  dbRestoreRequest: restoreOnly,
  dbDismissRestoreFailure: restoreOnly,
  dbOpenBackupsDir: fileOnly,
  dbSaveBackupCopy: desktopOnly('Download is available in the desktop application.'),
  pickBackupDestination: desktopOnly('Download is available in the desktop application.'),
  ttsSpeak: noRoute,
  ttsStop: noRoute,
  ttsStatus: noRoute,
  getVoicestudioHost: noRoute,
  setVoicestudioHost: noRoute,
  getVoicestudioPin: noRoute,
  setVoicestudioPin: noRoute,
  checkVoicestudio: noRoute,
  voiceClipStates: noRoute,
  voiceWorkerStatus: noRoute,
  voiceRegenerate: desktopOnly('Voice regeneration needs the desktop app.'),
  voiceNameAudioUrl: noRoute,
  idRegisterStatus: noRoute,
  idRegisterSignIn: noRoute,
  idRegisterSignOut: noRoute,
  idRegisterCheck: noRoute,
  autostartStatus: noRoute,
  autostartSet: noRoute,
};
