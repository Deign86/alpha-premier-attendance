import type {
  ArtifactExportResponse,
  AttendanceXlsxExportResponse,
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
import { convertFileSrc } from '@tauri-apps/api/core';
import { tauriApi } from './tauri-api';

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
  enableScanSounds: false,
  resultResetDelayMs: 4_000,
  enableCardSetup: false,
  enableAdmin: false,
};

export async function loadConfig(signal?: AbortSignal): Promise<Omit<SafeConfigResponse, 'success'>> {
  try {
    if (runningInTauri()) {
      const data = await tauriApi.getConfig();
      return { timezone: data.timezone || DEFAULT_CONFIG.timezone, rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs), enableScanSounds: data.enableScanSounds ?? DEFAULT_CONFIG.enableScanSounds, resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs), enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup, enableAdmin: data.enableAdmin ?? DEFAULT_CONFIG.enableAdmin };
    }
    const response = await fetch('/api/config', { signal });
    if (!response.ok) return DEFAULT_CONFIG;
    const data = (await response.json()) as Partial<SafeConfigResponse>;
    return {
      timezone: data.timezone || DEFAULT_CONFIG.timezone,
      rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs),
      enableScanSounds: data.enableScanSounds ?? DEFAULT_CONFIG.enableScanSounds,
      resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs),
      enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup,
      enableAdmin: data.enableAdmin ?? DEFAULT_CONFIG.enableAdmin,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function submitScan(request: ScanRequest, signal?: AbortSignal): Promise<ScanSuccessResponse | ScanErrorResponse> {
  try {
    if (runningInTauri()) return await tauriApi.scanRfid(request);
    const response = await fetch('/api/attendance/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
    const data = (await response.json()) as ScanResponse;
    if (data && typeof data === 'object' && 'success' in data) return data;
    return networkError('The attendance service returned an invalid response.');
  } catch {
    return networkError('Unable to reach the attendance service. Please try again.');
  }
}

export async function unlockSetup(pin: string, signal?: AbortSignal): Promise<SetupUnlockResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { const response = await tauriApi.setupUnlock(pin); nativeAdminToken = response.token; return { success: true, setupToken: response.token, expiresAt: response.expiresAt }; } catch { return { success: false, error: { code: 'INVALID_SETUP_PIN', message: 'The setup PIN is invalid.' } } as SetupErrorResponse; } }
  return setupRequest<SetupUnlockResponse | SetupErrorResponse>('/api/setup/unlock', {
    method: 'POST',
    body: JSON.stringify({ pin }),
    signal,
  });
}

export async function lookupSetupCard(rfidUid: string, setupToken: string, signal?: AbortSignal): Promise<SetupLookupResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.setupLookupCard(setupToken, rfidUid) as SetupLookupResponse; } catch { return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Setup authentication is required.' } } as SetupErrorResponse; } }
  return setupRequest<SetupLookupResponse | SetupErrorResponse>(`/api/setup/card?rfidUid=${encodeURIComponent(rfidUid)}`, {
    method: 'GET',
    setupToken,
    signal,
  });
}

export async function upsertSetupUser(request: SetupUpsertRequest, setupToken: string, signal?: AbortSignal): Promise<SetupUpsertResponse | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.setupUpsertUser(setupToken, request) as SetupUpsertResponse; } catch { return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Setup authentication is required.' } } as SetupErrorResponse; } }
  return setupRequest<SetupUpsertResponse | SetupErrorResponse>('/api/setup/users', {
    method: 'POST',
    setupToken,
    body: JSON.stringify(request),
    signal,
  });
}

export async function lockSetup(setupToken: string, signal?: AbortSignal): Promise<void> {
  if (runningInTauri()) { nativeAdminToken = null; await tauriApi.setupLock(); return; }
  await setupRequest<unknown>('/api/setup/lock', { method: 'POST', setupToken, signal });
}

export async function uploadSetupPhoto(userId: string, dataUrl: string, setupToken: string): Promise<{ success: true; photoUrl: string } | SetupErrorResponse> {
  if (runningInTauri()) { try { return await tauriApi.uploadPhoto(setupToken, userId, dataUrl); } catch { return { success: false, error: { code: 'SETUP_AUTH_REQUIRED', message: 'Setup authentication is required.' } } as SetupErrorResponse; } }
  return setupRequest<{ success: true; photoUrl: string }>('/api/setup/photo', { method: 'POST', setupToken, body: JSON.stringify({ userId, dataUrl }) });
}

export async function loadAttendance(date?: string, signal?: AbortSignal): Promise<AttendanceListResponse> {
  if (runningInTauri()) return await tauriApi.getAttendance(date) as AttendanceListResponse;
  const response = await fetch(`/api/attendance${date ? `?date=${encodeURIComponent(date)}` : ''}`, { signal });
  return (await response.json()) as AttendanceListResponse;
}

export async function unlockAdmin(pin: string): Promise<{ success: true; expiresAt: string } | { success: false; error: { message: string } }> {
  if (runningInTauri()) { try { const response = await tauriApi.setupUnlock(pin); nativeAdminToken = response.token; return { success: true, expiresAt: response.expiresAt }; } catch { return { success: false, error: { message: 'The administrator PIN is invalid.' } }; } }
  const response = await fetch('/api/admin/unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  return (await response.json()) as { success: true; expiresAt: string } | { success: false; error: { message: string } };
}

export async function lockAdmin(): Promise<void> { if (runningInTauri()) { nativeAdminToken = null; await tauriApi.setupLock(); return; } await fetch('/api/admin/lock', { method: 'POST' }); }
export async function checkAdminSession(): Promise<string | null> { if (runningInTauri()) { if (!nativeAdminToken) return null; try { await tauriApi.adminGetSession(nativeAdminToken); return nativeAdminToken; } catch { nativeAdminToken = null; return null; } } try { const response = await fetch('/api/admin/session'); if (!response.ok) return null; const data = (await response.json()) as { expiresAt?: string }; return data.expiresAt ?? null; } catch { return null; } }
export async function loadAdminUsers(signal?: AbortSignal): Promise<AdminUsersResponse> { if (runningInTauri()) return await tauriApi.adminUsers(nativeAdminToken ?? '') as AdminUsersResponse; return (await fetch('/api/admin/users', { signal })).json() as Promise<AdminUsersResponse>; }
export async function loadAdminAttendance(date: string, signal?: AbortSignal): Promise<AdminAttendanceResponse> { if (runningInTauri()) return await tauriApi.adminAttendance(nativeAdminToken ?? '', date) as AdminAttendanceResponse; return (await fetch(`/api/admin/attendance?date=${encodeURIComponent(date)}`, { signal })).json() as Promise<AdminAttendanceResponse>; }
export async function saveAdminUser(user: unknown, userId?: string): Promise<unknown> { if (runningInTauri()) return tauriApi.adminUpsertUser(nativeAdminToken ?? '', { ...(user as object), ...(userId ? { userId } : {}) }); const response = await fetch(userId ? `/api/admin/users/${encodeURIComponent(userId)}` : '/api/admin/users', { method: userId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(user) }); return response.json(); }
export async function saveAdminAttendance(attendanceId: string, payload: unknown): Promise<unknown> { if (runningInTauri()) return tauriApi.adminUpdateAttendance(nativeAdminToken ?? '', attendanceId, payload); const response = await fetch(`/api/admin/attendance/${encodeURIComponent(attendanceId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return response.json(); }
export async function deleteAdminUser(userId: string): Promise<unknown> { if (runningInTauri()) return tauriApi.adminDeleteUser(nativeAdminToken ?? '', userId); const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' }); return response.json(); }
export async function deleteAdminAttendance(attendanceId: string, date: string): Promise<unknown> { if (runningInTauri()) return tauriApi.adminDeleteAttendance(nativeAdminToken ?? '', attendanceId, date); const response = await fetch(`/api/admin/attendance/${encodeURIComponent(attendanceId)}?date=${encodeURIComponent(date)}`, { method: 'DELETE' }); return response.json(); }
export async function loadPayrollProfiles(): Promise<PayrollProfilesResponse> { if (runningInTauri()) return await tauriApi.payrollProfiles(nativeAdminToken ?? '') as PayrollProfilesResponse; return (await fetch('/api/admin/payroll/profiles')).json() as Promise<PayrollProfilesResponse>; }
export async function savePayrollProfile(profile: PayrollCalculationProfile): Promise<unknown> { if (runningInTauri()) return tauriApi.payrollUpsertProfile(nativeAdminToken ?? '', profile); const response = await fetch(`/api/admin/payroll/profiles/${encodeURIComponent(profile.profileId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(profile) }); return response.json(); }
export async function loadPayrollCutoffs(): Promise<PayrollCutoffsResponse> { if (runningInTauri()) return await tauriApi.payrollCutoffs(nativeAdminToken ?? '') as PayrollCutoffsResponse; return (await fetch('/api/admin/payroll/cutoffs')).json() as Promise<PayrollCutoffsResponse>; }
export async function savePayrollCutoff(payroll: unknown, payrollId?: string): Promise<unknown> { if (runningInTauri()) return payrollId ? tauriApi.payrollUpdateCutoff(nativeAdminToken ?? '', { ...(payroll as object), payrollId }) : tauriApi.payrollCreateCutoff(nativeAdminToken ?? '', payroll); const response = await fetch(payrollId ? `/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}` : '/api/admin/payroll/cutoffs', { method: payrollId ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payroll) }); return response.json(); }
export async function finalizePayrollCutoff(payrollId: string): Promise<unknown> { if (runningInTauri()) return tauriApi.payrollFinalizeCutoff(nativeAdminToken ?? '', payrollId); const response = await fetch(`/api/admin/payroll/cutoffs/${encodeURIComponent(payrollId)}/finalize`, { method: 'POST' }); return response.json(); }
export async function exportAttendanceXlsx(date: string): Promise<AttendanceXlsxExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.exportAttendanceXlsx(nativeAdminToken ?? '', date); } catch { return { success: false, error: { message: 'Unable to generate the attendance workbook.' } }; } } return { success: false, error: { message: 'Attendance workbooks are available in the desktop application.' } }; }
export async function exportPayrollXlsx(cutoff?: string): Promise<ArtifactExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.exportPayrollXlsx(nativeAdminToken ?? '', cutoff); } catch { return { success: false, error: { message: 'Unable to generate the payroll workbook.' } }; } } return { success: false, error: { message: 'Payroll workbooks are available in the desktop application.' } }; }
export async function generatePayrollPayslipPdf(payrollId: string): Promise<ArtifactExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.generatePayrollPayslipPdf(nativeAdminToken ?? '', payrollId); } catch { return { success: false, error: { message: 'Unable to generate the payslip PDF.' } }; } } return { success: false, error: { message: 'Payslip PDFs are available in the desktop application.' } }; }
export async function generatePayrollRegisterPdf(cutoff?: string): Promise<ArtifactExportResponse | { success: false; error: { message: string } }> { if (runningInTauri()) { try { return await tauriApi.generatePayrollRegisterPdf(nativeAdminToken ?? '', cutoff); } catch { return { success: false, error: { message: 'Unable to generate the payroll register PDF.' } }; } } return { success: false, error: { message: 'Payroll register PDFs are available in the desktop application.' } }; }

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
