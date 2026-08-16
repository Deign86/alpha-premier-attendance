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
    const errorPayload: ScanErrorResponse['error'] = {
      code: this.code,
      message: this.message,
    };
    if (this.retryAfterSeconds !== undefined) {
      errorPayload.retryAfterSeconds = this.retryAfterSeconds;
    }
    return {
      success: false,
      requestId,
      error: errorPayload,
    };
  }
}

export interface ScanErrorLike {
  code: ScanErrorCode;
  message: string;
  status: number;
  retryAfterSeconds?: number;
}

export function asScanError<T>(error: T): ScanError {
  if (error instanceof ScanError) return error;
  if (isScanErrorLike(error)) {
    return new ScanError(error.code, error.message, error.status, error.retryAfterSeconds);
  }
  return new ScanError('INTERNAL_SERVER_ERROR', 'An unexpected server error occurred.', 500);
}

function isScanErrorLike<T>(error: T): error is T & ScanErrorLike {
  if (error === null || error === undefined || Object(error) !== error) return false;
  // SAFETY: Checked that error is an object type
  const value = error as { code?: unknown; message?: unknown; status?: unknown; retryAfterSeconds?: unknown };
  if (Object.prototype.toString.call(value.code) !== '[object String]') return false;
  // SAFETY: Checked that code is a string and present in scanErrorCodeSet
  if (!scanErrorCodeSet.has(value.code as ScanErrorCode)) return false;
  if (Object.prototype.toString.call(value.message) !== '[object String]') return false;
  if (Object.prototype.toString.call(value.status) !== '[object Number]' || !Number.isFinite(value.status)) return false;
  return true;
}
