import type { ScanErrorCode, ScanErrorResponse } from '@rfid-attendance/shared';

type ScanErrorLike = {
  code: ScanErrorCode;
  message: string;
  status: number;
  retryAfterSeconds?: number;
};

type UnknownRecord = Record<string, unknown>;

const scanErrorCodeSet = new Set<string>([
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
  return new ScanError('INTERNAL_SERVER_ERROR', 'An unexpected server error occurred.', 500);
}

function isScanErrorLike(error: unknown): error is ScanErrorLike {
  if (!isUnknownRecord(error) || !isScanErrorCode(error.code)) return false;
  if (typeof error.message !== 'string' || typeof error.status !== 'number') return false;
  return !('retryAfterSeconds' in error)
    || error.retryAfterSeconds === undefined
    || typeof error.retryAfterSeconds === 'number';
}

function isScanErrorCode(value: unknown): value is ScanErrorCode {
  return typeof value === 'string' && scanErrorCodeSet.has(value);
}

function isUnknownRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}
