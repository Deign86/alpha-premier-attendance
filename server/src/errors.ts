import type { ScanErrorCode, ScanErrorResponse } from '@rfid-attendance/shared';

const scanErrorCodeSet = new Set<ScanErrorCode>([
  'INVALID_SCAN_INPUT',
  'UNKNOWN_RFID_CARD',
  'INACTIVE_USER',
  'DUPLICATE_SCAN',
  'ATTENDANCE_ALREADY_COMPLETED',
  'ATTENDANCE_DATA_CONFLICT',
  'GOOGLE_SHEETS_UNAVAILABLE',
  'PAYROLL_GENERATION_FAILED',
  'RATE_LIMITED',
  'INTERNAL_SERVER_ERROR',
  'CONFIGURATION_ERROR',
]);

export class ScanError extends Error {
  readonly code: ScanErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: ScanErrorCode, message: string, status = 400, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ScanError';
    Object.setPrototypeOf(this, new.target.prototype);
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }

  toResponse(requestId: string): ScanErrorResponse {
    return {
      success: false,
      requestId,
      error: {
        code: this.code,
        message: this.message,
        ...(this.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: this.retryAfterSeconds }),
      },
    };
  }
}

export function asScanError(error: unknown): ScanError {
  if (error instanceof ScanError) return error;
  if (isScanErrorLike(error)) {
    return new ScanError(error.code, error.message, error.status, error.retryAfterSeconds);
  }
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new ScanError('INTERNAL_SERVER_ERROR', `Scan failed: ${detail}`, 500);
}

function isScanErrorLike(error: unknown): error is { code: ScanErrorCode; message: string; status: number; retryAfterSeconds?: number } {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<{ code: string; message: string; status: number; retryAfterSeconds?: number }>;
  return typeof value.code === 'string'
    && scanErrorCodeSet.has(value.code as ScanErrorCode)
    && typeof value.message === 'string'
    && typeof value.status === 'number';
}
