import type {
  ArtifactExportResponse,
  AttendanceXlsxExportResponse,
  BathroomActionResponse,
  BathroomScanRequest,
  BathroomScanResponse,
  BathroomStatusResponse,
  BathroomUpdateRequest,
  DatabaseBackupResponse,
  DatabaseInfoResponse,
  LanStatusResponse,
  OfficeIdentity,
  PayrollCsvExportResponse,
  SafeConfigResponse,
  ScanErrorResponse,
  ScanRequest,
  ScanResponse,
  SetupErrorCode,
  SetupErrorResponse,
  SetupLookupResponse,
  SetupUnlockResponse,
  SetupUpsertRequest,
  SetupUpsertResponse,
  AttendanceListItem,
  AttendanceListResponse,
  AdminAttendanceResponse,
  AdminUsersResponse,
  PayrollCalculationProfile,
  PayrollCutoffsResponse,
  InternPayrollReportResponse,
  PayrollProfilesResponse,
  PayrollPdfGenerateRequest,
  PayrollPdfGenerateResponse,
  PayrollPdfListResponse,
} from '@rfid-attendance/shared';
import { DEFAULT_OFFICE_IDENTITY, resolveOfficeDisplay } from '@rfid-attendance/shared';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open as openFileDialog } from '@tauri-apps/plugin-dialog';
import { tauriApi } from './tauri-api';
import { apiUrl } from './network';

export async function pickRestoreBackupFile(): Promise<string | null> {
  const selected = await openFileDialog({
    multiple: false,
    directory: false,
    filters: [{ name: 'Alpha Premier portable backup', extensions: ['apbackup', 'db'] }],
  });
  if (selected && Object.prototype.toString.call(selected) === '[object String]') {
    // SAFETY: Verified selected is a string file path
    return selected as string;
  }
  return null;
}

const runningInTauri = () => globalThis.window !== undefined && '__TAURI_INTERNALS__' in globalThis.window;
let nativeAdminToken: string | null = null;

function errorString<T>(error: T): string {
  if (error && Object.prototype.toString.call(error) === '[object String]') {
    // SAFETY: Verified error is a string
    return error as string;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return '';
}

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
  scanner: { mode: 'keyboard', paused: false, expectedLength: 10, characterSet: 'decimal' },
};

/**
 * Tauri command errors arrive as the `Err(String)` value (e.g. "SETUP_AUTH_REQUIRED").
 * Map them to a readable setup error instead of masking every failure as an
 * authentication problem — otherwise a user whose session simply expired sees
 * the misleading "Setup authentication is required" with all fields filled.
 */
export function setupErrorFrom<T>(error: T, fallback: SetupErrorCode): SetupErrorResponse {
  const raw = errorString(error);
  switch (raw) {
    case 'SETUP_AUTH_REQUIRED':
      return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Your setup session expired or was replaced (e.g. by unlocking the Admin panel). Unlock setup again to continue.' } };
    case 'SETUP_SESSION_EXPIRED':
      return { success: false, error: { code: 'SETUP_SESSION_EXPIRED', message: 'Your setup session expired. Unlock setup again to continue.' } };
    case 'INVALID_SETUP_PIN':
      return { success: false, error: { code: 'INVALID_SETUP_PIN', message: 'The setup PIN is invalid.' } };
    case 'ADMIN_DISABLED':
    case 'SETUP_DISABLED':
      return { success: false, error: { code: 'SETUP_DISABLED', message: 'Admin setup is disabled in the configuration.' } };
    case 'SETUP_VALIDATION_ERROR':
      return { success: false, error: { code: 'SETUP_VALIDATION_ERROR', message: 'Some form fields are missing or invalid.' } };
    case 'USER_CONFLICT':
      return { success: false, error: { code: 'USER_CONFLICT', message: 'That User ID or RFID card is already in use by another user.' } };
    case 'INVALID_USER_ID':
      return { success: false, error: { code: 'SETUP_VALIDATION_ERROR', message: 'The User ID may only contain letters, numbers, dashes, underscores, and dots.' } };
    default:
      // Unknown backend error: surface the real message so the true cause is visible.
      return { success: false, error: { code: fallback, message: raw || 'The setup request could not be completed.' } };
  }
}

/** Merge a partial office payload from the backend with canonical defaults. */
export function normalizeOffice(office: Partial<OfficeIdentity> | undefined): OfficeIdentity {
  const merged = { ...DEFAULT_OFFICE_IDENTITY, ...office };
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
        // SAFETY: Casting data.office to partial OfficeIdentity
        office: normalizeOffice(data.office as Partial<OfficeIdentity> | undefined),
        scanner: data.scanner ?? DEFAULT_CONFIG.scanner,
      };
    }
    const response = await fetch(apiUrl('/api/config'), { signal });
    if (!response.ok) return DEFAULT_CONFIG;
    // SAFETY: Parsing response as SafeConfigResponse partial
    const data = (await response.json()) as Partial<SafeConfigResponse>;
    return {
      timezone: data.timezone || DEFAULT_CONFIG.timezone,
      rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs),
      resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs),
      enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup,
      enableAdmin: data.enableAdmin ?? DEFAULT_CONFIG.enableAdmin,
      // SAFETY: Casting data.office to partial OfficeIdentity
      office: normalizeOffice(data.office as Partial<OfficeIdentity> | undefined),
      scanner: data.scanner ?? DEFAULT_CONFIG.scanner,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function submitScan(request: ScanRequest, signal?: AbortSignal): Promise<ScanResponse> {
  try {
    const scanRequest = runningInTauri()
      ? tauriApi.scanRfid(request)
      : fetch(apiUrl('/api/attendance/scan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }).then(async (response) => {
      // SAFETY: Parsing scan response JSON
      const data = (await response.json()) as ScanResponse;
      if (data && Object(data) === data && 'success' in data) return data;
      return networkError('The attendance service returned an invalid response.');
    });
    return await scanRequest;
  } catch (error) {
    const err = error instanceof Error ? error.message : String(error);
    const isNetworkError = !navigator.onLine || err.includes('fetch') || err.includes('network') || err.includes('connectivity');
    if (isNetworkError) {
      const { enqueueOfflineScan } = await import('./network');
      enqueueOfflineScan(request);
      return { success: true, offlineQueued: true, message: 'Attendance saved offline. Will automatically sync when reconnected.' };
    }
    return networkError('Unable to reach the attendance service. Please try again.');
  }
}

export async function unlockSetup(pin: string, signal?: AbortSignal): Promise<SetupUnlockResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { const response = await tauriApi.setupUnlock(pin); nativeAdminToken = response.token; return { success: true, setupToken: response.token, expiresAt: response.expiresAt }; } catch (error) { return setupErrorFrom(error, 'INVALID_SETUP_PIN'); } }
  return setupRequest<SetupUnlockResponse | SetupErrorResponse>(apiUrl('/api/setup/unlock'), {
    method: 'POST',
    body: JSON.stringify({ pin }),
    signal,
  });
}

export async function lookupSetupCard(rfidUid: string, setupToken: string, signal?: AbortSignal): Promise<SetupLookupResponse | SetupErrorResponse> {
  if (runningInTauri()) {
    try {
      // SAFETY: Backend setup lookup command returns SetupLookupResponse
      return (await tauriApi.setupLookupCard(setupToken, rfidUid)) as SetupLookupResponse;
    } catch (error) {
      return setupErrorFrom(error, 'SETUP_AUTH_REQUIRED');
    }
  }
  return setupRequest<SetupLookupResponse | SetupErrorResponse>(apiUrl(`/api/setup/card?rfidUid=${encodeURIComponent(rfidUid)}`), {
    method: 'GET',
    setupToken,
    signal,
  });
}

export async function upsertSetupUser(request: SetupUpsertRequest, setupToken: string, signal?: AbortSignal): Promise<SetupUpsertResponse | SetupErrorResponse> {
  if (runningInTauri()) {
    try {
      // SAFETY: Backend setup upsert user returns SetupUpsertResponse
      return (await tauriApi.setupUpsertUser(setupToken, request)) as SetupUpsertResponse;
    } catch (error) {
      return setupErrorFrom(error, 'SETUP_AUTH_REQUIRED');
    }
  }
  return setupRequest<SetupUpsertResponse | SetupErrorResponse>(apiUrl('/api/setup/users'), {
    method: 'POST',
    setupToken,
    body: JSON.stringify(request),
    signal,
  });
}

export async function lockSetup(setupToken: string, signal?: AbortSignal): Promise<void> {
  if (runningInTauri()) { nativeAdminToken = null; await tauriApi.setupLock(); return; }
  await setupRequest<{ success: true }>(apiUrl('/api/setup/lock'), { method: 'POST', setupToken, signal });
}

export async function uploadSetupPhoto(userId: string, dataUrl: string, setupToken: string): Promise<{ success: true; photoUrl: string } | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.uploadPhoto(setupToken, userId, dataUrl); } catch (error) { return setupErrorFrom(error, 'SETUP_AUTH_REQUIRED'); } }
  return setupRequest<{ success: true; photoUrl: string }>(apiUrl('/api/setup/photo'), { method: 'POST', setupToken, body: JSON.stringify({ userId, dataUrl }) });
}

export async function loadAttendance(date?: string, signal?: AbortSignal): Promise<AttendanceListResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend attendance returns AttendanceListResponse
    return (await tauriApi.getAttendance(date)) as AttendanceListResponse;
  }
  const response = await fetch(apiUrl(`/api/attendance${date ? `?date=${encodeURIComponent(date)}` : ''}`), { signal });
  // SAFETY: Parsing response as AttendanceListResponse
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
  // SAFETY: Parsing admin unlock response JSON
  return (await response.json()) as { success: true; expiresAt: string } | { success: false; error: { message: string } };
}

export async function lockAdmin(): Promise<void> { if (runningInTauri()) { nativeAdminToken = null; await tauriApi.setupLock(); return; } await fetch(apiUrl('/api/admin/lock'), { method: 'POST' }); }
export async function checkAdminSession(): Promise<string | null> {
  if (runningInTauri()) {
    if (!nativeAdminToken) return null;
    try { await tauriApi.adminGetSession(nativeAdminToken); return nativeAdminToken; }
    catch { nativeAdminToken = null; return null; }
  }
  try {
    const response = await fetch(apiUrl('/api/admin/session'));
    if (!response.ok) return null;
    // SAFETY: Parsing admin session check JSON
    const data = (await response.json()) as { expiresAt?: string };
    return data.expiresAt ?? null;
  } catch { return null; }
}
export async function loadAdminUsers(signal?: AbortSignal): Promise<AdminUsersResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend admin users returns AdminUsersResponse
    return (await tauriApi.adminUsers(nativeAdminToken ?? '')) as AdminUsersResponse;
  }
  // SAFETY: Parsing admin users response JSON
  return (await fetch(apiUrl('/api/admin/users'), { signal })).json() as Promise<AdminUsersResponse>;
}
export async function loadAdminAttendance(date: string, signal?: AbortSignal): Promise<AdminAttendanceResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend admin attendance returns AdminAttendanceResponse
    return (await tauriApi.adminAttendance(nativeAdminToken ?? '', date)) as AdminAttendanceResponse;
  }
  // SAFETY: Parsing admin attendance response JSON
  return (await fetch(apiUrl(`/api/admin/attendance?date=${encodeURIComponent(date)}`), { signal })).json() as Promise<AdminAttendanceResponse>;
}
export async function saveAdminUser<T extends object>(user: T, userId?: string): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    const payload = Object.assign({}, user, userId ? { userId } : undefined);
    // SAFETY: Backend admin upsert user returns success response
    return (await tauriApi.adminUpsertUser(nativeAdminToken ?? '', payload)) as { success: boolean; error?: { message?: string } };
  }
  const url = userId ? `/api/admin/users/${encodeURIComponent(userId)}` : '/api/admin/users';
  const response = await fetch(apiUrl(url), { method: userId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) });
  // SAFETY: Parsing admin user save response JSON
  return (await response.json()) as { success: boolean; error?: { message?: string } };
}
export async function saveAdminAttendance<T extends object>(attendanceId: string, payload: T): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    // SAFETY: Backend update attendance returns success response
    return (await tauriApi.adminUpdateAttendance(nativeAdminToken ?? '', attendanceId, payload)) as { success: boolean; error?: { message?: string } };
  }
  const response = await fetch(apiUrl(`/api/admin/attendance/${encodeURIComponent(attendanceId)}`), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  // SAFETY: Parsing admin attendance save response JSON
  return (await response.json()) as { success: boolean; error?: { message?: string } };
}
export async function createAdminBackdatedAttendance<T extends object>(payload: T): Promise<{ success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } }> {
  if (runningInTauri()) {
    try {
      // SAFETY: Backend create backdated attendance returns success and record
      return (await tauriApi.adminCreateBackdatedAttendance(nativeAdminToken ?? '', payload)) as { success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } };
    } catch (err: unknown) {
      const raw = errorString(err);
      const msg = raw || 'Failed to add backdated attendance';
      const friendlyMessage =
        msg === 'ATTENDANCE_ALREADY_EXISTS_FOR_DATE'
          ? 'An attendance record already exists for this employee on this date. Use attendance correction instead.'
          : msg === 'BACKDATE_LIMIT_EXCEEDED'
            ? 'Cannot add backdated attendance: date falls within a finalized payroll cutoff.'
            : msg === 'ADMIN_VALIDATION_ERROR'
              ? 'Please check the employee, date, time, and reason fields.'
              : msg === 'ADMIN_AUTH_REQUIRED'
                ? 'Administrator authentication required.'
                : msg === 'INACTIVE_USER'
                  ? 'Cannot create attendance for an inactive user.'
                  : msg === 'ADMIN_CARD_REQUIRES_SELECTION' || msg === 'ADMIN_CARD_NOT_ALLOWED'
                    ? 'Cannot create attendance for an Admin RFID card.'
                    : msg;
      return { success: false, error: { code: raw || undefined, message: friendlyMessage } };
    }
  }
  const response = await fetch(apiUrl('/api/admin/attendance/backdate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // SAFETY: Parsing admin backdate attendance response JSON
  return (await response.json()) as { success: boolean; attendance?: AttendanceListItem; error?: { code?: string; message?: string } };
}
export async function deleteAdminUser(userId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    // SAFETY: Backend delete user returns success response
    return (await tauriApi.adminDeleteUser(nativeAdminToken ?? '', userId)) as { success: boolean; error?: { message?: string } };
  }
  const response = await fetch(apiUrl(`/api/admin/users/${encodeURIComponent(userId)}`), { method: 'DELETE' });
  // SAFETY: Parsing admin delete user response JSON
  return (await response.json()) as { success: boolean; error?: { message?: string } };
}
export async function deleteAdminAttendance(attendanceId: string, date: string): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    // SAFETY: Backend delete attendance returns success response
    return (await tauriApi.adminDeleteAttendance(nativeAdminToken ?? '', attendanceId, date)) as { success: boolean; error?: { message?: string } };
  }
  const response = await fetch(apiUrl(`/api/admin/attendance/${encodeURIComponent(attendanceId)}?date=${encodeURIComponent(date)}`), { method: 'DELETE' });
  // SAFETY: Parsing admin delete attendance response JSON
  return (await response.json()) as { success: boolean; error?: { message?: string } };
}
export async function loadPayrollProfiles(): Promise<PayrollProfilesResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend list profiles returns PayrollProfilesResponse
    return (await tauriApi.payrollProfiles(nativeAdminToken ?? '')) as PayrollProfilesResponse;
  }
  // SAFETY: Parsing admin payroll profiles JSON
  return (await fetch(apiUrl('/api/admin/payroll/profiles'))).json() as Promise<PayrollProfilesResponse>;
}
export async function savePayrollProfile(profile: PayrollCalculationProfile): Promise<{ success: boolean }> {
  if (runningInTauri()) {
    // SAFETY: Backend save profile returns success response
    return (await tauriApi.payrollUpsertProfile(nativeAdminToken ?? '', profile)) as { success: boolean };
  }
  const response = await fetch(apiUrl('/api/admin/payroll/profiles'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) });
  // SAFETY: Parsing admin save profile response JSON
  return (await response.json()) as { success: boolean };
}
export async function loadPayrollCutoffs(): Promise<PayrollCutoffsResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend list cutoffs returns PayrollCutoffsResponse
    return (await tauriApi.payrollCutoffs(nativeAdminToken ?? '')) as PayrollCutoffsResponse;
  }
  // SAFETY: Parsing admin payroll cutoffs JSON
  return (await fetch(apiUrl('/api/admin/payroll/cutoffs'))).json() as Promise<PayrollCutoffsResponse>;
}
export async function loadPayrollPdfs(): Promise<PayrollPdfListResponse> {
  if (runningInTauri()) {
    try { return await tauriApi.listPayrollPdfs(nativeAdminToken ?? ''); }
    catch { return { success: false, error: { message: 'Unable to load payroll PDFs.' } }; }
  }
  return { success: false, error: { message: 'Payroll PDFs are available in the desktop application.' } };
}
export async function generatePayrollPdf(request: PayrollPdfGenerateRequest): Promise<PayrollPdfGenerateResponse> {
  if (runningInTauri()) {
    try {
      return await tauriApi.generatePayrollPdf(nativeAdminToken ?? '', request.cutoffStart, request.cutoffEnd, request.payrollCutoffLabel ?? '', request.workerType.toUpperCase());
    } catch { return { success: false, error: { message: 'Unable to generate the payroll PDF.' } }; }
  }
  return { success: false, error: { message: 'Payroll PDFs are generated in the desktop application.' } };
}
export async function loadInternPayrollReport(cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string): Promise<InternPayrollReportResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend intern report returns InternPayrollReportResponse
    return (await tauriApi.internPayrollReport(nativeAdminToken ?? '', cutoffStart, cutoffEnd, payrollCutoffLabel)) as InternPayrollReportResponse;
  }
  return { success: true, payroll: [] };
}
export async function savePayrollCutoff<T extends object>(payroll: T, payrollId?: string): Promise<{ success: boolean }> {
  if (runningInTauri()) {
    if (payrollId) {
      const updatePayload = Object.assign({}, payroll, { payrollId });
      // SAFETY: Backend update cutoff returns success response
      return (await tauriApi.payrollUpdateCutoff(nativeAdminToken ?? '', updatePayload)) as { success: boolean };
    }
    // SAFETY: Backend create cutoff returns success response
    return (await tauriApi.payrollCreateCutoff(nativeAdminToken ?? '', payroll)) as { success: boolean };
  }
  const response = await fetch(apiUrl(payrollId ? `/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}` : '/api/admin/payroll/cutoffs'), { method: payrollId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payroll) });
  // SAFETY: Parsing admin save cutoff response JSON
  return (await response.json()) as { success: boolean };
}
export async function generatePayrollCutoff<T extends object>(cutoffStart: string, cutoffEnd: string, payrollCutoffLabel: string, customization?: T): Promise<{ success: boolean; error?: { message: string } }> {
  if (runningInTauri()) {
    const payload = customization ?? {};
    // SAFETY: Backend generate cutoff returns success or error response
    return (await tauriApi.payrollGenerateCutoff(nativeAdminToken ?? '', cutoffStart, cutoffEnd, payrollCutoffLabel, payload)) as { success: boolean; error?: { message: string } };
  }
  return { success: false, error: { message: 'Automatic payroll generation is available in the desktop application.' } };
}
export async function finalizePayrollCutoff(payrollId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    // SAFETY: Backend finalize cutoff returns success response
    return (await tauriApi.payrollFinalizeCutoff(nativeAdminToken ?? '', payrollId)) as { success: boolean; error?: { message?: string } };
  }
  const response = await fetch(apiUrl(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}/finalize`), { method: 'POST' });
  // SAFETY: Parsing finalize cutoff response JSON
  return (await response.json()) as { success: boolean; error?: { message?: string } };
}
export async function deletePayrollCutoff(payrollId: string): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    // SAFETY: Backend delete cutoff returns success response
    return (await tauriApi.payrollDeleteCutoff(nativeAdminToken ?? '', payrollId)) as { success: boolean; error?: { message?: string } };
  }
  const response = await fetch(apiUrl(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}`), { method: 'DELETE' });
  // SAFETY: Parsing delete cutoff response JSON
  return (await response.json()) as { success: boolean; error?: { message?: string } };
}
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

function fileActionError<T>(error: T, fallback: string): FileActionResult {
  const code = errorString(error);
  if (code === 'FILE_NOT_FOUND') return { ok: false, message: 'The file could not be found. It may have been moved or deleted.' };
  if (code === 'DIRECTORY_NOT_FOUND') return { ok: false, message: 'The folder could not be found. It may have been moved or deleted.' };
  if (code === 'ADMIN_AUTH_REQUIRED') return { ok: false, message: 'Administrator session expired. Unlock admin to continue.' };
  return { ok: false, message: fallback };
}

async function runFileAction(action: (token: string) => Promise<{ success: boolean; message?: string } | void>): Promise<FileActionResult> {
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

export async function nukeSheetsResync(confirm: boolean): Promise<{ success: boolean; error?: { message?: string } }> {
  if (runningInTauri()) {
    // SAFETY: Backend sheets nuke resync returns success response
    return (await tauriApi.sheetsNukeResync(nativeAdminToken ?? '', confirm)) as { success: boolean; error?: { message?: string } };
  }
  return { success: false, error: { message: 'Google Sheets sync is available in the desktop application.' } };
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
      const code = errorString(error);
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
    const headers: Record<string, string> = {};
    if (options.body) {
      headers['Content-Type'] = 'application/json';
    }
    if (options.setupToken) {
      headers['X-Setup-Token'] = options.setupToken;
    }
    const init: RequestInit = {
      method: options.method,
      headers,
      signal: options.signal,
    };
    if (options.body) {
      init.body = options.body;
    }
    const response = await fetch(url, init);
    // SAFETY: Parsing setup response as requested type T
    return (await response.json()) as T;
  } catch {
    return { success: false, error: { code: 'GOOGLE_SHEETS_UNAVAILABLE', message: 'Unable to reach setup service. Please try again.' } };
  }
}

function positiveNumber<T>(value: T, fallback: number): number {
  if (value && Object.prototype.toString.call(value) === '[object Number]') {
    // SAFETY: Verified that value is a number
    const num = value as number;
    if (Number.isFinite(num) && num > 0) return num;
  }
  return fallback;
}

function networkError(message: string): ScanErrorResponse {
  return {
    success: false,
    requestId: `client-${Date.now()}`,
    error: { code: 'INTERNAL_SERVER_ERROR', message },
  };
}

export async function getAutostartStatus(): Promise<boolean> {
  if (runningInTauri()) {
    try {
      return await tauriApi.autostartStatus();
    } catch {
      return false;
    }
  }
  return false;
}

export async function setAutostartStatus(enabled: boolean): Promise<boolean> {
  if (runningInTauri()) {
    try {
      return await tauriApi.autostartSet(enabled);
    } catch {
      return false;
    }
  }
  return false;
}

export async function loadBathroomStatus(date?: string, signal?: AbortSignal): Promise<BathroomStatusResponse> {
  if (runningInTauri()) {
    // SAFETY: Backend bathroom status returns BathroomStatusResponse
    return (await tauriApi.bathroomGetStatus(nativeAdminToken ?? undefined, date)) as BathroomStatusResponse;
  }
  const url = date ? `/api/bathroom/status?date=${encodeURIComponent(date)}` : '/api/bathroom/status';
  const response = await fetch(apiUrl(url), { signal });
  // SAFETY: Parsing bathroom status response JSON
  return (await response.json()) as BathroomStatusResponse;
}

export async function submitBathroomScan(
  request: BathroomScanRequest,
  signal?: AbortSignal,
): Promise<BathroomScanResponse> {
  if (runningInTauri()) {
    try {
      // SAFETY: Backend bathroom scan returns BathroomScanResponse
      return (await tauriApi.bathroomScanRfid(request.rfidUid)) as BathroomScanResponse;
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: errorString(error) },
      };
    }
  }
  const response = await fetch(apiUrl('/api/bathroom/scan'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  // SAFETY: Parsing bathroom scan response JSON
  return (await response.json()) as BathroomScanResponse;
}

export async function bathroomTimeOut(
  userId: string,
  genderKey: 'MALE' | 'FEMALE',
  notes?: string,
): Promise<BathroomActionResponse> {
  if (runningInTauri()) {
    try {
      // SAFETY: Backend bathroom time out returns BathroomActionResponse
      return (await tauriApi.bathroomTimeOut(nativeAdminToken ?? '', userId, genderKey, notes)) as BathroomActionResponse;
    } catch (error) {
      return { success: false, error: { code: 'BATHROOM_ERROR', message: errorString(error) } };
    }
  }
  const response = await fetch(apiUrl('/api/admin/bathroom/time-out'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, genderKey, notes }),
  });
  // SAFETY: Parsing bathroom action response JSON
  return (await response.json()) as BathroomActionResponse;
}

export async function bathroomTimeIn(
  logId: string,
  notes?: string,
): Promise<BathroomActionResponse> {
  if (runningInTauri()) {
    try {
      // SAFETY: Backend bathroom time in returns BathroomActionResponse
      return (await tauriApi.bathroomTimeIn(nativeAdminToken ?? '', logId, notes)) as BathroomActionResponse;
    } catch (error) {
      return { success: false, error: { code: 'BATHROOM_ERROR', message: errorString(error) } };
    }
  }
  const response = await fetch(apiUrl('/api/admin/bathroom/time-in'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ logId, notes }),
  });
  // SAFETY: Parsing bathroom action response JSON
  return (await response.json()) as BathroomActionResponse;
}

export async function updateBathroomLog(
  logId: string,
  request: BathroomUpdateRequest,
): Promise<BathroomActionResponse> {
  if (runningInTauri()) {
    try {
      return await tauriApi.bathroomUpdateLog(nativeAdminToken ?? '', logId, request);
    } catch (error) {
      return { success: false, error: { code: 'BATHROOM_ERROR', message: errorString(error) } };
    }
  }
  const response = await fetch(apiUrl(`/api/admin/bathroom/${encodeURIComponent(logId)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  // SAFETY: Parsing bathroom action response JSON
  return (await response.json()) as BathroomActionResponse;
}
