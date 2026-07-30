import { scanErrorCodes, type ScanErrorCode, type ScanErrorResponse } from '@rfid-attendance/shared';

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

function isScanErrorLike(error: unknown): error is { code: ScanErrorCode; message: string; status: number; retryAfterSeconds?: number } {
  if (!error || typeof error !== 'object') return false;
  const value = error as Partial<{ code: string; message: string; status: number; retryAfterSeconds?: number }>;
  return typeof value.code === 'string'
    && scanErrorCodes.includes(value.code as ScanErrorCode)
    && typeof value.message === 'string'
    && typeof value.status === 'number';
}
