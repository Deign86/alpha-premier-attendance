import type {
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
} from '@rfid-attendance/shared';

export const DEFAULT_CONFIG: Omit<SafeConfigResponse, 'success'> = {
  timezone: 'Asia/Manila',
  rfidAutoSubmitDelayMs: 150,
  enableScanSounds: false,
  resultResetDelayMs: 4_000,
  enableCardSetup: false,
};

export async function loadConfig(signal?: AbortSignal): Promise<Omit<SafeConfigResponse, 'success'>> {
  try {
    const response = await fetch('/api/config', { signal });
    if (!response.ok) return DEFAULT_CONFIG;
    const data = (await response.json()) as Partial<SafeConfigResponse>;
    return {
      timezone: data.timezone || DEFAULT_CONFIG.timezone,
      rfidAutoSubmitDelayMs: positiveNumber(data.rfidAutoSubmitDelayMs, DEFAULT_CONFIG.rfidAutoSubmitDelayMs),
      enableScanSounds: data.enableScanSounds ?? DEFAULT_CONFIG.enableScanSounds,
      resultResetDelayMs: positiveNumber(data.resultResetDelayMs, DEFAULT_CONFIG.resultResetDelayMs),
      enableCardSetup: data.enableCardSetup ?? DEFAULT_CONFIG.enableCardSetup,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function submitScan(request: ScanRequest, signal?: AbortSignal): Promise<ScanSuccessResponse | ScanErrorResponse> {
  try {
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
  return setupRequest<SetupUnlockResponse | SetupErrorResponse>('/api/setup/unlock', {
    method: 'POST',
    body: JSON.stringify({ pin }),
    signal,
  });
}

export async function lookupSetupCard(rfidUid: string, setupToken: string, signal?: AbortSignal): Promise<SetupLookupResponse | SetupErrorResponse> {
  return setupRequest<SetupLookupResponse | SetupErrorResponse>(`/api/setup/card?rfidUid=${encodeURIComponent(rfidUid)}`, {
    method: 'GET',
    setupToken,
    signal,
  });
}

export async function upsertSetupUser(request: SetupUpsertRequest, setupToken: string, signal?: AbortSignal): Promise<SetupUpsertResponse | SetupErrorResponse> {
  return setupRequest<SetupUpsertResponse | SetupErrorResponse>('/api/setup/users', {
    method: 'POST',
    setupToken,
    body: JSON.stringify(request),
    signal,
  });
}

export async function lockSetup(setupToken: string, signal?: AbortSignal): Promise<void> {
  await setupRequest<unknown>('/api/setup/lock', { method: 'POST', setupToken, signal });
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
