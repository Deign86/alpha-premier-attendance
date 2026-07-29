import type { ScanErrorCode, ScanErrorResponse } from '@rfid-attendance/shared';

export class ScanError extends Error {
  readonly code: ScanErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: ScanErrorCode, message: string, status = 400, retryAfterSeconds?: number) {
    super(message);
    this.name = 'ScanError';
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
  return new ScanError('INTERNAL_SERVER_ERROR', 'An unexpected server error occurred.', 500);
}
