import type {
  ArtifactExportResponse,
  AttendanceXlsxExportResponse,
  DatabaseBackupResponse,
  DatabaseInfoResponse,
  LanStatusResponse,
  OfficeIdentity,
  PayrollCsvExportResponse,
  SafeConfigResponse,
  ScanErrorResponse,
  ScanRequest,
  ScanResponse,
  ScanSuccessResponse,
  SetupErrorResponse,
  SetupLookupResponse,
  SetupUnlockResponse,
  SetupUpsertRequest,
  SetupUpsertResponse,
  AttendanceListResponse,
  AdminAttendanceResponse,
  AdminUsersResponse,
  PayrollCalculationProfile,
  PayrollCutoffsResponse,
  PayrollProfilesResponse,
} from '@rfid-attendance/shared';
import { DEFAULT_OFFICE_IDENTITY, resolveOfficeDisplay } from '@rfid-attendance/shared';
import { convertFileSrc } from '@tauri-apps/api/core';
import { tauriApi } from './tauri-api';
import { apiUrl } from './network';

const runningInTauri = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
let nativeAdminToken: string | null = null;

export function photoSource(photoUrl: string | null | undefined): string | undefined {
  if (!photoUrl || !runningInTauri()) return photoUrl || undefined;
  try {
    if (photoUrl.startsWith('asset://localhost/')) {
      return convertFileSrc(decodeURIComponent(photoUrl.slice('asset://localhost/'.length)));
    }
    if (/^[A-Za-z]:[\\/]/.test(photoUrl) || photoUrl.startsWith('\\\\')) return convertFileSrc(photoUrl);
  } catch {
    return photoUrl;
  }
  return photoUrl;
}

export const DEFAULT_CONFIG: Omit<SafeConfigResponse, 'success'> = {
  timezone: 'Asia/Manila',
  rfidAutoSubmitDelayMs: 150,
  resultResetDelayMs: 4_000,
  enableCardSetup: false,
  enableAdmin: false,
  office: DEFAULT_OFFICE_IDENTITY,
};

/** Merge a partial office payload from the backend with canonical defaults. */
export function normalizeOffice(office: Partial<OfficeIdentity> | undefined): OfficeIdentity {
  const merged = { ...DEFAULT_OFFICE_IDENTITY, ...(office ?? {}) };
  return {
    ...merged,
    // Display strings derive from the same source of truth when not configured.
    officeDisplayShort: resolveOfficeDisplay(merged, 'short'),
    officeDisplayFull: resolveOfficeDisplay(merged, 'full'),
  };
}

export async function loadConfig(signal?: AbortSignal): Promise<Omit<SafeConfigResponse, 'success'>> {
  try {
    if (runningInTauri()) {
      const data = await tauriApi.getConfig();
      return {
        timezone: data.timezone || DEFAULT_CONFIG.timezone,
        rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs),
        resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs),
        enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup,
        enableAdmin: data.enableAdmin ?? DEFAULT_CONFIG.enableAdmin,
        office: normalizeOffice(data.office as Partial<OfficeIdentity> | undefined),
      };
    }
    const response = await fetch(apiUrl('/api/config'), { signal });
    if (!response.ok) return DEFAULT_CONFIG;
    const data = (await response.json()) as Partial<SafeConfigResponse>;
    return {
      timezone: data.timezone || DEFAULT_CONFIG.timezone,
      rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs),
      resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs),
      enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup,
      enableAdmin: data.enableAdmin ?? DEFAULT_CONFIG.enableAdmin,
      office: normalizeOffice(data.office as Partial<OfficeIdentity> | undefined),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function submitScan(request: ScanRequest, signal?: AbortSignal): Promise<ScanSuccessResponse | ScanErrorResponse> {
  try {
    const scanRequest = runningInTauri()
      ? tauriApi.scanRfid(request)
      : fetch(apiUrl('/api/attendance/scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }).then(async (response) => {
      const data = (await response.json()) as ScanResponse;
      if (data && typeof data === 'object' && 'success' in data) return data;
      return networkError('The attendance service returned an invalid response.');
    });
    return await scanRequest;
  } catch {
    return networkError('Unable to reach the attendance service. Please try again.');
  }
}

export async function unlockSetup(pin: string, signal?: AbortSignal): Promise<SetupUnlockResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { const response = await tauriApi.setupUnlock(pin); nativeAdminToken = response.token; return { success: true, setupToken: response.token, expiresAt: response.expiresAt }; } catch { return { success: false, error: { code: 'INVALID_SETUP_PIN', message: 'The setup PIN is invalid.' } } as SetupErrorResponse; } }
  return setupRequest<SetupUnlockResponse | SetupErrorResponse>(apiUrl('/api/setup/unlock'), {
    method: 'POST',
    body: JSON.stringify({ pin }),
    signal,
  });
}

export async function lookupSetupCard(rfidUid: string, setupToken: string, signal?: AbortSignal): Promise<SetupLookupResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.setupLookupCard(setupToken, rfidUid) as SetupLookupResponse; } catch { return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Setup authentication is required.' } } as SetupErrorResponse; } }
  return setupRequest<SetupLookupResponse | SetupErrorResponse>(apiUrl(`/api/setup/card?rfidUid=${encodeURIComponent(rfidUid)}`), {
    method: 'GET',
    setupToken,
    signal,
  });
}

export async function upsertSetupUser(request: SetupUpsertRequest, setupToken: string, signal?: AbortSignal): Promise<SetupUpsertResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.setupUpsertUser(setupToken, request) as SetupUpsertResponse; } catch { return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Setup authentication is required.' } } as SetupErrorResponse; } }
  return setupRequest<SetupUpsertResponse | SetupErrorResponse>(apiUrl('/api/setup/users'), {
    method: 'POST',
    setupToken,
    body: JSON.stringify(request),
    signal,
  });
}

export async function lockSetup(setupToken: string, signal?: AbortSignal): Promise<void> {
  if (runningInTauri()) { nativeAdminToken = null; await tauriApi.setupLock(); return; }
  await setupRequest<unknown>(apiUrl('/api/setup/lock'), { method: 'POST', setupToken, signal });
}

export async function uploadSetupPhoto(userId: string, dataUrl: string, setupToken: string): Promise<{ success: true; photoUrl: string } | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.uploadPhoto(setupToken, userId, dataUrl); } catch { return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Setup authentication is required.' } } as SetupErrorResponse; } }
  return setupRequest<{ success: true; photoUrl: string }>(apiUrl('/api/setup/photo'), { method: 'POST', setupToken, body: JSON.stringify({ userId, dataUrl }) });
}

export async function loadAttendance(date?: string, signal?: AbortSignal): Promise<AttendanceListResponse> {
  if (runningInTauri()) return await tauriApi.getAttendance(date) as AttendanceListResponse;
  const response = await fetch(apiUrl(`/api/attendance${date ? `?date=${encodeURIComponent(date)}` : ''}`), { signal });
  return (await response.json()) as AttendanceListResponse;
}

/** LAN viewer status used when the desktop bridge is unavailable (web mode). */
function lanUnavailableStatus(message: string): LanStatusResponse {
  return {
    success: false,
    state: 'disabled',
    enabled: false,
    allowRuntimeStart: false,
    port: 4173,
    bindAddress: null,
    viewerUrl: null,
    lanIps: [],
    activeLanIp: null,
    networkScope: 'The LAN viewer is available in the desktop application.',
    networkProfile: 'unknown',
    configValid: false,
    configError: message,
    issue: 'not_tauri',
    connectedSseClients: 0,
    startedAt: null,
    lastError: null,
    allowedSubnets: [],
    configuredBindPresent: true,
    localHealthOk: null,
    localHealthError: null,
    firewallAllowRule: 'unknown',
    guidance: [message],
  };
}

/** Desktop-only: start (or verify) the LAN live attendance viewer. */
export async function startLanViewer(): Promise<LanStatusResponse> {
  if (runningInTauri()) { try { return await tauriApi.lanStart(); } catch { return lanUnavailableStatus('Unable to reach the LAN viewer service.'); } }
  return lanUnavailableStatus('The LAN viewer is available in the desktop application.');
}

/** Desktop-only: read the current LAN viewer status for the Live Attendance panel. */
export async function getLanStatus(): Promise<LanStatusResponse> {
  if (runningInTauri()) { try { return await tauriApi.lanStatus(); } catch { return lanUnavailableStatus('Unable to reach the LAN viewer service.'); } }
  return lanUnavailableStatus('The LAN viewer is available in the desktop application.');
}

/** Desktop-only: stop the LAN viewer (attendance recording on this laptop is unaffected). */
export async function stopLanViewer(): Promise<LanStatusResponse> {
  if (runningInTauri()) { try { return await tauriApi.lanStop(); } catch { return lanUnavailableStatus('Unable to reach the LAN viewer service.'); } }
  return lanUnavailableStatus('The LAN viewer is available in the desktop application.');
}

/** Open the viewer URL in the system default browser (web fallback: new tab). */
export async function openViewerUrl(url: string): Promise<boolean> {
  if (runningInTauri()) { try { await tauriApi.openViewerUrl(url); return true; } catch { return false; } }
  try { window.open(url, '_blank'); return true; } catch { return false; }
}

export async function unlockAdmin(pin: string): Promise<{ success: true; expiresAt: string } | { success: false; error: { message: string } }> {
  if (runningInTauri()) { try { const response = await tauriApi.setupUnlock(pin); nativeAdminToken = response.token; return { success: true, expiresAt: response.expiresAt }; } catch { return { success: false, error: { message: 'The administrator PIN is invalid.' } }; } }
  const response = await fetch(apiUrl('/api/admin/unlock'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  return (await response.json()) as { success: true; expiresAt: string } | { success: false; error: { message: string } };
}

export async function lockAdmin(): Promise<void> { if (runningInTauri()) { nativeAdminToken = null; await tauriApi.setupLock(); return; } await fetch(apiUrl('/api/admin/lock'), { method: 'POST' }); }
export async function checkAdminSession(): Promise<string | null> { if (runningInTauri()) { if (!nativeAdminToken) return null; try { await tauriApi.adminGetSession(nativeAdminToken); return nativeAdminToken; } catch { nativeAdminToken = null; return null; } } try { const response = await fetch(apiUrl('/api/admin/session')); if (!response.ok) return null; const data = (await response.json()) as { expiresAt?: string }; return data.expiresAt ?? null; } catch { return null; } }
export async function loadAdminUsers(signal?: AbortSignal): Promise<AdminUsersResponse> { if (runningInTauri()) return await tauriApi.adminUsers(nativeAdminToken ?? '') as AdminUsersResponse; return (await fetch(apiUrl('/api/admin/users'), { signal })).json() as Promise<AdminUsersResponse>; }
export async function loadAdminAttendance(date: string, signal?: AbortSignal): Promise<AdminAttendanceResponse> { if (runningInTauri()) return await tauriApi.adminAttendance(nativeAdminToken ?? '', date) as AdminAttendanceResponse; return (await fetch(apiUrl(`/api/admin/attendance?date=${encodeURIComponent(date)}`), { signal })).json() as Promise<AdminAttendanceResponse>; }
export async function saveAdminUser(user: unknown, userId?: string): Promise<unknown> { if (runningInTauri()) return tauriApi.adminUpsertUser(nativeAdminToken ?? '', { ...(user as object), ...(userId ? { userId } : {}) }); const response = await fetch(apiUrl(userId ? `/api/admin/users/${encodeURIComponent(userId)}` : '/api/admin/users'), { method: userId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) }); return response.json(); }
export async function saveAdminAttendance(attendanceId: string, payload: unknown): Promise<unknown> { if (runningInTauri()) return tauriApi.adminUpdateAttendance(nativeAdminToken ?? '', attendanceId, payload); const response = await fetch(apiUrl(`/api/admin/attendance/${encodeURIComponent(attendanceId)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return response.json(); }
export async function deleteAdminUser(userId: string): Promise<unknown> { if (runningInTauri()) return tauriApi.adminDeleteUser(nativeAdminToken ?? '', userId); const response = await fetch(apiUrl(`/api/admin/users/${encodeURIComponent(userId)}`), { method: 'DELETE' }); return response.json(); }
export async function deleteAdminAttendance(attendanceId: string, date: string): Promise<unknown> { if (runningInTauri()) return tauriApi.adminDeleteAttendance(nativeAdminToken ?? '', attendanceId, date); const response = await fetch(apiUrl(`/api/admin/attendance/${encodeURIComponent(attendanceId)}?date=${encodeURIComponent(date)}`), { method: 'DELETE' }); return response.json(); }
export async function loadPayrollProfiles(): Promise<PayrollProfilesResponse> { if (runningInTauri()) return await tauriApi.payrollProfiles(nativeAdminToken ?? '') as PayrollProfilesResponse; return (await fetch(apiUrl('/api/admin/payroll/profiles'))).json() as Promise<PayrollProfilesResponse>; }
export async function savePayrollProfile(profile: PayrollCalculationProfile): Promise<unknown> { if (runningInTauri()) return tauriApi.payrollUpsertProfile(nativeAdminToken ?? '', profile); const response = await fetch(apiUrl(`/api/admin/payroll/profiles/${encodeURIComponent(profile.profileId)}`), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) }); return response.json(); }
export async function loadPayrollCutoffs(): Promise<PayrollCutoffsResponse> { if (runningInTauri()) return await tauriApi.payrollCutoffs(nativeAdminToken ?? '') as PayrollCutoffsResponse; return (await fetch(apiUrl('/api/admin/payroll/cutoffs'))).json() as Promise<PayrollCutoffsResponse>; }
export async function savePayrollCutoff(payroll: unknown, payrollId?: string): Promise<unknown> { if (runningInTauri()) return payrollId ? tauriApi.payrollUpdateCutoff(nativeAdminToken ?? '', { ...(payroll as object), payrollId }) : tauriApi.payrollCreateCutoff(nativeAdminToken ?? '', payroll); const response = await fetch(apiUrl(payrollId ? `/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}` : '/api/admin/payroll/cutoffs'), { method: payrollId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payroll) }); return response.json(); }
export async function finalizePayrollCutoff(payrollId: string): Promise<unknown> { if (runningInTauri()) return tauriApi.payrollFinalizeCutoff(nativeAdminToken ?? '', payrollId); const response = await fetch(apiUrl(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}/finalize`), { method: 'POST' }); return response.json(); }
export async function exportAttendanceXlsx(date: string): Promise<AttendanceXlsxExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.exportAttendanceXlsx(nativeAdminToken ?? '', date); } catch { return { success: false, error: { message: 'Unable to generate the attendance workbook.' } }; } } return { success: false, error: { message: 'Attendance workbooks are available in the desktop application.' } }; }
export async function exportPayrollXlsx(cutoff?: string): Promise<ArtifactExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.exportPayrollXlsx(nativeAdminToken ?? '', cutoff); } catch { return { success: false, error: { message: 'Unable to generate the payroll workbook.' } }; } } return { success: false, error: { message: 'Payroll workbooks are available in the desktop application.' } }; }
export async function exportPayrollCsv(): Promise<PayrollCsvExportResponse | { success: false; error: { message: string } }> {
  try {
    if (runningInTauri()) {
      // The desktop app writes the CSV next to the other generated files and
      // returns exact paths so the UI can offer Open / Show in folder actions.
      return await tauriApi.payrollExportCsv(nativeAdminToken ?? '');
    }
    const response = await fetch(apiUrl('/api/admin/payroll/export'));
    if (!response.ok) throw new Error('Unable to export payroll CSV.');
    const text = await response.text();
    const fileName = `payroll-${new Date().toISOString().slice(0, 10)}.csv`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return { success: true, fileName, filePath: null, directoryPath: null, fileKind: 'csv', isPortableMode: false };
  } catch (error) {
    return { success: false, error: { message: error instanceof Error ? error.message : 'Unable to export payroll CSV.' } };
  }
}

export type FileActionResult = { ok: boolean; message: string };

function fileActionError(error: unknown, fallback: string): FileActionResult {
  const code = typeof error === 'string' ? error : '';
  if (code === 'FILE_NOT_FOUND') return { ok: false, message: 'The file could not be found. It may have been moved or deleted.' };
  if (code === 'DIRECTORY_NOT_FOUND') return { ok: false, message: 'The folder could not be found. It may have been moved or deleted.' };
  if (code === 'ADMIN_AUTH_REQUIRED') return { ok: false, message: 'Administrator session expired. Unlock admin to continue.' };
  return { ok: false, message: fallback };
}

async function runFileAction(action: (token: string) => Promise<unknown>): Promise<FileActionResult> {
  if (!runningInTauri()) return { ok: false, message: 'File actions are available in the desktop application.' };
  try {
    await action(nativeAdminToken ?? '');
    return { ok: true, message: '' };
  } catch (error) {
    return fileActionError(error, 'The file action could not be completed.');
  }
}

/** Open a generated file with the system default application. */
export function openGeneratedFile(filePath: string): Promise<FileActionResult> {
  return runFileAction((token) => tauriApi.openGeneratedFile(token, filePath));
}

/** Reveal the exact generated file in the OS file explorer. */
export function revealGeneratedFile(filePath: string): Promise<FileActionResult> {
  return runFileAction((token) => tauriApi.revealGeneratedFile(token, filePath));
}

/** Open a generated-file directory in the OS file explorer. */
export function openGeneratedDirectory(directoryPath: string): Promise<FileActionResult> {
  return runFileAction((token) => tauriApi.openGeneratedDirectory(token, directoryPath));
}
export async function generatePayrollPayslipPdf(payrollId: string): Promise<ArtifactExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.generatePayrollPayslipPdf(nativeAdminToken ?? '', payrollId); } catch { return { success: false, error: { message: 'Unable to generate the payslip PDF.' } }; } } return { success: false, error: { message: 'Payslip PDFs are available in the desktop application.' } }; }
export async function generatePayrollRegisterPdf(cutoff?: string): Promise<ArtifactExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.generatePayrollRegisterPdf(nativeAdminToken ?? '', cutoff); } catch { return { success: false, error: { message: 'Unable to generate the payroll register PDF.' } }; } } return { success: false, error: { message: 'Payroll register PDFs are available in the desktop application.' } }; }

export async function nukeSheetsResync(confirm: boolean): Promise<unknown> {
  if (runningInTauri()) return tauriApi.sheetsNukeResync(nativeAdminToken ?? '', confirm);
  return { success: false, error: { message: 'Sheet resync is only available in the desktop application.' } };
}

/** Desktop-only: read the live SQLite database status for the Data & backup panel. */
export async function loadDatabaseInfo(): Promise<DatabaseInfoResponse | { success: false; error: { message: string } }> {
  if (runningInTauri()) { try { return await tauriApi.dbInfo(); } catch { return { success: false, error: { message: 'Unable to read the database status.' } }; } }
  return { success: false, error: { message: 'Database tools are available in the desktop application.' } };
}

/** Desktop-only: create a consistent timestamped backup of the SQLite database. */
export async function createDatabaseBackup(): Promise<DatabaseBackupResponse | { success: false; error: { message: string } }> {
  if (runningInTauri()) { try { return await tauriApi.dbBackup(nativeAdminToken ?? ''); } catch { return { success: false, error: { message: 'Unable to create a database backup.' } }; } }
  return { success: false, error: { message: 'Database backup is available in the desktop application.' } };
}

/** Desktop-only: schedule a restore from `sourcePath`; the app exits and restores on next launch. */
export async function requestDatabaseRestore(sourcePath: string): Promise<{ success: true; message: string } | { success: false; error: { message: string } }> {
  if (runningInTauri()) {
    try { return await tauriApi.dbRestoreRequest(nativeAdminToken ?? '', sourcePath); }
    catch (error) {
      const code = typeof error === 'string' ? error : '';
      const message = code.startsWith('RESTORE_SOURCE_INVALID') ? 'The selected file is not a valid Alpha Premier attendance database.' : code === 'RESTORE_SOURCE_NOT_FOUND' ? 'The selected file could not be found.' : 'Unable to schedule the restore.';
      return { success: false, error: { message } };
    }
  }
  return { success: false, error: { message: 'Restore is available in the desktop application.' } };
}

/** Desktop-only: open the backups folder in the OS file explorer. */
export function openDatabaseBackupsFolder(): Promise<FileActionResult> {
  return runFileAction((token) => tauriApi.dbOpenBackupsDir(token));
}

async function setupRequest<T>(url: string, options: { method: 'GET' | 'POST'; setupToken?: string; body?: string; signal?: AbortSignal }): Promise<T | SetupErrorResponse> {
  try {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.setupToken ? { 'X-Setup-Token': options.setupToken } : {}),
      },
      ...(options.body ? { body: options.body } : {}),
      signal: options.signal,
    });
    return (await response.json()) as T;
  } catch {
    return { success: false, error: { code: 'GOOGLE_SHEETS_UNAVAILABLE', message: 'Unable to reach setup service. Please try again.' } };
  }
}

function positiveNumber(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function networkError(message: string): ScanErrorResponse {
  return {
    success: false,
    requestId: `client-${Date.now()}`,
    error: { code: 'INTERNAL_SERVER_ERROR', message },
  };
}
