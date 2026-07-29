import crypto from 'node:crypto';
import type { GoogleSheetsService, SheetUser } from './sheets.js';
import { normalizeRfidUid } from './rfid.js';

export const setupErrorCodes = [
  'SETUP_DISABLED',
  'INVALID_SETUP_PIN',
  'SETUP_AUTH_REQUIRED',
  'SETUP_SESSION_EXPIRED',
  'SETUP_VALIDATION_ERROR',
  'USER_CONFLICT',
  'GOOGLE_SHEETS_UNAVAILABLE',
] as const;
export type SetupErrorCode = (typeof setupErrorCodes)[number];

export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode, message: string, readonly status = 400) {
    super(message);
    this.name = 'SetupError';
  }
  toResponse(requestId: string) {
    return { success: false as const, requestId, error: { code: this.code, message: this.message } };
  }
}

export type SetupConfig = {
  enableCardSetup?: boolean;
  setupAdminPin?: string;
  setupSessionMinutes?: number;
};

export type SetupUserInput = {
  userId: string;
  fullName: string;
  rfidUid: string;
  department?: string | null;
  status?: 'ACTIVE' | 'INACTIVE';
};

type TokenRecord = { expiresAtMs: number };
type Clock = () => Date;

export class SetupService {
  private readonly tokens = new Map<string, TokenRecord>();
  private now: Clock;

  constructor(private readonly sheets: GoogleSheetsService, private readonly config: SetupConfig, now: Clock = () => new Date()) {
    this.now = now;
  }

  setNowProvider(now: Clock): void { this.now = now; }

  unlock(pin: unknown): { setupToken: string; expiresAt: string } {
    this.assertEnabled();
    if (typeof pin !== 'string' || !this.constantTimePinEqual(pin, this.config.setupAdminPin ?? '')) {
      throw new SetupError('INVALID_SETUP_PIN', 'The setup PIN is invalid.', 401);
    }
    const setupToken = crypto.randomBytes(32).toString('hex');
    const expiresAtMs = this.now().getTime() + (this.config.setupSessionMinutes ?? 15) * 60_000;
    this.tokens.set(setupToken, { expiresAtMs });
    return { setupToken, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  lock(token: string | undefined): void {
    this.requireToken(token);
    this.tokens.delete(token!);
  }

  async lookupCard(token: string | undefined, rawUid: string): Promise<{ rfidUid: string; user: SheetUser | null }> {
    this.requireToken(token);
    let rfidUid: string;
    try { rfidUid = normalizeRfidUid(rawUid); } catch { throw new SetupError('SETUP_VALIDATION_ERROR', 'rfidUid must be a valid hexadecimal UID.', 400); }
    try {
      const user = await this.sheets.findUserByUid(rfidUid);
      return { rfidUid, user };
    } catch {
      throw new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503);
    }
  }

  async upsertUser(token: string | undefined, input: unknown): Promise<{ user: SheetUser; created: boolean }> {
    this.requireToken(token);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SetupError('SETUP_VALIDATION_ERROR', 'A user object is required.', 400);
    const value = input as Partial<SetupUserInput>;
    if (typeof value.userId !== 'string' || !value.userId.trim() || typeof value.fullName !== 'string' || !value.fullName.trim() || typeof value.rfidUid !== 'string' || (value.status !== 'ACTIVE' && value.status !== 'INACTIVE')) {
      throw new SetupError('SETUP_VALIDATION_ERROR', 'userId, fullName, and rfidUid are required.', 400);
    }
    let rfidUid: string;
    try { rfidUid = normalizeRfidUid(value.rfidUid); } catch { throw new SetupError('SETUP_VALIDATION_ERROR', 'rfidUid must be a valid hexadecimal UID.', 400); }
    const user: SheetUser = {
      userId: value.userId.trim(),
      fullName: value.fullName.trim(),
      rfidUid,
      department: typeof value.department === 'string' && value.department.trim() ? value.department.trim() : null,
      active: value.status === 'ACTIVE',
    };
    try {
      const existing = await this.sheets.findUserById(user.userId);
      const saved = await this.sheets.upsertUser(user);
      return { user: saved, created: existing === null };
    } catch (error) {
      if (error instanceof Error && /duplicate.*uid|duplicate.*rfid/i.test(error.message)) {
        throw new SetupError('USER_CONFLICT', 'That RFID card is already assigned to another user.', 409);
      }
      throw new SetupError('GOOGLE_SHEETS_UNAVAILABLE', 'User data is temporarily unavailable.', 503);
    }
  }

  private assertEnabled(): void {
    if (!this.config.enableCardSetup) throw new SetupError('SETUP_DISABLED', 'Card setup is disabled.', 403);
    if (!this.config.setupAdminPin) throw new SetupError('SETUP_DISABLED', 'Card setup is not configured.', 403);
  }

  private requireToken(token: string | undefined): void {
    this.assertEnabled();
    if (!token) throw new SetupError('SETUP_AUTH_REQUIRED', 'A setup token is required.', 401);
    const record = this.tokens.get(token);
    if (!record) throw new SetupError('SETUP_AUTH_REQUIRED', 'The setup session is invalid.', 401);
    if (this.now().getTime() >= record.expiresAtMs) {
      this.tokens.delete(token);
      throw new SetupError('SETUP_SESSION_EXPIRED', 'The setup session has expired.', 401);
    }
  }

  private constantTimePinEqual(input: string, expected: string): boolean {
    const inputHash = crypto.createHash('sha256').update(input).digest();
    const expectedHash = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(inputHash, expectedHash);
  }
}

export function setupTokenFromRequest(headers: { authorization?: string; 'x-setup-token'?: string }): string | undefined {
  const bearer = headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return bearer || headers['x-setup-token'];
}
